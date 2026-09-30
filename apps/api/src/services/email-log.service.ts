import { sql } from 'kysely';
import {
  EMAIL_STALLED_AFTER_MINUTES, EMAIL_STATUSES,
  type EmailEventDto, type EmailEventType, type EmailKind, type EmailLogQuery, type EmailLogSummaryDto, type EmailLogSummaryQuery, type EmailMessageDetailDto, type EmailMessageDto, type EmailStatus,
} from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requirePermission } from '../lib/authorize.js';
import { type Actor, runUser } from '../lib/service.js';
import { likeContains, pageOf, resolveSort, toCount } from '../lib/pagination.js';
import { isoDateTime, isoDateTimeOrNull } from '../lib/mappers.js';

/**
 * E-mail activity log (migration 20260930000500): the invitation and notification e-mails of an organisation, where each
 * stands (the worker's attempts, then the provider's delivery events) and its timeline. The log names recipients across the
 * organisation whatever their branch, so it needs `audit.view` AND access to every branch — the read policy says the same.
 */
const SORT = { createdAt: 'm.created_at', status: 'm.status', recipient: 'm.recipient', sentAt: 'm.sent_at' } as const;
const SUMMARY_DEFAULT_DAYS = 7;

function requireLogAccess(actor: Actor, orgId: string): void {
  const grant = requirePermission(actor.principal, orgId, 'audit.view');
  if (!grant.allBranches) throw errors.forbidden('The e-mail log covers every branch: it needs access to all branches.');
}

const MESSAGE_COLUMNS = [
  'm.id', 'm.organizationId', 'm.kind', 'm.category', 'm.recipient', 'm.recipientUserId', 'm.subject', 'm.status', 'm.provider', 'm.providerMessageId', 'm.attempts',
  'm.lastError', 'm.invitationId', 'm.createdAt', 'm.updatedAt', 'm.lastAttemptAt', 'm.nextAttemptAt', 'm.sentAt', 'm.deliveredAt', 'm.openedAt', 'm.clickedAt',
  'm.bouncedAt', 'm.complainedAt', 'u.fullName as recipientName',
] as const;

function baseQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('emailMessages as m').leftJoin('userProfiles as u', 'u.id', 'm.recipientUserId').where('m.organizationId', '=', orgId);
}

function toDto(r: {
  id: string; organizationId: string | null; kind: string; category: string; recipient: string; recipientUserId: string | null; subject: string | null; status: string;
  provider: string | null; providerMessageId: string | null; attempts: number; lastError: string | null; invitationId: string | null; createdAt: Date; updatedAt: Date;
  lastAttemptAt: Date | null; nextAttemptAt: Date | null; sentAt: Date | null; deliveredAt: Date | null; openedAt: Date | null; clickedAt: Date | null;
  bouncedAt: Date | null; complainedAt: Date | null; recipientName: string | null;
}): EmailMessageDto {
  return {
    id: r.id, organizationId: r.organizationId, kind: r.kind as EmailKind, category: r.category, recipient: r.recipient, recipientUserId: r.recipientUserId,
    recipientName: r.recipientName?.trim() || null, subject: r.subject, status: r.status as EmailStatus, provider: r.provider, providerMessageId: r.providerMessageId,
    attempts: r.attempts, lastError: r.lastError, invitationId: r.invitationId, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
    lastAttemptAt: isoDateTimeOrNull(r.lastAttemptAt), nextAttemptAt: isoDateTimeOrNull(r.nextAttemptAt), sentAt: isoDateTimeOrNull(r.sentAt),
    deliveredAt: isoDateTimeOrNull(r.deliveredAt), openedAt: isoDateTimeOrNull(r.openedAt), clickedAt: isoDateTimeOrNull(r.clickedAt),
    bouncedAt: isoDateTimeOrNull(r.bouncedAt), complainedAt: isoDateTimeOrNull(r.complainedAt),
  };
}

export async function listEmailLog(deps: ApiDeps, actor: Actor, orgId: string, q: EmailLogQuery): Promise<{ data: EmailMessageDto[]; total: number }> {
  requireLogAccess(actor, orgId);
  const sort = resolveSort(SORT, q.sort, q.sort ? q.order : 'desc', 'm.created_at');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = baseQuery(trx, orgId);
    if (q.status?.length) base = base.where('m.status', 'in', q.status);
    if (q.kind) base = base.where('m.kind', '=', q.kind);
    if (q.invitationId) base = base.where('m.invitationId', '=', q.invitationId);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('m.recipient', 'ilike', like), eb('m.subject', 'ilike', like), eb('u.fullName', 'ilike', like)])); }
    if (q.from) base = base.where('m.createdAt', '>=', new Date(q.from));
    if (q.to) base = base.where('m.createdAt', '<=', new Date(q.to));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(MESSAGE_COLUMNS).orderBy(sql.raw(`${sort.column} ${sort.direction} nulls last`)).orderBy('m.id', sort.direction).limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map(toDto), total };
  });
}

export async function getEmailMessage(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<EmailMessageDetailDto> {
  requireLogAccess(actor, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const row = await baseQuery(trx, orgId).where('m.id', '=', id).select(MESSAGE_COLUMNS).executeTakeFirst();
    if (!row) throw errors.notFound('E-mail', id);
    const events = await trx.selectFrom('emailEvents').select(['id', 'event', 'occurredAt', 'attempt', 'detail'])
      .where('organizationId', '=', orgId).where('messageId', '=', id).orderBy('occurredAt').orderBy('id').execute();
    return {
      ...toDto(row),
      events: events.map((e): EmailEventDto => ({ id: String(e.id), event: e.event as EmailEventType, occurredAt: isoDateTime(e.occurredAt), attempt: e.attempt, detail: e.detail })),
    };
  });
}

export async function emailLogSummary(deps: ApiDeps, actor: Actor, orgId: string, q: EmailLogSummaryQuery): Promise<EmailLogSummaryDto> {
  requireLogAccess(actor, orgId);
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - SUMMARY_DEFAULT_DAYS * 86_400_000);
  if (from.getTime() > to.getTime()) throw errors.validation('`from` must not be after `to`.', { from: q.from, to: q.to });
  return runUser(deps.db, actor, async (trx) => {
    const counts = await trx.selectFrom('emailMessages').select(['status', (eb) => eb.fn.countAll().as('n'), sql<string>`count(*) filter (where provider = 'console' and sent_at is not null)`.as('console')])
      .where('organizationId', '=', orgId).where('createdAt', '>=', from).where('createdAt', '<=', to).groupBy('status').execute();
    // a stalled message is one the worker should have picked up by now, whatever the period: queued, or past its retry time
    const stalledSince = new Date(Date.now() - EMAIL_STALLED_AFTER_MINUTES * 60_000);
    const stalled = await trx.selectFrom('emailMessages').select([(eb) => eb.fn.countAll().as('n'), (eb) => eb.fn.min('createdAt').as('oldest')])
      .where('organizationId', '=', orgId)
      .where((eb) => eb.or([
        eb.and([eb('status', '=', 'queued'), eb('updatedAt', '<', stalledSince)]),
        eb.and([eb('status', '=', 'retrying'), eb('nextAttemptAt', '<', stalledSince)]),
      ]))
      .executeTakeFirst();
    const byStatus = Object.fromEntries(EMAIL_STATUSES.map((s) => [s, 0])) as Record<EmailStatus, number>;
    let total = 0; let consoleSent = 0;
    for (const c of counts) {
      const n = toCount(c.n);
      if ((EMAIL_STATUSES as readonly string[]).includes(c.status)) byStatus[c.status as EmailStatus] = n;
      total += n; consoleSent += toCount(c.console);
    }
    return {
      from: isoDateTime(from), to: isoDateTime(to), total, byStatus,
      stalled: toCount(stalled?.n), oldestStalledAt: isoDateTimeOrNull(stalled?.oldest as Date | null | undefined), consoleSent,
    };
  });
}
