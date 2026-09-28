import { sql } from 'kysely';
import {
  NOTES_REPORT_EXPORT_MAX_ROWS,
  type ApprovalRequestStatus, type AttendanceFlag, type AttendanceStatus, type CsvExportFileDto, type NoteImpact, type NotesReportExportQuery, type NotesReportQuery,
  type NotesReportRowDto, type NotesReportTotalsDto,
} from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, isTeamMember, requireMembership } from '../../lib/authorize.js';
import { toCsvDocument } from '../../lib/csv.js';
import { isoDate, isoDateTime, isoDateTimeOrNull, jsonArray, numberOrNull } from '../../lib/mappers.js';
import { likeContains, pageOf, toCount } from '../../lib/pagination.js';
import { consumeHourlyQuota } from '../../lib/quota.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { delegatorsOf } from '../approvals/engine.js';
import { systemStep } from '../features/context.js';
import { dv } from '../features/sql-helpers.js';
import { routedToUser } from '../portal/line-manager.js';
import { excusedCounts, NOTE_COLUMNS, type NoteRow } from '../portal/note-effects.js';

/**
 * Comments & approvals report (HR portal Prompt 6b; Finance ATT-78 / ATT-86 columns): one row per attendance reason with the
 * engine's day, the review outcome, the pay effect and what it cost (paid leave charged or loss of pay), plus the employee's
 * excused count in that year. Scope follows the review queue: `all` = organisation-wide oversight (attendance.view with
 * attendance.review_notes or attendance.approve; branch scope applies), `team` = direct reports, `mine` = direct reports and
 * reasons routed to the caller. Rows are read under the caller's RLS; names and the charged leave are read for those rows in
 * the organisation's system scope. The CSV needs report.export, is formula-escaped, quota-bound and audited with its row count.
 */

const OVERSIGHT_KEYS = ['attendance.review_notes', 'attendance.approve'] as const;
const NIL = '00000000-0000-0000-0000-000000000000';
const NOTES_REPORT_EXPORTS_PER_HOUR = 30;

const hasOversight = (grant: MembershipGrant) => hasPermission(grant, 'attendance.view') && OVERSIGHT_KEYS.some((k) => hasPermission(grant, k));

type Filters = NotesReportExportQuery;

async function scoped(trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, q: Filters) {
  if (q.scope === 'all' && !hasOversight(grant)) throw errors.forbidden('Missing permission: attendance.review_notes (or attendance.approve) with attendance.view.');
  const team = grant.teamEmployeeIds.filter((id) => id !== grant.employeeId);
  let routedIds: string[] = [];
  if (q.scope === 'mine') {
    routedIds = await withSystemScope(trx, orgId, async (t) => [...await routedToUser(t, orgId, 'ATTENDANCE_NOTE', actor.userId, [...await delegatorsOf(t, orgId, 'ATTENDANCE_NOTE', actor.userId)])]);
  }
  let base = trx.selectFrom('attendanceNotes as n')
    .leftJoin('employees as e', 'e.id', 'n.employeeId')
    .leftJoin('attendanceDailyRecords as r', (j) => j.onRef('r.employeeId', '=', 'n.employeeId').onRef('r.attendanceDate', '=', 'n.attendanceDate'))
    .where('n.organizationId', '=', orgId)
    .where('n.attendanceDate', '>=', dv(q.from)).where('n.attendanceDate', '<=', dv(q.to));
  const teamIds = team.length ? team : [NIL];
  if (q.scope === 'team') base = base.where('n.employeeId', 'in', teamIds);
  else if (q.scope === 'mine') base = base.where((eb) => eb.or([eb('n.employeeId', 'in', teamIds), ...(routedIds.length ? [eb('n.approvalRequestId', 'in', routedIds)] : [])]));
  else { const branches = branchFilter(grant); if (branches) base = base.where((eb) => eb.or([eb('n.branchId', 'in', branches), eb('n.employeeId', 'in', teamIds)])); }
  if (q.branchId) { branchFilter(grant, q.branchId); base = base.where('n.branchId', '=', q.branchId); }
  if (q.status) base = base.where('n.status', '=', q.status);
  if (q.category) base = base.where('n.category', '=', q.category);
  if (q.departmentId) base = base.where('e.departmentId', '=', q.departmentId);
  if (q.employeeId) base = base.where('n.employeeId', '=', q.employeeId);
  if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb(sql`e.employee_number::text`, 'ilike', like), eb('n.note', 'ilike', like)])); }
  return base;
}

const N_COLUMNS = NOTE_COLUMNS.map((c) => `n.${c}` as const);
type ReportRow = NoteRow & { dayStatus: string | null; dayFlags: unknown };

function impactOf(r: NoteRow): NoteImpact {
  if (r.status === 'pending' || r.status === 'info_requested') return 'pending';
  if (r.status === 'excused') return 'excused';
  if (r.status === 'rejected') return r.deductedLeaveRecordId ? 'leave' : r.lossOfPay ? 'lop' : 'none';
  return 'none';
}

async function toRows(trx: Trx, grant: MembershipGrant, orgId: string, rows: ReportRow[], routed: ReadonlySet<string>): Promise<NotesReportRowDto[]> {
  if (!rows.length) return [];
  return withSystemScope(trx, orgId, async (t) => {
    const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
    const employees = await t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber', 'departmentId']).where('organizationId', '=', orgId).where('id', 'in', employeeIds).execute();
    const branchIds = [...new Set(rows.map((r) => r.branchId).filter((x): x is string => !!x))];
    const departmentIds = [...new Set(employees.map((e) => e.departmentId).filter((x): x is string => !!x))];
    const userIds = [...new Set(rows.map((r) => r.reviewedBy).filter((x): x is string => !!x))];
    const leaveIds = [...new Set(rows.map((r) => r.deductedLeaveRecordId).filter((x): x is string => !!x))];
    const requestIds = [...new Set(rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x))];
    const [branches, departments, users, leave, requests, stepCounts, excused] = await Promise.all([
      branchIds.length ? t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', branchIds).execute() : Promise.resolve([]),
      departmentIds.length ? t.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', departmentIds).execute() : Promise.resolve([]),
      userIds.length ? t.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', userIds).execute() : Promise.resolve([]),
      leaveIds.length ? t.selectFrom('leaveRecords as l').innerJoin('leaveTypes as lt', 'lt.id', 'l.leaveTypeId').select(['l.id', 'l.days', 'lt.code', 'lt.name']).where('l.organizationId', '=', orgId).where('l.id', 'in', leaveIds).execute() : Promise.resolve([]),
      requestIds.length ? t.selectFrom('approvalRequests').select(['id', 'status', 'currentStep']).where('organizationId', '=', orgId).where('id', 'in', requestIds).execute() : Promise.resolve([]),
      requestIds.length ? t.selectFrom('approvalSteps').select(['requestId', (eb) => eb.fn.countAll<string>().as('n')]).where('requestId', 'in', requestIds).groupBy('requestId').execute() : Promise.resolve([]),
      excusedCounts(t, orgId, rows.map((r) => ({ employeeId: r.employeeId, year: Number(isoDate(r.attendanceDate).slice(0, 4)) }))),
    ]);
    const emp = new Map(employees.map((e) => [e.id, e]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const departmentName = new Map(departments.map((d) => [d.id, d.name]));
    const userName = new Map(users.map((u) => [u.id, u.fullName || u.email]));
    const leaveOf = new Map(leave.map((l) => [l.id, l]));
    const reqOf = new Map(requests.map((r) => [r.id, r]));
    const steps = new Map(stepCounts.map((s) => [s.requestId, toCount(s.n)]));
    return rows.map((r): NotesReportRowDto => {
      const date = isoDate(r.attendanceDate);
      const e = emp.get(r.employeeId);
      const l = r.deductedLeaveRecordId ? leaveOf.get(r.deductedLeaveRecordId) : undefined;
      const req = r.approvalRequestId ? reqOf.get(r.approvalRequestId) : undefined;
      const isRouted = !!r.approvalRequestId && routed.has(r.approvalRequestId);
      return {
        id: r.id, employeeId: r.employeeId, employeeName: e?.displayName ?? '', employeeNumber: e?.employeeNumber ?? '', branchId: r.branchId, branchName: r.branchId ? branchName.get(r.branchId) ?? null : null,
        departmentName: e?.departmentId ? departmentName.get(e.departmentId) ?? null : null, attendanceDate: date,
        dayStatus: (r.dayStatus as AttendanceStatus | null) ?? null, dayFlags: jsonArray<AttendanceFlag>(r.dayFlags),
        category: r.category, note: r.note, status: r.status, approvalStatus: req ? (req.status as ApprovalRequestStatus) : null,
        approvalCurrentStep: req?.currentStep ?? null, approvalStepCount: req ? steps.get(req.id) ?? 0 : null,
        submittedAt: isoDateTime(r.submittedAt), reviewedByName: r.reviewedBy ? userName.get(r.reviewedBy) ?? null : null, reviewedAt: isoDateTimeOrNull(r.reviewedAt),
        reviewVia: r.reviewVia === 'manager' || r.reviewVia === 'oversight' ? r.reviewVia : null, reviewReason: r.reviewReason,
        payEffectDays: numberOrNull(r.payEffectDays), impact: impactOf(r), lossOfPay: r.lossOfPay,
        deductedLeaveTypeCode: l ? String(l.code) : null, deductedLeaveTypeName: l?.name ?? null, deductedLeaveDays: l ? numberOrNull(l.days) : null,
        excusedCountYear: excused.get(`${r.employeeId}|${date.slice(0, 4)}`) ?? 0,
        isOversight: !isRouted && !isTeamMember(grant, r.employeeId),
      };
    });
  });
}

async function routedSet(trx: Trx, actor: Actor, orgId: string, requestIds: readonly (string | null)[]): Promise<Set<string>> {
  const ids = [...new Set(requestIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Set();
  return withSystemScope(trx, orgId, async (t) => routedToUser(t, orgId, 'ATTENDANCE_NOTE', actor.userId, [...await delegatorsOf(t, orgId, 'ATTENDANCE_NOTE', actor.userId)], ids));
}

/** GET /orgs/:orgId/attendance/notes/report — a page of rows + the totals of the whole filtered set. */
export async function notesReport(deps: ApiDeps, actor: Actor, orgId: string, q: NotesReportQuery): Promise<{ data: NotesReportRowDto[]; total: number; totals: NotesReportTotalsDto }> {
  const grant = requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const base = await scoped(trx, actor, grant, orgId, q);
    const agg = await base.select([
      (eb) => eb.fn.countAll<string>().as('total'),
      sql<string>`count(*) filter (where n.status = 'pending')`.as('pending'),
      sql<string>`count(*) filter (where n.status = 'approved')`.as('approved'),
      sql<string>`count(*) filter (where n.status = 'rejected')`.as('rejected'),
      sql<string>`count(*) filter (where n.status = 'excused')`.as('excused'),
      sql<string>`count(*) filter (where n.status = 'info_requested')`.as('infoRequested'),
      sql<string>`coalesce(sum(n.pay_effect_days) filter (where n.status = 'rejected' and n.loss_of_pay), 0)`.as('lopDays'),
      sql<string>`coalesce(sum(n.pay_effect_days) filter (where n.status = 'rejected' and n.deducted_leave_record_id is not null), 0)`.as('leaveDays'),
    ]).executeTakeFirst();
    const totals: NotesReportTotalsDto = {
      total: toCount(agg?.total), pending: toCount(agg?.pending), approved: toCount(agg?.approved), rejected: toCount(agg?.rejected), excused: toCount(agg?.excused),
      infoRequested: toCount(agg?.infoRequested), lopDays: Number(agg?.lopDays ?? 0), leaveDays: Number(agg?.leaveDays ?? 0),
    };
    const page = pageOf(q);
    const rows = (await base.select([...N_COLUMNS, 'r.status as dayStatus', 'r.flags as dayFlags'])
      .orderBy('n.attendanceDate', 'desc').orderBy('e.displayName').orderBy('n.id').limit(page.pageSize).offset(page.offset).execute()) as unknown as ReportRow[];
    const routed = await routedSet(trx, actor, orgId, rows.map((r) => r.approvalRequestId));
    return { data: await toRows(trx, grant, orgId, rows, routed), total: totals.total, totals };
  });
}

const CATEGORY_LABEL = { client_visit: 'Client visit', field_work: 'Field work', late_reason: 'Late arrival', absence_reason: 'Absence', wfh: 'Work from home', other: 'Other' } as const;

/** GET /orgs/:orgId/attendance/notes/report/export — the whole filtered set (bounded) as CSV. */
export async function exportNotesReport(deps: ApiDeps, actor: Actor, orgId: string, q: NotesReportExportQuery): Promise<CsvExportFileDto> {
  const grant = requireMembership(actor.principal, orgId);
  if (!hasPermission(grant, 'report.export')) throw errors.forbidden('Missing permission: report.export.');
  return runUser(deps.db, actor, async (trx) => {
    const base = await scoped(trx, actor, grant, orgId, q);
    const rows = (await base.select([...N_COLUMNS, 'r.status as dayStatus', 'r.flags as dayFlags'])
      .orderBy('n.attendanceDate', 'desc').orderBy('e.displayName').orderBy('n.id').limit(NOTES_REPORT_EXPORT_MAX_ROWS + 1).execute()) as unknown as ReportRow[];
    if (rows.length > NOTES_REPORT_EXPORT_MAX_ROWS) throw errors.validation(`The export is limited to ${NOTES_REPORT_EXPORT_MAX_ROWS} rows; narrow the dates or the branch.`, { rows: rows.length });
    await systemStep(trx, orgId, (t) => consumeHourlyQuota(t, orgId, 'attendance_notes_report_exports', NOTES_REPORT_EXPORTS_PER_HOUR));
    const routed = await routedSet(trx, actor, orgId, rows.map((r) => r.approvalRequestId));
    const data = await toRows(trx, grant, orgId, rows, routed);
    const header = ['Employee No.', 'Employee', 'Branch', 'Department', 'Date', 'Day status', 'Day flags', 'Category', 'Comment', 'Status', 'Approval', 'Level', 'Reviewed by', 'Reviewed at', 'Reviewed as',
      'Review note', 'Pay effect (days)', 'Impact', 'Leave charged', 'Leave days', 'Loss of pay', 'Excused this year', 'Oversight'];
    const csvRows = data.map((r) => [r.employeeNumber, r.employeeName, r.branchName ?? '', r.departmentName ?? '', r.attendanceDate, r.dayStatus ?? '', r.dayFlags.join(' '), CATEGORY_LABEL[r.category], r.note,
      r.status, r.approvalStatus ?? '', r.approvalCurrentStep && r.approvalStepCount ? `${r.approvalCurrentStep}/${r.approvalStepCount}` : '', r.reviewedByName ?? '', r.reviewedAt ?? '', r.reviewVia ?? '',
      r.reviewReason ?? '', r.payEffectDays ?? '', r.impact, r.deductedLeaveTypeName ?? '', r.deductedLeaveDays ?? '', r.lossOfPay ? 'yes' : 'no', r.excusedCountYear, r.isOversight ? 'yes' : 'no']);
    await audit(trx, actor, orgId, 'attendance.notes_report_exported', 'attendance_note', {
      branchId: q.branchId ?? null,
      newValue: { rowCount: rows.length, filters: { scope: q.scope, from: q.from, to: q.to, status: q.status ?? null, category: q.category ?? null, branchId: q.branchId ?? null, departmentId: q.departmentId ?? null, employeeId: q.employeeId ?? null, search: q.search ?? null } },
    });
    return { fileName: `attendance-comments-${q.from}_${q.to}.csv`, contentType: 'text/csv', content: toCsvDocument(header, csvRows), rowCount: rows.length };
  });
}
