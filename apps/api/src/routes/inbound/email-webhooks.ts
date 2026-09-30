import type { Hono } from 'hono';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { EMAIL_WEBHOOK_MAX_BODY_BYTES, parseResendEvent, recordProviderEvent, resendWebhookSchema, verifyWebhookSignature } from '../../services/email-webhook.service.js';

/**
 * POST /webhooks/email/resend — Resend's delivery events (delivered, bounced, complained, opened …) for the e-mail activity
 * log. Off (404, like an unknown path) until RESEND_WEBHOOK_SECRET is set; signature-verified; 2xx for anything the log does
 * not need so the provider stops redelivering it, 5xx only when recording failed (the provider retries).
 */
export function registerEmailWebhookRoutes(app: Hono<AppEnv>, deps: ApiDeps): void {
  app.post('/webhooks/email/resend', async (c) => {
    const secret = deps.config.RESEND_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: 'not_found' }, 404);
    const log = c.get('log');
    const requestId = c.get('requestId');
    if (Number(c.req.header('content-length') ?? '0') > EMAIL_WEBHOOK_MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    const body = await c.req.text().catch(() => '');
    if (Buffer.byteLength(body, 'utf8') > EMAIL_WEBHOOK_MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);
    const id = c.req.header('svix-id') ?? c.req.header('webhook-id');
    const signed = { id, timestamp: c.req.header('svix-timestamp') ?? c.req.header('webhook-timestamp'), signature: c.req.header('svix-signature') ?? c.req.header('webhook-signature'), body };
    if (!verifyWebhookSignature(secret, signed)) {
      log.warn({ event: 'email_webhook_rejected', provider: 'resend', reason: 'signature' });
      return c.json({ error: 'invalid_signature' }, 401);
    }
    let json: unknown;
    try { json = JSON.parse(body); } catch { return c.json({ error: 'invalid_payload' }, 400); }
    const payload = resendWebhookSchema.safeParse(json);
    if (!payload.success) return c.json({ error: 'invalid_payload' }, 400);
    const parsed = parseResendEvent(payload.data);
    if (!parsed) {
      log.info({ event: 'email_webhook', provider: 'resend', type: payload.data.type, result: 'ignored' });
      return c.json({ ok: true, result: 'ignored' });
    }
    try {
      const result = await recordProviderEvent(deps, 'resend', `resend:${id}`, parsed, requestId);
      log.info({ event: 'email_webhook', provider: 'resend', type: payload.data.type, providerMessageId: parsed.messageId, result });
      return c.json({ ok: true, result });
    } catch (err) {
      log.error({ event: 'email_webhook_failed', provider: 'resend', type: payload.data.type, providerMessageId: parsed.messageId, err: (err as Error).message });
      return c.json({ error: 'internal_error' }, 500);
    }
  });
}
