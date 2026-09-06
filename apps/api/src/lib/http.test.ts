import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import { clientIp, type ProxyTrust } from './http.js';

/** Minimal Context stand-in: clientIp only reads request headers, and Hono lower-cases the name it is given. */
const ctx = (headers: Record<string, string>): Context =>
  ({ req: { header: (name: string) => headers[name.toLowerCase()] } }) as unknown as Context;

const BEHIND_CLOUDFLARE: ProxyTrust = { TRUST_PROXY: true, CLIENT_IP_HEADER: 'cf-connecting-ip', TRUSTED_PROXY_HOPS: 1 };
const BEHIND_ONE_PROXY: ProxyTrust = { TRUST_PROXY: true, TRUSTED_PROXY_HOPS: 1 };

describe('clientIp', () => {
  it('returns null when proxy headers are not trusted, whatever the request claims', () => {
    const c = ctx({ 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8', 'x-real-ip': '9.9.9.9' });
    expect(clientIp(c, { TRUST_PROXY: false, TRUSTED_PROXY_HOPS: 1 })).toBeNull();
  });

  it('prefers the authoritative edge header over anything the client sent', () => {
    // Cloudflare overwrites cf-connecting-ip; the spoofed X-Forwarded-For prefix must not win.
    const c = ctx({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7', 'cf-connecting-ip': '203.0.113.7' });
    expect(clientIp(c, BEHIND_CLOUDFLARE)).toBe('203.0.113.7');
  });

  it('does not let a client-supplied X-Forwarded-For prefix impersonate another address', () => {
    // The regression this guards: reading chain[0] returned the attacker's value and defeated per-IP rate limiting.
    const c = ctx({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' });
    expect(clientIp(c, BEHIND_ONE_PROXY)).toBe('203.0.113.7');
  });

  it('rotating spoofed prefixes all resolve to the same real address', () => {
    const real = '203.0.113.7';
    const seen = ['9.9.9.1', '9.9.9.2', '9.9.9.3'].map((spoof) =>
      clientIp(ctx({ 'x-forwarded-for': `${spoof}, ${real}` }), BEHIND_ONE_PROXY),
    );
    expect(new Set(seen)).toEqual(new Set([real]));
  });

  it('counts multiple trusted hops in from the right', () => {
    // Cloudflare -> Fly: the client value, then Cloudflare's, are appended after the spoofed prefix.
    const c = ctx({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 172.16.0.1' });
    expect(clientIp(c, { TRUST_PROXY: true, TRUSTED_PROXY_HOPS: 2 })).toBe('203.0.113.7');
  });

  it('reads a single-entry chain as the client address', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': '203.0.113.7' }), BEHIND_ONE_PROXY)).toBe('203.0.113.7');
  });

  it('falls back to the hop-counted chain when the configured edge header is missing', () => {
    const c = ctx({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' });
    expect(clientIp(c, BEHIND_CLOUDFLARE)).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip only when there is no chain at all', () => {
    expect(clientIp(ctx({ 'x-real-ip': '203.0.113.7' }), BEHIND_ONE_PROXY)).toBe('203.0.113.7');
  });

  it('returns null when no proxy header is present', () => {
    expect(clientIp(ctx({}), BEHIND_ONE_PROXY)).toBeNull();
  });

  it('ignores whitespace and empty entries in the chain', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': ' 1.2.3.4 , , 203.0.113.7 ' }), BEHIND_ONE_PROXY)).toBe('203.0.113.7');
  });

  it('treats a hop count below one as one rather than reading past the end', () => {
    const c = ctx({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' });
    expect(clientIp(c, { TRUST_PROXY: true, TRUSTED_PROXY_HOPS: 0 })).toBe('203.0.113.7');
  });

  it('clamps a hop count longer than the chain to the left-most entry', () => {
    const c = ctx({ 'x-forwarded-for': '203.0.113.7' });
    expect(clientIp(c, { TRUST_PROXY: true, TRUSTED_PROXY_HOPS: 5 })).toBe('203.0.113.7');
  });
});

describe('clientIp with an incomplete trust config', () => {
  it('treats a missing hop count as a single trusted proxy instead of reporting no IP', () => {
    // A config object assembled by hand (test harness, embedder) has no TRUSTED_PROXY_HOPS. Arithmetic on undefined
    // produced NaN, indexed nothing, and reported null — which would silently merge every caller into one rate-limit
    // bucket and blank the audit trail.
    const c = ctx({ 'x-forwarded-for': '203.0.113.9' });
    expect(clientIp(c, { TRUST_PROXY: true } as ProxyTrust)).toBe('203.0.113.9');
  });
});
