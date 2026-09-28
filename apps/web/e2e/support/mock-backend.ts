import type { Page, Route } from '@playwright/test';
import type { ApprovalDelegationDto, ApprovalRequestDto, ApprovalWorkflowDto, AttendanceNoteDto, DashboardSummary, DeviceDto, EmployeeDto, FinanceIntegrationDto, FinanceIntegrationStatusDto, LeaveCommentDto, MeDto, Permission, SelfCompOffDto, SelfLeaveDto, SelfLeaveRecordDto, SelfPunchDto, SelfPunchStatusDto } from '@flowza/contracts';

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
      permissions: [...ALL_PERMISSIONS], allBranches: true, branchIds: [], employeeId: null, isManager: false, teamSize: 0, approvals: { actionable: 0, delegatedToMe: false }, featureFlags: {},
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

/** Flowza Finance connector as GET /integrations/finance answers before it is configured (defaults; start date 30 days back). */
export const financeIntegrationFixture = (): FinanceIntegrationDto => ({
  configured: false, enabled: false, deviceId: null, branchId: null, baseUrl: 'https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1', deviceSerial: null, direction: 'both', pinKey: 'employee_number', pollMinutes: 10,
  syncFrom: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), hasToken: false, tokenMasked: null, connectionStatus: null, lastErrorCode: null, lastError: null, updatedAt: null,
});

export const branchesFixture = [
  { id: BRANCH_A, organizationId: ORG_ID, code: 'MCT', name: 'Muscat HQ', nameAr: 'مسقط', countryCode: 'OM', city: 'Muscat', address: {}, timezone: 'Asia/Muscat', latitude: null, longitude: null, geofenceRadiusM: null, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active', employeeCount: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: BRANCH_B, organizationId: ORG_ID, code: 'SOH', name: 'Sohar Plant', nameAr: 'صحار', countryCode: 'OM', city: 'Sohar', address: {}, timezone: 'Asia/Muscat', latitude: null, longitude: null, geofenceRadiusM: null, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active', employeeCount: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
];

// ---- HR attendance workspace (HR portal Prompt 6a) ------------------------------------------------------------------------------
/** "Today" of the workspace fixtures: the calendar's today ring and the last day HR may add a record for. */
export const WORKSPACE_TODAY = '2026-09-20';
const outcome = (over: Record<string, unknown> = {}) => ({ status: 'ABSENT', flags: [], firstInAt: null, lastOutAt: null, workedMinutes: 0, breakMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, scheduledMinutes: 540, punchCount: 0, lopDays: 0, ...over });
const calendarDay = (recordId: string, date: string, over: Record<string, unknown> = {}) => ({
  recordId, status: 'PRESENT', flags: [], statusSource: 'AUTO', firstInAt: `${date}T04:02:00Z`, lastOutAt: `${date}T13:05:00Z`, workedMinutes: 543, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0, timezone: 'Asia/Muscat', ...over,
});
/** One month of the calendar register: working days present, a late day, a manual absence, weekly offs; Salim's 14th left empty. */
export function calendarFixture(month = '2026-09') {
  const rows = employeesFixture.map((e, i) => {
    const days: Record<string, unknown> = {};
    for (let d = 1; d <= 19; d += 1) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (d === 14 && i === 0) continue; // no record: HR adds it in the scenario
      if (dow === 5 || dow === 6) days[date] = calendarDay(`rec-${i}-${d}`, date, { status: 'WEEKLY_OFF', firstInAt: null, lastOutAt: null, workedMinutes: 0 });
      else if (d === 8) days[date] = calendarDay(`rec-${i}-${d}`, date, { flags: ['LATE'], lateMinutes: 17, firstInAt: `${date}T04:17:00Z` });
      else if (d === 9 && i === 1) days[date] = calendarDay(`rec-${i}-${d}`, date, { status: 'ABSENT', statusSource: 'MANUAL', firstInAt: null, lastOutAt: null, workedMinutes: 0, flags: ['MANUAL_CORRECTION'] });
      else days[date] = calendarDay(`rec-${i}-${d}`, date);
    }
    return { employeeId: e.id, employeeNumber: e.employeeNumber, employeeName: e.displayName, branchId: e.branchId, departmentId: null, joiningDate: e.joiningDate, exitDate: null, days };
  });
  return { data: rows, meta: { page: 1, pageSize: 12, total: rows.length, totalPages: 1, month, days: [], today: WORKSPACE_TODAY } };
}
/** POST /attendance/preview: the empty day as the engine sees it, then the proposed check-in / check-out. */
export function previewFixture(body: { employeeId: string; date: string; inAt?: string | null; outAt?: string | null }) {
  const e = employeesFixture.find((x) => x.id === body.employeeId) ?? employeesFixture[0]!;
  const proposed = !!(body.inAt || body.outAt);
  const plan = [
    ...(body.inAt ? [{ type: 'ADD_PUNCH', originalEventId: null, originalPunchedAt: null, proposedPunchedAt: body.inAt, proposedEventType: 'PUNCH_IN', proposedStatus: null }] : []),
    ...(body.outAt ? [{ type: 'ADD_PUNCH', originalEventId: null, originalPunchedAt: null, proposedPunchedAt: body.outAt, proposedEventType: 'PUNCH_OUT', proposedStatus: null }] : []),
  ];
  return {
    data: {
      employeeId: e.id, employeeNumber: e.employeeNumber, employeeName: e.displayName, date: body.date, timezone: 'Asia/Muscat', recordId: null,
      shift: { id: '99999999-9999-4999-8999-000000000001', code: 'DAY', name: 'Day shift', expectedStartAt: `${body.date}T04:00:00Z`, expectedEndAt: `${body.date}T13:00:00Z`, scheduledMinutes: 540 },
      current: outcome(),
      preview: proposed ? outcome({ status: 'PRESENT', firstInAt: body.inAt ?? null, lastOutAt: body.outAt ?? null, workedMinutes: 510, punchCount: 2, flags: ['EARLY_DEPARTURE'], earlyDepartureMinutes: 30 }) : outcome(),
      statusSource: 'AUTO', manualStatus: null, punches: { in: null, out: null }, plan, pendingCorrections: 0, locked: false,
    },
  };
}
const summaryFigures = (present: number, late: number, absent: number) => ({ presentDays: present, lateDays: late, halfDays: 0, leaveDays: 1, absentDays: absent, missingPunchDays: 0, holidayDays: 0, weeklyOffDays: 4, daysWorked: present, workedMinutes: present * 540, overtimeMinutes: 45, averageWorkedMinutes: 540, lopDays: 0, unexcusedDays: absent, pendingDays: 0, recordCount: 19 });
export function summaryFixture(month = '2026-09') {
  const rows = employeesFixture.map((e, i) => ({ ...summaryFigures(13 - i, i, i), employeeId: e.id, employeeNumber: e.employeeNumber, employeeName: e.displayName, branchId: e.branchId, branchName: e.branchName, departmentId: null, departmentName: 'Operations', source: 'LIVE', finalizedAt: null }));
  const totals = rows.reduce((acc, r) => ({ ...acc, presentDays: acc.presentDays + r.presentDays, lateDays: acc.lateDays + r.lateDays, absentDays: acc.absentDays + r.absentDays, leaveDays: acc.leaveDays + r.leaveDays, workedMinutes: acc.workedMinutes + r.workedMinutes, overtimeMinutes: acc.overtimeMinutes + r.overtimeMinutes }), summaryFigures(0, 0, 0));
  return { data: rows, meta: { page: 1, pageSize: 50, total: rows.length, totalPages: 1, month, from: `${month}-01`, to: `${month}-30`, totals } };
}
/** GET / POST handlers of the HR attendance workspace, to spread into installMockBackend's options. */
export function hrWorkspaceHandlers(): { get: NonNullable<MockBackendOptions['get']>; post: NonNullable<MockBackendOptions['post']> } {
  return {
    get: {
      [`/orgs/${ORG_ID}/attendance/calendar`]: (url: URL) => calendarFixture(url.searchParams.get('month') ?? '2026-09'),
      [`/orgs/${ORG_ID}/attendance/summary`]: (url: URL) => summaryFixture(url.searchParams.get('month') ?? '2026-09'),
      [`/orgs/${ORG_ID}/attendance/manual-statuses`]: { data: [] },
    },
    post: {
      [`/orgs/${ORG_ID}/attendance/preview`]: (body) => ({ body: previewFixture(body as Parameters<typeof previewFixture>[0]) }),
      [`/orgs/${ORG_ID}/attendance/record-edits`]: () => ({ status: 201, body: { data: { corrections: [{ id: 'c-in', type: 'ADD_PUNCH', status: 'APPROVED', approval: 'AUTO_APPROVED' }, { id: 'c-out', type: 'ADD_PUNCH', status: 'APPROVED', approval: 'AUTO_APPROVED' }], applied: true, failed: null, unchanged: 0 } } }),
    },
  };
}

// ---- approval engine v2 (review fixes: P2-12) ------------------------------------------------------------------------------------
export const APPROVAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
export const COLLEAGUE = { userId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', fullName: 'Salma Al Hinai', email: 'salma@albahja.example' };
const REPORT_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
/** A two-level leave request waiting for the signed-in owner at level 2 (level 1 approved by the manager). */
export function approvalRequestFixture(over: Partial<ApprovalRequestDto> = {}): ApprovalRequestDto {
  const salim = employeesFixture[0]!;
  const actor = (userId: string, userName: string, decision: 'PENDING' | 'APPROVED', path: string, decidedAt: string | null = null, comment: string | null = null) => ({ userId, userName, viaDelegationOf: null, viaDelegationOfName: null, onBehalfOfUserId: null, onBehalfOfName: null, resolutionPath: path, decision, decidedAt, comment });
  const step = (stepNo: number, status: 'PENDING' | 'APPROVED', approverType: 'MANAGER' | 'USER', actors: ReturnType<typeof actor>[]) => ({
    id: `step-${stepNo}`, requestId: APPROVAL_ID, stepNo, approverType, approverRoleId: null, approverUserId: actors[0]!.userId, permissionKey: null, mode: 'ANY' as const, requiredCount: 1, status,
    resolutionPath: actors[0]!.resolutionPath, resolutionReason: null, activatedAt: '2026-09-20T05:00:00Z', dueAt: null, escalateTo: null, escalatedAt: null, remindedAt: null,
    actedBy: status === 'APPROVED' ? actors[0]!.userId : null, actedByName: status === 'APPROVED' ? actors[0]!.userName : null, actedAt: status === 'APPROVED' ? '2026-09-20T06:00:00Z' : null, comment: status === 'APPROVED' ? 'Fine by me' : null, actors,
  });
  return {
    id: APPROVAL_ID, organizationId: ORG_ID, workflowId: null, workflowName: 'Leave: manager then owner', entityType: 'LEAVE', entityId: 'cccccccc-cccc-4ccc-8ccc-000000000001', branchId: BRANCH_A, departmentId: null,
    employeeId: salim.id, employeeName: salim.displayName, employeeNumber: salim.employeeNumber, units: 2, currentStep: 2, stepCount: 2, status: 'PENDING', requestedBy: REPORT_USER, requestedByName: salim.displayName, subjectUserId: REPORT_USER,
    infoRequestedAt: null, completedAt: null, decidedBy: null, decidedByName: null, cancelReason: null, invalidationReason: null, createdAt: '2026-09-20T05:00:00Z', updatedAt: '2026-09-20T06:00:00Z',
    steps: [step(1, 'APPROVED', 'MANAGER', [actor('dddddddd-dddd-4ddd-8ddd-000000000001', 'Khalid Manager', 'APPROVED', 'primary', '2026-09-20T06:00:00Z', 'Fine by me')]), step(2, 'PENDING', 'USER', [actor(USER_ID, 'Aisha Al Balushi', 'PENDING', 'user')])],
    context: { kind: 'LEAVE', leave: { id: 'cccccccc-cccc-4ccc-8ccc-000000000001', leaveTypeId: 'lt-annual', leaveTypeName: 'Annual Leave', startDate: '2026-10-04', endDate: '2026-10-05', isHalfDay: false, halfDayPart: null, days: 2, reason: 'Family wedding', status: 'PENDING', balanceRemainingDays: 18, allowanceDays: 30 } },
    abilities: { canDecide: true, canCancel: false, canReassign: true, canBypass: true, canRequestInfo: true, canAnswerInfo: false, actingAsDelegateOf: null, decideVia: 'actor' },
    events: [
      { id: '1', at: '2026-09-20T05:00:00Z', actorUserId: REPORT_USER, actorName: salim.displayName, kind: 'submitted', detail: {} },
      { id: '2', at: '2026-09-20T06:00:00Z', actorUserId: 'dddddddd-dddd-4ddd-8ddd-000000000001', actorName: 'Khalid Manager', kind: 'step_approved', detail: { stepNo: 1, comment: 'Fine by me' } },
      { id: '3', at: '2026-09-20T06:00:00Z', actorUserId: 'dddddddd-dddd-4ddd-8ddd-000000000001', actorName: 'Khalid Manager', kind: 'advanced', detail: { stepNo: 2 } },
    ],
    ...over,
  };
}
/** The token of the one-click e-mail link the e-mail scenario opens (the double accepts only this one). */
export const EMAIL_TOKEN = 'e2e-email-token-0123456789abcdef';
/**
 * Stateful handlers of the approvals screens: the inbox (the request leaves the queue once decided), one request, the
 * decision, the one-click e-mail action, the delegations list (a created delegation appears in it), the colleague picker
 * and the workflow editor.
 */
export function approvalsHandlers(): { get: NonNullable<MockBackendOptions['get']>; post: NonNullable<MockBackendOptions['post']> } {
  let decided: ApprovalRequestDto | null = null;
  const delegations: ApprovalDelegationDto[] = [];
  const workflows: ApprovalWorkflowDto[] = [];
  const pending = () => (decided ? [] : [approvalRequestFixture()]);
  return {
    get: {
      [`/orgs/${ORG_ID}/approvals`]: (url: URL) => page(url.searchParams.get('view') === 'history' ? (decided ? [decided] : []) : pending()),
      [`/orgs/${ORG_ID}/approvals/${APPROVAL_ID}`]: () => ({ data: decided ?? approvalRequestFixture() }),
      [`/orgs/${ORG_ID}/approval-delegations`]: { data: delegations },
      [`/orgs/${ORG_ID}/approval-delegations/candidates`]: { data: [COLLEAGUE] },
      [`/orgs/${ORG_ID}/approval-workflows`]: { data: workflows },
      [`/orgs/${ORG_ID}/roles`]: { data: [] },
      [`/orgs/${ORG_ID}/members`]: page([]),
    },
    post: {
      [`/orgs/${ORG_ID}/approvals/${APPROVAL_ID}/decide`]: (body) => {
        const b = body as { stepNo: number; decision: 'APPROVE' | 'REJECT'; comment?: string };
        const base = approvalRequestFixture();
        decided = { ...base, status: b.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', completedAt: nowIso(), decidedBy: USER_ID, decidedByName: 'Aisha Al Balushi', abilities: { ...base.abilities, canDecide: false, decideVia: null } };
        return { body: { data: { ...decided, noop: false, terminal: true } } };
      },
      [`/orgs/${ORG_ID}/approvals/email-action`]: (body) => {
        const b = body as { token: string; action: 'APPROVE' | 'REJECT'; comment?: string };
        if (b.token !== EMAIL_TOKEN) return { status: 404, body: { code: 'NOT_FOUND', message: 'Approval link not found' } };
        const base = approvalRequestFixture();
        decided = { ...base, status: b.action === 'APPROVE' ? 'APPROVED' : 'REJECTED', completedAt: nowIso(), decidedBy: USER_ID, decidedByName: 'Aisha Al Balushi', abilities: { ...base.abilities, canDecide: false, decideVia: null } };
        return { body: { data: { ...decided, noop: false, terminal: true } } };
      },
      [`/orgs/${ORG_ID}/approval-delegations`]: (body) => {
        const b = body as { delegateUserId: string; startsOn: string; endsOn: string; entityTypes?: ApprovalDelegationDto['entityTypes']; reason?: string };
        const created: ApprovalDelegationDto = { id: `eeeeeeee-eeee-4eee-8eee-${String(delegations.length + 1).padStart(12, '0')}`, organizationId: ORG_ID, delegatorUserId: USER_ID, delegatorName: 'Aisha Al Balushi', delegateUserId: b.delegateUserId, delegateName: COLLEAGUE.fullName, entityTypes: b.entityTypes ?? null, startsOn: b.startsOn, endsOn: b.endsOn, isActive: true, reason: b.reason ?? null, createdAt: nowIso(), revokedAt: null };
        delegations.push(created);
        return { status: 201, body: { data: created } };
      },
      [`/orgs/${ORG_ID}/approval-workflows`]: (body) => {
        const created = { ...(body as ApprovalWorkflowDto), id: 'ffffffff-ffff-4fff-8fff-000000000001', organizationId: ORG_ID, allowSelfApproval: false, createdAt: nowIso(), updatedAt: nowIso() } as ApprovalWorkflowDto;
        workflows.push(created);
        return { status: 201, body: { data: created } };
      },
    },
  };
}

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
  /** employee-portal attendance (HR portal Prompt 4): the punches and reasons the SPA recorded through the double */
  portal: { punches: SelfPunchDto[]; notes: AttendanceNoteDto[] };
}

/** The employee record the portal scenarios link the signed-in member to. */
export const PORTAL_EMPLOYEE_ID = employeesFixture[1]!.id;
/** A work zone around Muscat HQ (the portal check-in scenario stands inside it). */
export const HQ_FENCE = { id: '99999999-9999-4999-8999-000000000001', name: 'Muscat HQ', latitude: 23.588, longitude: 58.3829, radiusM: 150, hasPolygon: false, enforcement: 'soft_warn' as const, scope: 'org' as const };

const CORS: Record<string, string> = { 'access-control-allow-origin': '*' };
const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) => route.fulfill({ status, headers: { 'content-type': 'application/json', ...CORS, ...headers }, body: JSON.stringify(body) });
const apiError = (route: Route, status: number, code: string, message: string) => json(route, status, { code, message, requestId: 'e2e-request' });

/** Install the backend double on `page`. Call before `page.goto`. */
export async function installMockBackend(page: Page, opts: MockBackendOptions = {}): Promise<MockBackend> {
  const me = opts.me ?? meFixture();
  const state: MockBackend = { calls: [], unmatched: [], portal: { punches: [], notes: [] } };
  const portal = portalAttendanceDouble(state);
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
    // Settings → Integrations (Flowza Finance connector): an organisation that has not configured it yet
    [`/orgs/${ORG_ID}/integrations/finance`]: { data: financeIntegrationFixture() },
    [`/orgs/${ORG_ID}/integrations/finance/status`]: { data: { configured: false, enabled: false, deviceId: null, connectionStatus: null, state: null, cursor: null, circuit: null, unmatchedCount: 0, pendingCount: 0, lastJobs: [] } satisfies FinanceIntegrationStatusDto },
    [`/orgs/${ORG_ID}/search`]: (url: URL) => { const q = (url.searchParams.get('q') ?? '').toLowerCase(); return { data: { q, employees: employeesFixture.filter((e) => e.displayName.toLowerCase().includes(q)).map((e) => ({ type: 'employee', id: e.id, title: e.displayName, subtitle: e.employeeNumber, branchId: e.branchId, status: e.employmentStatus })), devices: [], branches: [], departments: [] } }; },
    ...portal.get,
    ...opts.get,
  };
  const postHandlers: Record<string, (body: unknown, url: URL) => { status?: number; body: unknown }> = { ...portal.post, ...opts.post };

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
    // POST: the portal double + the scenario's own handlers; PATCH / PUT: the scenario's handlers; then the leave double
    const custom = req.method() === 'POST' ? postHandlers[path] : req.method() === 'PATCH' ? opts.patch?.[path] : req.method() === 'PUT' ? opts.put?.[path] : undefined;
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

/**
 * Employee-portal attendance double (HR portal Prompt 4): punch status / preview / punch and the reasons list, stateful so a
 * scenario sees what it recorded. The server clock, the geofence verdict (inside HQ_FENCE → allowed, elsewhere → flagged) and
 * the punch time are this double's; authorization and the real evaluation are covered by the API suite.
 */
function portalAttendanceDouble(state: MockBackend) {
  const today = () => new Date().toISOString().slice(0, 10);
  const inside = (b: { lat?: number; lng?: number }) => b.lat !== undefined && b.lng !== undefined && Math.abs(b.lat - HQ_FENCE.latitude) < 0.001 && Math.abs(b.lng - HQ_FENCE.longitude) < 0.001;
  const verdict = (b: { lat?: number; lng?: number }) => (inside(b)
    ? { verdict: 'allowed' as const, reason: 'inside', geofenceId: HQ_FENCE.id, geofenceName: HQ_FENCE.name, distanceM: 0, scope: 'org' as const, enforcement: 'soft_warn' as const }
    : { verdict: 'flagged' as const, reason: 'outside', geofenceId: HQ_FENCE.id, geofenceName: HQ_FENCE.name, distanceM: 420, scope: 'org' as const, enforcement: 'soft_warn' as const });
  const status = (): SelfPunchStatusDto => {
    const last = state.portal.punches[state.portal.punches.length - 1];
    const lastDirection = last?.direction === 'in' || last?.direction === 'out' ? last.direction : null;
    return {
      date: today(), timezone: 'Asia/Muscat', serverTime: new Date().toISOString(), punches: state.portal.punches, today: null, lastDirection,
      canCheckIn: lastDirection !== 'in', canCheckOut: lastDirection === 'in', blockers: [],
      policy: { webCheckIn: true, mobileCheckIn: false, requireGeofence: 'flag', allowSelfieCheckIn: false, checkInWindow: null, checkOutWindow: null, outOfWindowAction: 'flag', duplicatePunchSeconds: 60, ipRestricted: false },
      grant: { openAttendance: false, selfieRequired: false }, selfieAvailable: false, fences: [HQ_FENCE],
    };
  };
  const me = `/orgs/${ORG_ID}/me`;
  return {
    get: {
      [`${me}/punch/status`]: () => ({ data: status() }),
      [`${me}/attendance/notes`]: () => ({ data: [...state.portal.notes].reverse() }),
    } as Record<string, (url: URL) => unknown>,
    post: {
      [`${me}/punch/preview`]: (body: unknown) => {
        const b = body as { lat?: number; lng?: number };
        return { body: { data: { verdict: verdict(b), outOfWindow: false, refusals: [], wouldBeFlagged: !inside(b) } } };
      },
      [`${me}/punch`]: (body: unknown) => {
        const b = body as { direction: 'in' | 'out'; lat?: number; lng?: number; idempotencyKey: string };
        const punch: SelfPunchDto = { id: String(state.portal.punches.length + 1), punchedAt: new Date().toISOString(), direction: b.direction, source: 'SELF_SERVICE', channel: 'web', verdict: verdict(b).verdict, deviceName: null, processingStatus: 'pending' };
        state.portal.punches.push(punch);
        return { status: 201, body: { data: { replayed: false, punch, verdict: verdict(b), outOfWindow: false, flagged: !inside(b) } } };
      },
      [`${me}/attendance/notes`]: (body: unknown) => {
        const b = body as { date: string; category: AttendanceNoteDto['category']; note: string };
        const at = new Date().toISOString();
        const note: AttendanceNoteDto = {
          id: `n${state.portal.notes.length + 1}`, employeeId: PORTAL_EMPLOYEE_ID, attendanceDate: b.date, category: b.category, note: b.note, status: 'pending', submittedAt: at,
          reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewReason: null, reviewVia: null, infoRequestMessage: null, infoRequestedAt: null, payEffectDays: null, lossOfPay: false,
          deductedLeaveTypeCode: null, deductedLeaveTypeName: null, approvalRequestId: 'e2e-request-1', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 1, excusedAt: null, createdAt: at, updatedAt: at,
        };
        state.portal.notes.push(note);
        return { status: 201, body: { data: note } };
      },
    } as Record<string, (body: unknown, url: URL) => { status?: number; body: unknown }>,
  };
}

// ---- team workspace (HR portal Prompt 5) ----------------------------------------------------------------------------------------
/** The line manager of the team scenario: Maryam's employee record manages Salim (primary) and Khalid (secondary). */
export const MANAGER_EMPLOYEE_ID = employeesFixture[1]!.id;
/** A custom team-lead role: the team keys and no approve key (the system Line Manager role carries both approve keys) — so their approvals live on /team (Finance B-66). */
export const LINE_MANAGER_PERMISSIONS: Permission[] = ['dashboard.view', 'employee.view_team', 'attendance.view_team', 'attendance.view_own', 'attendance.correct', 'leave.view_team', 'leave.request', 'approval.delegate', 'attendance.checkin', 'attendance.note', 'shift.view', 'holiday.view'];
export const TEAM_NOTE_ID = 'abababab-abab-4bab-8bab-000000000001';

/**
 * Stateful handlers of the team workspace: today's board of two reports (one late with a reason waiting for the manager, one on
 * leave), the counts behind the manager badge, the reasons list and the review decision — a rejected reason leaves the queue
 * and the counts drop, like the real API.
 */
export function teamHandlers(): { get: NonNullable<MockBackendOptions['get']>; post: NonNullable<MockBackendOptions['post']>; reviews: unknown[] } {
  const today = new Date().toISOString().slice(0, 10);
  const salim = employeesFixture[0]!;
  const khalid = employeesFixture[2]!;
  const reviews: unknown[] = [];
  let rejected = false;
  const member = (e: EmployeeDto, over: Record<string, unknown>) => ({
    employeeId: e.id, employeeNumber: e.employeeNumber, employeeName: e.displayName, designationName: 'Storekeeper', departmentName: 'Operations', branchId: e.branchId, branchName: e.branchName, relation: 'primary',
    date: today, timezone: 'Asia/Muscat', status: 'present', recordStatus: 'PRESENT', recordId: null, flags: [], firstInAt: null, lastOutAt: null, liveState: 'NONE', lastPunchAt: null, workedMinutes: 0, workedIsLive: false,
    lateMinutes: 0, leave: null, pendingItems: 0, ...over,
  });
  const members = () => [
    member(salim, { status: 'late', recordStatus: 'PRESENT', flags: ['LATE'], firstInAt: `${today}T04:17:00Z`, liveState: 'IN', lastPunchAt: `${today}T04:17:00Z`, workedMinutes: 95, workedIsLive: true, lateMinutes: 17, pendingItems: rejected ? 0 : 1 }),
    member(khalid, { relation: 'secondary', status: 'on_leave', recordStatus: null, leave: { leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', color: '#16a34a', isHalfDay: false, halfDayPart: null, status: 'APPROVED' } }),
  ];
  const summary = () => ({ data: { date: today, generatedAt: new Date().toISOString(), members: members(), totals: { reports: 2, present: 1, late: 1, absent: 0, onLeave: 1, missingPunch: 0, weeklyOff: 0, holiday: 0, notInYet: 0, inNow: 1, pendingItems: rejected ? 0 : 1 } } });
  const note = () => ({
    id: TEAM_NOTE_ID, employeeId: salim.id, attendanceDate: today, category: 'late_reason', note: 'Road closed near the Wadi Kabir roundabout', status: rejected ? 'rejected' : 'pending', submittedAt: `${today}T04:30:00Z`,
    reviewedBy: rejected ? USER_ID : null, reviewedByName: rejected ? 'Aisha Al Balushi' : null, reviewedAt: rejected ? new Date().toISOString() : null, reviewReason: null, reviewVia: rejected ? 'manager' : null,
    infoRequestMessage: null, infoRequestedAt: null, payEffectDays: rejected ? 0.5 : null, lossOfPay: false, deductedLeaveTypeCode: rejected ? 'AL' : null, deductedLeaveTypeName: rejected ? 'Annual Leave' : null,
    approvalRequestId: null, approvalStatus: null, approvalCurrentStep: null, approvalStepCount: null, excusedAt: null, createdAt: `${today}T04:30:00Z`, updatedAt: new Date().toISOString(),
    employeeName: salim.displayName, employeeNumber: salim.employeeNumber, branchId: salim.branchId, branchName: salim.branchName, dayStatus: 'PRESENT', dayFlags: ['LATE'], firstInAt: `${today}T04:17:00Z`, lastOutAt: null, timezone: 'Asia/Muscat',
    excusedCountYear: 1, isOversight: false, canReview: !rejected,
  });
  return {
    reviews,
    get: {
      [`/orgs/${ORG_ID}/team/summary`]: () => summary(),
      [`/orgs/${ORG_ID}/team/pending-counts`]: () => ({ data: { approvals: 0, notes: rejected ? 0 : 1, total: rejected ? 0 : 1 } }),
      [`/orgs/${ORG_ID}/team/leave`]: (url: URL) => ({ data: { from: url.searchParams.get('from'), to: url.searchParams.get('to'), today, entries: [], upcoming: [], pendingForMe: 0 } }),
      [`/orgs/${ORG_ID}/attendance/notes`]: (url: URL) => page(url.searchParams.get('open') === 'true' && rejected ? [] : [note()]),
      [`/orgs/${ORG_ID}/approvals`]: () => page([]),
    },
    post: {
      [`/orgs/${ORG_ID}/attendance/notes/${TEAM_NOTE_ID}/review`]: (body) => {
        reviews.push(body);
        const b = body as { decision: string; payEffectDays?: number };
        if (b.decision === 'reject') rejected = true;
        return { body: { data: { note: note(), requestStatus: null, terminal: true, charge: { outcome: 'charged_leave', payEffectDays: b.payEffectDays ?? 0, leaveTypeCode: 'AL' } } } };
      },
    },
  };
}
