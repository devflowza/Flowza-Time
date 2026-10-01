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
export const networkFailureReason = (error: unknown): string | undefined => (isNetworkError(error) ? ((error as ApiError).details?.reason as string | undefined) : undefined);
export const FEATURE_UNAVAILABLE = 'FEATURE_UNAVAILABLE';
export const isFeatureUnavailableError = (error: unknown): boolean => error instanceof ApiError && error.code === FEATURE_UNAVAILABLE;
export const apiClientModule = { api: apiMock, apiFetch: apiFetchMock, ApiError, isMfaRequiredError, isNetworkError, networkFailureReason, NETWORK_ERROR_STATUS, isFeatureUnavailableError, FEATURE_UNAVAILABLE };
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
// A repeated sign-up of a confirmed address returns a stand-in user with `identities: []`; errors carry supabase's `code`.
type AuthResult = { data: { session: { access_token: string } | null; user: { id: string; identities?: unknown[] } | null }; error: { message: string; code?: string; status?: number } | null };
type AuthCallResult = { data: unknown; error: { message: string; code?: string; status?: number; name?: string } | null };
export interface RealtimeChannelDouble { topic: string; handlers: Array<(msg: { event?: string; payload?: unknown }) => void>; on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn>; emit: (event: string) => void }
/** Every channel opened through `supabaseMock.channel` (tests clear it in their setup). */
export const realtimeChannels: RealtimeChannelDouble[] = [];
export const supabaseMock = {
  auth: {
    getSession: vi.fn(async () => ({ data: { session: { access_token: 'token' } } })),
    signOut: vi.fn(async () => ({ error: null })),
    signInWithPassword: vi.fn<() => Promise<AuthResult>>(async () => ({ data: { session: { access_token: 'token' }, user: { id: 'u1' } }, error: null })),
    // signUp resolves with `session: null` when the project requires email confirmation — the invitation flow has to
    // handle both shapes, so the double must be able to produce both.
    signUp: vi.fn<() => Promise<AuthResult>>(async () => ({ data: { session: { access_token: 'token' }, user: { id: 'u2' } }, error: null })),
    // the password-reset flow: request the e-mail, verify a `token_hash` link, set the new password
    resetPasswordForEmail: vi.fn<(email: string, options?: { redirectTo?: string }) => Promise<AuthCallResult>>(async () => ({ data: {}, error: null })),
    verifyOtp: vi.fn<(params: { token_hash: string; type: string }) => Promise<AuthResult>>(async () => ({ data: { session: { access_token: 'token' }, user: { id: 'u1' } }, error: null })),
    updateUser: vi.fn<(attrs: { password?: string }) => Promise<AuthCallResult>>(async () => ({ data: {}, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    mfa: {
      listFactors: vi.fn<() => Promise<MfaListResult>>(async () => ({ data: { totp: [], all: [] }, error: null })),
      enroll: vi.fn(), challenge: vi.fn(), verify: vi.fn(), unenroll: vi.fn(),
    },
  },
  /** Realtime: `channel(topic)` records the broadcast handlers so a test can fire a signal through `realtimeChannels`. */
  channel: vi.fn((topic: string) => {
    const ch: RealtimeChannelDouble = {
      topic,
      handlers: [],
      on: vi.fn((_type: string, _filter: unknown, cb: (msg: { event?: string; payload?: unknown }) => void) => { ch.handlers.push(cb); return ch; }),
      subscribe: vi.fn((cb?: (status: string) => void) => { cb?.('SUBSCRIBED'); return ch; }),
      emit: (event: string) => { for (const h of ch.handlers) h({ event, payload: {} }); },
    };
    realtimeChannels.push(ch);
    return ch;
  }),
  removeChannel: vi.fn(async () => 'ok'),
};
export const supabaseModule = { supabase: supabaseMock };
export const envModule = { env: { supabaseUrl: 'http://localhost', supabaseAnonKey: 'anon', apiUrl: 'http://localhost:4000' } };

// ---- me / permissions mock -----------------------------------------------------------------------------------------
/** `orgId: null` models a signed-in user with no organisation — a platform admin before the first one exists. */
/** `settings` is the organisation settings object /me carries; tests set e.g. `{ dashboard: { theme: 'midnight' } }`. */
/** `teamSize` > 0 models a member whose employee record has direct reports (/me: isManager). */
/** `approvals` is /me's approval signal for the membership (what waits for the member, a delegation to them today). */
export const testState = { permissions: new Set<string>(), orgId: 'org-1' as string | null, timezone: 'Asia/Muscat', membershipId: 'mem-1', settings: {} as Record<string, unknown>, employeeId: null as string | null, teamSize: 0, approvals: { actionable: 0, delegatedToMe: false }, /** The signed-in user's id (useMe); tests that switch users set it and reset it to 'u1'. */ userId: 'u1',
  /** The membership's branch scope and role key (tests of branch-scoped administrators set them and reset them). */ allBranches: true, branchIds: [] as string[], roleKey: 'org_admin',
  /** Modules that are off for the organisation (migration 20260929000600); tests that switch one off reset it to empty. */ disabledModules: new Set<string>() };
export function grant(...perms: Permission[]) { testState.permissions = new Set(perms); }
export function grantAll() { testState.permissions = new Set(['*']); }
const membership = () =>
  testState.orgId === null
    ? null
    : {
        membershipId: testState.membershipId, roleId: 'role-1', roleKey: testState.roleKey, roleName: 'Admin', permissions: [...testState.permissions], allBranches: testState.allBranches, branchIds: testState.branchIds, employeeId: testState.employeeId, isManager: testState.teamSize > 0, teamSize: testState.teamSize, approvals: testState.approvals, featureFlags: {}, settings: testState.settings,
        modules: Object.fromEntries([...testState.disabledModules].map((k) => [k, false])), subscriptionLapsed: false,
        organization: { id: testState.orgId, companyCode: 'ACME', legalName: 'Acme LLC', displayName: 'Acme', countryCode: 'OM', timezone: testState.timezone, currencyCode: 'OMR', locale: 'en', weeklyOffDays: [5, 6], logoPath: null, contact: {}, address: {}, status: 'active', createdAt: '2024-01-01T00:00:00Z' },
      };
export const useMeModule = {
  meQueryKey: ['me'] as const,
  useMe: () => {
    const m = membership();
    return { data: { user: { id: testState.userId, email: 'dev@flowza.ai', fullName: 'Dev', avatarUrl: null, locale: 'en', mfaEnrolled: false, isPlatformAdmin: m === null }, memberships: m ? [m] : [] }, isLoading: false, isError: false };
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
  useEmployeeId: () => (testState.orgId === null ? null : testState.employeeId),
  useFeatureFlag: () => false,
  useModuleEnabled: (key: string) => !testState.disabledModules.has(key),
  useModulesEnabled: () => (...keys: string[]) => keys.every((k) => !testState.disabledModules.has(k)),
};
