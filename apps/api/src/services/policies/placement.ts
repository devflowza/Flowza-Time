import { sql } from 'kysely';
import { DEFAULT_POLICY_SECTIONS, policySectionsOf, resolveAttendanceSettings, shiftBreakSchema, type AttendancePolicySections, type ShiftBreak } from '@flowza/contracts';
import { additionalShiftOn, loadAdditionalShiftAssignments, loadEmployeeWorkingCalendars, loadPolicyRows, toPolicyCandidate, type RuleSetRow, type Trx } from '@flowza/database';
import { resolvePolicy, scheduledBreakMinutes, type PolicyScope } from '@flowza/domain';
import { timeToMinutes } from '@flowza/shared';
import { jsonArray, jsonObject } from '../../lib/mappers.js';

/*
 * Where employees sit on a date and which attendance policy applies to them — the same answer as the engine's input loader
 * (packages/database load-inputs.ts + policy.ts), batched for a page of employees: one query per table whatever the page size.
 *
 *   placement   branch / department from employment history (the per-date working calendar), the primary shift from
 *               `resolveShift` with the organisation's default shift where nothing resolves (not on a rotation off day), and
 *               the additional (double) shift when there is no primary one
 *   scope       + the branch's country and the employee's group on the date
 *   policy      the most specific matching policy (packages/domain resolvePolicy)
 *
 * The callers authorise the employees first (the page of employees is read under the caller's RLS and branch scope) and then
 * run these readers in the organisation's system scope (`withSystemScope`): the inputs — assignments, history, patterns,
 * memberships, every policy — are what the engine reads, whatever the caller's own keys reveal. Nothing but the derived
 * placement and the winning policy goes back to the caller.
 */

export interface Placement { branchId: string; departmentId: string | null; shiftId: string | null }
export interface EmployeePolicy { scope: PolicyScope; row: RuleSetRow | null; sections: AttendancePolicySections }

const asDate = (date: string) => sql<Date>`${date}::date`;

/** Placement of each employee on `date` (unknown employees are absent). */
export async function placementsOn(trx: Trx, orgId: string, employeeIds: readonly string[], date: string): Promise<Map<string, Placement>> {
  const ids = [...new Set(employeeIds)];
  const out = new Map<string, Placement>();
  if (ids.length === 0) return out;
  const [{ calendars }, settingsRow, additional] = await Promise.all([
    loadEmployeeWorkingCalendars(trx, orgId, ids, { from: date, to: date }),
    trx.selectFrom('organizationSettings').select('attendance').where('organizationId', '=', orgId).executeTakeFirst(),
    loadAdditionalShiftAssignments(trx, orgId, ids, date, date),
  ]);
  const defaultShiftId = resolveAttendanceSettings(jsonObject(settingsRow?.attendance)).defaultShiftId ?? null;
  for (const id of ids) {
    const calendar = calendars.get(id);
    if (!calendar) continue;
    const day = calendar.day(date);
    const primary = day.shift.shiftId ?? (day.shift.isPatternOff ? null : defaultShiftId);
    const extra = additionalShiftOn(additional.filter((a) => a.employeeId === id), date)?.shiftId ?? null;
    out.set(id, { branchId: day.placement.branchId, departmentId: day.placement.departmentId, shiftId: primary ?? extra });
  }
  return out;
}

/** The employee group of each employee on `date` (absent = none). */
export async function groupsOn(trx: Trx, orgId: string, employeeIds: readonly string[], date: string): Promise<Map<string, string>> {
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return new Map();
  const rows = await trx.selectFrom('employeeGroupMemberships').select(['employeeId', 'employeeGroupId'])
    .where('organizationId', '=', orgId).where('employeeId', 'in', ids)
    .where('effectiveFrom', '<=', asDate(date)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', asDate(date))]))
    .orderBy('effectiveFrom', 'desc').execute();
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.employeeId)) out.set(r.employeeId, r.employeeGroupId);
  return out;
}

/** The policy of each employee on `date` (placement → scope → most specific match); employees without a placement are absent. */
export async function policiesOn(trx: Trx, orgId: string, employeeIds: readonly string[], date: string): Promise<Map<string, EmployeePolicy>> {
  const placements = await placementsOn(trx, orgId, employeeIds, date);
  const out = new Map<string, EmployeePolicy>();
  if (placements.size === 0) return out;
  const branchIds = [...new Set([...placements.values()].map((p) => p.branchId))];
  const [branches, groups, rows] = await Promise.all([
    trx.selectFrom('branches').select(['id', 'countryCode']).where('organizationId', '=', orgId).where('id', 'in', branchIds).execute(),
    groupsOn(trx, orgId, [...placements.keys()], date),
    loadPolicyRows(trx, orgId, date),
  ]);
  const countries = new Map(branches.map((b) => [b.id, b.countryCode?.trim() || null]));
  const candidates = rows.map(toPolicyCandidate);
  for (const [employeeId, p] of placements) {
    const scope: PolicyScope = { countryCode: countries.get(p.branchId) ?? null, branchId: p.branchId, departmentId: p.departmentId, employeeGroupId: groups.get(employeeId) ?? null, shiftId: p.shiftId };
    const winner = resolvePolicy(candidates, date, scope);
    out.set(employeeId, { scope, row: winner?.row ?? null, sections: winner ? policySectionsOf(winner.row.policy) : DEFAULT_POLICY_SECTIONS });
  }
  return out;
}

/** Scheduled minutes of a shift row as the engine counts them: FIXED = span − unpaid breaks, FLEXIBLE = the required minutes. */
export function shiftScheduledMinutes(shift: { type: string; startTime: string | null; endTime: string | null; requiredMinutes: number | null; breaks: unknown }): number {
  if (shift.type !== 'FIXED') return shift.requiredMinutes ?? 0;
  if (!shift.startTime || !shift.endTime) return 0;
  const start = timeToMinutes(shift.startTime.slice(0, 5));
  const end = timeToMinutes(shift.endTime.slice(0, 5));
  const span = end > start ? end - start : end + 1440 - start;
  const breaks: ShiftBreak[] = [];
  for (const b of jsonArray(shift.breaks)) { const parsed = shiftBreakSchema.safeParse(b); if (parsed.success) breaks.push(parsed.data); }
  const unpaid = scheduledBreakMinutes(breaks).unpaid;
  return Math.max(0, span - unpaid);
}
