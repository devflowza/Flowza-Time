import { describe, expect, it } from 'vitest';
import { buildDigestAuthorization, joinUrl, parseDigestChallenge, retryAfterMs, VendorHttpClient } from './vendor-http.js';
import { ProviderError } from './types.js';

describe('digest auth', () => {
  it('reproduces the RFC 2617 §3.5 example response', () => {
    const ch = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(ch).toMatchObject({ realm: 'testrealm@host.com', qop: 'auth', algorithm: 'MD5' });
    const header = buildDigestAuthorization(ch!, { method: 'GET', uri: '/dir/index.html', username: 'Mufasa', password: 'Circle Of Life' }, '0a4f113b');
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(header).toContain('nc=00000001');
  });
  it('refuses Basic-only and unsupported algorithms', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
    expect(parseDigestChallenge('Digest realm="x", nonce="n", algorithm=SHA-256')).toBeNull();
  });
});

describe('VendorHttpClient', () => {
  const c = new VendorHttpClient('Acme');
  it('normalises base URLs and refuses http / credentials in production', () => {
    expect(c.baseUrl('https://h.example.com:8081/biotime/?x=1')).toBe('https://h.example.com:8081/biotime');
    expect(() => c.baseUrl('http://h.example.com')).toThrow(ProviderError);
    expect(() => c.baseUrl('https://u:p@h.example.com')).toThrow(/credentials/);
    expect(() => c.baseUrl('')).toThrow(/not configured/);
    expect(new VendorHttpClient('Acme', { allowPrivateHosts: true }).baseUrl('http://127.0.0.1:81')).toBe('http://127.0.0.1:81');
  });
  it('maps statuses to provider error codes', () => {
    expect(c.statusError(401, 'x').code).toBe('AUTH_FAILED');
    expect(c.statusError(429, 'x', '5')).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 5000, retryable: true });
    expect(c.statusError(503, 'x')).toMatchObject({ code: 'DEVICE_OFFLINE', retryable: true });
    expect(c.statusError(500, 'x')).toMatchObject({ code: 'VENDOR_ERROR', retryable: true });
    expect(c.statusError(400, 'x')).toMatchObject({ code: 'VENDOR_ERROR', retryable: false });
    expect(c.statusError(302, 'x').retryable).toBe(false);
  });
  it('joins urls and parses Retry-After', () => {
    expect(joinUrl('https://a/b/', '/c')).toBe('https://a/b/c');
    expect(retryAfterMs(undefined)).toBe(60_000);
    expect(retryAfterMs('999999')).toBe(30 * 60_000);
  });
});
