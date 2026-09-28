import { sql } from 'kysely';
import type { AttendanceSettings, DayMarkSource } from '@flowza/contracts';
import { countLeaveDays, holidayDates, type WorkingCalendar } from '@flowza/domain';
import type { Trx } from '../context.js';
import type { JobQueue } from '../queue.js';
import { activeMarksOn, effectiveBranchOn, isoDateOf, markDay, revokeMark, type DayMarkRow } from './day-marks.js';
import { enqueueRecompute } from './recompute-queue.js';

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

/** The employee's working calendar (weekly off: employee → branch → organisation; holidays of the branch or default calendar) for [from, to]. */
export async function loadWorkingCalendar(trx: Trx, organizationId: string, employeeId: string, from: string, to: string): Promise<WorkingCalendar> {
  const emp = await trx.selectFrom('employees').select(['branchId', 'weeklyOffDays']).where('organizationId', '=', organizationId).where('id', '=', employeeId).executeTakeFirst();
  const [org, branch] = await Promise.all([
    trx.selectFrom('organizations').select('weeklyOffDays').where('id', '=', organizationId).executeTakeFirst(),
    emp ? trx.selectFrom('branches').select(['weeklyOffDays', 'holidayCalendarId']).where('organizationId', '=', organizationId).where('id', '=', emp.branchId).executeTakeFirst() : Promise.resolve(undefined),
  ]);
  const nums = (v: unknown): number[] | null => (Array.isArray(v) ? v.map(Number) : null);
  const weeklyOffDays = nums(emp?.weeklyOffDays) ?? nums(branch?.weeklyOffDays) ?? nums(org?.weeklyOffDays) ?? [];
  let calendarId = branch?.holidayCalendarId ?? null;
  if (!calendarId) calendarId = (await trx.selectFrom('holidayCalendars').select('id').where('organizationId', '=', organizationId).where('isDefault', '=', true).executeTakeFirst())?.id ?? null;
  const holidays = calendarId
    ? (await trx.selectFrom('holidays').select(['date', 'endDate', 'branchIds']).where('organizationId', '=', organizationId).where('calendarId', '=', calendarId)
        .where('date', '<=', dv(to)).where(sql<boolean>`coalesce(end_date, date) >= ${from}::date`).execute())
        .filter((h) => !h.branchIds || !emp || h.branchIds.includes(emp.branchId))
        .map((h) => ({ date: isoDateOf(h.date), endDate: h.endDate === null ? null : isoDateOf(h.endDate) }))
    : [];
  return { weeklyOffDays, holidays: holidayDates(holidays) };
}

interface Candidate { id: string; code: string; remaining: number; priority: number }

/** Paid, tracked, non-excluded leave types with their remaining allowance for the year, in charging order. */
async function chargeableLeaveTypes(trx: Trx, organizationId: string, employeeId: string, date: string, settings: UnexcusedSettings): Promise<Candidate[]> {
  const year = Number(date.slice(0, 4));
  const from = `${year}-01-01`; const to = `${year}-12-31`;
  const excluded = new Set(settings.excludeLeaveTypeCodes.map((c) => c.toUpperCase()));
  const priority = settings.leaveTypePriority.map((c) => c.toUpperCase());
  const types = (await trx.selectFrom('leaveTypes').select(['id', 'code', 'annualAllowanceDays']).where('organizationId', '=', organizationId).where('status', '=', 'active').where('isPaid', '=', true).execute())
    .filter((t) => t.annualAllowanceDays !== null && !excluded.has(String(t.code).toUpperCase()));
  if (types.length === 0) return [];
  const cal = await loadWorkingCalendar(trx, organizationId, employeeId, from, to);
  const records = await trx.selectFrom('leaveRecords').select(['leaveTypeId', 'startDate', 'endDate', 'isHalfDay'])
    .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId).where('status', '=', 'APPROVED').where('leaveTypeId', 'in', types.map((t) => t.id))
    .where('startDate', '<=', dv(to)).where('endDate', '>=', dv(from)).execute();
  const clip = { from, to };
  const candidates: Candidate[] = types.map((t) => {
    const used = records.filter((r) => r.leaveTypeId === t.id).reduce((a, r) => a + countLeaveDays({ startDate: isoDateOf(r.startDate), endDate: isoDateOf(r.endDate), isHalfDay: r.isHalfDay }, cal, clip), 0);
    const code = String(t.code).toUpperCase();
    const idx = priority.indexOf(code);
    return { id: t.id, code: String(t.code), remaining: Number(t.annualAllowanceDays) - used, priority: idx === -1 ? Number.POSITIVE_INFINITY : idx };
  });
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
  const covering = await trx.selectFrom('leaveRecords').select('id').where('organizationId', '=', input.organizationId).where('employeeId', '=', input.employeeId)
    .where('status', '=', 'APPROVED').where('startDate', '<=', dv(input.date)).where('endDate', '>=', dv(input.date)).executeTakeFirst();
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
    isHalfDay: payEffectDays === 0.5, halfDayPart: payEffectDays === 0.5 ? (input.halfDayPart ?? 'FIRST_HALF') : null,
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
