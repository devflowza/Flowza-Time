import { vi } from 'vitest';
import type { Permission } from '@flowza/contracts';

/**
 * Module mocks for the web feature tests. This file must import NOTHING from the application (no '@/lib/*', no
 * '@/components/*'): `vi.mock` factories `await import(...)` it while a mocked module (e.g. '@/lib/api-client', imported by
 * the ui barrel's ErrorState) is still being evaluated — importing application code from here deadlocks the module graph.
 * Render helpers live in ./test-utils.tsx.
 */

// ---- API client mock ------------------------------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string, readonly details?: Record<string, unknown>) { super(message); this.name = 'ApiError'; }
}
export const apiMock = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() };
export const apiFetchMock = vi.fn();
export const apiClientModule = { api: apiMock, apiFetch: apiFetchMock, ApiError };
export function resetApiMock() { for (const fn of Object.values(apiMock)) fn.mockReset(); apiFetchMock.mockReset(); apiMock.get.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'not mocked')); }

/** Route a GET mock by path (query params are passed as the second argument by the real client). */
export function mockGet(routes: Record<string, unknown | ((query: Record<string, unknown> | undefined) => unknown)>) {
  apiMock.get.mockImplementation((path: string, query?: Record<string, unknown>) => {
    const hit = Object.entries(routes).find(([k]) => (k.endsWith('*') ? path.startsWith(k.slice(0, -1)) : path === k));
    if (!hit) return Promise.reject(new ApiError(404, 'NOT_FOUND', `No mock for GET ${path}`));
    const v = hit[1];
    return Promise.resolve(typeof v === 'function' ? (v as (q: Record<string, unknown> | undefined) => unknown)(query) : v);
  });
}
export const page = <T,>(data: T[], total = data.length, pageNo = 1, pageSize = 25) => ({ data, meta: { page: pageNo, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } });

// ---- supabase / env mocks -------------------------------------------------------------------------------------------
export const supabaseMock = {
  auth: {
    getSession: vi.fn(async () => ({ data: { session: { access_token: 'token' } } })),
    mfa: { listFactors: vi.fn(async () => ({ data: { totp: [], all: [] }, error: null })), enroll: vi.fn(), challenge: vi.fn(), verify: vi.fn(), unenroll: vi.fn() },
  },
};
export const supabaseModule = { supabase: supabaseMock };
export const envModule = { env: { supabaseUrl: 'http://localhost', supabaseAnonKey: 'anon', apiUrl: 'http://localhost:4000' } };

// ---- me / permissions mock -----------------------------------------------------------------------------------------
export const testState = { permissions: new Set<string>(), orgId: 'org-1', timezone: 'Asia/Muscat', membershipId: 'mem-1' };
export function grant(...perms: Permission[]) { testState.permissions = new Set(perms); }
export function grantAll() { testState.permissions = new Set(['*']); }
const membership = () => ({
  membershipId: testState.membershipId, roleId: 'role-1', roleKey: 'org_admin', roleName: 'Admin', permissions: [...testState.permissions], allBranches: true, branchIds: [], employeeId: null, featureFlags: {}, settings: {},
  organization: { id: testState.orgId, companyCode: 'ACME', legalName: 'Acme LLC', displayName: 'Acme', countryCode: 'OM', timezone: testState.timezone, currencyCode: 'OMR', locale: 'en', weeklyOffDays: [5, 6], logoPath: null, contact: {}, address: {}, status: 'active', createdAt: '2024-01-01T00:00:00Z' },
});
export const useMeModule = {
  meQueryKey: ['me'] as const,
  useMe: () => ({ data: { user: { id: 'u1', email: 'dev@flowza.ai', fullName: 'Dev', avatarUrl: null, locale: 'en', mfaEnrolled: false, isPlatformAdmin: false }, memberships: [membership()] }, isLoading: false, isError: false }),
  useActiveMembership: () => membership(),
  useCan: () => (...perms: string[]) => testState.permissions.has('*') || perms.every((p) => testState.permissions.has(p)),
  useOrgId: () => testState.orgId,
  useOrgTimezone: () => testState.timezone,
  useFeatureFlag: () => false,
};
