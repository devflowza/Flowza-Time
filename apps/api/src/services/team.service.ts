import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type {
  AttendanceFlag, AttendanceStatus, Permission, TeamAttendanceQuery, TeamAttendanceRowDto, TeamLeaveDto, TeamLeaveOverviewDto, TeamLeaveQuery, TeamMemberLeaveDto,
  TeamMemberTodayDto, TeamPendingCountsDto, TeamRelation, TeamSummaryDto, TeamSummaryQuery,
} from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { livePunchState, teamDayStatus, teamTotals, workedSoFarMinutes, type MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { hasPermission, isTeamMember, requireBranchAccess, requireMembership } from '../lib/authorize.js';
import { type Actor, runUser, withSystemScope } from '../lib/service.js';
import { isoDate, isoDateTimeOrNull, jsonArray } from '../lib/mappers.js';
import { toCount } from '../lib/pagination.js';
import { orgToday } from './features/recalc.js';
import { dv } from './features/sql-helpers.js';
import { DAILY_RECORD_COLUMNS, toDailyRecordDto, type DailyRecordRow } from './features/mappers.js';

/**
 * The line manager's team workspace (HR portal Prompt 5, Finance B-61 … B-66).
 *
 * Scope = the caller's direct reports (primary or secondary manager — `grant.teamEmployeeIds`, the rule of
 * `app.team_employee_ids()`) AND the key the RLS team predicate of the table requires: attendance.view_team /
 * leave.view_team, or the organisation-wide attendance.view / leave.view (branch scope applies to those). A crafted
 * employee id that is not a report is refused (403) before any read; everything is then read under the caller's RLS
 * (`runUser`), which applies the team predicate again row by row. Only reference data the rows already point at (branch
 * zone and names, department / designation names, the organisation's date) is read in the organisation's system scope.
 */

type TeamArea = 'attendance' | 'leave';
const AREA_KEYS: Record<TeamArea, { team: Permission; org: Permission }> = {
  attendance: { team: 'attendance.view_team', org: 'attendance.view' },
  leave: { team: 'leave.view_team', org: 'leave.view' },
};
const NIL = '00000000-0000-0000-0000-000000000000';
const OPEN_LEAVE = ['APPROVED', 'PENDING', 'INFO_REQUESTED'] as const;

interface TeamScope { grant: MembershipGrant; teamKey: boolean; orgKey: boolean; ids: string[] }

/** The caller's reports for one area; FORBIDDEN without the area's team or organisation-wide key. */
function teamScope(actor: Actor, orgId: string, area: TeamArea): TeamScope {
  const grant = requireMembership(actor.principal, orgId);
  const keys = AREA_KEYS[area];
  const teamKey = hasPermission(grant, keys.team);
  const orgKey = hasPermission(grant, keys.org);
  if (!teamKey && !orgKey) throw errors.forbidden(`Missing permission: ${keys.team} (or ${keys.org}).`);
  return { grant, teamKey, orgKey, ids: grant.teamEmployeeIds.filter((id) => id !== grant.employeeId) };
}

/** A crafted id that is not one of the caller's direct reports never reaches a query. */
function requireReport(scope: TeamScope, employeeId: string): void {
  if (!isTeamMember(scope.grant, employeeId) || employeeId === scope.grant.employeeId) throw errors.forbidden('This employee is not one of your direct reports.');
}

interface ReportRow { id: string; employeeNumber: string; displayName: string; branchId: string; departmentId: string | null; designationId: string | null; managerEmployeeId: string | null }

/**
 * The reports the caller may read in this area, under RLS: the team key reaches every report (the team predicate carries
 * no branch scope); the organisation-wide key alone reaches only reports inside the caller's branches.
 */
async function reachableReports(trx: Trx, orgId: string, scope: TeamScope, ids: readonly string[]): Promise<ReportRow[]> {
  if (ids.length === 0) return [];
  const rows = await trx.selectFrom('employees').select(['id', 'employeeNumber', 'displayName', 'branchId', 'departmentId', 'designationId', 'managerEmployeeId'])
    .where('organizationId', '=', orgId).where('id', 'in', [...ids]).where('deletedAt', 'is', null)
    .orderBy('displayName').orderBy('id').execute();
  return rows.filter((e) => scope.teamKey || scope.grant.allBranches || scope.grant.branchIds.includes(e.branchId));
}

const relationOf = (scope: TeamScope, e: Pick<ReportRow, 'managerEmployeeId'>): TeamRelation => (e.managerEmployeeId === scope.grant.employeeId ? 'primary' : 'secondary');

interface StructureNames { branch: Map<string, { name: string; timezone: string | null }>; department: Map<string, string>; designation: Map<string, string>; orgTimezone: string }

/** Names and zones of the branches / departments / designations the (already authorised) reports point at. */
async function structureNames(trx: Trx, orgId: string, reports: readonly ReportRow[]): Promise<StructureNames> {
  return withSystemScope(trx, orgId, async (t) => {
    const branchIds = [...new Set(reports.map((r) => r.branchId))];
    const departmentIds = [...new Set(reports.map((r) => r.departmentId).filter((x): x is string => !!x))];
    const designationIds = [...new Set(reports.map((r) => r.designationId).filter((x): x is string => !!x))];
    const [org, branches, departments, designations] = await Promise.all([
      t.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst(),
      branchIds.length ? t.selectFrom('branches').select(['id', 'name', 'timezone']).where('organizationId', '=', orgId).where('id', 'in', branchIds).execute() : Promise.resolve([]),
      departmentIds.length ? t.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', departmentIds).execute() : Promise.resolve([]),
      designationIds.length ? t.selectFrom('designations').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', designationIds).execute() : Promise.resolve([]),
    ]);
    return {
      branch: new Map(branches.map((b) => [b.id, { name: b.name, timezone: b.timezone }])),
      department: new Map(departments.map((d) => [d.id, d.name])),
      designation: new Map(designations.map((d) => [d.id, d.name])),
      orgTimezone: org?.timezone || 'UTC',
    };
  });
}

const zoneOk = (tz: string | null | undefined): tz is string => !!tz && DateTime.local().setZone(tz).isValid;

// ----- pending items (the badge halves) ---------------------------------------------------------------------------------------

type ActionableRow = { id: string; employeeId: string | null; entityType: string };

/** The requests waiting for the caller on their current level — the engine's ONE definition (`/me.approvals.actionable`). */
async function actionableRequests(trx: Trx, orgId: string): Promise<ActionableRow[]> {
  return trx.selectFrom('approvalRequests as r').select(['r.id', 'r.employeeId', 'r.entityType'])
    .where('r.organizationId', '=', orgId).where('r.id', 'in', sql<string>`(select app.approval_actionable_request_ids(${orgId}::uuid))`).execute();
}
async function actionableCount(trx: Trx, orgId: string): Promise<number> {
  const r = await sql<{ n: string }>`select count(*)::text as n from app.approval_actionable_request_ids(${orgId}::uuid)`.execute(trx);
  return toCount(r.rows[0]?.n);
}

/** Run one half of the badge on its own; a failure reads as the fallback with a logged warning (Finance B-63). */
export async function halfOrZero<T>(deps: ApiDeps, actor: Actor, orgId: string, half: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    deps.log.warn({ event: 'team_pending_count_failed', half, requestId: actor.requestId, organizationId: orgId, err: (err as Error).message });
    return fallback;
  }
}

/**
 * The notes half: attendance reasons the caller may review as a mapped line manager that the approvals half does not count.
 *   (a) pending reasons of the direct reports with no live approval request — the line manager decides those directly
 *       (notes.service reviewNote, role `manager`);
 *   (b) pending reasons whose CURRENT level seats the caller as the secondary manager standing in for the primary
 *       (resolution path `secondary`, line-manager.ts) — minus any the engine's actionable set already lists, so a future
 *       engine that counts those seats cannot make one item count twice.
 * Read under the caller's RLS (their team key reveals the reasons and requests of their reports). Independent of the
 * approvals half: when the de-duplicating read of the actionable set fails, the approvals half — the same function — reads
 * 0 as well, so nothing is counted twice then either.
 */
async function notesHalf(deps: ApiDeps, actor: Actor, orgId: string, grant: MembershipGrant): Promise<Map<string, number>> {
  const team = grant.teamEmployeeIds.filter((id) => id !== grant.employeeId);
  const { direct, standIn } = await runUser(deps.db, actor, async (trx) => ({
    direct: team.length ? await trx.selectFrom('attendanceNotes as n')
      .select(['n.employeeId', (eb) => eb.fn.countAll<string>().as('n')])
      .where('n.organizationId', '=', orgId).where('n.employeeId', 'in', team).where('n.status', '=', 'pending')
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('approvalRequests as r').select('r.id')
        .where('r.organizationId', '=', orgId).where('r.entityType', '=', 'ATTENDANCE_NOTE').whereRef('r.entityId', '=', 'n.id').where('r.status', '=', 'PENDING'))))
      .groupBy('n.employeeId').execute() : [],
    standIn: await trx.selectFrom('approvalRequests as r')
      .innerJoin('approvalSteps as s', (j) => j.onRef('s.requestId', '=', 'r.id').onRef('s.stepNo', '=', 'r.currentStep'))
      .innerJoin('approvalStepActors as a', 'a.stepId', 's.id')
      .innerJoin('attendanceNotes as n', (j) => j.onRef('n.id', '=', 'r.entityId').on('n.status', '=', 'pending'))
      .select(['r.id', 'r.employeeId']).distinct()
      .where('r.organizationId', '=', orgId).where('r.entityType', '=', 'ATTENDANCE_NOTE').where('r.status', '=', 'PENDING').where('s.status', '=', 'PENDING')
      .where('a.userId', '=', actor.userId).where('a.decision', '=', 'PENDING').where('a.resolutionPath', '=', 'secondary').where('a.viaDelegationOf', 'is not', null)
      .where('n.employeeId', '!=', grant.employeeId ?? NIL)
      .execute(),
  }));
  const out = new Map<string, number>();
  for (const r of direct) out.set(r.employeeId, (out.get(r.employeeId) ?? 0) + toCount(r.n));
  if (standIn.length) {
    const counted = await halfOrZero(deps, actor, orgId, 'notes.dedupe', new Set<string>(), () => runUser(deps.db, actor, async (trx) => new Set((await actionableRequests(trx, orgId)).map((r) => r.id))));
    for (const r of standIn) if (!counted.has(r.id)) { const key = r.employeeId ?? NIL; out.set(key, (out.get(key) ?? 0) + 1); }
  }
  return out;
}

const sum = (m: ReadonlyMap<string, number>) => [...m.values()].reduce((a, n) => a + n, 0);

/** GET /orgs/:orgId/team/pending-counts — { approvals, notes, total } (any active member; each half independent). */
export async function pendingCounts(deps: ApiDeps, actor: Actor, orgId: string): Promise<TeamPendingCountsDto> {
  const grant = requireMembership(actor.principal, orgId);
  const [approvals, notes] = await Promise.all([
    halfOrZero(deps, actor, orgId, 'approvals', 0, () => runUser(deps.db, actor, (trx) => actionableCount(trx, orgId))),
    halfOrZero(deps, actor, orgId, 'notes', 0, async () => sum(await notesHalf(deps, actor, orgId, grant))),
  ]);
  return { approvals, notes, total: approvals + notes };
}

/** Per report: approval requests on the caller's level + reasons the caller may review (each half guarded on its own). */
async function pendingByEmployee(deps: ApiDeps, actor: Actor, orgId: string, grant: MembershipGrant): Promise<{ byEmployee: Map<string, number>; leave: Map<string, number> }> {
  const [actionable, notes] = await Promise.all([
    halfOrZero(deps, actor, orgId, 'approvals', [] as ActionableRow[], () => runUser(deps.db, actor, (trx) => actionableRequests(trx, orgId))),
    halfOrZero(deps, actor, orgId, 'notes', new Map<string, number>(), () => notesHalf(deps, actor, orgId, grant)),
  ]);
  const byEmployee = new Map(notes);
  const leave = new Map<string, number>();
  for (const r of actionable) {
    if (!r.employeeId) continue;
    byEmployee.set(r.employeeId, (byEmployee.get(r.employeeId) ?? 0) + 1);
    if (r.entityType === 'LEAVE') leave.set(r.employeeId, (leave.get(r.employeeId) ?? 0) + 1);
  }
  return { byEmployee, leave };
}

// ----- today --------------------------------------------------------------------------------------------------------------------

/** GET /orgs/:orgId/team/summary — every reachable report's day (default: each report's own today) + the totals row. */
export async function summary(deps: ApiDeps, actor: Actor, orgId: string, q: TeamSummaryQuery): Promise<TeamSummaryDto> {
  const scope = teamScope(actor, orgId, 'attendance');
  const now = new Date();
  const board = await runUser(deps.db, actor, async (trx): Promise<TeamSummaryDto> => {
    const today = q.date ?? await withSystemScope(trx, orgId, (t) => orgToday(t, orgId));
    const reports = await reachableReports(trx, orgId, scope, scope.ids);
    if (reports.length === 0) return { date: today, generatedAt: now.toISOString(), members: [], totals: teamTotals([]) };
    const names = await structureNames(trx, orgId, reports);
    const ids = reports.map((r) => r.id);
    const zoneOf = (r: ReportRow) => { const tz = names.branch.get(r.branchId)?.timezone; return zoneOk(tz) ? tz : zoneOk(names.orgTimezone) ? names.orgTimezone : 'UTC'; };
    const dayOf = new Map(reports.map((r) => [r.id, q.date ?? (DateTime.fromJSDate(now).setZone(zoneOf(r)).toISODate() ?? today)]));
    const windowOf = (r: ReportRow) => { const start = DateTime.fromISO(dayOf.get(r.id)!, { zone: zoneOf(r) }).startOf('day'); return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() }; };
    const windows = new Map(reports.map((r) => [r.id, windowOf(r)]));
    const dates = [...new Set(dayOf.values())];
    const minStart = new Date(Math.min(...[...windows.values()].map((w) => w.start.getTime())));
    const maxEnd = new Date(Math.max(...[...windows.values()].map((w) => w.end.getTime())));

    const [records, events, leaves] = await Promise.all([
      trx.selectFrom('attendanceDailyRecords').select(['id', 'employeeId', 'attendanceDate', 'status', 'flags', 'firstInAt', 'lastOutAt', 'workedMinutes', 'lateMinutes'])
        .where('organizationId', '=', orgId).where('employeeId', 'in', ids).where(sql<boolean>`attendance_date = any(${sql.val(dates)}::date[])`).execute(),
      trx.selectFrom('attendanceEvents').select(['employeeId', 'eventType', 'punchedAt'])
        .where('organizationId', '=', orgId).where('employeeId', 'in', ids).where('voidedAt', 'is', null)
        .where('punchedAt', '>=', minStart).where('punchedAt', '<', maxEnd).orderBy('punchedAt').execute(),
      trx.selectFrom('leaveRecords as l').leftJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
        .select(['l.employeeId', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.halfDayPart', 't.name as leaveTypeName', 't.code as leaveTypeCode', 't.color'])
        .where('l.organizationId', '=', orgId).where('l.employeeId', 'in', ids).where('l.status', '=', 'APPROVED')
        .where('l.startDate', '<=', dv(dates.reduce((a, b) => (a > b ? a : b)))).where('l.endDate', '>=', dv(dates.reduce((a, b) => (a < b ? a : b))))
        .execute(),
    ]);

    const members: TeamMemberTodayDto[] = reports.map((e) => {
      const date = dayOf.get(e.id)!;
      const w = windows.get(e.id)!;
      const record = records.find((r) => r.employeeId === e.id && isoDate(r.attendanceDate) === date) ?? null;
      const punches = events.filter((ev) => ev.employeeId === e.id && ev.punchedAt >= w.start && ev.punchedAt < w.end);
      const leaveRow = leaves.find((l) => l.employeeId === e.id && isoDate(l.startDate) <= date && isoDate(l.endDate) >= date) ?? null;
      const flags = record ? jsonArray<string>(record.flags) : [];
      const status = teamDayStatus({
        record: record ? { status: record.status as AttendanceStatus, flags, firstInAt: isoDateTimeOrNull(record.firstInAt), workedMinutes: record.workedMinutes } : null,
        onLeave: !!leaveRow, hasPunch: punches.length > 0,
      });
      const liveState = livePunchState(punches.map((p) => ({ eventType: p.eventType, punchedAt: p.punchedAt })));
      const engineWorked = record && record.status !== 'PENDING' ? record.workedMinutes : null;
      const live = liveState === 'IN' || engineWorked === null;
      const worked = live ? workedSoFarMinutes(punches.map((p) => ({ eventType: p.eventType, punchedAt: p.punchedAt })), now) : engineWorked;
      const leave: TeamMemberLeaveDto | null = leaveRow ? { leaveTypeName: leaveRow.leaveTypeName ?? '', leaveTypeCode: leaveRow.leaveTypeCode === null ? '' : String(leaveRow.leaveTypeCode), color: leaveRow.color ?? null, isHalfDay: leaveRow.isHalfDay, halfDayPart: leaveRow.halfDayPart, status: 'APPROVED' } : null;
      const last = punches.at(-1);
      return {
        employeeId: e.id, employeeNumber: e.employeeNumber, employeeName: e.displayName,
        designationName: e.designationId ? names.designation.get(e.designationId) ?? null : null, departmentName: e.departmentId ? names.department.get(e.departmentId) ?? null : null,
        branchId: e.branchId, branchName: names.branch.get(e.branchId)?.name ?? null, relation: relationOf(scope, e), date, timezone: zoneOf(e),
        status, recordStatus: record ? (record.status as AttendanceStatus) : null, recordId: record?.id ?? null, flags: flags as AttendanceFlag[],
        firstInAt: isoDateTimeOrNull(record?.firstInAt) ?? (punches[0] ? punches[0].punchedAt.toISOString() : null), lastOutAt: isoDateTimeOrNull(record?.lastOutAt),
        liveState, lastPunchAt: last ? last.punchedAt.toISOString() : null, workedMinutes: worked, workedIsLive: live && punches.length > 0, lateMinutes: record?.lateMinutes ?? 0,
        leave, pendingItems: 0,
      };
    });
    return { date: today, generatedAt: now.toISOString(), members, totals: teamTotals(members) };
  });
  if (board.members.length === 0) return board;
  const pending = await pendingByEmployee(deps, actor, orgId, scope.grant);
  const members = board.members.map((m) => ({ ...m, pendingItems: pending.byEmployee.get(m.employeeId) ?? 0 }));
  return { ...board, members, totals: teamTotals(members) };
}

// ----- attendance ---------------------------------------------------------------------------------------------------------------

/** GET /orgs/:orgId/team/attendance — daily records of the reports over [from, to], paginated by report. */
export async function attendance(deps: ApiDeps, actor: Actor, orgId: string, q: TeamAttendanceQuery): Promise<{ data: TeamAttendanceRowDto[]; total: number }> {
  const scope = teamScope(actor, orgId, 'attendance');
  if (q.employeeId) requireReport(scope, q.employeeId);
  const ids = q.employeeId ? [q.employeeId] : scope.ids;
  if (ids.length === 0) return { data: [], total: 0 };
  return runUser(deps.db, actor, async (trx) => {
    if (q.employeeId) await requireReadableReport(trx, orgId, scope, q.employeeId);
    const reports = await reachableReports(trx, orgId, scope, ids);
    const page = reports.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    if (page.length === 0) return { data: [], total: reports.length };
    const rows = (await trx.selectFrom('attendanceDailyRecords as r').innerJoin('employees as e', 'e.id', 'r.employeeId').leftJoin('branches as b', 'b.id', 'r.branchId')
      .leftJoin('departments as dp', 'dp.id', 'r.departmentId').leftJoin('shifts as s', 's.id', 'r.shiftId')
      .select([...DAILY_RECORD_COLUMNS])
      .where('r.organizationId', '=', orgId).where('r.employeeId', 'in', page.map((p) => p.id))
      .where('r.attendanceDate', '>=', dv(q.from)).where('r.attendanceDate', '<=', dv(q.to))
      .orderBy('r.attendanceDate', 'asc').orderBy('r.id').execute()) as DailyRecordRow[];
    const byEmployee = new Map<string, DailyRecordRow[]>();
    for (const r of rows) { const list = byEmployee.get(r.employeeId) ?? []; list.push(r); byEmployee.set(r.employeeId, list); }
    return {
      total: reports.length,
      data: page.map((e) => ({
        employeeId: e.id, employeeNumber: e.employeeNumber, employeeName: e.displayName, branchId: e.branchId, departmentId: e.departmentId, relation: relationOf(scope, e),
        records: (byEmployee.get(e.id) ?? []).map((r) => toDailyRecordDto(r)),
      })),
    };
  });
}

/** A named report must be readable too: hidden by RLS → 404; outside the branch scope of an organisation-wide key → 403. */
async function requireReadableReport(trx: Trx, orgId: string, scope: TeamScope, employeeId: string): Promise<void> {
  const row = await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', '=', employeeId).where('deletedAt', 'is', null).executeTakeFirst();
  if (!row) throw errors.notFound('Employee', employeeId);
  if (!scope.teamKey) requireBranchAccess(scope.grant, row.branchId);
}

// ----- leave --------------------------------------------------------------------------------------------------------------------

/** GET /orgs/:orgId/team/leave — the month calendar entries, the upcoming card (≤ 20) and the leave requests awaiting me. */
export async function leave(deps: ApiDeps, actor: Actor, orgId: string, q: TeamLeaveQuery): Promise<TeamLeaveOverviewDto> {
  const scope = teamScope(actor, orgId, 'leave');
  const result = await runUser(deps.db, actor, async (trx): Promise<TeamLeaveOverviewDto & { ids?: string[] }> => {
    const today = await withSystemScope(trx, orgId, (t) => orgToday(t, orgId));
    const empty: TeamLeaveOverviewDto = { from: q.from, to: q.to, today, entries: [], upcoming: [], pendingForMe: 0 };
    const reports = await reachableReports(trx, orgId, scope, scope.ids);
    if (reports.length === 0) return empty;
    const ids = reports.map((r) => r.id);
    const byId = new Map(reports.map((r) => [r.id, r]));
    const base = () => trx.selectFrom('leaveRecords as l').leftJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
      .select(['l.id', 'l.employeeId', 'l.leaveTypeId', 't.name as leaveTypeName', 't.code as leaveTypeCode', 't.color', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.halfDayPart', 'l.days', 'l.status'])
      .where('l.organizationId', '=', orgId).where('l.employeeId', 'in', ids).where('l.status', 'in', [...OPEN_LEAVE]);
    const [entries, upcoming] = await Promise.all([
      base().where('l.startDate', '<=', dv(q.to)).where('l.endDate', '>=', dv(q.from)).orderBy('l.startDate').orderBy('l.id').limit(1000).execute(),
      base().where('l.endDate', '>=', dv(today)).orderBy('l.startDate').orderBy('l.id').limit(20).execute(),
    ]);
    const toDto = (r: (typeof entries)[number]): TeamLeaveDto => ({
      id: r.id, employeeId: r.employeeId, employeeName: byId.get(r.employeeId)?.displayName ?? '', employeeNumber: byId.get(r.employeeId)?.employeeNumber ?? '',
      leaveTypeId: r.leaveTypeId, leaveTypeName: r.leaveTypeName ?? '', leaveTypeCode: r.leaveTypeCode === null ? '' : String(r.leaveTypeCode), color: r.color ?? null,
      startDate: isoDate(r.startDate), endDate: isoDate(r.endDate), isHalfDay: r.isHalfDay, halfDayPart: r.halfDayPart, days: r.days === null ? null : Number(r.days), status: r.status,
    });
    return { ...empty, entries: entries.map(toDto), upcoming: upcoming.map(toDto), pendingForMe: 0, ids };
  });
  const { ids, ...overview } = result;
  if (!ids || ids.length === 0) return overview;
  // leave requests of the team on the caller's level — the engine's actionable set, read on its own (0 on failure)
  const actionable = await halfOrZero(deps, actor, orgId, 'approvals', [] as ActionableRow[], () => runUser(deps.db, actor, (trx) => actionableRequests(trx, orgId)));
  const team = new Set(ids);
  return { ...overview, pendingForMe: actionable.filter((r) => r.entityType === 'LEAVE' && r.employeeId && team.has(r.employeeId)).length };
}
