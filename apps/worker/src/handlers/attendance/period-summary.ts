import { z } from 'zod';
import { isoDateSchema, uuidSchema, type AttendanceFlag, type AttendanceStatus } from '@flowza/contracts';
import { errors, event } from '@flowza/shared';
import { withContext, writeAudit, type Trx } from '@flowza/database';
import { summarisePeriod, type PeriodRecordLike, type PeriodSummary } from '@flowza/domain';
import type { HandlerRegistry, JobContext } from '../types.js';
import { asDate, isoDate, parsePayload } from './common.js';

export const periodSummaryPayloadSchema = z.object({
  organizationId: uuidSchema,
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  employeeIds: z.array(uuidSchema).max(5000).optional(),
  branchId: uuidSchema.optional(),
  finalize: z.boolean().default(false),
  requestedBy: uuidSchema.nullable().optional(),
});
export type PeriodSummaryPayload = z.infer<typeof periodSummaryPayloadSchema>;

export interface PeriodSummaryResult { employees: number; built: number; changed: number; unchanged: number; finalized: number; skippedFinalized: number; pendingDays: number }

/** The numeric columns compared to decide whether a summary changed (a new version). Key order is normalised because jsonb re-orders object keys. */
function comparable(s: PeriodSummary, recordVersions: Record<string, number>): string {
  const sortedVersions = Object.fromEntries(Object.keys(recordVersions).sort().map((k) => [k, Number(recordVersions[k])]));
  return JSON.stringify({ ...s, recordVersions: sortedVersions });
}
function fromRow(r: { workingDays: number; presentDays: string; absentDays: string; leaveDays: string; paidLeaveDays: string; holidayDays: number; weeklyOffDays: number; halfDays: number; missingPunchDays: number; lateDays: number; regularMinutes: number; overtimeMinutes: number; overtimeWeeklyOffMinutes: number; overtimeHolidayMinutes: number; lateMinutes: number; earlyDepartureMinutes: number; recordVersions: unknown }, periodStart: string, periodEnd: string, pendingDays: number, recordCount: number, totalOvertimeMinutes: number): string {
  const s: PeriodSummary = {
    periodStart, periodEnd, workingDays: r.workingDays, presentDays: Number(r.presentDays), absentDays: Number(r.absentDays), leaveDays: Number(r.leaveDays), paidLeaveDays: Number(r.paidLeaveDays),
    holidayDays: r.holidayDays, weeklyOffDays: r.weeklyOffDays, halfDays: r.halfDays, missingPunchDays: r.missingPunchDays, lateDays: r.lateDays, regularMinutes: r.regularMinutes,
    overtimeMinutes: r.overtimeMinutes, overtimeWeeklyOffMinutes: r.overtimeWeeklyOffMinutes, overtimeHolidayMinutes: r.overtimeHolidayMinutes, totalOvertimeMinutes, lateMinutes: r.lateMinutes, earlyDepartureMinutes: r.earlyDepartureMinutes,
    pendingDays, recordCount,
  };
  const rv = (r.recordVersions && typeof r.recordVersions === 'object' && !Array.isArray(r.recordVersions) ? r.recordVersions : {}) as Record<string, number>;
  return comparable(s, rv);
}

/**
 * Build (or refresh) `attendance_period_summaries` for the employees in scope (§G.8). Values come from `summarisePeriod`
 * over the daily records of the period with the leave paid flag joined from `leave_records`/`leave_types`. A changed
 * summary bumps `version` and stores the aggregated `record_versions`. `branchId` selects the employees (anyone with a record
 * under that branch in the period); each summary always aggregates all of the employee's records. `finalize` requires an
 * active period lock covering the whole period for the summary's branch and no PENDING days in scope, then stamps
 * `finalized_by/at`; already finalized summaries are left alone unless `finalize` is requested again.
 */
export async function buildPeriodSummaries(trx: Trx, p: PeriodSummaryPayload, now: Date, jobId: string | null): Promise<PeriodSummaryResult> {
  if (p.periodEnd < p.periodStart) throw errors.validation('periodEnd must not precede periodStart.');
  const { organizationId, periodStart, periodEnd } = p;

  // A summary is per (employee, period) and must aggregate ALL of the employee's records in the period: `branchId` therefore
  // scopes the employee set (anyone with a record under that branch in the period), never the record set — otherwise a
  // branch build would overwrite a transferred employee's summary with a partial one.
  let recordsQ = trx.selectFrom('attendanceDailyRecords')
    .select(['id', 'employeeId', 'attendanceDate', 'branchId', 'status', 'flags', 'workedMinutes', 'overtimeMinutes', 'overtimeCategory', 'lateMinutes', 'earlyDepartureMinutes', 'calculationVersion'])
    .where('organizationId', '=', organizationId).where('attendanceDate', '>=', asDate(periodStart)).where('attendanceDate', '<=', asDate(periodEnd));
  if (p.employeeIds?.length) recordsQ = recordsQ.where('employeeId', 'in', p.employeeIds);
  if (p.branchId) {
    const branchId = p.branchId;
    recordsQ = recordsQ.where('employeeId', 'in', (eb) => eb.selectFrom('attendanceDailyRecords').select('employeeId')
      .where('organizationId', '=', organizationId).where('branchId', '=', branchId).where('attendanceDate', '>=', asDate(periodStart)).where('attendanceDate', '<=', asDate(periodEnd)));
  }
  const records = await recordsQ.orderBy('employeeId').orderBy('attendanceDate').execute();

  const employeeIds = new Set<string>(records.map((r) => r.employeeId));
  for (const id of p.employeeIds ?? []) employeeIds.add(id);
  if (employeeIds.size === 0) return { employees: 0, built: 0, changed: 0, unchanged: 0, finalized: 0, skippedFinalized: 0, pendingDays: 0 };
  const ids = [...employeeIds];

  const employees = await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', organizationId).where('id', 'in', ids).where('deletedAt', 'is', null).execute();
  const employeeBranch = new Map(employees.map((e) => [e.id, e.branchId]));

  // leave paid flags per (employee, date) for LEAVE / half-day-leave records
  const leaves = await trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
    .select(['l.employeeId', 'l.startDate', 'l.endDate', 't.isPaid'])
    .where('l.organizationId', '=', organizationId).where('l.status', '=', 'APPROVED').where('l.employeeId', 'in', ids)
    .where('l.startDate', '<=', asDate(periodEnd)).where('l.endDate', '>=', asDate(periodStart)).execute();
  const leavePaid = (employeeId: string, date: string): boolean | null => {
    const hit = leaves.find((l) => l.employeeId === employeeId && isoDate(l.startDate) <= date && isoDate(l.endDate) >= date);
    return hit ? hit.isPaid : null;
  };

  const existingRows = await trx.selectFrom('attendancePeriodSummaries').selectAll()
    .where('organizationId', '=', organizationId).where('periodStart', '=', asDate(periodStart)).where('periodEnd', '=', asDate(periodEnd)).where('employeeId', 'in', ids).execute();
  const existingByEmployee = new Map(existingRows.map((r) => [r.employeeId, r]));

  // finalisation needs an active lock covering the whole period for every branch involved (org-wide lock also qualifies)
  const branchesInvolved = new Set<string>();
  const perEmployee = new Map<string, { branchId: string; records: typeof records }>();
  for (const id of ids) {
    const own = records.filter((r) => r.employeeId === id);
    const last = own[own.length - 1];
    const branchId = last?.branchId ?? employeeBranch.get(id);
    if (!branchId) continue; // deleted employee without records
    perEmployee.set(id, { branchId, records: own });
    branchesInvolved.add(branchId);
  }
  if (p.finalize) {
    const locks = await trx.selectFrom('attendancePeriodLocks').select(['branchId'])
      .where('organizationId', '=', organizationId).where('unlockedAt', 'is', null).where('periodStart', '<=', asDate(periodStart)).where('periodEnd', '>=', asDate(periodEnd)).execute();
    const orgWide = locks.some((l) => l.branchId === null);
    const lockedBranches = new Set(locks.map((l) => l.branchId).filter((b): b is string => b !== null));
    const missing = [...branchesInvolved].filter((b) => !orgWide && !lockedBranches.has(b));
    if (missing.length) throw errors.invalidState('Finalising a period summary requires an active period lock covering the whole period.', { periodStart, periodEnd, branchIds: missing });
  }

  // Aggregate first, write second: finalisation is all-or-nothing over the scope.
  const computed = [...perEmployee].map(([employeeId, { branchId, records: own }]) => {
    const like: PeriodRecordLike[] = own.map((r) => ({
      attendanceDate: isoDate(r.attendanceDate), status: r.status as AttendanceStatus, flags: r.flags as AttendanceFlag[], workedMinutes: r.workedMinutes, overtimeMinutes: r.overtimeMinutes,
      overtimeCategory: (r.overtimeCategory === 'REGULAR' || r.overtimeCategory === 'WEEKLY_OFF' || r.overtimeCategory === 'HOLIDAY') ? r.overtimeCategory : null,
      lateMinutes: r.lateMinutes, earlyDepartureMinutes: r.earlyDepartureMinutes,
      leaveIsPaid: (r.status === 'LEAVE' || (r.flags as string[]).includes('HALF_DAY_LEAVE')) ? leavePaid(r.employeeId, isoDate(r.attendanceDate)) : null,
    }));
    const recordVersions: Record<string, number> = {};
    for (const r of own) recordVersions[r.id] = r.calculationVersion;
    return { employeeId, branchId, summary: summarisePeriod(like, { periodStart, periodEnd }), recordVersions };
  });
  if (p.finalize) {
    // a PENDING day contributes to nothing (neither present nor absent): payroll must not be finalised over unknown days (§G.8)
    const pending = computed.filter((c) => c.summary.pendingDays > 0).map((c) => ({ employeeId: c.employeeId, pendingDays: c.summary.pendingDays }));
    if (pending.length) throw errors.invalidState('Cannot finalise a period with PENDING attendance days; resolve them first.', { periodStart, periodEnd, pending: pending.slice(0, 100), pendingEmployees: pending.length });
  }

  const result: PeriodSummaryResult = { employees: perEmployee.size, built: 0, changed: 0, unchanged: 0, finalized: 0, skippedFinalized: 0, pendingDays: 0 };
  for (const { employeeId, branchId, summary, recordVersions } of computed) {
    result.pendingDays += summary.pendingDays;
    const existing = existingByEmployee.get(employeeId);
    const values = {
      branchId, workingDays: summary.workingDays, presentDays: summary.presentDays, absentDays: summary.absentDays, leaveDays: summary.leaveDays, paidLeaveDays: summary.paidLeaveDays,
      holidayDays: summary.holidayDays, weeklyOffDays: summary.weeklyOffDays, halfDays: summary.halfDays, missingPunchDays: summary.missingPunchDays, lateDays: summary.lateDays,
      regularMinutes: summary.regularMinutes, overtimeMinutes: summary.overtimeMinutes, overtimeWeeklyOffMinutes: summary.overtimeWeeklyOffMinutes, overtimeHolidayMinutes: summary.overtimeHolidayMinutes,
      lateMinutes: summary.lateMinutes, earlyDepartureMinutes: summary.earlyDepartureMinutes, recordVersions: JSON.stringify(recordVersions), computedAt: now,
    };
    const finalizeCols = p.finalize ? { status: 'finalized' as const, finalizedBy: p.requestedBy ?? null, finalizedAt: now } : {};
    if (!existing) {
      await trx.insertInto('attendancePeriodSummaries').values({ organizationId, employeeId, periodStart, periodEnd, version: 1, ...values, ...finalizeCols }).execute();
      result.built++; result.changed++;
      if (p.finalize) result.finalized++;
      continue;
    }
    if (existing.status === 'finalized' && !p.finalize) { result.skippedFinalized++; continue; }
    const changed = fromRow(existing, periodStart, periodEnd, summary.pendingDays, summary.recordCount, summary.totalOvertimeMinutes) !== comparable(summary, recordVersions);
    if (!changed && !p.finalize) { result.unchanged++; continue; }
    await trx.updateTable('attendancePeriodSummaries').set({ ...values, ...finalizeCols, version: changed ? existing.version + 1 : existing.version }).where('id', '=', existing.id).execute();
    result.built++;
    if (changed) result.changed++; else result.unchanged++;
    if (p.finalize) result.finalized++;
  }

  await writeAudit(trx, {
    organizationId, actorUserId: p.requestedBy ?? null, actorType: p.requestedBy ? 'USER' : 'SYSTEM', action: 'payroll.summary_built', entityType: 'attendance_period_summary', entityId: null, branchId: p.branchId ?? null,
    newValue: { periodStart, periodEnd, finalize: p.finalize, ...result }, jobId,
  });
  return result;
}

/** BUILD_PERIOD_SUMMARY handler. `finalize=true` fails with INVALID_STATE (dead-letter) when the period is not locked. */
export async function buildPeriodSummaryHandler({ job, deps, log }: JobContext) {
  const p = parsePayload(periodSummaryPayloadSchema, job.payload);
  const res = await withContext(deps.db, { kind: 'system', organizationId: p.organizationId, jobId: job.id }, (trx) => buildPeriodSummaries(trx, p, deps.now(), job.id));
  log.info(event('period_summaries_built', { periodStart: p.periodStart, periodEnd: p.periodEnd, finalize: p.finalize, ...res }));
  return res;
}

export function registerPeriodSummaryHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'BUILD_PERIOD_SUMMARY', handler: buildPeriodSummaryHandler, timeoutMs: 1_800_000 });
}
