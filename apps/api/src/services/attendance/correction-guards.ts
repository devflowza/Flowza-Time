import { DateTime } from 'luxon';
import type { CreateCorrectionInput } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors, isValidTimezone } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { hasPermission, requireBranchAccess, requireMembership } from '../../lib/authorize.js';
import { isoDate } from '../../lib/mappers.js';
import { type Actor, runUser, withSystemScope } from '../../lib/service.js';
import { dv } from '../features/sql-helpers.js';

/**
 * Guards every attendance correction must pass (HR portal Prompt 6a review), whichever door files it — the Corrections page,
 * HR's record edit, bulk status, self-service. `createCorrection` calls `preValidateCorrection` FIRST; the permission / door
 * rules of the correction itself stay where they are (`correctionAccess`).
 *
 *  - Defect 2 — the day belongs to the branch that OWNED it: the daily record's branch and the effective branch from the
 *    employment history on that date. A branch-scoped caller may only touch a day of one of their branches, even when the
 *    employee has since moved into one (previously only the employee's CURRENT branch was checked, so a transfer opened the
 *    old branch's history to the new branch's HR).
 *  - Defect 6 — a correction that sets a status or places a punch is refused for a date after today in the organisation's
 *    timezone, before the employee's joining date and after their exit date: such a record would count in summaries for a day
 *    the person could not have worked.
 */

/** Correction types that create or re-date attendance (REMOVE_PUNCH only takes an existing punch away and stays allowed). */
const DATED_CORRECTION_TYPES: ReadonlySet<string> = new Set(['ADD_PUNCH', 'EDIT_PUNCH', 'SET_STATUS']);

/** The organisation's IANA zone (read in its system scope: a line manager holds no organization.view). */
export async function organizationTimezone(trx: Trx, orgId: string): Promise<string> {
  const row = await withSystemScope(trx, orgId, (t) => t.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst());
  const tz = row?.timezone ?? 'UTC';
  return isValidTimezone(tz) ? tz : 'UTC';
}

/** Today's date in the organisation's timezone. */
export async function organizationToday(trx: Trx, orgId: string, now: Date = new Date()): Promise<string> {
  return DateTime.fromJSDate(now).setZone(await organizationTimezone(trx, orgId)).toISODate()!;
}

/**
 * The branches that owned an employee's day: the stored daily record's branch and the effective branch of the employment
 * history on that date (else the employee's current branch) — the rule `loadDailyInputs` places the day with. Read in the
 * organisation's system scope ONLY after the caller could see the employee, because the caller's RLS hides exactly the rows
 * that matter here (a record of another branch).
 */
export async function dayOwningBranchIds(trx: Trx, orgId: string, employee: { id: string; branchId: string }, date: string): Promise<string[]> {
  return withSystemScope(trx, orgId, async (t) => {
    const record = await t.selectFrom('attendanceDailyRecords').select('branchId').where('organizationId', '=', orgId).where('employeeId', '=', employee.id).where('attendanceDate', '=', dv(date)).executeTakeFirst();
    const history = await t.selectFrom('employmentHistory').select(['branchId', 'effectiveFrom', 'effectiveTo']).where('organizationId', '=', orgId).where('employeeId', '=', employee.id)
      .where('effectiveFrom', '<=', dv(date)).orderBy('effectiveFrom', 'desc').execute();
    const placed = history.find((h) => h.effectiveTo === null || date < isoDate(h.effectiveTo));
    return [...new Set([record?.branchId, placed?.branchId ?? employee.branchId].filter((b): b is string => typeof b === 'string'))];
  });
}

/** FORBIDDEN unless the caller's branch scope covers every branch that owned the day. */
export async function requireDayBranchAccess(trx: Trx, orgId: string, grant: MembershipGrant, employee: { id: string; branchId: string }, date: string): Promise<void> {
  if (grant.allBranches) return;
  for (const branchId of await dayOwningBranchIds(trx, orgId, employee, date)) requireBranchAccess(grant, branchId);
}

/** VALIDATION_ERROR when the date lies after today (organisation zone), before joining or after exit. */
export function requireDateInEmployment(date: string, today: string, employee: { joiningDate: Date | string; exitDate: Date | string | null }): void {
  if (date > today) throw errors.validation('The date is in the future: attendance can only be set up to today.', { issues: [{ path: 'attendanceDate', message: 'In the future' }], today });
  const joining = isoDate(employee.joiningDate);
  if (date < joining) throw errors.validation(`The date is before the employee joined (${joining}).`, { issues: [{ path: 'attendanceDate', message: 'Before the joining date' }], joiningDate: joining });
  if (employee.exitDate !== null) {
    const exit = isoDate(employee.exitDate);
    if (date > exit) throw errors.validation(`The date is after the employee left (${exit}).`, { issues: [{ path: 'attendanceDate', message: 'After the exit date' }], exitDate: exit });
  }
}

/**
 * Called first by `createCorrection` (attendance.service.ts). A caller who could not file a correction at all, or cannot see the
 * employee, is left to `createCorrection`'s own answers (FORBIDDEN / "Employee not found.") so nothing new is revealed here.
 */
export async function preValidateCorrection(deps: ApiDeps, actor: Actor, orgId: string, input: CreateCorrectionInput): Promise<void> {
  const grant = requireMembership(actor.principal, orgId);
  if (!hasPermission(grant, 'attendance.correct') && !hasPermission(grant, 'attendance.request_correction')) return;
  const own = grant.employeeId !== null && grant.employeeId === input.employeeId;
  await runUser(deps.db, actor, async (trx) => {
    // under the caller's RLS: an employee they cannot see is not examined here
    const emp = await trx.selectFrom('employees').select(['id', 'branchId', 'joiningDate', 'exitDate', 'deletedAt']).where('organizationId', '=', orgId).where('id', '=', input.employeeId).executeTakeFirst();
    if (!emp || emp.deletedAt) return;
    if (!own) await requireDayBranchAccess(trx, orgId, grant, emp, input.attendanceDate);
    if (DATED_CORRECTION_TYPES.has(input.type)) requireDateInEmployment(input.attendanceDate, await organizationToday(trx, orgId), emp);
  });
}
