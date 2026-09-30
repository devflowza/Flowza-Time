import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import type { ApiDeps } from './deps.js';
import { requestContext, type AppEnv } from './middleware/request-context.js';
import { errorHandler } from './middleware/error-handler.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rate-limit.js';
import { orgMfaGate } from './middleware/mfa.js';
import { moduleGate } from './middleware/module-gate.js';
import { orgAccessGate, platformAccessGate } from './middleware/org-access.js';
import { clientIp } from './lib/http.js';
import { healthRoutes } from './routes/health.js';
import { registerV1Routes } from './routes/v1/index.js';
import { registerPublicInvitationRoutes } from './routes/v1/members.js';
import { registerInboundRoutes } from './routes/inbound/index.js';
import { registerEmailWebhookRoutes } from './routes/inbound/email-webhooks.js';
import { edgeGate } from './middleware/edge-gate.js';
import { securityHeaders } from './middleware/security-headers.js';

/** The paths of the inbound router (device push protocols, vendor webhooks): its edge gate and limiter apply to these only. */
export const INBOUND_PREFIXES = ['/device-push', '/webhooks'] as const;

/** `details.reason` of the router's own 404 (no route matched), as opposed to a NOT_FOUND raised for a missing record. */
export const ROUTE_NOT_FOUND = 'ROUTE_NOT_FOUND';

/** Invitation previews per client IP: enough for a person opening their link, far too few to guess tokens. */
export const INVITATION_VALIDATE_LIMIT = { windowMs: 60_000, max: 20 } as const;

/** Builds the Hono application. Route modules live in routes/v1/* (authenticated) and routes/inbound/* (devices/webhooks). */
export function createApp(deps: ApiDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requestContext(deps.log));
  app.use('*', securityHeaders());
  app.use('*', bodyLimit({ maxSize: 25 * 1024 * 1024 }));
  app.use('/api/*', cors({ origin: deps.config.webOrigins, allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'Idempotency-Key'], exposeHeaders: ['X-Request-Id', 'Retry-After'], maxAge: 600, credentials: false }));
  // JSON lists (a day of attendance, an org's employees) are 20–60 KB; gzip keeps them inside the first congestion
  // windows of a connection that already pays a long round trip.
  app.use('/api/*', compress());
  app.onError(errorHandler);
  // details.reason tells the web a path the API does not serve (a web deploy ahead of the API deploy) from a record that
  // does not exist — both are NOT_FOUND. The web shows the first as "not available yet", never as this message.
  app.notFound((c) => c.json({ code: 'NOT_FOUND', message: 'Route not found.', requestId: c.get('requestId'), details: { reason: ROUTE_NOT_FOUND } }, 404));

  // The edge gate runs before the rate limiters everywhere it applies: a request that did not come through the edge
  // carries an unverifiable client IP, so letting it reach a limiter would let it write to a bucket it chose.
  const edge = edgeGate(deps.config.EDGE_SHARED_SECRET);

  // /api/health stays open — the platform's own health check reaches the container directly, without the edge, and it
  // returns no data. /api/ready is gated: it reports database latency and queue depth.
  app.use('/api/ready', edge);
  app.route('/api', healthRoutes(deps));

  // Inbound: vendor webhooks and device push protocols (device/webhook authentication inside). Its middlewares are scoped
  // to its own paths: mounted at '/', a `use('*')` here would run for EVERY request of the app — the inbound limiter
  // (1,200 / min per IP) then capped the whole authenticated API as well (Prompt 10).
  const inbound = new Hono<AppEnv>();
  const inboundLimit = rateLimit({ name: 'inbound', windowMs: 60_000, max: 1200, keyFn: (c) => clientIp(c, deps.config) ?? 'unknown' });
  for (const prefix of INBOUND_PREFIXES) inbound.use(`${prefix}/*`, edge, inboundLimit);
  registerInboundRoutes(inbound, deps);
  registerEmailWebhookRoutes(inbound, deps);
  app.route('/', inbound);

  // Public invitation preview (HR portal Prompt 6b, B-70): no session; edge-gated and limited per client IP before the
  // authenticated router, whose middlewares therefore never see this path. It reveals a token's state and masked data only.
  const pub = new Hono<AppEnv>();
  pub.use('/invitations/validate', edge);
  pub.use('/invitations/validate', rateLimit({ name: 'invitation-validate', windowMs: INVITATION_VALIDATE_LIMIT.windowMs, max: INVITATION_VALIDATE_LIMIT.max, keyFn: (c) => clientIp(c, deps.config) ?? 'unknown' }));
  registerPublicInvitationRoutes(pub, deps);
  app.route('/api/v1', pub);

  // Authenticated API
  const v1 = new Hono<AppEnv>();
  v1.use('*', edge);
  v1.use('*', rateLimit({ name: 'api-ip', windowMs: deps.config.RATE_LIMIT_WINDOW_MS, max: deps.config.RATE_LIMIT_MAX * 2, keyFn: (c) => clientIp(c, deps.config) ?? 'unknown' }));
  v1.use('*', requireAuth({ verify: deps.verifyToken, db: deps.db }));
  v1.use('*', rateLimit({ name: 'api-user', windowMs: deps.config.RATE_LIMIT_WINDOW_MS, max: deps.config.RATE_LIMIT_MAX, keyFn: (c) => c.get('principal')?.userId ?? 'anon' }));
  // the tenant boundary first (403 for a non-member, before any body is read), then the organisation's MFA policy
  v1.use('/orgs/:orgId', orgAccessGate());
  v1.use('/orgs/:orgId/*', orgAccessGate());
  v1.use('/platform/*', platformAccessGate());
  v1.use('/orgs/:orgId', orgMfaGate());
  v1.use('/orgs/:orgId/*', orgMfaGate());
  // then the organisation's modules (plan, platform override, fleet switch, lapsed subscription): 403 for a module that is off
  v1.use('/orgs/:orgId/*', moduleGate());
  registerV1Routes(v1, deps);
  app.route('/api/v1', v1);
  return app;
}
