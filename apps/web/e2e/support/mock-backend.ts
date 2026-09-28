import type { Page, Route } from '@playwright/test';
import type { DashboardSummary, DeviceDto, EmployeeDto, LeaveCommentDto, MeDto, Permission, SelfCompOffDto, SelfLeaveDto, SelfLeaveRecordDto } from '@flowza/contracts';

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
export const ALL_PERMISSIONS: Permission[] = ['dashboard.view', 'organization.view', 'organization.manage', 'user.view', 'user.manage', 'role.manage', 'branch.view', 'branch.manage', 'department.view', 'department.manage', 'employee.view', 'employee.view_team', 'employee.view_sensitive', 'employee.create', 'employee.update', 'employee.delete', 'employee.import', 'employee.export', 'device.view', 'device.create', 'device.update', 'device.manage', 'device.sync', 'shift.view', 'shift.manage', 'shift.assign', 'holiday.view', 'holiday.manage', 'leave.view', 'leave.manage', 'leave.request', 'attendance.view', 'attendance.view_own', 'attendance.view_raw', 'attendance.correct', 'attendance.approve', 'attendance.manage_rules', 'attendance.recalculate', 'attendance.lock_period', 'attendance.request_correction', 'payroll.view', 'payroll.finalize', 'report.view', 'report.manage', 'report.export', 'audit.view', 'notification.manage',
  'integration.manage', 'shift.request_swap', 'leave.approve', 'leave.view_team', 'attendance.view_team', 'attendance.checkin', 'attendance.note', 'attendance.review_notes', 'attendance.manage_geofences', 'attendance.manage_overtime', 'report.schedule', 'approval.manage', 'approval.delegate'];

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
      permissions: [...ALL_PERMISSIONS], allBranches: true, branchIds: [], employeeId: null, isManager: false, teamSize: 0, featureFlags: {},
      settings: { general: {}, attendance: {}, sync: {}, notifications: {}, security: {}, integrations: {} } as MeDto['memberships'][number]['settings'],
      ...overrides,
    }],
  };
}

export const dashboardFixture: DashboardSummary = { date: new Date().toISOString().slice(0, 10), employees: 512, presentToday: 431, absent: 44, late: 27, onLeave: 10, earlyDeparture: 6, overtimeMinutes: 1830, missingPunch: 9, devicesOnline: 18, devicesOffline: 1, devicesUnknown: 1, syncFailures24h: 2, pendingApprovals: 4 };
/** One trend point per day of the requested window, so the dashboard's chart and "vs last week" deltas have data. */
export function trendsFixture(url: URL) {
  const from = url.searchParams.get('from') ?? dashboardFixture.date;
  const to = url.searchParams.get('to') ?? dashboardFixture.date;
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const last = date === to;
    out.push({ date, present: last ? dashboardFixture.presentToday : 400 + d.getUTCDate(), absent: last ? dashboardFixture.absent : 40, late: last ? dashboardFixture.late : 22, onLeave: 10, missingPunch: 5, overtimeMinutes: 120 });
  }
  return out;
}
export const dashboardBranchesFixture = [
  { branchId: BRANCH_A, branchCode: 'MCT', branchName: 'Muscat HQ', employees: 300, present: 252, absent: 30, late: 10, onLeave: 8, missingPunch: 4, devicesOnline: 10, devicesOffline: 0 },
  { branchId: BRANCH_B, branchCode: 'SOH', branchName: 'Sohar Plant', employees: 212, present: 179, absent: 14, late: 17, onLeave: 2, missingPunch: 5, devicesOnline: 8, devicesOffline: 2 },
];

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

// ---- leave v2 (HR portal Prompt 7) ----------------------------------------------------------------------------------------
// Every leave endpoint the web calls has a handler: the HR Leave page (records, types, balances + CSV, allocations, year close,
// calendar, the comment thread) and the portal (/me/leave apply / edit / withdraw / reply, comp-off, the team's leave). The
// self-service part keeps state, so a request applied in the browser is listed on the next GET like the real API does.

/** The employee record a portal user is linked to (pass it as `meFixture({ employeeId: EMPLOYEE_ID })`). */
export const EMPLOYEE_ID = '99999999-9999-4999-8999-999999999999';
export const LEAVE_TYPE_AL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const LEAVE_TYPE_SL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const LEAVE_TYPE_CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const leavePolicy = { requiresApproval: true, countMode: 'working', maxConsecutiveDays: null, advanceNoticeDays: 0, applicableGender: 'all', accrual: 'none', carryForwardMaxDays: 0, carryForwardExpiryMonths: null, isSpecial: false, allowHalfDay: true, portalVisible: true, systemKey: null, compOff: false } as const;
/** GET /leave-types (HR shape, leave v2 policy included). */
export const leaveTypesFixture = [
  { id: LEAVE_TYPE_AL, code: 'AL', name: 'Annual Leave', nameAr: 'إجازة سنوية', isPaid: true, treatAsPresent: false, color: '#175cd3', annualAllowanceDays: 30, status: 'active', createdAt: '2026-01-01T00:00:00Z', ...leavePolicy, carryForwardMaxDays: 5, carryForwardExpiryMonths: 3 },
  { id: LEAVE_TYPE_SL, code: 'SL', name: 'Sick Leave', nameAr: 'إجازة مرضية', isPaid: true, treatAsPresent: false, color: '#b54708', annualAllowanceDays: null, status: 'active', createdAt: '2026-01-01T00:00:00Z', ...leavePolicy, isSpecial: true },
  { id: LEAVE_TYPE_CO, code: 'CO', name: 'Comp off', nameAr: 'إجازة تعويضية', isPaid: true, treatAsPresent: false, color: '#6941c6', annualAllowanceDays: null, status: 'active', createdAt: '2026-01-01T00:00:00Z', ...leavePolicy, isSpecial: true, portalVisible: false, systemKey: 'COMP_OFF', compOff: true },
];
const WEEKLY_OFF = [5, 6]; // Friday, Saturday (the organisation's weekly off days)
/** Working days of a range, as the API counts them for a working-days type (no holidays in the double). */
export function leaveWorkingDays(startDate: string, endDate: string, isHalfDay = false): number {
  let days = 0;
  for (let d = new Date(`${startDate}T00:00:00Z`); d.toISOString().slice(0, 10) <= endDate; d.setUTCDate(d.getUTCDate() + 1)) if (!WEEKLY_OFF.includes(d.getUTCDay())) days += 1;
  return isHalfDay ? days * 0.5 : days;
}
interface LeaveState { records: SelfLeaveRecordDto[]; comments: LeaveCommentDto[] }
function selfLeaveBody(st: LeaveState, year: number): SelfLeaveDto {
  const sum = (typeId: string, statuses: string[]) => st.records.filter((r) => r.leaveTypeId === typeId && statuses.includes(r.status)).reduce((a, r) => a + r.days, 0);
  const balance = (typeId: string, entitlement: number | null) => {
    const taken = sum(typeId, ['APPROVED']);
    const pending = sum(typeId, ['PENDING', 'INFO_REQUESTED']);
    return {
      leaveTypeId: typeId, allowanceDays: entitlement, usedDays: taken, pendingDays: pending, remainingDays: entitlement === null ? null : entitlement - taken - pending, tracked: entitlement !== null,
      entitlementDays: entitlement, takenDays: taken, availableDays: entitlement === null ? null : entitlement - taken, availableAfterPendingDays: entitlement === null ? null : entitlement - taken - pending,
      carriedForwardDays: 0, carriedForwardExpiresOn: null, carriedForwardExpiredDays: 0, accrual: 'none' as const,
    };
  };
  const alTaken = sum(LEAVE_TYPE_AL, ['APPROVED']);
  return {
    year,
    types: leaveTypesFixture.filter((t) => !t.compOff).map((t) => ({ id: t.id, code: t.code, name: t.name, nameAr: t.nameAr, isPaid: t.isPaid, color: t.color, annualAllowanceDays: t.annualAllowanceDays, requiresApproval: t.requiresApproval, countMode: t.countMode, allowHalfDay: t.allowHalfDay, advanceNoticeDays: t.advanceNoticeDays, maxConsecutiveDays: t.maxConsecutiveDays, accrual: t.accrual, compOff: false })),
    balances: [balance(LEAVE_TYPE_AL, 30), balance(LEAVE_TYPE_SL, null)],
    records: st.records.filter((r) => r.startDate.startsWith(String(year)) || r.endDate.startsWith(String(year))),
    calendar: { weeklyOffDays: WEEKLY_OFF, holidays: [] },
    asOf: new Date().toISOString().slice(0, 10),
    totals: { entitlementDays: 30, takenDays: alTaken, pendingDays: sum(LEAVE_TYPE_AL, ['PENDING', 'INFO_REQUESTED']), availableDays: 30 - alTaken, accruedToDateDays: 30 },
    compOff: { leaveTypeId: LEAVE_TYPE_CO, earnedDays: 0, usedDays: 0, availableDays: 0, pendingDays: 0, availableAfterPendingDays: 0 },
  };
}
const compOffBody: SelfCompOffDto = { balance: { leaveTypeId: LEAVE_TYPE_CO, earnedDays: 0, usedDays: 0, availableDays: 0, pendingDays: 0, availableAfterPendingDays: 0 }, credits: [], rules: { fullDayHours: 8, halfDayHours: 4, expiryDays: 90 } };
const notFound = { status: 404, body: { code: 'NOT_FOUND', message: 'Leave request not found', requestId: 'e2e-request' } };

/** The leave endpoints (method + path relative to /api/v1); undefined = not a leave route. */
function leaveRoute(st: LeaveState, method: string, path: string, body: unknown, url: URL): { status?: number; body: unknown; csv?: string } | undefined {
  const org = `/orgs/${ORG_ID}`;
  if (!path.startsWith(org)) return undefined;
  const p = path.slice(org.length);
  const b = (body ?? {}) as Record<string, unknown>;
  const year = Number(url.searchParams.get('year')) || new Date().getUTCFullYear();
  const comments = /^\/leave-records\/([^/]+)\/comments$/.exec(p);
  if (method === 'GET') {
    if (p === '/leave-types') return { body: { data: leaveTypesFixture } };
    if (p === '/leave-records' || p === '/leave-balances' || p === '/leave-allocations') return { body: page([]) };
    if (p === '/leave-balances/export') return { body: null, csv: '﻿Employee number,Employee,Year\r\n' };
    if (p === '/leave-calendar') { const month = url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7); return { body: { data: { month, from: `${month}-01`, to: `${month}-28`, employees: [], entries: [], truncated: false } } }; }
    if (comments) return { body: { data: st.comments.filter((c) => c.leaveRecordId === comments[1]) } };
    if (p === '/me/leave') return { body: { data: selfLeaveBody(st, year) } };
    if (p === '/me/team/leave') return { body: { data: [] } };
    if (p === '/me/comp-off') return { body: { data: compOffBody } };
    if (p === '/me/comp-off/preview') {
      const workedOn = url.searchParams.get('workedOn') ?? '';
      const weekly = WEEKLY_OFF.includes(new Date(`${workedOn}T00:00:00Z`).getUTCDay());
      return { body: { data: { workedOn, workedOnType: weekly ? 'weekly_off' : null, holidayName: null, recordedMinutes: null, daysEarned: 0, alreadyRequested: false, eligible: weekly, reason: weekly ? null : 'working_day' } } };
    }
    if (p === '/settings/leave') return { body: { data: {} } };
    return undefined;
  }
  if (method === 'POST') {
    if (p === '/me/leave') {
      const type = leaveTypesFixture.find((t) => t.id === b['leaveTypeId']);
      if (!type) return { status: 400, body: { code: 'VALIDATION_ERROR', message: 'Unknown leave type', requestId: 'e2e-request' } };
      const isHalfDay = !!b['isHalfDay'];
      const rec: SelfLeaveRecordDto = {
        id: `dddddddd-dddd-4ddd-8ddd-${String(st.records.length + 1).padStart(12, '0')}`, leaveTypeId: type.id, leaveTypeCode: type.code, leaveTypeName: type.name, color: type.color, isPaid: type.isPaid,
        startDate: String(b['startDate']), endDate: String(b['endDate']), isHalfDay, halfDayPart: isHalfDay ? String(b['halfDayPart'] ?? 'FIRST_HALF') : null, days: leaveWorkingDays(String(b['startDate']), String(b['endDate']), isHalfDay),
        reason: typeof b['reason'] === 'string' ? b['reason'] : null, status: 'PENDING', decisionNote: null, approvedByName: null, approvedAt: null, createdAt: nowIso(), updatedAt: nowIso(),
        approvalRequestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 1, canEdit: true, canWithdraw: true, canReply: false, infoRequest: null, commentCount: 0, compOff: type.compOff, warnings: [],
      };
      st.records.unshift(rec);
      return { status: 201, body: { data: rec } };
    }
    const action = /^\/me\/leave\/([^/]+)\/(withdraw|cancel|reply)$/.exec(p);
    if (action) {
      const rec = st.records.find((r) => r.id === action[1]);
      if (!rec) return notFound;
      if (action[2] === 'reply') Object.assign(rec, { status: 'PENDING', canReply: false, infoRequest: null });
      else Object.assign(rec, { status: 'CANCELLED', withdrawnAt: nowIso(), canEdit: false, canWithdraw: false, approvalStatus: 'CANCELLED' });
      return { body: { data: rec } };
    }
    if (comments) {
      const c: LeaveCommentDto = { id: `c-${st.comments.length + 1}`, leaveRecordId: comments[1]!, authorUserId: USER_ID, authorName: 'Aisha Al Balushi', kind: 'comment', body: String(b['body'] ?? ''), createdAt: nowIso(), mine: true };
      st.comments.push(c);
      return { status: 201, body: { data: c } };
    }
    if (p === '/me/comp-off') return { status: 201, body: { data: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', employeeId: EMPLOYEE_ID, ...b, daysEarned: 1, status: 'pending_approval', usedDays: 0, remainingDays: 0, expiresOn: null, decisionNote: null, approvalRequestId: null, approvalStatus: 'PENDING', createdAt: nowIso(), updatedAt: nowIso() } } };
    if (p === '/leave-allocations/generate') return { status: 201, body: { data: { year: Number(b['year']), created: 0, skipped: 0, employees: 0, leaveTypes: 0 } } };
    if (p === '/leave-allocations/year-close') return { status: 202, body: { data: { jobId: '12121212-1212-4121-8121-121212121212', status: 'QUEUED', fromYear: Number(b['fromYear']), toYear: Number(b['fromYear']) + 1 } } };
    return undefined;
  }
  if (method === 'PATCH') {
    const own = /^\/me\/leave\/([^/]+)$/.exec(p);
    if (own) {
      const rec = st.records.find((r) => r.id === own[1]);
      if (!rec) return notFound;
      Object.assign(rec, b, { status: 'PENDING', editedAt: nowIso() });
      rec.days = leaveWorkingDays(rec.startDate, rec.endDate, rec.isHalfDay);
      return { body: { data: rec } };
    }
    const hr = /^\/leave-records\/([^/]+)$/.exec(p);
    if (hr) return { body: { data: { id: hr[1], ...b, recalculationJobId: null, warnings: [] } } };
    return undefined;
  }
  if (method === 'PUT') {
    if (p === '/leave-allocations') return { body: { data: { created: 0, updated: Array.isArray(b['rows']) ? b['rows'].length : 0, unchanged: 0, allocations: [] } } };
    if (p === '/settings/leave') return { body: { data: b } };
    return undefined;
  }
  return undefined;
}

export interface MockBackendOptions {
  /** the user is signed in before the page loads (session pre-seeded in localStorage) */
  me?: MeDto;
  /** GET handlers keyed by `/api/v1`-relative path; a function may inspect the URL */
  get?: Record<string, unknown | ((url: URL) => unknown)>;
  /** POST handlers keyed by `/api/v1`-relative path; return the status and the JSON body */
  post?: Record<string, (body: unknown, url: URL) => { status?: number; body: unknown }>;
  /** PATCH / PUT handlers, as `post` (the leave endpoints answer by default — see leaveRoute) */
  patch?: Record<string, (body: unknown, url: URL) => { status?: number; body: unknown }>;
  put?: Record<string, (body: unknown, url: URL) => { status?: number; body: unknown }>;
  /** reject the password grant (wrong credentials) */
  rejectSignIn?: boolean;
  /** reject sign-up (address already registered) */
  rejectSignUp?: boolean;
  /** sign-up creates the user but withholds the session, as a project that requires email confirmation does */
  confirmEmailOnSignUp?: boolean;
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
  const leave: LeaveState = { records: [], comments: [] };
  const getHandlers: Record<string, unknown | ((url: URL) => unknown)> = {
    '/me': { data: me },
    '/me/notifications/unread-count': { data: { unread: 0 } },
    '/me/notifications': page_([]),
    [`/orgs/${ORG_ID}/dashboard/summary`]: { data: dashboardFixture },
    [`/orgs/${ORG_ID}/dashboard/trends`]: (url: URL) => ({ data: trendsFixture(url) }),
    [`/orgs/${ORG_ID}/dashboard/branches`]: { data: dashboardBranchesFixture },
    [`/orgs/${ORG_ID}/holidays`]: { data: [] },
    // approval engine v2: the dashboard's queue card (scope mine, pending) and the approver's delegations banner
    [`/orgs/${ORG_ID}/approvals`]: page_([]),
    [`/orgs/${ORG_ID}/approval-delegations`]: { data: [] },
    [`/orgs/${ORG_ID}/settings/dashboard`]: { data: me.memberships[0]?.settings.dashboard ?? {} },
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
    if (url.pathname.endsWith('/signup')) {
      if (opts.rejectSignUp) return json(route, 422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
      // GoTrue answers with a bare user (no tokens) while the address is unconfirmed, and with a full session otherwise
      return json(route, 200, opts.confirmEmailOnSignUp ? { ...sessionBody().user, email_confirmed_at: null } : sessionBody());
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
      const leaveAnswer = leaveRoute(leave, 'GET', path, body, url);
      if (leaveAnswer?.csv !== undefined) return route.fulfill({ status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="leave-balances.csv"', ...CORS }, body: leaveAnswer.csv });
      if (leaveAnswer) return json(route, leaveAnswer.status ?? 200, leaveAnswer.body);
      state.unmatched.push(path);
      // unknown list endpoints (filter option sources etc.) answer with an empty page so screens render their empty states
      return json(route, 200, page_([]));
    }
    const custom = req.method() === 'POST' ? opts.post?.[path] : req.method() === 'PATCH' ? opts.patch?.[path] : req.method() === 'PUT' ? opts.put?.[path] : undefined;
    if (custom) { const r = custom(body, url); return json(route, r.status ?? 200, r.body); }
    const leaveAnswer = leaveRoute(leave, req.method(), path, body, url);
    if (leaveAnswer) return json(route, leaveAnswer.status ?? 200, leaveAnswer.body);
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
