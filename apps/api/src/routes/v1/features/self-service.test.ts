import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, domainEvents, isoToday, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture; let annualId: string;
const DAY = '2026-01-12'; // a Monday

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_self_${process.pid}`);
  f = await seedOrg(h.admin, 'self');
  for (const [date, status, flags] of [[DAY, 'PRESENT', ['LATE']], ['2026-01-13', 'ABSENT', []], ['2026-01-16', 'WEEKLY_OFF', []]] as const) {
    await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId: f.e1, attendanceDate: date, branchId: f.branchA, departmentId: f.departmentA, timezone: 'Asia/Muscat', engineVersion: 'test', status, flags: [...flags], workedMinutes: status === 'PRESENT' ? 480 : 0, lateMinutes: flags.length ? 12 : 0, trace: JSON.stringify({ punches: [] }) }).execute();
  }
  // somebody else's day: must never show up
  await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId: f.e2, attendanceDate: DAY, branchId: f.branchB, timezone: 'Asia/Muscat', engineVersion: 'test', status: 'PRESENT', flags: [], trace: JSON.stringify({ punches: [] }) }).execute();
});
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;

describe('self-service profile and attendance', () => {
  it('returns the caller\'s own profile with names their role cannot read directly', async () => {
    const r = await h.request('GET', `${base()}/me/profile`, { token: f.employeeUser });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ employeeId: f.e1, branch: { id: f.branchA, name: 'Branch A' }, department: { id: f.departmentA, name: 'Operations' }, manager: { id: f.e3 } });
    expect(r.body.data.weeklyOffDays).toEqual([5, 6]);
  });

  it('refuses members without an employee link and non-members', async () => {
    expect((await h.request('GET', `${base()}/me/profile`, { token: f.hrAdmin })).status).toBe(403);
    expect((await h.request('GET', `${base()}/me/overview`, { token: f.outsider })).status).toBe(403);
  });

  it('lists only the caller\'s own days for a month, with totals and names', async () => {
    const r = await h.request('GET', `${base()}/me/attendance?month=2026-01`, { token: f.employeeUser });
    expect(r.status).toBe(200);
    expect(r.body.data.days.map((d: { attendanceDate: string }) => d.attendanceDate)).toEqual([DAY, '2026-01-13', '2026-01-16']);
    expect(r.body.data.days.every((d: { employeeId: string }) => d.employeeId === f.e1)).toBe(true);
    expect(r.body.data.days[0].branchName).toBe('Branch A');
    expect(r.body.data.totals).toMatchObject({ present: 1, absent: 1, weeklyOff: 1, late: 1, workingDays: 2, attendanceRate: 0.5, workedMinutes: 480 });
    expect((await h.request('GET', `${base()}/me/attendance?month=2026-13`, { token: f.employeeUser })).status).toBe(400);
  });

  it('still keeps the employee out of the organisation-wide lists', async () => {
    expect((await h.request('GET', `${base()}/leave-records`, { token: f.employeeUser })).status).toBe(403);
    const daily = await h.request('GET', `${base()}/attendance/daily?date=${DAY}`, { token: f.employeeUser });
    expect(daily.status).toBe(200);
    expect(daily.body.data.map((d: { employeeId: string }) => d.employeeId)).toEqual([f.e1]);
  });
});

describe('self-service leave', () => {
  const start = isoToday(21); const end = isoToday(23);

  it('shows active types with the yearly allowance as the balance', async () => {
    const t = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'AL', name: 'Annual Leave', annualAllowanceDays: 30 } });
    expect(t.status).toBe(201);
    expect(t.body.data.annualAllowanceDays).toBe(30);
    annualId = t.body.data.id;
    // a PATCH of one field leaves the allowance alone
    const patched = await h.request('PATCH', `${base()}/leave-types/${annualId}`, { token: f.hrAdmin, body: { color: '#175cd3' } });
    expect(patched.body.data.annualAllowanceDays).toBe(30);
    const r = await h.request('GET', `${base()}/me/leave`, { token: f.employeeUser });
    expect(r.status).toBe(200);
    expect(r.body.data.types.map((x: { code: string }) => x.code)).toEqual(['AL']);
    expect(r.body.data.balances).toEqual([{ leaveTypeId: annualId, allowanceDays: 30, usedDays: 0, pendingDays: 0, remainingDays: 30 }]);
  });

  let requestId: string;
  it('applies for leave as a PENDING request and tells HR', async () => {
    expect((await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: annualId, startDate: start, endDate: end } })).status).toBe(400); // reason required
    const r = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: annualId, startDate: start, endDate: end, reason: 'Family visit' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'PENDING', leaveTypeCode: 'AL', startDate: start, endDate: end, approvedByName: null });
    expect(r.body.data.days).toBeGreaterThan(0);
    requestId = r.body.data.id;
    const row = await h.admin.selectFrom('leaveRecords').selectAll().where('id', '=', requestId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ employeeId: f.e1, branchId: f.branchA, status: 'PENDING', approvedBy: null, createdBy: f.employeeUser });
    expect((await domainEvents(h.admin, 'leave.requested')).map((e) => e.aggregateId)).toContain(requestId);
    const overlap = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: annualId, startDate: end, endDate: end, reason: 'Again' } });
    expect(overlap.status).toBe(409);
    const bal = await h.request('GET', `${base()}/me/leave`, { token: f.employeeUser });
    expect(bal.body.data.balances[0].pendingDays).toBe(r.body.data.days);
  });

  it('never lets the employee approve, edit or delete the request through the HR endpoints', async () => {
    expect((await h.request('PATCH', `${base()}/leave-records/${requestId}`, { token: f.employeeUser, body: { status: 'APPROVED' } })).status).toBe(403);
    expect((await h.request('DELETE', `${base()}/leave-records/${requestId}`, { token: f.employeeUser })).status).toBe(403);
    expect((await h.request('POST', `${base()}/leave-records`, { token: f.employeeUser, body: { employeeId: f.e1, leaveTypeId: annualId, startDate: isoToday(60), endDate: isoToday(60) } })).status).toBe(403);
  });

  it('HR approves with a note; the employee sees the decision and is notified', async () => {
    const r = await h.request('PATCH', `${base()}/leave-records/${requestId}`, { token: f.hrAdmin, body: { status: 'APPROVED', decisionNote: 'Enjoy!' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'APPROVED', decisionNote: 'Enjoy!' });
    const mine = await h.request('GET', `${base()}/me/leave`, { token: f.employeeUser });
    const rec = mine.body.data.records.find((x: { id: string }) => x.id === requestId);
    expect(rec).toMatchObject({ status: 'APPROVED', decisionNote: 'Enjoy!', approvedByName: 'hrAdmin' });
    expect(mine.body.data.balances[0]).toMatchObject({ pendingDays: 0, usedDays: rec.days, remainingDays: 30 - rec.days });
    const ev = (await domainEvents(h.admin, 'leave.approved')).find((e) => e.aggregateId === requestId);
    expect((ev?.payload as Record<string, unknown>)['userId']).toBe(f.employeeUser);
    // approved leave is HR's to change
    const cancel = await h.request('POST', `${base()}/me/leave/${requestId}/cancel`, { token: f.employeeUser });
    expect(cancel.status).toBe(409);
  });

  it('withdraws a pending request; RLS refuses anything but that shape', async () => {
    const r = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: annualId, startDate: isoToday(45), endDate: isoToday(47), reason: 'Conference' } });
    expect(r.status).toBe(201);
    const c = await h.request('POST', `${base()}/me/leave/${r.body.data.id}/cancel`, { token: f.employeeUser });
    expect(c.status).toBe(200);
    expect(c.body.data.status).toBe('CANCELLED');
    // another employee's request is invisible
    const other = await h.admin.insertInto('leaveRecords').values({ organizationId: f.orgId, employeeId: f.e2, branchId: f.branchB, leaveTypeId: annualId, startDate: isoToday(50), endDate: isoToday(50), status: 'PENDING' }).returning('id').executeTakeFirstOrThrow();
    expect((await h.request('POST', `${base()}/me/leave/${other.id}/cancel`, { token: f.employeeUser })).status).toBe(404);
  });

  it('forbids deciding on one\'s own request', async () => {
    const r = await h.request('POST', `${base()}/me/leave`, { token: f.managerUser, body: { leaveTypeId: annualId, startDate: isoToday(70), endDate: isoToday(71), reason: 'Rest' } });
    expect(r.status).toBe(201);
    expect((await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: f.managerUser, body: { status: 'APPROVED' } })).status).toBe(403);
    expect((await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: f.hrAdmin, body: { status: 'REJECTED', decisionNote: 'Busy week' } })).status).toBe(200);
  });

  it('summarises the portal home', async () => {
    const r = await h.request('GET', `${base()}/me/overview`, { token: f.employeeUser });
    expect(r.status).toBe(200);
    expect(r.body.data.upcomingLeave.map((x: { id: string }) => x.id)).toContain(requestId);
    expect(r.body.data.balances[0]).toMatchObject({ code: 'AL', allowanceDays: 30 });
    expect(r.body.data.pendingLeave).toBe(0);
  });
});

describe('self-service correction requests', () => {
  it('is refused while the organisation has self-service corrections turned off', async () => {
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.employeeUser, body: { employeeId: f.e1, attendanceDate: DAY, type: 'ADD_PUNCH', proposedPunchedAt: `${DAY}T13:00:00.000Z`, reason: 'Forgot to punch out' } });
    expect(r.status).toBe(403);
    await h.admin.updateTable('organizationSettings').set({ attendance: JSON.stringify({ allowSelfServiceCorrections: true }) }).where('organizationId', '=', f.orgId).execute();
  });

  it('accepts a punch correction for one\'s own day and routes it to approval', async () => {
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.employeeUser, body: { employeeId: f.e1, attendanceDate: '2026-01-13', type: 'ADD_PUNCH', proposedPunchedAt: '2026-01-13T04:00:00.000Z', proposedEventType: 'PUNCH_IN', reason: 'Forgot to punch in' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'PENDING', approval: 'PENDING', requestedBy: f.employeeUser });
    const mine = await h.request('GET', `${base()}/attendance/corrections`, { token: f.employeeUser });
    expect(mine.body.data.map((c: { id: string }) => c.id)).toEqual([r.body.data.id]);
  });

  it('refuses other employees and status overrides', async () => {
    expect((await h.request('POST', `${base()}/attendance/corrections`, { token: f.employeeUser, body: { employeeId: f.e2, attendanceDate: DAY, type: 'ADD_PUNCH', proposedPunchedAt: `${DAY}T04:00:00.000Z`, reason: 'Not mine' } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/attendance/corrections`, { token: f.employeeUser, body: { employeeId: f.e1, attendanceDate: DAY, type: 'SET_STATUS', proposedStatus: 'PRESENT', reason: 'Please mark present' } })).status).toBe(403);
  });
});
