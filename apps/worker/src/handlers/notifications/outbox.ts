import { sql } from 'kysely';
import {
  decideNotificationChannels, notificationData, notificationEntry, notificationReaders, resolveNotification, resolveNotificationSettings,
  type NotificationAudience, type NotificationDeliveryChannel, type NotificationSettings, type Permission,
} from '@flowza/contracts';
import { event, isValidTimezone } from '@flowza/shared';
import { applyContext, issueApprovalEmailTokens, withContext, type Trx } from '@flowza/database';
import type { HandlerRegistry, JobContext } from '../types.js';
import { pickLocale, renderEmail, renderNotification } from './templates/render.js';
import { MISSING_PUNCH_REMINDER_JOB_TYPE, missingPunchRemindersHandler } from './missing-punch.js';
import { NOTIFICATION_RETENTION_JOB_TYPE, notificationRetentionHandler } from './retention.js';

interface OutboxRow { id: string; organizationId: string | null; eventType: string; aggregateType: string; aggregateId: string | null; payload: Record<string, unknown>; actorUserId: string | null; occurredAt: Date; publishAttempts: number }

type Payload = Record<string, unknown>;
const R = notificationReaders;

/**
 * WHO receives a notification of an event type. HOW it is composed, localised, linked and delivered is the notification
 * catalogue (@flowza/contracts `NOTIFICATION_CATALOGUE`: category, template, deep link, channels, organisation switch) and
 * the templates next to this file; a test fails when a type here has no catalogue entry or no template (and the reverse).
 *  - `permission` (default): active members whose role holds `permission` (+ `payload.userId` when present);
 *  - `user`: exactly `payload.userId`;
 *  - `users`: exactly `payload.userIds` — targeted notifications (the approval engine's resolved approvers of a level, the
 *    requester and the person concerned; the day-close sweep's employee and managers; the portal's notices).
 * Every list is kept to ACTIVE members of the organisation, so a stale or foreign id notifies nobody. `when` filters events
 * that are published (realtime, webhooks) but must not become notifications.
 */
export interface NotificationRouteSpec { permission?: Permission; recipients?: 'permission' | 'user' | 'users'; when?: (p: Payload) => boolean }

export const ROUTING: Readonly<Record<string, NotificationRouteSpec>> = {
  // Day-close sweep (HR portal Prompt 3): one event per (employee, run); payload.userIds = the employee + the managers
  // holding attendance.approve (never every attendance.approve holder for every employee-day).
  'attendance.unexcused_marked': { permission: 'attendance.approve', recipients: 'users' },
  'device.offline': { permission: 'device.view' },
  'device.online': { permission: 'device.view' },
  'sync.failed': { permission: 'device.sync' },
  // Flowza Finance connector: routed to integration.manage holders — the people who can open /settings/integrations and act
  // (device.sync-only roles would get a link to a page they cannot open).
  'sync.finance.failed': { permission: 'integration.manage' },
  // Only a sync somebody asked for is worth a notification: the scheduler completes a health check per device every few
  // minutes and a poll per device per interval. Failures keep notifying regardless of who started the sync.
  'sync.completed': { permission: 'device.sync', when: (p) => p['trigger'] === 'MANUAL' && p['jobType'] !== 'DEVICE_HEALTH_CHECK' },
  // Approval engine v2: every approval notification is TARGETED — the resolved approvers of the level, never every holder
  // of a permission.
  'approval.pending': { recipients: 'users' },
  'approval.reminder': { recipients: 'users' },
  'approval.escalated': { recipients: 'users' },
  'approval.decided': { recipients: 'users' },
  'approval.info_requested': { recipients: 'users' },
  'approval.info_answered': { recipients: 'users' },
  'approval.reassigned': { recipients: 'users' },
  // an approval.manage holder approved the request as an exception: the approvers who were waiting are told it no longer needs them
  'approval.bypassed': { recipients: 'users' },
  'attendance.correction_approved': { permission: 'attendance.correct' },
  'attendance.correction_rejected': { permission: 'attendance.correct' },
  // Self-service leave: HR hears about a request only when the approval engine did not route it (older rows); the engine's
  // approval.pending reaches the actual approvers instead. The employee (payload.userId) hears about the decision.
  'leave.requested': { permission: 'leave.manage', when: (p) => !p['approvalRequestId'] },
  'leave.approved': { permission: 'leave.request', recipients: 'user' },
  'leave.rejected': { permission: 'leave.request', recipients: 'user' },
  // Leave v2 (Prompt 7): a comment reaches the other side of the thread (targeted); the year close tells every leave.manage
  // holder (and the HR user who queued it); an expired comp-off credit tells the employee. Prompt 8: an approver's question
  // on a leave request reaches the employee it is for (targeted).
  'leave.info_requested': { recipients: 'users' },
  'leave.comment_added': { recipients: 'users' },
  'leave.year_closed': { permission: 'leave.manage' },
  'leave.comp_off_expired': { permission: 'leave.request', recipients: 'user' },
  // A report belongs to whoever asked for it (routing by permission told every report.view holder about every report).
  'report.ready': { permission: 'report.view', recipients: 'user' },
  'report.failed': { permission: 'report.view', recipients: 'user' },
  'employee.imported': { permission: 'employee.import' },
  'subscription.limit_reached': { permission: 'organization.manage' },
  // Report sharing / schedules (Prompt 6a): one event per recipient copy, generated under that recipient's own scope. The
  // link opens Reports, which downloads through the recipient's session — no bearer link is ever mailed. payload.channels
  // chooses in-app and/or e-mail.
  'report.scheduled_delivery': { permission: 'report.view', recipients: 'users' },
  // Employee portal attendance (Prompt 4): payload.userIds is resolved by the API (the employee's own login for decisions and
  // questions, the line managers for reasons / selfies / flagged punches, the colleague named in a swap).
  'attendance.note_submitted': { recipients: 'users' },
  'attendance.note_decided': { recipients: 'users' },
  'attendance.note_info_requested': { recipients: 'users' },
  'attendance.selfie_submitted': { recipients: 'users' },
  'attendance.selfie_decided': { recipients: 'users' },
  'attendance.punch_flagged': { recipients: 'users' },
  'attendance.regularisation_decided': { recipients: 'users' },
  'shift.swap_requested': { recipients: 'users' },
  'shift.swap_decided': { recipients: 'users' },
  // Prompt 8: the missing check-out reminder (worker task attendance.missing-punch-reminder), the employee's own login.
  'punch.missing_out': { recipients: 'users' },
};

/** An event failing this many relay runs is left unpublished (visible, never purged) and no longer retried. */
export const MAX_PUBLISH_ATTEMPTS = 20;
/** Targeted recipient lists are bounded (an event names people, not a population). */
const MAX_TARGETED_RECIPIENTS = 500;
/** Same type + aggregate for the same user within this window is one notification (device flapping, repeated failures). */
const DEDUPE_WINDOW_MS = 15 * 60_000;

/** Realtime channel + event for invalidation signals (payload = ids only). */
function realtimeTarget(row: OutboxRow): { channel: string; event: string } | null {
  if (!row.organizationId) return null;
  if (row.eventType.startsWith('sync.')) return { channel: `org:${row.organizationId}:sync`, event: row.eventType };
  if (row.eventType.startsWith('device.')) return { channel: `org:${row.organizationId}:devices`, event: row.eventType };
  if (row.eventType.startsWith('attendance.') || row.eventType.startsWith('approval.')) return { channel: `org:${row.organizationId}:attendance`, event: row.eventType };
  return null;
}

/**
 * Channels an event asks for (`payload.channels`, HR portal Prompt 6a report deliveries): absent = both, as every other routed
 * event has always been delivered; the catalogue, the organisation switch and the recipient's preferences still apply on top.
 */
export function channelsOf(payload: Record<string, unknown>): { inApp: boolean; email: boolean } {
  const raw = payload['channels'];
  if (!Array.isArray(raw)) return { inApp: true, email: true };
  return { inApp: raw.includes('in_app'), email: raw.includes('email') };
}

interface OrgFacts { displayName: string; locale: string; timezone: string; settings: NotificationSettings }
async function loadOrgFacts(trx: Trx, orgId: string): Promise<OrgFacts | null> {
  const org = await trx.selectFrom('organizations').select(['displayName', 'locale', 'timezone']).where('id', '=', orgId).executeTakeFirst();
  if (!org) return null;
  // organization_settings is not on the platform whitelist; this SECURITY DEFINER reader exposes the notifications group only
  const s = await sql<{ settings: unknown }>`select app.organization_notification_settings(${orgId}::uuid) as settings`.execute(trx);
  return { displayName: org.displayName, locale: org.locale, timezone: isValidTimezone(org.timezone) ? org.timezone : 'UTC', settings: resolveNotificationSettings(s.rows[0]?.settings) };
}

interface Recipient { userId: string; employeeId: string | null; locale: string; profileStatus: string }
/** The recipients of an event per its route, kept to active members of the organisation (one query for their facts). */
async function recipientsOf(trx: Trx, route: NotificationRouteSpec, row: OutboxRow): Promise<Recipient[]> {
  const orgId = row.organizationId!;
  const one = R.id(row.payload['userId']);
  let ids: string[] = [];
  if (route.recipients === 'users') {
    ids = (Array.isArray(row.payload['userIds']) ? (row.payload['userIds'] as unknown[]) : []).map(R.id).filter((u): u is string => u !== null).slice(0, MAX_TARGETED_RECIPIENTS);
  } else if (route.recipients === 'user') {
    ids = one ? [one] : [];
  } else {
    const holders = await sql<{ userId: string }>`
      select distinct m.user_id as "userId" from public.org_memberships m
      join public.role_permissions rp on rp.role_id = m.role_id
      where m.organization_id = ${orgId}::uuid and m.status = 'active' and rp.permission_key = ${route.permission ?? ''}`.execute(trx);
    ids = [...holders.rows.map((h) => h.userId), ...(one ? [one] : [])];
  }
  ids = [...new Set(ids)];
  if (ids.length === 0) return [];
  const rows = await sql<Recipient>`
    select m.user_id as "userId", m.employee_id as "employeeId", p.locale, p.status as "profileStatus"
    from public.org_memberships m join public.user_profiles p on p.id = m.user_id
    where m.organization_id = ${orgId}::uuid and m.status = 'active' and m.user_id = any(${ids}::uuid[])
    order by m.user_id`.execute(trx);
  return rows.rows;
}

/** The recipient is the person the event is about (their membership is linked to `payload.employeeId`). */
function audienceOf(recipientEmployeeId: string | null, subjectEmployeeId: unknown): NotificationAudience {
  const subject = R.id(subjectEmployeeId);
  return recipientEmployeeId !== null && subject !== null && recipientEmployeeId.toLowerCase() === subject ? 'subject' : 'other';
}

interface RelayCounters { notifications: number; emails: number; suppressed: number }

/**
 * One event → its notifications: for every recipient the catalogue resolves the variant, category, organisation switch and
 * link, the channel decision applies the switch and the recipient's preferences, the texts are rendered in the recipient's
 * language, and the in-app row (plus a pending e-mail delivery) is written. A notice the recipient receives by e-mail only
 * is stored with `in_app = false` (and read) — the e-mail's content and trail, not an inbox item.
 */
async function notify(trx: Trx, deps: JobContext['deps'], orgs: Map<string, OrgFacts | null>, row: OutboxRow, counters: RelayCounters, log: JobContext['log']): Promise<void> {
  const route = ROUTING[row.eventType];
  if (!route || !row.organizationId || !(route.when?.(row.payload) ?? true)) return;
  const entry = notificationEntry(row.eventType);
  if (!entry) { log.warn(event('notification_type_uncatalogued', { eventType: row.eventType, eventId: row.id })); return; }
  if (!orgs.has(row.organizationId)) orgs.set(row.organizationId, await loadOrgFacts(trx, row.organizationId));
  const org = orgs.get(row.organizationId);
  if (!org) return;
  const recipients = await recipientsOf(trx, route, row);
  if (recipients.length === 0) return;
  const payload: Payload = { ...row.payload, aggregateType: row.aggregateType, aggregateId: row.aggregateId };
  const prefs = await trx.selectFrom('notificationPreferences').select(['userId', 'channel', 'enabled'])
    .where('organizationId', '=', row.organizationId).where('category', '=', entry.category).where('channel', 'in', ['IN_APP', 'EMAIL'])
    .where('userId', 'in', recipients.map((r) => r.userId)).execute();
  const requested = channelsOf(row.payload);
  const now = deps.now();
  for (const r of recipients) {
    const audience = audienceOf(r.employeeId, row.payload['employeeId']);
    const resolved = resolveNotification(row.eventType, payload, { audience, timezone: org.timezone });
    if (!resolved) continue;
    const preferences: Partial<Record<NotificationDeliveryChannel, boolean>> = {};
    for (const p of prefs) if (p.userId === r.userId) preferences[p.channel as NotificationDeliveryChannel] = p.enabled;
    const decision = decideNotificationChannels({ resolved, orgSettings: org.settings, preferences, requested });
    if (!decision.inApp && !decision.email) { counters.suppressed++; continue; }
    // dedupe: same type + aggregate for the same user within 15 minutes (device flapping, repeated failures). Targeted events
    // are deliberate, one per transition (level 2 after level 1, a second question), so they are not.
    if (route.recipients !== 'users') {
      const dup = await trx.selectFrom('notifications').select('id').where('userId', '=', r.userId).where('organizationId', '=', row.organizationId).where('type', '=', row.eventType)
        .where('createdAt', '>', new Date(now.getTime() - DEDUPE_WINDOW_MS)).where(sql<boolean>`data->>'aggregateId' = ${row.aggregateId ?? ''}`).executeTakeFirst();
      if (dup) continue;
    }
    const locale = pickLocale(r.locale, org.locale);
    const rendered = renderNotification({ type: row.eventType, data: payload, locale, timezone: org.timezone, orgName: org.displayName, audience, now });
    const inserted = await trx.insertInto('notifications').values({
      organizationId: row.organizationId, userId: r.userId, category: entry.category, type: row.eventType,
      title: rendered.title.slice(0, 500), body: rendered.body ? rendered.body.slice(0, 2000) : null, link: resolved.link,
      data: JSON.stringify(notificationData(entry, payload, resolved.route, { type: row.aggregateType, id: row.aggregateId })),
      inApp: decision.inApp,
      // an e-mail-only notice keeps its row (the e-mail's content and trail) without raising an unread badge
      ...(decision.inApp ? {} : { readAt: now }),
    }).returning('id').executeTakeFirstOrThrow();
    counters.notifications++;
    if (!decision.email) continue;
    // queueing the e-mail never costs the recipient the in-app notice
    await sql`savepoint relay_delivery`.execute(trx);
    try {
      await trx.insertInto('notificationDeliveries').values({ organizationId: row.organizationId, notificationId: inserted.id, channel: 'EMAIL', status: 'pending' }).execute();
      await sql`release savepoint relay_delivery`.execute(trx);
      counters.emails++;
    } catch (err) {
      await sql`rollback to savepoint relay_delivery`.execute(trx);
      log.warn(event('notification_email_queue_failed', { eventId: row.id, notificationId: inserted.id, err: (err as Error).message }));
    }
  }
}

/**
 * Outbox relay (transactional outbox, ADR-004/§53): reads unpublished domain events in order, writes the notifications of
 * each (catalogue + templates + channel decision), queues e-mail deliveries, and broadcasts a coalesced invalidation signal
 * per channel. Each event runs under a savepoint: a failing event is rolled back alone, counted and retried by the next run
 * (up to MAX_PUBLISH_ATTEMPTS), and never stops the events behind it.
 */
export async function relayOutbox({ deps, log, job }: JobContext) {
  const batch = Number(job.payload['batchSize'] ?? 200);
  return withContext(deps.db, { kind: 'platform', jobId: job.id }, async (trx) => {
    const rows = await sql<OutboxRow>`select id, organization_id as "organizationId", event_type as "eventType", aggregate_type as "aggregateType", aggregate_id as "aggregateId", payload, actor_user_id as "actorUserId", occurred_at as "occurredAt", publish_attempts as "publishAttempts"
      from public.domain_events where published_at is null and publish_attempts < ${MAX_PUBLISH_ATTEMPTS} order by id asc limit ${batch} for update skip locked`.execute(trx);
    if (rows.rows.length === 0) return { relayed: 0, notifications: 0, emails: 0, failed: 0 };
    const coalesced = new Map<string, { channel: string; event: string; ids: string[] }>();
    const counters: RelayCounters = { notifications: 0, emails: 0, suppressed: 0 };
    const orgs = new Map<string, OrgFacts | null>();
    let failed = 0;
    for (const row of rows.rows) {
      await sql`savepoint relay_event`.execute(trx);
      try {
        await notify(trx, deps, orgs, row, counters, log);
        const target = realtimeTarget(row);
        if (target) {
          const key = `${target.channel}|${target.event}`;
          const c = coalesced.get(key) ?? { ...target, ids: [] };
          if (row.aggregateId) c.ids.push(row.aggregateId);
          coalesced.set(key, c);
        }
        await sql`update public.domain_events set published_at = now(), publish_attempts = publish_attempts + 1 where id = ${row.id}::bigint`.execute(trx);
        await sql`release savepoint relay_event`.execute(trx);
      } catch (err) {
        await sql`rollback to savepoint relay_event`.execute(trx);
        failed++;
        await sql`update public.domain_events set publish_attempts = publish_attempts + 1, publish_error = ${String((err as Error).message).slice(0, 500)} where id = ${row.id}::bigint`.execute(trx);
        const attempts = Number(row.publishAttempts) + 1;
        if (attempts >= MAX_PUBLISH_ATTEMPTS) log.error(event('outbox_event_dead_lettered', { eventId: row.id, eventType: row.eventType, attempts, err: (err as Error).message }));
        else log.warn(event('outbox_relay_failed', { eventId: row.id, eventType: row.eventType, attempts, err: (err as Error).message }));
      }
    }
    for (const c of coalesced.values()) await deps.realtime.publish(c.channel, c.event, { ids: c.ids.slice(0, 200), count: c.ids.length, at: deps.now().toISOString() });
    log.info(event('outbox_relayed', { events: rows.rows.length, notifications: counters.notifications, emails: counters.emails, suppressed: counters.suppressed, failed, channels: coalesced.size }));
    return { relayed: rows.rows.length, notifications: counters.notifications, emails: counters.emails, failed };
  });
}

/**
 * The approve / reject links of an approval e-mail: a fresh token pair for THIS recipient and THIS level, minted in the
 * organisation's system context (the token table is system-only). Returns null when the level is no longer waiting for
 * the recipient (decided, withdrawn, reassigned) — the e-mail then only links to the request. The links open the web action
 * page, which asks the approver to confirm and POSTs the decision (never acted on by a GET).
 */
async function oneClickLinks(trx: Trx, deps: JobContext['deps'], d: { organizationId: string; userId: string; data: Record<string, unknown> }): Promise<{ approve: string; reject: string } | null> {
  const requestId = R.id(d.data['requestId']) ?? (d.data['aggregateType'] === 'approval_request' ? R.id(d.data['aggregateId']) : null);
  if (!requestId) return null;
  await applyContext(trx, { kind: 'system', organizationId: d.organizationId });
  try {
    const step = await trx.selectFrom('approvalSteps as s').innerJoin('approvalRequests as r', 'r.id', 's.requestId').innerJoin('approvalStepActors as a', 'a.stepId', 's.id')
      .select(['s.id as stepId', 'r.id as requestId']).where('r.id', '=', requestId).where('r.status', '=', 'PENDING').where('s.status', '=', 'PENDING').whereRef('s.stepNo', '=', 'r.currentStep')
      .where('a.userId', '=', d.userId).where('a.decision', '=', 'PENDING').executeTakeFirst();
    if (!step) return null;
    const pair = await issueApprovalEmailTokens(trx, { organizationId: d.organizationId, requestId: step.requestId, stepId: step.stepId, userId: d.userId }, { now: deps.now() });
    const base = `${webBase(deps)}/approvals/email-action?org=${encodeURIComponent(d.organizationId)}`;
    return { approve: `${base}&action=APPROVE&token=${encodeURIComponent(pair.approve)}`, reject: `${base}&action=REJECT&token=${encodeURIComponent(pair.reject)}` };
  } finally {
    await applyContext(trx, { kind: 'platform' });
  }
}

const webBase = (deps: JobContext['deps']) => String(deps.config.WEB_PUBLIC_URL ?? '').replace(/\/+$/, '');
/** An absolute URL on the web app for a canonical path (a path is always relative to the app; anything else is dropped). */
export function webUrl(base: string, path: string | null | undefined): string {
  const b = base.replace(/\/+$/, '');
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? `${b}${path}` : `${b}/`;
}

/** E-mail attempts per delivery (the first send + retries), and the waits between them. */
export const DELIVERY_MAX_ATTEMPTS = 5;
export const DELIVERY_BACKOFF_MINUTES = [1, 5, 15, 60] as const;
/** Delay before the next attempt after `attempts` failed ones. */
export function deliveryBackoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), DELIVERY_BACKOFF_MINUTES.length) - 1;
  return DELIVERY_BACKOFF_MINUTES[i]! * 60_000;
}
/** A single, plain address (no display name, no header breaks) — anything else is never handed to the mailer. */
export function isDeliverableAddress(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/.test(email)
    // the reserved `.invalid` TLD marks a placeholder profile address (a user created without an e-mail)
    && !/\.invalid$/i.test(email);
}

interface PendingDelivery {
  id: string; organizationId: string | null; attempts: number; userId: string; type: string; title: string; body: string | null; link: string | null; data: unknown;
  email: string; userLocale: string | null; profileStatus: string; orgName: string | null; orgLocale: string | null; timezone: string | null; employeeId: string | null; membershipStatus: string | null;
}

/**
 * Sends the due e-mail deliveries (worker mailer), one batch per run. Every e-mail is rendered for its recipient at send time
 * — their language (profile, else the organisation's), the organisation's timezone and name — into the branded layout, and
 * goes ONLY to the address on the recipient's own profile, after checking the recipient is still an active member with an
 * active account (else the delivery is `skipped` with the reason). A failed send is retried with back-off
 * (DELIVERY_BACKOFF_MINUTES) up to DELIVERY_MAX_ATTEMPTS, then `failed`; the in-app notice is never affected.
 */
export async function deliverNotifications({ deps, log, job }: JobContext) {
  const now = deps.now();
  return withContext(deps.db, { kind: 'platform', jobId: job.id }, async (trx) => {
    const pending = await sql<PendingDelivery>`
      select d.id, d.organization_id as "organizationId", d.attempts, n.user_id as "userId", n.type, n.title, n.body, n.link, n.data,
             u.email, u.locale as "userLocale", u.status as "profileStatus",
             o.display_name as "orgName", o.locale as "orgLocale", o.timezone,
             m.employee_id as "employeeId", m.status as "membershipStatus"
      from public.notification_deliveries d
      join public.notifications n on n.id = d.notification_id
      join public.user_profiles u on u.id = n.user_id
      left join public.organizations o on o.id = d.organization_id
      left join public.org_memberships m on m.organization_id = d.organization_id and m.user_id = n.user_id
      where d.status = 'pending' and d.channel = 'EMAIL' and (d.next_attempt_at is null or d.next_attempt_at <= ${now})
      order by coalesce(d.next_attempt_at, d.created_at), d.id
      limit ${Number(job.payload['batchSize'] ?? 100)}
      for update of d skip locked`.execute(trx);
    let sent = 0; let skipped = 0; let retried = 0; let failed = 0;
    for (const d of pending.rows) {
      const problem = !isDeliverableAddress(d.email) ? 'invalid_recipient_address'
        : d.profileStatus !== 'active' ? 'recipient_disabled'
        : d.organizationId && d.membershipStatus !== 'active' ? 'recipient_not_member' : null;
      if (problem) {
        await sql`update public.notification_deliveries set status = 'skipped', error = ${problem}, next_attempt_at = null where id = ${d.id}::bigint`.execute(trx);
        skipped++;
        continue;
      }
      try {
        const data = d.data && typeof d.data === 'object' && !Array.isArray(d.data) ? (d.data as Record<string, unknown>) : {};
        const locale = pickLocale(d.userLocale, d.orgLocale);
        const timezone = d.timezone && isValidTimezone(d.timezone) ? d.timezone : 'UTC';
        const audience = audienceOf(d.employeeId, data['employeeId']);
        const orgName = d.orgName ?? '';
        const rendered = renderNotification({ type: d.type, data, locale, timezone, orgName, audience, now }, { title: d.title, body: d.body, link: d.link });
        const base = webBase(deps);
        const oneClick = rendered.resolved?.oneClick && d.organizationId ? await oneClickLinks(trx, deps, { organizationId: d.organizationId, userId: d.userId, data }) : null;
        const mail = renderEmail({
          rendered, locale, orgName,
          // the link stored with the notice is the one the relay resolved; the rendering only supplies the words
          url: webUrl(base, d.link ?? rendered.link),
          preferencesUrl: webUrl(base, d.employeeId ? '/my/profile' : '/settings/notifications'),
          locked: rendered.resolved ? !rendered.resolved.entry.userConfigurable : false,
          oneClick,
        });
        const res = await deps.mailer.send({ to: d.email, subject: mail.subject, html: mail.html, text: mail.text });
        await sql`update public.notification_deliveries set status = 'sent', provider = ${res.provider}, provider_message_id = ${res.id}, sent_at = now(), attempts = attempts + 1, next_attempt_at = null, error = null where id = ${d.id}::bigint`.execute(trx);
        sent++;
      } catch (err) {
        const attempts = Number(d.attempts) + 1;
        const giveUp = attempts >= DELIVERY_MAX_ATTEMPTS;
        await sql`update public.notification_deliveries set status = ${giveUp ? 'failed' : 'pending'}::public.delivery_status, attempts = ${attempts},
          next_attempt_at = ${giveUp ? null : new Date(now.getTime() + deliveryBackoffMs(attempts))}, error = ${String((err as Error).message).slice(0, 500)} where id = ${d.id}::bigint`.execute(trx);
        if (giveUp) { failed++; log.warn(event('notification_email_failed', { deliveryId: d.id, attempts, err: (err as Error).message })); } else retried++;
      }
    }
    if (pending.rows.length) log.info(event('notifications_delivered', { attempted: pending.rows.length, sent, skipped, retried, failed }));
    return { attempted: pending.rows.length, sent, skipped, retried, failed };
  });
}

export function registerNotificationHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'RELAY_OUTBOX', handler: relayOutbox, timeoutMs: 120_000 });
  registry.register({ jobType: 'DELIVER_NOTIFICATIONS', handler: deliverNotifications, timeoutMs: 120_000 });
  registry.register({ jobType: MISSING_PUNCH_REMINDER_JOB_TYPE, handler: missingPunchRemindersHandler, timeoutMs: 600_000 });
  registry.register({ jobType: NOTIFICATION_RETENTION_JOB_TYPE, handler: notificationRetentionHandler, timeoutMs: 1_800_000 });
}
