import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { withContext } from '@flowza/database';
import type { ApiDeps } from '../deps.js';

/**
 * The e-mail provider's delivery webhook (Resend) → the e-mail activity log (migration 20260930000500).
 *
 * Resend signs every delivery the Svix / Standard Webhooks way: `svix-id`, `svix-timestamp` and `svix-signature`
 * (`v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<raw body>">`, space-separated when the secret rotates) with the endpoint's
 * `whsec_…` secret. A request is accepted only when a signature matches and the timestamp is within five minutes (replay).
 * The svix id is the event's id: a redelivery of the same event is recorded once.
 *
 * What is kept: the event, when it happened and — for a bounce or a provider failure — the provider's reason. A click's URL
 * is NEVER kept: the invitation e-mail's only link carries the invitation token.
 */
export const EMAIL_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const EMAIL_WEBHOOK_TOLERANCE_SECONDS = 300;

export type ProviderEmailEvent = 'delivered' | 'delayed' | 'bounced' | 'complained' | 'opened' | 'clicked' | 'provider_failed' | 'suppressed';

/** Resend event types the log records; the others (email.sent, email.scheduled, contact.*, domain.*) are acknowledged and ignored. */
export const RESEND_EVENT_MAP: Readonly<Record<string, ProviderEmailEvent>> = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.failed': 'provider_failed',
  'email.suppressed': 'suppressed',
};

export interface SignedRequest { id: string | undefined; timestamp: string | undefined; signature: string | undefined; body: string }

/** True when one of the request's `v1` signatures matches the body under the secret, within the replay window. */
export function verifyWebhookSignature(secret: string, req: SignedRequest, nowMs = Date.now(), toleranceSeconds = EMAIL_WEBHOOK_TOLERANCE_SECONDS): boolean {
  const { id, timestamp, signature, body } = req;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > toleranceSeconds) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  if (key.length === 0) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest();
  for (const part of signature.trim().split(/\s+/)) {
    const comma = part.indexOf(',');
    if (comma < 0 || part.slice(0, comma) !== 'v1') continue;
    const given = Buffer.from(part.slice(comma + 1), 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

const text = (max: number) => z.string().max(max).optional();
export const resendWebhookSchema = z.object({
  type: z.string().min(1).max(64),
  created_at: text(64),
  data: z.object({
    email_id: z.string().min(1).max(200).optional(),
    created_at: text(64),
    bounce: z.object({ message: text(2000), type: text(64), subType: text(64) }).optional(),
    failed: z.object({ reason: text(2000) }).optional(),
  }).optional(),
});
export type ResendWebhook = z.infer<typeof resendWebhookSchema>;

export interface ParsedProviderEvent { messageId: string; event: ProviderEmailEvent; occurredAt: Date | null; detail: string | null }

/** The log's view of a Resend event, or null for an event the log does not record (or one that names no message). */
export function parseResendEvent(payload: ResendWebhook): ParsedProviderEvent | null {
  const event = RESEND_EVENT_MAP[payload.type];
  const messageId = payload.data?.email_id;
  if (!event || !messageId) return null;
  const at = Date.parse(payload.created_at ?? payload.data?.created_at ?? '');
  let detail: string | null = null;
  if (event === 'bounced') {
    const b = payload.data?.bounce;
    const kind = [b?.type, b?.subType].filter(Boolean).join(' / ');
    detail = [kind, b?.message].filter(Boolean).join(': ') || null;
  } else if (event === 'provider_failed') {
    detail = payload.data?.failed?.reason ?? null;
  } else if (event === 'suppressed') {
    detail = 'The provider suppressed the address (an earlier bounce or spam complaint).';
  } else if (event === 'complained') {
    detail = 'The recipient marked the e-mail as spam.';
  }
  return { messageId, event, occurredAt: Number.isFinite(at) ? new Date(at) : null, detail: detail ? detail.slice(0, 500) : null };
}

export type RecordOutcome = 'recorded' | 'duplicate' | 'unknown_message' | 'ignored';

/** Records the event against the message it names (platform context; the database function finds the organisation). */
export async function recordProviderEvent(deps: ApiDeps, provider: string, eventId: string, e: ParsedProviderEvent, requestId: string): Promise<RecordOutcome> {
  return withContext(deps.db, { kind: 'platform', requestId }, async (trx) => {
    const { rows } = await sql<{ result: RecordOutcome }>`select app.record_email_provider_event(${provider}, ${e.messageId}, ${e.event}, ${e.occurredAt}, ${e.detail}, ${eventId}) as result`.execute(trx);
    return rows[0]?.result ?? 'ignored';
  });
}
