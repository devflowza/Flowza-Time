import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { MUSTER_STATES, SELF_SERVICE_PROVIDER_KEY, type LocationMusterDto, type LocationMusterEntryDto, type MusterState, type MusterTotals } from '@flowza/contracts';
import { locationLabels, uuidArray, type Trx } from '@flowza/database';
import { addDays, errors, isValidTimezone } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, runUser, withSystemScope } from '../../lib/service.js';
import { isoDateTime } from '../../lib/mappers.js';
import { dv } from '../features/sql-helpers.js';

/*
 * The muster list of a location (Enterprise, module advanced_scheduling — docs/locations.md §4): who was last seen there on a
 * day, for a roll call. An employee is listed when their LATEST non-voided attendance event of the day (the branch's local
 * date) was punched on a terminal placed in the location's subtree:
 *   - a place (site, floor, zone…): the terminals whose location is the place or a place below it;
 *   - a group or branch node: every terminal of the branches below it, at its place — or at the branch when it has none.
 * The state comes from that event: PUNCH_IN / BREAK_END = on site, BREAK_START = on break, PUNCH_OUT = left, PUNCH = seen.
 * Portal punches (web / mobile / selfie: the organisation's virtual self-service device) carry no terminal and are not
 * attributed; neither are corrections without a device. Someone whose latest event is on a terminal elsewhere (another zone,
 * another branch) is listed there, not here.
 *
 * Reads: `attendance.view`. The location, its subtree and the events are read under the caller's RLS (branch.view for the
 * tree; attendance.view in the branch scope for the events; employee.view for the names, as on the attendance list) and the
 * branches are intersected with the caller's scope. The terminals (their place and name) are read in the organisation's
 * system scope for those branches only — like the device names of the attendance timeline, so a member without device.view
 * still gets the roll call. The employees of the branches are found through the (organization_id, branch_id, punched_at)
 * index; employees deployed to one of the branches that day (their events carry their home branch) through
 * (organization_id, employee_id, punched_at).
 */

const STATE_OF: Readonly<Record<string, MusterState>> = { PUNCH_IN: 'on_site', BREAK_END: 'on_site', BREAK_START: 'on_break', PUNCH_OUT: 'left', PUNCH: 'seen' };
const STATE_ORDER = new Map<MusterState, number>(MUSTER_STATES.map((s, i) => [s, i]));
const zeroTotals = (): MusterTotals => ({ on_site: 0, on_break: 0, left: 0, seen: 0 });

/** The calendar day `date` in `zone` as a UTC half-open window (Luxon: DST days are 23 or 25 hours long). */
function dayWindow(date: string, zone: string): { from: Date; to: Date } {
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  return { from: start.toJSDate(), to: start.plus({ days: 1 }).toJSDate() };
}
const validZone = (tz: string | null | undefined): string | null => (tz && isValidTimezone(tz) ? tz : null);

/** One part of the events query: the events of some branches (or of some employees) inside one day window. */
interface EventClause { branchIds?: string[]; employeeIds?: string[]; from: Date; to: Date }
/** A terminal of the subtree: where it is installed (a place, or only its branch). */
interface Terminal { id: string; name: string; branchId: string; locationId: string | null; status: string }

/** Each employee's latest non-voided event over the clauses, with their number and name (caller's RLS). */
async function latestEvents(trx: Trx, orgId: string, clauses: readonly EventClause[]) {
  if (clauses.length === 0) return [];
  const from = new Date(Math.min(...clauses.map((c) => c.from.getTime())));
  const to = new Date(Math.max(...clauses.map((c) => c.to.getTime())));
  return trx.selectFrom('attendanceEvents as ev')
    .innerJoin('employees as e', (j) => j.onRef('e.id', '=', 'ev.employeeId').onRef('e.organizationId', '=', 'ev.organizationId'))
    .distinctOn('ev.employeeId')
    .select(['ev.employeeId', 'ev.branchId', 'ev.deviceId', 'ev.eventType', 'ev.punchedAt', 'e.employeeNumber', 'e.displayName'])
    .where('ev.organizationId', '=', orgId).where('ev.voidedAt', 'is', null)
    // the overall bounds let the planner prune the monthly partitions; each clause has its own window
    .where('ev.punchedAt', '>=', from).where('ev.punchedAt', '<', to)
    .where((eb) => eb.or(clauses.map((c) => eb.and([
      c.branchIds ? eb('ev.branchId', 'in', c.branchIds) : eb('ev.employeeId', 'in', c.employeeIds ?? []),
      eb('ev.punchedAt', '>=', c.from), eb('ev.punchedAt', '<', c.to),
    ]))))
    .orderBy('ev.employeeId').orderBy('ev.punchedAt', 'desc').orderBy('ev.id', 'desc')
    .execute();
}

/** Group ids by the window of their zone (one events clause per distinct day window). */
function byWindow(items: ReadonlyArray<{ id: string; zone: string }>, date: string): Array<{ ids: string[]; from: Date; to: Date }> {
  const groups = new Map<string, string[]>();
  for (const it of items) groups.set(it.zone, [...(groups.get(it.zone) ?? []), it.id]);
  return [...groups].map(([zone, ids]) => ({ ids: [...new Set(ids)], ...dayWindow(date, zone) }));
}

/** GET /locations/:id/muster?date= */
export async function locationMuster(deps: ApiDeps, actor: Actor, orgId: string, locationId: string, q: { date?: string }): Promise<LocationMusterDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  // the query schema checks the shape (YYYY-MM-DD); the calendar checks the day exists
  if (q.date !== undefined && !DateTime.fromISO(q.date, { zone: 'utc' }).isValid) throw errors.validation('date is not a calendar date.', { issues: [{ path: 'date', message: 'Invalid date' }] });
  return runUser(deps.db, actor, async (trx) => {
    // 1. the location and everything below it that the caller may see (group nodes, the nodes of their branches)
    const nodes = await trx.selectFrom('locations as l')
      .leftJoin('branches as b', (j) => j.onRef('b.id', '=', 'l.branchId').onRef('b.organizationId', '=', 'l.organizationId'))
      .select(['l.id', 'l.parentId', 'l.role', 'l.branchId', 'l.code', 'l.name', 'l.nameAr', 'l.status', 'l.path', 'b.code as branchCode', 'b.name as branchName', 'b.nameAr as branchNameAr', 'b.status as branchStatus', 'b.timezone as branchTimezone'])
      .where('l.organizationId', '=', orgId).where(sql<boolean>`l.path @> array[${locationId}]::uuid[]`)
      .execute();
    const node = nodes.find((n) => n.id === locationId);
    if (!node) throw errors.notFound('Location', locationId);
    requireBranchAccess(grant, node.branchId);
    const inScope = (branchId: string | null): branchId is string => branchId !== null && (grant.allBranches || grant.branchIds.includes(branchId));
    const branchNodes = nodes.filter((n) => n.role === 'branch' && inScope(n.branchId));
    const branchIds = node.role === 'group' ? [...new Set(branchNodes.map((n) => n.branchId!))] : [node.branchId!];
    const zoneOfBranch = new Map(nodes.flatMap((n) => (n.branchId && validZone(n.branchTimezone) ? [[n.branchId, validZone(n.branchTimezone)!] as const] : [])));

    // 2. the day: the date asked for, else today in the branch's time zone (a group node: the organisation's)
    const orgZone = validZone((await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst())?.timezone) ?? 'UTC';
    const zoneOf = (branchId: string) => zoneOfBranch.get(branchId) ?? orgZone;
    const date = q.date ?? DateTime.now().setZone(node.role === 'group' ? orgZone : zoneOf(node.branchId!)).toISODate()!;

    // 3. the terminals of the subtree (system scope, those branches only) and the employees deployed there that day
    const placeIds = node.role === 'place' ? nodes.filter((n) => n.role === 'place').map((n) => n.id) : null;
    let devices: Terminal[] = [];
    let deployed: Array<{ employeeId: string; branchId: string }> = [];
    if (branchIds.length > 0) {
      [devices, deployed] = await withSystemScope(trx, orgId, (t) => {
        let terminals = t.selectFrom('devices').select(['id', 'name', 'branchId', 'locationId', 'status'])
          .where('organizationId', '=', orgId).where('providerKey', '!=', SELF_SERVICE_PROVIDER_KEY).where('branchId', 'in', branchIds);
        if (placeIds) terminals = terminals.where('locationId', 'in', placeIds);
        // a deployment's window runs on into the morning after its last day (docs/enterprise/plan.md §4.7): that day counts too
        const deployments = t.selectFrom('employeeBranchDeployments').select(['employeeId', 'branchId'])
          .where('organizationId', '=', orgId).where('branchId', 'in', branchIds).where('cancelledAt', 'is', null)
          .where('fromDate', '<=', dv(date)).where('toDate', '>=', dv(addDays(date, -1)));
        return Promise.all([terminals.execute(), deployments.execute()]);
      });
    }

    // 4. each employee's latest event of the day: the employees of the branches, and those deployed to them
    const clauses: EventClause[] = [
      ...byWindow(branchIds.map((id) => ({ id, zone: zoneOf(id) })), date).map((w) => ({ branchIds: w.ids, from: w.from, to: w.to })),
      ...byWindow(deployed.map((d) => ({ id: d.employeeId, zone: zoneOf(d.branchId) })), date).map((w) => ({ employeeIds: w.ids, from: w.from, to: w.to })),
    ];
    const latest = devices.length === 0 ? [] : await latestEvents(trx, orgId, clauses);

    // 5. attribute: listed when that event was punched on one of the terminals; at the terminal's place, else at its branch
    const deviceById = new Map(devices.map((d) => [d.id, d]));
    const branchNodeOf = new Map(branchNodes.map((n) => [n.branchId!, n]));
    const labels = await locationLabels(trx, orgId, devices.map((d) => d.locationId));
    const pathOf = new Map(nodes.map((n) => [n.id, uuidArray(n.path) ?? [n.id]]));
    const entries: LocationMusterEntryDto[] = [];
    for (const ev of latest) {
      const device = ev.deviceId ? deviceById.get(ev.deviceId) : undefined;
      const state = STATE_OF[ev.eventType];
      if (!device || !state) continue;
      const branchNode = branchNodeOf.get(device.branchId);
      const at = device.locationId ?? branchNode?.id;
      if (!at) continue;
      entries.push({
        employeeId: ev.employeeId, employeeNumber: String(ev.employeeNumber), displayName: ev.displayName, branchId: ev.branchId,
        state, eventType: ev.eventType, punchedAt: isoDateTime(ev.punchedAt), deviceId: device.id, deviceName: device.name,
        locationId: at, locationName: device.locationId ? labels.get(device.locationId) ?? '' : branchNode?.branchName ?? String(branchNode?.branchCode ?? ''),
      });
    }
    entries.sort((a, b) => (STATE_ORDER.get(a.state)! - STATE_ORDER.get(b.state)!) || a.displayName.localeCompare(b.displayName) || a.employeeNumber.localeCompare(b.employeeNumber) || a.employeeId.localeCompare(b.employeeId));

    // 6. the totals, and the same per direct child (an entry counts for the child its place / branch sits under)
    const totals = zeroTotals();
    for (const e of entries) totals[e.state] += 1;
    const children = nodes.filter((n) => n.parentId === locationId && (n.role !== 'branch' || inScope(n.branchId))).map((n) => {
      const childTotals = zeroTotals();
      for (const e of entries) if (pathOf.get(e.locationId)?.includes(n.id)) childTotals[e.state] += 1;
      const branchNode = n.role === 'branch';
      const archived = (branchNode ? n.branchStatus ?? 'archived' : n.status) === 'archived';
      return { locationId: n.id, name: (branchNode ? n.branchName ?? n.branchCode : n.name ?? n.code) ?? '', nameAr: (branchNode ? n.branchNameAr : n.nameAr) ?? null, totals: childTotals, archived };
    })
      // an archived child is shown only while someone is attributed to it
      .filter((c) => !c.archived || Object.values(c.totals).some((n) => n > 0))
      .map(({ archived: _archived, ...c }) => c)
      .sort((a, b) => a.name.localeCompare(b.name) || a.locationId.localeCompare(b.locationId));

    return { locationId, date, totals, children, entries, deviceCount: devices.filter((d) => d.status !== 'decommissioned').length };
  });
}
