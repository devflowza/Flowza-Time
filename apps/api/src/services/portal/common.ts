import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { resolveAttendanceSettings, type AttendanceSettings, type DomainEventType, type Permission } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import { hasPermission, isTeamMember, requireMembership } from '../../lib/authorize.js';
import { type Actor, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateOrNull } from '../../lib/mappers.js';
import { loadSettings } from '../../lib/settings.js';

/**
 * Shared plumbing of the employee-portal attendance services (HR portal Prompt 4): who the caller is in the organisation,
 * the employee's reference data, the organisation's attendance policy, local time, and targeted notifications.
 *
 * Reference data (branch, teams, managers, settings) is read in the organisation's SYSTEM scope — an employee's role
 * cannot read the branch table or the organisation settings — but only ever for an employee id the service has already
 * authorised: the caller's own membership link, or one the manager / HR checks admitted.
 */

export interface PortalSelf { grant: MembershipGrant; employeeId: string }

/** The caller's own employee record in the organisation (never a client-supplied id), optionally with one of the keys. */
export function portalSelf(actor: Actor, orgId: string, ...anyOf: Permission[]): PortalSelf {
  const grant = requireMembership(actor.principal, orgId);
  if (!grant.employeeId) throw errors.forbidden('Your account is not linked to an employee record in this organisation.');
  if (anyOf.length > 0 && !anyOf.some((p) => hasPermission(grant, p))) throw errors.forbidden(`Missing permission: ${anyOf.join(' or ')}.`);
  return { grant, employeeId: grant.employeeId };
}

export interface EmployeeCtx {
  id: string;
  displayName: string;
  employeeNumber: string;
  branchId: string;
  branchName: string | null;
  departmentId: string | null;
  managerEmployeeId: string | null;
  secondaryManagerEmployeeId: string | null;
  employmentStatus: string;
  joiningDate: string;
  exitDate: string | null;
  weeklyOffDays: number[] | null;
  branchWeeklyOffDays: number[] | null;
  orgWeeklyOffDays: number[];
  holidayCalendarId: string | null;
  teamIds: string[];
  /** Branch timezone → organisation timezone → UTC. */
  timezone: string;
}

const nums = (v: unknown): number[] | null => (Array.isArray(v) ? v.map(Number) : null);

/** Reference data of one (already authorised) employee, in the organisation's system scope. 404 when unknown or deleted. */
export async function loadEmployeeCtx(trx: Trx, orgId: string, employeeId: string): Promise<EmployeeCtx> {
  return withSystemScope(trx, orgId, async (t) => {
    const e = await t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber', 'branchId', 'departmentId', 'managerEmployeeId', 'secondaryManagerEmployeeId', 'employmentStatus', 'joiningDate', 'exitDate', 'weeklyOffDays'])
      .where('organizationId', '=', orgId).where('id', '=', employeeId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!e) throw errors.notFound('Employee', employeeId);
    const [org, branch, teams, defaultCalendar] = await Promise.all([
      t.selectFrom('organizations').select(['timezone', 'weeklyOffDays']).where('id', '=', orgId).executeTakeFirstOrThrow(),
      t.selectFrom('branches').select(['id', 'name', 'timezone', 'weeklyOffDays', 'holidayCalendarId']).where('organizationId', '=', orgId).where('id', '=', e.branchId).executeTakeFirst(),
      t.selectFrom('teamMembers').select('teamId').where('organizationId', '=', orgId).where('employeeId', '=', employeeId).execute(),
      t.selectFrom('holidayCalendars').select('id').where('organizationId', '=', orgId).where('isDefault', '=', true).executeTakeFirst(),
    ]);
    return {
      id: e.id, displayName: e.displayName, employeeNumber: e.employeeNumber, branchId: e.branchId, branchName: branch?.name ?? null, departmentId: e.departmentId,
      managerEmployeeId: e.managerEmployeeId, secondaryManagerEmployeeId: e.secondaryManagerEmployeeId, employmentStatus: String(e.employmentStatus),
      joiningDate: isoDate(e.joiningDate), exitDate: isoDateOrNull(e.exitDate), weeklyOffDays: nums(e.weeklyOffDays), branchWeeklyOffDays: nums(branch?.weeklyOffDays),
      orgWeeklyOffDays: nums(org.weeklyOffDays) ?? [], holidayCalendarId: branch?.holidayCalendarId ?? defaultCalendar?.id ?? null,
      teamIds: teams.map((x) => x.teamId), timezone: branch?.timezone || org.timezone || 'UTC',
    };
  });
}

/** Weekly off days in force: employee → branch → organisation (the engine's precedence). */
export const weeklyOffOf = (e: EmployeeCtx): number[] => e.weeklyOffDays ?? e.branchWeeklyOffDays ?? e.orgWeeklyOffDays;

/** True when the employee can still work (not terminated / resigned, not past the exit date). */
export function isWorking(e: EmployeeCtx, today: string): boolean {
  if (e.employmentStatus === 'terminated' || e.employmentStatus === 'resigned') return false;
  return !(e.exitDate && e.exitDate < today);
}

/** The organisation's effective attendance policy (defaults filled in), read in its system scope. */
export async function attendancePolicy(trx: Trx, orgId: string): Promise<AttendanceSettings> {
  return withSystemScope(trx, orgId, async (t) => resolveAttendanceSettings((await loadSettings(t, orgId)).attendance));
}

export interface LocalInstant { date: string; minuteOfDay: number; isoWeekday: number; iso: string }
/** An instant in an IANA zone as the geofence / window rules read it. */
export function localInstant(at: Date, tz: string): LocalInstant {
  const dt = DateTime.fromJSDate(at).setZone(tz);
  const local = dt.isValid ? dt : DateTime.fromJSDate(at).toUTC();
  return { date: local.toISODate()!, minuteOfDay: local.hour * 60 + local.minute, isoWeekday: local.weekday, iso: local.toISO()! };
}
export const localDate = (at: Date, tz: string): string => localInstant(at, tz).date;

/** A local-time window (`HH:mm`) that may wrap midnight; null = any time; start = end = the whole day. Inclusive minutes. */
export function inLocalWindow(window: { start: string; end: string } | null, minuteOfDay: number): boolean {
  if (!window) return true;
  const m = (hhmm: string) => { const [h, mm] = hhmm.split(':'); return Number(h) * 60 + Number(mm); };
  const start = m(window.start); const end = m(window.end);
  if (start === end) return true;
  return start < end ? minuteOfDay >= start && minuteOfDay <= end : minuteOfDay >= start || minuteOfDay <= end;
}

/** Serialise concurrent writers of one employee's self-service rows (punches, notes, swaps) for the rest of the transaction. */
export async function lockEmployee(trx: Trx, scope: string, employeeId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`flowza:${scope}:${employeeId}`}, 0))`.execute(trx);
}

/** Active login(s) of employees (membership employee link). System scope. */
export async function userIdsOfEmployees(trx: Trx, orgId: string, employeeIds: readonly (string | null | undefined)[]): Promise<string[]> {
  const ids = [...new Set(employeeIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return [];
  const rows = await withSystemScope(trx, orgId, (t) => t.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('status', '=', 'active').where('employeeId', 'in', ids).execute());
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * Who hears about an employee's portal activity: the primary and secondary line managers' logins; when neither has one,
 * the members who hold `fallbackPermission` AND can open the employee (organisation-wide `attendance.view`, all branches
 * or the employee's branch). Never the employee themselves.
 */
export async function lineManagerUserIds(trx: Trx, orgId: string, employee: Pick<EmployeeCtx, 'id' | 'branchId' | 'managerEmployeeId' | 'secondaryManagerEmployeeId'>, fallbackPermission: Permission = 'attendance.approve'): Promise<string[]> {
  const own = new Set(await userIdsOfEmployees(trx, orgId, [employee.id]));
  const managers = (await userIdsOfEmployees(trx, orgId, [employee.managerEmployeeId, employee.secondaryManagerEmployeeId])).filter((u) => !own.has(u));
  if (managers.length > 0) return managers;
  const rows = await withSystemScope(trx, orgId, (t) => sql<{ userId: string }>`
    select distinct m.user_id as "userId" from public.org_memberships m
    where m.organization_id = ${orgId}::uuid and m.status = 'active'
      and exists (select 1 from public.role_permissions rp where rp.role_id = m.role_id and rp.permission_key = ${fallbackPermission})
      and exists (select 1 from public.role_permissions rp where rp.role_id = m.role_id and rp.permission_key = 'attendance.view')
      and (m.all_branches or exists (select 1 from public.membership_branches mb where mb.membership_id = m.id and mb.branch_id = ${employee.branchId}::uuid))`.execute(t));
  return rows.rows.map((r) => r.userId).filter((u) => !own.has(u)).sort();
}

/** A domain event whose notification is targeted at exactly `userIds` (the outbox routes it with `recipients: 'users'`). */
export async function emitToUsers(trx: Trx, actor: Actor | null, orgId: string, eventType: DomainEventType, aggregate: { type: string; id: string }, userIds: readonly string[], payload: Record<string, unknown>): Promise<void> {
  const ids = [...new Set(userIds.filter((u): u is string => !!u && (!actor || u !== actor.userId)))];
  await emitDomainEvent(trx, { organizationId: orgId, eventType, aggregateType: aggregate.type, aggregateId: aggregate.id, payload: { ...payload, userIds: ids }, actorUserId: actor?.userId ?? null, requestId: actor?.requestId ?? null });
}

/**
 * The manager / HR side of an employee's portal item (a selfie, the attendance grants, a note without a live request):
 * `manager` = one of the employee's line managers (primary or secondary on the employee record); `oversight` = an
 * organisation-wide holder of one of `approveKeys` (with `attendance.view`, within the branch scope). The person the item
 * is about never acts on it — also when their membership still links them to the employee (live link).
 */
export function reviewerRole(grant: MembershipGrant, employee: { id: string; branchId: string | null }, approveKeys: readonly Permission[]): 'manager' | 'oversight' | null {
  if (grant.employeeId && grant.employeeId === employee.id) return null;
  if (isTeamMember(grant, employee.id)) return 'manager';
  const branchOk = grant.allBranches || !employee.branchId || grant.branchIds.includes(employee.branchId);
  if (branchOk && hasPermission(grant, 'attendance.view') && approveKeys.some((k) => hasPermission(grant, k))) return 'oversight';
  return null;
}

/** `app.is_period_locked` (the same check corrections and leave use); kept here so the portal modules import no service with engine dependencies. */
export async function isPeriodLocked(trx: Trx, orgId: string, branchId: string | null, date: string): Promise<boolean> {
  const res = await sql<{ locked: boolean }>`select app.is_period_locked(${orgId}::uuid, ${branchId}::uuid, ${date}::date) as locked`.execute(trx);
  return res.rows[0]?.locked ?? false;
}
