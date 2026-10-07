import type { GeofenceAssignmentDto, GeofenceAssignmentInput, GeofenceDto, GeofenceEnforcement, GeofenceEvaluateInput, GeofenceEvaluationDto, GeofenceInput, GeofenceScope, GeofenceTimeWindow, GeofenceUpdateInput, GeofenceVerdictDto, SelfGeofenceDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { evaluateGeofence, type GeofenceEvaluation, type GeofenceFence, type MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, requireAnyPermission, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, diffObjects, runUser, withSystemScope } from '../../lib/service.js';
import { isoDateOrNull, isoDateTime, jsonArray } from '../../lib/mappers.js';
import { systemStep } from '../features/context.js';
import { type EmployeeCtx, loadEmployeeCtx, localInstant, attendancePolicy } from './common.js';

/**
 * Geofences (HR portal Prompt 4): circles (optionally a polygon) with an enforcement, an accuracy threshold, a grace radius,
 * active dates and weekly local-time windows, assigned by scope (organisation, branch, department, team, employee). The
 * punch endpoint evaluates them through the pure `evaluateGeofence` (packages/domain/src/geofence): most specific scope
 * wins, worst verdict of that scope wins, the organisation policy `selfService.requireGeofence` caps the enforcement.
 *
 * Reads need `attendance.view` or `attendance.manage_geofences` (a branch-scoped reader sees the fences of their branches and
 * the organisation-wide ones, and the assignments that target people inside their scope). Every write needs
 * `attendance.manage_geofences` and goes through this service's system step (the tables are service-write-only — HR portal
 * Prompt 4 review, P0-1): a branch-scoped manager manages only fences of their branches whose every assignment targets people
 * inside their scope, and assigns only inside them (organisation-wide fences and assignments are for unrestricted members).
 *
 * Which fence judges a punch (ATT-63/64, the pack's decision): the most specific assignment scope that applies to the employee
 * wins (employee > team > department > branch > organisation) and, within that scope, the WORST verdict of its fences decides.
 */

type FenceRow = { id: string; organizationId: string; branchId: string | null; name: string; latitude: number; longitude: number; radiusM: number; polygon: unknown; enforcement: GeofenceEnforcement; accuracyThresholdM: number; graceM: number; activeFrom: Date | string | null; activeTo: Date | string | null; timeWindows: unknown; isActive: boolean; createdAt: Date; updatedAt: Date };
type AssignmentRow = { id: string; geofenceId: string; scope: GeofenceScope; targetId: string | null; priority: number; requireOnCheckIn: boolean; requireOnCheckOut: boolean; createdAt: Date };

const FENCE_COLUMNS = ['id', 'organizationId', 'branchId', 'name', 'latitude', 'longitude', 'radiusM', 'polygon', 'enforcement', 'accuracyThresholdM', 'graceM', 'activeFrom', 'activeTo', 'timeWindows', 'isActive', 'createdAt', 'updatedAt'] as const;
const ASSIGNMENT_COLUMNS = ['id', 'geofenceId', 'scope', 'targetId', 'priority', 'requireOnCheckIn', 'requireOnCheckOut', 'createdAt'] as const;

const polygonOf = (v: unknown): Array<[number, number]> | null => {
  const arr = jsonArray<unknown>(v);
  if (arr.length < 3) return null;
  const pts = arr.filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number');
  return pts.length >= 3 ? pts : null;
};
const windowsOf = (v: unknown): GeofenceTimeWindow[] => jsonArray<GeofenceTimeWindow>(v).filter((w) => w && Array.isArray(w.days) && typeof w.start === 'string' && typeof w.end === 'string');

/** (fence, assignment) → the domain's fence spec. */
export function toFenceSpec(f: FenceRow, a: Pick<AssignmentRow, 'scope' | 'priority' | 'requireOnCheckIn' | 'requireOnCheckOut'>): GeofenceFence {
  const polygon = polygonOf(f.polygon);
  return {
    id: f.id, name: f.name, center: { lat: Number(f.latitude), lng: Number(f.longitude) }, radiusM: Number(f.radiusM), polygon: polygon ? polygon.map(([lat, lng]) => ({ lat, lng })) : null,
    enforcement: f.enforcement, accuracyThresholdM: Number(f.accuracyThresholdM), graceM: Number(f.graceM), activeFrom: isoDateOrNull(f.activeFrom), activeTo: isoDateOrNull(f.activeTo),
    timeWindows: windowsOf(f.timeWindows), isActive: f.isActive, scope: a.scope, priority: Number(a.priority), requireOnCheckIn: a.requireOnCheckIn, requireOnCheckOut: a.requireOnCheckOut,
  };
}

/** Every (fence, assignment) pair that targets the employee (organisation, their branch, department, teams, themselves). System scope. */
export async function fencesForEmployee(trx: Trx, orgId: string, emp: Pick<EmployeeCtx, 'id' | 'branchId' | 'departmentId' | 'teamIds'>): Promise<GeofenceFence[]> {
  return withSystemScope(trx, orgId, async (t) => {
    const rows = await t.selectFrom('geofenceAssignments as a').innerJoin('geofences as g', (j) => j.onRef('g.id', '=', 'a.geofenceId').onRef('g.organizationId', '=', 'a.organizationId'))
      .select(['g.id', 'g.organizationId', 'g.branchId', 'g.name', 'g.latitude', 'g.longitude', 'g.radiusM', 'g.polygon', 'g.enforcement', 'g.accuracyThresholdM', 'g.graceM', 'g.activeFrom', 'g.activeTo', 'g.timeWindows', 'g.isActive', 'g.createdAt', 'g.updatedAt',
        'a.scope', 'a.priority', 'a.requireOnCheckIn', 'a.requireOnCheckOut'])
      .where('a.organizationId', '=', orgId)
      .where((eb) => eb.or([
        eb('a.scope', '=', 'org'),
        eb.and([eb('a.scope', '=', 'branch'), eb('a.targetId', '=', emp.branchId)]),
        ...(emp.departmentId ? [eb.and([eb('a.scope', '=', 'department'), eb('a.targetId', '=', emp.departmentId)])] : []),
        ...(emp.teamIds.length ? [eb.and([eb('a.scope', '=', 'team'), eb('a.targetId', 'in', emp.teamIds)])] : []),
        eb.and([eb('a.scope', '=', 'employee'), eb('a.targetId', '=', emp.id)]),
      ]))
      .orderBy('a.priority', 'asc').orderBy('g.name', 'asc').execute();
    return rows.map((r) => toFenceSpec(r as unknown as FenceRow, r));
  });
}

/**
 * The fences of a BRANCH as a place (Enterprise, temporary deployment — docs/enterprise/plan.md §4.7): the fences assigned to
 * the branch (scope `branch`) and the fences that belong to it (`geofences.branch_id`), whatever else they are assigned to.
 * All are judged as one branch-scope set (the domain rule: the worst verdict of the set wins), with the direction flags of
 * their branch assignment (both directions for a fence that only belongs to the branch). System scope.
 */
export async function fencesForBranch(trx: Trx, orgId: string, branchId: string): Promise<GeofenceFence[]> {
  return withSystemScope(trx, orgId, async (t) => {
    const assigned = await t.selectFrom('geofenceAssignments as a').innerJoin('geofences as g', (j) => j.onRef('g.id', '=', 'a.geofenceId').onRef('g.organizationId', '=', 'a.organizationId'))
      .select(['g.id', 'g.organizationId', 'g.branchId', 'g.name', 'g.latitude', 'g.longitude', 'g.radiusM', 'g.polygon', 'g.enforcement', 'g.accuracyThresholdM', 'g.graceM', 'g.activeFrom', 'g.activeTo', 'g.timeWindows', 'g.isActive', 'g.createdAt', 'g.updatedAt',
        'a.priority', 'a.requireOnCheckIn', 'a.requireOnCheckOut'])
      .where('a.organizationId', '=', orgId).where('a.scope', '=', 'branch').where('a.targetId', '=', branchId)
      .orderBy('a.priority', 'asc').orderBy('g.name', 'asc').execute();
    const seen = new Set(assigned.map((r) => r.id));
    const owned = (await t.selectFrom('geofences').select(FENCE_COLUMNS).where('organizationId', '=', orgId).where('branchId', '=', branchId).orderBy('name', 'asc').execute()) as FenceRow[];
    return [
      ...assigned.map((r) => toFenceSpec(r as unknown as FenceRow, { scope: 'branch', priority: r.priority, requireOnCheckIn: r.requireOnCheckIn, requireOnCheckOut: r.requireOnCheckOut })),
      ...owned.filter((f) => !seen.has(f.id)).map((f) => toFenceSpec(f, { scope: 'branch', priority: 100, requireOnCheckIn: true, requireOnCheckOut: true })),
    ];
  });
}

/** The punch-time evaluation for an employee at an instant (their branch's local time decides windows and active dates). */
export function evaluateForEmployee(emp: Pick<EmployeeCtx, 'timezone'>, fences: readonly GeofenceFence[], input: { lat?: number | undefined; lng?: number | undefined; accuracy?: number | undefined; isMock?: boolean | undefined; direction: 'in' | 'out' }, policy: 'off' | 'flag' | 'block', at: Date): GeofenceEvaluation {
  const when = localInstant(at, emp.timezone);
  const point = input.lat !== undefined && input.lng !== undefined ? { lat: input.lat, lng: input.lng } : null;
  return evaluateGeofence(point, input.accuracy ?? null, fences, { isMock: input.isMock === true, policy, direction: input.direction, when: { date: when.date, minuteOfDay: when.minuteOfDay, isoWeekday: when.isoWeekday } });
}

export function toVerdictDto(e: GeofenceEvaluation): GeofenceVerdictDto {
  return { verdict: e.verdict, reason: e.reason, geofenceId: e.geofenceId, geofenceName: e.geofenceName, distanceM: e.distanceM, scope: e.scope, enforcement: e.enforcement };
}

/** Fences shown on the check-in page (applicable ones, most specific scope first, one row per fence). */
export function selfFences(fences: readonly GeofenceFence[]): SelfGeofenceDto[] {
  const seen = new Set<string>();
  const out: SelfGeofenceDto[] = [];
  const rank: Record<GeofenceScope, number> = { employee: 0, team: 1, department: 2, branch: 3, org: 4 };
  for (const f of [...fences].filter((x) => x.isActive).sort((a, b) => rank[a.scope] - rank[b.scope] || a.priority - b.priority)) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({ id: f.id, name: f.name, latitude: f.center.lat, longitude: f.center.lng, radiusM: f.radiusM, hasPolygon: !!f.polygon, enforcement: f.enforcement, scope: f.scope });
  }
  return out;
}

// ----- CRUD --------------------------------------------------------------------------------------------------------------------------
//
// HR portal Prompt 4 review, P0-1: `geofences` and `geofence_assignments` are SERVICE-WRITE-ONLY (like report_schedules after the
// 6a fix): `authenticated` holds no write privilege and three explicit denial policies back it up, so a branch-limited role can
// no longer loosen other branches' fences through PostgREST. Every write happens here, in a system step, AFTER these checks:
//   1. the STORED fence (read in system scope: out of scope answers 403, not 404) belongs to one of the caller's branches —
//      organisation-wide fences (no branch) only for unrestricted members;
//   2. the fence's REACH: every assignment it already carries targets people inside the caller's scope (an organisation-scope
//      assignment, or a target of another branch, makes the fence someone else's to change);
//   3. the NEW branch (create, move) is one of the caller's branches, organisation-wide again only for unrestricted members;
//   4. every NEW assignment target (employee / team / department / branch) exists and sits inside the caller's scope;
//      organisation-scope assignments only for unrestricted members.
// The checks run against the row locked FOR UPDATE inside the same system step, so a concurrent change cannot slip between
// the check and the write.

/** Name and branch of one assignment target: the branch itself, a department's / team's branch, an employee's (current) branch. */
type TargetInfo = { name: string; branchId: string | null; archived?: boolean };
const targetKey = (scope: GeofenceScope, targetId: string | null) => `${scope}:${targetId ?? ''}`;

async function targetInfo(t: Trx, orgId: string, rows: ReadonlyArray<{ scope: GeofenceScope; targetId: string | null }>): Promise<Map<string, TargetInfo>> {
  const out = new Map<string, TargetInfo>();
  const ids = (scope: GeofenceScope) => [...new Set(rows.filter((r) => r.scope === scope && r.targetId).map((r) => r.targetId!))];
  const b = ids('branch'); if (b.length) for (const x of await t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', b).execute()) out.set(targetKey('branch', x.id), { name: x.name, branchId: x.id });
  const d = ids('department'); if (d.length) for (const x of await t.selectFrom('departments').select(['id', 'name', 'branchId']).where('organizationId', '=', orgId).where('id', 'in', d).execute()) out.set(targetKey('department', x.id), { name: x.name, branchId: x.branchId });
  const tm = ids('team'); if (tm.length) for (const x of await t.selectFrom('teams').select(['id', 'name', 'branchId']).where('organizationId', '=', orgId).where('id', 'in', tm).execute()) out.set(targetKey('team', x.id), { name: x.name, branchId: x.branchId });
  const e = ids('employee'); if (e.length) for (const x of await t.selectFrom('employees').select(['id', 'displayName', 'branchId', 'deletedAt']).where('organizationId', '=', orgId).where('id', 'in', e).execute()) out.set(targetKey('employee', x.id), { name: x.displayName, branchId: x.branchId, archived: !!x.deletedAt });
  return out;
}

/** An assignment the caller may create or remove: everything for unrestricted members; a target of one of their branches otherwise (never the organisation scope). */
function assignmentInScope(grant: MembershipGrant, a: { scope: GeofenceScope; targetId: string | null }, info: Map<string, TargetInfo>): boolean {
  if (grant.allBranches) return true;
  if (a.scope === 'org') return false;
  const branchId = info.get(targetKey(a.scope, a.targetId))?.branchId ?? null;
  return !!branchId && grant.branchIds.includes(branchId);
}

/** A fence the caller may manage as far as its own branch goes (organisation-wide fences only for unrestricted members). */
function fenceBranchInScope(grant: MembershipGrant, branchId: string | null | undefined): boolean {
  if (grant.allBranches) return true;
  return !!branchId && grant.branchIds.includes(branchId);
}

/** A branch-scoped manager may only create / edit fences of their branches (no organisation-wide fence). */
function requireFenceScope(grant: MembershipGrant, branchId: string | null | undefined): void {
  if (branchId) requireBranchAccess(grant, branchId);
  else if (!grant.allBranches) throw errors.forbidden('Branch-scoped users can only manage fences of their branches.');
}

/** Whether the caller may change the fence and its assignments (the rules above, read side — the DTO's `editable`). */
function canEditFence(grant: MembershipGrant, fence: Pick<FenceRow, 'branchId'>, assignments: readonly AssignmentRow[], info: Map<string, TargetInfo>): boolean {
  return hasPermission(grant, 'attendance.manage_geofences') && fenceBranchInScope(grant, fence.branchId) && assignments.every((a) => assignmentInScope(grant, a, info));
}

/** Validates the new targets exist and are inside the caller's branch scope. Runs inside the write's system step. */
async function checkAssignments(t: Trx, grant: MembershipGrant, orgId: string, assignments: readonly GeofenceAssignmentInput[]): Promise<void> {
  const seen = new Set<string>();
  const info = await targetInfo(t, orgId, assignments.map((a) => ({ scope: a.scope, targetId: a.scope === 'org' ? null : a.targetId ?? null })));
  for (const [i, a] of assignments.entries()) {
    const key = targetKey(a.scope, a.targetId ?? null);
    if (seen.has(key)) throw errors.validation('The same target is assigned twice.', { issues: [{ path: `assignments.${i}`, message: 'Duplicate target' }] });
    seen.add(key);
    if (a.scope === 'org') { if (!grant.allBranches) throw errors.forbidden('Only members with access to every branch can assign a fence to the whole organisation.'); continue; }
    const target = info.get(key);
    if (!target || target.archived) throw errors.validation(`Unknown ${a.scope} for this organisation.`, { issues: [{ path: `assignments.${i}.targetId`, message: 'Unknown target' }] });
    if (!assignmentInScope(grant, { scope: a.scope, targetId: a.targetId ?? null }, info)) throw errors.forbidden('This assignment target is outside your branch scope.');
  }
}

async function loadFenceRow(t: Trx, orgId: string, id: string, opts: { lock?: boolean } = {}): Promise<FenceRow | undefined> {
  let q = t.selectFrom('geofences').select(FENCE_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id);
  if (opts.lock) q = q.forUpdate();
  return (await q.executeTakeFirst()) as FenceRow | undefined;
}

async function assignmentsOf(t: Trx, orgId: string, geofenceIds: readonly string[]): Promise<AssignmentRow[]> {
  if (geofenceIds.length === 0) return [];
  return (await t.selectFrom('geofenceAssignments').select(ASSIGNMENT_COLUMNS).where('organizationId', '=', orgId).where('geofenceId', 'in', [...geofenceIds])
    .orderBy('priority', 'asc').orderBy('createdAt', 'asc').orderBy('id', 'asc').execute()) as AssignmentRow[];
}

/**
 * The fence a change targets, locked for the write and checked (rules 1 and 2): read in the organisation's system scope —
 * the caller holds no write privilege and may not even read every assignment — so a fence outside a branch-scoped caller's
 * reach answers 403 (refused) rather than 404. MUST run inside the write's system step.
 */
async function lockFenceForChange(t: Trx, orgId: string, id: string, grant: MembershipGrant): Promise<{ fence: FenceRow; assignments: AssignmentRow[] }> {
  const fence = await loadFenceRow(t, orgId, id, { lock: true });
  if (!fence) throw errors.notFound('Geofence', id);
  if (!fenceBranchInScope(grant, fence.branchId)) throw errors.forbidden(fence.branchId ? 'This geofence belongs to a branch outside your access scope.' : 'Only members with access to every branch can change an organisation-wide geofence.');
  const assignments = await assignmentsOf(t, orgId, [id]);
  const info = await targetInfo(t, orgId, assignments);
  if (!assignments.every((a) => assignmentInScope(grant, a, info))) throw errors.forbidden('This geofence also applies to people outside your branch scope; ask an administrator with access to every branch to change it.');
  return { fence, assignments };
}

async function writeAssignments(t: Trx, actor: Actor, orgId: string, geofenceId: string, assignments: readonly GeofenceAssignmentInput[]): Promise<void> {
  await t.deleteFrom('geofenceAssignments').where('organizationId', '=', orgId).where('geofenceId', '=', geofenceId).execute();
  if (assignments.length === 0) return;
  await t.insertInto('geofenceAssignments').values(assignments.map((a) => ({
    organizationId: orgId, geofenceId, scope: a.scope, targetId: a.scope === 'org' ? null : a.targetId ?? null, priority: a.priority ?? 100,
    requireOnCheckIn: a.requireOnCheckIn ?? true, requireOnCheckOut: a.requireOnCheckOut ?? true, createdBy: actor.userId,
  }))).execute();
}

/**
 * DTOs. Assignments are read under the CALLER's RLS (a branch-scoped reader sees the assignments inside their scope and the
 * organisation-wide ones); names, the full assignment count and the editability are resolved in system scope.
 */
async function toDtos(trx: Trx, orgId: string, fences: FenceRow[], grant: MembershipGrant): Promise<GeofenceDto[]> {
  if (fences.length === 0) return [];
  const visible = (await trx.selectFrom('geofenceAssignments').select(ASSIGNMENT_COLUMNS).where('organizationId', '=', orgId).where('geofenceId', 'in', fences.map((f) => f.id))
    .orderBy('priority', 'asc').orderBy('createdAt', 'asc').orderBy('id', 'asc').execute()) as AssignmentRow[];
  const { all, info, branches } = await withSystemScope(trx, orgId, async (t) => {
    const allRows = await assignmentsOf(t, orgId, fences.map((f) => f.id));
    return {
      all: allRows,
      info: await targetInfo(t, orgId, allRows),
      branches: new Map((await t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).execute()).map((b) => [b.id, b.name])),
    };
  });
  return fences.map((f) => {
    const mine = visible.filter((a) => a.geofenceId === f.id);
    const every = all.filter((a) => a.geofenceId === f.id);
    return {
      ...fenceFields(f, branches),
      assignments: mine.map((a): GeofenceAssignmentDto => ({ id: a.id, geofenceId: a.geofenceId, scope: a.scope, targetId: a.targetId, targetName: a.scope === 'org' ? null : info.get(targetKey(a.scope, a.targetId))?.name ?? null, priority: Number(a.priority), requireOnCheckIn: a.requireOnCheckIn, requireOnCheckOut: a.requireOnCheckOut, createdAt: isoDateTime(a.createdAt) })),
      editable: canEditFence(grant, f, every, info),
      hiddenAssignments: Math.max(0, every.length - mine.length),
    };
  });
}

function fenceFields(f: FenceRow, branches: Map<string, string>): Omit<GeofenceDto, 'assignments' | 'editable' | 'hiddenAssignments'> {
  return {
    id: f.id, organizationId: f.organizationId, branchId: f.branchId, branchName: f.branchId ? branches.get(f.branchId) ?? null : null, name: f.name,
    latitude: Number(f.latitude), longitude: Number(f.longitude), radiusM: Number(f.radiusM), polygon: polygonOf(f.polygon), enforcement: f.enforcement,
    accuracyThresholdM: Number(f.accuracyThresholdM), graceM: Number(f.graceM), activeFrom: isoDateOrNull(f.activeFrom), activeTo: isoDateOrNull(f.activeTo),
    timeWindows: windowsOf(f.timeWindows), isActive: f.isActive, createdAt: isoDateTime(f.createdAt), updatedAt: isoDateTime(f.updatedAt),
  };
}

const assignmentAudit = (rows: ReadonlyArray<{ scope: GeofenceScope; targetId?: string | null | undefined; priority?: number | undefined; requireOnCheckIn?: boolean | undefined; requireOnCheckOut?: boolean | undefined }>) =>
  rows.map(({ scope, targetId, priority, requireOnCheckIn, requireOnCheckOut }) => ({ scope, targetId: targetId ?? null, priority: Number(priority ?? 100), requireOnCheckIn: requireOnCheckIn ?? true, requireOnCheckOut: requireOnCheckOut ?? true }));

export async function listGeofences(deps: ApiDeps, actor: Actor, orgId: string, q: { branchId?: string | undefined; includeInactive?: boolean | undefined }): Promise<GeofenceDto[]> {
  const grant = requireAnyPermission(actor.principal, orgId, 'attendance.manage_geofences', 'attendance.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('geofences').select(FENCE_COLUMNS).where('organizationId', '=', orgId);
    if (scope) base = base.where((eb) => (q.branchId ? eb('branchId', 'in', scope) : eb.or([eb('branchId', 'is', null), eb('branchId', 'in', scope)])));
    if (!q.includeInactive) base = base.where('isActive', '=', true);
    const rows = (await base.orderBy('name', 'asc').orderBy('id').execute()) as FenceRow[];
    return toDtos(trx, orgId, rows, grant);
  });
}

export async function getGeofence(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<GeofenceDto> {
  const grant = requireAnyPermission(actor.principal, orgId, 'attendance.manage_geofences', 'attendance.view');
  return runUser(deps.db, actor, async (trx) => {
    const row = await loadFenceRow(trx, orgId, id);
    if (!row) throw errors.notFound('Geofence', id);
    if (row.branchId) requireBranchAccess(grant, row.branchId);
    return (await toDtos(trx, orgId, [row], grant))[0]!;
  });
}

function fenceValues(input: GeofenceUpdateInput): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const key of ['name', 'branchId', 'latitude', 'longitude', 'radiusM', 'enforcement', 'accuracyThresholdM', 'graceM', 'activeFrom', 'activeTo', 'isActive'] as const) if (input[key] !== undefined) v[key] = input[key];
  if (input.polygon !== undefined) v['polygon'] = input.polygon === null ? null : JSON.stringify(input.polygon);
  if (input.timeWindows !== undefined) v['timeWindows'] = input.timeWindows === null ? null : JSON.stringify(input.timeWindows);
  return v;
}

async function requireBranchExists(t: Trx, orgId: string, branchId: string | null | undefined): Promise<void> {
  if (!branchId) return;
  if (!(await t.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', '=', branchId).executeTakeFirst())) {
    throw errors.validation('Branch not found.', { issues: [{ path: 'branchId', message: 'Unknown branch' }] });
  }
}

export async function createGeofence(deps: ApiDeps, actor: Actor, orgId: string, input: GeofenceInput): Promise<GeofenceDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_geofences');
  requireFenceScope(grant, input.branchId);
  // no explicit list: the fence applies to its branch, or to the whole organisation when it has none
  const assignments: GeofenceAssignmentInput[] = input.assignments ?? [input.branchId ? { scope: 'branch', targetId: input.branchId, priority: 100, requireOnCheckIn: true, requireOnCheckOut: true } : { scope: 'org', targetId: null, priority: 100, requireOnCheckIn: true, requireOnCheckOut: true }];
  return runUser(deps.db, actor, async (trx) => {
    // written by the service's system step after the checks (authenticated holds no write privilege on the geofence tables)
    const row = await systemStep(trx, orgId, async (t) => {
      await requireBranchExists(t, orgId, input.branchId);
      await checkAssignments(t, grant, orgId, assignments);
      const created = (await t.insertInto('geofences').values({ organizationId: orgId, createdBy: actor.userId, name: input.name, latitude: input.latitude, longitude: input.longitude, radiusM: input.radiusM, ...fenceValues(input) } as never)
        .returning(FENCE_COLUMNS).executeTakeFirstOrThrow()) as FenceRow;
      await writeAssignments(t, actor, orgId, created.id, assignments);
      return created;
    });
    await audit(trx, actor, orgId, 'geofence.created', 'geofence', { entityId: row.id, branchId: input.branchId ?? null, newValue: { ...input, assignments } });
    return (await toDtos(trx, orgId, [row], grant))[0]!;
  });
}

export async function updateGeofence(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: GeofenceUpdateInput): Promise<GeofenceDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_geofences');
  if (input.branchId !== undefined) requireFenceScope(grant, input.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const { before, after, branches } = await systemStep(trx, orgId, async (t) => {
      const { fence } = await lockFenceForChange(t, orgId, id, grant);
      if (input.branchId !== undefined) await requireBranchExists(t, orgId, input.branchId);
      const from = input.activeFrom !== undefined ? input.activeFrom : isoDateOrNull(fence.activeFrom);
      const to = input.activeTo !== undefined ? input.activeTo : isoDateOrNull(fence.activeTo);
      if (from && to && to < from) throw errors.validation('activeTo must be on/after activeFrom.', { issues: [{ path: 'activeTo', message: 'Before activeFrom' }] });
      const values = fenceValues(input);
      if (Object.keys(values).length > 0) await t.updateTable('geofences').set(values as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
      const saved = (await loadFenceRow(t, orgId, id))!;
      return { before: fence, after: saved, branches: new Map((await t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).execute()).map((b) => [b.id, b.name])) };
    });
    const { updatedAt: _bu, ...bv } = fenceFields(before, branches); const { updatedAt: _au, ...av } = fenceFields(after, branches);
    const diff = diffObjects(bv as unknown as Record<string, unknown>, av as unknown as Record<string, unknown>);
    await audit(trx, actor, orgId, 'geofence.updated', 'geofence', { entityId: id, branchId: after.branchId, oldValue: diff.oldValue, newValue: diff.newValue });
    return (await toDtos(trx, orgId, [after], grant))[0]!;
  });
}

export async function replaceGeofenceAssignments(deps: ApiDeps, actor: Actor, orgId: string, id: string, assignments: readonly GeofenceAssignmentInput[]): Promise<GeofenceDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_geofences');
  return runUser(deps.db, actor, async (trx) => {
    const { fence, previous } = await systemStep(trx, orgId, async (t) => {
      const locked = await lockFenceForChange(t, orgId, id, grant);
      await checkAssignments(t, grant, orgId, assignments);
      await writeAssignments(t, actor, orgId, id, assignments);
      return { fence: locked.fence, previous: locked.assignments };
    });
    await audit(trx, actor, orgId, 'geofence.assignments_replaced', 'geofence', { entityId: id, branchId: fence.branchId, oldValue: assignmentAudit(previous), newValue: assignmentAudit(assignments) });
    return (await toDtos(trx, orgId, [fence], grant))[0]!;
  });
}

export async function deleteGeofence(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_geofences');
  await runUser(deps.db, actor, async (trx) => {
    const { fence, previous, branches } = await systemStep(trx, orgId, async (t) => {
      const locked = await lockFenceForChange(t, orgId, id, grant);
      const names = new Map((await t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).execute()).map((b) => [b.id, b.name]));
      // assignments cascade; punches keep the fence id and verdict in their raw payload (immutable history)
      await t.deleteFrom('geofences').where('organizationId', '=', orgId).where('id', '=', id).execute();
      return { fence: locked.fence, previous: locked.assignments, branches: names };
    });
    await audit(trx, actor, orgId, 'geofence.deleted', 'geofence', { entityId: id, branchId: fence.branchId, oldValue: { ...fenceFields(fence, branches), assignments: assignmentAudit(previous) } });
  });
}

/** The HR dry-run tester: how would a punch of this employee at this spot (and time) be judged — without recording anything. */
export async function evaluateGeofenceForEmployee(deps: ApiDeps, actor: Actor, orgId: string, input: GeofenceEvaluateInput): Promise<GeofenceEvaluationDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_geofences');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeCtx(trx, orgId, input.employeeId);
    requireBranchAccess(grant, emp.branchId);
    const policy = (await attendancePolicy(trx, orgId)).selfService.requireGeofence;
    const fences = await fencesForEmployee(trx, orgId, emp);
    const at = input.at ? new Date(input.at) : new Date();
    const e = evaluateForEmployee(emp, fences, { lat: input.lat, lng: input.lng, accuracy: input.accuracy, isMock: input.isMock, direction: input.direction }, policy, at);
    const first = (o: (typeof e.outcomes)[number]) => (o.considered ? 0 : o.applicable ? 1 : 2);
    return {
      verdict: toVerdictDto(e), requireGeofence: policy, winningScope: e.winningScope,
      fences: [...e.outcomes].sort((a, b) => first(a) - first(b) || a.fence.priority - b.fence.priority).map((o) => ({ id: o.fence.id, name: o.fence.name, scope: o.fence.scope, priority: o.fence.priority, considered: o.considered, applicable: o.applicable, inactiveReason: o.inactiveReason, distanceM: o.distanceM, outcome: o.verdict })),
    };
  });
}
