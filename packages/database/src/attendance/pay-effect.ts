import { sql } from 'kysely';
import type { AttendanceSettings, DayMarkSource } from '@flowza/contracts';
import { leaveTypeAppliesTo, type WorkingCalendar } from '@flowza/domain';
import type { Trx } from '../context.js';
import type { JobQueue } from '../queue.js';
import { activeMarksOn, effectiveBranchOn, markDay, revokeMark, type DayMarkRow } from './day-marks.js';
import { enqueueRecompute } from './recompute-queue.js';
import { COMP_OFF_SYSTEM_KEY, loadLeaveBalances, loadLeaveTypePolicies, loadWorkingCalendars } from '../leave/balances.js';

/**
 * The pay-effect charger (HR portal Prompt 3, Finance parity `_deduct_leave_for_unexcused_note`): the ONE function through
 * which an unexcused day costs the employee something — used by the day-close sweep (auto-deduction) and by the manager's
 * rejection of an attendance note (Prompt 4).
 *
 *   1. never charge a day that is EXCUSED, already charged (PAY_EFFECT / LOP mark) or covered by approved leave;
 *   2. charge paid leave first — the types in `unexcused.leaveTypePriority` in that order, then the paid, tracked type
 *      with the most remaining allowance; types in `excludeLeaveTypeCodes` and unpaid types are never charged — by
 *      writing a PAY_EFFECT mark and an APPROVED `leave_records` row for that single day (half day when 0.5) with
 *      `source = 'INTERNAL'`, `external_ref = 'mark:<mark id>'`, `approved_by = null` (a system decision), so the charge is
 *      auditable and reversible and the engine sees the day as (half) paid leave;
 *   3. otherwise write an LOP mark: the day is loss of pay (`lopDays` on the record, `lop_days` in the period summary).
 *
 * Idempotent per (employee, date): a second call returns `already_charged`. The recompute of the day is queued in the
 * same transaction. Must run in the organisation's system context or a system step: the leave row is APPROVED and the
 * reversal cancels an approved row, which the user-level RLS / guard only allow for `leave.manage` holders.
 */
export type UnexcusedSettings = AttendanceSettings['unexcused'];
export const AUTO_CHARGE_NOTE = 'Unexcused day — auto-charged';

export interface ChargeUnexcusedInput {
  organizationId: string;
  employeeId: string;
  date: string;
  /** 0.5 or 1 (0 = nothing to charge). */
  payEffectDays: number;
  sourceKind: DayMarkSource;
  sourceId?: string | null;
  createdBy?: string | null;
  reason?: string | null;
  /** Which half a 0.5-day charge covers (default FIRST_HALF — a late arrival). */
  halfDayPart?: 'FIRST_HALF' | 'SECOND_HALF';
}
export type ChargeOutcome = 'charged_leave' | 'lop' | 'already_charged' | 'covered_by_leave' | 'excused' | 'no_effect';
export interface ChargeUnexcusedResult { outcome: ChargeOutcome; payEffectDays: 0 | 0.5 | 1; mark: DayMarkRow | null; leaveRecordId: string | null; leaveTypeCode: string | null }

const dv = (date: string) => sql<Date>`${date}::date`;
const normalise = (days: number): 0 | 0.5 | 1 => (!Number.isFinite(days) || days < 0.5 ? 0 : days >= 1 ? 1 : 0.5);

/**
 * The employee's working calendar for [from, to] — the per-date working calendar (leave v2 review P1-1 / P1-2: the branch in
 * force on each date, its weekly offs and holidays, rotation off days), the same one leave counting and the engine use.
 */
export async function loadWorkingCalendar(trx: Trx, organizationId: string, employeeId: string, from: string, to: string): Promise<WorkingCalendar> {
  return (await loadWorkingCalendars(trx, organizationId, [employeeId], from, to)).get(employeeId) ?? { weeklyOffDays: [], holidays: new Set() };
}

interface Candidate { id: string; code: string; remaining: number; priority: number }

/**
 * Paid, tracked leave types that may be charged, with the available balance on the charged date, in charging order.
 * Never charged: unpaid types, untracked types (no allocation, no allowance), special types (`is_special` — sick,
 * maternity, Hajj… — leave v2), the codes in `excludeLeaveTypeCodes`, the comp-off type (credits are earned, not
 * charged), and — leave v2 review P1-3 — a type that does not apply to the employee (`leaveTypeAppliesTo`: gender and
 * employment type, the rule the portal and the API use), so an unexcused day never becomes leave the employee could never
 * have. The balance is read through the ONE balance function (leave v2: allocations, carry-forward, accrual), not
 * recomputed here; pending requests do not reserve (decision of Prompt 3).
 */
async function chargeableLeaveTypes(trx: Trx, organizationId: string, employeeId: string, date: string, settings: UnexcusedSettings): Promise<Candidate[]> {
  const year = Number(date.slice(0, 4));
  const excluded = new Set(settings.excludeLeaveTypeCodes.map((c) => c.toUpperCase()));
  const priority = settings.leaveTypePriority.map((c) => c.toUpperCase());
  const employee = await trx.selectFrom('employees').select(['gender', 'employmentType']).where('organizationId', '=', organizationId).where('id', '=', employeeId).executeTakeFirst();
  if (!employee) return [];
  const types = (await loadLeaveTypePolicies(trx, organizationId))
    .filter((t) => t.isPaid && !t.isSpecial && t.systemKey !== COMP_OFF_SYSTEM_KEY && !excluded.has(t.code.toUpperCase()) && leaveTypeAppliesTo(t, employee));
  if (types.length === 0) return [];
  const balances = (await loadLeaveBalances(trx, organizationId, [employeeId], { year, asOf: date, types })).get(employeeId) ?? [];
  const candidates: Candidate[] = [];
  for (const t of types) {
    const b = balances.find((x) => x.leaveTypeId === t.id);
    if (!b || !b.tracked || b.availableDays === null) continue;
    const idx = priority.indexOf(t.code.toUpperCase());
    candidates.push({ id: t.id, code: t.code, remaining: b.availableDays, priority: idx === -1 ? Number.POSITIVE_INFINITY : idx });
  }
  return candidates.sort((a, b) => a.priority - b.priority || b.remaining - a.remaining || a.code.localeCompare(b.code));
}

export async function chargeUnexcusedDay(trx: Trx, queue: JobQueue, input: ChargeUnexcusedInput, settings: UnexcusedSettings, opts: { now?: Date; correlationId?: string } = {}): Promise<ChargeUnexcusedResult> {
  const now = opts.now ?? new Date();
  const payEffectDays = normalise(input.payEffectDays);
  const none = (outcome: ChargeOutcome, mark: DayMarkRow | null = null): ChargeUnexcusedResult => ({ outcome, payEffectDays, mark, leaveRecordId: null, leaveTypeCode: null });
  if (payEffectDays === 0) return none('no_effect');

  const marks = await activeMarksOn(trx, input.organizationId, input.employeeId, input.date);
  const excused = marks.find((m) => m.kind === 'EXCUSED');
  if (excused) return none('excused', excused);
  const charged = marks.find((m) => m.kind === 'PAY_EFFECT' || m.kind === 'LOP');
  if (charged) return none('already_charged', charged);
  // approved leave covers the day; a PENDING / INFO_REQUESTED request for it is an open explanation (and would clash with
  // the charge under the leave overlap constraint of leave v2) — decide that request first
  const covering = await trx.selectFrom('leaveRecords').select('id').where('organizationId', '=', input.organizationId).where('employeeId', '=', input.employeeId)
    .where('status', 'in', ['APPROVED', 'PENDING', 'INFO_REQUESTED']).where('startDate', '<=', dv(input.date)).where('endDate', '>=', dv(input.date)).executeTakeFirst();
  if (covering) return none('covered_by_leave');

  const pick = (await chargeableLeaveTypes(trx, input.organizationId, input.employeeId, input.date, settings)).find((c) => c.remaining >= payEffectDays);
  const common = { organizationId: input.organizationId, employeeId: input.employeeId, attendanceDate: input.date, source: input.sourceKind, sourceId: input.sourceId ?? null, createdBy: input.createdBy ?? null } as const;
  const markOpts = { now, recomputeReason: 'LEAVE_CHANGE' as const, ...(opts.correlationId ? { correlationId: opts.correlationId } : {}) };
  if (!pick) {
    const { mark } = await markDay(trx, queue, { ...common, kind: 'LOP', payEffectDays, reason: input.reason ?? `${AUTO_CHARGE_NOTE}: no paid leave balance left → loss of pay` }, { ...markOpts, recomputeReason: input.sourceKind === 'HR' || input.sourceKind === 'NOTE_REVIEW' ? 'MANUAL_OVERRIDE' : 'RECALCULATION' });
    return { outcome: 'lop', payEffectDays, mark, leaveRecordId: null, leaveTypeCode: null };
  }
  const { mark } = await markDay(trx, queue, { ...common, kind: 'PAY_EFFECT', payEffectDays, reason: input.reason ?? `${AUTO_CHARGE_NOTE} to ${pick.code}` }, markOpts);
  const branchId = mark.branchId ?? await effectiveBranchOn(trx, input.organizationId, input.employeeId, input.date);
  const leave = await trx.insertInto('leaveRecords').values({
    organizationId: input.organizationId, employeeId: input.employeeId, branchId, leaveTypeId: pick.id, startDate: input.date, endDate: input.date,
    isHalfDay: payEffectDays === 0.5, halfDayPart: payEffectDays === 0.5 ? (input.halfDayPart ?? 'FIRST_HALF') : null, days: payEffectDays,
    status: 'APPROVED', source: 'INTERNAL', externalRef: `mark:${mark.id}`, reason: AUTO_CHARGE_NOTE, decisionNote: AUTO_CHARGE_NOTE, approvedBy: null, approvedAt: now, createdBy: input.createdBy ?? null,
  }).returning('id').executeTakeFirstOrThrow();
  await enqueueRecompute(queue, { organizationId: input.organizationId, employeeId: input.employeeId, date: input.date, reason: 'LEAVE_CHANGE', triggeredBy: input.createdBy ?? null, ...(opts.correlationId ? { correlationId: opts.correlationId } : {}) }, trx);
  return { outcome: 'charged_leave', payEffectDays, mark, leaveRecordId: leave.id, leaveTypeCode: pick.code };
}

export interface ReverseChargeInput {
  organizationId: string;
  employeeId: string;
  date: string;
  revokedBy?: string | null;
  reason: string;
  /** Only undo charges that came from this source (a note id); default: every active charge on the day. */
  sourceId?: string | null;
  /** Only undo charges written by these sources (e.g. SWEEP + NOTE_REVIEW: an employee's reason never undoes HR's own charge); default: any source. */
  sources?: readonly DayMarkSource[];
}
export interface ReverseChargeResult { reversedMarks: DayMarkRow[]; cancelledLeaveRecordIds: string[] }

/** Undo the charge of a day: cancel the internal leave row(s) written for it, revoke the PAY_EFFECT / LOP marks, queue the recompute. Idempotent. */
export async function reverseUnexcusedCharge(trx: Trx, queue: JobQueue, input: ReverseChargeInput, opts: { now?: Date; correlationId?: string } = {}): Promise<ReverseChargeResult> {
  const now = opts.now ?? new Date();
  const marks = (await activeMarksOn(trx, input.organizationId, input.employeeId, input.date))
    .filter((m) => (m.kind === 'PAY_EFFECT' || m.kind === 'LOP') && (input.sourceId === undefined || input.sourceId === null || m.sourceId === input.sourceId)
      && (input.sources === undefined || input.sources.includes(m.source)));
  const reversedMarks: DayMarkRow[] = [];
  const cancelledLeaveRecordIds: string[] = [];
  for (const m of marks) {
    if (m.kind === 'PAY_EFFECT') {
      const cancelled = await trx.updateTable('leaveRecords').set({ status: 'CANCELLED', decisionNote: `${AUTO_CHARGE_NOTE} — reversed: ${input.reason}`.slice(0, 1000) })
        .where('organizationId', '=', input.organizationId).where('employeeId', '=', input.employeeId).where('externalRef', '=', `mark:${m.id}`).where('status', '=', 'APPROVED').returning('id').execute();
      cancelledLeaveRecordIds.push(...cancelled.map((c) => c.id));
    }
    const revoked = await revokeMark(trx, queue, { organizationId: input.organizationId, markId: m.id, revokedBy: input.revokedBy ?? null, reason: input.reason }, { now, recomputeReason: 'LEAVE_CHANGE', ...(opts.correlationId ? { correlationId: opts.correlationId } : {}) });
    if (revoked) reversedMarks.push(revoked);
  }
  return { reversedMarks, cancelledLeaveRecordIds };
}
