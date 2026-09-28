import type { MiddlewareHandler } from 'hono';
import { errors } from '@flowza/shared';
import { requireMembership, requirePlatformAdmin } from '../lib/authorize.js';
import type { AppEnv } from './request-context.js';

/**
 * Organisation access gate (HR portal Prompt 10 — security gate). Every `/orgs/:orgId` route answers 403 to a caller who is
 * not an active member of the organisation in the path (a platform admin reaches an organisation through an active access
 * grant, which the principal carries as a membership). It runs before any body is parsed or any row is read, so a
 * non-member learns nothing — not even a validation message — from any route, including one added later. The services still
 * check the precise permission, scope and state (authorization twice, AGENTS.md); this is the tenant boundary at the edge.
 * The route authorisation matrix (src/test/route-authz.test.ts) proves it for every route of the app.
 */
export function orgAccessGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const orgId = c.req.param('orgId');
    if (orgId !== undefined) {
      const principal = c.get('principal');
      if (!principal) throw errors.unauthenticated();
      requireMembership(principal, orgId);
    }
    await next();
  };
}

/**
 * Platform access gate (Prompt 10): every `/platform/*` route answers 403 to a caller who is not a platform administrator
 * before any body is parsed — a tenant user learns nothing, not even the validation rules of platform operations. The
 * services keep their own requirePlatformAdmin (authorization twice).
 */
export function platformAccessGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal');
    if (!principal) throw errors.unauthenticated();
    requirePlatformAdmin(principal);
    await next();
  };
}
