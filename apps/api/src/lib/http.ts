import type { Context } from 'hono';
import type { PageMeta } from '@flowza/contracts';

export function ok<T>(c: Context, data: T, meta?: Record<string, unknown>, status: 200 | 201 = 200) {
  return c.json({ data, ...(meta ? { meta } : {}) }, status);
}
export function created<T>(c: Context, data: T) { return ok(c, data, undefined, 201); }
export function accepted(c: Context, jobId: string, message = 'Request queued successfully.') {
  return c.json({ data: { jobId, status: 'QUEUED' as const, message } }, 202);
}
export function paginated<T>(c: Context, data: T[], page: number, pageSize: number, total: number) {
  const meta: PageMeta = { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  return c.json({ data, meta }, 200);
}
export function noContent(c: Context) { return c.body(null, 204); }

/** Proxy-trust settings needed to derive a client IP. `ApiConfig` satisfies this shape. */
export interface ProxyTrust {
  TRUST_PROXY: boolean;
  /** Header the edge sets authoritatively on every request (Cloudflare: `cf-connecting-ip`). Preferred when present. */
  CLIENT_IP_HEADER?: string | undefined;
  /** How many trusted proxies append to X-Forwarded-For, counted from the right. Defaults to 1 when absent. */
  TRUSTED_PROXY_HOPS?: number | undefined;
}

/**
 * The caller's IP, used to rate-limit (app.ts) and to stamp the audit trail (service.ts) — so a value an attacker can
 * choose is a rate-limit bypass and a forged audit record, not a cosmetic problem.
 *
 * X-Forwarded-For is a chain that each proxy APPENDS to, so anything the client sent lands on the LEFT and the
 * left-most entry is attacker-controlled: behind Cloudflare, a request carrying `X-Forwarded-For: 1.2.3.4` reaches the
 * origin as `1.2.3.4, <real client ip>`. We therefore count `TRUSTED_PROXY_HOPS` proxies in from the right instead of
 * reading entry zero.
 *
 * `CLIENT_IP_HEADER` is the stronger option where the edge provides one: Cloudflare overwrites `CF-Connecting-IP` on
 * every request, so it cannot be spoofed — *provided the origin only accepts traffic from that edge*. An origin
 * reachable directly lets anyone set the header themselves, so this must be paired with Authenticated Origin Pulls or
 * an edge IP allowlist (docs/deployment.md).
 */
export function clientIp(c: Context, trust: ProxyTrust): string | null {
  if (!trust.TRUST_PROXY) return null;
  if (trust.CLIENT_IP_HEADER) {
    const authoritative = c.req.header(trust.CLIENT_IP_HEADER)?.trim();
    if (authoritative) return authoritative;
    // Header absent: the request did not traverse the expected edge. Fall through — the hop-counted read below is
    // itself spoof-resistant, so this costs nothing in safety and keeps a misconfigured header name from blinding us.
  }
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    const chain = fwd.split(',').map((part) => part.trim()).filter(Boolean);
    // Defaulted here rather than relying on the caller: a config object assembled without the field (a test harness,
    // an embedder) must degrade to single-hop, not to NaN — which would index nothing and silently report no IP.
    const hops = Number.isFinite(trust.TRUSTED_PROXY_HOPS) ? Math.max(1, trust.TRUSTED_PROXY_HOPS as number) : 1;
    if (chain.length > 0) return chain[Math.max(0, chain.length - hops)] ?? null;
  }
  const real = c.req.header('x-real-ip')?.trim();
  return real || null;
}
