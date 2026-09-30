import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './request-context.js';

/** The one path another origin may load: the web's reachability probe (apps/web `lib/api-client.ts`). */
export const REACHABILITY_PROBE_PATH = '/api/health';

/**
 * Hono's secure headers everywhere, with one exception. After a request got no readable answer, the web loads
 * /api/health in `no-cors` mode to tell "this device cannot reach the API host" from "the host answered, but something
 * in front of the API (a CDN security rule, a gateway error) answered instead". Under the default
 * `Cross-Origin-Resource-Policy: same-origin` the browser discards even a healthy answer to that probe, and the second
 * case would be reported as the first. The body is public (status, service name, time); every other path keeps
 * same-origin, and reading any response from script still requires CORS.
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  const strict = secureHeaders();
  const probe = secureHeaders({ crossOriginResourcePolicy: 'cross-origin' });
  return (c, next) => (c.req.path === REACHABILITY_PROBE_PATH ? probe(c, next) : strict(c, next));
}
