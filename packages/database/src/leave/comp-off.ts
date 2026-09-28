import { sql } from 'kysely';
import { allocateCompOffCredits, compOffDemandOf, type CompOffCreditSlot, type CompOffDemandDay, type LeaveCountMode } from '@flowza/domain';
import type { Trx } from '../context.js';
import { isoDateOf } from '../attendance/day-marks.js';
import { COMP_OFF_SYSTEM_KEY, loadWorkingCalendars } from './balances.js';

/**
 * Comp-off credit bookkeeping (HR portal Prompt 7, Finance parity A13 / B-60). A comp-off leave (the organisation's
 * COMP_OFF type) consumes credits when it is APPROVED — earliest expiry first, then the earliest worked day — and every
 * consumption is a `comp_off_usages` row, so a cancellation releases exactly what the leave took. Credits never go below
 * zero: consumption stops at what is available and reports the shortfall (the caller refuses the approval). Leave v2
 * review P2-4: a credit pays only for leave dated on or before its expiry — each date of the leave is matched against the
 * credits (`allocateCompOffCredits`), at application (`compOffCoverage`) and at approval (`consumeCompOffCredits`) alike.
 *
 * Runs in the organisation's system context (credits and usages have no client write path beyond the self request).
 */

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const half = (n: number) => Math.round(n * 2) / 2;

/** A credit's status from what it paid for (and whether it is past its expiry). */
export function compOffCreditStatus(usedDays: number, daysEarned: number, expired: boolean): 'approved' | 'partially_used' | 'used' | 'expired' {
  if (usedDays >= daysEarned) return 'used';
  if (expired) return 'expired';
  return usedDays > 0 ? 'partially_used' : 'approved';
}

export interface ConsumeCompOffResult { consumedDays: number; shortfallDays: number; usages: Array<{ creditId: string; days: number }> }

type CreditRow = { id: string; branchId: string; daysEarned: unknown; usedDays: unknown; expiresOn: Date | string | null; workedOn: Date | string };
const toSlot = (c: CreditRow): CompOffCreditSlot => ({ id: c.id, freeDays: half(num(c.daysEarned) - num(c.usedDays)), expiresOn: isoDateOf(c.expiresOn!), workedOn: isoDateOf(c.workedOn) });

/** Credits that can still pay (approved / partially used, with an expiry on or after `from`), earliest expiry first. */
function usableCredits(trx: Trx, organizationId: string, employeeId: string, from: string) {
  return trx.selectFrom('compOffCredits').select(['id', 'branchId', 'daysEarned', 'usedDays', 'expiresOn', 'workedOn'])
    .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId).where('status', 'in', ['approved', 'partially_used'])
    .where('expiresOn', 'is not', null).where('expiresOn', '>=', sql<Date>`${from}::date`)
    .orderBy('expiresOn', 'asc').orderBy('workedOn', 'asc').orderBy('id', 'asc');
}

/**
 * Take what a comp-off leave charges from the employee's credits — each charged date (`demand`, see `compOffDemandOf`) from
 * the credit expiring first among those still valid on that date (review P2-4). Idempotent per leave: a leave that already
 * holds active usages consumes nothing more. Locks the credits it may use.
 */
export async function consumeCompOffCredits(trx: Trx, input: { organizationId: string; employeeId: string; leaveRecordId: string; demand: readonly CompOffDemandDay[] }): Promise<ConsumeCompOffResult> {
  const existing = await trx.selectFrom('compOffUsages').select(['creditId', 'days']).where('organizationId', '=', input.organizationId).where('leaveRecordId', '=', input.leaveRecordId).where('releasedAt', 'is', null).execute();
  if (existing.length) return { consumedDays: half(existing.reduce((a, u) => a + num(u.days), 0)), shortfallDays: 0, usages: existing.map((u) => ({ creditId: u.creditId, days: num(u.days) })) };
  const needed = half(input.demand.reduce((a, d) => a + d.days, 0));
  if (needed <= 0) return { consumedDays: 0, shortfallDays: 0, usages: [] };
  const first = input.demand.map((d) => d.date).sort()[0]!;
  const credits = (await usableCredits(trx, input.organizationId, input.employeeId, first).forUpdate().execute()) as CreditRow[];
  const plan = allocateCompOffCredits(credits.map(toSlot), input.demand.map((d) => ({ date: d.date, days: d.days })));
  const byId = new Map(credits.map((c) => [c.id, c]));
  const usages: Array<{ creditId: string; days: number }> = [];
  for (const u of plan.usages) {
    const c = byId.get(u.creditId)!;
    const earned = num(c.daysEarned); const used = num(c.usedDays);
    // a credit gives 0.5 or 1 day, which is exactly what one usage row can hold
    await trx.insertInto('compOffUsages').values({ organizationId: input.organizationId, employeeId: input.employeeId, branchId: c.branchId, creditId: c.id, leaveRecordId: input.leaveRecordId, days: u.days }).execute();
    usages.push({ creditId: c.id, days: u.days });
    const newUsed = Math.min(earned, half(used + u.days));
    await trx.updateTable('compOffCredits').set({ usedDays: newUsed, status: compOffCreditStatus(newUsed, earned, false) }).where('id', '=', c.id).execute();
  }
  const consumed = half(usages.reduce((a, u) => a + u.days, 0));
  return { consumedDays: consumed, shortfallDays: half(Math.max(0, needed - consumed)), usages };
}

/** The comp-off demand of a leave: its charged dates by the per-date working calendar (reconciled with its stored days). */
export async function compOffLeaveDemand(trx: Trx, organizationId: string, leave: { employeeId: string; startDate: string; endDate: string; isHalfDay: boolean; days: number | null }, countMode: LeaveCountMode, key?: string): Promise<CompOffDemandDay[]> {
  const cal = (await loadWorkingCalendars(trx, organizationId, [leave.employeeId], leave.startDate, leave.endDate)).get(leave.employeeId) ?? { weeklyOffDays: [], holidays: new Set<string>() };
  return compOffDemandOf({ startDate: leave.startDate, endDate: leave.endDate, isHalfDay: leave.isHalfDay, days: leave.days }, cal, countMode, key);
}

/**
 * How many days of a comp-off application the employee's credits can pay (review P2-4), after the other undecided comp-off
 * requests reserve theirs (they are served first on a shared date): each date needs a credit still valid on it. Read-only.
 */
export async function compOffCoverage(trx: Trx, organizationId: string, employeeId: string, request: { startDate: string; endDate: string; isHalfDay: boolean; days: number; countMode: LeaveCountMode }, opts: { excludeRecordId?: string } = {}): Promise<{ coverableDays: number; shortfallDays: number }> {
  let pendingQuery = trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
    .select(['l.id', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.days', 't.countMode'])
    .where('l.organizationId', '=', organizationId).where('l.employeeId', '=', employeeId).where('t.systemKey', '=', COMP_OFF_SYSTEM_KEY).where('l.status', 'in', ['PENDING', 'INFO_REQUESTED']);
  if (opts.excludeRecordId) pendingQuery = pendingQuery.where('l.id', '!=', opts.excludeRecordId);
  const pending = await pendingQuery.execute();
  const ranges = [...pending.map((p) => ({ startDate: isoDateOf(p.startDate), endDate: isoDateOf(p.endDate) })), { startDate: request.startDate, endDate: request.endDate }];
  const from = ranges.map((r) => r.startDate).sort()[0]!;
  const to = ranges.map((r) => r.endDate).sort().pop()!;
  const cal = (await loadWorkingCalendars(trx, organizationId, [employeeId], from, to)).get(employeeId) ?? { weeklyOffDays: [], holidays: new Set<string>() };
  const demand: CompOffDemandDay[] = [
    ...pending.flatMap((p) => compOffDemandOf({ startDate: isoDateOf(p.startDate), endDate: isoDateOf(p.endDate), isHalfDay: p.isHalfDay, days: p.days === null ? null : num(p.days) }, cal, p.countMode === 'calendar' ? 'calendar' : 'working', p.id)),
    ...compOffDemandOf({ startDate: request.startDate, endDate: request.endDate, isHalfDay: request.isHalfDay, days: request.days }, cal, request.countMode, 'this'),
  ];
  if (!demand.length) return { coverableDays: request.days, shortfallDays: 0 };
  const credits = (await usableCredits(trx, organizationId, employeeId, from).execute()) as CreditRow[];
  const plan = allocateCompOffCredits(credits.map(toSlot), demand, { lastKey: 'this' });
  const shortfall = plan.shortfall.get('this') ?? 0;
  return { coverableDays: half(Math.max(0, request.days - shortfall)), shortfallDays: shortfall };
}

/** Give back what a comp-off leave consumed (cancellation, rejection after approval, an edit that re-books it). Idempotent. */
export async function releaseCompOffCredits(trx: Trx, input: { organizationId: string; leaveRecordId: string; asOf: string; now?: Date }): Promise<number> {
  const usages = await trx.selectFrom('compOffUsages').select(['id', 'creditId', 'days']).where('organizationId', '=', input.organizationId).where('leaveRecordId', '=', input.leaveRecordId).where('releasedAt', 'is', null).forUpdate().execute();
  if (!usages.length) return 0;
  await trx.updateTable('compOffUsages').set({ releasedAt: input.now ?? new Date() }).where('id', 'in', usages.map((u) => u.id)).execute();
  const byCredit = new Map<string, number>();
  for (const u of usages) byCredit.set(u.creditId, half((byCredit.get(u.creditId) ?? 0) + num(u.days)));
  const credits = await trx.selectFrom('compOffCredits').select(['id', 'daysEarned', 'usedDays', 'expiresOn']).where('id', 'in', [...byCredit.keys()]).forUpdate().execute();
  for (const c of credits) {
    const earned = num(c.daysEarned);
    const newUsed = Math.max(0, half(num(c.usedDays) - (byCredit.get(c.id) ?? 0)));
    const expired = c.expiresOn !== null && isoDateOf(c.expiresOn) < input.asOf;
    await trx.updateTable('compOffCredits').set({ usedDays: newUsed, status: compOffCreditStatus(newUsed, earned, expired) }).where('id', '=', c.id).execute();
  }
  return half(usages.reduce((a, u) => a + num(u.days), 0));
}

/** Mark approved / partially used credits whose expiry has passed (`expires_on < asOf`) expired. Returns the credits touched. */
export async function expireCompOffCredits(trx: Trx, organizationId: string, asOf: string): Promise<Array<{ id: string; employeeId: string; remainingDays: number; expiresOn: string }>> {
  const rows = await trx.updateTable('compOffCredits').set({ status: 'expired' })
    .where('organizationId', '=', organizationId).where('status', 'in', ['approved', 'partially_used']).where('expiresOn', '<', sql<Date>`${asOf}::date`)
    .returning(['id', 'employeeId', 'daysEarned', 'usedDays', 'expiresOn']).execute();
  return rows.map((r) => ({ id: r.id, employeeId: r.employeeId, remainingDays: half(num(r.daysEarned) - num(r.usedDays)), expiresOn: r.expiresOn === null ? asOf : isoDateOf(r.expiresOn) }));
}
