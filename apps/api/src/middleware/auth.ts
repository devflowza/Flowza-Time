import type { MiddlewareHandler } from 'hono';
import { errors } from '@flowza/shared';
import type { Database } from '@flowza/database';
import type { AppEnv } from './request-context.js';
import type { VerifiedToken } from '../lib/jwt.js';
import { loadPrincipal } from '../lib/principal.js';
import { mfaRequiredError } from './mfa.js';

export interface AuthDeps { verify: (token: string) => Promise<VerifiedToken>; db: Database }

/** Bearer JWT → verified token → principal loaded from the database. Platform administrators must always carry aal2 (MFA). */
export function requireAuth(deps: AuthDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw errors.unauthenticated();
    const verified = await deps.verify(token);
    const { principal, mfaRequiredOrgIds } = await loadPrincipal(deps.db, verified.sub, verified.email, c.get('requestId'));
    const aal = verified.aal ?? 'aal1';
    if (principal.isPlatformAdmin && aal !== 'aal2') throw mfaRequiredError('Platform administrators must sign in with multi-factor authentication.');
    c.set('principal', principal);
    c.set('aal', aal);
    c.set('mfaRequiredOrgIds', mfaRequiredOrgIds);
    c.set('log', c.get('log').child({ userId: principal.userId }));
    await next();
  };
}
