import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { AppError } from '@flowza/shared';
import type { AppEnv } from './request-context.js';

/** Header Cloudflare adds with a Transform Rule. Requests that did not pass through the edge will not carry it. */
export const EDGE_HEADER = 'x-flowza-edge';

/**
 * Rejects requests that did not arrive through the CDN edge (§119, docs/go-live.md).
 *
 * This is what makes the client-IP handling in lib/http.ts sound. Both strategies there assume the request traversed
 * the expected proxy chain: `CLIENT_IP_HEADER` trusts a header the edge rewrites, and `TRUSTED_PROXY_HOPS` counts a
 * fixed number of proxies in from the right. A request sent straight to the origin satisfies neither — it carries one
 * fewer hop than configured, so the hop count reads a client-supplied entry, and nothing overwrites the edge header.
 * Closing the origin is therefore not defence in depth, it is the precondition both strategies rest on.
 *
 * Deliberately a shared secret rather than mutual TLS: Cloudflare's Authenticated Origin Pulls needs the origin to
 * validate a client certificate, which the Fly proxy does not do on the application's behalf. A secret header is
 * weaker in kind but is actually enforceable here, and it costs an attacker who has guessed the origin hostname a
 * value they cannot read. Cloudflare Tunnel — no public origin listener at all — is the stronger end state.
 *
 * Disabled when the secret is unset, so local development and self-hosted deployments without a CDN are unaffected.
 */
export function edgeGate(secret: string | undefined): MiddlewareHandler<AppEnv> {
  if (!secret) return async (_c, next) => next();
  const expected = Buffer.from(secret, 'utf8');
  return async (c, next) => {
    const presented = c.req.header(EDGE_HEADER);
    // Compare lengths first: timingSafeEqual throws on a mismatch, and the length is not the secret.
    const supplied = presented ? Buffer.from(presented, 'utf8') : null;
    if (!supplied || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      // Deliberately says nothing about the header: an attacker probing the origin directly learns only that it is
      // closed, not what would open it.
      throw new AppError('FORBIDDEN', 'Request did not originate from the configured edge.');
    }
    return next();
  };
}
