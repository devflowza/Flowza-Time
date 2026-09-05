import type { Hono } from 'hono';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';

/** /webhooks/providers/:providerKey and /device-push/:protocol/* — see docs/device-integrations.md. */
export function registerInboundRoutes(app: Hono<AppEnv>, deps: ApiDeps): void {
  void app; void deps;
}
