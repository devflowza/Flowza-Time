import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { CreateReportRequest, ReportRequestDto } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import { AppError, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runUser } from '../../lib/service.js';
import { enqueueJob } from '../../lib/jobs.js';
import { likeContains, pageOf, toCount } from '../../lib/pagination.js';
import { loadSettings } from '../../lib/settings.js';
import { isoDate, isoDateTime, isoDateTimeOrNull, jsonObject, numberOrNull } from '../../lib/mappers.js';
import { REPORT_TYPE_DEFINITIONS, type PayrollPeriodActionInput, type PayrollPeriodDto, type ReportTypeDefinition } from '../../routes/v1/features/dto.js';
import { cancelQueueJob, systemStep } from './context.js';
import { REPORT_COLUMNS, toReportDto, type ReportRow } from './mappers.js';

export const REPORTS_PER_HOUR = 20;

export function listReportTypes(actor: Actor, orgId: string | undefined): (ReportTypeDefinition & { allowed: boolean | null })[] {
  const grant = orgId ? actor.principal.memberships.find((m) => m.organizationId === orgId) : undefined;
  return REPORT_TYPE_DEFINITIONS.map((d) => ({ ...d, allowed: grant ? d.permissions.every((p) => hasPermission(grant, p)) : null }));
}

/** Sliding hourly quota per organisation (usage_quotas, system-owned rows) → RATE_LIMITED above REPORTS_PER_HOUR. */
async function consumeQuota(trx: Trx, orgId: string, metric: string, windowSeconds: number, limit: number): Promise<number> {
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const res = await sql<{ count: number }>`
    insert into public.usage_quotas (organization_id, metric, window_start, window_seconds, count) values (${orgId}::uuid, ${metric}, ${windowStart}, ${windowSeconds}, 1)
    on conflict (organization_id, metric, window_start) do update set count = public.usage_quotas.count + 1 returning count`.execute(trx);
  const count = res.rows[0]?.count ?? 1;
  if (count > limit) throw new AppError('RATE_LIMITED', `At most ${limit} ${metric} per hour per organisation.`, { details: { metric, limit }, retryAfterMs: windowStart.getTime() + windowSeconds * 1000 - Date.now() });
  return count;
}

function reportQuery(trx: Trx, orgId: string) { return trx.selectFrom('reportRequests as r').leftJoin('userProfiles as u', 'u.id', 'r.requestedBy').where('r.organizationId', '=', orgId); }

export async function createReport(deps: ApiDeps, actor: Actor, orgId: string, input: CreateReportRequest): Promise<ReportRequestDto & { jobId: string | null; status: 'QUEUED' }> {
  const grant = requirePermission(actor.principal, orgId, 'report.view');
  const def = REPORT_TYPE_DEFINITIONS.find((d) => d.key === input.reportType);
  if (!def) throw errors.validation('Unknown report type.');
  for (const p of def.permissions) if (!hasPermission(grant, p)) throw errors.forbidden(`Missing permission: ${p}.`);
  if (!def.formats.includes(input.format)) throw errors.validation(`Format ${input.format} is not available for ${def.key}.`, { formats: def.formats });
  const missing = def.requiredParameters.filter((p) => (input.parameters as Record<string, unknown>)[p] === undefined);
  if (missing.length) throw errors.validation('Missing report parameters.', { issues: missing.map((m) => ({ path: `parameters.${m}`, message: 'Required' })) });
  if (input.parameters.from && input.parameters.to && input.parameters.to < input.parameters.from) throw errors.validation('to must be on/after from.');
  requireBranchAccess(grant, input.parameters.branchId);
  const parameters: Record<string, unknown> = { ...input.parameters };
  let branchId: string | null = input.parameters.branchId ?? null;
  if (!grant.allBranches) {
    // branch scope is injected server-side so a restricted caller can never widen the report
    if (!branchId) { if (grant.branchIds.length === 1) branchId = grant.branchIds[0]!; else parameters.branchIds = grant.branchIds; }
    parameters.branchScope = grant.branchIds;
  }
  if (branchId) parameters.branchId = branchId;
  return runUser(deps.db, actor, async (trx) => {
    const settings = await loadSettings(trx, orgId);
    if (settings.security.exportRequiresReason && !input.reason) throw errors.validation('This organisation requires a reason for exports.', { issues: [{ path: 'reason', message: 'Required' }] });
    if (parameters.employeeIds && Array.isArray(parameters.employeeIds) && parameters.employeeIds.length) {
      const emps = await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', 'in', parameters.employeeIds as string[]).execute();
      for (const e of emps) requireBranchAccess(grant, e.branchId);
    }
    await systemStep(trx, orgId, (t) => consumeQuota(t, orgId, 'reports', 3600, REPORTS_PER_HOUR));
    const row = await trx.insertInto('reportRequests').values({ organizationId: orgId, reportType: input.reportType, format: input.format, parameters: JSON.stringify(parameters), status: 'QUEUED', requestedBy: actor.userId, branchId }).returning('id').executeTakeFirstOrThrow();
    const jobId = await enqueueJob(deps.queue, trx, { queue: 'reports', jobType: 'GENERATE_REPORT', organizationId: orgId, payload: { organizationId: orgId, reportRequestId: row.id }, correlationId: actor.requestId, priority: 5 });
    await trx.updateTable('reportRequests').set({ queueJobId: jobId }).where('id', '=', row.id).execute();
    await audit(trx, actor, orgId, 'report.requested', 'report_request', { entityId: row.id, branchId, newValue: { reportType: input.reportType, format: input.format, parameters }, reason: input.reason ?? null });
    const saved = (await reportQuery(trx, orgId).select(REPORT_COLUMNS).where('r.id', '=', row.id).executeTakeFirstOrThrow()) as ReportRow;
    return { ...toReportDto(saved), jobId, status: 'QUEUED' as const };
  });
}

export async function listReports(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; status?: string; reportType?: string }) {
  const grant = requirePermission(actor.principal, orgId, 'report.view');
  return runUser(deps.db, actor, async (trx) => {
    let base = reportQuery(trx, orgId);
    if (!hasPermission(grant, 'report.manage')) base = base.where('r.requestedBy', '=', actor.userId);
    if (q.status) base = base.where('r.status', '=', q.status as never);
    if (q.reportType) base = base.where('r.reportType', '=', q.reportType);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(REPORT_COLUMNS).orderBy('r.createdAt', 'desc').limit(page.pageSize).offset(page.offset).execute()) as ReportRow[];
    return { data: rows.map(toReportDto), total };
  });
}
async function loadReport(trx: Trx, actor: Actor, orgId: string, id: string, canManage: boolean): Promise<ReportRow> {
  const row = (await reportQuery(trx, orgId).select(REPORT_COLUMNS).where('r.id', '=', id).executeTakeFirst()) as ReportRow | undefined;
  if (!row || (!canManage && row.requestedBy !== actor.userId)) throw errors.notFound('Report request', id);
  return row;
}
export async function getReport(deps: ApiDeps, actor: Actor, orgId: string, id: string) {
  const grant = requirePermission(actor.principal, orgId, 'report.view');
  return runUser(deps.db, actor, async (trx) => toReportDto(await loadReport(trx, actor, orgId, id, hasPermission(grant, 'report.manage'))));
}
export async function downloadReport(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<{ url: string; expiresInSeconds: number; fileName: string }> {
  const grant = requirePermission(actor.principal, orgId, 'report.view');
  return runUser(deps.db, actor, async (trx) => {
    const r = await loadReport(trx, actor, orgId, id, hasPermission(grant, 'report.manage'));
    if (r.status !== 'COMPLETED' || !r.filePath) throw errors.invalidState(`The report is ${r.status}; only completed reports can be downloaded.`);
    if (r.expiresAt && r.expiresAt < new Date()) throw errors.invalidState('The report file has expired; request it again.');
    const url = await deps.storage.signedUrl('reports', r.filePath, 300);
    if (!url) throw errors.dependency('Report storage');
    await audit(trx, actor, orgId, 'report.exported', 'report_request', { entityId: id, branchId: r.branchId, newValue: { reportType: r.reportType, format: r.format, rowCount: r.rowCount } });
    return { url, expiresInSeconds: 300, fileName: `${r.reportType}-${isoDate(r.createdAt)}.${r.format}` };
  });
}
export async function cancelReport(deps: ApiDeps, actor: Actor, orgId: string, id: string) {
  const grant = requirePermission(actor.principal, orgId, 'report.view');
  return runUser(deps.db, actor, async (trx) => {
    const r = await loadReport(trx, actor, orgId, id, hasPermission(grant, 'report.manage'));
    if (r.status !== 'QUEUED') throw errors.invalidState(`Only queued reports can be cancelled (current: ${r.status}).`);
    if (r.queueJobId !== null) await cancelQueueJob(trx, String(r.queueJobId));
    await trx.updateTable('reportRequests').set({ status: 'CANCELLED', completedAt: new Date() }).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'report.cancelled', 'report_request', { entityId: id, branchId: r.branchId });
    return toReportDto(await loadReport(trx, actor, orgId, id, true));
  });
}

// ----- payroll ---------------------------------------------------------------------------------------------------------------

/** Periods of a year from the organisation's payroll settings: calendar months or custom cut-off (D+1 of previous month → D). */
export function payrollPeriodsFor(year: number, mode: 'calendar_month' | 'custom_cutoff', cutoffDay: number): { periodStart: string; periodEnd: string; label: string }[] {
  const out: { periodStart: string; periodEnd: string; label: string }[] = [];
  for (let m = 1; m <= 12; m += 1) {
    const month = DateTime.utc(year, m, 1);
    if (mode === 'calendar_month') out.push({ periodStart: month.toISODate()!, periodEnd: month.endOf('month').toISODate()!, label: month.toFormat('LLLL yyyy') });
    else { const end = month.set({ day: Math.min(cutoffDay, month.daysInMonth ?? 28) }); const start = end.minus({ months: 1 }).plus({ days: 1 }); out.push({ periodStart: start.toISODate()!, periodEnd: end.toISODate()!, label: month.toFormat('LLLL yyyy') }); }
  }
  return out;
}

export async function listPayrollPeriods(deps: ApiDeps, actor: Actor, orgId: string, q: { year?: number; branchId?: string }): Promise<PayrollPeriodDto[]> {
  const grant = requirePermission(actor.principal, orgId, 'payroll.view');
  requireBranchAccess(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const settings = await loadSettings(trx, orgId);
    const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst();
    const today = DateTime.now().setZone(org?.timezone ?? 'UTC').toISODate()!;
    const year = q.year ?? Number(today.slice(0, 4));
    const periods = payrollPeriodsFor(year, settings.attendance.payrollPeriod ?? 'calendar_month', settings.attendance.payrollCutoffDay ?? 25);
    const locks = await trx.selectFrom('attendancePeriodLocks').selectAll().where('organizationId', '=', orgId).where('unlockedAt', 'is', null).where('periodEnd', '>=', periods[0]!.periodStart).where('periodStart', '<=', periods[periods.length - 1]!.periodEnd).execute();
    let sq = trx.selectFrom('attendancePeriodSummaries').select(['periodStart', 'periodEnd', 'status', (eb) => eb.fn.countAll().as('n')]).where('organizationId', '=', orgId).where('periodEnd', '>=', periods[0]!.periodStart).where('periodStart', '<=', periods[periods.length - 1]!.periodEnd);
    if (q.branchId) sq = sq.where('branchId', '=', q.branchId);
    const summaries = await sq.groupBy(['periodStart', 'periodEnd', 'status']).execute();
    return periods.map((p) => {
      const lock = locks.find((l) => isoDate(l.periodStart) <= p.periodStart && isoDate(l.periodEnd) >= p.periodEnd && (l.branchId === null || l.branchId === (q.branchId ?? l.branchId)));
      const rows = summaries.filter((s) => isoDate(s.periodStart) === p.periodStart && isoDate(s.periodEnd) === p.periodEnd);
      const draft = rows.filter((r) => r.status === 'draft').reduce((a, r) => a + toCount(r.n), 0); const finalized = rows.filter((r) => r.status === 'finalized').reduce((a, r) => a + toCount(r.n), 0);
      return { ...p, locked: !!lock, lockId: lock?.id ?? null, lockedAt: lock ? isoDateTime(lock.lockedAt) : null, summaries: { total: draft + finalized, draft, finalized, employees: draft + finalized }, isCurrent: p.periodStart <= today && today <= p.periodEnd };
    });
  });
}

async function periodLocked(trx: Trx, orgId: string, branchId: string | null, start: string, end: string): Promise<boolean> {
  const lock = await trx.selectFrom('attendancePeriodLocks').select('id').where('organizationId', '=', orgId).where('unlockedAt', 'is', null).where('periodStart', '<=', start).where('periodEnd', '>=', end).where((eb) => branchId ? eb.or([eb('branchId', 'is', null), eb('branchId', '=', branchId)]) : eb('branchId', 'is', null)).executeTakeFirst();
  return !!lock;
}

export async function buildPeriod(deps: ApiDeps, actor: Actor, orgId: string, input: PayrollPeriodActionInput, finalize: boolean) {
  const grant = requirePermission(actor.principal, orgId, finalize ? 'payroll.finalize' : 'payroll.view');
  requireBranchAccess(grant, input.branchId);
  if (!grant.allBranches && !input.branchId) throw errors.forbidden('Branch-scoped users must specify a branch.');
  return runUser(deps.db, actor, async (trx) => {
    if (finalize && !(await periodLocked(trx, orgId, input.branchId ?? null, input.periodStart, input.periodEnd))) throw errors.invalidState('The period must be locked before it can be finalised.', { periodStart: input.periodStart, periodEnd: input.periodEnd });
    const jobId = await enqueueJob(deps.queue, trx, { queue: 'processing', jobType: 'BUILD_PERIOD_SUMMARY', organizationId: orgId, payload: { organizationId: orgId, periodStart: input.periodStart, periodEnd: input.periodEnd, ...(input.employeeIds?.length ? { employeeIds: input.employeeIds } : {}), ...(input.branchId ? { branchId: input.branchId } : {}), finalize, requestedBy: actor.userId }, correlationId: actor.requestId, priority: finalize ? 6 : 4, dedupeKey: `period:${orgId}:${input.branchId ?? 'all'}:${input.periodStart}:${input.periodEnd}:${finalize ? 'final' : 'build'}` });
    await audit(trx, actor, orgId, finalize ? 'payroll.period_finalize_requested' : 'payroll.period_build_requested', 'attendance_period_summary', { branchId: input.branchId ?? null, newValue: { ...input, jobId } });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'sync.queued', aggregateType: 'payroll_period', aggregateId: null, payload: { periodStart: input.periodStart, periodEnd: input.periodEnd, finalize, jobId }, actorUserId: actor.userId, requestId: actor.requestId });
    return { jobId, status: 'QUEUED' as const, message: finalize ? 'Period finalisation queued.' : 'Period summary build queued.' };
  });
}

export async function listSummaries(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; periodStart: string; periodEnd: string; branchId?: string; status?: string; search?: string }) {
  const grant = requirePermission(actor.principal, orgId, 'payroll.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('attendancePeriodSummaries as s').innerJoin('employees as e', 'e.id', 's.employeeId').leftJoin('branches as b', 'b.id', 's.branchId').where('s.organizationId', '=', orgId).where('s.periodStart', '=', q.periodStart).where('s.periodEnd', '=', q.periodEnd);
    if (scope) base = base.where('s.branchId', 'in', scope);
    if (q.status) base = base.where('s.status', '=', q.status as never);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb(sql`e.employee_number::text`, 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.selectAll('s').select(['e.employeeNumber', 'e.displayName as employeeName', 'e.departmentId', 'b.name as branchName']).orderBy('e.displayName').orderBy('s.id').limit(page.pageSize).offset(page.offset).execute();
    return {
      data: rows.map((r) => ({ id: r.id, employeeId: r.employeeId, employeeNumber: r.employeeNumber, employeeName: r.employeeName, departmentId: r.departmentId, branchId: r.branchId, branchName: r.branchName, periodStart: isoDate(r.periodStart), periodEnd: isoDate(r.periodEnd), status: r.status, version: r.version, workingDays: r.workingDays, presentDays: numberOrNull(r.presentDays), absentDays: numberOrNull(r.absentDays), leaveDays: numberOrNull(r.leaveDays), paidLeaveDays: numberOrNull(r.paidLeaveDays), holidayDays: r.holidayDays, weeklyOffDays: r.weeklyOffDays, halfDays: r.halfDays, lateDays: r.lateDays, lateMinutes: r.lateMinutes, earlyDepartureMinutes: r.earlyDepartureMinutes, missingPunchDays: r.missingPunchDays, regularMinutes: r.regularMinutes, overtimeMinutes: r.overtimeMinutes, overtimeWeeklyOffMinutes: r.overtimeWeeklyOffMinutes, overtimeHolidayMinutes: r.overtimeHolidayMinutes, recordVersions: r.recordVersions === null ? null : jsonObject(r.recordVersions), computedAt: isoDateTime(r.computedAt), finalizedAt: isoDateTimeOrNull(r.finalizedAt), finalizedBy: r.finalizedBy })),
      total,
    };
  });
}
