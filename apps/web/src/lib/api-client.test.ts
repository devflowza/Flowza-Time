import { describe, expect, it, vi } from 'vitest';

// only the browser-only dependencies are mocked; api-client itself is the real module under test
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { ApiError, isMfaRequiredError } from './api-client';

describe('isMfaRequiredError', () => {
  it('matches only the 403 the API raises for a session below aal2', () => {
    expect(isMfaRequiredError(new ApiError(403, 'FORBIDDEN', 'MFA needed', 'r1', { reason: 'MFA_REQUIRED' }))).toBe(true);
    expect(isMfaRequiredError(new ApiError(403, 'FORBIDDEN', 'Missing permission: employee.view.'))).toBe(false);
    expect(isMfaRequiredError(new ApiError(401, 'UNAUTHENTICATED', 'no', 'r1', { reason: 'MFA_REQUIRED' }))).toBe(false);
    expect(isMfaRequiredError(new Error('network'))).toBe(false);
    expect(isMfaRequiredError(null)).toBe(false);
  });
});
