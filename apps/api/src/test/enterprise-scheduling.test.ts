import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadDailyInputs, withContext } from '@flowza/database';
import { addDays } from '@flowza/shared';
import { auditRows, createApiHarness, isoTodayIn, seedDevice, seedEmployee, seedOrg, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

/*
 * Round-the-clock scheduling (Enterprise, module advanced_scheduling — docs/enterprise/plan.md §4.7–4.8, §8–§9): 24/7 templates,
 * coverage targets and report, additional (double) shift assignments, temporary branch deployments (terminals, check-in at the
 * host branch, clean-up on cancel), and the per-policy check-in methods of the portal punch.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

let h: ApiHarness; let f: OrgFixture; let off: OrgFixture;
const base = () => `/api/v1/orgs/${f.orgId}`;
const TODAY = isoTodayIn('Asia/Muscat');
const OFFICE = { lat: 23.588, lng: 58.3829 }; // branch A
const FAR = { lat: 23.62, lng: 58.45 }; // branch B, several km away
const NOWHERE = { lat: 23.7, lng: 58.6 };
let keySeq = 0;
const key = () => `sched-key-${process.pid}-${(keySeq += 1)}`;

// shifts of the fixture (branch B: everyone on MORNING through a branch assignment; Friday is the weekly off)
const MORNING = uuid('5'); const EVENING = uuid('5'); const OVERLAP = uuid('5'); const FLEX = uuid('5');
let e4: string;

async function setSelfService(patch: Record<string, unknown>): Promise<void> {
  const row = await h.admin.selectFrom('organizationSettings').select('attendance').where('organizationId', '=', f.orgId).executeTakeFirstOrThrow();
  const att = (row.attendance ?? {}) as Record<string, unknown>;
  const selfService = { ...((att['selfService'] as Record<string, unknown>) ?? {}), ...patch };
  await h.admin.updateTable('organizationSettings').set({ attendance: JSON.stringify({ ...att, selfService }) }).where('organizationId', '=', f.orgId).execute();
}
const punch = (body: Record<string, unknown>, channel: 'web' | 'mobile' = 'web') => h.request('POST', `${base()}/me/punch`, { token: f.employeeUser, body: { channel, idempotencyKey: key(), ...body } });
async function nextDirection(): Promise<'in' | 'out'> {
  const s = await h.request('GET', `${base()}/me/punch/status?channel=web`, { token: f.employeeUser });
  return s.body.data.lastDirection === 'in' ? 'out' : 'in';
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_sched_${process.pid}`);
  f = await seedOrg(h.admin, 'sched', { modules: ['advanced_scheduling'] });
  off = await seedOrg(h.admin, 'schedoff');
  await h.admin.updateTable('branches').set({ weeklyOffDays: [5] }).where('id', '=', f.branchB).execute();
  await h.admin.insertInto('shifts').values([
    { id: MORNING, organizationId: f.orgId, code: 'MOR', name: 'Morning', type: 'FIXED', startTime: '06:00', endTime: '14:00', breaks: JSON.stringify([]) },
    { id: EVENING, organizationId: f.orgId, code: 'EVE', name: 'Evening', type: 'FIXED', startTime: '18:00', endTime: '22:00', breaks: JSON.stringify([]) },
    { id: OVERLAP, organizationId: f.orgId, code: 'MID', name: 'Midday', type: 'FIXED', startTime: '10:00', endTime: '16:00', breaks: JSON.stringify([]) },
    { id: FLEX, organizationId: f.orgId, code: 'FLX', name: 'Flexible', type: 'FLEXIBLE', requiredMinutes: 480, breaks: JSON.stringify([]) },
  ]).execute();
  await h.admin.insertInto('shiftAssignments').values({ organizationId: f.orgId, targetType: 'BRANCH', targetId: f.branchB, branchId: f.branchB, shiftId: MORNING, effectiveFrom: '2026-09-01' }).execute();
  e4 = await seedEmployee(h.admin, f.orgId, f.branchB, 4);
});
afterAll(async () => { await h?.close(); });

describe('module gate', () => {
  it('refuses every round-the-clock route with 403 FEATURE_DISABLED while advanced_scheduling is off', async () => {
    const id = uuid('9');
    const routes: Array<[string, string]> = [
      ['POST', 'round-the-clock/preview'], ['POST', 'round-the-clock'], ['GET', 'shift-coverage'], ['POST', 'shift-coverage'], ['GET', `shift-coverage/report?branchId=${off.branchA}&from=2026-09-01&to=2026-09-02`],
      ['PATCH', `shift-coverage/${id}`], ['DELETE', `shift-coverage/${id}`], ['GET', 'additional-shift-assignments'], ['POST', 'additional-shift-assignments'],
      ['PATCH', `additional-shift-assignments/${id}`], ['DELETE', `additional-shift-assignments/${id}`], ['GET', 'branch-deployments'], ['POST', 'branch-deployments'], ['POST', `branch-deployments/${id}/cancel`],
    ];
    for (const [method, path] of routes) {
      const r = await h.request(method, `/api/v1/orgs/${off.orgId}/${path}`, { token: off.owner, ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }) });
      expect([method, path, r.status, r.body?.code]).toEqual([method, path, 403, 'FEATURE_DISABLED']);
      expect(r.body.details).toMatchObject({ reason: 'MODULE_DISABLED', module: 'advanced_scheduling' });
    }
  });
});

describe('round-the-clock templates', () => {
  let team1: string; let team2: string;
  const input = () => ({ template: 'THREE_SHIFT_CONTINENTAL', codePrefix: 'C24', namePrefix: 'Plant', firstShiftStart: '06:00', anchorDate: '2026-09-01', breakMinutes: 30 });

  it('previews a template (shift.manage) without writing anything', async () => {
    const r = await h.request('POST', `${base()}/round-the-clock/preview`, { token: f.hrAdmin, body: input() });
    expect(r.status).toBe(200);
    expect(r.body.data.crews).toHaveLength(4);
    expect(r.body.data.shifts.map((s: { code: string }) => s.code)).toEqual(['C24-M', 'C24-E', 'C24-N']);
    expect(r.body.data.coverageCheck).toEqual({ covered: true, minCrewsPerShift: 1 });
    expect(r.body.data.averageWeeklyHours).toBe(42);
    expect(await h.admin.selectFrom('shifts').select('id').where('organizationId', '=', f.orgId).where('code', 'like', 'C24%').execute()).toHaveLength(0);
    // hr_user holds shift.assign but not shift.manage
    expect((await h.request('POST', `${base()}/round-the-clock/preview`, { token: f.hrUser, body: input() })).status).toBe(403);
  });

  it('applies it in one transaction: shifts, crew patterns, team assignments, coverage targets — and the crews resolve on their days', async () => {
    team1 = uuid('7'); team2 = uuid('7');
    await h.admin.insertInto('teams').values([{ id: team1, organizationId: f.orgId, code: 'T1', name: 'Crew team 1', branchId: f.branchA }, { id: team2, organizationId: f.orgId, code: 'T2', name: 'Crew team 2', branchId: f.branchA }]).execute();
    await h.admin.insertInto('teamMembers').values([{ organizationId: f.orgId, teamId: team1, employeeId: f.e1 }, { organizationId: f.orgId, teamId: team2, employeeId: f.e3 }]).execute();
    const r = await h.request('POST', `${base()}/round-the-clock`, { token: f.hrAdmin, body: { ...input(), crewTeams: [{ crew: 'A', teamId: team1 }, { crew: 'B', teamId: team2 }], coverage: { branchId: f.branchA, minHeadcount: 1 } } });
    expect(r.status).toBe(201);
    const d = r.body.data;
    expect(d.shiftIds).toHaveLength(3);
    expect(d.patternIds).toHaveLength(4);
    expect(d.assignmentIds).toHaveLength(2);
    expect(d.coverageIds).toHaveLength(3);
    expect(d.recalculationJobId).toEqual(expect.any(String));
    const shifts = await h.admin.selectFrom('shifts').select(['id', 'code', 'startTime', 'endTime', 'breaks', 'color']).where('id', 'in', d.shiftIds).execute();
    expect(shifts.find((s) => s.code === 'C24-N')).toMatchObject({ startTime: '22:00:00', endTime: '06:00:00', breaks: [{ minutes: 30, paid: false }] });
    const patterns = await h.admin.selectFrom('shiftPatterns').select(['code', 'anchorDate', 'cycleLengthDays']).where('id', 'in', d.patternIds).orderBy('code').execute();
    expect(patterns.map((p) => [p.code, p.cycleLengthDays])).toEqual([['C24-A', 8], ['C24-B', 8], ['C24-C', 8], ['C24-D', 8]]);
    const [M, E] = d.shiftIds as string[];
    const resolve = async (employeeId: string, date: string) => (await h.request('GET', `${base()}/shifts/resolve?employeeId=${employeeId}&date=${date}`, { token: f.hrAdmin })).body.data;
    // crew A (team 1, e1): M M E E N N · · from the anchor; crew B (team 2, e3) the same two days later
    expect(await resolve(f.e1, '2026-09-01')).toMatchObject({ source: 'PATTERN', patternDay: 0, shift: { id: M } });
    expect(await resolve(f.e1, '2026-09-03')).toMatchObject({ patternDay: 2, shift: { id: E } });
    expect(await resolve(f.e3, '2026-09-01')).toMatchObject({ isPatternOff: true, shift: null });
    expect(await resolve(f.e3, '2026-09-03')).toMatchObject({ shift: { id: M } });
    expect((await auditRows(h.admin, 'shift.round_the_clock_applied')).length).toBe(1);
  });

  it('refuses a code that exists (409) and a team already on a shift from the anchor date (409), writing nothing', async () => {
    const before = (await h.admin.selectFrom('shifts').select('id').where('organizationId', '=', f.orgId).execute()).length;
    const clash = await h.request('POST', `${base()}/round-the-clock`, { token: f.hrAdmin, body: { ...input(), codePrefix: 'c24' } });
    expect(clash.status).toBe(409);
    expect(clash.body.details.shiftCodes).toEqual(expect.arrayContaining(['C24-M']));
    const team = await h.request('POST', `${base()}/round-the-clock`, { token: f.hrAdmin, body: { ...input(), codePrefix: 'X24', crewTeams: [{ crew: 'A', teamId: team1 }] } });
    expect(team.status).toBe(409);
    expect((await h.admin.selectFrom('shifts').select('id').where('organizationId', '=', f.orgId).execute()).length).toBe(before);
  });
});

describe('additional (double) shift assignments', () => {
  let rowId: string;

  it('assigns an additional fixed shift (inclusive last day) and recalculates the past days', async () => {
    const r = await h.request('POST', `${base()}/additional-shift-assignments`, { token: f.hrAdmin, body: { employeeId: f.e2, shiftId: EVENING, effectiveFrom: '2026-09-06', effectiveTo: '2026-09-06' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ employeeId: f.e2, branchId: f.branchB, shift: { id: EVENING, startTime: '18:00', endTime: '22:00' }, effectiveFrom: '2026-09-06', effectiveTo: '2026-09-06' });
    expect(r.body.data.recalculationJobId).toEqual(expect.any(String));
    rowId = r.body.data.id;
    const stored = await h.admin.selectFrom('additionalShiftAssignments').selectAll().where('id', '=', rowId).executeTakeFirstOrThrow();
    expect(String(stored.effectiveTo instanceof Date ? stored.effectiveTo.toISOString() : stored.effectiveTo).slice(0, 10)).toBe('2026-09-07');
    expect((await auditRows(h.admin, 'shift.additional_assigned')).length).toBe(1);
  });

  it('refuses an overlapping assignment (409), a combination that cannot be one day (422 with the dates) and a flexible shift (422)', async () => {
    const overlap = await h.request('POST', `${base()}/additional-shift-assignments`, { token: f.hrAdmin, body: { employeeId: f.e2, shiftId: EVENING, effectiveFrom: '2026-09-06', effectiveTo: '2026-09-08' } });
    expect(overlap.status).toBe(409);
    // 10:00–16:00 overlaps the 06:00–14:00 morning shift; Friday (the 11th) is a weekly off and not checked
    const clash = await h.request('POST', `${base()}/additional-shift-assignments`, { token: f.hrAdmin, body: { employeeId: f.e2, shiftId: OVERLAP, effectiveFrom: '2026-09-10', effectiveTo: '2026-09-12' } });
    expect(clash.status).toBe(422);
    expect(clash.body.code).toBe('UNPROCESSABLE');
    expect(clash.body.details.reason).toBe('OVERLAP');
    expect(clash.body.details.conflicts.map((c: { date: string }) => c.date)).toEqual(['2026-09-10', '2026-09-12']);
    // open-ended: checked over the first 92 days
    const open = await h.request('POST', `${base()}/additional-shift-assignments`, { token: f.hrAdmin, body: { employeeId: f.e2, shiftId: OVERLAP, effectiveFrom: '2026-09-20' } });
    expect(open.status).toBe(422);
    const flexible = await h.request('POST', `${base()}/additional-shift-assignments`, { token: f.hrAdmin, body: { employeeId: f.e2, shiftId: FLEX, effectiveFrom: '2026-09-14', effectiveTo: '2026-09-14' } });
    expect(flexible.status).toBe(422);
    expect(flexible.body.details).toEqual({ reason: 'NOT_FIXED', conflicts: [] });
    const same = await h.request('POST', `${base()}/additional-shift-assignments`, { token: f.hrAdmin, body: { employeeId: f.e2, shiftId: MORNING, effectiveFrom: '2026-09-14', effectiveTo: '2026-09-14' } });
    expect(same.status).toBe(422);
    expect(same.body.details.reason).toBe('SAME_SHIFT');
    expect((await h.admin.selectFrom('additionalShiftAssignments').select('id').where('organizationId', '=', f.orgId).execute())).toHaveLength(1);
  });

  it('extends (checking the added days) and the engine input then has a double-shift day', async () => {
    const r = await h.request('PATCH', `${base()}/additional-shift-assignments/${rowId}`, { token: f.hrAdmin, body: { effectiveTo: '2026-09-07' } });
    expect(r.status).toBe(200);
    expect(r.body.data.effectiveTo).toBe('2026-09-07');
    const loaded = await withContext(h.deps.db, { kind: 'system', organizationId: f.orgId }, (trx) => loadDailyInputs(trx, f.orgId, f.e2, '2026-09-06', new Date()));
    expect(loaded!.additionalShiftId).toBe(EVENING);
    expect(loaded!.input.shift).toMatchObject({ id: MORNING, startTime: '06:00', endTime: '22:00' });
    expect(loaded!.input.shift?.segments?.map((s) => s.shiftId)).toEqual([MORNING, EVENING]);
  });

  it('branch scope: a branch-B manager lists branch B rows and cannot assign an employee of branch A', async () => {
    const list = await h.request('GET', `${base()}/additional-shift-assignments`, { token: f.branchManagerB });
    expect(list.status).toBe(200);
    expect(list.body.data.map((a: { id: string }) => a.id)).toEqual([rowId]);
    expect(list.body.data[0]).toMatchObject({ employeeName: 'Employee 2', shift: { code: 'EVE' } });
    const denied = await h.request('POST', `${base()}/additional-shift-assignments`, { token: f.branchManagerB, body: { employeeId: f.e1, shiftId: EVENING, effectiveFrom: '2026-09-20', effectiveTo: '2026-09-20' } });
    expect(denied.status).toBe(403);
  });

  it('deletes an assignment (recalculating its past days)', async () => {
    const created = await h.request('POST', `${base()}/additional-shift-assignments`, { token: f.hrAdmin, body: { employeeId: f.e2, shiftId: EVENING, effectiveFrom: '2026-09-20', effectiveTo: '2026-09-21' } });
    expect(created.status).toBe(201);
    const del = await h.request('DELETE', `${base()}/additional-shift-assignments/${created.body.data.id}`, { token: f.hrAdmin });
    expect(del.status).toBe(200);
    expect(del.body.data.recalculationJobId).toEqual(expect.any(String));
    expect((await h.request('DELETE', `${base()}/additional-shift-assignments/${created.body.data.id}`, { token: f.hrAdmin })).status).toBe(404);
  });
});

describe('coverage targets and report', () => {
  let morningTarget: string; let eveningTarget: string;

  it('creates, refuses a duplicate, and a PATCH of one field leaves the other untouched', async () => {
    const r = await h.request('POST', `${base()}/shift-coverage`, { token: f.hrAdmin, body: { branchId: f.branchB, shiftId: MORNING, minHeadcount: 2 } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ branchId: f.branchB, shiftId: MORNING, shiftName: 'Morning', weekdays: [0, 1, 2, 3, 4, 5, 6], minHeadcount: 2 });
    morningTarget = r.body.data.id;
    expect((await h.request('POST', `${base()}/shift-coverage`, { token: f.hrAdmin, body: { branchId: f.branchB, shiftId: MORNING, minHeadcount: 5 } })).status).toBe(409);
    const p1 = await h.request('PATCH', `${base()}/shift-coverage/${morningTarget}`, { token: f.hrAdmin, body: { minHeadcount: 3 } });
    expect(p1.body.data).toMatchObject({ weekdays: [0, 1, 2, 3, 4, 5, 6], minHeadcount: 3 });
    const p2 = await h.request('PATCH', `${base()}/shift-coverage/${morningTarget}`, { token: f.hrAdmin, body: { weekdays: [6, 0, 1, 2, 3, 4, 5] } });
    expect(p2.body.data).toMatchObject({ weekdays: [0, 1, 2, 3, 4, 5, 6], minHeadcount: 3 });
    await h.request('PATCH', `${base()}/shift-coverage/${morningTarget}`, { token: f.hrAdmin, body: { minHeadcount: 2 } });
    const ev = await h.request('POST', `${base()}/shift-coverage`, { token: f.hrAdmin, body: { branchId: f.branchB, shiftId: EVENING, weekdays: [0], minHeadcount: 1 } });
    expect(ev.status).toBe(201);
    eveningTarget = ev.body.data.id;
    const list = await h.request('GET', `${base()}/shift-coverage?branchId=${f.branchB}`, { token: f.branchManagerB });
    expect(list.body.data.map((c: { id: string }) => c.id).sort()).toEqual([morningTarget, eveningTarget].sort());
    // shift.manage is needed to write; a branch-B manager only holds shift.view / shift.assign
    expect((await h.request('PATCH', `${base()}/shift-coverage/${morningTarget}`, { token: f.branchManagerB, body: { minHeadcount: 9 } })).status).toBe(403);
  });

  it('reports scheduled vs required per day and shift: leave, weekly offs and additional shifts counted right, gaps shown', async () => {
    const leaveType = await h.admin.insertInto('leaveTypes').values({ organizationId: f.orgId, code: 'AL', name: 'Annual', isPaid: true }).returning('id').executeTakeFirstOrThrow();
    await h.admin.insertInto('leaveRecords').values({ organizationId: f.orgId, employeeId: e4, branchId: f.branchB, leaveTypeId: leaveType.id, startDate: '2026-09-08', endDate: '2026-09-08', status: 'APPROVED' }).execute();
    const r = await h.request('GET', `${base()}/shift-coverage/report?branchId=${f.branchB}&from=2026-09-06&to=2026-09-12`, { token: f.hrAdmin });
    expect(r.status).toBe(200);
    const rep = r.body.data;
    expect(rep.shifts.map((s: { id: string }) => s.id)).toEqual([MORNING, EVENING]);
    const cell = (date: string, shiftId: string) => rep.days.find((d: { date: string }) => d.date === date).cells.find((c: { shiftId: string }) => c.shiftId === shiftId);
    // Sunday: e2 and e4 on the morning; e2's additional evening meets the Sunday-only evening target
    expect(cell('2026-09-06', MORNING)).toEqual({ shiftId: MORNING, required: 2, scheduled: 2, gap: 0 });
    expect(cell('2026-09-06', EVENING)).toEqual({ shiftId: EVENING, required: 1, scheduled: 1, gap: 0 });
    // Monday: the extended additional evening is scheduled though nothing is required
    expect(cell('2026-09-07', EVENING)).toEqual({ shiftId: EVENING, required: 0, scheduled: 1, gap: 0 });
    // Tuesday: e4 on approved leave → a gap of one
    expect(cell('2026-09-08', MORNING)).toEqual({ shiftId: MORNING, required: 2, scheduled: 1, gap: 1 });
    // Friday: the branch's weekly off
    expect(cell('2026-09-11', MORNING)).toEqual({ shiftId: MORNING, required: 2, scheduled: 0, gap: 2 });
    expect(rep.days).toHaveLength(7);
  });

  it('limits the report to 62 days and to the caller\'s branches; deletes a target', async () => {
    expect((await h.request('GET', `${base()}/shift-coverage/report?branchId=${f.branchB}&from=2026-07-01&to=2026-09-01`, { token: f.hrAdmin })).status).toBe(400);
    expect((await h.request('GET', `${base()}/shift-coverage/report?branchId=${f.branchB}&from=2026-09-01&to=2026-09-02`, { token: f.branchManagerB })).status).toBe(200);
    expect((await h.request('GET', `${base()}/shift-coverage/report?branchId=${f.branchA}&from=2026-09-01&to=2026-09-02`, { token: f.branchManagerB })).status).toBe(403);
    expect((await h.request('DELETE', `${base()}/shift-coverage/${eveningTarget}`, { token: f.hrAdmin })).status).toBe(204);
    expect((await h.request('GET', `${base()}/shift-coverage?branchId=${f.branchB}`, { token: f.hrAdmin })).body.data).toHaveLength(1);
    expect((await auditRows(h.admin, 'shift.coverage_deleted')).length).toBe(1);
  });
});

describe('temporary branch deployments', () => {
  let hostPush: string; let hostNoPush: string; let deviceB: string; let deploymentId: string;

  it('deploys an employee and enrols them on the host branch\'s terminals only (one sync job of PUSH_EMPLOYEE items)', async () => {
    hostPush = await seedDevice(h.admin, f.orgId, f.branchA);
    hostNoPush = await seedDevice(h.admin, f.orgId, f.branchA, { capabilities: { attendancePull: true, employeePush: false, employeeDelete: false } });
    await seedDevice(h.admin, f.orgId, f.branchA, { status: 'disabled' });
    deviceB = await seedDevice(h.admin, f.orgId, f.branchB);
    const r = await h.request('POST', `${base()}/branch-deployments`, { token: f.hrAdmin, body: { employeeId: f.e2, branchId: f.branchA, fromDate: TODAY, toDate: addDays(TODAY, 5), reason: 'Covering the night crew' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ employeeId: f.e2, employeeName: 'Employee 2', homeBranchId: f.branchB, homeBranchName: 'Branch B', branchId: f.branchA, branchName: 'Branch A', status: 'active', enrolOnDevices: true, cancelledAt: null });
    deploymentId = r.body.data.id;
    const jobId = r.body.data.enrolJobId as string;
    expect(jobId).toEqual(expect.any(String));
    const job = await h.admin.selectFrom('syncJobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job).toMatchObject({ jobType: 'PUSH_EMPLOYEES', branchId: f.branchA });
    const items = await h.admin.selectFrom('syncJobItems').select(['deviceId', 'employeeId', 'operation']).where('syncJobId', '=', jobId).execute();
    expect(items).toEqual([{ deviceId: hostPush, employeeId: f.e2, operation: 'PUSH_EMPLOYEE' }]);
    expect(items.some((i) => i.deviceId === hostNoPush || i.deviceId === deviceB)).toBe(false);
    // the sync job is readable at /sync/:id
    expect((await h.request('GET', `${base()}/sync/jobs/${jobId}`, { token: f.hrAdmin })).status).toBe(200);
    expect((await auditRows(h.admin, 'employee.deployment_created')).length).toBe(1);
  });

  it('refuses an overlap (409), the own branch (400), a past range (400) and a caller without access to the host branch (403)', async () => {
    expect((await h.request('POST', `${base()}/branch-deployments`, { token: f.hrAdmin, body: { employeeId: f.e2, branchId: f.branchA, fromDate: addDays(TODAY, 3), toDate: addDays(TODAY, 8), reason: 'Again' } })).status).toBe(409);
    expect((await h.request('POST', `${base()}/branch-deployments`, { token: f.hrAdmin, body: { employeeId: f.e2, branchId: f.branchB, fromDate: addDays(TODAY, 20), toDate: addDays(TODAY, 21), reason: 'Home' } })).status).toBe(400);
    expect((await h.request('POST', `${base()}/branch-deployments`, { token: f.hrAdmin, body: { employeeId: f.e3, branchId: f.branchB, fromDate: addDays(TODAY, -9), toDate: addDays(TODAY, -2), reason: 'Past' } })).status).toBe(400);
    // the branch-B manager may update e2 (home B) but has no access to branch A
    const denied = await h.request('POST', `${base()}/branch-deployments`, { token: f.branchManagerB, body: { employeeId: f.e2, branchId: f.branchA, fromDate: addDays(TODAY, 20), toDate: addDays(TODAY, 21), reason: 'Scope' } });
    expect(denied.status).toBe(403);
    // employee.update is needed: payroll holds employee.view only
    expect((await h.request('POST', `${base()}/branch-deployments`, { token: f.payrollUser, body: { employeeId: f.e2, branchId: f.branchA, fromDate: addDays(TODAY, 20), toDate: addDays(TODAY, 21), reason: 'Perm' } })).status).toBe(403);
  });

  it('lists for host and home branch readers with the derived status', async () => {
    const home = await h.request('GET', `${base()}/branch-deployments`, { token: f.branchManagerB });
    expect(home.status).toBe(200);
    expect(home.body.data.map((d: { id: string }) => d.id)).toContain(deploymentId);
    expect((await h.request('GET', `${base()}/branch-deployments?status=active`, { token: f.hrAdmin })).body.data.map((d: { id: string }) => d.id)).toEqual([deploymentId]);
    expect((await h.request('GET', `${base()}/branch-deployments?status=scheduled`, { token: f.hrAdmin })).body.data).toEqual([]);
    expect((await h.request('GET', `${base()}/branch-deployments?branchId=${f.branchA}&activeOn=${TODAY}`, { token: f.hrAdmin })).body.meta.total).toBe(1);
  });

  it('cancels: a deployment that enrolled is cleaned up at once (the queued enrolment is stopped); a second cancel is refused', async () => {
    const r = await h.request('POST', `${base()}/branch-deployments`, { token: f.hrAdmin, body: { employeeId: f.e3, branchId: f.branchB, fromDate: addDays(TODAY, 10), toDate: addDays(TODAY, 12), reason: 'Stocktaking' } });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('scheduled');
    const enrolJobId = r.body.data.enrolJobId as string;
    expect((await h.admin.selectFrom('syncJobItems').select('deviceId').where('syncJobId', '=', enrolJobId).execute()).map((i) => i.deviceId)).toEqual([deviceB]);
    const c = await h.request('POST', `${base()}/branch-deployments/${r.body.data.id}/cancel`, { token: f.hrAdmin, body: { reason: 'Plans changed' } });
    expect(c.status).toBe(200);
    expect(c.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'Plans changed' });
    expect(c.body.data.cleanedUpAt).not.toBeNull();
    expect((await h.admin.selectFrom('syncJobItems').select('status').where('syncJobId', '=', enrolJobId).execute()).map((i) => i.status)).toEqual(['CANCELLED']);
    expect((await h.request('POST', `${base()}/branch-deployments/${r.body.data.id}/cancel`, { token: f.hrAdmin, body: { reason: 'Again please' } })).status).toBe(409);
    const audit = await auditRows(h.admin, 'employee.deployment_cancelled');
    expect(audit[0]!.newValue).toMatchObject({ status: 'cancelled', cleanup: { cancelledEnrolItems: 1 } });
  });
});

describe('web check-in at the host branch during a deployment', () => {
  it('accepts a punch at a host-branch fence only while a deployment covers today, and records it on the payload', async () => {
    await setSelfService({ webCheckIn: true, requireGeofence: 'block', duplicatePunchSeconds: 0 });
    const fence = (name: string, branchId: string, at: { lat: number; lng: number }) => h.request('POST', `${base()}/geofences`, { token: f.owner, body: { name, branchId, latitude: at.lat, longitude: at.lng, radiusM: 150, enforcement: 'hard_block', accuracyThresholdM: 100, assignments: [{ scope: 'branch', targetId: branchId }] } });
    expect((await fence('Branch A gate', f.branchA, OFFICE)).status).toBe(201);
    expect((await fence('Branch B yard', f.branchB, FAR)).status).toBe(201);

    // not deployed: branch B's yard is outside the employee's (branch A) fence
    const before = await punch({ direction: await nextDirection(), ...FAR, accuracy: 10 });
    expect(before.status).toBe(403);
    expect(before.body.details.reason).toBe('OUTSIDE_GEOFENCE');
    // a deployment that starts tomorrow does not count today
    const later = await h.request('POST', `${base()}/branch-deployments`, { token: f.hrAdmin, body: { employeeId: f.e1, branchId: f.branchB, fromDate: addDays(TODAY, 1), toDate: addDays(TODAY, 2), reason: 'Next week', enrolOnDevices: false } });
    expect(later.status).toBe(201);
    expect(later.body.data.enrolJobId).toBeNull();
    expect((await punch({ direction: await nextDirection(), ...FAR, accuracy: 10 })).status).toBe(403);
    expect((await h.request('POST', `${base()}/branch-deployments/${later.body.data.id}/cancel`, { token: f.hrAdmin, body: { reason: 'Moved to today' } })).status).toBe(200);

    const dep = await h.request('POST', `${base()}/branch-deployments`, { token: f.hrAdmin, body: { employeeId: f.e1, branchId: f.branchB, fromDate: TODAY, toDate: addDays(TODAY, 2), reason: 'Covering today', enrolOnDevices: false } });
    expect(dep.status).toBe(201);
    const status = await h.request('GET', `${base()}/me/punch/status?channel=web`, { token: f.employeeUser });
    expect(status.body.data.deployment).toEqual({ branchId: f.branchB, branchName: 'Branch B', toDate: addDays(TODAY, 2) });
    expect(status.body.data.fences.map((x: { name: string }) => x.name).sort()).toEqual(['Branch A gate', 'Branch B yard']);

    const dir = await nextDirection();
    const ok = await punch({ direction: dir, ...FAR, accuracy: 10 });
    expect(ok.status).toBe(201);
    expect(ok.body.data.verdict).toMatchObject({ verdict: 'allowed', geofenceName: 'Branch B yard' });
    const raw = await h.admin.selectFrom('attendanceRawTransactions').selectAll().where('organizationId', '=', f.orgId).where('employeeId', '=', f.e1).orderBy('punchedAt', 'desc').executeTakeFirstOrThrow();
    // the punch stays the employee's own (home branch A); the payload says where it was accepted
    expect(raw.branchId).toBe(f.branchA);
    expect(raw.rawPayload).toMatchObject({ verdict: 'allowed', withinGeofence: true, deploymentId: dep.body.data.id, deployedBranchId: f.branchB });
    // somewhere else entirely is still refused
    const nowhere = await punch({ direction: dir === 'in' ? 'out' : 'in', ...NOWHERE, accuracy: 10 });
    expect(nowhere.status).toBe(403);
    // at the home fence, the own fence decides (no deployment on the payload)
    const home = await punch({ direction: dir === 'in' ? 'out' : 'in', ...OFFICE, accuracy: 10 });
    expect(home.status).toBe(201);
    const last = await h.admin.selectFrom('attendanceRawTransactions').select('rawPayload').where('organizationId', '=', f.orgId).where('employeeId', '=', f.e1).orderBy('punchedAt', 'desc').executeTakeFirstOrThrow();
    expect(last.rawPayload).not.toHaveProperty('deploymentId');
    // the module switched off: the host branch's zone no longer counts (the deployment itself stays)
    const setModule = (enabled: boolean) => h.admin.updateTable('organizationModules').set({ enabled }).where('organizationId', '=', f.orgId).where('moduleKey', '=', 'advanced_scheduling').execute();
    await setModule(false);
    expect((await punch({ direction: await nextDirection(), ...FAR, accuracy: 10 })).status).toBe(403);
    expect((await h.request('GET', `${base()}/me/punch/status?channel=web`, { token: f.employeeUser })).body.data.deployment).toBeNull();
    await setModule(true);
    // ended / cancelled → refused again
    expect((await h.request('POST', `${base()}/branch-deployments/${dep.body.data.id}/cancel`, { token: f.hrAdmin, body: { reason: 'Back home' } })).status).toBe(200);
    expect((await punch({ direction: await nextDirection(), ...FAR, accuracy: 10 })).status).toBe(403);
    expect((await h.request('GET', `${base()}/me/punch/status?channel=web`, { token: f.employeeUser })).body.data.deployment).toBeNull();
  });
});

describe('per-policy check-in methods', () => {
  const POLICY = uuid('6');
  const setMethods = async (methods: Record<string, unknown>) => {
    const policy = { methods: { web: true, mobile: true, selfie: true, requireGeofence: 'inherit', ...methods } };
    const exists = await h.admin.selectFrom('attendanceRuleSets').select('id').where('id', '=', POLICY).executeTakeFirst();
    if (exists) await h.admin.updateTable('attendanceRuleSets').set({ policy: JSON.stringify(policy) }).where('id', '=', POLICY).execute();
    else await h.admin.insertInto('attendanceRuleSets').values({ id: POLICY, organizationId: f.orgId, name: 'Office staff', effectiveFrom: '2026-01-01', ramadanMode: JSON.stringify({}), policy: JSON.stringify(policy) }).execute();
  };

  it('a policy that turns web check-in off refuses it (403 CHECKIN_METHOD_NOT_ALLOWED) — with the attendance_policies module off', async () => {
    await setSelfService({ webCheckIn: true, mobileCheckIn: false, requireGeofence: 'block' });
    await setMethods({ web: false });
    const status = await h.request('GET', `${base()}/me/punch/status?channel=web`, { token: f.employeeUser });
    expect(status.body.data.blockers).toContain('CHECKIN_METHOD_NOT_ALLOWED');
    expect(status.body.data.canCheckIn).toBe(false);
    const r = await punch({ direction: await nextDirection(), ...OFFICE, accuracy: 10 });
    expect(r.status).toBe(403);
    expect(r.body.details.reason).toBe('CHECKIN_METHOD_NOT_ALLOWED');
    // the organisation switch is judged first: mobile is off for everyone
    const mobile = await punch({ direction: await nextDirection(), ...OFFICE, accuracy: 10 }, 'mobile');
    expect(mobile.body.details.reason).toBe('MOBILE_CHECKIN_DISABLED');
    await setSelfService({ mobileCheckIn: true });
    expect((await punch({ direction: await nextDirection(), ...OFFICE, accuracy: 10 }, 'mobile')).status).toBe(201);
  });

  it('mobile / selfie off and a geofence requirement that overrides the organisation\'s', async () => {
    await setMethods({ web: true, mobile: false, selfie: false, requireGeofence: 'off' });
    const mobile = await punch({ direction: await nextDirection(), ...OFFICE, accuracy: 10 }, 'mobile');
    expect(mobile.status).toBe(403);
    expect(mobile.body.details.reason).toBe('CHECKIN_METHOD_NOT_ALLOWED');
    // the organisation blocks outside the fence; this policy does not judge the location at all
    const anywhere = await punch({ direction: await nextDirection(), ...NOWHERE, accuracy: 10 });
    expect(anywhere.status).toBe(201);
    expect(anywhere.body.data.verdict.verdict).toBe('no_fence');
    expect((await h.request('GET', `${base()}/me/punch/status?channel=web`, { token: f.employeeUser })).body.data.policy.requireGeofence).toBe('off');
    await setSelfService({ allowSelfieCheckIn: true });
    const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const selfie = await h.request('POST', `${base()}/me/selfie-checkin`, { token: f.employeeUser, body: { direction: 'in', imageBase64: PNG_BASE64, ...OFFICE, accuracy: 10 } });
    expect(selfie.status).toBe(403);
    expect(selfie.body.details.reason).toBe('CHECKIN_METHOD_NOT_ALLOWED');
    await h.admin.deleteFrom('attendanceRuleSets').where('id', '=', POLICY).execute();
  });
});
