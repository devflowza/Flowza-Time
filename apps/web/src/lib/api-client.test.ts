import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// only the browser-only dependencies are mocked; api-client itself is the real module under test
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { ApiError, FEATURE_UNAVAILABLE, NETWORK_ERROR_STATUS, apiFetch, isFeatureUnavailableError, isMfaRequiredError, isNetworkError, shouldRetryQuery } from './api-client';

describe('shouldRetryQuery', () => {
  const network = new ApiError(NETWORK_ERROR_STATUS, 'NETWORK_ERROR', 'Could not reach the API');

  it('retries a request that never got an answer, although its status (0) is below 500', () => {
    // The old predicate read status 0 as a client error: one dropped /me took the whole app to "Could not reach the API".
    expect(shouldRetryQuery(0, network)).toBe(true);
    expect(shouldRetryQuery(1, network)).toBe(true);
  });

  it('retries server errors and non-API failures, never a 4xx answer', () => {
    expect(shouldRetryQuery(0, new ApiError(503, 'HTTP_ERROR', 'Service Unavailable'))).toBe(true);
    expect(shouldRetryQuery(0, new Error('boom'))).toBe(true);
    expect(shouldRetryQuery(0, new ApiError(401, 'UNAUTHENTICATED', 'no'))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError(403, 'FORBIDDEN', 'MFA needed', 'r1', { reason: 'MFA_REQUIRED' }))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError(404, 'NOT_FOUND', 'gone'))).toBe(false);
  });

  it('gives up after two retries', () => {
    expect(shouldRetryQuery(2, network)).toBe(false);
    expect(shouldRetryQuery(2, new ApiError(500, 'INTERNAL', 'x'))).toBe(false);
  });
});

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

describe('apiFetch — a path the API does not serve', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const answer = (status: number, body: unknown) => { globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })); };

  // The API in production when the web shipped PIN mapping: its router 404 carries only the message.
  it('never surfaces the router\'s "Route not found." from an API that predates the marker', async () => {
    answer(404, { code: 'NOT_FOUND', message: 'Route not found.', requestId: 'req_1' });
    const err = await apiFetch('/orgs/o1/pin-mappings').catch((e: unknown) => e);
    expect(isFeatureUnavailableError(err)).toBe(true);
    expect((err as ApiError).code).toBe(FEATURE_UNAVAILABLE);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe('Not available yet');
    expect((err as ApiError).message).not.toMatch(/route/i);
    expect((err as ApiError).requestId).toBe('req_1');
    expect((err as ApiError).details).toMatchObject({ path: '/orgs/o1/pin-mappings' });
  });

  it('recognises the router 404 by its details.reason, whatever its message says', async () => {
    answer(404, { code: 'NOT_FOUND', message: 'No such path.', requestId: 'req_2', details: { reason: 'ROUTE_NOT_FOUND' } });
    const err = await apiFetch('/orgs/o1/pin-mappings').catch((e: unknown) => e);
    expect(isFeatureUnavailableError(err)).toBe(true);
  });

  it('keeps a missing record a NOT_FOUND with the API\'s own message', async () => {
    answer(404, { code: 'NOT_FOUND', message: 'Employee not found.', requestId: 'req_3', details: { id: 'e1' } });
    const err = await apiFetch('/orgs/o1/employees/e1').catch((e: unknown) => e);
    expect(isFeatureUnavailableError(err)).toBe(false);
    expect((err as ApiError).code).toBe('NOT_FOUND');
    expect((err as ApiError).message).toBe('Employee not found.');
  });
});
