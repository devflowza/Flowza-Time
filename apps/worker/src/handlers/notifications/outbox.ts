import { sql } from 'kysely';
import type { NotificationCategory } from '@flowza/contracts';
import { event } from '@flowza/shared';
import { withContext } from '@flowza/database';
import type { HandlerRegistry, JobContext } from '../types.js';

interface OutboxRow { id: string; organizationId: string | null; eventType: string; aggregateType: string; aggregateId: string | null; payload: Record<string, unknown>; actorUserId: string | null; occurredAt: Date }

/** Which users receive an in-app notification for an event type: by permission within the organisation. */
const ROUTING: Record<string, { category: NotificationCategory; permission: string; title: (p: Record<string, unknown>) => string; body?: (p: Record<string, unknown>) => string; link?: (p: Record<string, unknown>) => string }> = {
  'device.offline': { category: 'DEVICE', permission: 'device.view', title: (p) => `Device offline: ${String(p['deviceName'] ?? p['deviceId'] ?? '')}`, body: (p) => `No successful communication since ${String(p['lastSeenAt'] ?? 'unknown')}.`, link: (p) => `/devices/${String(p['deviceId'] ?? '')}` },
  'device.online': { category: 'DEVICE', permission: 'device.view', title: (p) => `Device back online: ${String(p['deviceName'] ?? '')}`, link: (p) => `/devices/${String(p['deviceId'] ?? '')}` },
  'sync.failed': { category: 'ATTENDANCE', permission: 'device.sync', title: (p) => `Sync failed: ${String(p['jobType'] ?? '')}`, body: (p) => String(p['error'] ?? ''), link: (p) => `/sync/${String(p['syncJobId'] ?? '')}` },
  'sync.completed': { category: 'ATTENDANCE', permission: 'device.sync', title: (p) => `Sync completed: ${String(p['jobType'] ?? '')}`, body: (p) => `${String(p['itemsSuccess'] ?? 0)} succeeded, ${String(p['itemsFailed'] ?? 0)} failed`, link: (p) => `/sync/${String(p['syncJobId'] ?? '')}` },
  'approval.pending': { category: 'APPROVAL', permission: 'attendance.approve', title: () => 'Correction awaiting your approval', link: () => '/approvals' },
  'attendance.correction_approved': { category: 'APPROVAL', permission: 'attendance.correct', title: () => 'Correction approved', link: (p) => `/attendance?employeeId=${String(p['employeeId'] ?? '')}` },
  'attendance.correction_rejected': { category: 'APPROVAL', permission: 'attendance.correct', title: () => 'Correction rejected', link: (p) => `/attendance?employeeId=${String(p['employeeId'] ?? '')}` },
  'report.ready': { category: 'SYSTEM', permission: 'report.view', title: (p) => `Report ready: ${String(p['reportType'] ?? '')}`, link: (p) => `/reports/${String(p['reportId'] ?? '')}` },
  'report.failed': { category: 'SYSTEM', permission: 'report.view', title: (p) => `Report failed: ${String(p['reportType'] ?? '')}`, body: (p) => String(p['error'] ?? '') },
  'employee.imported': { category: 'SYSTEM', permission: 'employee.import', title: (p) => `Import finished: ${String(p['imported'] ?? 0)} employees`, link: (p) => `/employees/imports/${String(p['importId'] ?? '')}` },
  'subscription.limit_reached': { category: 'SUBSCRIPTION', permission: 'organization.manage', title: (p) => `Plan limit reached: ${String(p['metric'] ?? '')}`, link: () => '/settings/subscription' },
};

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
      if (route && row.organizationId) {
        notifications += await (async () => {
          // recipients: active members whose role holds the permission (+ specific user in payload.userId)
          const recipients = await sql<{ userId: string }>`
            select distinct m.user_id as "userId" from public.org_memberships m
            join public.role_permissions rp on rp.role_id = m.role_id
            where m.organization_id = ${row.organizationId}::uuid and m.status = 'active' and rp.permission_key = ${route.permission}
            union select ${String(row.payload['userId'] ?? '00000000-0000-0000-0000-000000000000')}::uuid where ${row.payload['userId'] !== undefined}`.execute(trx);
          let created = 0;
          for (const r of recipients.rows) {
            // dedupe: same type + aggregate for the same user within 15 minutes (device flapping, repeated failures)
            const dup = await trx.selectFrom('notifications').select('id').where('userId', '=', r.userId).where('type', '=', row.eventType).where('createdAt', '>', new Date(deps.now().getTime() - 15 * 60_000))
              .where(sql`data->>'aggregateId'`, '=', row.aggregateId ?? '').executeTakeFirst();
            if (dup) continue;
            const inserted = await trx.insertInto('notifications').values({
              organizationId: row.organizationId, userId: r.userId, category: route.category, type: row.eventType, title: route.title(row.payload), body: route.body?.(row.payload) ?? null,
              link: route.link?.(row.payload) ?? null, data: JSON.stringify({ aggregateType: row.aggregateType, aggregateId: row.aggregateId, ...row.payload }),
            }).returning('id').executeTakeFirstOrThrow();
            created++;
            const pref = await trx.selectFrom('notificationPreferences').select('enabled').where('userId', '=', r.userId).where('organizationId', '=', row.organizationId!).where('category', '=', route.category).where('channel', '=', 'EMAIL').executeTakeFirst();
            if (pref?.enabled) await trx.insertInto('notificationDeliveries').values({ organizationId: row.organizationId, notificationId: inserted.id, channel: 'EMAIL', status: 'pending' }).execute();
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

/** Sends pending email deliveries (worker mailer), one batch per run. */
export async function deliverNotifications({ deps, log, job }: JobContext) {
  return withContext(deps.db, { kind: 'platform', jobId: job.id }, async (trx) => {
  const pending = await sql<{ id: string; organizationId: string | null; notificationId: string; title: string; body: string | null; email: string; link: string | null }>`
    select d.id, d.organization_id as "organizationId", d.notification_id as "notificationId", n.title, n.body, n.link, u.email
    from public.notification_deliveries d join public.notifications n on n.id = d.notification_id join public.user_profiles u on u.id = n.user_id
    where d.status = 'pending' and d.channel = 'EMAIL' order by d.created_at limit ${Number(job.payload['batchSize'] ?? 100)} for update of d skip locked`.execute(trx);
  let sent = 0;
  for (const d of pending.rows) {
    try {
      const link = d.link ? `${deps.config.WEB_PUBLIC_URL}${d.link}` : deps.config.WEB_PUBLIC_URL;
      const res = await deps.mailer.send({ to: d.email, subject: `[FlowZa Time] ${d.title}`, html: `<p>${escapeHtml(d.title)}</p>${d.body ? `<p>${escapeHtml(d.body)}</p>` : ''}<p><a href="${link}">Open FlowZa Time</a></p>`, text: `${d.title}\n${d.body ?? ''}\n${link}` });
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
