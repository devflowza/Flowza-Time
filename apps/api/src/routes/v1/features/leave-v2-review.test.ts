/**
 * Leave v2 review fixes (docs/hr-portal/reviews/07-leave-v2-review.md): one regression test per defect of the API layer,
 * named after it — segregation of duties on one's own leave by every route (7-P0-1), the API's writes of one's own rows
 * (7-P0-2: the database refuses them from the person's session; the API writes them after its checks), the per-date
 * working calendar shared with attendance (7-P1-1 rotation off days, 7-P1-2 transfers and stored days), the one
 * applicability rule incl. employment types (7-P1-3, B-41: portal, API, charger, allocation generation), the minor fixes
 * (7-P2-3 … 7-P2-12) and the seat choice of an override on the Leave page (engine §9.8).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveAttendanceSettings } from '@flowza/contracts';
import { chargeUnexcusedDay, effectiveBranchIdOn, loadDailyInputs, withContext } from '@flowza/database';
import { auditRows, createApiHarness, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
const T: Record<string, string> = {};
const base = () => `/api/v1/orgs/${f.orgId}`;
const hrAdmin2 = uuid('c'); const orgAdmin = uuid('c'); const worker21 = uuid('c');
let e20: string; let e21: string; let e22: string; let eF: string; let eO: string;

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_leave2rev_${process.pid}`);
  f = await seedOrg(h.admin, 'lvr');
  e20 = await seedEmployee(h.admin, f.orgId, f.branchA, 20);
  e21 = await seedEmployee(h.admin, f.orgId, f.branchA, 21);
  e22 = await seedEmployee(h.admin, f.orgId, f.branchB, 22);
  eF = await seedEmployee(h.admin, f.orgId, f.branchA, 23);
  eO = await seedEmployee(h.admin, f.orgId, f.branchB, 25); // linked to the owner for the owner-bypass tests
  await h.admin.updateTable('employees').set({ gender: 'female' }).where('id', '=', eF).execute();
  await seedUser(h.admin, hrAdmin2, 'hr-admin-2-lvr@test.local', 'HR Admin Two');
  await seedUser(h.admin, orgAdmin, 'org-admin-lvr@test.local', 'Org Admin');
  await seedUser(h.admin, worker21, 'worker21-lvr@test.local', 'Worker 21');
  await seedMembership(h.admin, f.orgId, hrAdmin2, ROLE.hr_admin);
  await seedMembership(h.admin, f.orgId, orgAdmin, ROLE.org_admin, { employeeId: e20 });
  await seedMembership(h.admin, f.orgId, worker21, ROLE.employee, { employeeId: e21 });
  // the branch manager of branch B is employee e22 of branch B
  await h.admin.updateTable('orgMemberships').set({ employeeId: e22 }).where('organizationId', '=', f.orgId).where('userId', '=', f.branchManagerB).execute();
  const types: Array<[string, Record<string, unknown>]> = [
    ['AL', { name: 'Annual Leave', annualAllowanceDays: 20 }],
    ['CL', { name: 'Casual Leave', annualAllowanceDays: 12 }],
    ['CT', { name: 'Contract Leave', annualAllowanceDays: 6, applicableEmploymentTypes: ['contract'] }],
  ];
  for (const [code, body] of types) {
    const r = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code, ...body } });
    expect(r.status).toBe(201);
    T[code] = r.body.data.id;
  }
  const seeded = await h.request('POST', `${base()}/leave-types/seed-defaults`, { token: f.hrAdmin });
  expect(seeded.status).toBe(201);
  T['CO'] = (seeded.body.data.leaveTypes as Array<{ id: string; compOff: boolean }>).find((t) => t.compOff)!.id;
});
afterAll(async () => { await h?.close(); });

async function clearWorkflows() { await h.admin.deleteFrom('approvalWorkflows').where('organizationId', '=', f.orgId).execute(); }
async function workflow(steps: unknown[], entityType = 'LEAVE') {
  const r = await h.request('POST', `${base()}/approval-workflows`, { token: f.owner, body: { name: `${entityType} ${Math.random().toString(36).slice(2, 7)}`, entityType, steps } });
  expect(r.status).toBe(201);
}
let weekOffset = 3;
/** A fresh future range per request so nothing overlaps: starts on a Sunday weeks ahead (Fri + Sat off), `days` working days (≤ 5). */
function nextRange(days = 1) {
  weekOffset += 1;
  const d = new Date(); d.setUTCDate(d.getUTCDate() + weekOffset * 7 - d.getUTCDay());
  const start = d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + days - 1);
  return { startDate: start, endDate: d.toISOString().slice(0, 10) };
}
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
/** The most recent date with this weekday (0=Sun..6=Sat) at least `minBack` days ago. */
function pastWeekday(dow: number, minBack = 7) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - minBack);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
async function leaveRow(id: string) { return h.admin.selectFrom('leaveRecords').selectAll().where('id', '=', id).executeTakeFirstOrThrow(); }
async function requestRow(id: string) { return h.admin.selectFrom('approvalRequests').selectAll().where('id', '=', id).executeTakeFirstOrThrow(); }
const codes = (body: { details?: { issues?: Array<{ code?: string; path?: string }> } }) => (body.details?.issues ?? []).map((i) => i.code);
async function linkMembership(userId: string, employeeId: string | null) {
  await h.admin.updateTable('orgMemberships').set({ employeeId }).where('organizationId', '=', f.orgId).where('userId', '=', userId).execute();
}
/** HR (hr_user linked to e3) records their own leave; another HR approves it. */
async function ownApprovedLeave(token: string, employeeId: string) {
  const range = nextRange(1);
  const rec = await h.request('POST', `${base()}/leave-records`, { token, body: { employeeId, leaveTypeId: T['AL'], ...range, reason: 'Own leave' } });
  expect(rec.status).toBe(201);
  expect(rec.body.data).toMatchObject({ status: 'PENDING', approvalStatus: 'PENDING' });
  const ok = await h.request('PATCH', `${base()}/leave-records/${rec.body.data.id}`, { token: f.hrAdmin, body: { status: 'APPROVED', stepNo: rec.body.data.approvalCurrentStep } });
  expect(ok.status).toBe(200);
  expect(ok.body.data.status).toBe('APPROVED');
  return { id: rec.body.data.id as string, range, approvalRequestId: rec.body.data.approvalRequestId as string };
}

describe('7-P0-1 segregation of duties on one\'s own decided leave (every route)', () => {
  it('7-P0-1 an HR user cannot correct their own approved leave (SOD-1): +4 days refused, the leave unchanged', async () => {
    await clearWorkflows();
    const own = await ownApprovedLeave(f.managerUser, f.e3);
    const res = await h.request('PATCH', `${base()}/leave-records/${own.id}`, { token: f.managerUser, body: { endDate: addDays(own.range.endDate, 4) } });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/about you/);
    expect(await leaveRow(own.id)).toMatchObject({ status: 'APPROVED' });
    expect(Number((await leaveRow(own.id)).days)).toBe(1);
    expect((await auditRows(h.admin, 'leave.corrected')).some((a) => a.entityId === own.id)).toBe(false);
    // the note, the type or the half day are corrections too
    expect((await h.request('PATCH', `${base()}/leave-records/${own.id}`, { token: f.managerUser, body: { leaveTypeId: T['CL'] } })).status).toBe(403);
    expect((await h.request('PATCH', `${base()}/leave-records/${own.id}`, { token: f.managerUser, body: { reason: 'Changed later' } })).status).toBe(403);
    expect((await h.request('PATCH', `${base()}/leave-records/${own.id}`, { token: f.managerUser, body: { decisionNote: 'Rewritten by me' } })).status).toBe(403);
    // another HR user corrects it
    const other = await h.request('PATCH', `${base()}/leave-records/${own.id}`, { token: f.hrAdmin, body: { endDate: addDays(own.range.endDate, 1) } });
    expect(other.status).toBe(200);
    expect(other.body.data).toMatchObject({ status: 'APPROVED', days: 2 });
  });

  it('7-P0-1 the subject may cancel their own decided leave, nothing else; a status of their own pre-engine leave is refused too', async () => {
    await clearWorkflows();
    const own = await ownApprovedLeave(f.managerUser, f.e3);
    const cancel = await h.request('PATCH', `${base()}/leave-records/${own.id}`, { token: f.managerUser, body: { status: 'CANCELLED', decisionNote: 'Plans changed' } });
    expect(cancel.status).toBe(200);
    expect((await leaveRow(own.id)).status).toBe('CANCELLED');
    // a leave recorded before the engine (no request): deciding or re-deciding it about oneself is refused
    const range = nextRange(1);
    const legacy = await h.admin.insertInto('leaveRecords').values({ organizationId: f.orgId, employeeId: f.e3, branchId: f.branchA, leaveTypeId: T['CL'], startDate: range.startDate, endDate: range.endDate, status: 'PENDING', days: 1 }).returning('id').executeTakeFirstOrThrow();
    expect((await h.request('PATCH', `${base()}/leave-records/${legacy.id}`, { token: f.managerUser, body: { status: 'APPROVED' } })).status).toBe(403);
    await h.admin.updateTable('leaveRecords').set({ status: 'APPROVED', approvedAt: new Date() }).where('id', '=', legacy.id).execute();
    expect((await h.request('PATCH', `${base()}/leave-records/${legacy.id}`, { token: f.managerUser, body: { status: 'REJECTED', decisionNote: 'Undo' } })).status).toBe(403);
    expect((await leaveRow(legacy.id)).status).toBe('APPROVED');
    // DELETE (cancel) is the subject's own right
    expect((await h.request('DELETE', `${base()}/leave-records/${legacy.id}`, { token: f.managerUser })).status).toBe(200);
    expect((await leaveRow(legacy.id)).status).toBe('CANCELLED');
  });

  it('7-P0-1 the request\'s subject snapshot counts even after the login is unlinked from the employee', async () => {
    await clearWorkflows();
    const own = await ownApprovedLeave(f.managerUser, f.e3);
    expect((await requestRow(own.approvalRequestId)).subjectUserId).toBe(f.managerUser);
    await linkMembership(f.managerUser, null);
    try {
      const res = await h.request('PATCH', `${base()}/leave-records/${own.id}`, { token: f.managerUser, body: { endDate: addDays(own.range.endDate, 2) } });
      expect(res.status).toBe(403);
      expect(Number((await leaveRow(own.id)).days)).toBe(1);
    } finally { await linkMembership(f.managerUser, f.e3); }
  });

  it('7-P0-1 the organisation owner keeps the one exception, logged as sod_owner_bypass (audit + the request timeline)', async () => {
    await clearWorkflows();
    await linkMembership(f.owner, eO);
    try {
      const own = await ownApprovedLeave(f.owner, eO);
      const res = await h.request('PATCH', `${base()}/leave-records/${own.id}`, { token: f.owner, body: { endDate: addDays(own.range.endDate, 1) } });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'APPROVED', days: 2 });
      expect((await auditRows(h.admin, 'leave.sod_owner_bypass')).some((a) => a.entityId === own.id)).toBe(true);
      const events = await h.admin.selectFrom('approvalRequestEvents').select('kind').where('requestId', '=', own.approvalRequestId).execute();
      expect(events.map((e) => e.kind)).toContain('sod_owner_bypass');
    } finally { await linkMembership(f.owner, null); }
  });
});

describe('7-P0-2 one\'s own rows are written by the API after its checks, never from the person\'s session', () => {
  it('7-P0-2 HR user, branch manager and org admin act on OTHER employees through the API as before', async () => {
    await clearWorkflows();
    const year = Number(nextRange(1).startDate.slice(0, 4));
    for (const [token, other] of [[f.managerUser, f.e1], [f.branchManagerB, f.e2], [orgAdmin, eF]] as const) {
      const rec = await h.request('POST', `${base()}/leave-records`, { token, body: { employeeId: other, leaveTypeId: T['CL'], ...nextRange(1), reason: 'For a colleague' } });
      expect([token, rec.status]).toEqual([token, 201]);
      const alloc = await h.request('PUT', `${base()}/leave-allocations`, { token, body: { rows: [{ employeeId: other, leaveTypeId: T['AL'], year, allocatedDays: 21 }] } });
      expect([token, alloc.status]).toEqual([token, 200]);
    }
  });

  it('7-P0-2 they record their own leave through the API (201, PENDING, routed to the others) but never decide or allocate it', async () => {
    await clearWorkflows();
    const year = Number(nextRange(1).startDate.slice(0, 4));
    for (const [token, self] of [[f.managerUser, f.e3], [f.branchManagerB, e22], [orgAdmin, e20]] as const) {
      const rec = await h.request('POST', `${base()}/leave-records`, { token, body: { employeeId: self, leaveTypeId: T['CL'], ...nextRange(1), reason: 'Own leave' } });
      expect([token, rec.status, rec.body.data?.status]).toEqual([token, 201, 'PENDING']);
      expect(Number((await leaveRow(rec.body.data.id)).days)).toBe(1);
      expect((await h.request('PATCH', `${base()}/leave-records/${rec.body.data.id}`, { token, body: { status: 'APPROVED', stepNo: 1 } })).status).toBe(403);
      const alloc = await h.request('PUT', `${base()}/leave-allocations`, { token, body: { rows: [{ employeeId: self, leaveTypeId: T['AL'], year, allocatedDays: 366 }] } });
      expect([token, alloc.status]).toEqual([token, 403]);
      expect(await h.admin.selectFrom('leaveAllocations').select('id').where('employeeId', '=', self).where('year', '=', year).where('allocatedDays', '=', '366').execute()).toEqual([]);
    }
  });

  it('7-P0-2 allocation generation leaves the caller\'s own rows for another HR user; the owner\'s own rows are logged', async () => {
    const year = Number(nextRange(1).startDate.slice(0, 4)) + 1;
    const gen = await h.request('POST', `${base()}/leave-allocations/generate`, { token: f.managerUser, body: { year, leaveTypeIds: [T['AL']] } });
    expect(gen.status).toBe(201);
    expect(gen.body.data.skippedOwn).toBe(1);
    expect(await h.admin.selectFrom('leaveAllocations').select('id').where('employeeId', '=', f.e3).where('year', '=', year).execute()).toEqual([]);
    expect((await h.admin.selectFrom('leaveAllocations').select('id').where('employeeId', '=', f.e1).where('year', '=', year).execute()).length).toBe(1);
    await linkMembership(f.owner, eO);
    try {
      const own = await h.request('PUT', `${base()}/leave-allocations`, { token: f.owner, body: { rows: [{ employeeId: eO, leaveTypeId: T['CL'], year, allocatedDays: 12 }] } });
      expect(own.status).toBe(200);
      expect((await auditRows(h.admin, 'leave.sod_owner_bypass')).some((a) => a.entityType === 'leave_allocation' && (a.newValue as { employeeId?: string }).employeeId === eO)).toBe(true);
    } finally { await linkMembership(f.owner, null); }
  });

  it('7-P2-10 the portal application is still stored (with its server-computed days) — through the API only', async () => {
    await clearWorkflows();
    const r = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: T['CL'], ...nextRange(2), reason: 'Family' } });
    expect(r.status).toBe(201);
    expect(Number((await leaveRow(r.body.data.id)).days)).toBe(2);
  });
});

describe('7-P1-1 / 7-P1-2 the per-date working calendar (shared with the attendance engine)', () => {
  it('7-P1-1 a rotation pattern\'s off day is not charged as leave and earns comp-off, like attendance sees it (CAL-1)', async () => {
    await clearWorkflows();
    // Sun–Wed on, Thu–Sat off (anchor Sunday 4 Jan 2026)
    const shift = await h.admin.insertInto('shifts').values({ organizationId: f.orgId, code: 'ROT', name: 'Rota', type: 'FIXED', startTime: '08:00', endTime: '16:00' }).returning('id').executeTakeFirstOrThrow();
    const seq = [0, 1, 2, 3].map((day) => ({ day, shift_id: shift.id })).concat([4, 5, 6].map((day) => ({ day, off: true }) as never));
    const pattern = await h.admin.insertInto('shiftPatterns').values({ organizationId: f.orgId, code: 'SWTS', name: 'Sun–Wed', cycleLengthDays: 7, anchorDate: '2026-01-04', sequence: JSON.stringify(seq) }).returning('id').executeTakeFirstOrThrow();
    await h.admin.insertInto('shiftAssignments').values({ organizationId: f.orgId, targetType: 'EMPLOYEE', targetId: e21, shiftPatternId: pattern.id, effectiveFrom: '2025-01-01' }).execute();
    const week = nextRange(5); // Sun–Thu
    expect(weekday(week.endDate)).toBe(4);
    const rec = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: e21, leaveTypeId: T['AL'], ...week, reason: 'Rota' } });
    expect(rec.status).toBe(201);
    expect(rec.body.data.days).toBe(4);
    // attendance sees the same Thursday as a weekly off (one resolver)
    const thursday = pastWeekday(4, 7);
    const inputs = await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, (trx) => loadDailyInputs(trx, f.orgId, e21, thursday, new Date()));
    expect(inputs!.input.weeklyOffDays).toContain(4);
    const preview = await h.request('GET', `${base()}/me/comp-off/preview?workedOn=${thursday}`, { token: worker21 });
    expect(preview.status).toBe(200);
    expect(preview.body.data.workedOnType).toBe('weekly_off');
    expect(preview.body.data.reason).not.toBe('working_day');
  });

  it('7-P1-2 a transfer: each date uses the branch in force on it — leave, balances and attendance agree (CAL-2 / CAL-3)', async () => {
    await clearWorkflows();
    const x = uuid('b'); const y = uuid('b');
    await h.admin.insertInto('branches').values([
      { id: x, organizationId: f.orgId, code: 'X', name: 'Fri/Sat off', timezone: 'Asia/Muscat', weeklyOffDays: [5, 6] },
      { id: y, organizationId: f.orgId, code: 'Y', name: 'Thu/Fri off', timezone: 'Asia/Muscat', weeklyOffDays: [4, 5] },
    ]).execute();
    const eT = await seedEmployee(h.admin, f.orgId, x, 24);
    // Sun 3 – Thu 7 May 2026 in branch X: five working days
    const rec = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: eT, leaveTypeId: T['AL'], startDate: '2026-05-03', endDate: '2026-05-07', reason: 'Before the transfer' } });
    expect(rec.status).toBe(201);
    expect(rec.body.data).toMatchObject({ status: 'APPROVED', days: 5 });
    const taken = async () => (await h.request('GET', `${base()}/leave-balances?employeeId=${eT}&year=2026`, { token: f.hrAdmin })).body.data[0].balances.find((b: { leaveTypeId: string }) => b.leaveTypeId === T['AL']).takenDays as number;
    expect(await taken()).toBe(5);
    // transfer to branch Y from 1 July 2026 (the history transition the API writes)
    await h.admin.updateTable('employmentHistory').set({ effectiveTo: '2026-07-01' }).where('employeeId', '=', eT).where('effectiveTo', 'is', null).execute();
    await h.admin.insertInto('employmentHistory').values({ organizationId: f.orgId, employeeId: eT, effectiveFrom: '2026-07-01', effectiveTo: null, branchId: y, departmentId: null, designationId: null, managerEmployeeId: null, employmentType: 'full_time', employmentStatus: 'active', reason: 'Transfer' }).execute();
    await h.admin.updateTable('employees').set({ branchId: y }).where('id', '=', eT).execute();
    // CAL-3: taken stays 5 (stored days are the document) …
    expect(await taken()).toBe(5);
    // … and a leave stored without days (before leave v2) is counted with the branch of each date: still 5, not 4
    await h.admin.updateTable('leaveRecords').set({ days: null }).where('id', '=', rec.body.data.id).execute();
    expect(await taken()).toBe(5);
    // CAL-2: attendance sees the Thursday as a working day of branch X; the shared placement helper agrees
    const inputs = await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, (trx) => loadDailyInputs(trx, f.orgId, eT, '2026-05-07', new Date()));
    expect(inputs!.input.weeklyOffDays).not.toContain(4);
    expect(inputs!.branchId).toBe(x);
    expect(await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, (trx) => effectiveBranchIdOn(trx, f.orgId, eT, '2026-05-07'))).toBe(x);
    expect(await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, (trx) => effectiveBranchIdOn(trx, f.orgId, eT, '2026-07-02'))).toBe(y);
    // a new request after the transfer is counted with branch Y: Sun–Thu = 4 working days (Thursday off)
    const later = nextRange(5);
    const after = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: eT, leaveTypeId: T['AL'], ...later, reason: 'After the transfer' } });
    expect(after.body.data.days).toBe(4);
  });
});

describe('7-P1-3 one applicability rule: gender and employment type (B-41)', () => {
  it('7-P1-3 the type stores its employment types; the portal does not offer it to others; the API refuses them', async () => {
    const types = (await h.request('GET', `${base()}/leave-types`, { token: f.hrUser })).body.data as Array<{ id: string; applicableEmploymentTypes: string[] | null }>;
    expect(types.find((t) => t.id === T['CT'])!.applicableEmploymentTypes).toEqual(['contract']);
    expect(types.find((t) => t.id === T['AL'])!.applicableEmploymentTypes).toBeNull();
    expect((await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'BAD', name: 'Bad', applicableEmploymentTypes: ['boss'] } })).status).toBe(400);
    expect((await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'DUP', name: 'Dup', applicableEmploymentTypes: ['intern', 'intern'] } })).status).toBe(400);
    const me = await h.request('GET', `${base()}/me/leave`, { token: f.employeeUser });
    expect(me.body.data.types.map((t: { id: string }) => t.id)).not.toContain(T['CT']);
    const apply = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: T['CT'], ...nextRange(1), reason: 'Try' } });
    expect(apply.status).toBe(400);
    expect(codes(apply.body)).toContain('NOT_APPLICABLE');
    const hr = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: f.e1, leaveTypeId: T['CT'], ...nextRange(1) } });
    expect(hr.status).toBe(400);
    expect(codes(hr.body)).toContain('NOT_APPLICABLE');
    // a contract employee gets it
    await h.admin.updateTable('employees').set({ employmentType: 'contract' }).where('id', '=', f.e1).execute();
    try {
      expect((await h.request('GET', `${base()}/me/leave`, { token: f.employeeUser })).body.data.types.map((t: { id: string }) => t.id)).toContain(T['CT']);
    } finally { await h.admin.updateTable('employees').set({ employmentType: 'full_time' }).where('id', '=', f.e1).execute(); }
    // PATCH back to every employment type
    const p = await h.request('PATCH', `${base()}/leave-types/${T['CT']}`, { token: f.hrAdmin, body: { applicableEmploymentTypes: null } });
    expect(p.body.data.applicableEmploymentTypes).toBeNull();
    await h.request('PATCH', `${base()}/leave-types/${T['CT']}`, { token: f.hrAdmin, body: { applicableEmploymentTypes: ['contract'] } });
  });

  it('7-P1-3 allocation generation and the balances list follow the same rule', async () => {
    const year = Number(nextRange(1).startDate.slice(0, 4)) + 2;
    const gen = await h.request('POST', `${base()}/leave-allocations/generate`, { token: f.hrAdmin, body: { year, leaveTypeIds: [T['CT']] } });
    expect(gen.status).toBe(201);
    expect(gen.body.data.created).toBe(0);
    const list = await h.request('GET', `${base()}/leave-balances?employeeId=${f.e1}`, { token: f.hrAdmin });
    expect(list.body.data[0].balances.map((b: { leaveTypeId: string }) => b.leaveTypeId)).not.toContain(T['CT']);
  });

  it('7-P1-3 the unexcused-day charger never charges a type that does not apply to the employee (BAL-4)', async () => {
    const mo = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'MO', name: 'Male Only', annualAllowanceDays: 10, applicableGender: 'male' } });
    expect(mo.status).toBe(201);
    const ct = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'CX', name: 'Contract Extra', annualAllowanceDays: 10, applicableEmploymentTypes: ['contract'] } });
    expect(ct.status).toBe(201);
    // her other paid types are at zero for the charged year
    const day = pastWeekday(1, 10);
    const year = Number(day.slice(0, 4));
    const defaults = (await h.request('GET', `${base()}/leave-types`, { token: f.hrAdmin })).body.data as Array<{ id: string; code: string; isPaid: boolean; compOff: boolean }>;
    const zero = defaults.filter((t) => t.isPaid && !t.compOff && !['MO', 'CX'].includes(t.code)).map((t) => ({ employeeId: eF, leaveTypeId: t.id, year, allocatedDays: 0 }));
    expect((await h.request('PUT', `${base()}/leave-allocations`, { token: f.hrAdmin, body: { rows: zero } })).status).toBe(200);
    const settings = resolveAttendanceSettings({}).unexcused;
    const res = await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, (trx) => chargeUnexcusedDay(trx, h.deps.queue, { organizationId: f.orgId, employeeId: eF, date: day, payEffectDays: 1, sourceKind: 'HR', reason: 'probe' }, settings));
    expect(res.outcome).toBe('lop');
    expect(res.leaveTypeCode).toBeNull();
  });
});

describe('7-P2-3 a level approved while its question is open', () => {
  it('7-P2-3 the request moves on without the question and the leave returns to PENDING (REQ-4)', async () => {
    await clearWorkflows();
    await workflow([{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'HR_ADMIN' }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: T['CL'], ...nextRange(1), reason: 'Family' } });
    expect(r.status).toBe(201);
    const reqId = r.body.data.approvalRequestId;
    // e1's manager is e3 (managerUser)
    expect((await h.request('POST', `${base()}/approvals/${reqId}/request-info`, { token: f.managerUser, body: { comment: 'Who covers?' } })).status).toBe(200);
    expect((await leaveRow(r.body.data.id)).status).toBe('INFO_REQUESTED');
    const ok = await h.request('POST', `${base()}/approvals/${reqId}/decide`, { token: f.managerUser, body: { decision: 'APPROVE', stepNo: 1 } });
    expect(ok.status).toBe(200);
    const req = await requestRow(reqId);
    expect([req.status, req.currentStep, req.infoRequestedAt]).toEqual(['PENDING', 2, null]);
    expect((await leaveRow(r.body.data.id)).status).toBe('PENDING');
    const mine = (await h.request('GET', `${base()}/me/leave?year=${r.body.data.startDate.slice(0, 4)}`, { token: f.employeeUser })).body.data.records.find((x: { id: string }) => x.id === r.body.data.id);
    expect(mine).toMatchObject({ status: 'PENDING', canReply: false, infoRequest: null });
    const events = (await h.admin.selectFrom('approvalRequestEvents').select('kind').where('requestId', '=', reqId).execute()).map((e) => e.kind);
    expect(events).toContain('info_request_closed');
    const thread = await h.request('GET', `${base()}/leave-records/${r.body.data.id}/comments`, { token: f.hrAdmin });
    expect(thread.body.data.map((c: { kind: string }) => c.kind)).toEqual(['info_request', 'system']);
  });
});

describe('7-P2-4 comp-off credits pay only for leave dated on or before their expiry', () => {
  it('7-P2-4 applying for comp-off after the only credit expires is refused; before it, allowed (CO-1)', async () => {
    await clearWorkflows();
    const range = nextRange(1);
    await h.admin.insertInto('compOffCredits').values({ organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, workedOn: pastWeekday(5, 7), workedOnType: 'weekly_off', workedMinutes: 480, daysEarned: 1, location: 'HQ', summary: 'Release', status: 'approved', expiresOn: addDays(range.startDate, -1) }).execute();
    const late = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: T['CO'], ...range, reason: 'Comp-off' } });
    expect(late.status).toBe(400);
    expect(codes(late.body)).toContain('COMP_OFF_BALANCE');
    // a credit valid through the date pays for it
    await h.admin.updateTable('compOffCredits').set({ expiresOn: range.startDate }).where('employeeId', '=', f.e1).where('status', '=', 'approved').execute();
    const ok = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: T['CO'], ...range, reason: 'Comp-off' } });
    expect(ok.status).toBe(201);
    // the credit's expiry moves before the leave date before the decision: the approval is refused, nothing is consumed
    await h.admin.updateTable('compOffCredits').set({ expiresOn: addDays(range.startDate, -1) }).where('employeeId', '=', f.e1).where('status', '=', 'approved').execute();
    const decide = await h.request('POST', `${base()}/approvals/${ok.body.data.approvalRequestId}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE', stepNo: 1 } });
    expect(decide.status).toBe(409);
    expect((await leaveRow(ok.body.data.id)).status).toBe('PENDING');
    expect(await h.admin.selectFrom('compOffUsages').select('id').where('leaveRecordId', '=', ok.body.data.id).execute()).toEqual([]);
    await h.request('POST', `${base()}/me/leave/${ok.body.data.id}/withdraw`, { token: f.employeeUser, body: { reason: 'Expired' } });
  });
});

describe('7-P2-5 the comp-off type is editable only in name, Arabic name and colour', () => {
  it('7-P2-5 every other change is refused (CO-3); the labels and colour save; a current value re-sent is harmless', async () => {
    for (const body of [{ code: 'XCO' }, { requiresApproval: false }, { isPaid: false }, { allowHalfDay: false }, { applicableGender: 'female' }, { countMode: 'calendar' }, { maxConsecutiveDays: 1 }, { advanceNoticeDays: 30 }, { applicableEmploymentTypes: ['contract'] }, { treatAsPresent: true }]) {
      const r = await h.request('PATCH', `${base()}/leave-types/${T['CO']}`, { token: f.hrAdmin, body });
      expect([Object.keys(body)[0], r.status]).toEqual([Object.keys(body)[0], 400]);
    }
    const co = await h.admin.selectFrom('leaveTypes').selectAll().where('id', '=', T['CO']).executeTakeFirstOrThrow();
    expect(co).toMatchObject({ requiresApproval: true, isPaid: true, allowHalfDay: true, applicableGender: 'all', countMode: 'working', advanceNoticeDays: 0 });
    const ok = await h.request('PATCH', `${base()}/leave-types/${T['CO']}`, { token: f.hrAdmin, body: { name: 'Time off in lieu', nameAr: 'إجازة بديلة', color: '#6941c6', requiresApproval: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ name: 'Time off in lieu', nameAr: 'إجازة بديلة', color: '#6941c6', compOff: true });
  });
});

describe('7-P2-8 leave stored without days shows its days everywhere; the calendar counts the month only', () => {
  it('7-P2-8 the calendar and the team view compute days on read and clip the calendar to the month (CALN-1, T5)', async () => {
    // a month ~3 months ahead; a leave from its last Sunday into the next month, stored without days
    const probe = new Date(); probe.setUTCMonth(probe.getUTCMonth() + 18, 1); // beyond every nextRange() of this file
    const month = probe.toISOString().slice(0, 7);
    const monthEnd = new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    let start = monthEnd; while (weekday(start) !== 0) start = addDays(start, -1);
    const end = addDays(start, 11);
    const working = (from: string, to: string) => { let n = 0; for (let d = from; d <= to; d = addDays(d, 1)) if (![5, 6].includes(weekday(d))) n += 1; return n; };
    const row = await h.admin.insertInto('leaveRecords').values({ organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, leaveTypeId: T['CL'], startDate: start, endDate: end, status: 'APPROVED', approvedAt: new Date(), days: null }).returning('id').executeTakeFirstOrThrow();
    try {
      const cal = await h.request('GET', `${base()}/leave-calendar?month=${month}`, { token: f.hrAdmin });
      expect(cal.status).toBe(200);
      const entry = cal.body.data.entries.find((e: { id: string }) => e.id === row.id);
      expect(entry.days).toBe(working(start, end));
      expect(entry.daysInPeriod).toBe(working(start, monthEnd));
      // the manager's team card (e1 reports to e3)
      const team = await h.request('GET', `${base()}/me/team/leave`, { token: f.managerUser });
      expect(team.body.data.find((e: { id: string }) => e.id === row.id).days).toBe(working(start, end));
      // the HR list agrees
      const list = await h.request('GET', `${base()}/leave-records?employeeId=${f.e1}&from=${start}&to=${end}`, { token: f.hrAdmin });
      expect(list.body.data.find((e: { id: string }) => e.id === row.id).days).toBe(working(start, end));
    } finally { await h.admin.updateTable('leaveRecords').set({ status: 'CANCELLED' }).where('id', '=', row.id).execute(); }
  });
});

describe('7-P2-11 / 7-P2-12 concurrency and idempotency of the portal', () => {
  it('7-P2-11 two identical parallel applications: the loser gets the overlap message, not "retry" (REQ-1)', async () => {
    await clearWorkflows();
    const body = { leaveTypeId: T['CL'], ...nextRange(2), reason: 'Double click' };
    const [a, b] = await Promise.all([h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body }), h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.message).toMatch(/already leave in this range/);
    const active = await h.admin.selectFrom('leaveRecords').select('id').where('employeeId', '=', f.e1).where('startDate', '=', body.startDate as never).where('status', 'in', ['PENDING', 'APPROVED', 'INFO_REQUESTED']).execute();
    expect(active.length).toBe(1);
  });

  it('7-P2-12 withdrawing an already withdrawn request answers "already withdrawn" (REQ-6)', async () => {
    await clearWorkflows();
    const r = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: T['CL'], ...nextRange(1), reason: 'Family' } });
    expect(r.status).toBe(201);
    const first = await h.request('POST', `${base()}/me/leave/${r.body.data.id}/withdraw`, { token: f.employeeUser, body: { reason: 'Plans changed' } });
    expect(first.status).toBe(200);
    expect(first.body.data.alreadyWithdrawn).toBeUndefined();
    const again = await h.request('POST', `${base()}/me/leave/${r.body.data.id}/withdraw`, { token: f.employeeUser, body: { reason: 'Plans changed' } });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ status: 'CANCELLED', alreadyWithdrawn: true });
  });
});

describe('seat choice on the Leave page (engine §9.8)', () => {
  it('an override on an ALL level waiting for two approvers names the seat it fills; unnamed → 400', async () => {
    await clearWorkflows();
    await workflow([{ order: 1, approverType: 'ROLE', roleId: ROLE.hr_admin, mode: 'ALL' }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: T['CL'], ...nextRange(1), reason: 'Family' } });
    expect(r.status).toBe(201);
    const detail = await h.request('GET', `${base()}/approvals/${r.body.data.approvalRequestId}`, { token: f.hrUser });
    expect(detail.body.data.abilities).toMatchObject({ decideVia: 'override', mustChooseSeat: true });
    const unnamed = await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: f.hrUser, body: { status: 'APPROVED', stepNo: 1 } });
    expect(unnamed.status).toBe(400);
    expect((unnamed.body.details?.issues ?? []).map((i: { path: string }) => i.path)).toContain('onBehalfOfUserId');
    const named = await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: f.hrUser, body: { status: 'APPROVED', stepNo: 1, onBehalfOfUserId: f.hrAdmin } });
    expect(named.status).toBe(200);
    expect(named.body.data).toMatchObject({ status: 'PENDING', approvalStatus: 'PENDING' });
    expect(named.body.data.approvalWaitingFor).toEqual(['HR Admin Two']);
  });
});
