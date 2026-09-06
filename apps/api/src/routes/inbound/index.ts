import type { Context, Hono } from 'hono';
import type { DevicePushRequest, DevicePushResponse, WebhookRequest } from '@flowza/device-providers';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { clientIp } from '../../lib/http.js';
import { pushTokenMatches } from '../../services/features/devices.service.js';
import { findPushDevices, findWebhookDevice, handleDevicePush, handleWebhook, INBOUND_MAX_BODY_BYTES, protocolErrorResponse, recordPendingDevice, SerialRateLimiter } from '../../services/features/inbound.service.js';

const TEXT = { 'content-type': 'text/plain; charset=utf-8' };
const HEADER_ALLOWLIST = ['content-type', 'content-length', 'user-agent', 'x-request-id', 'x-mock-signature', 'x-signature', 'x-hub-signature-256', 'x-device-token', 'authorization'];
/** Optional path-embedded token for terminals that cannot send headers: /device-push/<protocol>/~<token>/... */
const PATH_TOKEN = /^\/~([A-Za-z0-9_-]{16,128})(?=\/|$)/;

function subsetHeaders(c: Context<AppEnv>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADER_ALLOWLIST) { const v = c.req.header(name); if (v !== undefined) out[name] = v; }
  return out;
}
function queryOf(c: Context<AppEnv>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.queries())) out[k] = v[0] ?? '';
  return out;
}
async function readBody(c: Context<AppEnv>): Promise<string | null> {
  const len = Number(c.req.header('content-length') ?? '0');
  if (len > INBOUND_MAX_BODY_BYTES) return null;
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return '';
  const text = await c.req.text().catch(() => '');
  return Buffer.byteLength(text, 'utf8') > INBOUND_MAX_BODY_BYTES ? null : text;
}

/**
 * ANY /device-push/:protocolKey/*   — device push protocols (mock, iclock …); see docs/api.md "Inbound".
 * POST /webhooks/providers/:providerKey/:deviceId/:token — vendor cloud webhooks.
 * Responses are protocol text/JSON only; internal errors are never surfaced.
 */
export function registerInboundRoutes(app: Hono<AppEnv>, deps: ApiDeps): void {
  const serialLimiter = new SerialRateLimiter();

  app.all('/device-push/:protocolKey/*', async (c) => {
    const protocolKey = c.req.param('protocolKey');
    const handler = deps.providers.pushProtocol(protocolKey);
    if (!handler) return c.text('unknown protocol', 404, TEXT);
    const requestId = c.get('requestId');
    const log = c.get('log');
    let rest = c.req.path.slice(`/device-push/${protocolKey}`.length) || '/';
    let pathToken: string | undefined;
    const m = PATH_TOKEN.exec(rest);
    if (m) { pathToken = m[1]; rest = rest.slice(m[0].length) || '/'; }
    const rawBody = await readBody(c);
    if (rawBody === null) return c.text('payload too large', 413, TEXT);
    // the push token must never reach the protocol handler, the replay hash or the stored payload
    const query = queryOf(c);
    const queryToken = query.token;
    delete query.token;
    const headers = subsetHeaders(c);
    delete headers.authorization; delete headers['x-device-token'];
    const req: DevicePushRequest = { method: c.req.method, path: `/${protocolKey}${rest}`, query, headers, rawBody, remoteIp: clientIp(c, deps.config) ?? undefined };
    let identity: ReturnType<typeof handler.identifyDevice>;
    try { identity = handler.identifyDevice(req); } catch { identity = null; }
    if (!identity) return c.text('device not identified', 400, TEXT);
    const serial = identity.serialNumber;
    if (!serialLimiter.allow(serial)) { c.header('retry-after', '60'); return c.text('too many requests', 429, TEXT); }
    try {
      const candidates = await findPushDevices(deps, handler, serial, requestId);
      if (candidates.length === 0) {
        await recordPendingDevice(deps, handler, serial, req, requestId, { ...(identity.extra ?? {}), route: identity.extra?.route ?? null }).catch((err) => log.warn({ event: 'pending_device_upsert_failed', serial, err: (err as Error).message }));
        // Handshakes/heartbeats get the protocol's own answer so the terminal keeps polling and registers as soon as an admin
        // claims it. Data uploads are NOT acknowledged: an "OK" would make the device discard punches nobody stored.
        let response: DevicePushResponse = { status: 200, body: 'OK', headers: TEXT };
        try {
          const parsed = handler.parseInbound(req, { timezone: 'UTC', serialNumber: serial });
          const carriesData = parsed.transactions.length > 0 || (parsed.employees?.length ?? 0) > 0 || (parsed.commandResults?.length ?? 0) > 0;
          response = carriesData ? { status: 401, body: 'unauthorized', headers: TEXT } : parsed.response;
        } catch { /* unparseable: answer OK so the device does not loop on a request we will never store */ }
        log.info({ event: 'device_push_unknown_serial', protocolKey, serial, status: response.status });
        return c.body(response.body, response.status as 200, response.headers ?? TEXT);
      }
      // serial + per-device token, always: a DEVICE_PUSH row without a token is refused rather than trusted on serial alone
      const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
      const token = pathToken ?? c.req.header('x-device-token') ?? queryToken ?? bearer;
      const device = candidates.find((d) => pushTokenMatches(token, d.pushTokenHash));
      if (!device) {
        const first = candidates[0]!;
        log.warn({ event: first.pushTokenHash ? 'device_push_bad_token' : 'device_push_no_token_configured', protocolKey, serial, organizationId: first.organizationId, deviceId: first.id });
        return c.text('unauthorized', 401, TEXT);
      }
      const outcome = await handleDevicePush(deps, device, handler, req, requestId);
      log.info({ event: 'device_push', protocolKey, serial, organizationId: device.organizationId, deviceId: device.id, kind: outcome.kind, inserted: outcome.inserted, commandsSent: outcome.commandsSent });
      return c.body(outcome.response.body, outcome.response.status as 200, outcome.response.headers ?? TEXT);
    } catch (err) {
      log.error({ event: 'device_push_failed', protocolKey, serial, err: err instanceof Error ? { name: err.name, message: err.message } : err });
      const r = protocolErrorResponse(err);
      return c.body(r.body, r.status as 200, r.headers ?? TEXT);
    }
  });

  app.post('/webhooks/providers/:providerKey/:deviceId/:token', async (c) => {
    const { providerKey, deviceId, token } = c.req.param();
    const requestId = c.get('requestId');
    const log = c.get('log');
    const provider = deps.providers.tryGet(providerKey);
    if (!provider || typeof provider.handleWebhook !== 'function') return c.json({ error: 'unknown_provider' }, 404);
    if (!/^[0-9a-f-]{36}$/i.test(deviceId)) return c.json({ error: 'unknown_device' }, 404);
    const rawBody = await readBody(c);
    if (rawBody === null) return c.json({ error: 'payload_too_large' }, 413);
    try {
      const device = await findWebhookDevice(deps.db, deviceId, providerKey, requestId);
      if (!device) return c.json({ error: 'unknown_device' }, 404);
      let body: unknown = null;
      try { body = rawBody ? JSON.parse(rawBody) : null; } catch { body = null; }
      const req: WebhookRequest = { headers: subsetHeaders(c), rawBody, body, query: queryOf(c), remoteIp: clientIp(c, deps.config) ?? undefined };
      const outcome = await handleWebhook(deps, device, token, req, requestId);
      log.info({ event: 'provider_webhook', providerKey, organizationId: device.organizationId, deviceId, status: outcome.status });
      return c.json(outcome.body ?? {}, outcome.status as 200, outcome.headers);
    } catch (err) {
      log.error({ event: 'provider_webhook_failed', providerKey, deviceId, err: err instanceof Error ? { name: err.name, message: err.message } : err });
      return c.json({ error: 'internal_error' }, 500);
    }
  });
}
