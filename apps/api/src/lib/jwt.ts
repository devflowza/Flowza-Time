import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AppError } from '@flowza/shared';

export interface VerifiedToken { sub: string; email?: string; role: string; sessionId?: string; aal?: string; raw: JWTPayload }

/**
 * Verifies Supabase access tokens. New projects sign with asymmetric keys (JWKS at /auth/v1/.well-known/jwks.json);
 * legacy projects use HS256 with the project JWT secret. Both are supported; JWKS is preferred.
 */
export function createTokenVerifier(opts: { supabaseUrl: string; jwtSecret?: string }) {
  const issuer = `${opts.supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const hsKey = opts.jwtSecret ? new TextEncoder().encode(opts.jwtSecret) : null;

  return async function verify(token: string): Promise<VerifiedToken> {
    let payload: JWTPayload;
    try {
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' }));
      } catch (jwksErr) {
        if (!hsKey) throw jwksErr;
        ({ payload } = await jwtVerify(token, hsKey, { issuer, audience: 'authenticated', algorithms: ['HS256'] }));
      }
    } catch (err) {
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired session.', { cause: err });
    }
    if (!payload.sub) throw new AppError('UNAUTHENTICATED', 'Token has no subject.');
    const role = typeof payload['role'] === 'string' ? (payload['role'] as string) : 'authenticated';
    if (role !== 'authenticated') throw new AppError('UNAUTHENTICATED', 'Unsupported token role.');
    return {
      sub: payload.sub,
      email: typeof payload['email'] === 'string' ? (payload['email'] as string) : undefined,
      role,
      sessionId: typeof payload['session_id'] === 'string' ? (payload['session_id'] as string) : undefined,
      aal: typeof payload['aal'] === 'string' ? (payload['aal'] as string) : undefined,
      raw: payload,
    };
  };
}
