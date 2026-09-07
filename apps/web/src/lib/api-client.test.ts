import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// only the browser-only dependencies are mocked; api-client itself is the real module under test
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { ApiError, apiFetch, isMfaRequiredError, isNetworkError } from './api-client';

describe('isMfaRequiredError', () => {
  it('matches only the 403 the API raises for a session below aal2', () => {
    expect(isMfaRequiredError(new ApiError(403, 'FORBIDDEN', 'MFA needed', 'r1', { reason: 'MFA_REQUIRED' }))).toBe(true);
    expect(isMfaRequiredError(new ApiError(403, 'FORBIDDEN', 'Missing permission: employee.view.'))).toBe(false);
    expect(isMfaRequiredError(new ApiError(401, 'UNAUTHENTICATED', 'no', 'r1', { reason: 'MFA_REQUIRED' }))).toBe(false);
    expect(isMfaRequiredError(new Error('network'))).toBe(false);
    expect(isMfaRequiredError(null)).toBe(false);
  });
});

describe('apiFetch transport failures', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { globalThis.fetch = realFetch; });

  it('turns an unreachable API into an ApiError instead of a bare TypeError', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await apiFetch('/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isNetworkError(err)).toBe(true);
    expect((err as ApiError).code).toBe('NETWORK_ERROR');
    // Without this the UI cannot tell "API is down" from any other thrown value, and every instanceof branch is skipped.
    expect(isMfaRequiredError(err)).toBe(false);
  });

  it('keeps the real status when a proxy answers with an HTML error body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<html><body>Origin unreachable</body></html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const err = await apiFetch('/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect(isNetworkError(err)).toBe(false);
  });

  it('reports a malformed 200 body rather than leaking a SyntaxError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));
    const err = await apiFetch('/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INVALID_RESPONSE');
  });
});
