import type { Page, Route } from '@playwright/test';
import type { DashboardSummary, DeviceDto, EmployeeDto, MeDto, Permission } from '@flowza/contracts';

/**
 * Backend double for the UI end-to-end suite.
 *
 * The bundle under test is built with same-origin backend URLs (`VITE_API_URL=http://localhost:4173`,
 * `VITE_SUPABASE_URL=http://localhost:4173/supabase`), so every request the SPA makes — Supabase Auth (GoTrue) calls made by
 * supabase-js and FlowZa API calls made by `apiFetch` — can be answered here with `page.route`. Nothing leaves the browser.
 *
 * What is faithful: the auth session shape supabase-js expects (a real-looking JWT with `aal`/`amr`, refresh token, expiry),
 * the API envelopes (`{ data }`, `{ data, meta }`, `{ code, message, requestId }`) and the DTOs from `@flowza/contracts`.
 * What is not covered: authorization, RLS and calculations — those are covered by the API, worker and database suites.
 */

export const ORG_ID = '11111111-1111-4111-8111-111111111111';
export const BRANCH_A = '22222222-2222-4222-8222-222222222222';
export const BRANCH_B = '33333333-3333-4333-8333-333333333333';
export const USER_ID = '44444444-4444-4444-8444-444444444444';
export const OWNER = { email: 'owner@albahja.example', password: 'FlowZa-E2E-2026!' };
/** Every permission key (mirrors PERMISSIONS in @flowza/contracts; copied so this file has no runtime dependency on the package build). */
export const ALL_PERMISSIONS: Permission[] = ['dashboard.view', 'organization.view', 'organization.manage', 'user.view', 'user.manage', 'role.manage', 'branch.view', 'branch.manage', 'department.view', 'department.manage', 'employee.view', 'employee.view_sensitive', 'employee.create', 'employee.update', 'employee.delete', 'employee.import', 'employee.export', 'device.view', 'device.create', 'device.update', 'device.manage', 'device.sync', 'shift.view', 'shift.manage', 'shift.assign', 'holiday.view', 'holiday.manage', 'leave.view', 'leave.manage', 'attendance.view', 'attendance.view_own', 'attendance.view_raw', 'attendance.correct', 'attendance.approve', 'attendance.manage_rules', 'attendance.recalculate', 'attendance.lock_period', 'payroll.view', 'payroll.finalize', 'report.view', 'report.manage', 'report.export', 'audit.view', 'notification.manage'];

const nowIso = () => new Date().toISOString();

const b64url = (v: string | object) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
/** Unsigned-but-well-formed JWT: supabase-js decodes the payload (aal, exp, sub) and never verifies the signature client-side. */
export function fakeJwt(overrides: Record<string, unknown> = {}): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = { iss: 'http://localhost:4173/supabase/auth/v1', sub: USER_ID, aud: 'authenticated', role: 'authenticated', email: OWNER.email, aal: 'aal1', amr: [{ method: 'password', timestamp: iat }], session_id: '55555555-5555-4555-8555-555555555555', iat, exp: iat + 3600, ...overrides };
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.${b64url('e2e-signature')}`;
}
function sessionBody() {
  const expiresIn = 3600;
  const user = { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: OWNER.email, email_confirmed_at: nowIso(), app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { full_name: 'Aisha Al Balushi' }, identities: [], created_at: nowIso(), updated_at: nowIso(), factors: [] };
  return { access_token: fakeJwt(), token_type: 'bearer', expires_in: expiresIn, expires_at: Math.floor(Date.now() / 1000) + expiresIn, refresh_token: 'e2e-refresh-token', user };
}

export const organization = {
  id: ORG_ID, companyCode: 'ALBAHJA', legalName: 'Al Bahja Trading LLC', displayName: 'Al Bahja Trading', countryCode: 'OM', timezone: 'Asia/Muscat', currencyCode: 'OMR', locale: 'en',
  weeklyOffDays: [5, 6], logoPath: null, logoUrl: null, contact: {}, address: {}, status: 'active', createdAt: '2026-01-01T00:00:00Z',
};

export function meFixture(overrides: Partial<MeDto['memberships'][number]> = {}): MeDto {
  return {
    user: { id: USER_ID, email: OWNER.email, fullName: 'Aisha Al Balushi', avatarUrl: null, locale: 'en', mfaEnrolled: false, isPlatformAdmin: false },
    memberships: [{
      membershipId: '66666666-6666-4666-8666-666666666666', organization: organization as MeDto['memberships'][number]['organization'], roleId: '10000000-0000-0000-0000-000000000001', roleKey: 'owner', roleName: 'Owner',
      permissions: [...ALL_PERMISSIONS], allBranches: true, branchIds: [], employeeId: null, featureFlags: {},
      settings: { general: {}, attendance: {}, sync: {}, notifications: {}, security: {}, integrations: {} } as MeDto['memberships'][number]['settings'],
      ...overrides,
    }],
  };
}

export const dashboardFixture: DashboardSummary = { date: new Date().toISOString().slice(0, 10), employees: 512, presentToday: 431, absent: 44, late: 27, onLeave: 10, earlyDeparture: 6, overtimeMinutes: 1830, missingPunch: 9, devicesOnline: 18, devicesOffline: 1, devicesUnknown: 1, syncFailures24h: 2, pendingApprovals: 4 };

const employee = (n: number, name: string, branchId: string, branchName: string): EmployeeDto => ({
  id: `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`, organizationId: ORG_ID, employeeNumber: String(1000 + n), firstName: name.split(' ')[0]!, middleName: null, lastName: name.split(' ').slice(1).join(' '), displayName: name, displayNameAr: null,
  photoPath: null, photoUrl: null, gender: 'unspecified', dateOfBirth: null, nationalityCode: 'OM', email: `${name.split(' ')[0]!.toLowerCase()}@albahja.example`, phone: null, joiningDate: '2024-02-01', exitDate: null,
  employmentStatus: 'active', employmentType: 'full_time', branchId, branchName, departmentId: null, departmentName: 'Operations', designationId: null, designationName: null, managerEmployeeId: null, managerName: null, userId: null,
  deviceUserId: String(1000 + n), cardNumber: null, fingerprintEnrolled: true, faceEnrolled: false, weeklyOffDays: null, customFields: {}, deviceSyncSummary: { total: 2, inSync: 2, pending: 0, failed: 0, offline: 0 }, deletedAt: null, createdAt: '2024-02-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z',
} as EmployeeDto);
export const employeesFixture: EmployeeDto[] = [employee(1, 'Salim Al Harthy', BRANCH_A, 'Muscat HQ'), employee(2, 'Maryam Al Lawati', BRANCH_A, 'Muscat HQ'), employee(3, 'Khalid Al Balushi', BRANCH_B, 'Sohar Plant')];

const device = (n: number, name: string, code: string, branchId: string, branchName: string, connectionStatus: DeviceDto['connectionStatus']): DeviceDto => ({
  id: `88888888-8888-4888-8888-${String(n).padStart(12, '0')}`, organizationId: ORG_ID, branchId, branchName, code, name, providerKey: 'mock', providerName: 'FlowZa Mock Provider', modelId: null, manufacturer: 'FlowZa', modelName: 'SIM-100', serialNumber: `SIM${n}00${n}`,
  timezone: 'Asia/Muscat', integrationType: 'VENDOR_CLOUD_PULL', endpointUrl: 'https://mock.example.com/api', config: { scenario: 'healthy' }, capabilities: { attendancePull: true, employeePush: true, employeeDelete: true, deviceStatus: true, remoteRestart: false, webhooks: true, devicePush: false, attendancePush: false, fingerprint: true, face: false, card: true, pin: true, biometricTemplatePush: false },
  status: 'active', connectionStatus, lastHeartbeatAt: connectionStatus === 'online' ? nowIso() : null, lastAttendanceSyncAt: nowIso(), lastEmployeeSyncAt: nowIso(), lastSuccessfulCommunicationAt: connectionStatus === 'online' ? nowIso() : null, lastErrorCode: null, lastError: null,
  firmwareVersion: '1.0.0', offlineThresholdMinutes: 15, autoSyncEnabled: true, syncIntervalMinutes: 10, employeeCount: 120, tags: ['gate'], maskedCredentials: { apiKey: '****1234' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: nowIso(),
} as DeviceDto);
export const devicesFixture: DeviceDto[] = [device(1, 'Main gate', 'GATE-1', BRANCH_A, 'Muscat HQ', 'online'), device(2, 'Plant entrance', 'PLANT-1', BRANCH_B, 'Sohar Plant', 'offline')];

export const branchesFixture = [
  { id: BRANCH_A, organizationId: ORG_ID, code: 'MCT', name: 'Muscat HQ', nameAr: 'مسقط', countryCode: 'OM', city: 'Muscat', address: {}, timezone: 'Asia/Muscat', latitude: null, longitude: null, geofenceRadiusM: null, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active', employeeCount: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: BRANCH_B, organizationId: ORG_ID, code: 'SOH', name: 'Sohar Plant', nameAr: 'صحار', countryCode: 'OM', city: 'Sohar', address: {}, timezone: 'Asia/Muscat', latitude: null, longitude: null, geofenceRadiusM: null, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active', employeeCount: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
];

export const page = <T,>(data: T[], pageNo = 1, pageSize = 25) => ({ data, meta: { page: pageNo, pageSize, total: data.length, totalPages: Math.max(1, Math.ceil(data.length / pageSize)) } });

export interface MockBackendOptions {
  /** the user is signed in before the page loads (session pre-seeded in localStorage) */
  me?: MeDto;
  /** GET handlers keyed by `/api/v1`-relative path; a function may inspect the URL */
  get?: Record<string, unknown | ((url: URL) => unknown)>;
  /** reject the password grant (wrong credentials) */
  rejectSignIn?: boolean;
}

export interface MockBackend {
  /** every request the SPA made to the API (method + path), for assertions */
  calls: Array<{ method: string; path: string; body?: unknown }>;
  /** API GET paths nobody registered (answered with an empty page) */
  unmatched: string[];
}

const CORS: Record<string, string> = { 'access-control-allow-origin': '*' };
const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) => route.fulfill({ status, headers: { 'content-type': 'application/json', ...CORS, ...headers }, body: JSON.stringify(body) });
const apiError = (route: Route, status: number, code: string, message: string) => json(route, status, { code, message, requestId: 'e2e-request' });

/** Install the backend double on `page`. Call before `page.goto`. */
export async function installMockBackend(page: Page, opts: MockBackendOptions = {}): Promise<MockBackend> {
  const me = opts.me ?? meFixture();
  const state: MockBackend = { calls: [], unmatched: [] };
  const getHandlers: Record<string, unknown | ((url: URL) => unknown)> = {
    '/me': { data: me },
    '/me/notifications/unread-count': { data: { unread: 0 } },
    '/me/notifications': page_([]),
    [`/orgs/${ORG_ID}/dashboard/summary`]: { data: dashboardFixture },
    [`/orgs/${ORG_ID}/employees`]: (url: URL) => { const q = (url.searchParams.get('search') ?? '').toLowerCase(); return page_(employeesFixture.filter((e) => !q || e.displayName.toLowerCase().includes(q))); },
    [`/orgs/${ORG_ID}/branches`]: page_(branchesFixture),
    [`/orgs/${ORG_ID}/departments`]: page_([]),
    [`/orgs/${ORG_ID}/devices`]: page_(devicesFixture),
    [`/orgs/${ORG_ID}/devices/summary`]: { data: { total: 2, byConnectionStatus: { online: 1, offline: 1 }, byStatus: { active: 2 }, staleHeartbeats: 1 } },
    [`/orgs/${ORG_ID}/devices/pending`]: { data: [] },
    [`/orgs/${ORG_ID}/device-groups`]: { data: [] },
    '/device-providers': { data: [] },
    [`/orgs/${ORG_ID}/search`]: (url: URL) => { const q = (url.searchParams.get('q') ?? '').toLowerCase(); return { data: { q, employees: employeesFixture.filter((e) => e.displayName.toLowerCase().includes(q)).map((e) => ({ type: 'employee', id: e.id, title: e.displayName, subtitle: e.employeeNumber, branchId: e.branchId, status: e.employmentStatus })), devices: [], branches: [], departments: [] } }; },
    ...opts.get,
  };

  // ---- Supabase Auth (GoTrue) -------------------------------------------------------------------------------------
  await page.route('**/supabase/auth/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (url.pathname.endsWith('/token')) {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password' && opts.rejectSignIn) return json(route, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return json(route, 200, sessionBody());
    }
    if (url.pathname.endsWith('/user')) return json(route, 200, sessionBody().user);
    if (url.pathname.endsWith('/logout')) return route.fulfill({ status: 204, headers: CORS });
    if (url.pathname.endsWith('/factors')) return json(route, 200, { totp: [], all: [] });
    return json(route, 404, { msg: `no e2e handler for ${url.pathname}` });
  });
  // realtime websockets are not part of this suite
  await page.route('**/supabase/realtime/**', (route) => route.abort());

  // ---- FlowZa API ----------------------------------------------------------------------------------------------------
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^.*\/api\/v1/, '');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (!req.headers()['authorization']?.startsWith('Bearer ')) return apiError(route, 401, 'UNAUTHENTICATED', 'Missing bearer token');
    let body: unknown; try { body = req.postDataJSON(); } catch { body = req.postData(); }
    state.calls.push({ method: req.method(), path, body });
    if (req.method() === 'GET') {
      const handler = getHandlers[path];
      if (handler !== undefined) return json(route, 200, typeof handler === 'function' ? (handler as (u: URL) => unknown)(url) : handler);
      state.unmatched.push(path);
      // unknown list endpoints (filter option sources etc.) answer with an empty page so screens render their empty states
      return json(route, 200, page_([]));
    }
    return apiError(route, 404, 'NOT_FOUND', `No e2e handler for ${req.method()} ${path}`);
  });
  return state;
}

/** Pre-seed a signed-in supabase-js session so tests can start on an authenticated page. */
export async function signInDirectly(page: Page): Promise<void> {
  const session = sessionBody();
  const supabaseUrl = 'http://localhost:4173/supabase';
  const ref = new URL(supabaseUrl).hostname.split('.')[0];
  // supabase-js persists under `sb-<project-ref>-auth-token`; for a custom URL the ref is the hostname
  await page.addInitScript(([key, value]) => { window.localStorage.setItem(key as string, value as string); }, [`sb-${ref}-auth-token`, JSON.stringify(session)]);
}

function page_<T>(data: T[]) { return page(data); }
