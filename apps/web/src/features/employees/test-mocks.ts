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
export const isMfaRequiredError = (error: unknown): boolean => error instanceof ApiError && error.status === 403 && error.details?.reason === 'MFA_REQUIRED';
export const NETWORK_ERROR_STATUS = 0;
export const isNetworkError = (error: unknown): boolean => error instanceof ApiError && error.status === NETWORK_ERROR_STATUS;
export const apiClientModule = { api: apiMock, apiFetch: apiFetchMock, ApiError, isMfaRequiredError, isNetworkError, NETWORK_ERROR_STATUS };
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
/** Loose stand-ins for the supabase-js MFA shapes, so tests can resolve factors and errors without importing the SDK types. */
interface MfaFactor { id: string; status: string; friendly_name?: string; factor_type?: string }
type MfaListResult = { data: { totp: MfaFactor[]; all: MfaFactor[] } | null; error: { message: string } | null };
/** Mirrors supabase-js: `session` is null when the project requires email confirmation before the account is usable. */
type AuthResult = { data: { session: { access_token: string } | null; user: { id: string } | null }; error: { message: string } | null };
export const supabaseMock = {
  auth: {
    getSession: vi.fn(async () => ({ data: { session: { access_token: 'token' } } })),
    signOut: vi.fn(async () => ({ error: null })),
    signInWithPassword: vi.fn<() => Promise<AuthResult>>(async () => ({ data: { session: { access_token: 'token' }, user: { id: 'u1' } }, error: null })),
    // signUp resolves with `session: null` when the project requires email confirmation — the invitation flow has to
    // handle both shapes, so the double must be able to produce both.
    signUp: vi.fn<() => Promise<AuthResult>>(async () => ({ data: { session: { access_token: 'token' }, user: { id: 'u2' } }, error: null })),
    mfa: {
      listFactors: vi.fn<() => Promise<MfaListResult>>(async () => ({ data: { totp: [], all: [] }, error: null })),
      enroll: vi.fn(), challenge: vi.fn(), verify: vi.fn(), unenroll: vi.fn(),
    },
  },
};
export const supabaseModule = { supabase: supabaseMock };
export const envModule = { env: { supabaseUrl: 'http://localhost', supabaseAnonKey: 'anon', apiUrl: 'http://localhost:4000' } };

// ---- me / permissions mock -----------------------------------------------------------------------------------------
/** `orgId: null` models a signed-in user with no organisation — a platform admin before the first one exists. */
export const testState = { permissions: new Set<string>(), orgId: 'org-1' as string | null, timezone: 'Asia/Muscat', membershipId: 'mem-1' };
export function grant(...perms: Permission[]) { testState.permissions = new Set(perms); }
export function grantAll() { testState.permissions = new Set(['*']); }
const membership = () =>
  testState.orgId === null
    ? null
    : {
        membershipId: testState.membershipId, roleId: 'role-1', roleKey: 'org_admin', roleName: 'Admin', permissions: [...testState.permissions], allBranches: true, branchIds: [], employeeId: null, featureFlags: {}, settings: {},
        organization: { id: testState.orgId, companyCode: 'ACME', legalName: 'Acme LLC', displayName: 'Acme', countryCode: 'OM', timezone: testState.timezone, currencyCode: 'OMR', locale: 'en', weeklyOffDays: [5, 6], logoPath: null, contact: {}, address: {}, status: 'active', createdAt: '2024-01-01T00:00:00Z' },
      };
export const useMeModule = {
  meQueryKey: ['me'] as const,
  useMe: () => {
    const m = membership();
    return { data: { user: { id: 'u1', email: 'dev@flowza.ai', fullName: 'Dev', avatarUrl: null, locale: 'en', mfaEnrolled: false, isPlatformAdmin: m === null }, memberships: m ? [m] : [] }, isLoading: false, isError: false };
  },
  useActiveMembership: () => membership(),
  useCan: () => (...perms: string[]) => testState.permissions.has('*') || perms.every((p) => testState.permissions.has(p)),
  // Throws exactly as the real hook does. A double that always returns an id hides every "renders without an
  // organisation" bug, which is precisely the class that broke the platform-admin bootstrap.
  useOrgId: () => {
    if (testState.orgId === null) throw new Error('No active organisation');
    return testState.orgId;
  },
  useOrgTimezone: () => testState.timezone,
  useFeatureFlag: () => false,
};
