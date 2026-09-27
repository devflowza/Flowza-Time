import type { Hono } from 'hono';
import { publicStatementSubmitSchema, publicStatementViewSchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { ok } from '../../lib/http.js';
import { body } from '../../lib/validate.js';
import { clientIp } from '../../lib/http.js';
import { publicSubmitStatement, publicViewStatement } from '../../services/features/statements.service.js';

/**
 * The employee review flow (docs/statements.md): unauthenticated, the emailed token is the credential. POST for both
 * so the token travels in the body, never in a URL that lands in access logs or proxies. Mounted under /api/portal
 * with its own tight IP rate limit (app.ts); wrong, expired and voided tokens all answer 404/409 without revealing
 * whether a statement exists.
 */
export function registerPortalStatementRoutes(portal: Hono<AppEnv>, deps: ApiDeps): void {
  portal.post('/statements/view', async (c) => {
    const { token } = await body(c, publicStatementViewSchema);
    return ok(c, await publicViewStatement(deps, c.get('requestId'), token));
  });
  portal.post('/statements/submit', async (c) => {
    const input = await body(c, publicStatementSubmitSchema);
    return ok(c, await publicSubmitStatement(deps, c.get('requestId'), input, { ip: clientIp(c, deps.config), userAgent: c.req.header('user-agent')?.slice(0, 500) ?? null }));
  });
}
