import { sql, type Updateable } from 'kysely';
import {
  LOCATION_LEVELS_MAX, LOCATIONS_MAX, locationTemplate,
  type ApplyLocationTemplateInput, type LocationDetailDto, type LocationDto, type LocationInput, type LocationLevelDto, type LocationLevelInput,
  type LocationLevelRole, type LocationListQuery, type UpdateLocationInput, type UpdateLocationLevelInput,
} from '@flowza/contracts';
import { loadLocationTree, uuidArray, type LocationLevels, type LocationRow, type Locations, type Trx } from '@flowza/database';
import {
  ancestorsOf, deriveLocationCode, placementProblem, positionsAfterDelete, positionsAfterInsert, roleForNewLevel, rollUp, templateLevelPlan,
  type MembershipGrant, type PlacementParent, type PlacementProblem,
} from '@flowza/domain';
import { AppError, errors, localDateOf } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requireBranchAccess, requirePermission } from '../lib/authorize.js';
import { numberOrNull } from '../lib/mappers.js';
import { toCount } from '../lib/pagination.js';
import { type Actor, audit, diffObjects, runUser, withSystemScope } from '../lib/service.js';
import { LEVEL_COLUMNS, toLocationDto, toLocationLevelDto, type LevelRow } from './locations.mappers.js';

/*
 * Location hierarchy (docs/locations.md §1, §5, §6; ADR-009): the organisation's customer-named levels, its location tree and
 * the placement of branches in it.
 *
 * - Everything a member does runs as that member (runUser). RLS reads with branch.view and writes with branch.manage — the
 *   levels, group nodes and branch placement only for members with every branch, places for the members whose scope holds
 *   their branch. The services check the same rules first, so the caller gets a precise 403 / 400 / 409 instead of a policy
 *   violation, and the triggers' rules (shape, level list, place references) are mirrored with the domain helpers.
 * - Organisation-wide facts a branch-scoped member cannot see are counted through withSystemScope — read-only, and only the
 *   counts leave it: the 10 000-location cap and what still refers to a place (archive, move to another branch).
 * - One writer of an organisation's tree at a time (a transaction-scoped advisory lock): every validation reads exactly the
 *   state its write changes, so two concurrent moves cannot build a cycle and two creates cannot pass the cap together.
 * - The level list is checked by a DEFERRED constraint trigger: level writes run it at the end of the operation (SET
 *   CONSTRAINTS … IMMEDIATE), so a malformed list is a 400 inside the request rather than a failed COMMIT.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTHING = sql.raw('');

/** One writer of an organisation's location tree (levels and nodes) at a time. */
async function lockTree(trx: Trx, orgId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`flowza:locations:${orgId}`}, 0))`.execute(trx);
}

/** Runs the deferred level-list check now: a malformed list fails this statement (→ 400) instead of the COMMIT. */
async function checkLevelList(trx: Trx): Promise<void> {
  await sql`set constraints public.location_levels_check immediate`.execute(trx);
}

/** The node `id` and every node below it (ids), as a subquery. */
function subtreeQuery(trx: Trx, orgId: string, id: string) {
  return trx.selectFrom('locations as sub').select('sub.id').where('sub.organizationId', '=', orgId).where(sql<boolean>`sub.path @> array[${id}]::uuid[]`);
}

// ----- errors ------------------------------------------------------------------------------------------------------------------

function invalid(path: string, message: string, details: Record<string, unknown> = {}): AppError {
  return errors.validation(message, { ...details, issues: [{ path, message }] });
}

function requireEveryBranch(grant: MembershipGrant, action: string): void {
  if (!grant.allBranches) throw errors.forbidden(`Your access is limited to specific branches: only members with every branch ${action}.`);
}

const codeTaken = (code: string) =>
  errors.conflict(`Another location under the same parent already uses the code ${code}.`, { reason: 'CODE_TAKEN', code, issues: [{ path: 'code', message: 'Already used by a sibling location' }] });

/** The place references (composite keys `(location_id, branch_id, organization_id)`) and the count each one reports under. */
const PLACE_REFERENCE_KEYS: Readonly<Record<string, string>> = {
  devices_location_fkey: 'devices',
  employees_work_location_fkey: 'employees',
  geofences_location_fkey: 'geofences',
  shift_coverage_requirements_location_fkey: 'coverageTargets',
  attendance_rule_sets_location_branch_fkey: 'policies',
  attendance_rule_sets_location_fkey: 'policies',
};

/** A sentence a location trigger raised (authored text, never SQL) as a message: "A place sits under a branch…". */
function sentence(message: string | undefined, fallback: string): string {
  const m = (message ?? '').replace(/^error:\s*/i, '').trim();
  if (!m) return fallback;
  return `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?…]$/.test(m) ? '' : '.'}`;
}

/**
 * Postgres errors of the location triggers and keys → precise AppErrors (never SQL text); null = not ours, the central mapper
 * (runUser) decides. The services validate first, so these mostly answer races: 22023 (shape trigger) / 23514 (level-list
 * check) → 400, a sibling code (23505) or a place still referenced from another branch's point of view (23503) → 409.
 */
export function mapLocationError(err: unknown): AppError | null {
  if (AppError.is(err) || typeof err !== 'object' || err === null) return null;
  const { code, constraint, message } = err as { code?: unknown; constraint?: unknown; message?: unknown };
  const msg = typeof message === 'string' ? message : undefined;
  const key = typeof constraint === 'string' ? constraint : undefined;
  switch (code) {
    case '22023':
      return errors.validation(sentence(msg, 'The location does not fit there.'), { reason: 'LOCATION_SHAPE' });
    case '23514':
      // raised by the level-list check (no constraint name); a CHECK constraint names itself and stays with the central mapper
      return key ? null : errors.validation(sentence(msg, 'The location levels would not be well formed.'), { reason: 'LEVEL_LIST' });
    case '23505':
      if (key === 'locations_sibling_code_key') return errors.conflict('Another location under the same parent already uses this code.', { reason: 'CODE_TAKEN' });
      if (key === 'location_levels_position_key') return errors.conflict('The location levels changed at the same time: reload them and try again.', { reason: 'LEVELS_CHANGED' });
      return null;
    case '23503':
      if (key && PLACE_REFERENCE_KEYS[key]) {
        return errors.conflict('The place, or a place below it, is still in use, so it cannot move to another branch.', { reason: 'PLACE_IN_USE', referencedBy: PLACE_REFERENCE_KEYS[key] });
      }
      if (key === 'locations_level_fkey') return errors.conflict('Locations still use this level.', { reason: 'LEVEL_IN_USE' });
      // the shape trigger names a level / parent of another organisation (raised, no constraint)
      return key ? null : errors.validation(sentence(msg, 'The level or the parent does not belong to this organisation.'), { reason: 'LOCATION_SHAPE' });
    default:
      return null;
  }
}

/** runUser with the location errors mapped first (inside the transaction callback, before the central mapper sees them). */
function runTree<T>(deps: ApiDeps, actor: Actor, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return runUser(deps.db, actor, async (trx) => {
    try {
      return await fn(trx);
    } catch (err) {
      throw mapLocationError(err) ?? err;
    }
  });
}

// ----- levels ------------------------------------------------------------------------------------------------------------------

async function loadLevels(trx: Trx, orgId: string): Promise<LevelRow[]> {
  return trx.selectFrom('locationLevels').select(LEVEL_COLUMNS).where('organizationId', '=', orgId).orderBy('position').execute();
}

async function findLevel(trx: Trx, orgId: string, id: string): Promise<LevelRow | undefined> {
  if (!UUID.test(id)) return undefined;
  return trx.selectFrom('locationLevels').select(LEVEL_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
}

/** Locations per level (archived ones included; the branch level counts the branch nodes) — what the caller may see. */
async function levelCounts(trx: Trx, orgId: string): Promise<Map<string, number>> {
  const rows = await trx.selectFrom('locations').select(['levelId', (eb) => eb.fn.countAll().as('n')]).where('organizationId', '=', orgId).groupBy('levelId').execute();
  return new Map(rows.map((r) => [r.levelId, toCount(r.n)]));
}

async function levelList(trx: Trx, orgId: string): Promise<LocationLevelDto[]> {
  const levels = await loadLevels(trx, orgId);
  const counts = await levelCounts(trx, orgId);
  return levels.map((l) => toLocationLevelDto(l, counts.get(l.id) ?? 0));
}

const levelAudit = (l: { position: number; role: string; name: string; nameAr: string | null; icon: string }) =>
  ({ position: Number(l.position), role: l.role, name: l.name, nameAr: l.nameAr, icon: l.icon });

const LEVELS_ACTION = 'can change the location levels';

export async function listLocationLevels(deps: ApiDeps, actor: Actor, orgId: string): Promise<LocationLevelDto[]> {
  requirePermission(actor.principal, orgId, 'branch.view');
  return runUser(deps.db, actor, (trx) => levelList(trx, orgId));
}

/**
 * Inserts a level at `position` (1 … levels + 1): the levels from there down move one place, and the new level is a group
 * level at / above the branch level's position, a place level below it. Returns the whole ordered list.
 */
export async function createLocationLevel(deps: ApiDeps, actor: Actor, orgId: string, input: LocationLevelInput): Promise<LocationLevelDto[]> {
  const grant = requirePermission(actor.principal, orgId, 'branch.manage');
  requireEveryBranch(grant, LEVELS_ACTION);
  return runTree(deps, actor, async (trx) => {
    await lockTree(trx, orgId);
    const levels = await loadLevels(trx, orgId);
    if (levels.length >= LOCATION_LEVELS_MAX) throw errors.conflict(`An organisation has at most ${LOCATION_LEVELS_MAX} location levels.`, { reason: 'LEVELS_MAX', max: LOCATION_LEVELS_MAX });
    if (input.position > levels.length + 1) throw invalid('position', `Choose a position between 1 and ${levels.length + 1}.`, { max: levels.length + 1 });
    const role = roleForNewLevel(levels, input.position);
    const shifted = positionsAfterInsert(levels, input.position);
    // one statement: the (organization_id, position) key is deferrable, so it is checked once every level has moved
    if (shifted.length) {
      await trx.updateTable('locationLevels').set({ position: sql<number>`position + 1` }).where('organizationId', '=', orgId).where('id', 'in', shifted.map((s) => s.id)).execute();
    }
    const row = await trx.insertInto('locationLevels')
      .values({ organizationId: orgId, position: input.position, role, name: input.name, nameAr: input.nameAr ?? null, ...(input.icon ? { icon: input.icon } : {}) })
      .returning(LEVEL_COLUMNS).executeTakeFirstOrThrow();
    await checkLevelList(trx);
    await audit(trx, actor, orgId, 'location_level.created', 'location_level', { entityId: row.id, newValue: { ...levelAudit(row), shiftedLevels: shifted.length } });
    return levelList(trx, orgId);
  });
}

/** Renames a level (English / Arabic) or changes its icon; its role and position never change this way. */
export async function updateLocationLevel(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateLocationLevelInput): Promise<LocationLevelDto> {
  const grant = requirePermission(actor.principal, orgId, 'branch.manage');
  requireEveryBranch(grant, LEVELS_ACTION);
  return runTree(deps, actor, async (trx) => {
    const before = await findLevel(trx, orgId, id);
    if (!before) throw errors.notFound('Location level', id);
    const values: Updateable<LocationLevels> = {};
    if (input.name !== undefined) values.name = input.name;
    if (input.nameAr !== undefined) values.nameAr = input.nameAr;
    if (input.icon !== undefined) values.icon = input.icon;
    if (Object.keys(values).length) await trx.updateTable('locationLevels').set(values).where('organizationId', '=', orgId).where('id', '=', id).execute();
    const after = await findLevel(trx, orgId, id);
    if (!after) throw errors.notFound('Location level', id);
    const diff = diffObjects(levelAudit(before), levelAudit(after));
    if (Object.keys(diff.newValue).length) await audit(trx, actor, orgId, 'location_level.updated', 'location_level', { entityId: id, ...diff });
    return toLocationLevelDto(after, (await levelCounts(trx, orgId)).get(id) ?? 0);
  });
}

/** Deletes an unused level (never the branch level); the levels below it move one place up. Returns the whole ordered list. */
export async function deleteLocationLevel(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<LocationLevelDto[]> {
  const grant = requirePermission(actor.principal, orgId, 'branch.manage');
  requireEveryBranch(grant, LEVELS_ACTION);
  return runTree(deps, actor, async (trx) => {
    await lockTree(trx, orgId);
    const levels = await loadLevels(trx, orgId);
    const level = levels.find((l) => l.id === id);
    if (!level) throw errors.notFound('Location level', id);
    if (level.role === 'branch') throw errors.conflict('The branch level cannot be deleted: rename it instead.', { reason: 'BRANCH_LEVEL' });
    // the caller has every branch, so every location of the organisation is visible here (the level key refuses a race)
    const used = (await levelCounts(trx, orgId)).get(id) ?? 0;
    if (used > 0) {
      throw errors.conflict(`${used} location${used === 1 ? ' uses' : 's use'} this level (archived ones included): move them to another level first.`, { reason: 'LEVEL_IN_USE', locations: used });
    }
    await trx.deleteFrom('locationLevels').where('organizationId', '=', orgId).where('id', '=', id).execute();
    const shifted = positionsAfterDelete(levels, id);
    if (shifted.length) {
      await trx.updateTable('locationLevels').set({ position: sql<number>`position - 1` }).where('organizationId', '=', orgId).where('id', 'in', shifted.map((s) => s.id)).execute();
    }
    await checkLevelList(trx);
    await audit(trx, actor, orgId, 'location_level.deleted', 'location_level', { entityId: id, oldValue: { ...levelAudit(level), shiftedLevels: shifted.length } });
    return levelList(trx, orgId);
  });
}

/**
 * Replaces the level list with a template's while the organisation has no group / place location (archived ones included).
 * The branch level keeps its id — the branches' nodes point at it — and takes the template's name, icon and position.
 */
export async function applyLocationTemplate(deps: ApiDeps, actor: Actor, orgId: string, input: ApplyLocationTemplateInput): Promise<LocationLevelDto[]> {
  const grant = requirePermission(actor.principal, orgId, 'branch.manage');
  requireEveryBranch(grant, LEVELS_ACTION);
  return runTree(deps, actor, async (trx) => {
    await lockTree(trx, orgId);
    const nodes = toCount((await trx.selectFrom('locations').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('role', '<>', 'branch').executeTakeFirst())?.n);
    if (nodes > 0) {
      throw errors.conflict('A template replaces the levels only while the organisation has no group or place locations (archived ones included).', { reason: 'LOCATIONS_EXIST', locations: nodes });
    }
    const before = await loadLevels(trx, orgId);
    const plan = templateLevelPlan(before, locationTemplate(input.template));
    // the other levels go first, so the branch level can take any position and the template's levels theirs
    if (plan.deleteIds.length) await trx.deleteFrom('locationLevels').where('organizationId', '=', orgId).where('id', 'in', plan.deleteIds).execute();
    await trx.updateTable('locationLevels').set({ position: plan.branch.position, name: plan.branch.name, nameAr: plan.branch.nameAr, icon: plan.branch.icon })
      .where('organizationId', '=', orgId).where('id', '=', plan.branch.id).execute();
    if (plan.insert.length) await trx.insertInto('locationLevels').values(plan.insert.map((l) => ({ organizationId: orgId, ...l }))).execute();
    await checkLevelList(trx);
    const after = await levelList(trx, orgId);
    await audit(trx, actor, orgId, 'location_level.template_applied', 'location_level', {
      oldValue: { levels: before.map(levelAudit) }, newValue: { template: input.template, levels: after.map(levelAudit) },
    });
    return after;
  });
}

// ----- nodes -------------------------------------------------------------------------------------------------------------------

/** A location with what its rules need: the level's position, the path, and its status (a branch node's is its branch's). */
interface NodeRow {
  id: string; role: LocationLevelRole; levelId: string; levelPosition: number; parentId: string | null; branchId: string | null; path: string[];
  status: string; code: string | null; name: string | null; nameAr: string | null; latitude: number | null; longitude: number | null;
}

async function findNode(trx: Trx, orgId: string, id: string): Promise<NodeRow | undefined> {
  if (!UUID.test(id)) return undefined;
  const r = await trx.selectFrom('locations as l')
    .innerJoin('locationLevels as lv', (j) => j.onRef('lv.id', '=', 'l.levelId').onRef('lv.organizationId', '=', 'l.organizationId'))
    .leftJoin('branches as b', (j) => j.onRef('b.id', '=', 'l.branchId').onRef('b.organizationId', '=', 'l.organizationId'))
    .select(['l.id', 'l.role', 'l.levelId', 'lv.position as levelPosition', 'l.parentId', 'l.branchId', 'l.path', 'l.status', 'b.status as branchStatus',
      'l.code', 'l.name', 'l.nameAr', 'l.latitude', 'l.longitude'])
    .where('l.organizationId', '=', orgId).where('l.id', '=', id)
    .executeTakeFirst();
  if (!r) return undefined;
  return {
    id: r.id, role: r.role, levelId: r.levelId, levelPosition: Number(r.levelPosition), parentId: r.parentId, branchId: r.branchId, path: uuidArray(r.path) ?? [r.id],
    status: r.role === 'branch' ? (r.branchStatus ?? 'archived') : r.status,
    code: r.code === null ? null : String(r.code), name: r.name, nameAr: r.nameAr, latitude: numberOrNull(r.latitude), longitude: numberOrNull(r.longitude),
  };
}

/** The node, or NOT_FOUND — also for a node of another organisation or one the caller's branch scope hides. */
async function requireNode(trx: Trx, orgId: string, id: string): Promise<NodeRow> {
  const node = await findNode(trx, orgId, id);
  if (!node) throw errors.notFound('Location', id);
  return node;
}

async function requireParent(trx: Trx, orgId: string, id: string): Promise<NodeRow> {
  const node = await findNode(trx, orgId, id);
  if (!node) throw new AppError('NOT_FOUND', 'Parent location not found.', { details: { id, issues: [{ path: 'parentId', message: 'Unknown location' }] } });
  return node;
}

const asParent = (n: NodeRow, opts: { ignoreStatus?: boolean } = {}): PlacementParent =>
  (opts.ignoreStatus ? { id: n.id, role: n.role, levelPosition: n.levelPosition, path: n.path } : { id: n.id, role: n.role, levelPosition: n.levelPosition, path: n.path, status: n.status });

const PLACEMENT_MESSAGES: Record<PlacementProblem, string> = {
  PLACE_AT_TOP: 'A place sits under its branch or under another place of the branch, never at the top.',
  NOT_DEEPER: 'A location sits on a deeper level than its parent: choose a lower level or another parent.',
  GROUP_UNDER_NON_GROUP: 'A group location sits under another group location, or at the top.',
  BRANCH_UNDER_NON_GROUP: 'A branch sits under a group location, or at the top.',
  PLACE_UNDER_GROUP: 'A place sits under a branch or another place, not under a group location.',
  CYCLE: 'A location cannot move under itself or one of the locations below it.',
  PARENT_ARCHIVED: 'The parent location is archived: restore it first or choose another parent.',
};

/** 400 with the problem code (details.problem) when a node of `role` on a level at `levelPosition` cannot sit under `parent`. */
function assertPlacement(args: { role: LocationLevelRole; levelPosition: number; parent: PlacementParent | null; selfId?: string }, levelField: 'parentId' | 'levelId'): void {
  const problem = placementProblem(args);
  if (problem) throw invalid(problem === 'NOT_DEEPER' ? levelField : 'parentId', PLACEMENT_MESSAGES[problem], { problem });
}

/** The highest level (smallest position) among a node's children; null without children. */
async function highestChildLevel(trx: Trx, orgId: string, id: string): Promise<number | null> {
  const r = await trx.selectFrom('locations as c')
    .innerJoin('locationLevels as cl', (j) => j.onRef('cl.id', '=', 'c.levelId').onRef('cl.organizationId', '=', 'c.organizationId'))
    .select((eb) => eb.fn.min('cl.position').as('p'))
    .where('c.organizationId', '=', orgId).where('c.parentId', '=', id)
    .executeTakeFirst();
  return r?.p === null || r?.p === undefined ? null : Number(r.p);
}

/**
 * The codes under `parentId` (null = the top level), `exceptId` left out: the locations' own codes (unique among siblings,
 * case-insensitive — the database key) and the codes of the branches placed there (avoided when a code is derived).
 */
async function siblingCodes(trx: Trx, orgId: string, parentId: string | null, exceptId?: string): Promise<{ own: string[]; branches: string[] }> {
  let q = trx.selectFrom('locations as l')
    .leftJoin('branches as b', (j) => j.onRef('b.id', '=', 'l.branchId').onRef('b.organizationId', '=', 'l.organizationId'))
    .select(['l.role', 'l.code', 'b.code as branchCode'])
    .where('l.organizationId', '=', orgId);
  q = parentId ? q.where('l.parentId', '=', parentId) : q.where('l.parentId', 'is', null);
  if (exceptId) q = q.where('l.id', '<>', exceptId);
  const rows = await q.execute();
  return {
    own: rows.flatMap((r) => (r.role !== 'branch' && r.code ? [String(r.code)] : [])),
    branches: rows.flatMap((r) => (r.role === 'branch' && r.branchCode ? [String(r.branchCode)] : [])),
  };
}

const sameCode = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The cap counts every group and place node of the organisation, also in branches the caller cannot see. */
async function requireRoomForLocation(trx: Trx, orgId: string): Promise<void> {
  const n = await withSystemScope(trx, orgId, async (t) =>
    toCount((await t.selectFrom('locations').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('role', '<>', 'branch').executeTakeFirst())?.n));
  if (n >= LOCATIONS_MAX) throw errors.conflict(`An organisation has at most ${LOCATIONS_MAX.toLocaleString('en-US')} locations.`, { reason: 'LOCATIONS_MAX', max: LOCATIONS_MAX });
}

type PlaceUsage = { devices: number; employees: number; geofences: number; coverageTargets: number; policies: number };

/**
 * What refers to the node or a node below it, organisation-wide (counts only):
 *  - `archive`: what is still active there — terminals not decommissioned, employees not deleted and not terminated /
 *    resigned, active geofences, coverage targets, policies in force today or later (`effective_to` is exclusive);
 *  - `move` (to another branch): every reference the composite keys hold — except decommissioned terminals and deleted
 *    employee records, which let go of the place instead (releaseRetiredReferences).
 */
async function placeUsage(trx: Trx, orgId: string, nodeId: string, rule: 'archive' | 'move'): Promise<PlaceUsage> {
  const archive = rule === 'archive';
  const timezone = archive ? (await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst())?.timezone ?? 'UTC' : 'UTC';
  const today = localDateOf(new Date(), timezone);
  return withSystemScope(trx, orgId, async (t) => {
    const { rows } = await sql<{ devices: string; employees: string; geofences: string; coverage: string; policies: string }>`
      with sub as (select l.id from public.locations l where l.organization_id = ${orgId} and l.path @> array[${nodeId}]::uuid[])
      select
        (select count(*) from public.devices d where d.organization_id = ${orgId} and d.location_id in (select id from sub) and d.status <> 'decommissioned') as devices,
        (select count(*) from public.employees e where e.organization_id = ${orgId} and e.work_location_id in (select id from sub) and e.deleted_at is null
          ${archive ? sql`and e.employment_status not in ('terminated', 'resigned')` : NOTHING}) as employees,
        (select count(*) from public.geofences g where g.organization_id = ${orgId} and g.location_id in (select id from sub) ${archive ? sql`and g.is_active` : NOTHING}) as geofences,
        (select count(*) from public.shift_coverage_requirements c where c.organization_id = ${orgId} and c.location_id in (select id from sub)) as coverage,
        (select count(*) from public.attendance_rule_sets r where r.organization_id = ${orgId} and r.location_id in (select id from sub)
          ${archive ? sql`and (r.effective_to is null or r.effective_to > ${today}::date)` : NOTHING}) as policies`.execute(t);
    const r = rows[0];
    return { devices: toCount(r?.devices), employees: toCount(r?.employees), geofences: toCount(r?.geofences), coverageTargets: toCount(r?.coverage), policies: toCount(r?.policies) };
  });
}

/**
 * Retired rows do not hold a place: a decommissioned terminal or a deleted employee record lets go of a place that moves to
 * another branch (the composite key would refuse the move). Runs as the caller: a row their role cannot update keeps its
 * place, and the move then answers 409.
 */
async function releaseRetiredReferences(trx: Trx, orgId: string, nodeId: string): Promise<{ devices: number; employees: number }> {
  const devices = await trx.updateTable('devices').set({ locationId: null })
    .where('organizationId', '=', orgId).where('status', '=', 'decommissioned').where('locationId', 'in', subtreeQuery(trx, orgId, nodeId)).executeTakeFirst();
  const employees = await trx.updateTable('employees').set({ workLocationId: null })
    .where('organizationId', '=', orgId).where('deletedAt', 'is not', null).where('workLocationId', 'in', subtreeQuery(trx, orgId, nodeId)).executeTakeFirst();
  return { devices: Number(devices.numUpdatedRows), employees: Number(employees.numUpdatedRows) };
}

/** Children that are not archived (a branch child counts while its branch is not archived). */
async function activeChildren(trx: Trx, orgId: string, id: string): Promise<number> {
  const r = await trx.selectFrom('locations as l')
    .leftJoin('branches as b', (j) => j.onRef('b.id', '=', 'l.branchId').onRef('b.organizationId', '=', 'l.organizationId'))
    .select((eb) => eb.fn.countAll().as('n'))
    .where('l.organizationId', '=', orgId).where('l.parentId', '=', id)
    .where((eb) => eb.or([
      eb.and([eb('l.role', '=', 'branch'), eb.or([eb('b.status', 'is', null), eb('b.status', '<>', 'archived')])]),
      eb.and([eb('l.role', '<>', 'branch'), eb('l.status', '<>', 'archived')]),
    ]))
    .executeTakeFirst();
  return toCount(r?.n);
}

const USAGE_LABELS: Record<string, [string, string]> = {
  children: ['active location below it', 'active locations below it'], devices: ['device', 'devices'], employees: ['employee', 'employees'],
  geofences: ['geofence', 'geofences'], coverageTargets: ['coverage target', 'coverage targets'], policies: ['attendance policy', 'attendance policies'],
};
function usageSentence(prefix: string, counts: Record<string, number>): string {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${USAGE_LABELS[k]?.[n === 1 ? 0 : 1] ?? k}`);
  return `${prefix} ${parts.join(', ')}.`;
}

/** Archiving refuses while the node has active children or anything active still refers to it or below it (409 with the counts). */
async function assertArchivable(trx: Trx, orgId: string, node: NodeRow): Promise<void> {
  const counts = { children: await activeChildren(trx, orgId, node.id), ...(await placeUsage(trx, orgId, node.id, 'archive')) };
  if (Object.values(counts).some((n) => n > 0)) {
    throw errors.conflict(usageSentence('The location is still in use:', counts), { reason: 'LOCATION_IN_USE', ...counts });
  }
}

// ----- presenting --------------------------------------------------------------------------------------------------------------

/** Employees counted on the tree: not deleted, not terminated / resigned. Devices: not decommissioned. */
const GONE_EMPLOYMENT = ['terminated', 'resigned'] as const;

/**
 * Direct counts per node of `nodes`: an employee (device) goes to their work location (installation place) when it is one
 * of `nodes`, else to the nearest of `nodes` above it (an archived place left out of the view), else to their branch's node
 * — so a branch node counts the employees / devices of its branch without a place. RLS applies: a caller counts the
 * employees / devices their role may see.
 */
async function directCounts(trx: Trx, orgId: string, all: readonly LocationRow[], nodes: readonly LocationRow[]): Promise<{ employees: Map<string, number>; devices: Map<string, number> }> {
  const out = { employees: new Map<string, number>(), devices: new Map<string, number>() };
  const branchIds = [...new Set(nodes.flatMap((n) => (n.branchId ? [n.branchId] : [])))];
  if (branchIds.length === 0) return out;
  const shown = new Set(nodes.map((n) => n.id));
  const pathOf = new Map(all.map((n) => [n.id, n.path]));
  const branchNodeOf = new Map(nodes.flatMap((n) => (n.role === 'branch' && n.branchId ? [[n.branchId, n.id] as const] : [])));
  const target = (branchId: string, locationId: string | null): string | undefined => {
    const path = locationId ? pathOf.get(locationId) : undefined;
    if (path) {
      for (let i = path.length - 1; i >= 0; i -= 1) if (shown.has(path[i]!)) return path[i];
      return undefined; // a place outside the nodes shown
    }
    return branchNodeOf.get(branchId);
  };
  const add = (map: Map<string, number>, id: string | undefined, n: number) => { if (id) map.set(id, (map.get(id) ?? 0) + n); };
  // one array parameter, however many branches the tree shows
  const inBranches = sql<boolean>`branch_id = any(${branchIds}::uuid[])`;
  const employees = await trx.selectFrom('employees').select(['branchId', 'workLocationId', (eb) => eb.fn.countAll().as('n')])
    .where('organizationId', '=', orgId).where(inBranches).where('deletedAt', 'is', null).where('employmentStatus', 'not in', GONE_EMPLOYMENT)
    .groupBy(['branchId', 'workLocationId']).execute();
  for (const r of employees) add(out.employees, target(r.branchId, r.workLocationId), toCount(r.n));
  const devices = await trx.selectFrom('devices').select(['branchId', 'locationId', (eb) => eb.fn.countAll().as('n')])
    .where('organizationId', '=', orgId).where(inBranches).where('status', '<>', 'decommissioned')
    .groupBy(['branchId', 'locationId']).execute();
  for (const r of devices) add(out.devices, target(r.branchId, r.locationId), toCount(r.n));
  return out;
}

/** `nodes` (a subset of the visible tree `all`, parents before children) as DTOs, counts rolled up over `nodes`. */
async function present(trx: Trx, orgId: string, all: readonly LocationRow[], nodes: readonly LocationRow[]): Promise<LocationDto[]> {
  const direct = await directCounts(trx, orgId, all, nodes);
  const employees = rollUp(nodes, direct.employees);
  const devices = rollUp(nodes, direct.devices);
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, number>();
  for (const n of nodes) if (n.parentId && ids.has(n.parentId)) children.set(n.parentId, (children.get(n.parentId) ?? 0) + 1);
  return nodes.map((n) => toLocationDto(n, { employeeCount: employees.get(n.id) ?? 0, deviceCount: devices.get(n.id) ?? 0, childCount: children.get(n.id) ?? 0 }));
}

/** Without the archived nodes: an archived node hides its subtree (`keepId`, the root of a detail view, always stays). */
function withoutArchived(nodes: readonly LocationRow[], keepId?: string): LocationRow[] {
  const archived = new Set(nodes.filter((n) => n.status === 'archived' && n.id !== keepId).map((n) => n.id));
  return archived.size ? nodes.filter((n) => !n.path.some((id) => archived.has(id))) : [...nodes];
}

/** The node and its subtree as DTOs (archived descendants left out), with the visible tree for breadcrumbs. */
async function presentNode(trx: Trx, orgId: string, id: string): Promise<{ dto: LocationDto; all: LocationRow[] }> {
  const all = await loadLocationTree(trx, orgId, { includeArchived: true });
  const subtree = withoutArchived(all.filter((n) => n.path.includes(id)), id);
  const dto = subtree.length ? (await present(trx, orgId, all, subtree)).find((d) => d.id === id) : undefined;
  if (!dto) throw errors.notFound('Location', id);
  return { dto, all };
}

// ----- locations ---------------------------------------------------------------------------------------------------------------

/** The whole tree the caller may see (flat, parents before children) with counts rolled up over it. */
export async function listLocations(deps: ApiDeps, actor: Actor, orgId: string, q: LocationListQuery): Promise<LocationDto[]> {
  requirePermission(actor.principal, orgId, 'branch.view');
  return runUser(deps.db, actor, async (trx) => {
    const all = await loadLocationTree(trx, orgId, { includeArchived: true });
    return present(trx, orgId, all, q.includeArchived ? all : withoutArchived(all));
  });
}

/** One node and its ancestors (root first); NOT_FOUND when the caller cannot see it. */
export async function getLocation(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<LocationDetailDto> {
  requirePermission(actor.principal, orgId, 'branch.view');
  return runUser(deps.db, actor, async (trx) => {
    const { dto, all } = await presentNode(trx, orgId, id);
    const ancestors = ancestorsOf(all, id).map((a) => ({ id: a.id, levelId: a.levelId, role: a.role, code: a.code, name: a.name, nameAr: a.nameAr }));
    return { ...dto, ancestors };
  });
}

/**
 * A group node (every branch; under a group node or at the top) or a place (the branch in scope; under its branch's node or
 * another place of the branch). Branch nodes come with the branches. The code is derived from the name when it is omitted.
 */
export async function createLocation(deps: ApiDeps, actor: Actor, orgId: string, input: LocationInput): Promise<LocationDto> {
  const grant = requirePermission(actor.principal, orgId, 'branch.manage');
  return runTree(deps, actor, async (trx) => {
    await lockTree(trx, orgId);
    const level = await findLevel(trx, orgId, input.levelId);
    if (!level) throw invalid('levelId', 'Choose a location level of this organisation.', { reason: 'UNKNOWN_LEVEL' });
    if (level.role === 'branch') throw invalid('levelId', 'Branch locations come with the branches: add a branch instead.', { reason: 'BRANCH_LEVEL' });
    if (level.role === 'group') requireEveryBranch(grant, 'can manage group locations');
    const parent = input.parentId ? await requireParent(trx, orgId, input.parentId) : null;
    assertPlacement({ role: level.role, levelPosition: Number(level.position), parent: parent && asParent(parent) }, 'levelId');
    if (level.role === 'place') requireBranchAccess(grant, parent?.branchId);
    await requireRoomForLocation(trx, orgId);
    const siblings = await siblingCodes(trx, orgId, parent?.id ?? null);
    const code = input.code ?? deriveLocationCode(input.name, [...siblings.own, ...siblings.branches]);
    if (input.code !== undefined && siblings.own.some((c) => sameCode(c, code))) throw codeTaken(code);
    const values = {
      levelId: level.id, role: level.role, parentId: parent?.id ?? null, code, name: input.name, nameAr: input.nameAr ?? null,
      latitude: input.latitude ?? null, longitude: input.longitude ?? null,
    };
    // role, branch and path are derived by the shape trigger from the level and the parent
    const row = await trx.insertInto('locations').values({ organizationId: orgId, ...values, path: [], createdBy: actor.userId }).returning(['id', 'branchId']).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'location.created', 'location', { entityId: row.id, branchId: row.branchId, newValue: { ...values, branchId: row.branchId } });
    return (await presentNode(trx, orgId, row.id)).dto;
  });
}

const auditView = (n: NodeRow) => ({
  levelId: n.levelId, parentId: n.parentId, branchId: n.branchId, code: n.code, name: n.name, nameAr: n.nameAr, latitude: n.latitude, longitude: n.longitude, status: n.status,
});

/** Moves a branch's node under a group location (null = the top level): members with every branch only. */
async function moveBranchNode(trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, node: NodeRow, parentId: string | null): Promise<void> {
  requireEveryBranch(grant, 'can place branches in the location tree');
  const parent = parentId ? await requireParent(trx, orgId, parentId) : null;
  assertPlacement({ role: 'branch', levelPosition: node.levelPosition, parent: parent && asParent(parent), selfId: node.id }, 'parentId');
  await trx.updateTable('locations').set({ parentId }).where('organizationId', '=', orgId).where('id', '=', node.id).execute();
  await audit(trx, actor, orgId, 'location.moved', 'location', { entityId: node.id, branchId: node.branchId, oldValue: { parentId: node.parentId }, newValue: { parentId } });
}

/**
 * Places a branch in the location tree (`parentLocationId` of POST / PATCH /branches): under a group location, or at the top
 * (null). Unchanged → nothing to do (and nothing to authorise); a change needs every branch. Runs in the caller's transaction.
 */
export async function placeBranch(trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, branchId: string, parentId: string | null): Promise<void> {
  try {
    await lockTree(trx, orgId);
    const ref = await trx.selectFrom('locations').select('id').where('organizationId', '=', orgId).where('role', '=', 'branch').where('branchId', '=', branchId).executeTakeFirst();
    const node = ref ? await findNode(trx, orgId, ref.id) : undefined;
    if (!node) throw errors.notFound('Branch', branchId);
    if (node.parentId === parentId) return;
    await moveBranchNode(trx, actor, grant, orgId, node, parentId);
  } catch (err) {
    throw mapLocationError(err) ?? err;
  }
}

/**
 * Rename, move (`parentId`), re-level (`levelId`, same kind), set the point, archive / restore (`status`). A branch node only
 * moves: its name, code and status are the branch's. Group nodes and branch moves need every branch; a place needs its branch
 * in scope — and the target branch too when it moves to another branch, which only an unreferenced place can do.
 */
export async function updateLocation(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateLocationInput): Promise<LocationDto> {
  const grant = requirePermission(actor.principal, orgId, 'branch.manage');
  return runTree(deps, actor, async (trx) => {
    await lockTree(trx, orgId);
    const node = await requireNode(trx, orgId, id);
    const moving = input.parentId !== undefined && input.parentId !== node.parentId;

    if (node.role === 'branch') {
      const other = (Object.keys(input) as Array<keyof UpdateLocationInput>).filter((k) => k !== 'parentId' && input[k] !== undefined);
      if (other.length) {
        throw errors.validation('A branch location only moves (parentId): its name, code and status are the branch\'s — edit the branch instead.', {
          reason: 'BRANCH_NODE', issues: other.map((k) => ({ path: k, message: 'Not editable on a branch location' })),
        });
      }
      if (moving) await moveBranchNode(trx, actor, grant, orgId, node, input.parentId ?? null);
      return (await presentNode(trx, orgId, id)).dto;
    }
    if (node.role === 'group') requireEveryBranch(grant, 'can manage group locations');
    else requireBranchAccess(grant, node.branchId);

    // the level after the change: the same kind, below the parent, above the children
    const relevel = input.levelId !== undefined && input.levelId !== node.levelId;
    let levelPosition = node.levelPosition;
    if (relevel) {
      const level = await findLevel(trx, orgId, input.levelId!);
      if (!level) throw invalid('levelId', 'Choose a location level of this organisation.', { reason: 'UNKNOWN_LEVEL' });
      if (level.role !== node.role) throw invalid('levelId', `A ${node.role} location keeps its kind: choose another ${node.role} level.`, { problem: 'KIND_CHANGE' });
      levelPosition = Number(level.position);
      const childLevel = await highestChildLevel(trx, orgId, node.id);
      if (childLevel !== null && childLevel <= levelPosition) throw invalid('levelId', 'A location stays on a higher level than the locations below it.', { problem: 'NOT_ABOVE_CHILDREN' });
    }
    // the parent after the change
    const parent = moving
      ? (input.parentId ? await requireParent(trx, orgId, input.parentId) : null)
      : (node.parentId ? (await findNode(trx, orgId, node.parentId)) ?? null : null);
    if (moving) assertPlacement({ role: node.role, levelPosition, parent: parent && asParent(parent), selfId: node.id }, 'parentId');
    else if (relevel && parent) assertPlacement({ role: node.role, levelPosition, parent: asParent(parent, { ignoreStatus: true }) }, 'levelId');
    if (input.status === 'active' && node.status === 'archived' && parent?.status === 'archived') {
      throw invalid('status', PLACEMENT_MESSAGES.PARENT_ARCHIVED, { problem: 'PARENT_ARCHIVED' });
    }
    if (input.status === 'archived' && node.status !== 'archived') await assertArchivable(trx, orgId, node);

    // the code it ends up with is unique among its (new) siblings
    const code = input.code ?? node.code;
    if (code && (moving || (input.code !== undefined && !sameCode(input.code, node.code ?? '')))) {
      const siblings = await siblingCodes(trx, orgId, moving ? (input.parentId ?? null) : node.parentId, node.id);
      if (siblings.own.some((c) => sameCode(c, code))) throw codeTaken(code);
    }

    // a place moving to another branch: nothing may refer to it or below it (the composite keys hold the branch)
    let released: { devices: number; employees: number } | null = null;
    if (moving && node.role === 'place' && parent && parent.branchId !== node.branchId) {
      requireBranchAccess(grant, parent.branchId);
      const usage = await placeUsage(trx, orgId, node.id, 'move');
      if (Object.values(usage).some((n) => n > 0)) {
        throw errors.conflict(usageSentence('The place, or a place below it, is still in use, so it cannot move to another branch:', usage), { reason: 'PLACE_IN_USE', ...usage });
      }
      released = await releaseRetiredReferences(trx, orgId, node.id);
    }

    const values: Updateable<Locations> = {};
    if (input.levelId !== undefined) values.levelId = input.levelId;
    if (input.parentId !== undefined) values.parentId = input.parentId;
    if (input.code !== undefined) values.code = input.code;
    if (input.name !== undefined) values.name = input.name;
    if (input.nameAr !== undefined) values.nameAr = input.nameAr;
    if (input.latitude !== undefined) values.latitude = input.latitude;
    if (input.longitude !== undefined) values.longitude = input.longitude;
    if (input.status !== undefined) values.status = input.status;
    if (Object.keys(values).length) await trx.updateTable('locations').set(values).where('organizationId', '=', orgId).where('id', '=', id).execute();

    const after = await requireNode(trx, orgId, id);
    const diff = diffObjects(auditView(node), auditView(after));
    if (Object.keys(diff.newValue).length) await audit(trx, actor, orgId, 'location.updated', 'location', { entityId: id, branchId: after.branchId, ...diff });
    if (moving) {
      await audit(trx, actor, orgId, 'location.moved', 'location', {
        entityId: id, branchId: after.branchId,
        oldValue: { parentId: node.parentId, branchId: node.branchId },
        newValue: { parentId: after.parentId, branchId: after.branchId, ...(released && (released.devices || released.employees) ? { releasedRetiredReferences: released } : {}) },
      });
    }
    return (await presentNode(trx, orgId, id)).dto;
  });
}

/** Archives a group or place node (never deleted); a branch node follows its branch. Archiving an archived node is a no-op. */
export async function archiveLocation(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<LocationDto> {
  const grant = requirePermission(actor.principal, orgId, 'branch.manage');
  return runTree(deps, actor, async (trx) => {
    await lockTree(trx, orgId);
    const node = await requireNode(trx, orgId, id);
    if (node.role === 'branch') throw errors.conflict('A branch location follows its branch: archive the branch instead.', { reason: 'BRANCH_NODE' });
    if (node.role === 'group') requireEveryBranch(grant, 'can manage group locations');
    else requireBranchAccess(grant, node.branchId);
    if (node.status !== 'archived') {
      await assertArchivable(trx, orgId, node);
      await trx.updateTable('locations').set({ status: 'archived' }).where('organizationId', '=', orgId).where('id', '=', id).execute();
      await audit(trx, actor, orgId, 'location.archived', 'location', { entityId: id, branchId: node.branchId, oldValue: { status: node.status }, newValue: { status: 'archived' } });
    }
    return (await presentNode(trx, orgId, id)).dto;
  });
}
