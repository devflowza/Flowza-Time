import { sql } from 'kysely';
import type { Trx } from '../context.js';
import { isoDateOf } from '../attendance/day-marks.js';

/**
 * Comp-off credit bookkeeping (HR portal Prompt 7, Finance parity A13 / B-60). A comp-off leave (the organisation's
 * COMP_OFF type) consumes credits when it is APPROVED — earliest expiry first, then the earliest worked day — and every
 * consumption is a `comp_off_usages` row, so a cancellation releases exactly what the leave took. Credits never go below
 * zero: consumption stops at what is available and reports the shortfall (the caller refuses the approval).
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

/**
 * Take `days` from the employee's usable credits (approved / partially used, not expired on `asOf`) for a comp-off leave.
 * Idempotent per leave: a leave that already holds active usages consumes nothing more.
 */
export async function consumeCompOffCredits(trx: Trx, input: { organizationId: string; employeeId: string; leaveRecordId: string; days: number; asOf: string }): Promise<ConsumeCompOffResult> {
  const existing = await trx.selectFrom('compOffUsages').select(['creditId', 'days']).where('organizationId', '=', input.organizationId).where('leaveRecordId', '=', input.leaveRecordId).where('releasedAt', 'is', null).execute();
  if (existing.length) return { consumedDays: half(existing.reduce((a, u) => a + num(u.days), 0)), shortfallDays: 0, usages: existing.map((u) => ({ creditId: u.creditId, days: num(u.days) })) };
  const credits = await trx.selectFrom('compOffCredits').select(['id', 'branchId', 'daysEarned', 'usedDays', 'expiresOn'])
    .where('organizationId', '=', input.organizationId).where('employeeId', '=', input.employeeId).where('status', 'in', ['approved', 'partially_used'])
    .where('expiresOn', '>=', sql<Date>`${input.asOf}::date`)
    .orderBy('expiresOn', 'asc').orderBy('workedOn', 'asc').orderBy('id', 'asc').forUpdate().execute();
  let needed = half(input.days);
  const usages: Array<{ creditId: string; days: number }> = [];
  for (const c of credits) {
    if (needed <= 0) break;
    const earned = num(c.daysEarned); const used = num(c.usedDays);
    const free = half(earned - used);
    if (free <= 0) continue;
    // a credit gives 0.5 or 1 day, which is exactly what one usage row can hold
    const take = half(Math.min(free, needed));
    await trx.insertInto('compOffUsages').values({ organizationId: input.organizationId, employeeId: input.employeeId, branchId: c.branchId, creditId: c.id, leaveRecordId: input.leaveRecordId, days: take }).execute();
    usages.push({ creditId: c.id, days: take });
    needed = half(needed - take);
    const newUsed = Math.min(earned, half(used + take));
    await trx.updateTable('compOffCredits').set({ usedDays: newUsed, status: compOffCreditStatus(newUsed, earned, false) }).where('id', '=', c.id).execute();
  }
  const consumed = half(usages.reduce((a, u) => a + u.days, 0));
  return { consumedDays: consumed, shortfallDays: half(Math.max(0, half(input.days) - consumed)), usages };
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
