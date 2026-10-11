import type { z } from 'zod';
import type { ShiftCoverageDto, ShiftCoverageInput, ShiftCoverageReportDto, shiftCoverageListQuerySchema, shiftCoverageUpdateSchema } from '@flowza/contracts';
import { additionalShiftOn, loadAdditionalShiftAssignments, loadEmployeeWorkingCalendars, locationLabels, resolveLocationFilter, uuidArray, type Trx } from '@flowza/database';
import { placeLabel } from '@flowza/domain';
import { dayOfWeek, eachDate, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, diffObjects, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateOrNull, isoDateTime } from '../../lib/mappers.js';
import { dv } from '../features/sql-helpers.js';
import { attendancePolicy } from '../portal/common.js';

/*
 * Coverage targets for round-the-clock rosters (Enterprise, `shift_coverage_requirements`, docs/enterprise/plan.md §6):
 * a minimum head count per (branch, shift) on given weekdays — for the whole branch, or for a place of it (a site, floor,
 * zone…: only the people working there count, docs/locations.md §2) — and the report that compares them with who is
 * scheduled. Reads need `shift.view`, writes `shift.manage`, both inside the caller's branches (RLS again).
 */

type ListQuery = z.infer<typeof shiftCoverageListQuerySchema>;
type UpdateInput = z.infer<typeof shiftCoverageUpdateSchema>;
type ReportCell = ShiftCoverageReportDto['days'][number]['cells'][number];

type CoverageRow = { id: string; branchId: string; shiftId: string; shiftName: string | null; locationId: string | null; weekdays: number[]; minHeadcount: number; createdAt: Date; updatedAt: Date };
const NO_LABELS: ReadonlyMap<string, string> = new Map();
const toDto = (r: CoverageRow, labels: ReadonlyMap<string, string> = NO_LABELS): ShiftCoverageDto => ({
  id: r.id, branchId: r.branchId, shiftId: r.shiftId, shiftName: r.shiftName, weekdays: [...r.weekdays].map(Number).sort((a, b) => a - b), minHeadcount: Number(r.minHeadcount),
  createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
  locationId: r.locationId, locationName: r.locationId ? labels.get(r.locationId) ?? null : null,
});
const COLUMNS = ['c.id', 'c.branchId', 'c.shiftId', 's.name as shiftName', 'c.locationId', 'c.weekdays', 'c.minHeadcount', 'c.createdAt', 'c.updatedAt'] as const;
const coverageQuery = (trx: Trx, orgId: string) => trx.selectFrom('shiftCoverageRequirements as c').leftJoin('shifts as s', 's.id', 'c.shiftId').where('c.organizationId', '=', orgId);

async function loadCoverage(trx: Trx, orgId: string, id: string): Promise<CoverageRow> {
  const row = await coverageQuery(trx, orgId).select(COLUMNS).where('c.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Coverage target', id);
  return row as CoverageRow;
}

/**
 * DTOs with the label of each target's place ("Site A › Floor 2"). The labels are read in the organisation's system scope: the
 * caller already reads the target itself (RLS: shift.view in its branch) — a member without branch.view still sees where it is.
 */
async function toDtos(trx: Trx, orgId: string, rows: readonly CoverageRow[]): Promise<ShiftCoverageDto[]> {
  const ids = rows.flatMap((r) => (r.locationId ? [r.locationId] : []));
  const labels = ids.length ? await withSystemScope(trx, orgId, (t) => locationLabels(t, orgId, ids)) : NO_LABELS;
  return rows.map((r) => toDto(r, labels));
}

/**
 * GET /shift-coverage — `locationId`: a place → the targets set on it or on a place below it; a group / branch location → the
 * targets of its branches (whole-branch and place targets). The location must be visible to the caller (else 404).
 */
export async function listCoverage(deps: ApiDeps, actor: Actor, orgId: string, q: ListQuery): Promise<ShiftCoverageDto[]> {
  const grant = requirePermission(actor.principal, orgId, 'shift.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = coverageQuery(trx, orgId);
    if (scope) base = base.where('c.branchId', 'in', scope);
    if (q.shiftId) base = base.where('c.shiftId', '=', q.shiftId);
    if (q.locationId) {
      const filter = await resolveLocationFilter(trx, orgId, q.locationId);
      if (filter.kind === 'places') base = base.where('c.locationId', 'in', filter.placeIds);
      else if (filter.branchIds.length > 0) base = base.where('c.branchId', 'in', filter.branchIds);
      else return [];
    }
    // per branch and shift: the whole-branch target first, then the place targets
    const rows = (await base.select(COLUMNS).orderBy('c.branchId').orderBy('s.startTime').orderBy('s.name').orderBy((eb) => eb('c.locationId', 'is not', null)).orderBy('c.id').execute()) as CoverageRow[];
    return toDtos(trx, orgId, rows);
  });
}

/**
 * POST /shift-coverage — `locationId` (optional) is a place of the target's branch, visible to the caller (VALIDATION_ERROR
 * otherwise; the composite key and the place guard of the database say the same). One target per (branch, shift, location):
 * a second one is a 409 (the unique key treats the whole-branch target's null location as a value).
 */
export async function createCoverage(deps: ApiDeps, actor: Actor, orgId: string, input: ShiftCoverageInput): Promise<ShiftCoverageDto> {
  const grant = requirePermission(actor.principal, orgId, 'shift.manage');
  requireBranchAccess(grant, input.branchId);
  const locationId = input.locationId ?? null;
  return runUser(deps.db, actor, async (trx) => {
    const [branch, shift, place] = await Promise.all([
      trx.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', '=', input.branchId).executeTakeFirst(),
      trx.selectFrom('shifts').select('id').where('organizationId', '=', orgId).where('id', '=', input.shiftId).executeTakeFirst(),
      locationId ? trx.selectFrom('locations').select(['id', 'role', 'branchId', 'status']).where('organizationId', '=', orgId).where('id', '=', locationId).executeTakeFirst() : undefined,
    ]);
    if (!branch) throw errors.validation('Branch not found.', { issues: [{ path: 'branchId', message: 'Unknown branch' }] });
    if (!shift) throw errors.validation('Shift not found.', { issues: [{ path: 'shiftId', message: 'Unknown shift' }] });
    if (locationId) {
      if (!place) throw errors.validation('Location not found.', { issues: [{ path: 'locationId', message: 'Unknown location' }] });
      if (place.role !== 'place' || place.branchId !== input.branchId) throw errors.validation('A coverage target applies to the whole branch or to a place (site, floor, zone…) of it.', { issues: [{ path: 'locationId', message: 'Not a place of the branch' }] });
      if (place.status === 'archived') throw errors.validation('The location is archived.', { issues: [{ path: 'locationId', message: 'Archived location' }] });
    }
    const existing = await trx.selectFrom('shiftCoverageRequirements').select('id').where('organizationId', '=', orgId).where('branchId', '=', input.branchId).where('shiftId', '=', input.shiftId)
      .where((eb) => (locationId ? eb('locationId', '=', locationId) : eb('locationId', 'is', null))).executeTakeFirst();
    if (existing) throw errors.conflict(locationId ? 'This shift already has a coverage target for the location: edit it instead.' : 'This shift already has a coverage target on the branch: edit it instead.', { id: existing.id });
    const row = await trx.insertInto('shiftCoverageRequirements').values({ organizationId: orgId, branchId: input.branchId, shiftId: input.shiftId, locationId, weekdays: input.weekdays, minHeadcount: input.minHeadcount, createdBy: actor.userId })
      .returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'shift.coverage_created', 'shift_coverage_requirement', { entityId: row.id, branchId: input.branchId, newValue: input });
    const [dto] = await toDtos(trx, orgId, [await loadCoverage(trx, orgId, row.id)]);
    return dto!;
  });
}

export async function updateCoverage(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateInput): Promise<ShiftCoverageDto> {
  const grant = requirePermission(actor.principal, orgId, 'shift.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadCoverage(trx, orgId, id);
    requireBranchAccess(grant, before.branchId);
    const patch: { weekdays?: number[]; minHeadcount?: number } = {};
    if (input.weekdays !== undefined) patch.weekdays = input.weekdays;
    if (input.minHeadcount !== undefined) patch.minHeadcount = input.minHeadcount;
    if (Object.keys(patch).length) await trx.updateTable('shiftCoverageRequirements').set(patch).where('organizationId', '=', orgId).where('id', '=', id).execute();
    const after = await loadCoverage(trx, orgId, id);
    const diff = diffObjects(toDto(before) as unknown as Record<string, unknown>, { weekdays: toDto(after).weekdays, minHeadcount: after.minHeadcount });
    await audit(trx, actor, orgId, 'shift.coverage_updated', 'shift_coverage_requirement', { entityId: id, branchId: before.branchId, ...diff });
    const [dto] = await toDtos(trx, orgId, [after]);
    return dto!;
  });
}

export async function deleteCoverage(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  const grant = requirePermission(actor.principal, orgId, 'shift.manage');
  await runUser(deps.db, actor, async (trx) => {
    const before = await loadCoverage(trx, orgId, id);
    requireBranchAccess(grant, before.branchId);
    await trx.deleteFrom('shiftCoverageRequirements').where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'shift.coverage_deleted', 'shift_coverage_requirement', { entityId: id, branchId: before.branchId, oldValue: toDto(before) });
  });
}

/** A place target of the report: the places it covers (itself and every place below it) and its label for the ordering. */
interface PlaceTarget { locationId: string; label: string; weekdays: number[]; min: number; places: ReadonlySet<string> }

/** The place targets of the branch per shift, each with its subtree (read in the organisation's system scope, like the people). */
async function placeTargets(t: Trx, orgId: string, branchId: string, requirements: ReadonlyArray<{ shiftId: string; locationId: string | null; weekdays: number[] | null; minHeadcount: number }>): Promise<Map<string, PlaceTarget[]>> {
  const out = new Map<string, PlaceTarget[]>();
  const located = requirements.filter((r) => r.locationId !== null);
  if (located.length === 0) return out;
  const rows = await t.selectFrom('locations').select(['id', 'parentId', 'role', 'name', 'code', 'path']).where('organizationId', '=', orgId).where('branchId', '=', branchId).where('role', '=', 'place').execute();
  const nodes = new Map(rows.map((r) => [r.id, { id: r.id, parentId: r.parentId, role: r.role, name: r.name ?? String(r.code ?? ''), path: uuidArray(r.path) ?? [r.id] }]));
  for (const r of located) {
    const target = r.locationId!;
    const places = new Set([target, ...[...nodes.values()].filter((n) => n.path.includes(target)).map((n) => n.id)]);
    const list = out.get(r.shiftId) ?? [];
    list.push({ locationId: target, label: placeLabel(nodes, target) ?? target, weekdays: (r.weekdays ?? []).map(Number), min: Number(r.minHeadcount), places });
    out.set(r.shiftId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.label.localeCompare(b.label) || a.locationId.localeCompare(b.locationId));
  return out;
}

/**
 * Scheduled head count vs the targets, per day and shift, for one branch over at most 62 days.
 *
 *   scheduled  employees whose per-date placement (employment history) is the branch and whose shift that day — THE per-date
 *              working calendar (assignment / rotation pattern, the organisation's default shift where nothing resolves) — is
 *              the shift, leaving out weekly offs, rotation off days, holidays, approved full-day leave and days outside the
 *              employment (not active on the date, before joining, after the exit); PLUS the employees of the branch with an
 *              additional (double) shift assignment of that shift that day (on a day off too: an extra shift is extra work).
 *              One person counts once per shift and day.
 *   required   the target's minimum when the weekday (0 = Sunday) is listed, else 0.
 *   gap        max(0, required − scheduled).
 *
 * Every shift that has a target on the branch or anyone scheduled there is a column, and each column has its whole-branch
 * cell (no `locationId`: exactly the report of a branch without place targets). A target for a place adds one cell per day
 * after it (`locationId` = the place, ordered by the place's label) whose `scheduled` counts those people whose work location
 * is the place or a place below it. Only counts leave the API: the people behind them are read in the organisation's system
 * scope for a branch the caller was authorised for.
 */
export async function coverageReport(deps: ApiDeps, actor: Actor, orgId: string, q: { branchId: string; from: string; to: string }): Promise<ShiftCoverageReportDto> {
  const grant = requirePermission(actor.principal, orgId, 'shift.view');
  requireBranchAccess(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const branch = await trx.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', '=', q.branchId).executeTakeFirst();
    if (!branch) throw errors.notFound('Branch', q.branchId);
    const requirements = await trx.selectFrom('shiftCoverageRequirements').select(['shiftId', 'locationId', 'weekdays', 'minHeadcount']).where('organizationId', '=', orgId).where('branchId', '=', q.branchId).execute();
    const dates = eachDate(q.from, q.to);
    const { counted, workLocations, targets } = await withSystemScope(trx, orgId, async (t) => ({ ...(await scheduledByDay(t, orgId, q.branchId, q.from, q.to, dates)), targets: await placeTargets(t, orgId, q.branchId, requirements) }));
    const shiftIds = [...new Set([...requirements.map((r) => r.shiftId), ...[...counted.values()].flatMap((m) => [...m.keys()])])];
    const shifts = shiftIds.length
      ? await withSystemScope(trx, orgId, (t) => t.selectFrom('shifts').select(['id', 'code', 'name', 'startTime', 'endTime']).where('organizationId', '=', orgId).where('id', 'in', shiftIds).execute())
      : [];
    const hhmm = (v: string | null) => (v === null ? null : v.slice(0, 5));
    const columns = shifts.map((s) => ({ id: s.id, code: String(s.code), name: s.name, startTime: hhmm(s.startTime), endTime: hhmm(s.endTime) }))
      .sort((a, b) => (a.startTime ?? '99:99').localeCompare(b.startTime ?? '99:99') || a.code.localeCompare(b.code));
    const reqByShift = new Map(requirements.filter((r) => r.locationId === null).map((r) => [r.shiftId, { weekdays: (r.weekdays ?? []).map(Number), min: Number(r.minHeadcount) }]));
    return {
      branchId: q.branchId, from: q.from, to: q.to, shifts: columns,
      days: dates.map((date) => {
        const weekday = dayOfWeek(date);
        return {
          date,
          cells: columns.flatMap((s): ReportCell[] => {
            const req = reqByShift.get(s.id);
            const required = req && req.weekdays.includes(weekday) ? req.min : 0;
            const people = counted.get(date)?.get(s.id);
            const scheduled = people?.size ?? 0;
            const cells: ReportCell[] = [{ shiftId: s.id, required, scheduled, gap: Math.max(0, required - scheduled) }];
            for (const target of targets.get(s.id) ?? []) {
              const placeRequired = target.weekdays.includes(weekday) ? target.min : 0;
              let placeScheduled = 0;
              for (const employeeId of people ?? []) {
                const workLocation = workLocations.get(employeeId);
                if (workLocation && target.places.has(workLocation)) placeScheduled += 1;
              }
              cells.push({ shiftId: s.id, locationId: target.locationId, required: placeRequired, scheduled: placeScheduled, gap: Math.max(0, placeRequired - placeScheduled) });
            }
            return cells;
          }),
        };
      }),
    };
  });
}

/**
 * date → shift id → employees scheduled on it at the branch (see coverageReport), and each candidate's work location (a place
 * of their current branch; current, not effective-dated). System scope.
 */
async function scheduledByDay(t: Trx, orgId: string, branchId: string, from: string, to: string, dates: readonly string[]): Promise<{ counted: Map<string, Map<string, Set<string>>>; workLocations: Map<string, string> }> {
  const out = new Map<string, Map<string, Set<string>>>();
  const workLocations = new Map<string, string>();
  // everyone placed at the branch on some date of the window: its current employees and those whose history puts them there
  const [current, history] = await Promise.all([
    t.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('branchId', '=', branchId).where('deletedAt', 'is', null).execute(),
    t.selectFrom('employmentHistory').select('employeeId').where('organizationId', '=', orgId).where('branchId', '=', branchId)
      .where('effectiveFrom', '<=', dv(to)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(from))])).execute(),
  ]);
  const candidateIds = [...new Set([...current.map((e) => e.id), ...history.map((h) => h.employeeId)])];
  if (candidateIds.length === 0) return { counted: out, workLocations };
  const employees = await t.selectFrom('employees').select(['id', 'joiningDate', 'exitDate', 'workLocationId']).where('organizationId', '=', orgId).where('id', 'in', candidateIds).where('deletedAt', 'is', null).execute();
  for (const e of employees) if (e.workLocationId) workLocations.set(e.id, e.workLocationId);
  const ids = employees.map((e) => e.id);
  if (ids.length === 0) return { counted: out, workLocations };
  const [{ calendars }, settings, leave, additional] = await Promise.all([
    loadEmployeeWorkingCalendars(t, orgId, ids, { from, to }),
    attendancePolicy(t, orgId),
    t.selectFrom('leaveRecords').select(['employeeId', 'startDate', 'endDate']).where('organizationId', '=', orgId).where('employeeId', 'in', ids).where('status', '=', 'APPROVED').where('isHalfDay', '=', false)
      .where('startDate', '<=', dv(to)).where('endDate', '>=', dv(from)).execute(),
    loadAdditionalShiftAssignments(t, orgId, ids, from, to),
  ]);
  const defaultShiftId = settings.defaultShiftId ?? null;
  const leaveByEmployee = new Map<string, Array<{ from: string; to: string }>>();
  for (const l of leave) leaveByEmployee.set(l.employeeId, [...(leaveByEmployee.get(l.employeeId) ?? []), { from: isoDate(l.startDate), to: isoDate(l.endDate) }]);
  const additionalByEmployee = new Map<string, typeof additional>();
  for (const a of additional) additionalByEmployee.set(a.employeeId, [...(additionalByEmployee.get(a.employeeId) ?? []), a]);
  const add = (date: string, shiftId: string, employeeId: string) => {
    const day = out.get(date) ?? new Map<string, Set<string>>();
    const set = day.get(shiftId) ?? new Set<string>();
    set.add(employeeId); day.set(shiftId, set); out.set(date, day);
  };
  for (const e of employees) {
    const cal = calendars.get(e.id);
    if (!cal) continue;
    const joining = isoDate(e.joiningDate);
    const exit = isoDateOrNull(e.exitDate);
    const leaves = leaveByEmployee.get(e.id) ?? [];
    const extras = additionalByEmployee.get(e.id) ?? [];
    for (const date of dates) {
      const day = cal.day(date);
      if (day.placement.branchId !== branchId || day.placement.status !== 'active') continue;
      if (date < joining || (exit !== null && date > exit)) continue;
      if (leaves.some((l) => l.from <= date && date <= l.to)) continue;
      const primary = day.shift.shiftId ?? (day.shift.isPatternOff ? null : defaultShiftId);
      if (primary && !day.off) add(date, primary, e.id);
      const extra = additionalShiftOn(extras, date);
      if (extra) add(date, extra.shiftId, e.id);
    }
  }
  return { counted: out, workLocations };
}
