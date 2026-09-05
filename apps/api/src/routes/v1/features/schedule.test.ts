import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, isoToday, queueJobs, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
beforeAll(async () => { h = await createApiHarness(`flowza_api_sched_${process.pid}`); f = await seedOrg(h.admin, 'sched'); });
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;
const recalcCount = async () => (await queueJobs(h.admin, 'RECALCULATE_RANGE')).length;

describe('shifts and assignments', () => {
  let shiftId: string;
  it('creates shifts and refuses to delete an assigned one', async () => {
    const bad = await h.request('POST', `${base()}/shifts`, { token: f.hrAdmin, body: { code: 'NOTIME', name: 'Broken', type: 'FIXED' } });
    expect(bad.status).toBe(400);
    const r = await h.request('POST', `${base()}/shifts`, { token: f.hrAdmin, body: { code: 'DAY', name: 'Day shift', type: 'FIXED', startTime: '08:00', endTime: '17:00', breaks: [{ start: '12:00', end: '13:00', paid: false }] } });
    expect(r.status).toBe(201);
    shiftId = r.body.data.id;
    expect(r.body.data.startTime).toBe('08:00');
    expect((await h.request('POST', `${base()}/shifts`, { token: f.hrUser, body: { code: 'X', name: 'x', type: 'FIXED', startTime: '08:00', endTime: '17:00' } })).status).toBe(403);
    const before = await recalcCount();
    const assign = await h.request('POST', `${base()}/shift-assignments`, { token: f.hrAdmin, body: { targetType: 'EMPLOYEE', targetId: f.e1, shiftId, effectiveFrom: '2026-01-01' } });
    expect(assign.status).toBe(201);
    expect(assign.body.data.branchId).toBe(f.branchA);
    expect(assign.body.data.recalculationJobId).toBeTypeOf('string'); // effectiveFrom is in the past → recompute up to today
    expect(await recalcCount()).toBe(before + 1);
    const req = await h.admin.selectFrom('attendanceRecalculationRequests').selectAll().orderBy('createdAt', 'desc').executeTakeFirstOrThrow();
    expect(req.employeeIds).toEqual([f.e1]);
    expect(req.branchId).toBe(f.branchA);
    const del = await h.request('DELETE', `${base()}/shifts/${shiftId}`, { token: f.hrAdmin });
    expect(del.status).toBe(409);
    const list = await h.request('GET', `${base()}/shifts`, { token: f.hrUser });
    expect(list.body.data[0].assignmentCount).toBe(1);
  });

  it('returns 409 on overlapping assignments and skips recalculation for future ones', async () => {
    const overlap = await h.request('POST', `${base()}/shift-assignments`, { token: f.hrAdmin, body: { targetType: 'EMPLOYEE', targetId: f.e1, shiftId, effectiveFrom: '2026-03-01', effectiveTo: '2026-04-01' } });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('CONFLICT');
    const before = await recalcCount();
    const future = await h.request('POST', `${base()}/shift-assignments`, { token: f.hrAdmin, body: { targetType: 'BRANCH', targetId: f.branchB, shiftId, effectiveFrom: isoToday(30) } });
    expect(future.status).toBe(201);
    expect(future.body.data.recalculationJobId).toBeNull();
    expect(await recalcCount()).toBe(before);
    // branch manager B may assign within B but not for A employees or the whole organisation
    expect([400, 403]).toContain((await h.request('POST', `${base()}/shift-assignments`, { token: f.branchManagerB, body: { targetType: 'EMPLOYEE', targetId: f.e1, shiftId, effectiveFrom: isoToday(40) } })).status); // RLS hides branch-A employees → not found
    expect((await h.request('POST', `${base()}/shift-assignments`, { token: f.branchManagerB, body: { targetType: 'ORGANIZATION', targetId: f.orgId, shiftId, effectiveFrom: isoToday(40) } })).status).toBe(403);
    const ok = await h.request('POST', `${base()}/shift-assignments`, { token: f.branchManagerB, body: { targetType: 'EMPLOYEE', targetId: f.e2, shiftId, effectiveFrom: isoToday(40) } });
    expect(ok.status).toBe(201);
    const active = await h.request('GET', `${base()}/shift-assignments?activeOn=2026-02-01`, { token: f.hrAdmin });
    expect(active.body.meta.total).toBe(1);
  });

  it('resolves the shift for an employee and date (assignment beats branch, pattern off-days)', async () => {
    const r = await h.request('GET', `${base()}/shifts/resolve?employeeId=${f.e1}&date=2026-02-10`, { token: f.hrAdmin });
    expect(r.status).toBe(200);
    expect(r.body.data.source).toBe('ASSIGNMENT');
    expect(r.body.data.shift.code).toBe('DAY');
    const none = await h.request('GET', `${base()}/shifts/resolve?employeeId=${f.e2}&date=2026-02-10`, { token: f.hrAdmin });
    expect(none.body.data.source).toBe('NONE');
    const pattern = await h.request('POST', `${base()}/shift-patterns`, { token: f.hrAdmin, body: { code: 'ROT', name: '2 on 1 off', cycleLengthDays: 3, anchorDate: '2026-01-05', sequence: [{ day: 0, shiftId }, { day: 1, shiftId }, { day: 2, off: true }] } });
    expect(pattern.status).toBe(201);
    const badPattern = await h.request('POST', `${base()}/shift-patterns`, { token: f.hrAdmin, body: { code: 'BAD', name: 'bad', cycleLengthDays: 2, anchorDate: '2026-01-05', sequence: [{ day: 5, shiftId }] } });
    expect(badPattern.status).toBe(400);
    const pa = await h.request('POST', `${base()}/shift-assignments`, { token: f.hrAdmin, body: { targetType: 'EMPLOYEE', targetId: f.e3, shiftPatternId: pattern.body.data.id, effectiveFrom: '2026-01-05' } });
    expect(pa.status).toBe(201);
    const off = await h.request('GET', `${base()}/shifts/resolve?employeeId=${f.e3}&date=2026-01-07`, { token: f.hrAdmin });
    expect(off.body.data).toMatchObject({ source: 'PATTERN', isPatternOff: true, patternDay: 2 });
    const on = await h.request('GET', `${base()}/shifts/resolve?employeeId=${f.e3}&date=2026-01-08`, { token: f.hrAdmin });
    expect(on.body.data.shift.id).toBe(shiftId);
  });
});

describe('holidays, leave and rule sets', () => {
  it('records holidays and leave, enqueuing recomputation for past dates', async () => {
    const cal = await h.request('POST', `${base()}/holiday-calendars`, { token: f.hrAdmin, body: { name: 'Oman', countryCode: 'OM', isDefault: true } });
    expect(cal.status).toBe(201);
    const before = await recalcCount();
    const hol = await h.request('POST', `${base()}/holidays`, { token: f.hrAdmin, body: { calendarId: cal.body.data.id, name: 'National Day', date: '2025-11-18', endDate: '2025-11-19', type: 'PUBLIC' } });
    expect(hol.status).toBe(201);
    expect(await recalcCount()).toBe(before + 1);
    const futureHol = await h.request('POST', `${base()}/holidays`, { token: f.hrAdmin, body: { calendarId: cal.body.data.id, name: 'Future', date: isoToday(60) } });
    expect(futureHol.status).toBe(201);
    expect(await recalcCount()).toBe(before + 1);
    const list = await h.request('GET', `${base()}/holidays?year=2025`, { token: f.employeeUser });
    expect(list.body.data).toHaveLength(1);
    const lt = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'AL', name: 'Annual leave', isPaid: true } });
    expect(lt.status).toBe(201);
    const lv = await h.request('POST', `${base()}/leave-records`, { token: f.hrUser, body: { employeeId: f.e1, leaveTypeId: lt.body.data.id, startDate: '2026-02-02', endDate: '2026-02-04', reason: 'Vacation' } });
    expect(lv.status).toBe(201);
    expect(lv.body.data.status).toBe('APPROVED');
    expect(lv.body.data.recalculationJobId).toBeTypeOf('string');
    const req = await h.admin.selectFrom('attendanceRecalculationRequests').selectAll().orderBy('createdAt', 'desc').executeTakeFirstOrThrow();
    expect(req.employeeIds).toEqual([f.e1]);
    const clash = await h.request('POST', `${base()}/leave-records`, { token: f.hrUser, body: { employeeId: f.e1, leaveTypeId: lt.body.data.id, startDate: '2026-02-04', endDate: '2026-02-05' } });
    expect(clash.status).toBe(409);
    expect([400, 403]).toContain((await h.request('POST', `${base()}/leave-records`, { token: f.branchManagerB, body: { employeeId: f.e1, leaveTypeId: lt.body.data.id, startDate: '2026-03-01', endDate: '2026-03-01' } })).status);
    const upd = await h.request('PATCH', `${base()}/leave-records/${lv.body.data.id}`, { token: f.hrAdmin, body: { endDate: '2026-02-05' } });
    expect(upd.status).toBe(200);
    expect(upd.body.data.endDate).toBe('2026-02-05');
    const del = await h.request('DELETE', `${base()}/leave-records/${lv.body.data.id}`, { token: f.hrAdmin });
    expect(del.status).toBe(200);
    expect(del.body.data.recalculationJobId).toBeTypeOf('string');
  });

  it('manages effective-dated rule sets: overlap → 409, changes enqueue recalculation, branch scope enforced', async () => {
    const denied = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrUser, body: { name: 'x', effectiveFrom: '2026-01-01' } });
    expect(denied.status).toBe(403);
    const bmOrgWide = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.branchManagerB, body: { name: 'x', effectiveFrom: '2026-01-01' } });
    expect(bmOrgWide.status).toBe(403);
    const before = await recalcCount();
    const r = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Default 2026', effectiveFrom: '2026-01-01', graceInMinutes: 15 } });
    expect(r.status).toBe(201);
    expect(r.body.data.graceInMinutes).toBe(15);
    expect(r.body.data.recalculationJobId).toBeTypeOf('string');
    expect(await recalcCount()).toBe(before + 1);
    const overlap = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Clash', effectiveFrom: '2026-06-01' } });
    expect(overlap.status).toBe(409);
    const branchSpecific = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Branch A rules', branchId: f.branchA, effectiveFrom: '2026-06-01', lateThresholdMinutes: 5 } });
    expect(branchSpecific.status).toBe(201);
    const upd = await h.request('PATCH', `${base()}/attendance-rule-sets/${r.body.data.id}`, { token: f.hrAdmin, body: { graceInMinutes: 5 } });
    expect(upd.status).toBe(200);
    expect(upd.body.data.version).toBe(2);
    expect(upd.body.data.recalculationJobId).toBeTypeOf('string');
    const recalcs = await h.admin.selectFrom('attendanceRecalculationRequests').selectAll().orderBy('createdAt', 'desc').limit(1).execute();
    expect(recalcs[0]!.reason).toContain('Default 2026');
    const active = await h.request('GET', `${base()}/attendance-rule-sets?activeOn=2026-07-01`, { token: f.hrAdmin });
    expect(active.body.data).toHaveLength(2);
    const resolved = await h.request('GET', `${base()}/shifts/resolve?employeeId=${f.e1}&date=2026-07-01`, { token: f.hrAdmin });
    expect(resolved.body.data.ruleSet.name).toBe('Branch A rules');
  });
});
