/**
 * The "Majan Gulf" demo tenant (supabase/seeds/demo-tenant) as the web app's backend double for the recording: the employee
 * directory, members and roles, the user limit, and the reports. Stateful, so what the video does on screen (create an
 * employee, archive one, invite a member, queue a report) shows up in the next request like the real API answers it.
 *
 * Built on the e2e backend double (apps/web/e2e/support/mock-backend.ts); make.sh runs it from apps/web/.media-gen/.
 */
import { readFileSync } from 'node:fs';
import type { EmployeeDto, MeDto, Permission } from '@flowza/contracts';
import { ALL_PERMISSIONS, ORG_ID, USER_ID, meFixture, page, type MockBackendOptions } from '../e2e/support/mock-backend';

type Row = { num: string; first: string; last: string; gender: string; nat: string; email: string; phone: string; joined: string; exit: string | null; status: string; type: string; branch: string; dept: string; desig: string; manager: string | null; pin: string; card: string };
const PEOPLE: Row[] = JSON.parse(readFileSync(new URL('./people.json', import.meta.url), 'utf8'));

/** "Now" of the video: Tuesday 13 October 2026, 9:40 am in Muscat. */
export const NOW = new Date('2026-10-13T05:40:00Z');
export const TODAY = '2026-10-13';
const ts = (d: string) => `${d}T05:00:00Z`;
const uid = (prefix: string, n: number | string) => `${prefix}-0000-4000-8000-${String(n).replace(/\D/g, '').padStart(12, '0')}`;

export const BRANCHES = [
  ['MCT-HQ', 'Head Office – Muscat', 'Muscat'], ['SOH', 'Sohar Industrial Branch', 'Sohar'], ['SLL', 'Salalah Branch', 'Salalah'],
  ['NZW', 'Nizwa Branch', 'Nizwa'], ['SUR', 'Sur Branch', 'Sur'], ['DQM', 'Duqm Site Office', 'Duqm'],
].map(([code, name, city], i) => ({ id: uid('b0000000', i + 1), organizationId: ORG_ID, code: code!, name: name!, nameAr: null, countryCode: 'OM', city: city!, address: {}, timezone: 'Asia/Muscat', latitude: null, longitude: null, geofenceRadiusM: null, contact: {}, weeklyOffDays: [5, 6], holidayCalendarId: null, status: 'active', employeeCount: PEOPLE.filter((p) => p.branch === code).length, createdAt: ts('2026-02-16'), updatedAt: ts('2026-02-16') }));
export const DEPARTMENTS = [
  ['MGMT', 'Management'], ['HR', 'Human Resources'], ['FIN', 'Finance & Accounts'], ['PAY', 'Payroll'], ['IT', 'Information Technology'],
  ['ADM', 'Administration'], ['OPS', 'Operations'], ['SALES', 'Sales'], ['BD', 'Business Development'], ['CS', 'Customer Support'],
].map(([code, name], i) => ({ id: uid('d0000000', i + 1), organizationId: ORG_ID, branchId: null, branchName: null, parentId: null, code: code!, name: name!, nameAr: null, status: 'active', employeeCount: PEOPLE.filter((p) => p.dept === code).length, createdAt: ts('2026-02-16'), updatedAt: ts('2026-02-16') }));
export const DESIGNATIONS = [
  ['MD', 'Managing Director'], ['GM', 'General Manager'], ['HRM', 'HR Manager'], ['FM', 'Finance Manager'], ['ITM', 'IT Manager'], ['ADMM', 'Administration Manager'],
  ['OPM', 'Operations Manager'], ['SM', 'Sales Manager'], ['BM', 'Branch Manager'], ['TL', 'Team Lead'], ['SSE', 'Senior Software Engineer'], ['SACC', 'Senior Accountant'],
  ['SUP', 'Site Supervisor'], ['HRE', 'HR Executive'], ['PAYS', 'Payroll Specialist'], ['ACC', 'Accountant'], ['SE', 'Software Engineer'], ['ITSE', 'IT Support Engineer'],
  ['ATTA', 'Attendance Administrator'], ['BDE', 'Business Development Executive'], ['SEX', 'Sales Executive'], ['CSE', 'Customer Support Executive'], ['TECH', 'Technician'],
  ['STK', 'Storekeeper'], ['AA', 'Administrative Assistant'], ['OA', 'Office Assistant'], ['DRV', 'Driver'],
].map(([code, name], i) => ({ id: uid('c0000000', i + 1), organizationId: ORG_ID, code: code!, name: name!, nameAr: null, level: null, status: 'active', createdAt: ts('2026-02-16'), updatedAt: ts('2026-02-16') }));
const branchOf = (code: string) => BRANCHES.find((b) => b.code === code)!;
const deptOf = (code: string) => DEPARTMENTS.find((d) => d.code === code)!;
const desigOf = (code: string) => DESIGNATIONS.find((d) => d.code === code)!;
export const empId = (num: string) => uid('e0000000', num);

type Emp = EmployeeDto & { currentHistory: null };
function toEmployee(p: Row): Emp {
  const b = branchOf(p.branch);
  const d = deptOf(p.dept);
  const g = desigOf(p.desig);
  const mgr = p.manager ? PEOPLE.find((x) => x.num === p.manager) : undefined;
  const left = p.status !== 'active';
  return {
    id: empId(p.num), organizationId: ORG_ID, employeeNumber: p.num, firstName: p.first, middleName: null, lastName: p.last, displayName: `${p.first} ${p.last}`, displayNameAr: null,
    photoPath: null, photoUrl: null, gender: p.gender, dateOfBirth: null, nationalityCode: p.nat, email: p.email, phone: p.phone, joiningDate: p.joined, exitDate: p.exit,
    employmentStatus: p.status, employmentType: p.type, branchId: b.id, branchName: b.name, departmentId: d.id, departmentName: d.name, designationId: g.id, designationName: g.name,
    managerEmployeeId: mgr ? empId(mgr.num) : null, managerName: mgr ? `${mgr.first} ${mgr.last}` : null, secondaryManagerEmployeeId: null, secondaryManagerName: null, userId: null,
    deviceUserId: p.pin, cardNumber: p.card, fingerprintEnrolled: true, faceEnrolled: false, weeklyOffDays: null, customFields: {},
    deviceSyncSummary: left ? { total: 0, inSync: 0, pending: 0, failed: 0, offline: 0 } : { total: 2, inSync: 2, pending: 0, failed: 0, offline: 0 },
    // the two leavers of the seed were archived long ago (hidden from the list)
    deletedAt: left ? ts(p.exit ?? '2026-04-30') : null, createdAt: ts('2026-02-16'), updatedAt: ts('2026-02-16'), currentHistory: null,
  } as unknown as Emp;
}

/** Org admin of the demo tenant (orgadmin@flowza.ai): the role that may add, archive and invite. Everything but payroll.finalize. */
export function meForVideo(): MeDto {
  const me = meFixture({
    roleId: '10000000-0000-0000-0000-000000000002', roleKey: 'org_admin', roleName: 'Organisation Admin',
    permissions: ALL_PERMISSIONS.filter((p: Permission) => p !== 'payroll.finalize'), employeeId: empId('MG-1002'),
  });
  me.user = { ...me.user, email: 'orgadmin@flowza.ai', fullName: 'Khalid Al Harthi' };
  const m = me.memberships[0]!;
  m.organization = { ...m.organization, companyCode: 'MAJAN', legalName: 'Majan Gulf Trading & Contracting LLC', displayName: 'Majan Gulf' } as typeof m.organization;
  return me;
}

const ROLE_ROWS: Array<[string, string, string, string]> = [
  ['1', 'owner', 'Organisation Owner', 'Full access to the organisation'], ['2', 'org_admin', 'Organisation Admin', 'Administers users, settings, devices and HR data'],
  ['3', 'hr_admin', 'HR Admin', 'Manages employees, shifts, attendance and reports'], ['4', 'hr_user', 'HR User', 'Day-to-day HR operations without destructive rights'],
  ['5', 'branch_manager', 'Branch Manager', 'Manages attendance for assigned branches only'], ['6', 'attendance_admin', 'Attendance Admin', 'Manages devices, synchronisation and attendance rules'],
  ['7', 'payroll', 'Payroll / Finance', 'Read-only attendance and payroll summaries'], ['8', 'employee', 'Employee', 'Self-service access to own attendance'],
  ['9', 'manager', 'Line Manager', 'Sees and approves for direct reports'],
];
export const ROLES = ROLE_ROWS.map(([n, key, name, description]) => ({ id: `10000000-0000-0000-0000-00000000000${n}`, organizationId: null, key, name, description, isSystem: true, permissions: [], memberCount: 1, createdAt: ts('2026-01-01'), updatedAt: ts('2026-01-01') }));
const roleOf = (key: string) => ROLES.find((r) => r.key === key)!;
const MEMBERS: Array<[string, string, string]> = [
  ['MG-1001', 'acme@flowza.ai', 'owner'], ['MG-1002', 'orgadmin@flowza.ai', 'org_admin'], ['MG-1003', 'hradmin@flowza.ai', 'hr_admin'], ['MG-1004', 'hruser@flowza.ai', 'hr_user'],
  ['MG-1016', 'attadmin@flowza.ai', 'attendance_admin'], ['MG-1006', 'payroll@flowza.ai', 'payroll'], ['MG-1010', 'manager@flowza.ai', 'manager'], ['MG-2001', 'brmanager@flowza.ai', 'branch_manager'],
  ['MG-1012', 'employee@flowza.ai', 'employee'], ['MG-1024', 'deepa.kumar@majangulf.om', 'employee'],
];
const LAST_LOGIN: Record<string, string> = { 'MG-1001': '2026-10-12T14:22:00Z', 'MG-1002': '2026-10-13T05:31:00Z', 'MG-1003': '2026-10-13T04:58:00Z', 'MG-1004': '2026-10-12T11:05:00Z', 'MG-1016': '2026-10-13T04:12:00Z', 'MG-1006': '2026-10-08T09:40:00Z', 'MG-1010': '2026-10-13T05:02:00Z', 'MG-2001': '2026-10-11T06:15:00Z', 'MG-1012': '2026-10-12T04:47:00Z', 'MG-1024': '2026-09-24T05:20:00Z' };

/** The report files the video opens: served at the signed URL as the viewer page (see viewer.html) — a PDF viewer is not available in headless Chromium. */
export interface ReportFile { reportType: string; fileName: string; viewer: string; rowCount: number; bytes: number }

export interface World {
  /** active employees counted against the user limit */
  used(): number;
  limit: number;
  options: MockBackendOptions;
  /** add employees off screen (between two scenes) */
  hire(rows: Row[]): void;
  /** the next report queued becomes this file */
  nextReport: ReportFile[];
  /** GET/DELETE of paths with an id in them (employee detail, archive, report download) */
  extra(method: string, path: string, url: URL, body: unknown): { status?: number; body: unknown } | undefined;
}

export function createWorld(opts: { limit: number; extraActive?: Row[] }): World {
  const employees: Emp[] = PEOPLE.map(toEmployee);
  for (const r of opts.extraActive ?? []) employees.push(toEmployee(r));
  const members = MEMBERS.map(([num, email, role], i) => {
    const p = PEOPLE.find((x) => x.num === num)!;
    const r = roleOf(role);
    return { id: num === 'MG-1002' ? '66666666-6666-4666-8666-666666666666' : uid('f0000000', i + 1), organizationId: ORG_ID, userId: num === 'MG-1002' ? USER_ID : uid('a0000000', i + 1), email, fullName: `${p.first} ${p.last}`, avatarPath: null, roleId: r.id, roleKey: r.key, roleName: r.name, status: 'active', allBranches: role !== 'branch_manager', branchIds: role === 'branch_manager' ? [branchOf('SOH').id] : [], branchNames: role === 'branch_manager' ? ['Sohar Industrial Branch'] : [], employeeId: empId(num), employeeNumber: num, lastLoginAt: LAST_LOGIN[num] ?? null, joinedAt: ts('2026-02-16'), createdAt: ts('2026-02-16'), updatedAt: ts('2026-02-16') };
  });
  const invitations: unknown[] = [];
  const reports: Array<Record<string, unknown> & { id: string; status: string }> = [
    { id: uid('99000000', 3), reportType: 'daily_attendance', format: 'pdf', parameters: { from: '2026-10-12' }, status: 'COMPLETED', rowCount: 49, fileSizeBytes: 41_230, error: null, requestedBy: USER_ID, requestedByName: 'Khalid Al Harthi', createdAt: '2026-10-12T13:05:00Z', completedAt: '2026-10-12T13:05:09Z', expiresAt: '2026-10-19T13:05:09Z' },
    { id: uid('99000000', 2), reportType: 'late_report', format: 'pdf', parameters: { from: '2026-09-01', to: '2026-09-30' }, status: 'COMPLETED', rowCount: 37, fileSizeBytes: 28_904, error: null, requestedBy: USER_ID, requestedByName: 'Khalid Al Harthi', createdAt: '2026-10-08T06:41:00Z', completedAt: '2026-10-08T06:41:12Z', expiresAt: '2026-10-15T06:41:12Z' },
  ];
  const files = new Map<string, ReportFile>();
  const world: World = {
    used: () => employees.filter((e) => !e.deletedAt && !['terminated', 'resigned'].includes(e.employmentStatus)).length, limit: opts.limit, options: {}, hire: (rows) => { for (const r of rows) employees.push(toEmployee(r)); }, nextReport: [], extra: () => undefined };
  const userLimit = () => { const used = world.used(); return { used, limit: world.limit, remaining: Math.max(0, world.limit - used), reached: used >= world.limit, source: 'seats' }; };
  const listEmployees = (url: URL) => {
    const q = (url.searchParams.get('search') ?? '').toLowerCase();
    const status = url.searchParams.get('employmentStatus');
    const dept = url.searchParams.get('departmentId');
    const branch = url.searchParams.get('branchId');
    const unlinked = url.searchParams.get('unlinked') === 'true';
    const linked = new Set(members.map((m) => m.employeeId));
    let rows = employees.filter((e) => !e.deletedAt)
      .filter((e) => !q || `${e.displayName} ${e.employeeNumber} ${e.email ?? ''} ${e.deviceUserId}`.toLowerCase().includes(q))
      .filter((e) => !status || e.employmentStatus === status).filter((e) => !dept || e.departmentId === dept).filter((e) => !branch || e.branchId === branch)
      .filter((e) => !unlinked || !linked.has(e.id));
    const sort = url.searchParams.get('sort') ?? 'displayName';
    const dir = url.searchParams.get('order') === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => dir * String((a as unknown as Record<string, unknown>)[sort] ?? '').localeCompare(String((b as unknown as Record<string, unknown>)[sort] ?? ''), 'en', { numeric: true }));
    const pageNo = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 25);
    return { data: rows.slice((pageNo - 1) * pageSize, pageNo * pageSize), meta: { page: pageNo, pageSize, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / pageSize)) } };
  };
  const org = `/orgs/${ORG_ID}`;
  const get: NonNullable<MockBackendOptions['get']> = {
    [`${org}/employees`]: listEmployees,
    [`${org}/user-limit`]: () => ({ data: userLimit() }),
    [`${org}/branches`]: page(BRANCHES, 1, 100),
    [`${org}/departments`]: page(DEPARTMENTS, 1, 100),
    [`${org}/designations`]: page(DESIGNATIONS, 1, 100),
    [`${org}/roles`]: { data: ROLES },
    [`${org}/members`]: (url: URL) => {
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      return page(members.filter((m) => !q || `${m.fullName} ${m.email}`.toLowerCase().includes(q)), 1, 25);
    },
    [`${org}/invitations`]: () => page(invitations),
    [`${org}/reports`]: () => {
      // a queued report runs for a few seconds, like the reports worker
      for (const r of reports) {
        const age = Date.now() - new Date(String(r.createdAt)).getTime();
        if (r.status === 'QUEUED' && age > 1000) r.status = 'RUNNING';
        if (r.status === 'RUNNING' && age > 3000) Object.assign(r, { status: 'COMPLETED', completedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), rowCount: files.get(r.id)?.rowCount ?? 0, fileSizeBytes: files.get(r.id)?.bytes ?? 0 });
      }
      return page(reports);
    },
  };
  world.options = {
    me: meForVideo(),
    get,
    post: {
      [`${org}/employees`]: (body) => {
        const b = body as Record<string, string | undefined>;
        if (world.used() >= world.limit) return { status: 409, body: { code: 'USER_LIMIT_REACHED', message: 'Maximum users reached', requestId: 'demo' } };
        const nextPin = String(Math.max(...employees.map((e) => Number(e.deviceUserId) || 0)) + 1);
        const b0 = BRANCHES.find((x) => x.id === b['branchId'])!;
        const d0 = DEPARTMENTS.find((x) => x.id === b['departmentId']);
        const g0 = DESIGNATIONS.find((x) => x.id === b['designationId']);
        const m0 = employees.find((x) => x.id === b['managerEmployeeId']);
        const e = toEmployee({ num: b['employeeNumber']!, first: b['firstName']!, last: b['lastName']!, gender: b['gender'] ?? 'unspecified', nat: 'OM', email: b['email'] ?? '', phone: '', joined: b['joiningDate']!, exit: null, status: 'active', type: b['employmentType'] ?? 'full_time', branch: b0.code, dept: d0?.code ?? 'ADM', desig: g0?.code ?? 'OA', manager: m0?.employeeNumber ?? null, pin: b['deviceUserId'] ?? nextPin, card: b['cardNumber'] ?? '' });
        Object.assign(e, { managerEmployeeId: m0?.id ?? null, managerName: m0?.displayName ?? null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deviceSyncSummary: { total: 2, inSync: 0, pending: 2, failed: 0, offline: 0 } });
        employees.push(e);
        return { status: 201, body: { data: e } };
      },
      [`${org}/invitations`]: (body) => {
        const b = body as { email: string; roleId: string; allBranches: boolean; branchIds: string[]; employeeId?: string };
        const e = employees.find((x) => x.id === b.employeeId);
        const inv = { id: uid('ab000000', invitations.length + 1), organizationId: ORG_ID, email: b.email, roleId: b.roleId, roleName: ROLES.find((r) => r.id === b.roleId)?.name, allBranches: b.allBranches, branchIds: b.branchIds, invitedBy: USER_ID, invitedByName: 'Khalid Al Harthi', employeeId: e?.id ?? null, employeeNumber: e?.employeeNumber ?? null, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), acceptedAt: null, createdAt: new Date().toISOString(), token: 'k3J9vQ2mXn7Lr4tW8yZc1Bd6Fh0Gs5Pa', membershipId: null, deliveryStatus: 'queued', lastSentAt: null, sendCount: 0, lastDeliveryError: null };
        invitations.push(inv);
        return { status: 201, body: { data: inv } };
      },
      [`${org}/reports`]: (body) => {
        const b = body as { reportType: string; format: string; parameters: Record<string, unknown> };
        const id = uid('99000000', reports.length + 10);
        const r = { id, reportType: b.reportType, format: b.format, parameters: b.parameters, status: 'QUEUED', rowCount: null, fileSizeBytes: null, error: null, requestedBy: USER_ID, requestedByName: 'Khalid Al Harthi', createdAt: new Date().toISOString(), completedAt: null, expiresAt: null, jobId: String(4000 + reports.length) };
        const f = world.nextReport.shift();
        if (f) files.set(id, f);
        reports.unshift(r);
        return { status: 202, body: { data: r } };
      },
    },
  };
  // paths that carry an id (the double keys handlers by exact path): the recorder routes them here first
  world.extra = (method, path, url, body) => {
    const emp = new RegExp(`^${org}/employees/([^/]+)$`).exec(path);
    if (emp && method === 'GET') { const e = employees.find((x) => x.id === emp[1]); return e ? { body: { data: e } } : undefined; }
    if (emp && method === 'DELETE') {
      const e = employees.find((x) => x.id === emp[1]);
      if (!e) return undefined;
      const input = (body ?? {}) as { exitDate?: string; reason?: string };
      Object.assign(e, { employmentStatus: 'terminated', exitDate: input.exitDate ?? TODAY, deletedAt: new Date().toISOString(), deviceSyncSummary: { total: 0, inSync: 0, pending: 0, failed: 0, offline: 0 } });
      // the API offboards the linked sign-in with the employee (apps/api/src/services/offboarding.ts)
      for (const m of members) if (m.employeeId === e.id) m.status = 'suspended';
      return { body: { data: e } };
    }
    const dl = new RegExp(`^${org}/reports/([^/]+)/download$`).exec(path);
    if (dl && method === 'GET') {
      const f = files.get(dl[1]!);
      if (!f) return undefined;
      return { body: { data: { url: `http://localhost:4173/storage/v1/object/sign/reports/${ORG_ID}/${dl[1]}.pdf?token=demo&viewer=${encodeURIComponent(f.viewer)}`, expiresInSeconds: 300, fileName: f.fileName, disposition: url.searchParams.get('disposition') ?? 'attachment' } } };
    }
    return undefined;
  };
  return world;
}
