import type { GeofenceAssignmentDto, GeofenceAssignmentInput, GeofenceDto, GeofenceEnforcement, GeofenceEvaluateInput, GeofenceEvaluationDto, GeofenceInput, GeofenceScope, GeofenceTimeWindow, GeofenceUpdateInput, GeofenceVerdictDto, SelfGeofenceDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { evaluateGeofence, type GeofenceEvaluation, type GeofenceFence, type MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, requireAnyPermission, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, diffObjects, runUser, withSystemScope } from '../../lib/service.js';
import { isoDateOrNull, isoDateTime, jsonArray } from '../../lib/mappers.js';
import { type EmployeeCtx, loadEmployeeCtx, localInstant, attendancePolicy } from './common.js';

/**
 * Geofences (HR portal Prompt 4): circles (optionally a polygon) with an enforcement, an accuracy threshold, a grace radius,
 * active dates and weekly local-time windows, assigned by scope (organisation, branch, department, team, employee). The
 * punch endpoint evaluates them through the pure `evaluateGeofence` (packages/domain/src/geofence): most specific scope
 * wins, worst verdict of that scope wins, the organisation policy `selfService.requireGeofence` caps the enforcement.
 *
 * Reads need `attendance.view` or `attendance.manage_geofences`; every write needs `attendance.manage_geofences`. A branch-
 * scoped manager manages only fences of their branches and assigns only inside them (organisation-wide assignments and
 * fences without a branch are for unrestricted members); RLS enforces the branch column again.
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

async function targetNames(t: Trx, orgId: string, rows: readonly AssignmentRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = (scope: GeofenceScope) => [...new Set(rows.filter((r) => r.scope === scope && r.targetId).map((r) => r.targetId!))];
  const b = ids('branch'); if (b.length) for (const x of await t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', b).execute()) out.set(x.id, x.name);
  const d = ids('department'); if (d.length) for (const x of await t.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', d).execute()) out.set(x.id, x.name);
  const tm = ids('team'); if (tm.length) for (const x of await t.selectFrom('teams').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', tm).execute()) out.set(x.id, x.name);
  const e = ids('employee'); if (e.length) for (const x of await t.selectFrom('employees').select(['id', 'displayName']).where('organizationId', '=', orgId).where('id', 'in', e).execute()) out.set(x.id, x.displayName);
  return out;
}

async function toDtos(trx: Trx, orgId: string, fences: FenceRow[]): Promise<GeofenceDto[]> {
  if (fences.length === 0) return [];
  const assignments = (await trx.selectFrom('geofenceAssignments').select(ASSIGNMENT_COLUMNS).where('organizationId', '=', orgId).where('geofenceId', 'in', fences.map((f) => f.id))
    .orderBy('priority', 'asc').orderBy('createdAt', 'asc').execute()) as AssignmentRow[];
  // names of the targets (a branch-scoped manager's role may not read the whole directory) and of the fences' branches
  const { names, branches } = await withSystemScope(trx, orgId, async (t) => ({
    names: await targetNames(t, orgId, assignments),
    branches: new Map((await t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).execute()).map((b) => [b.id, b.name])),
  }));
  return fences.map((f) => ({
    id: f.id, organizationId: f.organizationId, branchId: f.branchId, branchName: f.branchId ? branches.get(f.branchId) ?? null : null, name: f.name,
    latitude: Number(f.latitude), longitude: Number(f.longitude), radiusM: Number(f.radiusM), polygon: polygonOf(f.polygon), enforcement: f.enforcement,
    accuracyThresholdM: Number(f.accuracyThresholdM), graceM: Number(f.graceM), activeFrom: isoDateOrNull(f.activeFrom), activeTo: isoDateOrNull(f.activeTo),
    timeWindows: windowsOf(f.timeWindows), isActive: f.isActive, createdAt: isoDateTime(f.createdAt), updatedAt: isoDateTime(f.updatedAt),
    assignments: assignments.filter((a) => a.geofenceId === f.id).map((a): GeofenceAssignmentDto => ({ id: a.id, geofenceId: a.geofenceId, scope: a.scope, targetId: a.targetId, targetName: a.scope === 'org' ? null : names.get(a.targetId ?? '') ?? null, priority: Number(a.priority), requireOnCheckIn: a.requireOnCheckIn, requireOnCheckOut: a.requireOnCheckOut, createdAt: isoDateTime(a.createdAt) })),
  }));
}

export async function listGeofences(deps: ApiDeps, actor: Actor, orgId: string, q: { branchId?: string | undefined; includeInactive?: boolean | undefined }): Promise<GeofenceDto[]> {
  const grant = requireAnyPermission(actor.principal, orgId, 'attendance.manage_geofences', 'attendance.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('geofences').select(FENCE_COLUMNS).where('organizationId', '=', orgId);
    if (scope) base = base.where((eb) => (q.branchId ? eb('branchId', 'in', scope) : eb.or([eb('branchId', 'is', null), eb('branchId', 'in', scope)])));
    if (!q.includeInactive) base = base.where('isActive', '=', true);
    const rows = (await base.orderBy('name', 'asc').orderBy('id').execute()) as FenceRow[];
    return toDtos(trx, orgId, rows);
  });
}

async function loadFence(trx: Trx, orgId: string, id: string): Promise<FenceRow> {
  const row = (await trx.selectFrom('geofences').select(FENCE_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst()) as FenceRow | undefined;
  if (!row) throw errors.notFound('Geofence', id);
  return row;
}

export async function getGeofence(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<GeofenceDto> {
  const grant = requireAnyPermission(actor.principal, orgId, 'attendance.manage_geofences', 'attendance.view');
  return runUser(deps.db, actor, async (trx) => {
    const row = await loadFence(trx, orgId, id);
    if (row.branchId) requireBranchAccess(grant, row.branchId);
    return (await toDtos(trx, orgId, [row]))[0]!;
  });
}

/** A branch-scoped manager may only create / edit fences of their branches (no organisation-wide fence). */
function requireFenceScope(grant: MembershipGrant, branchId: string | null | undefined): void {
  if (branchId) requireBranchAccess(grant, branchId);
  else if (!grant.allBranches) throw errors.forbidden('Branch-scoped users can only manage fences of their branches.');
}

/** Validates the targets exist and are inside the caller's branch scope. System scope for the lookups. */
async function checkAssignments(trx: Trx, grant: MembershipGrant, orgId: string, assignments: readonly GeofenceAssignmentInput[]): Promise<void> {
  const seen = new Set<string>();
  for (const [i, a] of assignments.entries()) {
    const key = `${a.scope}:${a.targetId ?? ''}`;
    if (seen.has(key)) throw errors.validation('The same target is assigned twice.', { issues: [{ path: `assignments.${i}`, message: 'Duplicate target' }] });
    seen.add(key);
    if (a.scope === 'org') { if (!grant.allBranches) throw errors.forbidden('Only members with access to every branch can assign a fence to the whole organisation.'); continue; }
    const targetId = a.targetId!;
    const branchOf = await withSystemScope(trx, orgId, async (t) => {
      switch (a.scope) {
        case 'branch': return (await t.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', '=', targetId).executeTakeFirst()) ? { found: true, branchId: targetId as string | null } : { found: false, branchId: null };
        case 'department': { const d = await t.selectFrom('departments').select('branchId').where('organizationId', '=', orgId).where('id', '=', targetId).executeTakeFirst(); return { found: !!d, branchId: d?.branchId ?? null }; }
        case 'team': { const x = await t.selectFrom('teams').select('branchId').where('organizationId', '=', orgId).where('id', '=', targetId).executeTakeFirst(); return { found: !!x, branchId: x?.branchId ?? null }; }
        default: { const e = await t.selectFrom('employees').select('branchId').where('organizationId', '=', orgId).where('id', '=', targetId).where('deletedAt', 'is', null).executeTakeFirst(); return { found: !!e, branchId: e?.branchId ?? null }; }
      }
    });
    if (!branchOf.found) throw errors.validation(`Unknown ${a.scope} for this organisation.`, { issues: [{ path: `assignments.${i}.targetId`, message: 'Unknown target' }] });
    if (!grant.allBranches && (!branchOf.branchId || !grant.branchIds.includes(branchOf.branchId))) throw errors.forbidden('This assignment target is outside your branch scope.');
  }
}

async function replaceAssignments(trx: Trx, actor: Actor, orgId: string, geofenceId: string, assignments: readonly GeofenceAssignmentInput[]): Promise<void> {
  await trx.deleteFrom('geofenceAssignments').where('organizationId', '=', orgId).where('geofenceId', '=', geofenceId).execute();
  if (assignments.length === 0) return;
  await trx.insertInto('geofenceAssignments').values(assignments.map((a) => ({
    organizationId: orgId, geofenceId, scope: a.scope, targetId: a.scope === 'org' ? null : a.targetId ?? null, priority: a.priority ?? 100,
    requireOnCheckIn: a.requireOnCheckIn ?? true, requireOnCheckOut: a.requireOnCheckOut ?? true, createdBy: actor.userId,
  }))).execute();
}

function fenceValues(input: GeofenceUpdateInput): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const key of ['name', 'branchId', 'latitude', 'longitude', 'radiusM', 'enforcement', 'accuracyThresholdM', 'graceM', 'activeFrom', 'activeTo', 'isActive'] as const) if (input[key] !== undefined) v[key] = input[key];
  if (input.polygon !== undefined) v['polygon'] = input.polygon === null ? null : JSON.stringify(input.polygon);
  if (input.timeWindows !== undefined) v['timeWindows'] = input.timeWindows === null ? null : JSON.stringify(input.timeWindows);
  return v;
}

export async function createGeofence(deps: ApiDeps, actor: Actor, orgId: string, input: GeofenceInput): Promise<GeofenceDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_geofences');
  requireFenceScope(grant, input.branchId);
  return runUser(deps.db, actor, async (trx) => {
    if (input.branchId && !(await withSystemScope(trx, orgId, (t) => t.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', '=', input.branchId!).executeTakeFirst()))) {
      throw errors.validation('Branch not found.', { issues: [{ path: 'branchId', message: 'Unknown branch' }] });
    }
    // no explicit list: the fence applies to its branch, or to the whole organisation when it has none
    const assignments: GeofenceAssignmentInput[] = input.assignments ?? [input.branchId ? { scope: 'branch', targetId: input.branchId, priority: 100, requireOnCheckIn: true, requireOnCheckOut: true } : { scope: 'org', targetId: null, priority: 100, requireOnCheckIn: true, requireOnCheckOut: true }];
    await checkAssignments(trx, grant, orgId, assignments);
    const row = await trx.insertInto('geofences').values({ organizationId: orgId, createdBy: actor.userId, name: input.name, latitude: input.latitude, longitude: input.longitude, radiusM: input.radiusM, ...fenceValues(input) } as never)
      .returning('id').executeTakeFirstOrThrow();
    await replaceAssignments(trx, actor, orgId, row.id, assignments);
    await audit(trx, actor, orgId, 'geofence.created', 'geofence', { entityId: row.id, branchId: input.branchId ?? null, newValue: { ...input, assignments } });
    return (await toDtos(trx, orgId, [await loadFence(trx, orgId, row.id)]))[0]!;
  });
}

export async function updateGeofence(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: GeofenceUpdateInput): Promise<GeofenceDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_geofences');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadFence(trx, orgId, id);
    requireFenceScope(grant, before.branchId);
    if (input.branchId !== undefined) requireFenceScope(grant, input.branchId);
    const from = input.activeFrom !== undefined ? input.activeFrom : isoDateOrNull(before.activeFrom);
    const to = input.activeTo !== undefined ? input.activeTo : isoDateOrNull(before.activeTo);
    if (from && to && to < from) throw errors.validation('activeTo must be on/after activeFrom.', { issues: [{ path: 'activeTo', message: 'Before activeFrom' }] });
    const values = fenceValues(input);
    if (Object.keys(values).length > 0) await trx.updateTable('geofences').set(values as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
    const after = await loadFence(trx, orgId, id);
    const [b] = await toDtos(trx, orgId, [before]); const [a] = await toDtos(trx, orgId, [after]);
    const { assignments: _ba, updatedAt: _bu, ...bv } = b!; const { assignments: _aa, updatedAt: _au, ...av } = a!;
    const diff = diffObjects(bv as unknown as Record<string, unknown>, av as unknown as Record<string, unknown>);
    await audit(trx, actor, orgId, 'geofence.updated', 'geofence', { entityId: id, branchId: after.branchId, oldValue: diff.oldValue, newValue: diff.newValue });
    return a!;
  });
}

export async function replaceGeofenceAssignments(deps: ApiDeps, actor: Actor, orgId: string, id: string, assignments: readonly GeofenceAssignmentInput[]): Promise<GeofenceDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_geofences');
  return runUser(deps.db, actor, async (trx) => {
    const fence = await loadFence(trx, orgId, id);
    requireFenceScope(grant, fence.branchId);
    const [before] = await toDtos(trx, orgId, [fence]);
    await checkAssignments(trx, grant, orgId, assignments);
    await replaceAssignments(trx, actor, orgId, id, assignments);
    await audit(trx, actor, orgId, 'geofence.assignments_replaced', 'geofence', { entityId: id, branchId: fence.branchId, oldValue: before!.assignments.map(({ scope, targetId, priority, requireOnCheckIn, requireOnCheckOut }) => ({ scope, targetId, priority, requireOnCheckIn, requireOnCheckOut })), newValue: assignments });
    return (await toDtos(trx, orgId, [fence]))[0]!;
  });
}

export async function deleteGeofence(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_geofences');
  await runUser(deps.db, actor, async (trx) => {
    const fence = await loadFence(trx, orgId, id);
    requireFenceScope(grant, fence.branchId);
    const [dto] = await toDtos(trx, orgId, [fence]);
    // assignments cascade; punches keep the fence id and verdict in their raw payload (immutable history)
    await trx.deleteFrom('geofences').where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'geofence.deleted', 'geofence', { entityId: id, branchId: fence.branchId, oldValue: dto });
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
