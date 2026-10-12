import { type z } from 'zod';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { TEAM_PERMISSIONS, type BulkEmployeeAction, type CreateEmployeeInput, type DeleteEmployeeInput, type EmployeeDeviceStateDto, type EmployeeDto, type EmployeeListQuery, type EmploymentHistoryDto, type IdentityDocumentDto, type UpdateEmployeeInput, type identityDocumentInputSchema } from '@flowza/contracts';
import { emitDomainEvent, locationLabels, type Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { branchFilter, hasPermission, requireAnyPermission, requireBranchAccess, requirePermission } from '../lib/authorize.js';
import { assertPlaceOfBranch, locationScope } from '../lib/location-scope.js';
import { type Actor, runUser, audit, diffObjects, withSystemScope } from '../lib/service.js';
import { enqueueJob } from '../lib/jobs.js';
import { hashPin } from '../lib/hashing.js';
import { loadSettings } from '../lib/settings.js';
import { assertUserCapacity } from './features/user-limit.js';
import { enqueueRecalculation, recalcTodayForLocationChange } from './features/recalc.js';
import { assignmentEndToStored } from './features/assignment-dates.js';
import { likeContains, pageOf, prefixTsQuery, resolveSort, toCount } from '../lib/pagination.js';
import { isoDate } from '../lib/mappers.js';
import { DOCUMENT_COLUMNS, EMPLOYEE_COLUMNS, EMPTY_SYNC_SUMMARY, HISTORY_COLUMNS, toDeviceStateDto, toDocumentDto, toEmployeeDto, toHistoryDto, type DeviceSyncSummary, type DeviceStateRow, type EmployeeRow, type HistoryRow } from './employees.mappers.js';
import { LEFT_EMPLOYMENT_STATUSES, hasLeft, offboardLinkedLogins, removeLeaversFromDevices } from './offboarding.js';

type IdentityDocumentInput = z.infer<typeof identityDocumentInputSchema>;

const EMPLOYEE_SORT = {
  employeeNumber: 'e.employee_number', displayName: 'e.display_name', firstName: 'e.first_name', lastName: 'e.last_name', joiningDate: 'e.joining_date', exitDate: 'e.exit_date',
  employmentStatus: 'e.employment_status', employmentType: 'e.employment_type', branch: 'b.name', department: 'd.name', designation: 'g.name', deviceUserId: 'e.device_user_id',
  createdAt: 'e.created_at', updatedAt: 'e.updated_at',
} as const;

/**
 * Sensitive personal columns (date of birth, phone) are only returned to callers holding `employee.view_sensitive`
 * (same rule as exports, AGENTS.md); everyone else sees null. Identity documents live behind their own endpoint.
 */
function maskSensitive<T extends EmployeeDto>(dto: T, grant: MembershipGrant): T {
  if (hasPermission(grant, 'employee.view_sensitive')) return dto;
  return { ...dto, dateOfBirth: null, phone: null };
}

function employeeQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('employees as e')
    .leftJoin('branches as b', 'b.id', 'e.branchId')
    .leftJoin('departments as d', 'd.id', 'e.departmentId')
    .leftJoin('designations as g', 'g.id', 'e.designationId')
    .leftJoin('employees as mgr', 'mgr.id', 'e.managerEmployeeId')
    .leftJoin('employees as mgr2', 'mgr2.id', 'e.secondaryManagerEmployeeId')
    .where('e.organizationId', '=', orgId);
}

/**
 * Employees already linked to a login of this organisation (any membership status) or reserved by a pending invitation.
 * Read in the organisation's system scope: memberships are hidden from callers without user.view, and the filter must
 * be exact for whoever picks an employee for a new login. Returns ids only.
 */
async function linkedEmployeeIds(trx: Trx, orgId: string): Promise<string[]> {
  return withSystemScope(trx, orgId, async (t) => {
    const members = await t.selectFrom('orgMemberships').select('employeeId').where('organizationId', '=', orgId).where('employeeId', 'is not', null).execute();
    const invited = await t.selectFrom('invitations').select('employeeId').where('organizationId', '=', orgId).where('employeeId', 'is not', null).where('acceptedAt', 'is', null).where('revokedAt', 'is', null).where('expiresAt', '>', new Date()).execute();
    return [...new Set([...members, ...invited].map((r) => r.employeeId).filter((id): id is string => !!id))];
  });
}

async function syncSummaries(trx: Trx, orgId: string, employeeIds: string[]): Promise<Map<string, DeviceSyncSummary>> {
  const out = new Map<string, DeviceSyncSummary>();
  if (employeeIds.length === 0) return out;
  const rows = await trx.selectFrom('deviceEmployeeStates').select(['employeeId', 'syncStatus', (eb) => eb.fn.countAll().as('n')])
    .where('organizationId', '=', orgId).where('desired', '=', true).where('employeeId', 'in', employeeIds).groupBy(['employeeId', 'syncStatus']).execute();
  for (const r of rows) {
    if (!r.employeeId) continue;
    const s = out.get(r.employeeId) ?? { ...EMPTY_SYNC_SUMMARY };
    const n = toCount(r.n);
    s.total += n;
    if (r.syncStatus === 'IN_SYNC') s.inSync += n;
    else if (r.syncStatus === 'FAILED') s.failed += n;
    else if (r.syncStatus === 'OFFLINE') s.offline += n;
    else s.pending += n;
    out.set(r.employeeId, s);
  }
  return out;
}

/** Who may read the employee directory: organisation-wide (branch-scoped) viewers, and line managers for their team. */
const DIRECTORY_KEYS = ['employee.view', 'employee.view_team'] as const;

/**
 * Employees the RLS read rule of `employees` shows a branch-scoped `employee.view` holder beyond their branches: their own
 * record (self column) and, with any team key, their direct reports (team predicate). The service's branch filter must
 * not hide what the database shows.
 */
function visibleBeyondBranches(grant: MembershipGrant): string[] {
  const ids = grant.employeeId ? [grant.employeeId] : [];
  if (TEAM_PERMISSIONS.some((p) => hasPermission(grant, p))) ids.push(...grant.teamEmployeeIds);
  return [...new Set(ids)];
}

export async function listEmployees(deps: ApiDeps, actor: Actor, orgId: string, q: EmployeeListQuery): Promise<{ data: EmployeeDto[]; total: number }> {
  const grant = requireAnyPermission(actor.principal, orgId, ...DIRECTORY_KEYS);
  // "which employees already have a login" is user-management knowledge, answered in system scope: user.view only
  if (q.unlinked) requirePermission(actor.principal, orgId, 'user.view');
  // An organisation-wide viewer is narrowed to their branches (RLS again underneath). A team-only viewer (a line manager:
  // employee.view_team) gets no branch filter — RLS already limits them to their own record and their direct reports,
  // wherever those sit; an explicit branchId is then a plain filter over those rows.
  const orgWide = hasPermission(grant, 'employee.view');
  const scope = orgWide ? branchFilter(grant, q.branchId) : q.branchId ? [q.branchId] : null;
  const beyond = orgWide && scope && !q.branchId ? visibleBeyondBranches(grant) : [];
  const sort = resolveSort(EMPLOYEE_SORT, q.sort, q.order, 'e.employee_number');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    // `locationId` (docs/locations.md §2): a group / branch location → the employees of its branches, a place → the employees
    // working in it or below; ANDed with the branch scope above (NOT_FOUND for a location the caller cannot see)
    const loc = q.locationId ? await locationScope(trx, orgId, q.locationId, scope) : null;
    let base = employeeQuery(trx, orgId);
    if (!q.includeDeleted) base = base.where('e.deletedAt', 'is', null);
    if (scope) base = beyond.length ? base.where((eb) => eb.or([eb('e.branchId', 'in', scope), eb('e.id', 'in', beyond)])) : base.where('e.branchId', 'in', scope);
    if (loc?.branchIds) base = base.where('e.branchId', 'in', loc.branchIds);
    if (loc?.placeIds) base = base.where('e.workLocationId', 'in', loc.placeIds);
    if (q.departmentId) base = base.where('e.departmentId', '=', q.departmentId);
    if (q.designationId) base = base.where('e.designationId', '=', q.designationId);
    if (q.employmentStatus) base = base.where('e.employmentStatus', '=', q.employmentStatus);
    if (q.employmentType) base = base.where('e.employmentType', '=', q.employmentType);
    if (q.managerEmployeeId) base = base.where('e.managerEmployeeId', '=', q.managerEmployeeId);
    if (q.teamOf) { const id = q.teamOf; base = base.where((eb) => eb.or([eb('e.managerEmployeeId', '=', id), eb('e.secondaryManagerEmployeeId', '=', id)])); }
    if (q.unlinked) {
      const linked = await linkedEmployeeIds(trx, orgId);
      if (linked.length) base = base.where('e.id', 'not in', linked);
      // somebody who left can never be given a login (members.service refuses the link), so they are no candidate
      base = base.where('e.employmentStatus', 'not in', [...LEFT_EMPLOYMENT_STATUSES]);
    }
    if (q.search) {
      const like = likeContains(q.search);
      const tsq = prefixTsQuery(q.search);
      base = base.where((eb) => eb.or([
        ...(tsq ? [sql<boolean>`e.search @@ to_tsquery('simple', ${tsq})`] : []),
        eb('e.displayName', 'ilike', like), // trigram index fallback (partial / mid-word matches)
        eb(sql`e.employee_number::text`, 'ilike', like),
        eb('e.deviceUserId', 'ilike', like),
        eb(sql`e.email::text`, 'ilike', like),
      ]));
    }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(EMPLOYEE_COLUMNS).orderBy(sql.raw(sort.column), sort.direction).orderBy('e.id').limit(page.pageSize).offset(page.offset).execute();
    const summaries = await syncSummaries(trx, orgId, rows.map((r) => r.id));
    const labels = await locationLabels(trx, orgId, rows.map((r) => r.workLocationId));
    return { data: rows.map((r) => maskSensitive(toEmployeeDto(r as EmployeeRow, summaries.get(r.id) ?? { ...EMPTY_SYNC_SUMMARY }, labels), grant)), total };
  });
}

async function loadEmployeeRow(trx: Trx, orgId: string, id: string): Promise<EmployeeRow> {
  const row = await employeeQuery(trx, orgId).select(EMPLOYEE_COLUMNS).where('e.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Employee', id);
  return row as EmployeeRow;
}

/**
 * Every API writer of an employee's record and employment history (PATCH, archive, the bulk actions) locks the employee
 * rows FIRST, in id order, and only then reads them: a concurrent writer waits, and the read that follows (READ COMMITTED:
 * a new snapshot per statement) sees its committed change — no history row built from a stale read replaces another
 * writer's, and two overlapping bulk changes cannot deadlock. NO KEY UPDATE is the strength an UPDATE of these columns
 * takes anyway; unlike FOR UPDATE it does not block the KEY SHARE lock a foreign-key check (a new manager link pointing at
 * the row) takes. Rows RLS does not let the caller update are simply not locked: the read after it answers as before
 * (404, 403 or "missing").
 */
async function lockEmployees(trx: Trx, orgId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await trx.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('id', 'in', [...ids]).orderBy('id').forNoKeyUpdate().execute();
}

async function loadEmployeeDto(trx: Trx, orgId: string, id: string): Promise<EmployeeDto> {
  const row = await loadEmployeeRow(trx, orgId, id);
  const summaries = await syncSummaries(trx, orgId, [id]);
  return toEmployeeDto(row, summaries.get(id) ?? { ...EMPTY_SYNC_SUMMARY }, await locationLabels(trx, orgId, [row.workLocationId]));
}

async function historyRows(trx: Trx, orgId: string, employeeId: string, limit?: number): Promise<EmploymentHistoryDto[]> {
  let q = trx.selectFrom('employmentHistory as h').leftJoin('branches as b', 'b.id', 'h.branchId').leftJoin('departments as d', 'd.id', 'h.departmentId').leftJoin('designations as g', 'g.id', 'h.designationId').leftJoin('employees as m', 'm.id', 'h.managerEmployeeId')
    .select(HISTORY_COLUMNS).where('h.organizationId', '=', orgId).where('h.employeeId', '=', employeeId).orderBy('h.effectiveFrom', 'desc');
  if (limit) q = q.limit(limit);
  return (await q.execute()).map((r) => toHistoryDto(r as HistoryRow));
}

// Profile reads admit either directory key; RLS decides whether the row is visible (a line manager's non-report → 404).
export async function getEmployee(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<EmployeeDto & { currentHistory: EmploymentHistoryDto | null }> {
  const grant = requireAnyPermission(actor.principal, orgId, ...DIRECTORY_KEYS);
  return runUser(deps.db, actor, async (trx) => {
    const dto = maskSensitive(await loadEmployeeDto(trx, orgId, id), grant);
    const [current] = await historyRows(trx, orgId, id, 1);
    return { ...dto, currentHistory: current ?? null };
  });
}

export async function getEmployeeHistory(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<EmploymentHistoryDto[]> {
  requireAnyPermission(actor.principal, orgId, ...DIRECTORY_KEYS);
  return runUser(deps.db, actor, async (trx) => { await loadEmployeeRow(trx, orgId, id); return historyRows(trx, orgId, id); });
}

export async function getEmployeeDevices(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<EmployeeDeviceStateDto[]> {
  requireAnyPermission(actor.principal, orgId, ...DIRECTORY_KEYS);
  return runUser(deps.db, actor, async (trx) => {
    await loadEmployeeRow(trx, orgId, id);
    const rows = await trx.selectFrom('deviceEmployeeStates as s').innerJoin('devices as dv', 'dv.id', 's.deviceId')
      .select(['s.id', 's.deviceId', 'dv.code as deviceCode', 'dv.name as deviceName', 's.branchId', 'dv.connectionStatus', 's.deviceUserId', 's.syncStatus', 's.desired', 's.lastSyncAt', 's.lastSuccessAt', 's.lastErrorCode', 's.lastError', 's.fingerprintCount', 's.faceEnrolled', 's.cardEnrolled', 's.mappedAt', 's.updatedAt'])
      .where('s.organizationId', '=', orgId).where('s.employeeId', '=', id).orderBy('dv.name').execute();
    return rows.map((r) => toDeviceStateDto(r as DeviceStateRow));
  });
}

// Writes ------------------------------------------------------------------------------------------

async function orgToday(trx: Trx, orgId: string): Promise<string> {
  const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst();
  return DateTime.now().setZone(org?.timezone ?? 'UTC').toISODate() ?? DateTime.utc().toISODate()!;
}

/** The organisation's first day on FlowZa (the local date it was created on): no attendance is calculated before it. */
async function orgFirstDay(trx: Trx, orgId: string): Promise<string | null> {
  const org = await trx.selectFrom('organizations').select(['timezone', 'createdAt']).where('id', '=', orgId).executeTakeFirst();
  return org ? DateTime.fromJSDate(new Date(org.createdAt)).setZone(org.timezone).toISODate() : null;
}

async function assertReferences(trx: Trx, orgId: string, refs: { branchId?: string; departmentId?: string | null; designationId?: string | null; managerEmployeeId?: string | null; secondaryManagerEmployeeId?: string | null; selfId?: string }): Promise<void> {
  if (refs.branchId) {
    const b = await trx.selectFrom('branches').select(['id', 'status']).where('organizationId', '=', orgId).where('id', '=', refs.branchId).executeTakeFirst();
    if (!b) throw errors.validation('Branch not found in this organisation.', { issues: [{ path: 'branchId', message: 'Unknown branch' }] });
    if (b.status === 'archived') throw errors.validation('Branch is archived.', { issues: [{ path: 'branchId', message: 'Archived' }] });
  }
  if (refs.departmentId) {
    const d = await trx.selectFrom('departments').select('id').where('organizationId', '=', orgId).where('id', '=', refs.departmentId).executeTakeFirst();
    if (!d) throw errors.validation('Department not found in this organisation.', { issues: [{ path: 'departmentId', message: 'Unknown department' }] });
  }
  if (refs.designationId) {
    const g = await trx.selectFrom('designations').select('id').where('organizationId', '=', orgId).where('id', '=', refs.designationId).executeTakeFirst();
    if (!g) throw errors.validation('Designation not found in this organisation.', { issues: [{ path: 'designationId', message: 'Unknown designation' }] });
  }
  if (refs.managerEmployeeId) {
    if (refs.selfId && refs.managerEmployeeId === refs.selfId) throw errors.validation('An employee cannot be their own manager.', { issues: [{ path: 'managerEmployeeId', message: 'Self reference' }] });
    const m = await trx.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('id', '=', refs.managerEmployeeId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!m) throw errors.validation('Manager not found in this organisation.', { issues: [{ path: 'managerEmployeeId', message: 'Unknown employee' }] });
  }
  if (refs.secondaryManagerEmployeeId) {
    if (refs.selfId && refs.secondaryManagerEmployeeId === refs.selfId) throw errors.validation('An employee cannot be their own secondary manager.', { issues: [{ path: 'secondaryManagerEmployeeId', message: 'Self reference' }] });
    const m = await trx.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('id', '=', refs.secondaryManagerEmployeeId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!m) throw errors.validation('Secondary manager not found in this organisation.', { issues: [{ path: 'secondaryManagerEmployeeId', message: 'Unknown employee' }] });
  }
  // the database check constraint says the same; validating here names the field instead of surfacing a 23514
  if (refs.managerEmployeeId && refs.secondaryManagerEmployeeId && refs.managerEmployeeId === refs.secondaryManagerEmployeeId) {
    throw errors.validation('The secondary manager must be a different person from the manager.', { issues: [{ path: 'secondaryManagerEmployeeId', message: 'Same as manager' }] });
  }
}

/** How far up the reporting line the cycle check looks (the database trigger employees_no_manager_cycle uses the same bound). */
export const MAX_REPORTING_DEPTH = 20;

/**
 * Which of `employeeIds` the person `start` already reports to, directly or through other managers: ONE walk upwards from
 * `start`, following both the primary and the secondary link of every ancestor, up to MAX_REPORTING_DEPTH levels (the
 * bound of the database trigger), intersected with the ids. Runs in the organisation's system scope, read-only, returning
 * ids the caller already named: a branch-scoped caller's RLS view would hide part of the chain.
 */
async function reportsUpTo(trx: Trx, orgId: string, start: string, employeeIds: readonly string[]): Promise<string[]> {
  if (employeeIds.length === 0) return [];
  return withSystemScope(trx, orgId, async (t) => {
    const { rows } = await sql<{ id: string }>`
      with recursive up(id, depth) as (
        select ${start}::uuid, 1
        union
        select l.manager_id, u.depth + 1
        from up u
        join public.employees e on e.id = u.id and e.organization_id = ${orgId}::uuid
        cross join lateral (values (e.manager_employee_id), (e.secondary_manager_employee_id)) as l(manager_id)
        where u.depth < ${MAX_REPORTING_DEPTH} and l.manager_id is not null
      )
      select distinct up.id from up where up.id = any(${[...employeeIds]}::uuid[])`.execute(t);
    return rows.map((r) => r.id);
  });
}

/**
 * Refuses a manager link that would close a loop in the reporting line: the proposed (primary or secondary) manager
 * already reports to the employee, directly or through other managers (reportsUpTo) — the rule the database trigger
 * enforces again; validating here names the field instead of surfacing a check violation. Only CHANGED links are
 * passed in (an unchanged one was checked when it was set).
 */
async function assertNoReportingCycle(trx: Trx, orgId: string, employeeId: string, links: { managerEmployeeId?: string | null; secondaryManagerEmployeeId?: string | null }): Promise<void> {
  for (const field of ['managerEmployeeId', 'secondaryManagerEmployeeId'] as const) {
    const start = links[field];
    if (!start) continue;
    const loops = start === employeeId || (await reportsUpTo(trx, orgId, start, [employeeId])).length > 0;
    if (loops) {
      throw errors.validation('This person already reports to the employee (directly or through other managers), so they cannot also be the employee\'s manager: the reporting line would go round in a circle.', { issues: [{ path: field, message: 'Reporting cycle' }] });
    }
  }
}

/**
 * Next numeric device user id for the organisation. Ids must be unique across ALL branches, but a branch-scoped caller
 * only sees their own employees under RLS, so the maximum is computed in the organisation's system scope (read-only,
 * returns a number only). Serialised with a transaction-level advisory lock; the unique index is the last line of defence.
 */
export async function nextDeviceUserId(trx: Trx, orgId: string): Promise<string> {
  await sql`select pg_advisory_xact_lock(hashtext(${`${orgId}:device_user_id`}))`.execute(trx);
  const res = await withSystemScope(trx, orgId, (t) => sql<{ next: string }>`select coalesce(max(device_user_id::bigint), 0) + 1 as next from public.employees where organization_id = ${orgId}::uuid and device_user_id ~ '^[0-9]{1,15}$'`.execute(t));
  return String(res.rows[0]?.next ?? 1);
}

const DEVICE_USER_ID_CONSTRAINT = 'employees_organization_id_device_user_id_key';
const isDeviceUserIdClash = (err: unknown) => (err as { code?: string; constraint?: string })?.code === '23505' && (err as { constraint?: string }).constraint === DEVICE_USER_ID_CONSTRAINT;

/**
 * Insert with an auto-assigned device user id, retrying on a unique violation (ids handed out outside the advisory lock,
 * e.g. by an import running in the worker). Each attempt runs inside a savepoint so a clash does not abort the transaction.
 */
async function insertWithAutoDeviceUserId<T>(trx: Trx, orgId: string, insert: (deviceUserId: string) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const deviceUserId = await nextDeviceUserId(trx, orgId);
    await sql`savepoint employee_insert`.execute(trx);
    try {
      const out = await insert(deviceUserId);
      await sql`release savepoint employee_insert`.execute(trx);
      return out;
    } catch (err) {
      if (!isDeviceUserIdClash(err) || attempt >= 5) throw err;
      await sql`rollback to savepoint employee_insert`.execute(trx);
    }
  }
}

export interface EmploymentSnapshot { branchId: string; departmentId: string | null; designationId: string | null; managerEmployeeId: string | null; employmentType: EmployeeDto['employmentType']; employmentStatus: EmployeeDto['employmentStatus'] }

/**
 * Effective-dated history transition: closes the current row at `effectiveFrom` (exclusive) and opens a new one.
 * A change dated on the current row's own start replaces that row in place; earlier dates are rejected (no rewrite of history).
 */
export async function applyHistoryTransition(trx: Trx, orgId: string, employeeId: string, next: EmploymentSnapshot, effectiveFrom: string, reason: string | null, actorUserId: string, joiningDate: string): Promise<void> {
  if (effectiveFrom < joiningDate) throw errors.validation('effectiveFrom cannot be before the joining date.', { issues: [{ path: 'effectiveFrom', message: `Must be on/after ${joiningDate}` }] });
  const current = await trx.selectFrom('employmentHistory').select(['id', 'effectiveFrom']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('effectiveTo', 'is', null).orderBy('effectiveFrom', 'desc').executeTakeFirst();
  const values = { ...next, reason };
  if (current) {
    const currentFrom = isoDate(current.effectiveFrom);
    if (effectiveFrom < currentFrom) throw errors.validation(`effectiveFrom cannot be before the current employment record (${currentFrom}).`, { issues: [{ path: 'effectiveFrom', message: `Must be on/after ${currentFrom}` }] });
    if (effectiveFrom === currentFrom) {
      await trx.updateTable('employmentHistory').set({ ...values, createdBy: actorUserId }).where('id', '=', current.id).execute();
      return;
    }
    await trx.updateTable('employmentHistory').set({ effectiveTo: effectiveFrom }).where('id', '=', current.id).execute();
  }
  await trx.insertInto('employmentHistory').values({ organizationId: orgId, employeeId, effectiveFrom, effectiveTo: null, ...values, createdBy: actorUserId }).execute();
}

/** How many employees a bulk date error names in its message (all of them are in its details). */
const DATE_ERROR_NAMED = 5;

/**
 * applyHistoryTransition's date rule for a whole bulk selection, checked BEFORE anything is written: the change cannot start
 * before an employee's joining date nor before their open employment record (a future joiner, a change already dated
 * later). One error names every such employee — message: their employee numbers and dates; details: `employeeIds` and
 * `earliestEffectiveFrom` ({ id: date }); issues[0]: the first date that suits all of them — instead of the first one
 * failing the batch with nobody identified. One query for the selection; applyHistoryTransition keeps the rule per row.
 */
async function assertBulkEffectiveFrom(trx: Trx, orgId: string, employees: ReadonlyArray<{ id: string; employeeNumber: string; joiningDate: Date | string }>, effectiveFrom: string): Promise<void> {
  if (employees.length === 0) return;
  const open = await trx.selectFrom('employmentHistory').select(['employeeId', (eb) => eb.fn.max('effectiveFrom').as('from')])
    .where('organizationId', '=', orgId).where('employeeId', 'in', employees.map((e) => e.id)).where('effectiveTo', 'is', null).groupBy('employeeId').execute();
  const openFrom = new Map(open.map((r) => [r.employeeId, isoDate(r.from)]));
  const late: Array<{ id: string; employeeNumber: string; from: string }> = [];
  for (const e of employees) {
    const joining = isoDate(e.joiningDate);
    const current = openFrom.get(e.id);
    const from = current && current > joining ? current : joining;
    if (effectiveFrom < from) late.push({ id: e.id, employeeNumber: e.employeeNumber, from });
  }
  if (late.length === 0) return;
  const latest = late.reduce((a, b) => (a > b.from ? a : b.from), effectiveFrom);
  const named = late.slice(0, DATE_ERROR_NAMED).map((x) => `${x.employeeNumber} (from ${x.from})`).join(', ');
  const more = late.length > DATE_ERROR_NAMED ? ` and ${late.length - DATE_ERROR_NAMED} more` : '';
  throw errors.validation(
    `The change date ${effectiveFrom} is before the joining date or the current employment record of ${late.length} selected employee${late.length === 1 ? '' : 's'}: ${named}${more}. Choose ${latest} or later, or leave them out of the selection.`,
    { issues: [{ path: 'effectiveFrom', message: `Must be on/after ${latest}` }], employeeIds: late.map((x) => x.id), earliestEffectiveFrom: Object.fromEntries(late.map((x) => [x.id, x.from])) },
  );
}

/**
 * The days a change of joining / exit date moves between NOT_JOINED / EXITED and calculated attendance (2026-10-02 field report:
 * a joining date moved from 2 Oct back to 1 Sep left every September day "Not joined" and out of the monthly summary): from the
 * earlier to the later of the old and the new date (an open exit date counts as today), never past today — the days after it
 * are calculated when they come. Null when neither date changed or the whole range lies in the future.
 */
export function employmentDatesRecalcRange(before: { joiningDate: string; exitDate: string | null }, after: { joiningDate: string; exitDate: string | null }, today: string): { fromDate: string; toDate: string } | null {
  const bounds: string[] = [];
  if (before.joiningDate !== after.joiningDate) bounds.push(before.joiningDate, after.joiningDate);
  if (before.exitDate !== after.exitDate) bounds.push(before.exitDate ?? today, after.exitDate ?? today);
  if (bounds.length === 0) return null;
  const fromDate = bounds.reduce((a, b) => (a < b ? a : b));
  const last = bounds.reduce((a, b) => (a > b ? a : b));
  const toDate = last < today ? last : today;
  return fromDate <= toDate ? { fromDate, toDate } : null;
}

/**
 * The first employment record starts on the joining date ("Joined"): a joining date moved earlier takes it along, so the days in
 * between belong to the branch the employee joined (the working calendar reads the record in force on each date).
 */
async function startHistoryOnJoining(trx: Trx, orgId: string, employeeId: string, joiningDate: string): Promise<void> {
  const first = await trx.selectFrom('employmentHistory').select(['id', 'effectiveFrom']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).orderBy('effectiveFrom', 'asc').executeTakeFirst();
  if (first && isoDate(first.effectiveFrom) > joiningDate) await trx.updateTable('employmentHistory').set({ effectiveFrom: joiningDate }).where('id', '=', first.id).execute();
}

function snapshotOf(e: { branchId: string; departmentId: string | null; designationId: string | null; managerEmployeeId: string | null; employmentType: EmployeeDto['employmentType']; employmentStatus: EmployeeDto['employmentStatus'] }): EmploymentSnapshot {
  return { branchId: e.branchId, departmentId: e.departmentId, designationId: e.designationId, managerEmployeeId: e.managerEmployeeId, employmentType: e.employmentType, employmentStatus: e.employmentStatus };
}
function snapshotChanged(a: EmploymentSnapshot, b: EmploymentSnapshot): boolean {
  return (Object.keys(a) as (keyof EmploymentSnapshot)[]).some((k) => a[k] !== b[k]);
}

export async function maybeEnqueuePush(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, employeeIds: string[], force = false): Promise<string | null> {
  if (!force) {
    const settings = await loadSettings(trx, orgId);
    if (settings.sync.autoPushNewEmployees === false) return null;
  }
  return enqueueJob(deps.queue, trx, { queue: 'sync', jobType: 'PUSH_EMPLOYEES', organizationId: orgId, payload: { scope: { employeeIds }, trigger: 'SYSTEM', requestedBy: actor.userId }, correlationId: actor.requestId, priority: 6 });
}

export async function createEmployee(deps: ApiDeps, actor: Actor, orgId: string, input: CreateEmployeeInput): Promise<EmployeeDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.create');
  requireBranchAccess(grant, input.branchId);
  return runUser(deps.db, actor, async (trx) => {
    await assertReferences(trx, orgId, { branchId: input.branchId, departmentId: input.departmentId, designationId: input.designationId, managerEmployeeId: input.managerEmployeeId, secondaryManagerEmployeeId: input.secondaryManagerEmployeeId });
    // where the employee works inside the branch: a place of that branch the caller can see (the composite key says it again)
    if (input.workLocationId) await assertPlaceOfBranch(trx, orgId, input.workLocationId, input.branchId, 'workLocationId');
    // the user limit the platform set (licensed users = active employees, counted org-wide whatever the creator's branch scope)
    if (!hasLeft(input.employmentStatus)) await assertUserCapacity(trx, orgId, 1);
    const displayName = input.displayName ?? [input.firstName, input.lastName].filter(Boolean).join(' ');
    const pinHash = input.pin ? hashPin(input.pin) : null;
    const insert = (deviceUserId: string) => trx.insertInto('employees').values({
      organizationId: orgId, employeeNumber: input.employeeNumber, firstName: input.firstName, middleName: input.middleName ?? null, lastName: input.lastName, displayName, displayNameAr: input.displayNameAr ?? null,
      gender: input.gender, dateOfBirth: input.dateOfBirth ?? null, nationalityCode: input.nationalityCode ?? null, email: input.email ?? null, phone: input.phone ?? null,
      joiningDate: input.joiningDate, employmentStatus: input.employmentStatus, employmentType: input.employmentType, branchId: input.branchId, workLocationId: input.workLocationId ?? null, departmentId: input.departmentId ?? null,
      designationId: input.designationId ?? null, managerEmployeeId: input.managerEmployeeId ?? null, secondaryManagerEmployeeId: input.secondaryManagerEmployeeId ?? null, deviceUserId, cardNumber: input.cardNumber ?? null, pinHash,
      weeklyOffDays: input.weeklyOffDays ?? null, customFields: JSON.stringify(input.customFields ?? {}), createdBy: actor.userId, updatedBy: actor.userId,
    }).returning(['id', 'deviceUserId']).executeTakeFirstOrThrow();
    const row = input.deviceUserId ? await insert(input.deviceUserId) : await insertWithAutoDeviceUserId(trx, orgId, insert);
    const deviceUserId = row.deviceUserId;
    await applyHistoryTransition(trx, orgId, row.id, { branchId: input.branchId, departmentId: input.departmentId ?? null, designationId: input.designationId ?? null, managerEmployeeId: input.managerEmployeeId ?? null, employmentType: input.employmentType, employmentStatus: input.employmentStatus }, input.joiningDate, 'Joined', actor.userId, input.joiningDate);
    const dto = await loadEmployeeDto(trx, orgId, row.id);
    const { pin: _pin, ...auditable } = input;
    await audit(trx, actor, orgId, 'employee.created', 'employee', { entityId: row.id, branchId: input.branchId, newValue: { ...auditable, deviceUserId, pinSet: Boolean(input.pin) } });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.created', aggregateType: 'employee', aggregateId: row.id, payload: { employeeNumber: dto.employeeNumber, branchId: dto.branchId, deviceUserId }, actorUserId: actor.userId, requestId: actor.requestId });
    await maybeEnqueuePush(deps, trx, actor, orgId, [row.id]);
    // an employee entered after they joined: the days since the joining date are calculated now, not left out of the register —
    // from the organisation's first day at the latest, so a long-serving employee entered at go-live gets no years of absences
    const today = await orgToday(trx, orgId);
    const firstDay = await orgFirstDay(trx, orgId);
    const recalcFrom = firstDay && firstDay > input.joiningDate ? firstDay : input.joiningDate;
    if (recalcFrom < today) await enqueueRecalculation(deps, trx, actor, orgId, { fromDate: recalcFrom, toDate: today, employeeIds: [row.id], reason: `Employee ${dto.employeeNumber} joined on ${input.joiningDate}` });
    return maskSensitive(dto, grant);
  });
}

export async function updateEmployee(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateEmployeeInput): Promise<EmployeeDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.update');
  requireBranchAccess(grant, input.branchId);
  return runUser(deps.db, actor, async (trx) => {
    // locked before it is read: `before` feeds the next employment record (lockEmployees)
    await lockEmployees(trx, orgId, [id]);
    const before = await loadEmployeeRow(trx, orgId, id);
    if (before.deletedAt) throw errors.invalidState('The employee has been deleted.');
    requireBranchAccess(grant, before.branchId);
    // the manager pair is validated as it will be AFTER the patch (a new primary equal to the kept secondary is refused too)
    const effectiveManager = input.managerEmployeeId === undefined ? before.managerEmployeeId : input.managerEmployeeId;
    const effectiveSecondary = input.secondaryManagerEmployeeId === undefined ? before.secondaryManagerEmployeeId : input.secondaryManagerEmployeeId;
    await assertReferences(trx, orgId, { branchId: input.branchId, departmentId: input.departmentId, designationId: input.designationId, managerEmployeeId: effectiveManager, secondaryManagerEmployeeId: effectiveSecondary, selfId: id });
    // the work location is a place of the employee's branch AFTER the change (re-sending the stored one unchanged is a no-op); a
    // transfer without a new place drops the old one (app.place_reference_guard) — the response and the audit diff show it
    const targetBranchId = input.branchId ?? before.branchId;
    if (input.workLocationId && !(input.workLocationId === before.workLocationId && targetBranchId === before.branchId)) await assertPlaceOfBranch(trx, orgId, input.workLocationId, targetBranchId, 'workLocationId');
    await assertNoReportingCycle(trx, orgId, id, {
      managerEmployeeId: effectiveManager !== before.managerEmployeeId ? effectiveManager : null,
      secondaryManagerEmployeeId: effectiveSecondary !== before.secondaryManagerEmployeeId ? effectiveSecondary : null,
    });
    const { effectiveFrom: requestedFrom, changeReason, pin, customFields, ...rest } = input;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
    // a cleared display name falls back to first + last name (the column is NOT NULL), as on create
    if (input.displayName === null) patch['displayName'] = [input.firstName ?? before.firstName, input.lastName ?? before.lastName].filter(Boolean).join(' ');
    if (customFields !== undefined) patch['customFields'] = JSON.stringify(customFields);
    if (pin !== undefined) patch['pinHash'] = hashPin(pin);
    const joiningDate = input.joiningDate ?? isoDate(before.joiningDate);
    if (input.exitDate && input.exitDate < joiningDate) throw errors.validation('exitDate cannot be before the joining date.', { issues: [{ path: 'exitDate', message: `Must be on/after ${joiningDate}` }] });
    const nextSnapshot: EmploymentSnapshot = {
      branchId: input.branchId ?? before.branchId,
      departmentId: input.departmentId === undefined ? before.departmentId : input.departmentId,
      designationId: input.designationId === undefined ? before.designationId : input.designationId,
      managerEmployeeId: input.managerEmployeeId === undefined ? before.managerEmployeeId : input.managerEmployeeId,
      employmentType: input.employmentType ?? before.employmentType,
      employmentStatus: input.employmentStatus ?? before.employmentStatus,
    };
    // re-activating an employee who left takes a user again: refused past the user limit
    if (hasLeft(before.employmentStatus) && !hasLeft(nextSnapshot.employmentStatus)) await assertUserCapacity(trx, orgId, 1);
    const transition = snapshotChanged(snapshotOf(before), nextSnapshot);
    if (transition) {
      const effectiveFrom = requestedFrom ?? (await orgToday(trx, orgId));
      await applyHistoryTransition(trx, orgId, id, nextSnapshot, effectiveFrom, changeReason ?? null, actor.userId, joiningDate);
    }
    patch['updatedBy'] = actor.userId;
    await trx.updateTable('employees').set(patch as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
    // a changed joining / exit date: the days in between are recalculated in this transaction (AGENTS.md rule 5)
    const beforeDates = { joiningDate: isoDate(before.joiningDate), exitDate: before.exitDate === null ? null : isoDate(before.exitDate) };
    const afterDates = { joiningDate, exitDate: input.exitDate === undefined ? beforeDates.exitDate : input.exitDate };
    if (afterDates.joiningDate < beforeDates.joiningDate) await startHistoryOnJoining(trx, orgId, id, afterDates.joiningDate);
    const recalcRange = employmentDatesRecalcRange(beforeDates, afterDates, await orgToday(trx, orgId));
    if (recalcRange) {
      const changed = [beforeDates.joiningDate !== afterDates.joiningDate ? `joining date ${beforeDates.joiningDate} → ${afterDates.joiningDate}` : null, beforeDates.exitDate !== afterDates.exitDate ? `exit date ${beforeDates.exitDate ?? 'none'} → ${afterDates.exitDate ?? 'none'}` : null].filter(Boolean).join(', ');
      await enqueueRecalculation(deps, trx, actor, orgId, { ...recalcRange, employeeIds: [id], reason: `Employee ${before.employeeNumber}: ${changed}` });
    }
    // another place in the same branch can mean another location-scoped policy from today (a transfer recalculates through the
    // history transition)
    if (input.workLocationId !== undefined && input.workLocationId !== before.workLocationId && targetBranchId === before.branchId) {
      await recalcTodayForLocationChange(deps, trx, actor, orgId, { employeeIds: [id] }, `Employee ${before.employeeNumber}: work location changed`);
    }
    // B-75: becoming terminated/resigned ends every login linked to the record (a refusal rolls the whole change back).
    // The reverse is deliberately NOT automatic: re-activating the employee leaves the login suspended until an
    // administrator re-activates the member.
    const leaving = hasLeft(nextSnapshot.employmentStatus) && !hasLeft(before.employmentStatus);
    if (leaving) {
      await offboardLinkedLogins(deps, trx, actor, grant, orgId, [id], { source: 'update', employmentStatus: nextSnapshot.employmentStatus });
    }
    const after = await loadEmployeeDto(trx, orgId, id);
    // labelled like `after`, so an unchanged work location never shows up in the diff
    const beforeDto = toEmployeeDto(before, undefined, await locationLabels(trx, orgId, [before.workLocationId]));
    const diff = diffObjects(beforeDto as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
    if (pin !== undefined) (diff.newValue as Record<string, unknown>)['pinSet'] = true;
    await audit(trx, actor, orgId, 'employee.updated', 'employee', { entityId: id, branchId: after.branchId, ...diff, reason: changeReason ?? null });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.updated', aggregateType: 'employee', aggregateId: id, payload: { changed: Object.keys(diff.newValue), transition, branchId: after.branchId }, actorUserId: actor.userId, requestId: actor.requestId });
    // a leaver is taken off every terminal (whatever the auto push setting); a re-activated employee is pushed back like
    // any other device-relevant change (name, card, pin, branch, status) when auto push is enabled — a leaver is never pushed
    const deviceRelevant = ['displayName', 'firstName', 'lastName', 'cardNumber', 'branchId', 'employmentStatus', 'deviceUserId'].some((k) => k in diff.newValue) || pin !== undefined;
    if (leaving) await removeLeaversFromDevices(deps, trx, actor, orgId, [id], { source: 'update', employmentStatus: nextSnapshot.employmentStatus });
    else if (deviceRelevant && !hasLeft(nextSnapshot.employmentStatus)) await maybeEnqueuePush(deps, trx, actor, orgId, [id]);
    return maskSensitive(after, grant);
  });
}

export async function deleteEmployee(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: DeleteEmployeeInput): Promise<EmployeeDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.delete', 'employee.update');
  return runUser(deps.db, actor, async (trx) => {
    await lockEmployees(trx, orgId, [id]);
    const before = await loadEmployeeRow(trx, orgId, id);
    requireBranchAccess(grant, before.branchId);
    if (before.deletedAt) throw errors.invalidState('The employee is already deleted.');
    const joiningDate = isoDate(before.joiningDate);
    const exitDate = input.exitDate ?? (await orgToday(trx, orgId));
    if (exitDate < joiningDate) throw errors.validation('exitDate cannot be before the joining date.', { issues: [{ path: 'exitDate', message: `Must be on/after ${joiningDate}` }] });
    await applyHistoryTransition(trx, orgId, id, { ...snapshotOf(before), employmentStatus: 'terminated' }, exitDate, input.reason ?? 'Deleted', actor.userId, joiningDate);
    await trx.updateTable('employees').set({ deletedAt: new Date(), employmentStatus: 'terminated', exitDate, updatedBy: actor.userId }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    // B-75: archiving is leaving — every login still linked to the record ends (whatever the previous status was)
    await offboardLinkedLogins(deps, trx, actor, grant, orgId, [id], { source: 'delete', employmentStatus: 'terminated' });
    await audit(trx, actor, orgId, 'employee.deleted', 'employee', { entityId: id, branchId: before.branchId, oldValue: { employmentStatus: before.employmentStatus, exitDate: before.exitDate }, newValue: { employmentStatus: 'terminated', exitDate, deleted: true }, reason: input.reason ?? null });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.deleted', aggregateType: 'employee', aggregateId: id, payload: { employeeNumber: before.employeeNumber, branchId: before.branchId, exitDate }, actorUserId: actor.userId, requestId: actor.requestId });
    // ... and so does every terminal: also for a record that left earlier and is still on a device
    await removeLeaversFromDevices(deps, trx, actor, orgId, [id], { source: 'delete', employmentStatus: 'terminated' });
    return maskSensitive(await loadEmployeeDto(trx, orgId, id), grant);
  });
}

export type BulkResult = { kind: 'sync'; updated: number; employeeIds: string[] } | { kind: 'job'; jobId: string };

export async function bulkAction(deps: ApiDeps, actor: Actor, orgId: string, input: BulkEmployeeAction): Promise<BulkResult> {
  switch (input.action) {
    case 'sync_devices': {
      const grant = requirePermission(actor.principal, orgId, 'device.sync');
      return runUser(deps.db, actor, async (trx) => {
        const ids = await visibleEmployeeIds(trx, orgId, grant, input.employeeIds);
        const jobId = await enqueueJob(deps.queue, trx, { queue: 'sync', jobType: 'PUSH_EMPLOYEES', organizationId: orgId, payload: { scope: { employeeIds: ids, deviceIds: input.deviceIds ?? null }, trigger: 'MANUAL', requestedBy: actor.userId }, correlationId: actor.requestId, priority: 7 });
        await audit(trx, actor, orgId, 'employee.sync_requested', 'employee', { newValue: { employeeIds: ids, deviceIds: input.deviceIds ?? null, jobId } });
        return { kind: 'job', jobId };
      });
    }
    case 'export': {
      // the file lands in Reports and is downloaded with report.export — refuse up front rather than generate what cannot be fetched
      const grant = requirePermission(actor.principal, orgId, 'employee.export', 'report.export');
      return runUser(deps.db, actor, async (trx) => {
        const ids = input.employeeIds ? await visibleEmployeeIds(trx, orgId, grant, input.employeeIds) : null;
        const jobId = await enqueueJob(deps.queue, trx, { queue: 'reports', jobType: 'EXPORT_EMPLOYEES', organizationId: orgId, payload: { employeeIds: ids, branchIds: grant.allBranches ? null : grant.branchIds, format: input.format, requestedBy: actor.userId }, correlationId: actor.requestId });
        await audit(trx, actor, orgId, 'employee.exported', 'employee', { newValue: { employeeIds: ids, count: ids?.length ?? 'all', format: input.format, jobId } });
        return { kind: 'job', jobId };
      });
    }
    case 'assign_shift': {
      const grant = requirePermission(actor.principal, orgId, 'shift.assign');
      return runUser(deps.db, actor, async (trx) => {
        const shift = await trx.selectFrom('shifts').select('id').where('organizationId', '=', orgId).where('id', '=', input.shiftId).executeTakeFirst();
        if (!shift) throw errors.validation('Shift not found in this organisation.', { issues: [{ path: 'shiftId', message: 'Unknown shift' }] });
        // effectiveTo is the assignment's LAST day (inclusive), as on the Schedule page; stored as the day after (assignment-dates.ts)
        if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) throw errors.validation('effectiveTo (the last day) cannot be before effectiveFrom.', { issues: [{ path: 'effectiveTo', message: 'Before the first day' }] });
        const employees = await visibleEmployees(trx, orgId, grant, input.employeeIds);
        for (const e of employees) {
          // the open assignment ends the day before the new one starts (stored bound = the new start, half-open)
          await trx.updateTable('shiftAssignments').set({ effectiveTo: input.effectiveFrom }).where('organizationId', '=', orgId).where('targetType', '=', 'EMPLOYEE').where('targetId', '=', e.id).where('effectiveTo', 'is', null).where('effectiveFrom', '<', sql<Date>`${input.effectiveFrom}::date`).execute();
          await trx.insertInto('shiftAssignments').values({ organizationId: orgId, targetType: 'EMPLOYEE', targetId: e.id, branchId: e.branchId, shiftId: input.shiftId, shiftPatternId: null, effectiveFrom: input.effectiveFrom, effectiveTo: assignmentEndToStored(input.effectiveTo), createdBy: actor.userId }).execute();
        }
        await audit(trx, actor, orgId, 'employee.bulk_shift_assigned', 'employee', { newValue: { employeeIds: employees.map((e) => e.id), shiftId: input.shiftId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null } });
        // §G.7, as an assignment made on the Schedule page: the days the change covers that already started (today included)
        // are recomputed, so a record computed before the assignment does not keep "No shift"; later days compute when they come
        const today = await orgToday(trx, orgId);
        if (employees.length > 0 && input.effectiveFrom <= today) {
          const until = input.effectiveTo && input.effectiveTo < today ? input.effectiveTo : today;
          await enqueueRecalculation(deps, trx, actor, orgId, { fromDate: input.effectiveFrom, toDate: until, employeeIds: employees.map((e) => e.id), reason: 'shift assigned to employees' });
        }
        return { kind: 'sync', updated: employees.length, employeeIds: employees.map((e) => e.id) };
      });
    }
    case 'assign_branch':
    case 'assign_department':
    case 'set_status': {
      const grant = requirePermission(actor.principal, orgId, 'employee.update');
      if (input.action === 'assign_branch') requireBranchAccess(grant, input.branchId);
      return runUser(deps.db, actor, async (trx) => {
        if (input.action === 'assign_branch') await assertReferences(trx, orgId, { branchId: input.branchId });
        if (input.action === 'assign_department') await assertReferences(trx, orgId, { departmentId: input.departmentId });
        const effectiveFrom = input.effectiveFrom ?? (await orgToday(trx, orgId));
        const employees = await visibleEmployees(trx, orgId, grant, input.employeeIds, { lock: true });
        // re-activating leavers takes users again: all of them fit under the user limit, or the whole change is refused
        if (input.action === 'set_status' && !hasLeft(input.employmentStatus)) {
          const rejoining = employees.filter((e) => hasLeft(e.employmentStatus)).length;
          if (rejoining > 0) await assertUserCapacity(trx, orgId, rejoining);
        }
        const plans = employees.map((e) => {
          const next = snapshotOf(e);
          if (input.action === 'assign_branch') next.branchId = input.branchId;
          if (input.action === 'assign_department') next.departmentId = input.departmentId;
          if (input.action === 'set_status') next.employmentStatus = input.employmentStatus;
          return { e, next };
        }).filter(({ e, next }) => snapshotChanged(snapshotOf(e), next));
        // a date some of them cannot take refuses the change once, naming them all
        await assertBulkEffectiveFrom(trx, orgId, plans.map((p) => p.e), effectiveFrom);
        const changed: string[] = [];
        const leavers: string[] = [];
        // a transfer drops a work location of the old branch (app.place_reference_guard): recorded in the bulk audit row
        const workLocationsCleared: Array<{ employeeId: string; workLocationId: string }> = [];
        for (const { e, next } of plans) {
          await applyHistoryTransition(trx, orgId, e.id, next, effectiveFrom, `Bulk ${input.action}`, actor.userId, isoDate(e.joiningDate));
          await trx.updateTable('employees').set({ branchId: next.branchId, departmentId: next.departmentId, employmentStatus: next.employmentStatus, updatedBy: actor.userId }).where('organizationId', '=', orgId).where('id', '=', e.id).execute();
          if (e.workLocationId && next.branchId !== e.branchId) workLocationsCleared.push({ employeeId: e.id, workLocationId: e.workLocationId });
          await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.updated', aggregateType: 'employee', aggregateId: e.id, payload: { bulk: input.action, transition: true, branchId: next.branchId }, actorUserId: actor.userId, requestId: actor.requestId });
          changed.push(e.id);
          if (hasLeft(next.employmentStatus) && !hasLeft(e.employmentStatus)) leavers.push(e.id);
        }
        // B-75: every login linked to an employee who now left ends (one refusal rolls the whole bulk change back)
        if (input.action === 'set_status' && leavers.length) {
          await offboardLinkedLogins(deps, trx, actor, grant, orgId, leavers, { source: 'bulk_set_status', employmentStatus: input.employmentStatus });
        }
        const { employeeIds: _ids, ...rest } = input;
        await audit(trx, actor, orgId, 'employee.bulk_updated', 'employee', { newValue: { ...rest, effectiveFrom, employeeIds: changed, ...(workLocationsCleared.length ? { workLocationsCleared } : {}) } });
        // leavers come off every terminal; anybody else whose branch or status changed is pushed (a leaver never is)
        if (input.action === 'set_status' && leavers.length) await removeLeaversFromDevices(deps, trx, actor, orgId, leavers, { source: 'bulk_set_status', employmentStatus: input.employmentStatus });
        const toPush = input.action === 'set_status' && hasLeft(input.employmentStatus) ? [] : changed;
        if (toPush.length && (input.action === 'assign_branch' || input.action === 'set_status')) await maybeEnqueuePush(deps, trx, actor, orgId, toPush);
        return { kind: 'sync', updated: changed.length, employeeIds: changed };
      });
    }
    case 'assign_manager': {
      // one manager for many employees, on the solid (primary) or the dotted (secondary) line; null removes the link. The
      // reporting line is no device data (nothing is pushed) and no attendance input (nothing is recalculated)
      const grant = requirePermission(actor.principal, orgId, 'employee.update');
      const { line } = input;
      // the ids are compared as strings below (unchanged, promoted, skipped, self): lower-cased like the uuids Postgres
      // returns — the schema accepts upper-case hex, which SQL would treat as the same id and JS would not
      const managerId = input.managerEmployeeId?.toLowerCase() ?? null;
      const ids = [...new Set(input.employeeIds.map((id) => id.toLowerCase()))];
      if (managerId && ids.includes(managerId)) throw errors.validation('An employee cannot be their own manager: remove the manager from the selected employees.', { issues: [{ path: 'employeeIds', message: 'Contains the manager' }] });
      return runUser(deps.db, actor, async (trx) => {
        if (managerId) {
          // in the organisation, not archived and visible to the caller (RLS) — and still working here: a leaver leads nobody
          await assertReferences(trx, orgId, { managerEmployeeId: managerId });
          const manager = await trx.selectFrom('employees').select('employmentStatus').where('organizationId', '=', orgId).where('id', '=', managerId).executeTakeFirst();
          if (manager && hasLeft(manager.employmentStatus)) throw errors.validation('This person has left the organisation and cannot be assigned as a manager.', { issues: [{ path: 'managerEmployeeId', message: 'Has left' }] });
        }
        const employees = await visibleEmployees(trx, orgId, grant, ids, { lock: true });
        if (managerId) {
          // the manager's own reporting line must not pass through any of the employees (one walk for the whole selection). Sound
          // for the batch: the new links all point AT the manager, so they only close a loop through a chain that is checked here
          const loops = await reportsUpTo(trx, orgId, managerId, employees.map((e) => e.id));
          if (loops.length) {
            throw errors.validation('The manager already reports to some of the selected employees (directly or through other managers), so the reporting line would go round in a circle. Remove them from the selection.', { issues: [{ path: 'managerEmployeeId', message: 'Reporting cycle' }], employeeIds: loops });
          }
        }
        // the solid line is part of the employment record (effective-dated); the dotted line is a plain column
        const effectiveFrom = line === 'primary' ? input.effectiveFrom ?? (await orgToday(trx, orgId)) : null;
        // a future joiner (or a record already dated later) among those whose solid line changes: one error naming them all
        if (effectiveFrom) await assertBulkEffectiveFrom(trx, orgId, employees.filter((e) => e.managerEmployeeId !== managerId), effectiveFrom);
        const changed: string[] = [];
        const secondaryCleared: string[] = [];
        const skipped: string[] = [];
        for (const e of employees) {
          if (line === 'primary') {
            if (e.managerEmployeeId === managerId) continue;
            // the dotted-line manager promoted to the solid line leaves the dotted line (the check constraint forbids both)
            const clearSecondary = managerId !== null && e.secondaryManagerEmployeeId === managerId;
            await applyHistoryTransition(trx, orgId, e.id, { ...snapshotOf(e), managerEmployeeId: managerId }, effectiveFrom!, `Bulk ${input.action}`, actor.userId, isoDate(e.joiningDate));
            await trx.updateTable('employees').set({ managerEmployeeId: managerId, ...(clearSecondary ? { secondaryManagerEmployeeId: null } : {}), updatedBy: actor.userId }).where('organizationId', '=', orgId).where('id', '=', e.id).execute();
            if (clearSecondary) secondaryCleared.push(e.id);
          } else {
            if (e.secondaryManagerEmployeeId === managerId) continue;
            // already the solid-line manager: a dotted line to the same person says nothing (and the check constraint refuses it)
            if (managerId !== null && e.managerEmployeeId === managerId) { skipped.push(e.id); continue; }
            await trx.updateTable('employees').set({ secondaryManagerEmployeeId: managerId, updatedBy: actor.userId }).where('organizationId', '=', orgId).where('id', '=', e.id).execute();
          }
          await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.updated', aggregateType: 'employee', aggregateId: e.id, payload: { bulk: input.action, line, transition: line === 'primary', branchId: e.branchId }, actorUserId: actor.userId, requestId: actor.requestId });
          changed.push(e.id);
        }
        await audit(trx, actor, orgId, 'employee.bulk_updated', 'employee', { newValue: { action: input.action, line, managerEmployeeId: managerId, ...(effectiveFrom ? { effectiveFrom } : {}), employeeIds: changed, ...(secondaryCleared.length ? { secondaryCleared } : {}), ...(skipped.length ? { skipped } : {}) } });
        return { kind: 'sync', updated: changed.length, employeeIds: changed };
      });
    }
  }
}

/**
 * The selected employees, all visible to the caller and in their branch scope (else nothing happens). Ids are compared in
 * lower case, the way Postgres returns uuids (the schema accepts upper-case hex too). A writer passes `lock`: the rows are
 * locked (lockEmployees) BEFORE they are read, so the snapshots built from them are the committed ones.
 */
async function visibleEmployees(trx: Trx, orgId: string, grant: MembershipGrant, ids: string[], opts: { lock?: boolean } = {}) {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (opts.lock) await lockEmployees(trx, orgId, unique);
  const rows = await trx.selectFrom('employees').select(['id', 'employeeNumber', 'branchId', 'departmentId', 'designationId', 'managerEmployeeId', 'secondaryManagerEmployeeId', 'employmentType', 'employmentStatus', 'joiningDate', 'workLocationId']).where('organizationId', '=', orgId).where('deletedAt', 'is', null).where('id', 'in', unique).orderBy('id').execute();
  if (rows.length !== unique.length) throw errors.validation('One or more employees were not found or are outside your branch scope.', { missing: unique.filter((id) => !rows.some((r) => r.id === id)) });
  for (const r of rows) requireBranchAccess(grant, r.branchId);
  return rows;
}
async function visibleEmployeeIds(trx: Trx, orgId: string, grant: MembershipGrant, ids: string[]): Promise<string[]> {
  return (await visibleEmployees(trx, orgId, grant, ids)).map((r) => r.id);
}

// Identity documents (sensitive) -----------------------------------------------------------------

export async function listDocuments(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string): Promise<IdentityDocumentDto[]> {
  requirePermission(actor.principal, orgId, 'employee.view_sensitive');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeRow(trx, orgId, employeeId);
    const rows = await trx.selectFrom('employeeIdentityDocuments').select(DOCUMENT_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).orderBy('createdAt', 'desc').execute();
    await audit(trx, actor, orgId, 'employee.sensitive_viewed', 'employee_identity_document', { entityId: employeeId, branchId: emp.branchId, newValue: { documents: rows.length } });
    return rows.map(toDocumentDto);
  });
}

export async function addDocument(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, input: IdentityDocumentInput): Promise<IdentityDocumentDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.update', 'employee.view_sensitive');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeRow(trx, orgId, employeeId);
    requireBranchAccess(grant, emp.branchId);
    const row = await trx.insertInto('employeeIdentityDocuments').values({ organizationId: orgId, employeeId, branchId: emp.branchId, type: input.type, number: input.number, issuingCountry: input.issuingCountry ?? null, issuedAt: input.issuedAt ?? null, expiresAt: input.expiresAt ?? null, notes: input.notes ?? null, createdBy: actor.userId }).returning(DOCUMENT_COLUMNS).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'employee.document_added', 'employee_identity_document', { entityId: row.id, branchId: emp.branchId, newValue: { employeeId, type: input.type, numberLast4: input.number.slice(-4), expiresAt: input.expiresAt ?? null } });
    return toDocumentDto(row);
  });
}

export async function deleteDocument(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, documentId: string): Promise<void> {
  const grant = requirePermission(actor.principal, orgId, 'employee.update', 'employee.view_sensitive');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeRow(trx, orgId, employeeId);
    requireBranchAccess(grant, emp.branchId);
    const doc = await trx.selectFrom('employeeIdentityDocuments').select(['id', 'type']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('id', '=', documentId).executeTakeFirst();
    if (!doc) throw errors.notFound('Identity document', documentId);
    await trx.deleteFrom('employeeIdentityDocuments').where('id', '=', documentId).execute();
    await audit(trx, actor, orgId, 'employee.document_deleted', 'employee_identity_document', { entityId: documentId, branchId: emp.branchId, oldValue: { employeeId, type: doc.type } });
  });
}
