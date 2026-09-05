import type { MiddlewareHandler } from 'hono';
import { newRequestId, type Logger } from '@flowza/shared';
import type { Principal } from '@flowza/domain';

export type AppVariables = {
  requestId: string;
  log: Logger;
  principal?: Principal;
  /** Authenticator assurance level of the session ('aal1' | 'aal2'); undefined before authentication. */
  aal?: string;
  /** Organisations (of the caller's memberships) whose security settings require MFA. */
  mfaRequiredOrgIds?: ReadonlySet<string>;
  startedAt: number;
};
export type AppEnv = { Variables: AppVariables };

export function requestContext(rootLogger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && /^[A-Za-z0-9_-]{8,128}$/.test(incoming) ? incoming : newRequestId();
    c.set('requestId', requestId);
    c.set('startedAt', Date.now());
    c.set('log', rootLogger.child({ requestId, method: c.req.method, path: c.req.path }));
    c.header('x-request-id', requestId);
    await next();
    const durationMs = Date.now() - c.get('startedAt');
    c.get('log').info({ event: 'http_request', status: c.res.status, durationMs, userId: c.get('principal')?.userId });
  };
}
