import { z } from 'zod';
import { uuidSchema } from '@flowza/contracts';
import { event } from '@flowza/shared';
import { COMP_OFF_SYSTEM_KEY, emitDomainEvent, loadLeaveBalances, loadLeaveTypePolicies, withContext, writeAudit, type Trx } from '@flowza/database';
import { carryForwardDays, carryForwardExpiry, leaveTypeAppliesTo, prorateAllowance } from '@flowza/domain';
import type { JobContext } from '../types.js';
import { asDate, isoDate, parsePayload } from '../attendance/common.js';
import { orgLocalDate } from '../attendance/day-close.js';

/**
 * Leave year close (leave v2, HR portal Prompt 7; Finance parity A11). For every employee still employed when the next year
 * starts and every active type that allows a carry-forward, the unused balance of `fromYear` — available after pending
 * requests, as of 31 December, through the one balance function — is floored to half days, capped at the type's
 * `carry_forward_max_days`, and written into the employee's allocation row of `fromYear + 1` with the type's expiry
 * (`carry_forward_expiry_months`). The row is created when missing (allocated = the type's allowance prorated for that
 * year, or the closing year's allocation for a type HR allocates by hand).
 *
 * Idempotent: the carry-forward is SET, never added, so running it again (after a late decision, or twice on 1 January)
 * converges on the same figures; a carry-forward that became 0 is cleared. Runs in the organisation's system context,
 * audited once, and HR hears about it (`leave.year_closed`).
 *
 * Review fixes: only employees allocation generation would allocate to — not resigned / terminated (P2-1, even without an
 * exit date) — and, per employee, only the types that apply to them (`leaveTypeAppliesTo`: gender and employment type,
 * P1-3 / B-41). Every run writes the ledger row `leave_year_closes` (organisation, closed year: the org-local date it ran
 * on, the summary) — the scheduler's catch-up (P2-2) enqueues the close until that row says it ran after the year ended.
 */
export const leaveYearClosePayloadSchema = z.object({ organizationId: uuidSchema, fromYear: z.number().int().min(2000).max(2099), requestedBy: uuidSchema.optional() });
export type LeaveYearClosePayload = z.infer<typeof leaveYearClosePayloadSchema>;

export interface LeaveYearCloseSummary { fromYear: number; toYear: number; employees: number; leaveTypes: number; carried: number; created: number; updated: number; cleared: number; unchanged: number; totalDays: number }

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const BATCH = 200;

export async function runLeaveYearClose(trx: Trx, p: LeaveYearClosePayload, jobId: string | null, now: Date = new Date()): Promise<LeaveYearCloseSummary> {
  const { organizationId, fromYear } = p;
  const toYear = fromYear + 1;
  const yearEnd = `${fromYear}-12-31`;
  const types = (await loadLeaveTypePolicies(trx, organizationId)).filter((t) => t.systemKey !== COMP_OFF_SYSTEM_KEY && t.carryForwardMaxDays > 0);
  const summary: LeaveYearCloseSummary = { fromYear, toYear, employees: 0, leaveTypes: types.length, carried: 0, created: 0, updated: 0, cleared: 0, unchanged: 0, totalDays: 0 };
  if (!types.length) { await recordYearClose(trx, p, jobId, now, summary); return summary; }
  // the employees allocation generation would allocate to (review P2-1): not resigned / terminated, still employed next year
  const employees = await trx.selectFrom('employees').select(['id', 'branchId', 'joiningDate', 'gender', 'employmentType']).where('organizationId', '=', organizationId).where('deletedAt', 'is', null)
    .where('employmentStatus', 'not in', ['resigned', 'terminated'])
    .where('joiningDate', '<=', asDate(yearEnd)).where((eb) => eb.or([eb('exitDate', 'is', null), eb('exitDate', '>', asDate(yearEnd))])).orderBy('id').execute();
  summary.employees = employees.length;
  for (let i = 0; i < employees.length; i += BATCH) {
    const batch = employees.slice(i, i + BATCH);
    const ids = batch.map((e) => e.id);
    const balances = await loadLeaveBalances(trx, organizationId, ids, { year: fromYear, asOf: yearEnd, types });
    const [closing, next] = await Promise.all([
      trx.selectFrom('leaveAllocations').select(['employeeId', 'leaveTypeId', 'allocatedDays']).where('organizationId', '=', organizationId).where('year', '=', fromYear).where('employeeId', 'in', ids).execute(),
      trx.selectFrom('leaveAllocations').select(['id', 'employeeId', 'leaveTypeId', 'carriedForwardDays', 'carriedForwardExpiresOn']).where('organizationId', '=', organizationId).where('year', '=', toYear).where('employeeId', 'in', ids).execute(),
    ]);
    for (const e of batch) {
      const list = balances.get(e.id) ?? [];
      for (const [idx, type] of types.entries()) {
        const b = list[idx];
        if (!b || !b.tracked) continue;
        // the one applicability rule (review P2-1 / P1-3): never carry a type the employee can never take
        if (!leaveTypeAppliesTo(type, e)) continue;
        const cf = carryForwardDays(b.availableAfterPendingDays === null ? null : Math.max(0, b.availableAfterPendingDays), type.carryForwardMaxDays);
        const expires = cf > 0 ? carryForwardExpiry(toYear, type.carryForwardExpiryMonths) : null;
        const existing = next.find((a) => a.employeeId === e.id && a.leaveTypeId === type.id);
        if (existing) {
          const same = num(existing.carriedForwardDays) === cf && (existing.carriedForwardExpiresOn === null ? null : isoDate(existing.carriedForwardExpiresOn)) === expires;
          if (same) { summary.unchanged++; if (cf > 0) { summary.carried++; summary.totalDays += cf; } continue; }
          await trx.updateTable('leaveAllocations').set({ carriedForwardDays: cf, carriedForwardExpiresOn: expires, updatedBy: p.requestedBy ?? null }).where('id', '=', existing.id).execute();
          if (cf > 0) { summary.updated++; summary.carried++; summary.totalDays += cf; } else summary.cleared++;
          continue;
        }
        if (cf === 0) continue;
        const fromRow = closing.find((a) => a.employeeId === e.id && a.leaveTypeId === type.id);
        const allocated = type.annualAllowanceDays !== null ? prorateAllowance(type.annualAllowanceDays, toYear, isoDate(e.joiningDate)) : num(fromRow?.allocatedDays);
        await trx.insertInto('leaveAllocations').values({
          organizationId, employeeId: e.id, leaveTypeId: type.id, branchId: e.branchId, year: toYear, allocatedDays: allocated, carriedForwardDays: cf, carriedForwardExpiresOn: expires,
          notes: `Carried forward from ${fromYear}`, createdBy: p.requestedBy ?? null, updatedBy: p.requestedBy ?? null,
        }).onConflict((oc) => oc.columns(['organizationId', 'employeeId', 'leaveTypeId', 'year']).doUpdateSet({ carriedForwardDays: cf, carriedForwardExpiresOn: expires })).execute();
        summary.created++; summary.carried++; summary.totalDays += cf;
      }
    }
  }
  summary.totalDays = Math.round(summary.totalDays * 2) / 2;
  await recordYearClose(trx, p, jobId, now, summary);
  await writeAudit(trx, { organizationId, actorUserId: p.requestedBy ?? null, action: 'leave.year_closed', entityType: 'leave_allocation', entityId: null, newValue: summary, jobId });
  await emitDomainEvent(trx, { organizationId, eventType: 'leave.year_closed', aggregateType: 'organization', aggregateId: organizationId, payload: { ...summary, ...(p.requestedBy ? { userId: p.requestedBy } : {}) }, actorUserId: p.requestedBy ?? null });
  return summary;
}

/**
 * The ledger row of a close (review P2-2): the org-local date it ran on and its summary, upserted — a later run (a late
 * decision, a catch-up after a close queued before the year ended) refreshes it.
 */
async function recordYearClose(trx: Trx, p: LeaveYearClosePayload, jobId: string | null, now: Date, summary: LeaveYearCloseSummary): Promise<void> {
  const ranOn = await orgLocalDate(trx, p.organizationId, now);
  const values = { ranOn: asDate(ranOn), ranAt: now, jobId: jobId === null ? null : String(jobId).slice(0, 100), requestedBy: p.requestedBy ?? null, summary: JSON.stringify(summary) };
  await trx.insertInto('leaveYearCloses').values({ organizationId: p.organizationId, fromYear: p.fromYear, ...values })
    .onConflict((oc) => oc.columns(['organizationId', 'fromYear']).doUpdateSet(values)).execute();
}

/** LEAVE_YEAR_CLOSE handler: one organisation per job, one transaction in the organisation's system context. */
export async function leaveYearCloseHandler({ job, deps, log }: JobContext) {
  const p = parsePayload(leaveYearClosePayloadSchema, job.payload);
  const res = await withContext(deps.db, { kind: 'system', organizationId: p.organizationId, jobId: job.id }, (trx) => runLeaveYearClose(trx, p, job.id, deps.now()));
  log.info(event('leave_year_closed', { organizationId: p.organizationId, ...res }));
  return res;
}
