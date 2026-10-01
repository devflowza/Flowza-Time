import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, isoToday, isoTodayIn, queueJobs, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

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

  it('clears a flexible shift\'s core hours with null and never keeps them on a fixed shift', async () => {
    const flex = await h.request('POST', `${base()}/shifts`, { token: f.hrAdmin, body: { code: 'EVE', name: 'Evening', type: 'FLEXIBLE', requiredMinutes: 480, coreStart: '17:00', coreEnd: '04:00' } });
    expect(flex.status).toBe(201);
    expect(flex.body.data).toMatchObject({ coreStart: '17:00', coreEnd: '04:00' });
    const omitted = await h.request('PATCH', `${base()}/shifts/${flex.body.data.id}`, { token: f.hrAdmin, body: { name: 'Evening shift' } });
    expect(omitted.body.data).toMatchObject({ name: 'Evening shift', coreStart: '17:00', coreEnd: '04:00' }); // absent = unchanged
    const cleared = await h.request('PATCH', `${base()}/shifts/${flex.body.data.id}`, { token: f.hrAdmin, body: { type: 'FLEXIBLE', coreStart: null, coreEnd: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ requiredMinutes: 480, coreStart: null, coreEnd: null });

    const again = await h.request('PATCH', `${base()}/shifts/${flex.body.data.id}`, { token: f.hrAdmin, body: { coreStart: '10:00', coreEnd: '14:00' } });
    expect(again.body.data).toMatchObject({ coreStart: '10:00', coreEnd: '14:00' });
    const fixed = await h.request('PATCH', `${base()}/shifts/${flex.body.data.id}`, { token: f.hrAdmin, body: { type: 'FIXED', startTime: '08:00', endTime: '16:00' } });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data).toMatchObject({ type: 'FIXED', coreStart: null, coreEnd: null });
  });

  it('starts a new shift\'s day boundary at 12:00 AM and clears its colour with null (absent = unchanged)', async () => {
    const created = await h.request('POST', `${base()}/shifts`, { token: f.hrAdmin, body: { code: 'MID', name: 'Midnight day', type: 'FLEXIBLE', requiredMinutes: 480, color: '#175cd3' } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ dayBoundary: '00:00', punchInWindowBeforeMinutes: 240, punchOutWindowAfterMinutes: 360, color: '#175cd3' });
    const omitted = await h.request('PATCH', `${base()}/shifts/${created.body.data.id}`, { token: f.hrAdmin, body: { name: 'Midnight day 2' } });
    expect(omitted.body.data).toMatchObject({ name: 'Midnight day 2', dayBoundary: '00:00', color: '#175cd3' });
    const cleared = await h.request('PATCH', `${base()}/shifts/${created.body.data.id}`, { token: f.hrAdmin, body: { color: null, graceInMinutes: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ color: null, graceInMinutes: null, dayBoundary: '00:00' });
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
    // a new rule set counts every minute after the shift end; the stricter "beyond the scheduled hours" policy is a switch
    expect(r.body.data).toMatchObject({ overtimeStartAfterMinutes: 0, overtimeMinBlockMinutes: 0, overtimeRoundingMinutes: 0, overtimeRequiresScheduledHours: false });
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
    // the overtime switch alone: nothing else of the rule set changes (no defaults re-applied on PATCH)
    const strict = await h.request('PATCH', `${base()}/attendance-rule-sets/${r.body.data.id}`, { token: f.hrAdmin, body: { overtimeRequiresScheduledHours: true } });
    expect(strict.status).toBe(200);
    expect(strict.body.data).toMatchObject({ overtimeRequiresScheduledHours: true, graceInMinutes: 5, overtimeStartAfterMinutes: 0, version: 3 });
    const row = await h.admin.selectFrom('attendanceRuleSets').select(['overtimeRequiresScheduledHours', 'graceInMinutes']).where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ overtimeRequiresScheduledHours: true, graceInMinutes: 5 });
  });
});

describe('shift changes made outside the Schedule page recompute the days they touch (§G.7)', () => {
  const day = (v: Date | string) => (typeof v === 'string' ? v.slice(0, 10) : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`);
  const latestRecalc = () => h.admin.selectFrom('attendanceRecalculationRequests').selectAll().orderBy('createdAt', 'desc').executeTakeFirstOrThrow();
  let bulkShift: string;

  it('bulk "Assign shift" recomputes the chosen employees from the effective date up to today; a future start waits', async () => {
    const s = await h.request('POST', `${base()}/shifts`, { token: f.hrAdmin, body: { code: 'BULK', name: 'Bulk shift', type: 'FIXED', startTime: '09:00', endTime: '18:00' } });
    expect(s.status).toBe(201);
    bulkShift = s.body.data.id;
    const today = isoTodayIn('Asia/Muscat');
    const from = isoTodayIn('Asia/Muscat', -3);
    const before = await recalcCount();
    const r = await h.request('POST', `${base()}/employees/bulk`, { token: f.hrAdmin, body: { action: 'assign_shift', employeeIds: [f.e3], shiftId: bulkShift, effectiveFrom: from } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ updated: 1, employeeIds: [f.e3] });
    expect(await recalcCount()).toBe(before + 1);
    const req = await latestRecalc();
    expect(req).toMatchObject({ employeeIds: [f.e3], reason: 'shift assigned to employees', status: 'QUEUED' });
    expect([day(req.fromDate), day(req.toDate)]).toEqual([from, today]);
    const resolved = await h.request('GET', `${base()}/shifts/resolve?employeeId=${f.e3}&date=${today}`, { token: f.hrAdmin });
    expect(resolved.body.data.shift.code).toBe('BULK');
    // starting tomorrow: nothing has happened yet, nothing to recompute
    const later = await h.request('POST', `${base()}/employees/bulk`, { token: f.hrAdmin, body: { action: 'assign_shift', employeeIds: [f.e3], shiftId: bulkShift, effectiveFrom: isoTodayIn('Asia/Muscat', 1) } });
    expect(later.status).toBe(200);
    expect(await recalcCount()).toBe(before + 1);
  });

  it('changing the default shift recomputes today organisation-wide; saving the group unchanged does not', async () => {
    const get = await h.request('GET', `${base()}/settings/attendance`, { token: f.owner });
    expect(get.status).toBe(200);
    const before = await recalcCount();
    const put = await h.request('PUT', `${base()}/settings/attendance`, { token: f.owner, body: { ...get.body.data, defaultShiftId: bulkShift } });
    expect(put.status).toBe(200);
    expect(put.body.data.defaultShiftId).toBe(bulkShift);
    expect(await recalcCount()).toBe(before + 1);
    const req = await latestRecalc();
    const today = isoTodayIn('Asia/Muscat');
    expect(req).toMatchObject({ employeeIds: null, branchId: null, reason: 'default shift changed' });
    expect([day(req.fromDate), day(req.toDate)]).toEqual([today, today]);
    const again = await h.request('PUT', `${base()}/settings/attendance`, { token: f.owner, body: put.body.data });
    expect(again.status).toBe(200);
    expect(await recalcCount()).toBe(before + 1);
  });
});
