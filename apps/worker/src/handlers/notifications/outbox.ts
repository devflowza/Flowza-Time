import { sql } from 'kysely';
import type { NotificationCategory } from '@flowza/contracts';
import { event } from '@flowza/shared';
import { applyContext, issueApprovalEmailTokens, withContext } from '@flowza/database';
import type { HandlerRegistry, JobContext } from '../types.js';

interface OutboxRow { id: string; organizationId: string | null; eventType: string; aggregateType: string; aggregateId: string | null; payload: Record<string, unknown>; actorUserId: string | null; occurredAt: Date }

type Payload = Record<string, unknown>;
/**
 * Who receives an in-app notification for an event type:
 *  - `permission` (default): active members whose role holds `permission` (+ `payload.userId` when present);
 *  - `user`: exactly `payload.userId`;
 *  - `users`: exactly `payload.userIds` — the approval engine's targeted notifications (the resolved approvers of a
 *    level, the requester and the person concerned), filtered to ACTIVE members of the organisation.
 * `when` filters events that are published (realtime, webhooks) but must not become notifications.
 */
interface Route { category: NotificationCategory; permission?: string; recipients?: 'permission' | 'user' | 'users'; when?: (p: Payload) => boolean; title: (p: Payload) => string; body?: (p: Payload) => string; link?: (p: Payload) => string }

const ENTITY_LABELS: Record<string, string> = {
  ATTENDANCE_CORRECTION: 'Attendance correction', LEAVE: 'Leave request', OVERTIME: 'Overtime', MISSING_PUNCH: 'Missing punch', SHIFT_CHANGE: 'Shift change', MANUAL_ATTENDANCE: 'Manual attendance',
  ATTENDANCE_NOTE: 'Attendance note', SHIFT_SWAP: 'Shift swap', COMP_OFF: 'Compensatory off', REGULARISATION: 'Regularisation', OVERTIME_CLAIM: 'Overtime claim',
};
/** "Leave request — Employee 5" (the entity and who it is about; ids only when no name was resolved). */
export function approvalLabel(p: Payload): string {
  const what = ENTITY_LABELS[String(p['entityType'] ?? '')] ?? 'Request';
  return p['employeeName'] ? `${what} — ${String(p['employeeName'])}` : what;
}
const requestLink = (p: Payload) => `/approvals/requests/${String(p['requestId'] ?? '')}`;
const DECISION_WORDS: Record<string, string> = { APPROVED: 'approved', REJECTED: 'rejected', CANCELLED: 'withdrawn', INVALIDATED: 'invalidated (changed while pending)' };

const ROUTING: Record<string, Route> = {
  // Day-close sweep (HR portal Prompt 3): one event per (employee, run). `recipients: 'users'` = exactly the logins the
  // emitter resolved into payload.userIds (the employee + the managers holding attendance.approve), re-checked against
  // active memberships of the organisation here — never every attendance.approve holder for every employee-day.
  'attendance.unexcused_marked': { category: 'ATTENDANCE', permission: 'attendance.approve', recipients: 'users', title: (p) => `${Number(p['count'] ?? 0) === 1 ? 'An attendance day' : `${String(p['count'] ?? 0)} attendance days`} marked unexcused`, body: (p) => `${Array.isArray(p['dates']) ? (p['dates'] as string[]).slice(0, 5).join(', ') : ''}${Array.isArray(p['dates']) && (p['dates'] as string[]).length > 5 ? ', …' : ''}${p['autoDeduct'] === true ? ' · pay effect applied per policy' : ''}`, link: (p) => `/attendance?employeeId=${String(p['employeeId'] ?? '')}` },
  'device.offline': { category: 'DEVICE', permission: 'device.view', title: (p) => `Device offline: ${String(p['deviceName'] ?? p['deviceId'] ?? '')}`, body: (p) => `No successful communication since ${String(p['lastSeenAt'] ?? 'unknown')}.`, link: (p) => `/devices/${String(p['deviceId'] ?? '')}` },
  'device.online': { category: 'DEVICE', permission: 'device.view', title: (p) => `Device back online: ${String(p['deviceName'] ?? '')}`, link: (p) => `/devices/${String(p['deviceId'] ?? '')}` },
  'sync.failed': { category: 'ATTENDANCE', permission: 'device.sync', title: (p) => `Sync failed: ${String(p['jobType'] ?? '')}`, body: (p) => String(p['error'] ?? ''), link: (p) => `/sync/${String(p['syncJobId'] ?? '')}` },
  // Flowza Finance connector: emitted once per failure streak (3 consecutive pull/push failures) and when a batch Finance kept
  // rejecting is skipped. Routed to integration.manage holders — the people who can open /settings/integrations and act (replace
  // the token, fix the base URL); device.sync-only roles would get a link to a page they cannot open, so they get nothing.
  'sync.finance.failed': { category: 'ATTENDANCE', permission: 'integration.manage', title: (p) => (p['reason'] === 'batch_skipped' ? 'Flowza Finance push skipped punches it could not store' : `Flowza Finance ${String(p['direction'] ?? 'sync')} is failing`), body: (p) => `${String(p['consecutiveFailures'] ?? 0)} consecutive failures · ${String(p['code'] ?? '')}: ${String(p['error'] ?? '')}`, link: () => '/settings/integrations' },
  // Only a sync somebody asked for is worth a notification. The scheduler completes a health check per device every few
  // minutes and a poll per device per interval; routing those to every device.sync holder produced a notification (and an
  // e-mail) each time, hundreds a day per tenant. Failures keep notifying regardless of who started the sync.
  'sync.completed': { category: 'ATTENDANCE', permission: 'device.sync', when: (p) => p['trigger'] === 'MANUAL' && p['jobType'] !== 'DEVICE_HEALTH_CHECK', title: (p) => `Sync completed: ${String(p['jobType'] ?? '')}`, body: (p) => `${String(p['itemsSuccess'] ?? 0)} succeeded, ${String(p['itemsFailed'] ?? 0)} failed`, link: (p) => `/sync/${String(p['syncJobId'] ?? '')}` },
  // Approval engine v2: every approval notification is TARGETED (payload.userIds) — the resolved approvers of the level,
  // never every holder of a permission. One-click approve / reject links are added to the e-mail of approval.pending /
  // approval.escalated / a single-request reminder (deliverNotifications).
  'approval.pending': { category: 'APPROVAL', recipients: 'users', title: (p) => `${approvalLabel(p)} awaiting your approval`, body: (p) => (p['summary'] ? String(p['summary']) : `Level ${String(p['stepNo'] ?? 1)}`), link: requestLink },
  'approval.reminder': { category: 'APPROVAL', recipients: 'users', title: (p) => (p['kind'] === 'digest' ? `${String(p['total'] ?? 0)} approval${Number(p['total']) === 1 ? '' : 's'} waiting for you` : `Reminder: ${approvalLabel(p)} is waiting for you`), body: (p) => (p['kind'] === 'digest' ? (Array.isArray(p['counts']) ? (p['counts'] as Array<{ entityType?: string; count?: number }>) : []).map((c) => `${ENTITY_LABELS[String(c.entityType)] ?? String(c.entityType)}: ${String(c.count ?? 0)}`).join(' · ') : `Waiting since ${String(p['waitingSince'] ?? '')}`), link: (p) => (p['kind'] === 'digest' ? '/approvals' : requestLink(p)) },
  'approval.escalated': { category: 'APPROVAL', recipients: 'users', title: (p) => `Escalated to you: ${approvalLabel(p)}`, body: (p) => `Level ${String(p['stepNo'] ?? '')} was not decided in time`, link: requestLink },
  'approval.decided': { category: 'APPROVAL', recipients: 'users', title: (p) => `${approvalLabel(p)} ${DECISION_WORDS[String(p['decision'] ?? '')] ?? 'decided'}`, body: (p) => (p['comment'] ? String(p['comment']) : ''), link: requestLink },
  'approval.info_requested': { category: 'APPROVAL', recipients: 'users', title: (p) => `More information requested: ${approvalLabel(p)}`, body: (p) => String(p['comment'] ?? ''), link: requestLink },
  'approval.info_answered': { category: 'APPROVAL', recipients: 'users', title: (p) => `Information provided: ${approvalLabel(p)}`, body: (p) => String(p['comment'] ?? ''), link: requestLink },
  'approval.reassigned': { category: 'APPROVAL', recipients: 'users', title: (p) => `${approvalLabel(p)} was reassigned`, body: (p) => String(p['reason'] ?? ''), link: requestLink },
  // an approval.manage holder approved the request as an exception: the approvers who were waiting are told it no longer needs them
  'approval.bypassed': { category: 'APPROVAL', recipients: 'users', title: (p) => `${approvalLabel(p)} approved as an exception`, body: (p) => `No action needed from you. Reason: ${String(p['reason'] ?? '')}`, link: requestLink },
  'attendance.correction_approved': { category: 'APPROVAL', permission: 'attendance.correct', title: () => 'Correction approved', link: (p) => `/attendance?employeeId=${String(p['employeeId'] ?? '')}` },
  'attendance.correction_rejected': { category: 'APPROVAL', permission: 'attendance.correct', title: () => 'Correction rejected', link: (p) => `/attendance?employeeId=${String(p['employeeId'] ?? '')}` },
  // Self-service leave: HR hears about a request only when the approval engine did not route it (older rows); the engine's
  // approval.pending reaches the actual approvers instead. The employee (payload.userId) hears about the decision.
  'leave.requested': { category: 'APPROVAL', permission: 'leave.manage', when: (p) => !p['approvalRequestId'], title: (p) => `Leave request from ${String(p['employeeName'] ?? 'an employee')}`, body: (p) => `${String(p['leaveTypeName'] ?? 'Leave')} · ${String(p['startDate'] ?? '')} → ${String(p['endDate'] ?? '')}`, link: () => '/leave?status=PENDING' },
  'leave.approved': { category: 'APPROVAL', permission: 'leave.request', recipients: 'user', title: (p) => `Leave approved: ${String(p['leaveTypeName'] ?? '')}`, body: (p) => `${String(p['startDate'] ?? '')} → ${String(p['endDate'] ?? '')}${p['decisionNote'] ? ` · ${String(p['decisionNote'])}` : ''}`, link: () => '/my/leave' },
  'leave.rejected': { category: 'APPROVAL', permission: 'leave.request', recipients: 'user', title: (p) => `Leave not approved: ${String(p['leaveTypeName'] ?? '')}`, body: (p) => `${String(p['startDate'] ?? '')} → ${String(p['endDate'] ?? '')}${p['decisionNote'] ? ` · ${String(p['decisionNote'])}` : ''}`, link: () => '/my/leave' },
  // A report belongs to whoever asked for it. Routing by permission sent every report.view holder a notification (and
  // the report's title) for every report anyone in the organisation requested.
  'report.ready': { category: 'SYSTEM', permission: 'report.view', recipients: 'user', title: (p) => `Report ready: ${String(p['reportTitle'] ?? p['reportType'] ?? '')}`, link: () => '/reports' },
  'report.failed': { category: 'SYSTEM', permission: 'report.view', recipients: 'user', title: (p) => `Report failed: ${String(p['reportTitle'] ?? p['reportType'] ?? '')}`, body: (p) => String(p['error'] ?? ''), link: () => '/reports' },
  'employee.imported': { category: 'SYSTEM', permission: 'employee.import', title: (p) => `Import finished: ${String(p['imported'] ?? 0)} employees`, link: (p) => `/employees/imports/${String(p['importId'] ?? '')}` },
  'subscription.limit_reached': { category: 'SUBSCRIPTION', permission: 'organization.manage', title: (p) => `Plan limit reached: ${String(p['metric'] ?? '')}`, link: () => '/settings/subscription' },
};

/** Approval notifications whose e-mail carries one-click approve / reject links for the recipient. */
const ONE_CLICK_TYPES = new Set(['approval.pending', 'approval.escalated', 'approval.reminder']);

/** Realtime channel + event for invalidation signals (payload = ids only). */
function realtimeTarget(row: OutboxRow): { channel: string; event: string } | null {
  if (!row.organizationId) return null;
  if (row.eventType.startsWith('sync.')) return { channel: `org:${row.organizationId}:sync`, event: row.eventType };
  if (row.eventType.startsWith('device.')) return { channel: `org:${row.organizationId}:devices`, event: row.eventType };
  if (row.eventType.startsWith('attendance.') || row.eventType.startsWith('approval.')) return { channel: `org:${row.organizationId}:attendance`, event: row.eventType };
  return null;
}

/**
 * Outbox relay (transactional outbox, ADR-004/§53): reads unpublished domain events in order, creates in-app notifications
 * for entitled users (deduped per device state within 15 min), queues email deliveries per preference, and broadcasts a
 * coalesced invalidation signal per channel. Marks events published; failures are retried by the next relay run.
 */
export async function relayOutbox({ deps, log, job }: JobContext) {
  const batch = Number(job.payload['batchSize'] ?? 200);
  return withContext(deps.db, { kind: 'platform', jobId: job.id }, async (trx) => {
  const rows = await sql<OutboxRow>`select id, organization_id as "organizationId", event_type as "eventType", aggregate_type as "aggregateType", aggregate_id as "aggregateId", payload, actor_user_id as "actorUserId", occurred_at as "occurredAt"
    from public.domain_events where published_at is null order by id asc limit ${batch} for update skip locked`.execute(trx);
  if (rows.rows.length === 0) return { relayed: 0, notifications: 0 };
  const coalesced = new Map<string, { channel: string; event: string; ids: string[] }>();
  let notifications = 0;
  for (const row of rows.rows) {
    try {
      const route = ROUTING[row.eventType];
      if (route && row.organizationId && (route.when?.(row.payload) ?? true)) {
        notifications += await (async () => {
          // recipients: active members whose role holds the permission (+ specific user in payload.userId), exactly
          // payload.userId, or exactly payload.userIds (targeted notifications — approvals, day-close sweep); the explicit
          // list is kept to active members of the organisation, so a stale id notifies nobody
          const userIds = Array.isArray(row.payload['userIds']) ? (row.payload['userIds'] as unknown[]).filter((u): u is string => typeof u === 'string' && /^[0-9a-f-]{36}$/i.test(u)) : [];
          const recipients = route.recipients === 'users'
            ? (userIds.length === 0 ? { rows: [] as Array<{ userId: string }> } : await sql<{ userId: string }>`
            select distinct m.user_id as "userId" from public.org_memberships m
            where m.organization_id = ${row.organizationId}::uuid and m.status = 'active' and m.user_id = any(${userIds}::uuid[])`.execute(trx))
            : route.recipients === 'user'
            ? await sql<{ userId: string }>`select ${String(row.payload['userId'] ?? '00000000-0000-0000-0000-000000000000')}::uuid as "userId" where ${typeof row.payload['userId'] === 'string'}`.execute(trx)
            : await sql<{ userId: string }>`
            select distinct m.user_id as "userId" from public.org_memberships m
            join public.role_permissions rp on rp.role_id = m.role_id
            where m.organization_id = ${row.organizationId}::uuid and m.status = 'active' and rp.permission_key = ${route.permission ?? ''}
            union select ${String(row.payload['userId'] ?? '00000000-0000-0000-0000-000000000000')}::uuid where ${row.payload['userId'] !== undefined}`.execute(trx);
          let created = 0;
          for (const r of recipients.rows) {
            // dedupe: same type + aggregate for the same user within 15 minutes (device flapping, repeated failures). Targeted
            // approval events are deliberate, one per transition (level 2 after level 1, a second question), so they are not.
            if (route.recipients !== 'users') {
              const dup = await trx.selectFrom('notifications').select('id').where('userId', '=', r.userId).where('type', '=', row.eventType).where('createdAt', '>', new Date(deps.now().getTime() - 15 * 60_000))
                .where(sql`data->>'aggregateId'`, '=', row.aggregateId ?? '').executeTakeFirst();
              if (dup) continue;
            }
            const inserted = await trx.insertInto('notifications').values({
              organizationId: row.organizationId, userId: r.userId, category: route.category, type: row.eventType, title: route.title(row.payload), body: route.body?.(row.payload) ?? null,
              link: route.link?.(row.payload) ?? null, data: JSON.stringify({ aggregateType: row.aggregateType, aggregateId: row.aggregateId, ...row.payload }),
            }).returning('id').executeTakeFirstOrThrow();
            created++;
            const pref = await trx.selectFrom('notificationPreferences').select('enabled').where('userId', '=', r.userId).where('organizationId', '=', row.organizationId!).where('category', '=', route.category).where('channel', '=', 'EMAIL').executeTakeFirst();
            // Absent means on. These are operational alerts — a device offline, a sync failure, a report ready — routed
            // only to users whose role already carries the matching permission, so the audience is staff who need to
            // act. Requiring a row first made the whole channel unreachable: nothing in the application writes
            // notification_preferences, so the only way to opt in was by hand in SQL. An explicit row still wins, so a
            // preferences screen can turn this off per user, per organisation, per category without touching this.
            if (pref?.enabled ?? true) await trx.insertInto('notificationDeliveries').values({ organizationId: row.organizationId, notificationId: inserted.id, channel: 'EMAIL', status: 'pending' }).execute();
          }
          return created;
        })();
      }
      const target = realtimeTarget(row);
      if (target) {
        const key = `${target.channel}|${target.event}`;
        const c = coalesced.get(key) ?? { ...target, ids: [] };
        if (row.aggregateId) c.ids.push(row.aggregateId);
        coalesced.set(key, c);
      }
      await sql`update public.domain_events set published_at = now(), publish_attempts = publish_attempts + 1 where id = ${row.id}::bigint`.execute(trx);
    } catch (err) {
      await sql`update public.domain_events set publish_attempts = publish_attempts + 1, publish_error = ${String((err as Error).message).slice(0, 500)} where id = ${row.id}::bigint`.execute(trx);
      log.warn(event('outbox_relay_failed', { eventId: row.id, err: (err as Error).message }));
    }
  }
  for (const c of coalesced.values()) await deps.realtime.publish(c.channel, c.event, { ids: c.ids.slice(0, 200), count: c.ids.length, at: deps.now().toISOString() });
  log.info(event('outbox_relayed', { events: rows.rows.length, notifications, channels: coalesced.size }));
  return { relayed: rows.rows.length, notifications };
  });
}

/**
 * The approve / reject links of an approval e-mail: a fresh token pair for THIS recipient and THIS level, minted in the
 * organisation's system context (the token table is system-only). Returns null when the level is no longer waiting for
 * the recipient (decided, withdrawn, reassigned) — the e-mail then only links to the request.
 */
async function oneClickLinks(trx: Parameters<typeof applyContext>[0], deps: JobContext['deps'], d: { organizationId: string; userId: string; type: string; data: Record<string, unknown> }): Promise<{ approve: string; reject: string } | null> {
  if (!ONE_CLICK_TYPES.has(d.type) || d.data['kind'] === 'digest') return null;
  const requestId = typeof d.data['requestId'] === 'string' ? d.data['requestId'] : typeof d.data['aggregateId'] === 'string' ? d.data['aggregateId'] : null;
  if (!requestId) return null;
  await applyContext(trx, { kind: 'system', organizationId: d.organizationId });
  try {
    const step = await trx.selectFrom('approvalSteps as s').innerJoin('approvalRequests as r', 'r.id', 's.requestId').innerJoin('approvalStepActors as a', 'a.stepId', 's.id')
      .select(['s.id as stepId', 'r.id as requestId']).where('r.id', '=', requestId).where('r.status', '=', 'PENDING').where('s.status', '=', 'PENDING').whereRef('s.stepNo', '=', 'r.currentStep')
      .where('a.userId', '=', d.userId).where('a.decision', '=', 'PENDING').executeTakeFirst();
    if (!step) return null;
    const pair = await issueApprovalEmailTokens(trx, { organizationId: d.organizationId, requestId: step.requestId, stepId: step.stepId, userId: d.userId }, { now: deps.now() });
    const base = `${deps.config.WEB_PUBLIC_URL}/approvals/email-action?org=${encodeURIComponent(d.organizationId)}`;
    return { approve: `${base}&action=APPROVE&token=${encodeURIComponent(pair.approve)}`, reject: `${base}&action=REJECT&token=${encodeURIComponent(pair.reject)}` };
  } finally {
    await applyContext(trx, { kind: 'platform' });
  }
}

/** Sends pending email deliveries (worker mailer), one batch per run. */
export async function deliverNotifications({ deps, log, job }: JobContext) {
  return withContext(deps.db, { kind: 'platform', jobId: job.id }, async (trx) => {
  const pending = await sql<{ id: string; organizationId: string | null; notificationId: string; title: string; body: string | null; email: string; link: string | null; userId: string; type: string; data: unknown }>`
    select d.id, d.organization_id as "organizationId", d.notification_id as "notificationId", n.title, n.body, n.link, u.email, n.user_id as "userId", n.type, n.data
    from public.notification_deliveries d join public.notifications n on n.id = d.notification_id join public.user_profiles u on u.id = n.user_id
    where d.status = 'pending' and d.channel = 'EMAIL' order by d.created_at limit ${Number(job.payload['batchSize'] ?? 100)} for update of d skip locked`.execute(trx);
  let sent = 0;
  for (const d of pending.rows) {
    try {
      const link = d.link ? `${deps.config.WEB_PUBLIC_URL}${d.link}` : deps.config.WEB_PUBLIC_URL;
      const data = (d.data && typeof d.data === 'object' ? d.data : {}) as Record<string, unknown>;
      const oneClick = d.organizationId ? await oneClickLinks(trx, deps, { organizationId: d.organizationId, userId: d.userId, type: d.type, data }) : null;
      const actionsHtml = oneClick ? `<p><a href="${escapeHtml(oneClick.approve)}">Approve</a> · <a href="${escapeHtml(oneClick.reject)}">Reject</a></p><p style="color:#667085;font-size:12px">You will be asked to confirm in FlowZa Time. The links work once and expire in 7 days.</p>` : '';
      const actionsText = oneClick ? `\nApprove: ${oneClick.approve}\nReject: ${oneClick.reject}\n` : '';
      const res = await deps.mailer.send({ to: d.email, subject: `[FlowZa Time] ${d.title}`, html: `<p>${escapeHtml(d.title)}</p>${d.body ? `<p>${escapeHtml(d.body)}</p>` : ''}${actionsHtml}<p><a href="${escapeHtml(link)}">Open FlowZa Time</a></p>`, text: `${d.title}\n${d.body ?? ''}${actionsText}\n${link}` });
      await sql`update public.notification_deliveries set status = 'sent', provider = ${res.provider}, provider_message_id = ${res.id}, sent_at = now(), attempts = attempts + 1 where id = ${d.id}::bigint`.execute(trx);
      sent++;
    } catch (err) {
      await sql`update public.notification_deliveries set status = case when attempts >= 4 then 'failed'::public.delivery_status else 'pending'::public.delivery_status end, attempts = attempts + 1, error = ${String((err as Error).message).slice(0, 500)} where id = ${d.id}::bigint`.execute(trx);
    }
  }
  if (pending.rows.length) log.info(event('notifications_delivered', { attempted: pending.rows.length, sent }));
  return { attempted: pending.rows.length, sent };
  });
}

function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c); }

export function registerNotificationHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'RELAY_OUTBOX', handler: relayOutbox, timeoutMs: 120_000 });
  registry.register({ jobType: 'DELIVER_NOTIFICATIONS', handler: deliverNotifications, timeoutMs: 120_000 });
}
