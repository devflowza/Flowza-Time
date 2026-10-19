import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { apiKeyCreateSchema, hrmsBatchSchema, hrmsIntegrationInputSchema, type ImportKind } from '@flowza/contracts';
import { AppError, sha256Hex } from '@flowza/shared';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { created, ok } from '../../../lib/http.js';
import { rateLimit } from '../../../middleware/rate-limit.js';
import { body, param } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as hrms from '../../../services/features/hrms.service.js';

/**
 * Settings → HR system (docs/integrations/hrms.md). Every route needs `integration.manage`; a key's secret is returned once,
 * by its creation, and never again.
 */
export function registerHrmsRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/orgs/:orgId/integrations/hrms', async (c) => ok(c, await hrms.getHrmsIntegration(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.put('/orgs/:orgId/integrations/hrms', async (c) => ok(c, await hrms.putHrmsIntegration(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, hrmsIntegrationInputSchema))));
  v1.get('/orgs/:orgId/integrations/hrms/batches', async (c) => ok(c, await hrms.listHrmsBatches(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.get('/orgs/:orgId/api-keys', async (c) => ok(c, await hrms.listApiKeys(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/api-keys', async (c) => created(c, await hrms.createApiKey(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, apiKeyCreateSchema))));
  v1.post('/orgs/:orgId/api-keys/:id/revoke', async (c) => ok(c, await hrms.revokeApiKey(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
}

/**
 * HR system requests per API key and per client IP (docs/integrations/hrms.md §2). The per-IP limit runs before anything else
 * (app.ts); the per-key limit counts AUTHENTICATED requests only (counted by the key's public prefix before authentication, a
 * flood of wrong secrets naming that prefix would lock the real HR system out).
 */
export const HRMS_INBOUND_LIMITS = { perKey: { windowMs: 60_000, max: 60 }, perIp: { windowMs: 60_000, max: 300 } } as const;

/** Largest HRMS batch body (500 records of a few dozen fields fit in well under a megabyte). */
export const HRMS_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** The key presented by the caller (`Authorization: Bearer fzk_…`), or undefined. */
export function bearerOf(c: Context<AppEnv>): string | undefined {
  const h = c.req.header('authorization');
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null;
  return m ? m[1] : undefined;
}

async function authenticateKey(c: Context<AppEnv>, deps: ApiDeps) {
  try {
    return await hrms.authenticateApiKey(deps, bearerOf(c), c.get('requestId'));
  } catch (err) {
    if (AppError.is(err) && err.code === 'UNAUTHENTICATED') c.header('www-authenticate', 'Bearer realm="flowza-hrms"');
    throw err;
  }
}

/**
 * HR system inbound API — `/api/v1/inbound/hrms/*`, authenticated by an organisation API key (no user session). Mounted by
 * app.ts on its own router BEFORE the authenticated one, behind the edge gate and its own limiters (per client IP and per key).
 * The organisation is the key's; a body naming another one is ignored by construction (the schemas carry no tenant field).
 */
export function registerHrmsInboundRoutes(router: Hono<AppEnv>, deps: ApiDeps): void {
  const keyOf = new WeakMap<Context<AppEnv>, string>();
  const perKey = rateLimit({ name: 'hrms-key', ...HRMS_INBOUND_LIMITS.perKey, keyFn: (c) => keyOf.get(c) ?? 'unknown' });
  /** The key of the request, then its own per-key limit (429 + Retry-After). */
  const authenticate = async (c: Context<AppEnv>) => {
    const key = await authenticateKey(c, deps);
    keyOf.set(c, key.keyId);
    await perKey(c, async () => {});
    return key;
  };
  const limit = bodyLimit({ maxSize: HRMS_MAX_BODY_BYTES, onError: () => { throw new AppError('PAYLOAD_TOO_LARGE', `The batch is larger than ${HRMS_MAX_BODY_BYTES / 1024 / 1024} MB: send fewer records per batch.`); } });
  const submit = (kind: ImportKind) => async (c: Context<AppEnv>) => {
    const key = await authenticate(c);
    const raw = await c.req.raw.clone().text();
    const input = await body(c, hrmsBatchSchema);
    const outcome = await hrms.submitHrmsBatch(deps, key, kind, input, { requestId: c.get('requestId'), idempotencyKey: c.req.header('idempotency-key'), requestHash: sha256Hex(`${kind}\n${raw}`) });
    c.get('log').info({ event: 'hrms_batch', organizationId: key.organizationId, apiKeyId: key.keyId, kind, batchId: outcome.accepted.batchId, jobId: outcome.accepted.jobId, validRows: outcome.accepted.validRows, errorRows: outcome.accepted.errorRows, replayed: outcome.replayed });
    if (outcome.replayed) c.header('idempotency-replayed', 'true');
    return c.json({ data: outcome.accepted }, 202);
  };
  router.post('/inbound/hrms/employees', limit, submit('EMPLOYEES'));
  router.post('/inbound/hrms/org-units', limit, submit('ORG_UNITS'));
  router.get('/inbound/hrms/batches/:id', async (c) => {
    const key = await authenticate(c);
    return ok(c, await hrms.getHrmsBatch(deps, key, param(c, 'id'), c.get('requestId')));
  });
}
