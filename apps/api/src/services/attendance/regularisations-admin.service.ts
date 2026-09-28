import { sql } from 'kysely';
import { DateTime } from 'luxon';
import {
  REGULARISATION_EXPORT_MAX_ROWS,
  type ApprovalRequestDto, type ApprovalRequestStatus, type CsvExportFileDto, type RegularisationAdminItemDto, type RegularisationAdminQuery, type RegularisationBulkDecideInput,
  type RegularisationBulkResultDto, type RegularisationDecideInput, type RegularisationDecisionResultDto, type RegularisationExportQuery, type RegularisationStatus,
} from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { type AppError, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, requireAnyPermission } from '../../lib/authorize.js';
import { toCsvDocument } from '../../lib/csv.js';
import { isoDate, isoDateTime, isoDateTimeOrNull } from '../../lib/mappers.js';
import { likeContains, pageOf, resolveSort, toCount } from '../../lib/pagination.js';
import { consumeHourlyQuota } from '../../lib/quota.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { hydrateRequests } from '../approvals/dto.js';
import { bulkDecide, decideWithin } from '../approvals/engine.js';
import { systemStep } from '../features/context.js';
import { dv } from '../features/sql-helpers.js';
import { REGULARISATION_COLUMNS, type RegularisationRow } from '../portal/regularisation-effects.js';

/**
 * The HR regularisation register (HR portal Prompt 6b; Finance ATT parity minus its quirk — Finance's page had no per-row
 * decision and its bulk approve bypassed the engine). Rows are read under the caller's RLS: organisation-wide
 * attendance.view (branch scope applies), the team predicate, or one's own. Every decision goes through the approval engine
 * on the request linked to the regularisation (`decideWithin` / `bulkDecide`): the engine decides who may decide which level,
 * and the regularisation hook applies the outcome (corrections on approval). Nothing here writes a regularisation's status.
 */

const ADMIN_KEYS = ['attendance.approve', 'attendance.review_notes'] as const;
const REGULARISATION_EXPORTS_PER_HOUR = 30;

function requireAdmin(actor: Actor, orgId: string): MembershipGrant {
  return requireAnyPermission(actor.principal, orgId, ...ADMIN_KEYS);
}

type Filters = Omit<RegularisationExportQuery, never>;

function filtered(trx: Trx, orgId: string, q: Filters, grant: MembershipGrant) {
  const branches = q.branchId ? branchFilter(grant, q.branchId) : null;
  let base = trx.selectFrom('attendanceRegularisationRequests as g').leftJoin('employees as e', 'e.id', 'g.employeeId').where('g.organizationId', '=', orgId);
  if (q.status) base = base.where('g.status', '=', q.status);
  if (q.type) base = base.where('g.type', '=', q.type);
  if (q.from) base = base.where('g.attendanceDate', '>=', dv(q.from));
  if (q.to) base = base.where('g.attendanceDate', '<=', dv(q.to));
  if (branches) base = base.where('g.branchId', 'in', branches);
  if (q.departmentId) base = base.where('e.departmentId', '=', q.departmentId);
  if (q.employeeId) base = base.where('g.employeeId', '=', q.employeeId);
  if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb(sql`e.employee_number::text`, 'ilike', like)])); }
  return base;
}

const G_COLUMNS = REGULARISATION_COLUMNS.map((c) => `g.${c}` as const);
const SORTS = { attendanceDate: 'g.attendance_date', createdAt: 'g.created_at', employeeName: 'e.display_name', status: 'g.status', type: 'g.type' } as const;

interface Enriched { employees: Map<string, { name: string; number: string; departmentId: string | null }>; branches: Map<string, { name: string; timezone: string | null }>; departments: Map<string, string>; users: Map<string, string>; requests: Map<string, { status: string; currentStep: number; stepCount: number }>; orgTimezone: string }

/** Names / zones / request facts of the listed rows (ids the caller already read under RLS; organisation system scope). */
async function enrich(trx: Trx, orgId: string, rows: readonly RegularisationRow[]): Promise<Enriched> {
  return withSystemScope(trx, orgId, async (t) => {
    const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
    const employees = employeeIds.length ? await t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber', 'departmentId']).where('organizationId', '=', orgId).where('id', 'in', employeeIds).execute() : [];
    const branchIds = [...new Set(rows.map((r) => r.branchId).filter((x): x is string => !!x))];
    const departmentIds = [...new Set(employees.map((e) => e.departmentId).filter((x): x is string => !!x))];
    const requestIds = [...new Set(rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x))];
    const userIds = [...new Set(rows.map((r) => r.decidedBy).filter((x): x is string => !!x))];
    const [org, branches, departments, users, requests, counts] = await Promise.all([
      t.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst(),
      branchIds.length ? t.selectFrom('branches').select(['id', 'name', 'timezone']).where('organizationId', '=', orgId).where('id', 'in', branchIds).execute() : Promise.resolve([]),
      departmentIds.length ? t.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', departmentIds).execute() : Promise.resolve([]),
      userIds.length ? t.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', userIds).execute() : Promise.resolve([]),
      requestIds.length ? t.selectFrom('approvalRequests').select(['id', 'status', 'currentStep']).where('organizationId', '=', orgId).where('id', 'in', requestIds).execute() : Promise.resolve([]),
      requestIds.length ? t.selectFrom('approvalSteps').select(['requestId', (eb) => eb.fn.countAll<string>().as('n')]).where('requestId', 'in', requestIds).groupBy('requestId').execute() : Promise.resolve([]),
    ]);
    const stepCount = new Map(counts.map((c) => [c.requestId, toCount(c.n)]));
    return {
      employees: new Map(employees.map((e) => [e.id, { name: e.displayName, number: e.employeeNumber, departmentId: e.departmentId }])),
      branches: new Map(branches.map((b) => [b.id, { name: b.name, timezone: b.timezone }])),
      departments: new Map(departments.map((d) => [d.id, d.name])),
      users: new Map(users.map((u) => [u.id, u.fullName || u.email])),
      requests: new Map(requests.map((r) => [r.id, { status: r.status, currentStep: r.currentStep, stepCount: stepCount.get(r.id) ?? 0 }])),
      orgTimezone: org?.timezone || 'UTC',
    };
  });
}

function toItem(r: RegularisationRow, x: Enriched, approval: ApprovalRequestDto | undefined): RegularisationAdminItemDto {
  const req = r.approvalRequestId ? x.requests.get(r.approvalRequestId) : undefined;
  const emp = x.employees.get(r.employeeId);
  const current = approval ? approval.steps.find((s) => s.stepNo === approval.currentStep) ?? null : null;
  return {
    id: r.id, employeeId: r.employeeId, attendanceDate: isoDate(r.attendanceDate), type: r.type, proposedInAt: isoDateTimeOrNull(r.proposedInAt), proposedOutAt: isoDateTimeOrNull(r.proposedOutAt), reason: r.reason,
    status: r.status, approvalRequestId: r.approvalRequestId, approvalStatus: req ? (req.status as ApprovalRequestStatus) : null, approvalCurrentStep: req?.currentStep ?? null, approvalStepCount: req ? req.stepCount : null,
    appliedCorrectionId: r.appliedCorrectionId, appliedAt: isoDateTimeOrNull(r.appliedAt), decidedByName: r.decidedBy ? x.users.get(r.decidedBy) ?? null : null, decidedAt: isoDateTimeOrNull(r.decidedAt), decisionNote: r.decisionNote,
    createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
    employeeName: emp?.name ?? '', employeeNumber: emp?.number ?? '', branchId: r.branchId, branchName: r.branchId ? x.branches.get(r.branchId)?.name ?? null : null,
    departmentId: emp?.departmentId ?? null, departmentName: emp?.departmentId ? x.departments.get(emp.departmentId) ?? null : null,
    approval: approval ? {
      requestId: approval.id, status: approval.status, currentStep: approval.status === 'PENDING' ? approval.currentStep : null, stepCount: approval.steps.length,
      approverType: current?.approverType ?? null, approvers: (current?.actors ?? []).map((a) => ({ userId: a.userId, name: a.userName ?? '', decision: a.decision })),
      infoRequested: !!approval.infoRequestedAt, canDecide: approval.abilities.canDecide, decideVia: approval.abilities.decideVia ?? null,
      // engine §9.8 (review P1-1): an override on an ALL / QUORUM level with several seats waiting names the seat it fills
      mustChooseSeat: approval.abilities.mustChooseSeat ?? false, pendingSeats: current?.pendingSeats ?? [],
    } : null,
  };
}

/** The live requests behind the rows, hydrated with the caller's abilities (read under the caller's RLS). */
async function approvalsOf(trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, rows: readonly RegularisationRow[]): Promise<Map<string, ApprovalRequestDto>> {
  const ids = [...new Set(rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const reqRows = await trx.selectFrom('approvalRequests').selectAll().where('organizationId', '=', orgId).where('id', 'in', ids).execute();
  const dtos = await hydrateRequests(trx, actor, grant, orgId, reqRows);
  return new Map(dtos.map((d) => [d.id, d]));
}

/** GET /orgs/:orgId/attendance/regularisations. */
export async function listRegularisations(deps: ApiDeps, actor: Actor, orgId: string, q: RegularisationAdminQuery): Promise<{ data: RegularisationAdminItemDto[]; total: number }> {
  const grant = requireAdmin(actor, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const base = filtered(trx, orgId, q, grant);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    let listQ = base.select(G_COLUMNS);
    if (q.sort) { const s = resolveSort(SORTS, q.sort, q.order, 'g.attendance_date'); listQ = listQ.orderBy(sql.raw(`${s.column} ${s.direction} nulls last`)); }
    // default: the queue first (pending), then the most recent days
    else listQ = listQ.orderBy(sql`(g.status = 'pending')`, 'desc').orderBy('g.attendanceDate', 'desc').orderBy('g.createdAt', 'desc');
    const rows = (await listQ.orderBy('g.id').limit(page.pageSize).offset(page.offset).execute()) as unknown as RegularisationRow[];
    if (!rows.length) return { data: [], total };
    const [x, approvals] = [await enrich(trx, orgId, rows), await approvalsOf(trx, actor, grant, orgId, rows)];
    return { data: rows.map((r) => toItem(r, x, r.approvalRequestId ? approvals.get(r.approvalRequestId) : undefined)), total };
  });
}

// ----- decisions (through the engine) -----------------------------------------------------------------------------------------------

interface Resolved { reg: RegularisationRow; requestId: string | null }

/** The regularisations the caller can read (RLS) and the pending request of each (organisation system scope). */
async function resolve(trx: Trx, orgId: string, ids: readonly string[]): Promise<Map<string, Resolved>> {
  const regs = (await trx.selectFrom('attendanceRegularisationRequests').select(REGULARISATION_COLUMNS).where('organizationId', '=', orgId).where('id', 'in', [...ids]).execute()) as RegularisationRow[];
  if (!regs.length) return new Map();
  const pending = await withSystemScope(trx, orgId, (t) => t.selectFrom('approvalRequests').select(['id', 'entityId']).where('organizationId', '=', orgId).where('entityType', '=', 'REGULARISATION')
    .where('entityId', 'in', regs.map((r) => r.id)).where('status', '=', 'PENDING').execute());
  const reqOf = new Map(pending.map((p) => [p.entityId, p.id]));
  return new Map(regs.map((r) => [r.id, { reg: r, requestId: reqOf.get(r.id) ?? null }]));
}

function refusal(id: string, err: AppError): RegularisationDecisionResultDto {
  return { id, ok: false, status: null, requestStatus: null, advanced: false, code: err.code, message: err.message };
}
function preflight(id: string, found: Resolved | undefined): AppError | null {
  if (!found) return errors.notFound('Regularisation', id);
  if (found.reg.status !== 'pending') return errors.invalidState(`This regularisation was already ${found.reg.status}.`);
  if (!found.requestId) return errors.invalidState('No approval request is waiting for this regularisation.');
  return null;
}

async function statusAfter(deps: ApiDeps, actor: Actor, orgId: string, ids: readonly string[]): Promise<Map<string, RegularisationStatus>> {
  if (!ids.length) return new Map();
  const rows = await runUser(deps.db, actor, (trx) => trx.selectFrom('attendanceRegularisationRequests').select(['id', 'status']).where('organizationId', '=', orgId).where('id', 'in', [...ids]).execute());
  return new Map(rows.map((r) => [r.id, r.status]));
}

/** POST /orgs/:orgId/attendance/regularisations/:id/decide — one decision on the current level of the linked request. */
export async function decideRegularisation(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: RegularisationDecideInput): Promise<RegularisationDecisionResultDto> {
  requireAdmin(actor, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const found = (await resolve(trx, orgId, [id])).get(id);
    const refused = preflight(id, found);
    if (refused) throw refused;
    const outcome = await decideWithin(deps, trx, actor, orgId, found!.requestId!, {
      ...(input.stepNo !== undefined ? { stepNo: input.stepNo } : {}), decision: input.decision === 'approve' ? 'APPROVE' : 'REJECT', comment: input.comment,
      ...(input.onBehalfOfUserId ? { onBehalfOfUserId: input.onBehalfOfUserId } : {}),
      detail: { source: 'regularisation_admin' },
    });
    await audit(trx, actor, orgId, `attendance.regularisation_${input.decision === 'approve' ? 'approved' : 'rejected'}`, 'attendance_regularisation', {
      entityId: id, branchId: found!.reg.branchId, reason: input.comment ?? null, newValue: { requestId: found!.requestId, stepNo: input.stepNo ?? null, onBehalfOfUserId: outcome.onBehalfOfUserId ?? null, requestStatus: outcome.status, noop: outcome.noop },
    });
    const after = await trx.selectFrom('attendanceRegularisationRequests').select('status').where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    return { id, ok: true, status: after?.status ?? null, requestStatus: outcome.status as ApprovalRequestStatus, advanced: outcome.status === 'PENDING' && !outcome.noop };
  });
}

/**
 * POST /orgs/:orgId/attendance/regularisations/bulk-decide — each item is authorised and decided on its own (the engine's
 * bulkDecide: one transaction per request); refusals are reported per item and never stop the others.
 */
export async function bulkDecideRegularisations(deps: ApiDeps, actor: Actor, orgId: string, input: RegularisationBulkDecideInput): Promise<RegularisationBulkResultDto> {
  requireAdmin(actor, orgId);
  const ids = input.items.map((i) => i.id);
  const found = await runUser(deps.db, actor, (trx) => resolve(trx, orgId, ids));
  const results = new Map<string, RegularisationDecisionResultDto>();
  const toDecide: Array<{ id: string; requestId: string; stepNo?: number | undefined; onBehalfOfUserId?: string | undefined }> = [];
  for (const item of input.items) {
    const f = found.get(item.id);
    const refused = preflight(item.id, f);
    if (refused) results.set(item.id, refusal(item.id, refused));
    else toDecide.push({ id: item.id, requestId: f!.requestId!, stepNo: item.stepNo, onBehalfOfUserId: item.onBehalfOfUserId });
  }
  const out = toDecide.length ? await bulkDecide(deps, actor, orgId, { items: toDecide.map((d) => ({ requestId: d.requestId, stepNo: d.stepNo, ...(d.onBehalfOfUserId ? { onBehalfOfUserId: d.onBehalfOfUserId } : {}) })), decision: input.decision === 'approve' ? 'APPROVE' : 'REJECT', comment: input.comment }) : { results: [] };
  const byRequest = new Map(out.results.map((r) => [r.requestId, r]));
  const after = await statusAfter(deps, actor, orgId, toDecide.map((d) => d.id));
  for (const d of toDecide) {
    const r = byRequest.get(d.requestId);
    if (!r) { results.set(d.id, { id: d.id, ok: false, status: null, requestStatus: null, advanced: false, code: 'INVALID_STATE', message: 'Not decided.' }); continue; }
    results.set(d.id, r.ok
      ? { id: d.id, ok: true, status: after.get(d.id) ?? null, requestStatus: r.status, advanced: r.status === 'PENDING' && !r.noop }
      : { id: d.id, ok: false, status: after.get(d.id) ?? null, requestStatus: null, advanced: false, code: r.code ?? 'INVALID_STATE', message: r.message ?? 'Not decided.' });
  }
  const ordered = input.items.map((i) => results.get(i.id)!);
  const succeeded = ordered.filter((r) => r.ok).length;
  await runUser(deps.db, actor, (trx) => audit(trx, actor, orgId, 'attendance.regularisations_bulk_decided', 'attendance_regularisation', {
    reason: input.comment ?? null, newValue: { decision: input.decision, count: ordered.length, succeeded, failed: ordered.length - succeeded, ids: ordered.map((r) => ({ id: r.id, ok: r.ok, code: r.code ?? null })) },
  }));
  return { results: ordered, succeeded, failed: ordered.length - succeeded };
}

// ----- export ----------------------------------------------------------------------------------------------------------------------

const TYPE_LABEL = { missed_punch: 'Missed punch', wrong_punch: 'Wrong punch', wfh_unmarked: 'Work from home not marked', system_downtime: 'System downtime' } as const;

/** GET /orgs/:orgId/attendance/regularisations/export — report.export; formula-escaped CSV; audited with its row count. */
export async function exportRegularisations(deps: ApiDeps, actor: Actor, orgId: string, q: RegularisationExportQuery): Promise<CsvExportFileDto> {
  const grant = requireAdmin(actor, orgId);
  if (!hasPermission(grant, 'report.export')) throw errors.forbidden('Missing permission: report.export.');
  return runUser(deps.db, actor, async (trx) => {
    const rows = (await filtered(trx, orgId, q, grant).select(G_COLUMNS).orderBy('g.attendanceDate', 'desc').orderBy('g.createdAt', 'desc').orderBy('g.id')
      .limit(REGULARISATION_EXPORT_MAX_ROWS + 1).execute()) as unknown as RegularisationRow[];
    if (rows.length > REGULARISATION_EXPORT_MAX_ROWS) throw errors.validation(`The export is limited to ${REGULARISATION_EXPORT_MAX_ROWS} rows; narrow the dates or the branch.`, { rows: rows.length });
    await systemStep(trx, orgId, (t) => consumeHourlyQuota(t, orgId, 'regularisation_exports', REGULARISATION_EXPORTS_PER_HOUR));
    const x = await enrich(trx, orgId, rows);
    const approvals = await approvalsOf(trx, actor, grant, orgId, rows);
    const local = (at: Date | null, branchId: string | null) => {
      if (!at) return '';
      const tz = (branchId ? x.branches.get(branchId)?.timezone : null) || x.orgTimezone;
      const dt = DateTime.fromJSDate(at).setZone(tz);
      return (dt.isValid ? dt : DateTime.fromJSDate(at).toUTC()).toFormat('yyyy-MM-dd HH:mm');
    };
    const header = ['Employee No.', 'Employee', 'Branch', 'Department', 'Date', 'Type', 'Proposed in', 'Proposed out', 'Reason', 'Status', 'Approval', 'Level', 'Approvers', 'Decided by', 'Decided at', 'Decision note', 'Correction', 'Submitted at'];
    const data = rows.map((r) => {
      const item = toItem(r, x, r.approvalRequestId ? approvals.get(r.approvalRequestId) : undefined);
      const level = item.approval?.currentStep ? `${item.approval.currentStep}/${item.approval.stepCount}` : item.approvalStepCount ? `${item.approvalStepCount}/${item.approvalStepCount}` : '';
      return [item.employeeNumber, item.employeeName, item.branchName ?? '', item.departmentName ?? '', item.attendanceDate, TYPE_LABEL[r.type], local(r.proposedInAt, r.branchId), local(r.proposedOutAt, r.branchId), r.reason,
        r.status, item.approvalStatus ?? '', level, (item.approval?.approvers ?? []).map((a) => a.name).join('; '), item.decidedByName ?? '', item.decidedAt ?? '', r.decisionNote ?? '', r.appliedCorrectionId ?? '', item.createdAt];
    });
    await audit(trx, actor, orgId, 'attendance.regularisations_exported', 'attendance_regularisation', {
      branchId: q.branchId ?? null, newValue: { rowCount: rows.length, filters: { status: q.status ?? null, type: q.type ?? null, from: q.from ?? null, to: q.to ?? null, branchId: q.branchId ?? null, departmentId: q.departmentId ?? null, employeeId: q.employeeId ?? null, search: q.search ?? null } },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return { fileName: `regularisations-${stamp}.csv`, contentType: 'text/csv', content: toCsvDocument(header, data), rowCount: rows.length };
  });
}
