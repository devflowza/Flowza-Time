import type { MiddlewareHandler } from 'hono';
import { errors } from '@flowza/shared';
import type { Database } from '@flowza/database';
import type { AppEnv } from './request-context.js';
import type { VerifiedToken } from '../lib/jwt.js';
import { loadPrincipal } from '../lib/principal.js';

export interface AuthDeps { verify: (token: string) => Promise<VerifiedToken>; db: Database }

/** Bearer JWT → verified token → principal loaded from the database. */
export function requireAuth(deps: AuthDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw errors.unauthenticated();
    const verified = await deps.verify(token);
    const principal = await loadPrincipal(deps.db, verified.sub, verified.email, c.get('requestId'));
    c.set('principal', principal);
    c.set('log', c.get('log').child({ userId: principal.userId }));
    await next();
  };
}
