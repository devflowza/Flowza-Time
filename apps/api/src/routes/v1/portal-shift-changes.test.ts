import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY_SECTIONS } from '@flowza/contracts';
import { loadDailyInputs, withContext } from '@flowza/database';
import { calculateDailyRecord } from '@flowza/domain';
import { addDays } from '@flowza/shared';
import { isoDate, isoDateOrNull } from '../../lib/mappers.js';
import { auditRows, createApiHarness, isoTodayIn, queueJobs, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../test/features-harness.js';

/*
 * Shift change requests (Enterprise, module shift_requests — docs/enterprise/plan.md §6/§7/§9): the module gate, the
 * employee's options / filing / withdrawal, the approval through the engine (CHANGE → employee assignments split around the
 * range; ADDITIONAL → an additional shift the engine input folds into a double-shift day), the HR / manager list and its RLS
 * scope, and the regularisation limits of the attendance policy.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
const TZ = 'Asia/Muscat';
const day = (n: number) => isoTodayIn(TZ, n);

let h: ApiHarness; let f: OrgFixture; let off: OrgFixture; let basic: OrgFixture;
let MORN: string; let DAY: string; let EVE: string; let FLEX: string; let OLD: string;
let e4: string; let emp2User: string; let teamLead: string;

const base = (org: OrgFixture = f) => `/api/v1/orgs/${org.orgId}`;
const file = (body: Record<string, unknown>, token = f.employeeUser, org: OrgFixture = f) => h.request('POST', `${base(org)}/me/shift-changes`, { token, body: { reason: 'Family commitments', ...body } });
const requestOf = async (entityId: string) => (await h.admin.selectFrom('approvalRequests').selectAll().where('entityId', '=', entityId).orderBy('createdAt', 'desc').execute())[0]!;
const decide = (requestId: string, token: string, decision: 'APPROVE' | 'REJECT' = 'APPROVE', comment?: string) =>
  h.request('POST', `${base()}/approvals/${requestId}/decide`, { token, body: { stepNo: 1, decision, ...(comment ? { comment } : {}) } });
const span = (r: { effectiveFrom: Date | string; effectiveTo: Date | string | null }) => `${isoDate(r.effectiveFrom)}→${isoDateOrNull(r.effectiveTo) ?? '∞'}`;
async function employeeAssignments(employeeId: string) {
  const rows = await h.admin.selectFrom('shiftAssignments').selectAll().where('organizationId', '=', f.orgId).where('targetType', '=', 'EMPLOYEE').where('targetId', '=', employeeId).orderBy('effectiveFrom').execute();
  return rows.map((r) => `${span(r)}:${r.shiftId === MORN ? 'MORN' : r.shiftId === DAY ? 'DAY' : r.shiftId === EVE ? 'EVE' : '?'}`);
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_shift_changes_${process.pid}`);
  f = await seedOrg(h.admin, 'shiftchg', { modules: ['shift_requests', 'advanced_scheduling'] });
  off = await seedOrg(h.admin, 'shiftchg-off');
  basic = await seedOrg(h.admin, 'shiftchg-basic', { modules: ['shift_requests'] });
  const shifts = await h.admin.insertInto('shifts').values([
    { organizationId: f.orgId, code: 'MORN', name: 'Morning', type: 'FIXED', startTime: '06:00', endTime: '14:00' },
    { organizationId: f.orgId, code: 'DAY', name: 'Day', type: 'FIXED', startTime: '08:00', endTime: '16:00' },
    { organizationId: f.orgId, code: 'EVE', name: 'Evening', type: 'FIXED', startTime: '18:00', endTime: '22:00' },
    { organizationId: f.orgId, code: 'FLEX', name: 'Flexible', type: 'FLEXIBLE', requiredMinutes: 480 },
    { organizationId: f.orgId, code: 'OLD', name: 'Retired', type: 'FIXED', startTime: '07:00', endTime: '15:00', status: 'inactive' },
  ]).returning(['id', 'code']).execute();
  const id = (code: string) => shifts.find((s) => s.code === code)!.id;
  MORN = id('MORN'); DAY = id('DAY'); EVE = id('EVE'); FLEX = id('FLEX'); OLD = id('OLD');
  // e2 (branch B) reports to e4, whose login holds the plain manager role (attendance.view_team, no organisation-wide view)
  e4 = await seedEmployee(h.admin, f.orgId, f.branchB, 4);
  await h.admin.updateTable('employees').set({ managerEmployeeId: e4 }).where('id', '=', f.e2).execute();
  emp2User = uuid('c'); teamLead = uuid('c');
  await seedUser(h.admin, emp2User, 'emp2-shiftchg@test.local', 'Employee Two');
  await seedUser(h.admin, teamLead, 'lead-shiftchg@test.local', 'Team lead');
  await seedMembership(h.admin, f.orgId, emp2User, ROLE.employee, { employeeId: f.e2 });
  await seedMembership(h.admin, f.orgId, teamLead, ROLE.manager, { employeeId: e4 });
  await h.admin.insertInto('shiftAssignments').values([
    { organizationId: f.orgId, targetType: 'EMPLOYEE', targetId: f.e1, branchId: f.branchA, shiftId: MORN, effectiveFrom: '2026-01-01' },
    { organizationId: f.orgId, targetType: 'EMPLOYEE', targetId: f.e2, branchId: f.branchB, shiftId: MORN, effectiveFrom: '2026-01-01' },
  ]).execute();
  const basicShifts = await h.admin.insertInto('shifts').values([
    { organizationId: basic.orgId, code: 'MORN', name: 'Morning', type: 'FIXED', startTime: '06:00', endTime: '14:00' },
    { organizationId: basic.orgId, code: 'EVE', name: 'Evening', type: 'FIXED', startTime: '18:00', endTime: '22:00' },
  ]).returning(['id', 'code']).execute();
  await h.admin.insertInto('shiftAssignments').values({ organizationId: basic.orgId, targetType: 'EMPLOYEE', targetId: basic.e1, branchId: basic.branchA, shiftId: basicShifts.find((s) => s.code === 'MORN')!.id, effectiveFrom: '2026-01-01' }).execute();
});
afterAll(async () => { await h?.close(); });

describe('module gate', () => {
  it('shift_requests off: the change and swap endpoints and the HR list answer 403 FEATURE_DISABLED', async () => {
    for (const [method, path, token] of [
      ['GET', '/me/shift-changes', off.employeeUser], ['GET', `/me/shift-changes/options?date=${day(5)}`, off.employeeUser], ['POST', '/me/shift-changes', off.employeeUser],
      ['GET', '/me/shift-swaps', off.employeeUser], ['POST', '/me/shift-swaps', off.employeeUser], ['GET', '/shift-change-requests', off.hrAdmin],
    ] as const) {
      const r = await h.request(method, `${base(off)}${path}`, { token, body: method === 'POST' ? {} : undefined });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ code: 'FEATURE_DISABLED', details: { reason: 'MODULE_DISABLED', module: 'shift_requests' } });
    }
  });

  it('an ADDITIONAL (double) shift also needs advanced_scheduling; a CHANGE does not', async () => {
    const eve = (await h.admin.selectFrom('shifts').select('id').where('organizationId', '=', basic.orgId).where('code', '=', 'EVE').executeTakeFirstOrThrow()).id;
    const additional = await file({ kind: 'ADDITIONAL', fromDate: day(10), toDate: day(12), shiftId: eve }, basic.employeeUser, basic);
    expect(additional.status).toBe(403);
    expect(additional.body).toMatchObject({ code: 'FEATURE_DISABLED', details: { module: 'advanced_scheduling' } });
    const change = await file({ kind: 'CHANGE', fromDate: day(10), toDate: day(12), shiftId: eve }, basic.employeeUser, basic);
    expect(change.status).toBe(201);
  });
});

describe('options', () => {
  it('lists the active shifts and the shift the employee works on the date', async () => {
    const r = await h.request('GET', `${base()}/me/shift-changes/options?date=${day(10)}`, { token: f.employeeUser });
    expect(r.status).toBe(200);
    expect(r.body.data.shifts.map((s: { code: string }) => s.code).sort()).toEqual(['DAY', 'EVE', 'FLEX', 'MORN']);
    expect(r.body.data.shifts.find((s: { code: string }) => s.code === 'DAY')).toMatchObject({ id: DAY, type: 'FIXED', startTime: '08:00', endTime: '16:00', crossesMidnight: false });
    expect(r.body.data.current).toMatchObject({ date: day(10), shift: { id: MORN }, source: 'ASSIGNMENT' });
    // the caller is their own employee record: an account without one cannot ask
    expect((await h.request('GET', `${base()}/me/shift-changes/options?date=${day(10)}`, { token: f.hrAdmin })).status).toBe(403);
    expect((await h.request('GET', `${base()}/me/shift-changes/options`, { token: f.employeeUser })).status).toBe(400);
  });
});

describe('validations', () => {
  it('refuses past, too distant, too long and inverted ranges', async () => {
    expect((await file({ fromDate: day(-1), toDate: day(1), shiftId: DAY })).status).toBe(400);
    expect((await file({ fromDate: day(181), toDate: day(183), shiftId: DAY })).status).toBe(400);
    const tooLong = await file({ fromDate: day(10), toDate: day(10 + 92), shiftId: DAY });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.message).toMatch(/at most 92 days/);
    expect((await file({ fromDate: day(12), toDate: day(10), shiftId: DAY })).status).toBe(400);
    // a day that does not exist, and an absurd last day, are refused before any date arithmetic
    expect((await file({ fromDate: '2026-02-30', toDate: '2026-03-01', shiftId: DAY })).body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'This date does not exist.' });
    expect((await file({ fromDate: day(10), toDate: '9999-12-31', shiftId: DAY })).status).toBe(400);
    expect((await h.request('GET', `${base()}/me/shift-changes/options?date=2026-13-01`, { token: f.employeeUser })).status).toBe(400);
  });

  it('refuses an inactive or unknown shift and a change to the shift already worked', async () => {
    expect((await file({ fromDate: day(10), toDate: day(12), shiftId: OLD })).body).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/active shift/) });
    expect((await file({ fromDate: day(10), toDate: day(12), shiftId: uuid('f') })).status).toBe(400);
    const same = await file({ fromDate: day(10), toDate: day(12), shiftId: MORN });
    expect(same.status).toBe(400);
    expect(same.body.message).toMatch(/already work this shift/);
  });

  it('an additional shift must be fixed and combine with the shift of every working day', async () => {
    const flexible = await file({ kind: 'ADDITIONAL', fromDate: day(10), toDate: day(12), shiftId: FLEX });
    expect(flexible.status).toBe(400);
    expect(flexible.body.message).toMatch(/fixed shift/);
    // Day 08:00–16:00 overlaps Morning 06:00–14:00
    const overlap = await file({ kind: 'ADDITIONAL', fromDate: day(10), toDate: day(12), shiftId: DAY });
    expect(overlap.status).toBe(400);
    expect(overlap.body.details).toMatchObject({ reason: 'DOUBLE_SHIFT_CONFLICT', conflicts: expect.arrayContaining([expect.objectContaining({ reason: 'OVERLAP' })]) });
    expect(overlap.body.message).toMatch(/the two shifts overlap/);
  });

  it('refuses a range inside a locked attendance period', async () => {
    const lock = await h.admin.insertInto('attendancePeriodLocks').values({ organizationId: f.orgId, branchId: f.branchA, periodStart: day(60), periodEnd: day(62), reason: 'test' }).returning('id').executeTakeFirstOrThrow();
    const r = await file({ fromDate: day(59), toDate: day(61), shiftId: DAY });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PERIOD_LOCKED');
    await h.admin.deleteFrom('attendancePeriodLocks').where('id', '=', lock.id).execute();
  });
});

describe('CHANGE: filing and approval', () => {
  const A = () => day(10); const B = () => day(12);
  let changeId: string; let requestId: string;

  it('files a change routed to the line manager', async () => {
    const r = await file({ kind: 'CHANGE', fromDate: A(), toDate: B(), shiftId: DAY, reason: 'Childcare in the early mornings' });
    expect(r.status).toBe(201);
    changeId = r.body.data.id;
    expect(r.body.data).toMatchObject({
      kind: 'CHANGE', status: 'pending', fromDate: A(), toDate: B(), employeeId: f.e1, employeeName: 'Employee 1', branchId: f.branchA, mine: true, approvalStatus: 'PENDING',
      requestedShift: { id: DAY, code: 'DAY', name: 'Day', startTime: '08:00', endTime: '16:00' }, currentShift: { id: MORN, name: 'Morning' }, appliedAssignmentIds: [],
    });
    const req = await requestOf(changeId);
    requestId = req.id;
    expect(req).toMatchObject({ entityType: 'SHIFT_CHANGE', status: 'PENDING', workflowId: null, employeeId: f.e1 });
    expect(Number(req.units)).toBe(3); // workflow tiers compare the number of days
    const actors = await h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select(['a.userId', 's.approverType', 's.resolutionPath']).where('s.requestId', '=', req.id).execute();
    expect(actors).toEqual([{ userId: f.managerUser, approverType: 'MANAGER', resolutionPath: 'primary' }]);
    expect((await auditRows(h.admin, 'shift.change_requested')).some((a) => a.entityId === changeId)).toBe(true);
  });

  it('a pending request of the same kind on any of the same days is a conflict', async () => {
    const r = await file({ kind: 'CHANGE', fromDate: B(), toDate: day(14), shiftId: EVE });
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ reason: 'PENDING_OVERLAP', shiftChangeRequestId: changeId });
  });

  it('the inbox shows the change; the requester never decides it', async () => {
    const detail = await h.request('GET', `${base()}/approvals/${requestId}`, { token: f.managerUser });
    expect(detail.status).toBe(200);
    expect(detail.body.data.context).toMatchObject({ kind: 'SHIFT_CHANGE', change: { id: changeId, kind: 'CHANGE', fromDate: A(), toDate: B(), employeeName: 'Employee 1', requestedShiftName: 'Day', currentShiftName: 'Morning', reason: 'Childcare in the early mornings', status: 'pending' } });
    expect(detail.body.data.context.summary).toContain('Morning → Day');
    expect((await decide(requestId, f.employeeUser)).status).toBe(403);
  });

  it('approval writes one assignment for the range and splits the one that covered it', async () => {
    const r = await decide(requestId, f.managerUser);
    expect(r.status).toBe(200);
    const row = await h.admin.selectFrom('shiftChangeRequests').selectAll().where('id', '=', changeId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'approved', decidedBy: f.managerUser });
    expect(row.appliedAssignmentIds).toHaveLength(1);
    expect(await employeeAssignments(f.e1)).toEqual([`2026-01-01→${A()}:MORN`, `${A()}→${addDays(B(), 1)}:DAY`, `${addDays(B(), 1)}→∞:MORN`]);
    const applied = await h.admin.selectFrom('shiftAssignments').select('id').where('targetId', '=', f.e1).where('shiftId', '=', DAY).executeTakeFirstOrThrow();
    expect(row.appliedAssignmentIds).toEqual([applied.id]);
    const resolve = async (date: string) => (await h.request('GET', `${base()}/shifts/resolve?employeeId=${f.e1}&date=${date}`, { token: f.hrAdmin })).body.data.shift?.id;
    expect(await resolve(day(11))).toBe(DAY);
    expect(await resolve(B())).toBe(DAY);
    expect(await resolve(day(9))).toBe(MORN);
    expect(await resolve(day(13))).toBe(MORN);
    expect((await auditRows(h.admin, 'shift.change_applied')).find((a) => a.entityId === changeId)?.newValue).toMatchObject({ kind: 'CHANGE', appliedAssignmentIds: [applied.id] });
    const mine = await h.request('GET', `${base()}/me/shift-changes`, { token: f.employeeUser });
    expect(mine.body.data.find((x: { id: string }) => x.id === changeId)).toMatchObject({ status: 'approved', approvalStatus: 'APPROVED' });
    const tab = await h.request('GET', `${base()}/me/shift`, { token: f.employeeUser });
    expect(tab.body.data.upcoming.find((x: { date: string }) => x.date === day(11))).toMatchObject({ shift: { id: DAY } });
    // future days are calculated when they come
    expect((await queueJobs(h.admin, 'RECOMPUTE_DAILY')).filter((j) => j.payload['employeeId'] === f.e1 && j.payload['reason'] === 'SHIFT_CHANGE')).toEqual([]);
  });

  it('a change starting today recomputes today at once', async () => {
    const r = await file({ kind: 'CHANGE', fromDate: day(0), toDate: day(2), shiftId: EVE });
    expect(r.status).toBe(201);
    expect((await decide((await requestOf(r.body.data.id)).id, f.managerUser)).status).toBe(200);
    const jobs = (await queueJobs(h.admin, 'RECOMPUTE_DAILY')).filter((j) => j.payload['employeeId'] === f.e1 && j.payload['reason'] === 'SHIFT_CHANGE');
    expect(jobs.map((j) => j.payload['date'])).toEqual([day(0)]);
  });
});

describe('ADDITIONAL: a double shift', () => {
  it('files, approves, and the engine input folds the additional shift into a DOUBLE_SHIFT day', async () => {
    const C = day(20); const D = day(22);
    const r = await file({ kind: 'ADDITIONAL', fromDate: C, toDate: D, shiftId: EVE });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ kind: 'ADDITIONAL', requestedShift: { id: EVE }, currentShift: { id: MORN } });
    // a CHANGE and an ADDITIONAL may wait side by side; the inbox summary says what is added
    const req = await requestOf(r.body.data.id);
    expect((await h.request('GET', `${base()}/approvals/${req.id}`, { token: f.managerUser })).body.data.context.summary).toContain('+ Evening');
    expect((await decide(req.id, f.managerUser)).status).toBe(200);
    const rows = await h.admin.selectFrom('additionalShiftAssignments').selectAll().where('employeeId', '=', f.e1).execute();
    expect(rows.map((x) => ({ span: span(x), shiftId: x.shiftId, shiftChangeRequestId: x.shiftChangeRequestId }))).toEqual([{ span: `${C}→${addDays(D, 1)}`, shiftId: EVE, shiftChangeRequestId: r.body.data.id }]);
    const loaded = await withContext(h.deps.db, { kind: 'system', organizationId: f.orgId }, (trx) => loadDailyInputs(trx, f.orgId, f.e1, day(21), new Date()));
    expect(loaded?.additionalShiftId).toBe(EVE);
    expect(loaded?.input.shift).toMatchObject({ id: MORN, startTime: '06:00', endTime: '22:00', segments: [expect.objectContaining({ shiftId: MORN }), expect.objectContaining({ shiftId: EVE })] });
    expect(calculateDailyRecord(loaded!.input).flags).toContain('DOUBLE_SHIFT');
  });
});

describe('withdrawal', () => {
  it('only the requester withdraws a pending request; the approval request is cancelled with it', async () => {
    const r = await file({ fromDate: day(30), toDate: day(32), shiftId: DAY });
    expect(r.status).toBe(201);
    const id = r.body.data.id as string;
    expect((await h.request('POST', `${base()}/me/shift-changes/${id}/cancel`, { token: emp2User })).status).toBe(404);
    const c = await h.request('POST', `${base()}/me/shift-changes/${id}/cancel`, { token: f.employeeUser, body: { reason: 'Plans changed' } });
    expect(c.status).toBe(200);
    expect(c.body.data).toMatchObject({ status: 'cancelled', decisionNote: 'Plans changed', approvalStatus: 'CANCELLED' });
    expect((await requestOf(id)).status).toBe('CANCELLED');
    expect((await auditRows(h.admin, 'shift.change_withdrawn')).some((a) => a.entityId === id)).toBe(true);
    expect((await h.request('POST', `${base()}/me/shift-changes/${id}/cancel`, { token: f.employeeUser })).status).toBe(409);
    // the days are free again
    expect((await file({ fromDate: day(31), toDate: day(33), shiftId: DAY })).status).toBe(201);
  });

  it('a rejection by the manager closes the request without touching the schedule', async () => {
    const r = await file({ fromDate: day(50), toDate: day(52), shiftId: EVE });
    const req = await requestOf(r.body.data.id);
    expect((await decide(req.id, f.managerUser, 'REJECT', 'Not enough cover on evenings')).status).toBe(200);
    const row = await h.admin.selectFrom('shiftChangeRequests').selectAll().where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'rejected', decisionNote: 'Not enough cover on evenings', appliedAssignmentIds: [] });
    expect((await h.request('GET', `${base()}/shifts/resolve?employeeId=${f.e1}&date=${day(51)}`, { token: f.hrAdmin })).body.data.shift.id).toBe(MORN);
  });
});

describe('approval re-validation', () => {
  it('a shift deactivated since the request refuses the approval (409) and the request stays open', async () => {
    const r = await file({ fromDate: day(80), toDate: day(82), shiftId: FLEX });
    expect(r.status).toBe(201);
    const req = await requestOf(r.body.data.id);
    await h.admin.updateTable('shifts').set({ status: 'inactive' }).where('id', '=', FLEX).execute();
    const refused = await decide(req.id, f.managerUser);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'SHIFT_INACTIVE' } });
    expect((await requestOf(r.body.data.id)).status).toBe('PENDING');
    expect((await h.admin.selectFrom('shiftChangeRequests').select('status').where('id', '=', r.body.data.id).executeTakeFirstOrThrow()).status).toBe('pending');
    await h.admin.updateTable('shifts').set({ status: 'active' }).where('id', '=', FLEX).execute();
    expect((await decide(req.id, f.managerUser)).status).toBe(200);
    expect((await h.request('GET', `${base()}/shifts/resolve?employeeId=${f.e1}&date=${day(81)}`, { token: f.hrAdmin })).body.data.shift.id).toBe(FLEX);
  });

  it('an employee no longer employed on the first day: the system rejects the request', async () => {
    const r = await file({ fromDate: day(70), toDate: day(72), shiftId: DAY }, emp2User);
    expect(r.status).toBe(201);
    const req = await requestOf(r.body.data.id);
    await h.admin.updateTable('employees').set({ exitDate: day(65) }).where('id', '=', f.e2).execute();
    try {
      const refused = await decide(req.id, teamLead);
      expect(refused.status).toBe(409);
      expect(refused.body.details).toMatchObject({ reason: 'SYSTEM_REJECTED', status: 'REJECTED' });
      const row = await h.admin.selectFrom('shiftChangeRequests').selectAll().where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ status: 'rejected', decidedBy: null, appliedAssignmentIds: [] });
      expect(row.decisionNote).toMatch(/no longer employed on/);
    } finally {
      await h.admin.updateTable('employees').set({ exitDate: null }).where('id', '=', f.e2).execute();
    }
  });
});

describe('shift swaps in the range', () => {
  const swapOn = (date: string) => h.admin.insertInto('shiftSwapRequests').values({ organizationId: f.orgId, requesterEmployeeId: f.e1, targetEmployeeId: f.e3, branchId: f.branchA, swapDate: date, requesterShiftId: MORN, targetShiftId: DAY, reason: 'Swap fixture', status: 'approved' }).returning('id').executeTakeFirstOrThrow();

  it('a change over a swapped day is refused when filed', async () => {
    const swap = await swapOn(day(90));
    const r = await file({ fromDate: day(89), toDate: day(91), shiftId: DAY });
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ reason: 'SWAP_IN_RANGE', swapId: swap.id, date: day(90) });
    // an additional shift does not replace the swapped shift: it is not concerned
    expect((await file({ kind: 'ADDITIONAL', fromDate: day(89), toDate: day(91), shiftId: EVE })).status).toBe(201);
  });

  it('a swap approved after the change was filed refuses the approval (409) and the request stays open', async () => {
    const r = await file({ fromDate: day(100), toDate: day(102), shiftId: DAY });
    expect(r.status).toBe(201);
    await swapOn(day(101));
    const req = await requestOf(r.body.data.id);
    const refused = await decide(req.id, f.managerUser);
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({ reason: 'SWAP_IN_RANGE', date: day(101) });
    expect((await requestOf(r.body.data.id)).status).toBe('PENDING');
  });
});

describe('HR / manager list', () => {
  let e2Change: string;
  beforeAll(async () => {
    const r = await file({ fromDate: day(40), toDate: day(42), shiftId: DAY }, emp2User);
    expect(r.status).toBe(201);
    e2Change = r.body.data.id;
  });

  it('HR sees every branch and filters by status, kind, employee and dates', async () => {
    const all = await h.request('GET', `${base()}/shift-change-requests?pageSize=100`, { token: f.hrAdmin });
    expect(all.status).toBe(200);
    expect(new Set(all.body.data.map((x: { employeeId: string }) => x.employeeId))).toEqual(new Set([f.e1, f.e2]));
    expect(all.body.meta.total).toBe(all.body.data.length);
    // waiting requests come first
    const firstNonPending = all.body.data.findIndex((x: { status: string }) => x.status !== 'pending');
    expect(all.body.data.slice(firstNonPending).every((x: { status: string }) => x.status !== 'pending')).toBe(true);
    const pending = await h.request('GET', `${base()}/shift-change-requests?status=pending`, { token: f.hrAdmin });
    expect(pending.body.data.every((x: { status: string }) => x.status === 'pending')).toBe(true);
    const additional = await h.request('GET', `${base()}/shift-change-requests?kind=ADDITIONAL`, { token: f.hrAdmin });
    expect(additional.body.data.length).toBeGreaterThan(0);
    expect(additional.body.data.every((x: { kind: string }) => x.kind === 'ADDITIONAL')).toBe(true);
    const byEmployee = await h.request('GET', `${base()}/shift-change-requests?employeeId=${f.e2}&status=pending`, { token: f.hrAdmin });
    expect(byEmployee.body.data.map((x: { id: string }) => x.id)).toEqual([e2Change]);
    const byDates = await h.request('GET', `${base()}/shift-change-requests?from=${day(41)}&to=${day(45)}`, { token: f.hrAdmin });
    expect(byDates.body.data.map((x: { id: string }) => x.id)).toEqual([e2Change]);
    expect(byDates.body.data[0]).toMatchObject({ employeeName: 'Employee 2', mine: false, requestedShift: { id: DAY } });
  });

  it('a branch-scoped user sees their branch only; a line manager their team only; an employee no list', async () => {
    const scoped = await h.request('GET', `${base()}/shift-change-requests?pageSize=100`, { token: f.branchManagerB });
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.length).toBeGreaterThan(0);
    expect(scoped.body.data.every((x: { employeeId: string; branchId: string }) => x.employeeId === f.e2 && x.branchId === f.branchB)).toBe(true);
    expect(scoped.body.data.map((x: { id: string }) => x.id)).toContain(e2Change);
    expect((await h.request('GET', `${base()}/shift-change-requests?branchId=${f.branchA}`, { token: f.branchManagerB })).status).toBe(403);
    const team = await h.request('GET', `${base()}/shift-change-requests?pageSize=100`, { token: teamLead });
    expect(team.status).toBe(200);
    expect(team.body.data.every((x: { employeeId: string }) => x.employeeId === f.e2)).toBe(true);
    expect(team.body.data.map((x: { id: string }) => x.id)).toContain(e2Change);
    expect((await h.request('GET', `${base()}/shift-change-requests`, { token: f.employeeUser })).status).toBe(403);
    // e2's line manager decides it (the seat of the reporting line)
    const req = await requestOf(e2Change);
    const actors = await h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select('a.userId').where('s.requestId', '=', req.id).execute();
    expect(actors.map((a) => a.userId)).toEqual([teamLead]);
  });
});

describe('regularisation limits from the attendance policy', () => {
  let policyId: string;
  const regularise = (date: string) => h.request('POST', `${base()}/me/regularisations`, { token: f.employeeUser, body: { date, type: 'wfh_unmarked', reason: 'Worked from home, not marked' } });
  const setLimits = (regularisation: { maxPerMonth: number | null; backdateDays: number | null }) =>
    h.admin.updateTable('attendanceRuleSets').set({ policy: JSON.stringify({ ...DEFAULT_POLICY_SECTIONS, regularisation }) }).where('id', '=', policyId).execute();
  beforeAll(async () => {
    // a stored organisation policy applies whatever the module state (attendance_policies is off for this organisation)
    policyId = (await h.admin.insertInto('attendanceRuleSets').values({ organizationId: f.orgId, name: 'Company policy', effectiveFrom: '2020-01-01', ramadanMode: JSON.stringify({}), policy: JSON.stringify(DEFAULT_POLICY_SECTIONS) }).returning('id').executeTakeFirstOrThrow()).id;
  });

  it('a day further back than the policy allows is refused', async () => {
    await setLimits({ maxPerMonth: null, backdateDays: 5 });
    const old = await regularise(day(-10));
    expect(old.status).toBe(400);
    expect(old.body).toMatchObject({ code: 'VALIDATION_ERROR', details: { reason: 'REGULARISATION_TOO_OLD', backdateDays: 5 } });
    expect(old.body.message).toMatch(/at most 5 day/);
    expect((await regularise(day(-1))).status).toBe(201);
  });

  it('the monthly limit counts the month of the regularised day, cancelled requests excluded', async () => {
    await setLimits({ maxPerMonth: 1, backdateDays: null });
    // two months back: no other regularisation of this suite falls in that month
    const monthStart = DateTime.fromISO(day(0), { zone: 'utc' }).minus({ months: 2 }).startOf('month').toISODate()!;
    const first = await regularise(monthStart);
    expect(first.status).toBe(201);
    const second = await regularise(addDays(monthStart, 1));
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ details: { reason: 'REGULARISATION_LIMIT', maxPerMonth: 1, used: 1 } });
    expect((await h.request('POST', `${base()}/me/regularisations/${first.body.data.id}/cancel`, { token: f.employeeUser })).status).toBe(200);
    expect((await regularise(addDays(monthStart, 1))).status).toBe(201);
  });

  it('a day that does not exist is a validation error, not a server error', async () => {
    expect((await regularise('2026-02-30')).body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'This date does not exist.' });
  });

  it('without limits in the policy nothing changes', async () => {
    await setLimits({ maxPerMonth: null, backdateDays: null });
    expect((await regularise(day(-20))).status).toBe(201);
  });
});
