import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import {
  createReportScheduleSchema, DAILY_REPORT_MAX_DAYS, dailyReportRangeTooLong, REPORT_RECIPIENT_MAX_RESOLVED, REPORT_SHARES_PER_HOUR, REPORT_TYPE_DEFINITIONS, SCHEDULABLE_REPORT_TYPES,
  type CreateReportScheduleInput, type ReportDeliveryChannel, type ReportDeliveryDto, type ReportDeliveryMode, type ReportDeliveryStatus, type ReportPeriodRule, type ReportRecipientOptionsDto,
  type ReportRecipients, type ReportRunNowResultDto, type ReportRunSummaryDto, type ReportScheduleCadence, type ReportScheduleDto, type ReportScheduleFilters, type ReportScheduleRunStatus,
  type ReportShareResultDto, type ReportType, type ReportTypeDefinition, type ShareReportInput, type UpdateReportScheduleInput,
} from '@flowza/contracts';
import type { DB, Trx } from '@flowza/database';
import { nextScheduleRun, schedulePeriod, type MembershipGrant } from '@flowza/domain';
import { AppError, errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { hasPermission, requireBranchAccess, requirePermission } from '../lib/authorize.js';
import { enqueueJob } from '../lib/jobs.js';
import { isoDate, isoDateTime, isoDateTimeOrNull, jsonObject } from '../lib/mappers.js';
import { pageOf, toCount } from '../lib/pagination.js';
import { type Actor, audit, runUser, withSystemScope } from '../lib/service.js';
import { loadSettings } from '../lib/settings.js';
import { systemStep } from './features/context.js';

/**
 * Report sharing and schedules (HR portal Prompt 6a).
 *
 * A share ("Send now"), a scheduled run and a "Run now" all end in ONE worker job (`RUN_REPORT_SCHEDULE`) that resolves the
 * recipients AT RUN TIME (explicit users + active holders of the chosen roles), and generates one report PER RECIPIENT under
 * that recipient's own access scope (organisation, their branches, or their direct reports) — a recipient who could not request
 * the report themselves is recorded as skipped with the reason, never sent a copy of somebody else's data. The generated file
 * belongs to the recipient (requested_by), so it is fetched through their authenticated session: the notification carries an
 * application link and the 5-minute signed URL is minted on click, after report.export is re-checked. No bearer link is mailed.
 *
 * Authorisation: schedules are read with report.view (RLS: a branch-scoped holder sees the schedules of their branches only —
 * never the organisation-wide ones) and written with report.schedule by THIS service only: since the Prompt 6a review
 * (defect 3) `authenticated` holds no write privilege on `report_schedules`, and every write runs as a system step AFTER the
 * checks here — the stored row must sit inside a branch-scoped caller's branches (before), the new specification too (after),
 * and `next_run_at` / `last_*` / `created_by` are computed here, never taken from a client. The author must also hold the report
 * type's own permissions — you can only distribute what you can see.
 */

export const REPORT_DELIVERY_JOB_TYPE = 'RUN_REPORT_SCHEDULE';

type ScheduleRow = Selectable<DB['reportSchedules']>;
const PERIOD_KEYS = ['from', 'to', 'month'];

function definitionOf(reportType: ReportType): ReportTypeDefinition {
  const def = REPORT_TYPE_DEFINITIONS.find((d) => d.key === reportType);
  if (!def || def.status !== 'available') throw errors.validation('This report type is not available.', { issues: [{ path: 'reportType', message: 'Unavailable' }] });
  return def;
}

async function consumeShareQuota(trx: Trx, orgId: string): Promise<void> {
  const windowSeconds = 3600;
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const res = await sql<{ count: number }>`
    insert into public.usage_quotas (organization_id, metric, window_start, window_seconds, count) values (${orgId}::uuid, 'report_shares', ${windowStart}, ${windowSeconds}, 1)
    on conflict (organization_id, metric, window_start) do update set count = public.usage_quotas.count + 1 returning count`.execute(trx);
  const count = res.rows[0]?.count ?? 1;
  if (count > REPORT_SHARES_PER_HOUR) throw new AppError('RATE_LIMITED', `At most ${REPORT_SHARES_PER_HOUR} report shares per hour per organisation.`, { details: { metric: 'report_shares', limit: REPORT_SHARES_PER_HOUR }, retryAfterMs: windowStart.getTime() + windowSeconds * 1000 - Date.now() });
}

async function orgTiming(trx: Trx, orgId: string): Promise<{ timezone: string; firstDayOfWeek: number }> {
  const org = await withSystemScope(trx, orgId, (t) => t.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst());
  const settings = await withSystemScope(trx, orgId, (t) => loadSettings(t, orgId));
  return { timezone: org?.timezone || 'UTC', firstDayOfWeek: settings.general?.firstDayOfWeek ?? 0 };
}

/**
 * Validate a report specification against the AUTHOR's own access: type available, format offered, the type's permissions held,
 * filters inside the author's branch scope (employees visible to them under RLS), leave type known. Returns normalised filters.
 */
async function validateSpec(trx: Trx, orgId: string, grant: MembershipGrant, reportType: ReportType, format: string, params: Record<string, unknown>, opts: { requireNonPeriod: boolean }): Promise<Record<string, unknown>> {
  const def = definitionOf(reportType);
  for (const p of def.permissions) if (!hasPermission(grant, p)) throw errors.forbidden(`Missing permission: ${p}.`);
  if (!def.formats.includes(format as never)) throw errors.validation(`Format ${format} is not available for ${def.key}.`, { formats: def.formats });
  const required = opts.requireNonPeriod ? def.requiredParameters.filter((p) => !PERIOD_KEYS.includes(p)) : def.requiredParameters;
  const missing = required.filter((p) => params[p] === undefined);
  if (missing.length) throw errors.validation('Missing report parameters.', { issues: missing.map((m) => ({ path: `filters.${m}`, message: 'Required' })) });
  const out: Record<string, unknown> = { ...params };
  // a Daily Report over a range (review ATT-21): at most DAILY_REPORT_MAX_DAYS, as POST /reports refuses it
  if (reportType === 'daily_attendance' && dailyReportRangeTooLong({ from: typeof out['from'] === 'string' ? out['from'] : null, to: typeof out['to'] === 'string' ? out['to'] : null })) {
    throw errors.validation(`The Daily Report covers at most ${DAILY_REPORT_MAX_DAYS} days.`, { issues: [{ path: 'parameters.to', message: `At most ${DAILY_REPORT_MAX_DAYS} days` }] });
  }
  const branchId = typeof out['branchId'] === 'string' ? out['branchId'] : undefined;
  requireBranchAccess(grant, branchId);
  if (!grant.allBranches && !branchId) throw errors.forbidden('Branch-scoped users must choose one of their branches.');
  if (Array.isArray(out['employeeIds']) && out['employeeIds'].length) {
    const ids = [...new Set(out['employeeIds'] as string[])];
    const emps = await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', 'in', ids).where('deletedAt', 'is', null).execute();
    const unknown = ids.filter((id) => !emps.some((e) => e.id === id));
    if (unknown.length) throw errors.validation('One or more employees were not found or are outside your branch scope.', { issues: [{ path: 'employeeIds', message: 'Unknown employee' }], missing: unknown });
    for (const e of emps) requireBranchAccess(grant, e.branchId);
    out['employeeIds'] = ids;
  }
  if (typeof out['leaveTypeCode'] === 'string') {
    const lt = await trx.selectFrom('leaveTypes').select('code').where('organizationId', '=', orgId).where(sql<boolean>`lower(code::text) = lower(${out['leaveTypeCode']})`).where('status', '=', 'active').executeTakeFirst();
    if (!lt) throw errors.validation('Unknown leave type.', { issues: [{ path: 'leaveTypeCode', message: 'Unknown leave type' }] });
    out['leaveTypeCode'] = String(lt.code);
  }
  return out;
}

/**
 * The members a caller may address and see in the picker (review minor 12): everyone for an organisation-wide caller; for a
 * branch-scoped caller, the members whose access covers one of the caller's branches (all branches, or a listed branch) or whose
 * linked employee record belongs to one of them.
 */
function memberScopeSql(grant: MembershipGrant) {
  if (grant.allBranches) return sql<boolean>`true`;
  const branches = grant.branchIds.length ? grant.branchIds : ['00000000-0000-0000-0000-000000000000'];
  return sql<boolean>`(m.all_branches
    or exists (select 1 from public.membership_branches mb where mb.membership_id = m.id and mb.branch_id = any(${branches}::uuid[]))
    or exists (select 1 from public.employees e where e.id = m.employee_id and e.organization_id = m.organization_id and e.branch_id = any(${branches}::uuid[])))`;
}

/**
 * Active members the recipient list resolves to right now (explicit users + holders of the roles); unknown ids / roles refused,
 * and explicit users outside a branch-scoped author's member scope refused like unknown ones (the picker never showed them).
 */
async function resolveRecipients(trx: Trx, orgId: string, recipients: ReportRecipients, grant?: MembershipGrant): Promise<string[]> {
  return withSystemScope(trx, orgId, async (t) => {
    if (recipients.roleKeys.length) {
      const roles = await t.selectFrom('roles').select('key').where('key', 'in', recipients.roleKeys).where((eb) => eb.or([eb('organizationId', 'is', null), eb('organizationId', '=', orgId)])).execute();
      const unknown = recipients.roleKeys.filter((k) => !roles.some((r) => r.key === k));
      if (unknown.length) throw errors.validation('Unknown role.', { issues: [{ path: 'recipients.roleKeys', message: 'Unknown role' }], unknown });
    }
    if (recipients.userIds.length) {
      const members = (await sql<{ userId: string }>`
        select m.user_id as "userId" from public.org_memberships m
        where m.organization_id = ${orgId}::uuid and m.status = 'active' and m.user_id = any(${recipients.userIds}::uuid[]) and ${grant ? memberScopeSql(grant) : sql`true`}`.execute(t)).rows;
      const unknown = recipients.userIds.filter((u) => !members.some((m) => m.userId === u));
      if (unknown.length) throw errors.validation('One or more recipients are not active members of this organisation.', { issues: [{ path: 'recipients.userIds', message: 'Not an active member' }], unknown });
    }
    const rows = await t.selectFrom('orgMemberships as m').innerJoin('roles as r', 'r.id', 'm.roleId').select('m.userId').where('m.organizationId', '=', orgId).where('m.status', '=', 'active')
      .where((eb) => eb.or([
        ...(recipients.userIds.length ? [eb('m.userId', 'in', recipients.userIds)] : []),
        ...(recipients.roleKeys.length ? [eb('r.key', 'in', recipients.roleKeys)] : []),
        sql<boolean>`false`,
      ])).execute();
    return [...new Set(rows.map((r) => r.userId))];
  });
}

async function userNames(trx: Trx, orgId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await withSystemScope(trx, orgId, (t) => t.selectFrom('userProfiles as u').innerJoin('orgMemberships as m', 'm.userId', 'u.id').select(['u.id', 'u.fullName', 'u.email']).where('m.organizationId', '=', orgId).where('u.id', 'in', unique).execute());
  return new Map(rows.map((r) => [r.id, r.fullName || r.email]));
}

function timingOf(s: { cadence: string; runDay: number; runTime: string }, timezone: string) {
  return { cadence: s.cadence as ReportScheduleCadence, runDay: s.runDay, runTime: s.runTime, timezone };
}

function toScheduleDto(s: ScheduleRow, timing: { timezone: string; firstDayOfWeek: number }, names: Map<string, string>): ReportScheduleDto {
  const recipients = jsonObject(s.recipients);
  const summary = s.lastSummary === null ? null : jsonObject(s.lastSummary);
  const nextPeriod = s.nextRunAt ? schedulePeriod({ periodRule: s.periodRule as ReportPeriodRule, customFromDay: s.customFromDay, customToDay: s.customToDay, firstDayOfWeek: timing.firstDayOfWeek }, new Date(s.nextRunAt), timing.timezone) : null;
  return {
    id: s.id, name: s.name, reportType: s.reportType as ReportType, format: s.format, filters: jsonObject(s.filters) as ReportScheduleFilters, branchId: s.branchId,
    cadence: s.cadence as ReportScheduleCadence, runDay: s.runDay, runTime: String(s.runTime).slice(0, 5), periodRule: s.periodRule as ReportPeriodRule,
    customFromDay: s.customFromDay, customToDay: s.customToDay,
    recipients: { userIds: Array.isArray(recipients['userIds']) ? (recipients['userIds'] as string[]) : [], roleKeys: Array.isArray(recipients['roleKeys']) ? (recipients['roleKeys'] as string[]) : [] },
    channels: s.channels as ReportDeliveryChannel[], isActive: s.isActive, nextRunAt: isoDateTimeOrNull(s.nextRunAt), lastRunAt: isoDateTimeOrNull(s.lastRunAt),
    lastStatus: (s.lastStatus as ReportScheduleRunStatus | null) ?? null, lastError: s.lastError, lastSummary: summary as ReportRunSummaryDto | null, nextPeriod, timezone: timing.timezone,
    createdBy: s.createdBy, createdByName: s.createdBy ? names.get(s.createdBy) ?? null : null, createdAt: isoDateTime(s.createdAt), updatedAt: isoDateTime(s.updatedAt),
  };
}

// ---- schedules CRUD --------------------------------------------------------------------------------------------------------

export async function listSchedules(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; reportType?: string }): Promise<{ data: ReportScheduleDto[]; total: number }> {
  requirePermission(actor.principal, orgId, 'report.view');
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('reportSchedules').where('organizationId', '=', orgId);
    if (q.reportType) base = base.where('reportType', '=', q.reportType);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.selectAll().orderBy('createdAt', 'desc').orderBy('id').limit(page.pageSize).offset(page.offset).execute();
    const timing = await orgTiming(trx, orgId);
    const names = await userNames(trx, orgId, rows.map((r) => r.createdBy).filter((x): x is string => x !== null));
    return { data: rows.map((r) => toScheduleDto(r, timing, names)), total };
  });
}

async function loadSchedule(trx: Trx, orgId: string, id: string, opts: { lock?: boolean } = {}): Promise<ScheduleRow> {
  let q = trx.selectFrom('reportSchedules').selectAll().where('organizationId', '=', orgId).where('id', '=', id);
  if (opts.lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw errors.notFound('Report schedule', id);
  return row;
}

/**
 * The STORED schedule must sit inside a branch-scoped caller's branches (review defect 3): an organisation-wide schedule
 * (branch null) or another branch's is not theirs to re-point, run or delete, whatever the new specification says. RLS already
 * hides such rows from them; this is the explicit second check.
 */
function requireScheduleScope(grant: MembershipGrant, row: Pick<ScheduleRow, 'branchId'>): void {
  if (grant.allBranches) return;
  if (!row.branchId || !grant.branchIds.includes(row.branchId)) throw errors.forbidden('This schedule covers branches outside your access scope.');
}

/**
 * The schedule a change targets (update, delete, run-now — callers hold report.view + report.schedule), read in the
 * organisation's system scope so a schedule outside a branch-scoped caller's branches answers 403 (refused) rather than 404,
 * then checked against the caller's scope. Within scope the row is exactly what the caller's RLS shows them.
 */
async function loadScheduleForChange(trx: Trx, orgId: string, id: string, grant: MembershipGrant): Promise<ScheduleRow> {
  const row = await withSystemScope(trx, orgId, (t) => loadSchedule(t, orgId, id));
  requireScheduleScope(grant, row);
  return row;
}

/**
 * Lock the row for a write (system step: `authenticated` holds no write privilege on report_schedules) and make sure it is the
 * version the caller was authorised against — a concurrent edit is a conflict, never silently overwritten.
 */
async function lockUnchanged(t: Trx, orgId: string, seen: ScheduleRow): Promise<ScheduleRow> {
  const locked = await loadSchedule(t, orgId, seen.id, { lock: true });
  if (new Date(locked.updatedAt).getTime() !== new Date(seen.updatedAt).getTime()) throw errors.conflict('The schedule changed meanwhile. Please refresh.');
  return locked;
}

export async function getSchedule(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<ReportScheduleDto> {
  requirePermission(actor.principal, orgId, 'report.view');
  return runUser(deps.db, actor, async (trx) => {
    const row = await loadSchedule(trx, orgId, id);
    return toScheduleDto(row, await orgTiming(trx, orgId), await userNames(trx, orgId, row.createdBy ? [row.createdBy] : []));
  });
}

function scheduleColumns(input: CreateReportScheduleInput, filters: Record<string, unknown>, nextRunAt: Date | null) {
  return {
    name: input.name, reportType: input.reportType, format: input.format, filters: JSON.stringify(filters), branchId: typeof filters['branchId'] === 'string' ? (filters['branchId'] as string) : null,
    cadence: input.cadence, runDay: input.runDay, runTime: input.runTime, periodRule: input.periodRule,
    customFromDay: input.periodRule === 'custom' ? input.customFromDay ?? null : null, customToDay: input.periodRule === 'custom' ? input.customToDay ?? null : null,
    recipients: JSON.stringify({ userIds: [...new Set(input.recipients.userIds)], roleKeys: [...new Set(input.recipients.roleKeys)] }), channels: input.channels, isActive: input.isActive,
    nextRunAt,
  };
}

export async function createSchedule(deps: ApiDeps, actor: Actor, orgId: string, input: CreateReportScheduleInput): Promise<ReportScheduleDto> {
  const grant = requirePermission(actor.principal, orgId, 'report.view', 'report.schedule');
  if (!SCHEDULABLE_REPORT_TYPES.includes(input.reportType)) throw errors.validation('This report type cannot be scheduled.', { issues: [{ path: 'reportType', message: 'Not schedulable' }] });
  return runUser(deps.db, actor, async (trx) => {
    const filters = await validateSpec(trx, orgId, grant, input.reportType, input.format, input.filters as Record<string, unknown>, { requireNonPeriod: true });
    const recipients = await resolveRecipients(trx, orgId, input.recipients, grant);
    if (recipients.length === 0) throw errors.validation('None of the chosen recipients is an active member.', { issues: [{ path: 'recipients', message: 'No active recipients' }] });
    const timing = await orgTiming(trx, orgId);
    const nextRunAt = input.isActive ? nextScheduleRun(timingOf(input, timing.timezone), new Date()) : null;
    // written by the service's system step after the checks above (authenticated holds no write privilege on the table)
    const row = await systemStep(trx, orgId, (t) => t.insertInto('reportSchedules').values({ organizationId: orgId, ...scheduleColumns(input, filters, nextRunAt), createdBy: actor.userId, updatedBy: actor.userId }).returningAll().executeTakeFirstOrThrow());
    await audit(trx, actor, orgId, 'report_schedule.created', 'report_schedule', { entityId: row.id, branchId: row.branchId, newValue: { name: row.name, reportType: row.reportType, format: row.format, cadence: row.cadence, runDay: row.runDay, runTime: input.runTime, periodRule: row.periodRule, recipients: input.recipients, channels: input.channels, isActive: row.isActive, filters } });
    return toScheduleDto(row, timing, await userNames(trx, orgId, [actor.userId]));
  });
}

function inputOf(row: ScheduleRow): CreateReportScheduleInput {
  const r = jsonObject(row.recipients);
  return {
    name: row.name, reportType: row.reportType as ReportType, format: row.format, filters: jsonObject(row.filters) as ReportScheduleFilters, cadence: row.cadence as ReportScheduleCadence,
    runDay: row.runDay, runTime: String(row.runTime).slice(0, 5), periodRule: row.periodRule as ReportPeriodRule, customFromDay: row.customFromDay, customToDay: row.customToDay,
    recipients: { userIds: Array.isArray(r['userIds']) ? (r['userIds'] as string[]) : [], roleKeys: Array.isArray(r['roleKeys']) ? (r['roleKeys'] as string[]) : [] },
    channels: row.channels as ReportDeliveryChannel[], isActive: row.isActive,
  };
}

export async function updateSchedule(deps: ApiDeps, actor: Actor, orgId: string, id: string, patch: UpdateReportScheduleInput): Promise<ReportScheduleDto> {
  const grant = requirePermission(actor.principal, orgId, 'report.view', 'report.schedule');
  return runUser(deps.db, actor, async (trx) => {
    // the stored schedule inside a branch-scoped caller's branches (before the change) …
    const row = await loadScheduleForChange(trx, orgId, id, grant);
    const before = inputOf(row);
    const parsed = createReportScheduleSchema.safeParse({ ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
    if (!parsed.success) throw errors.validation('Invalid schedule.', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const next = parsed.data;
    if (!SCHEDULABLE_REPORT_TYPES.includes(next.reportType)) throw errors.validation('This report type cannot be scheduled.', { issues: [{ path: 'reportType', message: 'Not schedulable' }] });
    // … and the new specification inside the caller's scope too (after the change)
    const filters = await validateSpec(trx, orgId, grant, next.reportType, next.format, next.filters as Record<string, unknown>, { requireNonPeriod: true });
    const recipients = await resolveRecipients(trx, orgId, next.recipients, grant);
    if (next.isActive && recipients.length === 0) throw errors.validation('None of the chosen recipients is an active member.', { issues: [{ path: 'recipients', message: 'No active recipients' }] });
    const timing = await orgTiming(trx, orgId);
    const timingChanged = before.cadence !== next.cadence || before.runDay !== next.runDay || before.runTime !== next.runTime;
    const nextRunAt = !next.isActive ? null : (timingChanged || !row.isActive || !row.nextRunAt) ? nextScheduleRun(timingOf(next, timing.timezone), new Date()) : row.nextRunAt;
    const saved = await systemStep(trx, orgId, async (t) => {
      await lockUnchanged(t, orgId, row);
      return t.updateTable('reportSchedules').set({ ...scheduleColumns(next, filters, nextRunAt), updatedBy: actor.userId }).where('organizationId', '=', orgId).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    });
    await audit(trx, actor, orgId, 'report_schedule.updated', 'report_schedule', { entityId: id, branchId: saved.branchId, oldValue: { ...before }, newValue: { ...next, filters } });
    return toScheduleDto(saved, timing, await userNames(trx, orgId, saved.createdBy ? [saved.createdBy] : []));
  });
}

export async function deleteSchedule(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  const grant = requirePermission(actor.principal, orgId, 'report.view', 'report.schedule');
  await runUser(deps.db, actor, async (trx) => {
    const row = await loadScheduleForChange(trx, orgId, id, grant);
    const deleted = await systemStep(trx, orgId, async (t) => {
      await lockUnchanged(t, orgId, row);
      const res = await t.deleteFrom('reportSchedules').where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
      return Number(res.numDeletedRows ?? 0n);
    });
    if (deleted === 0) throw errors.notFound('Report schedule', id);
    await audit(trx, actor, orgId, 'report_schedule.deleted', 'report_schedule', { entityId: id, branchId: row.branchId, oldValue: { ...inputOf(row) } });
  });
}

/** POST /report-schedules/:id/run-now — one run immediately for the period the schedule would cover now; next_run_at is untouched. */
export async function runScheduleNow(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<ReportRunNowResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'report.view', 'report.schedule');
  return runUser(deps.db, actor, async (trx) => {
    // the stored schedule must be the caller's to run, and their own access still bounds what they may send
    const row = await loadScheduleForChange(trx, orgId, id, grant);
    await validateSpec(trx, orgId, grant, row.reportType as ReportType, row.format, jsonObject(row.filters), { requireNonPeriod: true });
    await systemStep(trx, orgId, (t) => consumeShareQuota(t, orgId));
    const timing = await orgTiming(trx, orgId);
    const period = schedulePeriod({ periodRule: row.periodRule as ReportPeriodRule, customFromDay: row.customFromDay, customToDay: row.customToDay, firstDayOfWeek: timing.firstDayOfWeek }, new Date(), timing.timezone);
    const runKey = `manual:${randomUUID()}`;
    const jobId = await enqueueJob(deps.queue, trx, { queue: 'reports', jobType: REPORT_DELIVERY_JOB_TYPE, organizationId: orgId, payload: { organizationId: orgId, mode: 'manual', scheduleId: id, runKey, requestedBy: actor.userId }, correlationId: actor.requestId, priority: 5 });
    await audit(trx, actor, orgId, 'report_schedule.run_requested', 'report_schedule', { entityId: id, branchId: row.branchId, newValue: { runKey, period, jobId } });
    return { jobId, runKey, status: 'QUEUED', period };
  });
}

/** POST /reports/share — Send now: validated like POST /reports for the sender, then generated per recipient by the worker. */
export async function shareReport(deps: ApiDeps, actor: Actor, orgId: string, input: ShareReportInput): Promise<ReportShareResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'report.view', 'report.schedule');
  if (input.parameters.from && input.parameters.to && input.parameters.to < input.parameters.from) throw errors.validation('to must be on/after from.');
  return runUser(deps.db, actor, async (trx) => {
    const parameters = await validateSpec(trx, orgId, grant, input.reportType, input.format, { ...input.parameters }, { requireNonPeriod: false });
    delete parameters['branchScope']; delete parameters['branchIds'];
    const recipients = await resolveRecipients(trx, orgId, input.recipients, grant);
    if (recipients.length === 0) throw errors.validation('None of the chosen recipients is an active member.', { issues: [{ path: 'recipients', message: 'No active recipients' }] });
    if (recipients.length > REPORT_RECIPIENT_MAX_RESOLVED) throw errors.validation(`A report can be shared with at most ${REPORT_RECIPIENT_MAX_RESOLVED} people at once.`, { recipients: recipients.length });
    await systemStep(trx, orgId, (t) => consumeShareQuota(t, orgId));
    const runKey = `send:${randomUUID()}`;
    const spec = { reportType: input.reportType, format: input.format, parameters, recipients: input.recipients, channels: input.channels, note: input.note ?? null };
    const jobId = await enqueueJob(deps.queue, trx, { queue: 'reports', jobType: REPORT_DELIVERY_JOB_TYPE, organizationId: orgId, payload: { organizationId: orgId, mode: 'send_now', runKey, requestedBy: actor.userId, spec }, correlationId: actor.requestId, priority: 5 });
    await audit(trx, actor, orgId, 'report.shared', 'report_delivery', { branchId: typeof parameters['branchId'] === 'string' ? (parameters['branchId'] as string) : null, newValue: { runKey, jobId, reportType: input.reportType, format: input.format, parameters, recipients: input.recipients, resolvedRecipients: recipients.length, channels: input.channels } });
    return { jobId, runKey, status: 'QUEUED', recipients: recipients.length };
  });
}

// ---- deliveries + recipient picker --------------------------------------------------------------------------------------------------

export async function listDeliveries(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; scheduleId?: string; status?: string; mode?: string }): Promise<{ data: ReportDeliveryDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'report.view');
  const manager = hasPermission(grant, 'report.schedule');
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('reportDeliveries as d').where('d.organizationId', '=', orgId);
    // a recipient sees their own deliveries; a branch-scoped scheduler sees what they sent, received, or the deliveries of the
    // schedules of their branches (RLS since the review: report_deliveries_select applies the same rule)
    if (!manager) base = base.where('d.recipientUserId', '=', actor.userId);
    else if (!grant.allBranches) {
      const visible = (await trx.selectFrom('reportSchedules').select('id').where('organizationId', '=', orgId).execute()).map((s) => s.id);
      base = base.where((eb) => eb.or([eb('d.sentBy', '=', actor.userId), eb('d.recipientUserId', '=', actor.userId), ...(visible.length ? [eb('d.scheduleId', 'in', visible)] : [])]));
    }
    if (q.scheduleId) base = base.where('d.scheduleId', '=', q.scheduleId);
    if (q.status) base = base.where('d.status', '=', q.status);
    if (q.mode) base = base.where('d.mode', '=', q.mode);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.selectAll('d').orderBy('d.createdAt', 'desc').orderBy('d.id').limit(page.pageSize).offset(page.offset).execute();
    const names = await userNames(trx, orgId, rows.flatMap((r) => [r.recipientUserId, ...(r.sentBy ? [r.sentBy] : [])]));
    const scheduleIds = [...new Set(rows.map((r) => r.scheduleId).filter((s): s is string => s !== null))];
    const schedules = scheduleIds.length ? new Map((await withSystemScope(trx, orgId, (t) => t.selectFrom('reportSchedules').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', scheduleIds).execute())).map((s) => [s.id, s.name])) : new Map<string, string>();
    return {
      data: rows.map((r) => ({
        id: r.id, scheduleId: r.scheduleId, scheduleName: r.scheduleId ? schedules.get(r.scheduleId) ?? null : null, mode: r.mode as ReportDeliveryMode, reportType: r.reportType, format: r.format,
        periodFrom: r.periodFrom === null ? null : isoDate(r.periodFrom), periodTo: r.periodTo === null ? null : isoDate(r.periodTo), recipientUserId: r.recipientUserId,
        recipientName: names.get(r.recipientUserId) ?? null, sentBy: r.sentBy, sentByName: r.sentBy ? names.get(r.sentBy) ?? null : null, channels: r.channels as ReportDeliveryChannel[],
        scope: jsonObject(r.scope) as ReportDeliveryDto['scope'], status: r.status as ReportDeliveryStatus, skipReason: r.skipReason, error: r.error, reportRequestId: r.reportRequestId,
        createdAt: isoDateTime(r.createdAt), deliveredAt: isoDateTimeOrNull(r.deliveredAt),
      })),
      total,
    };
  });
}

/**
 * GET /report-recipients — members (with role, manager flag, branch scope size) and roles for the Share / Schedule picker. A
 * branch-scoped caller gets the members inside their branch scope (`memberScopeSql`) and role counts over that set; e-mail
 * addresses only for user.view holders — everyone else gets names (review minor 12: the picker is not a member directory).
 */
export async function recipientOptions(deps: ApiDeps, actor: Actor, orgId: string): Promise<ReportRecipientOptionsDto> {
  const grant = requirePermission(actor.principal, orgId, 'report.view', 'report.schedule');
  const withEmail = hasPermission(grant, 'user.view');
  return runUser(deps.db, actor, (trx) => withSystemScope(trx, orgId, async (t) => {
    const members = await sql<{ userId: string; displayName: string; email: string; roleKey: string; roleName: string; isManager: boolean; branchCount: number | null }>`
      select m.user_id as "userId",
        coalesce(nullif(u.full_name, ''), case when ${withEmail}::boolean then u.email::text else left(u.email::text, 1) || '***' || substring(u.email::text from position('@' in u.email::text)) end) as "displayName",
        u.email, r.key as "roleKey", r.name as "roleName",
        (m.employee_id is not null and exists (select 1 from public.employees e where e.organization_id = m.organization_id and e.deleted_at is null
           and e.employment_status not in ('terminated', 'resigned') and (e.manager_employee_id = m.employee_id or e.secondary_manager_employee_id = m.employee_id))) as "isManager",
        case when m.all_branches then null else (select count(*)::int from public.membership_branches mb where mb.membership_id = m.id) end as "branchCount"
      from public.org_memberships m join public.user_profiles u on u.id = m.user_id join public.roles r on r.id = m.role_id
      where m.organization_id = ${orgId}::uuid and m.status = 'active' and ${memberScopeSql(grant)}
      order by 2, 1
      limit 2000`.execute(t);
    const roles = await sql<{ key: string; name: string; members: number }>`
      select r.key, r.name, count(m.id)::int as members from public.roles r
      left join public.org_memberships m on m.role_id = r.id and m.organization_id = ${orgId}::uuid and m.status = 'active' and ${memberScopeSql(grant)}
      where r.organization_id is null or r.organization_id = ${orgId}::uuid
      group by r.key, r.name order by r.name`.execute(t);
    return { users: members.rows.map((u) => ({ ...u, email: withEmail ? u.email : null })), roles: roles.rows };
  }));
}
