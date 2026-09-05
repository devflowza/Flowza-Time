import type { MiddlewareHandler } from 'hono';
import { AppError } from '@flowza/shared';
import type { AppEnv } from './request-context.js';

export function mfaRequiredError(message = 'Multi-factor authentication is required for this organisation.'): AppError {
  return new AppError('FORBIDDEN', message, { details: { reason: 'MFA_REQUIRED' } });
}

/**
 * Organisation MFA gate (AGENTS.md service rules): when `organization_settings.security.mfaRequired` is true for the
 * organisation in the route, the session must carry `aal2`. Mounted on `/orgs/:orgId` routes only, so `/me` stays
 * reachable and the UI can prompt for MFA enrolment. Platform admins are gated globally in `requireAuth`.
 */
export function orgMfaGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const orgId = c.req.param('orgId');
    if (orgId && c.get('mfaRequiredOrgIds')?.has(orgId) && c.get('aal') !== 'aal2') throw mfaRequiredError();
    await next();
  };
}
