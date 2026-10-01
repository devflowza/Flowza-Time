import { describe, expect, it } from 'vitest';
import { canonicalRedirectUrl } from './canonical-origin';

const loc = (href: string) => { const u = new URL(href); return { origin: u.origin, hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash }; };
const CANONICAL = 'https://time.flowza.ai';

describe('canonicalRedirectUrl', () => {
  it('sends another custom domain to the same address on the canonical host', () => {
    expect(canonicalRedirectUrl(loc('https://time.flowza.com/auth/reset?code=abc#x'), CANONICAL)).toBe('https://time.flowza.ai/auth/reset?code=abc#x');
    expect(canonicalRedirectUrl(loc('https://TIME.flowza.com/employees/new'), CANONICAL)).toBe('https://time.flowza.ai/employees/new');
    // the canonical value may carry a trailing slash or a path: only its origin counts
    expect(canonicalRedirectUrl(loc('https://time.flowza.com/'), 'https://time.flowza.ai/')).toBe('https://time.flowza.ai/');
  });

  it('stays on the canonical host', () => {
    expect(canonicalRedirectUrl(loc('https://time.flowza.ai/employees'), CANONICAL)).toBeNull();
  });

  it('leaves local development and preview deployments alone', () => {
    for (const href of ['http://localhost:5173/', 'http://127.0.0.1:4173/auth/reset', 'http://app.localhost:5173/', 'https://3f2a1b.flowza-time-prd.pages.dev/', 'https://main.flowza-time-prd.pages.dev/']) {
      expect(canonicalRedirectUrl(loc(href), CANONICAL)).toBeNull();
    }
  });

  it('does nothing when no canonical address is configured, or it is not a web address', () => {
    expect(canonicalRedirectUrl(loc('https://time.flowza.com/'), undefined)).toBeNull();
    expect(canonicalRedirectUrl(loc('https://time.flowza.com/'), 'not a url')).toBeNull();
    expect(canonicalRedirectUrl(loc('https://time.flowza.com/'), 'javascript:alert(1)')).toBeNull();
  });
});
