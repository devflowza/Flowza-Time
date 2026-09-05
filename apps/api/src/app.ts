import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import type { ApiDeps } from './deps.js';
import { requestContext, type AppEnv } from './middleware/request-context.js';
import { errorHandler } from './middleware/error-handler.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rate-limit.js';
import { orgMfaGate } from './middleware/mfa.js';
import { clientIp } from './lib/http.js';
import { healthRoutes } from './routes/health.js';
import { registerV1Routes } from './routes/v1/index.js';
import { registerInboundRoutes } from './routes/inbound/index.js';

/** Builds the Hono application. Route modules live in routes/v1/* (authenticated) and routes/inbound/* (devices/webhooks). */
export function createApp(deps: ApiDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requestContext(deps.log));
  app.use('*', secureHeaders());
  app.use('*', bodyLimit({ maxSize: 25 * 1024 * 1024 }));
  app.use('/api/*', cors({ origin: deps.config.webOrigins, allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'Idempotency-Key'], exposeHeaders: ['X-Request-Id', 'Retry-After'], maxAge: 600, credentials: false }));
  app.onError(errorHandler);
  app.notFound((c) => c.json({ code: 'NOT_FOUND', message: 'Route not found.', requestId: c.get('requestId') }, 404));

  app.route('/api', healthRoutes(deps));

  // Inbound: vendor webhooks and device push protocols (device/webhook authentication inside)
  const inbound = new Hono<AppEnv>();
  inbound.use('*', rateLimit({ name: 'inbound', windowMs: 60_000, max: 1200, keyFn: (c) => clientIp(c, deps.config) ?? 'unknown' }));
  registerInboundRoutes(inbound, deps);
  app.route('/', inbound);

  // Authenticated API
  const v1 = new Hono<AppEnv>();
  v1.use('*', rateLimit({ name: 'api-ip', windowMs: deps.config.RATE_LIMIT_WINDOW_MS, max: deps.config.RATE_LIMIT_MAX * 2, keyFn: (c) => clientIp(c, deps.config) ?? 'unknown' }));
  v1.use('*', requireAuth({ verify: deps.verifyToken, db: deps.db }));
  v1.use('*', rateLimit({ name: 'api-user', windowMs: deps.config.RATE_LIMIT_WINDOW_MS, max: deps.config.RATE_LIMIT_MAX, keyFn: (c) => c.get('principal')?.userId ?? 'anon' }));
  v1.use('/orgs/:orgId', orgMfaGate());
  v1.use('/orgs/:orgId/*', orgMfaGate());
  registerV1Routes(v1, deps);
  app.route('/api/v1', v1);
  return app;
}
