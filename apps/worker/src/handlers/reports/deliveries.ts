import { sql } from 'kysely';
import { z } from 'zod';
import { REPORT_DELIVERY_CHANNELS, REPORT_FORMATS, REPORT_RECIPIENT_MAX_RESOLVED, REPORT_TYPES, uuidSchema, type ReportFormat, type ReportPeriodRule, type ReportScheduleCadence, type ReportType } from '@flowza/contracts';
import { emitDomainEvent, withContext, writeAudit, type JobQueue, type Trx } from '@flowza/database';
import { dueOccurrence, nextScheduleRun, periodParameters, schedulePeriod, scopeReportForRecipient, type RecipientGrant, type ReportPeriod } from '@flowza/domain';
import { errors, event, isValidTimezone } from '@flowza/shared';
import type { WorkerDeps } from '../../deps.js';
import type { HandlerRegistry, JobContext } from '../types.js';
import { asObject, parsePayload } from '../attendance/common.js';

/**
 * RUN_REPORT_SCHEDULE (HR portal Prompt 6a): one distribution run — a due schedule occurrence, a schedule's "Run now", or a
 * "Send now" share. Recipients are resolved NOW (explicit users + active holders of the chosen roles, capped at
 * REPORT_RECIPIENT_MAX_RESOLVED) and each receives a report generated under THEIR OWN access scope (`scopeReportForRecipient`:
 * organisation, their branches, or their direct reports); anybody who could not request the report themselves is recorded as
 * skipped with the reason. Per recipient: a `report_deliveries` row, a `report_requests` row owned by the recipient and a
 * GENERATE_REPORT job — all in this job's transaction. When the file is ready, `generateReportRequest` marks the delivery and
 * emits `report.scheduled_delivery` to that recipient (the outbox relay turns it into in-app / e-mail per the chosen channels).
 *
 * Idempotency: `report_deliveries (organization_id, run_key, recipient_user_id)` is unique; a run key is per occurrence
 * (`schedule:<id>:<occurrence>`) or per request (`manual:<uuid>`, `send:<uuid>`), so a retried or duplicated job never sends a
 * recipient the same run twice. A scheduled run also re-checks, under a row lock, that the schedule is still due at the
 * occurrence the scheduler saw, then advances `next_run_at` past now in the same transaction.
 */

export const REPORT_DELIVERY_JOB_TYPE = 'RUN_REPORT_SCHEDULE';

const recipientsSchema = z.object({ userIds: z.array(uuidSchema).max(50).default([]), roleKeys: z.array(z.string().min(1).max(64)).max(10).default([]) });
const specSchema = z.object({
  reportType: z.enum(REPORT_TYPES),
  format: z.enum(REPORT_FORMATS),
  parameters: z.record(z.string(), z.unknown()),
  recipients: recipientsSchema,
  channels: z.array(z.enum(REPORT_DELIVERY_CHANNELS)).min(1).max(2),
  note: z.string().max(500).nullish(),
});
export const reportDeliveryPayloadSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('schedule'), organizationId: uuidSchema, scheduleId: uuidSchema, scheduledFor: z.string().min(1).max(40) }),
  z.object({ mode: z.literal('manual'), organizationId: uuidSchema, scheduleId: uuidSchema, runKey: z.string().min(3).max(200), requestedBy: uuidSchema.nullish() }),
  z.object({ mode: z.literal('send_now'), organizationId: uuidSchema, runKey: z.string().min(3).max(200), requestedBy: uuidSchema.nullish(), spec: specSchema }),
]);
export type ReportDeliveryPayload = z.infer<typeof reportDeliveryPayloadSchema>;

export interface DeliveryCounts { recipients: number; queued: number; skipped: number; alreadyDelivered: number }
export interface DeliveryRunResult extends Partial<DeliveryCounts> { outcome: 'delivered' | 'skipped' | 'failed'; reason?: string; runKey?: string; period?: ReportPeriod | null; nextRunAt?: string | null }

interface RunSpec {
  organizationId: string;
  mode: 'schedule' | 'manual' | 'send_now';
  scheduleId: string | null;
  runKey: string;
  reportType: ReportType;
  format: ReportFormat;
  parameters: Record<string, unknown>;
  recipients: { userIds: string[]; roleKeys: string[] };
  channels: string[];
  period: ReportPeriod | null;
  sentBy: string | null;
}

const toStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The recipients' memberships, permissions, branch scopes and direct reports, loaded in bulk. */
async function loadRecipientGrants(trx: Trx, organizationId: string, recipients: { userIds: string[]; roleKeys: string[] }): Promise<RecipientGrant[]> {
  if (!recipients.userIds.length && !recipients.roleKeys.length) return [];
  const members = await trx.selectFrom('orgMemberships as m').innerJoin('roles as r', 'r.id', 'm.roleId')
    .select(['m.id', 'm.userId', 'm.roleId', 'm.allBranches', 'm.employeeId'])
    .where('m.organizationId', '=', organizationId).where('m.status', '=', 'active')
    .where((eb) => eb.or([
      ...(recipients.userIds.length ? [eb('m.userId', 'in', recipients.userIds)] : []),
      ...(recipients.roleKeys.length ? [eb.and([eb('r.key', 'in', recipients.roleKeys), eb.or([eb('r.organizationId', 'is', null), eb('r.organizationId', '=', organizationId)])])] : []),
      sql<boolean>`false`,
    ]))
    .orderBy('m.userId').execute();
  const unique = [...new Map(members.map((m) => [m.userId, m])).values()];
  if (!unique.length) return [];
  const roleIds = [...new Set(unique.map((m) => m.roleId))];
  const perms = await trx.selectFrom('rolePermissions').select(['roleId', 'permissionKey']).where('roleId', 'in', roleIds).execute();
  const permsByRole = new Map<string, string[]>();
  for (const p of perms) permsByRole.set(p.roleId, [...(permsByRole.get(p.roleId) ?? []), p.permissionKey]);
  const restricted = unique.filter((m) => !m.allBranches).map((m) => m.id);
  const branches = restricted.length ? await trx.selectFrom('membershipBranches').select(['membershipId', 'branchId']).where('membershipId', 'in', restricted).execute() : [];
  const branchesByMembership = new Map<string, string[]>();
  for (const b of branches) branchesByMembership.set(b.membershipId, [...(branchesByMembership.get(b.membershipId) ?? []), b.branchId]);
  // direct reports (primary or secondary manager), leavers excluded, and only while the manager's own record is active — the
  // same rule as app.team_employee_ids() / the principal snapshot
  const team = await sql<{ membershipId: string; employeeId: string }>`
    select m.id as "membershipId", e.id as "employeeId"
    from public.org_memberships m
    join public.employees me on me.id = m.employee_id and me.organization_id = m.organization_id and me.deleted_at is null and me.employment_status not in ('terminated', 'resigned')
    join public.employees e on e.organization_id = m.organization_id and e.deleted_at is null and e.employment_status not in ('terminated', 'resigned')
      and (e.manager_employee_id = m.employee_id or e.secondary_manager_employee_id = m.employee_id)
    where m.id = any(${unique.map((m) => m.id)}::uuid[])`.execute(trx);
  const teamByMembership = new Map<string, string[]>();
  for (const t of team.rows) teamByMembership.set(t.membershipId, [...(teamByMembership.get(t.membershipId) ?? []), t.employeeId]);
  // the recipient's own employee record — what somebody without report access may still receive a copy about (self scope);
  // a leaver or a deleted record is nobody's self any more
  const ownIds = [...new Set(unique.map((m) => m.employeeId).filter((id): id is string => typeof id === 'string'))];
  const own = ownIds.length
    ? new Map((await trx.selectFrom('employees').select(['id', 'branchId', 'departmentId']).where('organizationId', '=', organizationId).where('id', 'in', ownIds)
      .where('deletedAt', 'is', null).where('employmentStatus', 'not in', ['terminated', 'resigned']).execute()).map((e) => [e.id, e]))
    : new Map<string, { id: string; branchId: string; departmentId: string | null }>();
  return unique.map((m) => {
    const e = m.employeeId ? own.get(m.employeeId) : undefined;
    return {
      userId: m.userId, permissions: permsByRole.get(m.roleId) ?? [], allBranches: m.allBranches,
      branchIds: branchesByMembership.get(m.id) ?? [], teamEmployeeIds: teamByMembership.get(m.id) ?? [],
      self: e ? { employeeId: e.id, branchId: e.branchId, departmentId: e.departmentId } : null,
    };
  });
}

/**
 * Create the per-recipient deliveries of one run (see the module comment). Returns the counts; existing deliveries of the run
 * key are left untouched (a re-run is a no-op for those recipients).
 */
export async function deliverRun(trx: Trx, queue: JobQueue, run: RunSpec): Promise<DeliveryCounts> {
  const grants = await loadRecipientGrants(trx, run.organizationId, run.recipients);
  const done = new Set((await trx.selectFrom('reportDeliveries').select('recipientUserId').where('organizationId', '=', run.organizationId).where('runKey', '=', run.runKey).execute()).map((d) => d.recipientUserId));
  const requested = toStrings(run.parameters['employeeIds']);
  const employeeBranches = new Map<string, string>(requested.length
    ? (await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', run.organizationId).where('id', 'in', requested).where('deletedAt', 'is', null).execute()).map((e) => [e.id, e.branchId])
    : []);
  const counts: DeliveryCounts = { recipients: grants.length, queued: 0, skipped: 0, alreadyDelivered: 0 };
  const base = {
    organizationId: run.organizationId, scheduleId: run.scheduleId, runKey: run.runKey, mode: run.mode, reportType: run.reportType, format: run.format,
    periodFrom: run.period?.from ?? null, periodTo: run.period?.to ?? null, sentBy: run.sentBy, channels: run.channels,
  };
  for (const [index, grant] of grants.entries()) {
    if (done.has(grant.userId)) { counts.alreadyDelivered += 1; continue; }
    const decision = index >= REPORT_RECIPIENT_MAX_RESOLVED ? { ok: false as const, reason: 'recipient_cap' } : scopeReportForRecipient(grant, run.reportType, run.parameters, employeeBranches);
    if (!decision.ok) {
      await trx.insertInto('reportDeliveries').values({ ...base, recipientUserId: grant.userId, status: 'skipped', skipReason: decision.reason.slice(0, 200) })
        .onConflict((oc) => oc.columns(['organizationId', 'runKey', 'recipientUserId']).doNothing()).execute();
      counts.skipped += 1;
      continue;
    }
    const scope = { kind: decision.kind, ...(decision.branchCount !== null ? { branchCount: decision.branchCount } : {}), ...(decision.employeeCount !== null ? { employeeCount: decision.employeeCount } : {}) };
    const delivery = await trx.insertInto('reportDeliveries').values({ ...base, recipientUserId: grant.userId, status: 'queued', scope: JSON.stringify(scope) })
      .onConflict((oc) => oc.columns(['organizationId', 'runKey', 'recipientUserId']).doNothing()).returning('id').executeTakeFirst();
    if (!delivery) { counts.alreadyDelivered += 1; continue; }
    const request = await trx.insertInto('reportRequests').values({
      organizationId: run.organizationId, reportType: run.reportType, format: run.format, parameters: JSON.stringify(decision.parameters), status: 'QUEUED', requestedBy: grant.userId, branchId: decision.branchId,
    }).returning('id').executeTakeFirstOrThrow();
    const jobId = await queue.enqueue({ queue: 'reports', jobType: 'GENERATE_REPORT', organizationId: run.organizationId, payload: { organizationId: run.organizationId, reportRequestId: request.id }, priority: 4 }, trx);
    await trx.updateTable('reportRequests').set({ queueJobId: jobId }).where('id', '=', request.id).execute();
    await trx.updateTable('reportDeliveries').set({ reportRequestId: request.id }).where('id', '=', delivery.id).execute();
    counts.queued += 1;
  }
  return counts;
}

/** A share's period for the delivery trail: from/to, or the month, or the week-anchor date (null for period-less types). */
export function periodOfParameters(p: Record<string, unknown>): ReportPeriod | null {
  const from = typeof p['from'] === 'string' ? p['from'] : null;
  const to = typeof p['to'] === 'string' ? p['to'] : null;
  const month = typeof p['month'] === 'string' && /^\d{4}-\d{2}$/.test(p['month']) ? p['month'] : null;
  if (from && to) return { from, to };
  if (month) {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
  }
  if (from) return { from, to: from };
  return null;
}

async function orgTiming(trx: Trx, organizationId: string): Promise<{ timezone: string; firstDayOfWeek: number; active: boolean }> {
  const org = await trx.selectFrom('organizations').select(['timezone', 'status']).where('id', '=', organizationId).executeTakeFirst();
  if (!org) throw errors.notFound('Organization', organizationId);
  const settings = await trx.selectFrom('organizationSettings').select('general').where('organizationId', '=', organizationId).executeTakeFirst();
  const fdw = asObject(settings?.general)['firstDayOfWeek'];
  return { timezone: isValidTimezone(org.timezone) ? org.timezone : 'UTC', firstDayOfWeek: typeof fdw === 'number' && fdw >= 0 && fdw <= 6 ? fdw : 0, active: org.status === 'active' || org.status === 'trial' };
}

function runStatus(counts: DeliveryCounts): 'success' | 'partial' | 'skipped' {
  if (counts.queued + counts.alreadyDelivered === 0) return 'skipped';
  return counts.skipped > 0 ? 'partial' : 'success';
}

/** One distribution run inside the organisation's system context (see the module comment). */
export async function runReportDelivery(trx: Trx, deps: Pick<WorkerDeps, 'queue' | 'now'>, p: ReportDeliveryPayload, jobId: string | null): Promise<DeliveryRunResult> {
  const now = deps.now();
  const timing = await orgTiming(trx, p.organizationId);
  if (p.mode === 'send_now') {
    const period = periodOfParameters(p.spec.parameters);
    const counts = await deliverRun(trx, deps.queue, {
      organizationId: p.organizationId, mode: 'send_now', scheduleId: null, runKey: p.runKey, reportType: p.spec.reportType, format: p.spec.format, parameters: p.spec.parameters,
      recipients: p.spec.recipients, channels: p.spec.channels, period, sentBy: p.requestedBy ?? null,
    });
    await writeAudit(trx, { organizationId: p.organizationId, actorUserId: p.requestedBy ?? null, actorType: 'SYSTEM', action: 'report.share_run', entityType: 'report_delivery', entityId: p.runKey, newValue: { ...counts, reportType: p.spec.reportType, period }, jobId });
    return { outcome: counts.queued + counts.alreadyDelivered > 0 ? 'delivered' : 'skipped', runKey: p.runKey, period, ...counts };
  }

  const s = await trx.selectFrom('reportSchedules').selectAll().where('organizationId', '=', p.organizationId).where('id', '=', p.scheduleId).forUpdate().executeTakeFirst();
  if (!s) return { outcome: 'skipped', reason: 'schedule_missing' };
  const scheduleTiming = { cadence: s.cadence as ReportScheduleCadence, runDay: s.runDay, runTime: String(s.runTime), timezone: timing.timezone };
  let occurrence: Date;
  let missed = 0;
  let runKey: string;
  if (p.mode === 'schedule') {
    if (!s.isActive || !s.nextRunAt) return { outcome: 'skipped', reason: 'inactive' };
    const stored = new Date(s.nextRunAt);
    if (stored.getTime() > now.getTime()) return { outcome: 'skipped', reason: 'not_due' };
    // the scheduler saw this occurrence; an edit or an earlier run moved it since — that run / the next tick owns it now
    if (Date.parse(p.scheduledFor) !== stored.getTime()) return { outcome: 'skipped', reason: 'stale' };
    const due = dueOccurrence(scheduleTiming, stored, now);
    occurrence = due.scheduledFor;
    missed = due.missed;
    runKey = `schedule:${s.id}:${occurrence.toISOString()}`;
  } else {
    occurrence = now;
    runKey = p.runKey;
  }
  const period = schedulePeriod({ periodRule: s.periodRule as ReportPeriodRule, customFromDay: s.customFromDay, customToDay: s.customToDay, firstDayOfWeek: timing.firstDayOfWeek }, occurrence, timing.timezone);
  const filters = asObject(s.filters);
  const parameters = { ...filters, ...periodParameters(s.reportType as ReportType, period) };
  const recipients = asObject(s.recipients);
  const sentBy = p.mode === 'manual' ? (p.requestedBy ?? s.updatedBy ?? s.createdBy) : (s.updatedBy ?? s.createdBy);

  let counts: DeliveryCounts | null = null;
  let failure: string | null = null;
  if (!timing.active) failure = 'The organisation is not active.';
  else {
    // a failed run must still advance the schedule (or every tick would retry it); roll the partial work back to a savepoint
    await sql`savepoint report_delivery_run`.execute(trx);
    try {
      counts = await deliverRun(trx, deps.queue, {
        organizationId: p.organizationId, mode: p.mode, scheduleId: s.id, runKey, reportType: s.reportType as ReportType, format: s.format, parameters,
        recipients: { userIds: toStrings(recipients['userIds']), roleKeys: toStrings(recipients['roleKeys']) }, channels: s.channels, period, sentBy,
      });
      await sql`release savepoint report_delivery_run`.execute(trx);
    } catch (err) {
      await sql`rollback to savepoint report_delivery_run`.execute(trx);
      failure = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    }
  }
  const status = counts ? runStatus(counts) : 'failed';
  const summary = { period, recipients: counts?.recipients ?? 0, queued: counts?.queued ?? 0, skipped: counts?.skipped ?? 0, failed: failure ? 1 : 0, alreadyDelivered: counts?.alreadyDelivered ?? 0, missedOccurrences: missed, mode: p.mode, runKey };
  const nextRunAt = p.mode === 'schedule' ? nextScheduleRun(scheduleTiming, now) : s.nextRunAt ? new Date(s.nextRunAt) : null;
  await trx.updateTable('reportSchedules').set({
    lastRunAt: now, lastStatus: status, lastError: failure, lastSummary: JSON.stringify(summary),
    ...(p.mode === 'schedule' ? { nextRunAt } : {}),
  }).where('id', '=', s.id).execute();
  await writeAudit(trx, { organizationId: p.organizationId, actorUserId: p.mode === 'manual' ? (p.requestedBy ?? null) : null, actorType: 'SYSTEM', action: 'report_schedule.run', entityType: 'report_schedule', entityId: s.id, branchId: s.branchId, newValue: { ...summary, status, nextRunAt: nextRunAt?.toISOString() ?? null }, jobId });
  return { outcome: failure ? 'failed' : counts && counts.queued + counts.alreadyDelivered > 0 ? 'delivered' : 'skipped', ...(failure ? { reason: failure } : {}), runKey, period, nextRunAt: nextRunAt?.toISOString() ?? null, ...(counts ?? {}) };
}

export async function runReportDeliveryHandler({ job, deps, log }: JobContext): Promise<DeliveryRunResult> {
  const p = parsePayload(reportDeliveryPayloadSchema, job.payload);
  if (job.organizationId && job.organizationId !== p.organizationId) throw errors.validation('The job organisation does not match the payload.');
  const res = await withContext(deps.db, { kind: 'system', organizationId: p.organizationId, jobId: job.id }, (trx) => runReportDelivery(trx, deps, p, job.id));
  log.info(event('report_delivery_run', { organizationId: p.organizationId, mode: p.mode, jobId: job.id, outcome: res.outcome, reason: res.reason ?? null, queued: res.queued ?? 0, skipped: res.skipped ?? 0 }));
  return res;
}

// ---- completion hook (called by generateReportRequest) -----------------------------------------------------------------------------

/**
 * After a delivered report's generation settles: mark the delivery and notify. Returns true when the request belonged to a
 * delivery (the generic `report.ready` / `report.failed` is then NOT emitted — the recipient did not ask for this report, so
 * success reaches them as `report.scheduled_delivery` and a failure reaches the person who shared / scheduled it).
 */
export async function settleDelivery(trx: Trx, organizationId: string, reportRequestId: string, outcome: { ok: true; reportTitle: string; rowCount: number } | { ok: false; error: string }, now: Date): Promise<boolean> {
  const d = await trx.selectFrom('reportDeliveries as d').leftJoin('reportSchedules as s', 's.id', 'd.scheduleId')
    .select(['d.id', 'd.recipientUserId', 'd.sentBy', 'd.mode', 'd.scheduleId', 's.name as scheduleName', 'd.channels', 'd.reportType', 'd.format', 'd.periodFrom', 'd.periodTo', 'd.scope'])
    .where('d.organizationId', '=', organizationId).where('d.reportRequestId', '=', reportRequestId).executeTakeFirst();
  if (!d) return false;
  const isoDay = (v: Date | string | null) => (v === null ? null : typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));
  if (outcome.ok) {
    await trx.updateTable('reportDeliveries').set({ status: 'delivered', deliveredAt: now, error: null }).where('id', '=', d.id).execute();
    await emitDomainEvent(trx, {
      organizationId, eventType: 'report.scheduled_delivery', aggregateType: 'report_request', aggregateId: reportRequestId,
      payload: {
        reportId: reportRequestId, deliveryId: d.id, reportType: d.reportType, reportTitle: outcome.reportTitle, format: d.format, rowCount: outcome.rowCount, mode: d.mode,
        scheduleId: d.scheduleId, scheduleName: d.scheduleName ?? null, periodFrom: isoDay(d.periodFrom), periodTo: isoDay(d.periodTo), channels: d.channels, userIds: [d.recipientUserId],
        // a copy about the recipient themselves opens in the employee portal (/my/reports), not on the Reports page they cannot open
        selfScope: asObject(d.scope)['kind'] === 'SELF',
      },
      actorUserId: d.sentBy,
    });
  } else {
    await trx.updateTable('reportDeliveries').set({ status: 'failed', error: outcome.error.slice(0, 2000) }).where('id', '=', d.id).execute();
    if (d.sentBy) await emitDomainEvent(trx, { organizationId, eventType: 'report.failed', aggregateType: 'report_request', aggregateId: reportRequestId, payload: { reportId: reportRequestId, reportType: d.reportType, error: outcome.error, userId: d.sentBy, deliveryId: d.id } });
  }
  return true;
}

/** A delivered copy whose report request was cancelled (by its recipient) settles as `cancelled`; true when one was settled. */
export async function settleCancelledDelivery(trx: Trx, organizationId: string, reportRequestId: string): Promise<boolean> {
  const res = await trx.updateTable('reportDeliveries').set({ status: 'cancelled' }).where('organizationId', '=', organizationId).where('reportRequestId', '=', reportRequestId).where('status', '=', 'queued').executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0n) > 0;
}

export function registerDeliveryHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: REPORT_DELIVERY_JOB_TYPE, handler: runReportDeliveryHandler, timeoutMs: 5 * 60_000 });
}
