/**
 * Leave v2 (HR portal Prompt 7): leave type policy, the request validation matrix (errors vs warnings), stored days, the
 * half-day aware overlap rule, edit + resubmit, withdraw with a reason, the info-request loop, post-decision corrections,
 * locked periods, allocations / balances / CSV / year close, comp-off (request → approve → redeem → release), the comment
 * thread, the team views, the review fixes assigned from the Prompt 2 review (P1-2, P1-3, P1-4, P2-4) and the backward
 * compatibility of every leave call the current web makes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditRows, createApiHarness, domainEvents, isoToday, queueJobs, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
// e4 is a line manager (manager role, no leave.manage); e5 reports to e4 (female); e6 joins mid-year
let e4: string; let e5: string; let e6: string;
const lineMgr = uuid('c'); const staff5 = uuid('c'); const viewer = uuid('c');
const T: Record<string, string> = {};
const base = () => `/api/v1/orgs/${f.orgId}`;

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_leave2_${process.pid}`);
  f = await seedOrg(h.admin, 'lv2');
  e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4, { departmentId: f.departmentA });
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5, { managerEmployeeId: e4, departmentId: f.departmentA });
  e6 = await seedEmployee(h.admin, f.orgId, f.branchA, 6);
  await h.admin.updateTable('employees').set({ gender: 'female' }).where('id', '=', e5).execute();
  await h.admin.updateTable('employees').set({ gender: 'male' }).where('id', '=', f.e1).execute();
  await h.admin.updateTable('employees').set({ joiningDate: '2026-07-01' }).where('id', '=', e6).execute();
  await seedUser(h.admin, lineMgr, 'line-mgr-lv2@test.local', 'Line Manager');
  await seedUser(h.admin, staff5, 'staff5-lv2@test.local', 'Staff Five');
  await seedUser(h.admin, viewer, 'viewer-lv2@test.local', 'Leave Viewer');
  await seedMembership(h.admin, f.orgId, lineMgr, ROLE.manager, { employeeId: e4 });
  await seedMembership(h.admin, f.orgId, staff5, ROLE.employee, { employeeId: e5 });
  // a custom role that reads leave organisation-wide but may not export
  const role = await h.request('POST', `/api/v1/orgs/${f.orgId}/roles`, { token: f.owner, body: { key: 'leave_viewer', name: 'Leave viewer', permissions: ['leave.view'] } });
  expect(role.status).toBe(201);
  await seedMembership(h.admin, f.orgId, viewer, role.body.data.id);
  const types: Array<[string, Record<string, unknown>]> = [
    ['AL', { name: 'Annual Leave', annualAllowanceDays: 20, advanceNoticeDays: 7, maxConsecutiveDays: 10, carryForwardMaxDays: 5, carryForwardExpiryMonths: 3 }],
    ['ML', { name: 'Maternity Leave', annualAllowanceDays: 98, applicableGender: 'female' }],
    ['NH', { name: 'No Half Days', allowHalfDay: false }],
    ['RW', { name: 'Remote Work', requiresApproval: false, treatAsPresent: true }],
    ['CA', { name: 'Calendar Days', countMode: 'calendar', annualAllowanceDays: 10 }],
    ['SM', { name: 'Small', annualAllowanceDays: 1 }],
    ['CL', { name: 'Casual Leave', annualAllowanceDays: 12 }],
    ['HO', { name: 'HR only', portalVisible: false }],
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
let weekOffset = 4;
/** A fresh future range per request so nothing overlaps: starts on a Sunday weeks ahead (week Sun–Thu, Fri + Sat off), `days` working days (≤ 5). */
function nextRange(days = 1) {
  weekOffset += 1;
  const d = new Date(); d.setUTCDate(d.getUTCDate() + weekOffset * 7 - d.getUTCDay());
  const start = d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + days - 1);
  return { startDate: start, endDate: d.toISOString().slice(0, 10) };
}
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** The most recent date with this weekday (0=Sun..6=Sat) at least `minBack` days ago. */
function pastWeekday(dow: number, minBack = 7) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - minBack);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
async function applyAs(token: string, body: Record<string, unknown>) {
  return h.request('POST', `${base()}/me/leave`, { token, body: { reason: 'Family matters', ...body } });
}
async function leaveRow(id: string) { return h.admin.selectFrom('leaveRecords').selectAll().where('id', '=', id).executeTakeFirstOrThrow(); }
async function requestRow(id: string) { return h.admin.selectFrom('approvalRequests').selectAll().where('id', '=', id).executeTakeFirstOrThrow(); }
const codes = (body: { details?: { issues?: Array<{ code?: string }> } }) => (body.details?.issues ?? []).map((i) => i.code);

describe('leave types v2', () => {
  it('stores the policy of a type and returns it with the pre-v2 fields', async () => {
    const r = await h.request('GET', `${base()}/leave-types`, { token: f.hrUser });
    expect(r.status).toBe(200);
    const al = r.body.data.find((t: { code: string }) => t.code === 'AL');
    // backward compatibility: every field of the pre-v2 list is still there, unchanged
    for (const k of ['id', 'code', 'name', 'nameAr', 'isPaid', 'treatAsPresent', 'color', 'annualAllowanceDays', 'status', 'createdAt']) expect(al).toHaveProperty(k);
    expect(al).toMatchObject({ annualAllowanceDays: 20, advanceNoticeDays: 7, maxConsecutiveDays: 10, carryForwardMaxDays: 5, carryForwardExpiryMonths: 3, requiresApproval: true, countMode: 'working', applicableGender: 'all', allowHalfDay: true, portalVisible: true, compOff: false });
    // a PATCH of one field leaves the policy alone (update schema without defaults)
    const p = await h.request('PATCH', `${base()}/leave-types/${T['AL']}`, { token: f.hrAdmin, body: { color: '#175cd3' } });
    expect(p.body.data).toMatchObject({ advanceNoticeDays: 7, maxConsecutiveDays: 10, carryForwardMaxDays: 5 });
    expect((await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'BAD', name: 'Bad', carryForwardMaxDays: 2.25 } })).status).toBe(400);
  });

  it('keeps the comp-off type system-managed', async () => {
    const co = (await h.request('GET', `${base()}/leave-types`, { token: f.hrUser })).body.data.find((t: { id: string }) => t.id === T['CO']);
    expect(co).toMatchObject({ compOff: true, portalVisible: false, isSpecial: true, systemKey: 'COMP_OFF', status: 'active', annualAllowanceDays: null });
    expect((await h.request('PATCH', `${base()}/leave-types/${T['CO']}`, { token: f.hrAdmin, body: { status: 'inactive' } })).status).toBe(400);
    expect((await h.request('PATCH', `${base()}/leave-types/${T['CO']}`, { token: f.hrAdmin, body: { annualAllowanceDays: 5 } })).status).toBe(400);
    expect((await h.request('PATCH', `${base()}/leave-types/${T['CO']}`, { token: f.hrAdmin, body: { name: 'Compensatory Off (TOIL)' } })).status).toBe(200);
    expect((await h.request('DELETE', `${base()}/leave-types/${T['CO']}`, { token: f.hrAdmin })).status).toBe(409);
    // seeding again never creates a second one
    await h.request('POST', `${base()}/leave-types/seed-defaults`, { token: f.hrAdmin });
    expect((await h.admin.selectFrom('leaveTypes').select('id').where('organizationId', '=', f.orgId).where('systemKey', '=', 'COMP_OFF').execute()).length).toBe(1);
  });
});

describe('request validation matrix', () => {
  it('refuses a type that does not apply to the employee (gender)', async () => {
    const r = await applyAs(f.employeeUser, { leaveTypeId: T['ML'], ...nextRange(2) });
    expect(r.status).toBe(400);
    expect(codes(r.body)).toContain('NOT_APPLICABLE');
    expect((await applyAs(staff5, { leaveTypeId: T['ML'], ...nextRange(2) })).status).toBe(201);
  });

  it('refuses a half day on a type that does not allow it, and a range of weekly off days only', async () => {
    const d = nextRange(1).startDate;
    const half = await applyAs(f.employeeUser, { leaveTypeId: T['NH'], startDate: d, endDate: d, isHalfDay: true, halfDayPart: 'FIRST_HALF' });
    expect(half.status).toBe(400);
    expect(codes(half.body)).toContain('HALF_DAY_NOT_ALLOWED');
    const friday = addDays(nextRange(1).startDate, 5);
    const weekend = await applyAs(f.employeeUser, { leaveTypeId: T['CL'], startDate: friday, endDate: addDays(friday, 1) });
    expect(weekend.status).toBe(400);
    expect(codes(weekend.body)).toContain('NO_DAYS');
  });

  it('advance notice and the consecutive cap refuse the employee but only warn HR', async () => {
    let soon = isoToday(1);
    while ([5, 6].includes(new Date(`${soon}T00:00:00Z`).getUTCDay())) soon = addDays(soon, 1);
    const self = await applyAs(f.employeeUser, { leaveTypeId: T['AL'], startDate: soon, endDate: soon });
    expect(self.status).toBe(400);
    expect(codes(self.body)).toContain('ADVANCE_NOTICE');
    const hr = await h.request('POST', `${base()}/leave-records`, { token: f.hrUser, body: { employeeId: f.e1, leaveTypeId: T['AL'], startDate: soon, endDate: soon, reason: 'Recorded late' } });
    expect(hr.status).toBe(201);
    expect(hr.body.data.warnings.map((w: { code: string }) => w.code)).toContain('ADVANCE_NOTICE');
    expect(hr.body.data.days).toBe(1);
    // 12 working days against a cap of 10
    const start = nextRange(1).startDate; weekOffset += 2;
    const long = await applyAs(f.employeeUser, { leaveTypeId: T['AL'], startDate: start, endDate: addDays(start, 15) });
    expect(long.status).toBe(400);
    expect(codes(long.body)).toContain('MAX_CONSECUTIVE');
    const hrLong = await h.request('POST', `${base()}/leave-records`, { token: f.hrUser, body: { employeeId: e6, leaveTypeId: T['AL'], startDate: start, endDate: addDays(start, 15) } });
    expect(hrLong.status).toBe(201);
    expect(hrLong.body.data.days).toBe(12);
    expect(hrLong.body.data.warnings.map((w: { code: string }) => w.code)).toContain('MAX_CONSECUTIVE');
  });

  it('over the balance only warns (never blocks) and stores the days it charges', async () => {
    const r = await applyAs(f.employeeUser, { leaveTypeId: T['SM'], ...nextRange(2) });
    expect(r.status).toBe(201);
    expect(r.body.data.days).toBe(2);
    expect(r.body.data.warnings.map((w: { code: string }) => w.code)).toEqual(['OVER_BALANCE']);
    expect(Number((await leaveRow(r.body.data.id)).days)).toBe(2);
  });

  it('counts calendar days for a calendar-mode type', async () => {
    const { startDate } = nextRange(1);
    const cal = await applyAs(f.employeeUser, { leaveTypeId: T['CA'], startDate, endDate: addDays(startDate, 6) });
    expect(cal.status).toBe(201);
    expect(cal.body.data.days).toBe(7);
  });

  it('approves a type that needs no approval at once', async () => {
    const r = await applyAs(f.employeeUser, { leaveTypeId: T['RW'], ...nextRange(1) });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'APPROVED', approvalStatus: 'APPROVED' });
    expect((await leaveRow(r.body.data.id)).approvedBy).toBeNull();
  });

  it('refuses a type HR keeps for itself', async () => {
    const r = await applyAs(f.employeeUser, { leaveTypeId: T['HO'], ...nextRange(1) });
    expect(r.status).toBe(400);
    expect(codes(r.body)).toContain('NOT_REQUESTABLE');
    const types = (await h.request('GET', `${base()}/me/leave`, { token: f.employeeUser })).body.data.types.map((t: { code: string }) => t.code);
    expect(types).not.toContain('HO');
    expect(types).not.toContain('CO');
    expect(types).not.toContain('ML'); // not applicable to him
  });

  it('refuses any second leave on a date already on leave — the other half too (the engine charges one leave per date)', async () => {
    const d = nextRange(1).startDate;
    const a = await applyAs(staff5, { leaveTypeId: T['CL'], startDate: d, endDate: d, isHalfDay: true, halfDayPart: 'FIRST_HALF' });
    expect(a.status).toBe(201);
    expect(a.body.data.days).toBe(0.5);
    for (const body of [{ isHalfDay: true, halfDayPart: 'SECOND_HALF' }, { isHalfDay: true, halfDayPart: 'FIRST_HALF' }, {}]) {
      const clash = await applyAs(staff5, { leaveTypeId: T['CL'], startDate: d, endDate: d, ...body });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('CONFLICT');
    }
  });
});

describe('edit, withdraw and the info loop', () => {
  it('edits a pending request: days recomputed, the old request invalidated and a new one submitted', async () => {
    await clearWorkflows();
    const r = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(1) });
    const before = r.body.data;
    const e = await h.request('PATCH', `${base()}/me/leave/${before.id}`, { token: staff5, body: { endDate: addDays(before.startDate, 2) } });
    expect(e.status).toBe(200);
    expect(e.body.data).toMatchObject({ status: 'PENDING', days: 3, canEdit: true, canWithdraw: true });
    expect(e.body.data.approvalRequestId).not.toBe(before.approvalRequestId);
    expect((await requestRow(before.approvalRequestId)).status).toBe('INVALIDATED');
    expect((await auditRows(h.admin, 'leave.edited')).some((a) => a.entityId === before.id)).toBe(true);
    // nobody else edits it through the portal, and decided leave is not the employee's to change
    expect((await h.request('PATCH', `${base()}/me/leave/${before.id}`, { token: f.employeeUser, body: { reason: 'Mine now' } })).status).toBe(404);
  });

  it('withdraws with a reason (required on the v2 route) that reaches the approval request', async () => {
    const r = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(1) });
    expect((await h.request('POST', `${base()}/me/leave/${r.body.data.id}/withdraw`, { token: staff5, body: {} })).status).toBe(400);
    const w = await h.request('POST', `${base()}/me/leave/${r.body.data.id}/withdraw`, { token: staff5, body: { reason: 'Trip cancelled' } });
    expect(w.status).toBe(200);
    expect(w.body.data.status).toBe('CANCELLED');
    expect(w.body.data.withdrawnAt).not.toBeNull();
    expect(await requestRow(r.body.data.approvalRequestId)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Trip cancelled' });
  });

  it('refuses to withdraw approved leave — the employee is told to contact HR', async () => {
    const r = await applyAs(f.employeeUser, { leaveTypeId: T['RW'], ...nextRange(1) });
    const w = await h.request('POST', `${base()}/me/leave/${r.body.data.id}/withdraw`, { token: f.employeeUser, body: { reason: 'Changed my mind' } });
    expect(w.status).toBe(409);
    expect(w.body.message).toMatch(/Contact HR/);
  });

  it('runs the info loop: question → INFO_REQUESTED + thread, reply → PENDING, then a decision', async () => {
    await clearWorkflows();
    await workflow([{ order: 1, approverType: 'MANAGER' }]);
    const r = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(2) });
    const reqId = r.body.data.approvalRequestId;
    const ask = await h.request('POST', `${base()}/approvals/${reqId}/request-info`, { token: lineMgr, body: { comment: 'Who covers your tickets?' } });
    expect(ask.status).toBe(200);
    expect((await leaveRow(r.body.data.id)).status).toBe('INFO_REQUESTED');
    const mine = (await h.request('GET', `${base()}/me/leave?year=${r.body.data.startDate.slice(0, 4)}`, { token: staff5 })).body.data.records.find((x: { id: string }) => x.id === r.body.data.id);
    expect(mine).toMatchObject({ status: 'INFO_REQUESTED', canReply: true, infoRequest: { message: 'Who covers your tickets?', askedByName: 'Line Manager' } });
    expect((await h.request('POST', `${base()}/me/leave/${r.body.data.id}/reply`, { token: f.employeeUser, body: { body: 'Not mine' } })).status).toBe(404);
    const reply = await h.request('POST', `${base()}/me/leave/${r.body.data.id}/reply`, { token: staff5, body: { body: 'Omar covers them' } });
    expect(reply.status).toBe(200);
    expect(reply.body.data).toMatchObject({ status: 'PENDING', canReply: false });
    expect((await requestRow(reqId)).infoRequestedAt).toBeNull();
    const thread = await h.request('GET', `${base()}/leave-records/${r.body.data.id}/comments`, { token: lineMgr });
    expect(thread.body.data.map((c: { kind: string; body: string }) => [c.kind, c.body])).toEqual([['info_request', 'Who covers your tickets?'], ['reply', 'Omar covers them']]);
    // a second reply without a question is refused
    expect((await h.request('POST', `${base()}/me/leave/${r.body.data.id}/reply`, { token: staff5, body: { body: 'Again' } })).status).toBe(409);
    const ok = await h.request('POST', `${base()}/approvals/${reqId}/decide`, { token: lineMgr, body: { decision: 'APPROVE', stepNo: 1 } });
    expect(ok.status).toBe(200);
    expect((await leaveRow(r.body.data.id)).status).toBe('APPROVED');
  });

  it('an edit answers an open question: the request is resubmitted and the leave is PENDING again', async () => {
    await clearWorkflows();
    await workflow([{ order: 1, approverType: 'MANAGER' }]);
    const r = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(1) });
    await h.request('POST', `${base()}/approvals/${r.body.data.approvalRequestId}/request-info`, { token: lineMgr, body: { comment: 'Can you shorten it?' } });
    const e = await h.request('PATCH', `${base()}/me/leave/${r.body.data.id}`, { token: staff5, body: { isHalfDay: true, halfDayPart: 'SECOND_HALF' } });
    expect(e.status).toBe(200);
    expect(e.body.data).toMatchObject({ status: 'PENDING', days: 0.5 });
    expect((await requestRow(r.body.data.approvalRequestId)).status).toBe('INVALIDATED');
  });
});

describe('review fixes (assigned from the Prompt 2 review)', () => {
  it('P1-2: a Leave-page decision names its level; without it only a seat the caller holds is settled', async () => {
    await clearWorkflows();
    await workflow([{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'HR_ADMIN' }]);
    const r = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(1) });
    const id = r.body.data.id;
    // hr_user holds leave.approve organisation-wide but sits on no level: the pre-v2 call (no stepNo) is refused
    const legacy = await h.request('PATCH', `${base()}/leave-records/${id}`, { token: f.hrUser, body: { status: 'APPROVED' } });
    expect(legacy.status).toBe(403);
    // naming the level it saw: level 1 is settled and the leave waits at level 2 (never both levels in one call)
    const l1 = await h.request('PATCH', `${base()}/leave-records/${id}`, { token: f.hrUser, body: { status: 'APPROVED', stepNo: 1 } });
    expect(l1.status).toBe(200);
    expect(l1.body.data).toMatchObject({ status: 'PENDING', approvalStatus: 'PENDING', approvalCurrentStep: 2, approvalStepCount: 2 });
    expect(l1.body.data.approvalWaitingFor).toEqual(['hrAdmin']);
    // the same (stale) click again: level 1 is no longer current
    expect((await h.request('PATCH', `${base()}/leave-records/${id}`, { token: f.hrUser, body: { status: 'APPROVED', stepNo: 1 } })).status).toBe(409);
    expect((await leaveRow(id)).status).toBe('PENDING');
    // the seated HR admin decides level 2 with the pre-v2 call
    const l2 = await h.request('PATCH', `${base()}/leave-records/${id}`, { token: f.hrAdmin, body: { status: 'APPROVED', decisionNote: 'Enjoy' } });
    expect(l2.status).toBe(200);
    expect(l2.body.data).toMatchObject({ status: 'APPROVED', decisionNote: 'Enjoy', approvalStatus: 'APPROVED' });
  });

  it('P1-3: content and a decision in one call are refused — the edit is saved (and resubmitted) first', async () => {
    await clearWorkflows();
    const r = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(1) });
    const res = await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: f.hrAdmin, body: { status: 'APPROVED', endDate: addDays(r.body.data.startDate, 3) } });
    expect(res.status).toBe(400);
    expect(codes(res.body)).toContain('DECIDE_SEPARATELY');
    expect(await leaveRow(r.body.data.id)).toMatchObject({ status: 'PENDING' });
    expect((await requestRow(r.body.data.approvalRequestId)).status).toBe('PENDING');
    // saving the edit alone resubmits; deciding afterwards approves what the leave now says
    const edited = await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: f.hrAdmin, body: { endDate: addDays(r.body.data.startDate, 3) } });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ status: 'PENDING', days: 4 });
    expect((await requestRow(r.body.data.approvalRequestId)).status).toBe('INVALIDATED');
    const decided = await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: f.hrAdmin, body: { status: 'APPROVED' } });
    expect(decided.body.data).toMatchObject({ status: 'APPROVED', days: 4 });
  });

  it('P1-4: an engine rejection is not overturned by a status PATCH — the leave agrees with its request', async () => {
    await clearWorkflows();
    await workflow([{ order: 1, approverType: 'MANAGER' }]);
    const r = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(1) });
    const rej = await h.request('POST', `${base()}/approvals/${r.body.data.approvalRequestId}/decide`, { token: lineMgr, body: { decision: 'REJECT', comment: 'No cover', stepNo: 1 } });
    expect(rej.status).toBe(200);
    const flip = await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: f.hrUser, body: { status: 'APPROVED' } });
    expect(flip.status).toBe(409);
    expect(flip.body.message).toMatch(/decision stands/);
    expect((await leaveRow(r.body.data.id)).status).toBe('REJECTED');
    expect((await requestRow(r.body.data.approvalRequestId)).status).toBe('REJECTED');
    expect((await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: f.hrUser, body: { status: 'PENDING' } })).status).toBe(400);
  });

  it('P2-4: withdrawal belongs to the requester or leave.manage — never to an approver merely seated', async () => {
    await clearWorkflows();
    await workflow([{ order: 1, approverType: 'MANAGER' }]);
    const r = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(1) });
    const reqId = r.body.data.approvalRequestId;
    expect((await h.request('POST', `${base()}/approvals/${reqId}/cancel`, { token: lineMgr, body: { reason: 'Not needed' } })).status).toBe(403);
    const detail = await h.request('GET', `${base()}/approvals/${reqId}`, { token: lineMgr });
    expect(detail.body.data.abilities.canCancel).toBe(false);
    expect((await leaveRow(r.body.data.id)).status).toBe('PENDING');
    // HR with leave.manage may withdraw it through the engine; the reason reaches the request
    const hr = await h.request('POST', `${base()}/approvals/${reqId}/cancel`, { token: f.hrUser, body: { reason: 'Duplicate of an HR record' } });
    expect(hr.status).toBe(200);
    expect((await leaveRow(r.body.data.id)).status).toBe('CANCELLED');
    expect((await requestRow(reqId)).cancelReason).toBe('Duplicate of an HR record');
    // the requester may, through the engine too
    const r2 = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(1) });
    expect((await h.request('POST', `${base()}/approvals/${r2.body.data.approvalRequestId}/cancel`, { token: staff5, body: { reason: 'Plans changed' } })).status).toBe(200);
    expect((await leaveRow(r2.body.data.id)).status).toBe('CANCELLED');
  });
});

describe('separation of duties', () => {
  it('nobody decides their own leave: not the employee, not HR recording their own (routed to the others)', async () => {
    await clearWorkflows();
    const r = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(1) });
    expect((await h.request('POST', `${base()}/approvals/${r.body.data.approvalRequestId}/decide`, { token: staff5, body: { decision: 'APPROVE', stepNo: 1 } })).status).toBe(403);
    expect((await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: staff5, body: { status: 'APPROVED', stepNo: 1 } })).status).toBe(403);
    expect((await leaveRow(r.body.data.id)).status).toBe('PENDING');
    // an HR user (leave.manage) recording their OWN leave: a request for the other leave.approve holders, never auto-approved
    const own = await h.request('POST', `${base()}/leave-records`, { token: f.managerUser, body: { employeeId: f.e3, leaveTypeId: T['CL'], ...nextRange(1) } });
    expect(own.status).toBe(201);
    expect(own.body.data).toMatchObject({ status: 'PENDING', approvalStatus: 'PENDING' });
    expect((await h.request('PATCH', `${base()}/leave-records/${own.body.data.id}`, { token: f.managerUser, body: { status: 'APPROVED', stepNo: 1 } })).status).toBe(403);
    expect((await leaveRow(own.body.data.id)).status).toBe('PENDING');
    const other = await h.request('PATCH', `${base()}/leave-records/${own.body.data.id}`, { token: f.hrAdmin, body: { status: 'APPROVED', stepNo: 1 } });
    expect(other.status).toBe(200);
    expect(other.body.data.status).toBe('APPROVED');
  });
});

describe('own filings (review P2-4, B-98)', () => {
  it('a request HR filed for the employee is HR\'s to change or withdraw — the portal says so and refuses', async () => {
    await clearWorkflows();
    await workflow([{ order: 1, approverType: 'MANAGER' }]);
    const range = nextRange(1);
    const filed = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: e5, leaveTypeId: T['CL'], ...range, reason: 'Recorded by HR' } });
    expect(filed.status).toBe(201);
    expect(filed.body.data.status).toBe('PENDING');
    const mine = (await h.request('GET', `${base()}/me/leave?year=${range.startDate.slice(0, 4)}`, { token: staff5 })).body.data.records.find((r: { id: string }) => r.id === filed.body.data.id);
    expect(mine).toMatchObject({ status: 'PENDING', canEdit: false, canWithdraw: false });
    expect((await h.request('PATCH', `${base()}/me/leave/${filed.body.data.id}`, { token: staff5, body: { reason: 'Changed by me' } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/me/leave/${filed.body.data.id}/withdraw`, { token: staff5, body: { reason: 'Not needed' } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/me/leave/${filed.body.data.id}/cancel`, { token: staff5 })).status).toBe(403);
    // the engine agrees: the person a request is about but did not file cannot withdraw it there either
    expect((await h.request('POST', `${base()}/approvals/${filed.body.data.approvalRequestId}/cancel`, { token: staff5, body: { reason: 'Not needed' } })).status).toBe(403);
    expect((await leaveRow(filed.body.data.id)).status).toBe('PENDING');
    // HR withdraws it
    expect((await h.request('DELETE', `${base()}/leave-records/${filed.body.data.id}`, { token: f.hrAdmin })).status).toBe(200);
    expect((await leaveRow(filed.body.data.id)).status).toBe('CANCELLED');
  });

  it('the portal stores the server-computed days even though a client insert may not set them', async () => {
    await clearWorkflows();
    const r = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(3) });
    expect(r.status).toBe(201);
    expect(Number((await leaveRow(r.body.data.id)).days)).toBe(3);
    const e = await h.request('PATCH', `${base()}/me/leave/${r.body.data.id}`, { token: staff5, body: { endDate: addDays(r.body.data.startDate, 1) } });
    expect(e.status).toBe(200);
    expect(Number((await leaveRow(r.body.data.id)).days)).toBe(2);
  });
});

describe('corrections and locked periods', () => {
  it('a decided leave changed by HR is a correction, re-days itself and recomputes the past', async () => {
    await clearWorkflows();
    const start = pastWeekday(0, 14);
    const rec = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: e6, leaveTypeId: T['CL'], startDate: start, endDate: start } });
    expect(rec.body.data.status).toBe('APPROVED');
    expect(rec.body.data.recalculationJobId).not.toBeNull();
    const fix = await h.request('PATCH', `${base()}/leave-records/${rec.body.data.id}`, { token: f.hrAdmin, body: { endDate: addDays(start, 1) } });
    expect(fix.status).toBe(200);
    expect(fix.body.data).toMatchObject({ status: 'APPROVED', days: 2 });
    expect(fix.body.data.editedAt).not.toBeNull();
    expect(fix.body.data.recalculationJobId).not.toBeNull();
    const audit = (await auditRows(h.admin, 'leave.corrected')).find((a) => a.entityId === rec.body.data.id);
    expect(audit?.reason).toMatch(/post-decision correction/);
  });

  it('locked periods block everyone but attendance.lock_period holders (logged)', async () => {
    const day = pastWeekday(1, 21);
    await h.admin.insertInto('attendancePeriodLocks').values({ organizationId: f.orgId, periodStart: addDays(day, -3), periodEnd: addDays(day, 3), reason: 'Payroll closed' }).execute();
    const self = await applyAs(f.employeeUser, { leaveTypeId: T['CL'], startDate: day, endDate: day });
    expect([self.status, self.body.code]).toEqual([409, 'PERIOD_LOCKED']);
    const hrUser = await h.request('POST', `${base()}/leave-records`, { token: f.hrUser, body: { employeeId: f.e1, leaveTypeId: T['CL'], startDate: day, endDate: day } });
    expect(hrUser.body.code).toBe('PERIOD_LOCKED');
    const hrAdmin = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: f.e1, leaveTypeId: T['CL'], startDate: day, endDate: day } });
    expect(hrAdmin.status).toBe(201);
    expect((await auditRows(h.admin, 'leave.recorded')).find((a) => a.entityId === hrAdmin.body.data.id)?.reason).toMatch(/locked period/);
    await h.admin.updateTable('attendancePeriodLocks').set({ unlockedAt: new Date() }).where('organizationId', '=', f.orgId).execute();
  });
});

describe('allocations, balances, CSV and year close', () => {
  it('saves allocation rows (audited, idempotent) and refuses the comp-off type and out-of-scope employees', async () => {
    const row = { employeeId: f.e1, leaveTypeId: T['AL'], year: 2026, allocatedDays: 25, carriedForwardDays: 3, carriedForwardExpiresOn: '2026-03-31' };
    const a = await h.request('PUT', `${base()}/leave-allocations`, { token: f.hrUser, body: { rows: [row] } });
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    expect((await h.request('PUT', `${base()}/leave-allocations`, { token: f.hrUser, body: { rows: [row] } })).body.data).toMatchObject({ created: 0, unchanged: 1 });
    const u = await h.request('PUT', `${base()}/leave-allocations`, { token: f.hrUser, body: { rows: [{ ...row, allocatedDays: 26, adjustmentDays: 1.5 }] } });
    expect(u.body.data).toMatchObject({ updated: 1 });
    expect((await auditRows(h.admin, 'leave_allocation.updated')).length).toBeGreaterThan(0);
    expect((await h.request('PUT', `${base()}/leave-allocations`, { token: f.hrUser, body: { rows: [{ ...row, leaveTypeId: T['CO'] }] } })).status).toBe(400);
    expect((await h.request('PUT', `${base()}/leave-allocations`, { token: f.branchManagerB, body: { rows: [row] } })).status).toBe(400);
    expect((await h.request('PUT', `${base()}/leave-allocations`, { token: f.employeeUser, body: { rows: [row] } })).status).toBe(403);
    const list = await h.request('GET', `${base()}/leave-allocations?year=2026`, { token: f.hrUser });
    expect(list.body.data.find((x: { employeeId: string }) => x.employeeId === f.e1)).toMatchObject({ leaveTypeCode: 'AL', allocatedDays: 26, carriedForwardDays: 3, adjustmentDays: 1.5 });
  });

  it('computes balances from the rows: an expired carry-forward stops counting', async () => {
    const r = await h.request('GET', `${base()}/leave-balances?year=2026&employeeId=${f.e1}`, { token: f.hrUser });
    expect(r.status).toBe(200);
    const al = r.body.data[0].balances.find((b: { code: string }) => b.code === 'AL');
    expect(al).toMatchObject({ hasAllocation: true, allocatedDays: 26, adjustmentDays: 1.5, carriedForwardExpiresOn: '2026-03-31' });
    // by the time the test runs (after 31 March 2026) the 3 carried days expired unused
    expect(al.carriedForwardDays + al.carriedForwardExpiredDays).toBe(3);
    expect(al.entitlementDays).toBe(26 + 1.5 + al.carriedForwardDays);
    expect(r.body.data[0].balances.some((b: { code: string }) => b.code === 'ML')).toBe(false); // not applicable, unused
    expect((await h.request('GET', `${base()}/leave-balances`, { token: f.employeeUser })).status).toBe(403);
  });

  it('generates the missing rows of a year, prorated for joiners, and only once', async () => {
    const g = await h.request('POST', `${base()}/leave-allocations/generate`, { token: f.hrAdmin, body: { year: 2026, leaveTypeIds: [T['AL']] } });
    expect(g.status).toBe(201);
    expect(g.body.data.created).toBeGreaterThan(0);
    const joiner = await h.admin.selectFrom('leaveAllocations').selectAll().where('employeeId', '=', e6).where('leaveTypeId', '=', T['AL']).where('year', '=', 2026).executeTakeFirstOrThrow();
    expect(Number(joiner.allocatedDays)).toBe(10); // 20 × 6/12 (joined 1 July)
    const e1Row = await h.admin.selectFrom('leaveAllocations').selectAll().where('employeeId', '=', f.e1).where('leaveTypeId', '=', T['AL']).where('year', '=', 2026).executeTakeFirstOrThrow();
    expect(Number(e1Row.allocatedDays)).toBe(26); // existing rows are never overwritten
    expect((await h.request('POST', `${base()}/leave-allocations/generate`, { token: f.hrAdmin, body: { year: 2026, leaveTypeIds: [T['AL']] } })).body.data.created).toBe(0);
    expect((await h.request('POST', `${base()}/leave-allocations/generate`, { token: f.hrAdmin, body: { year: 2026, leaveTypeIds: [T['CO']] } })).status).toBe(400);
  });

  it('exports balances as CSV for report.export holders only (audited)', async () => {
    const r = await h.request('GET', `${base()}/leave-balances/export?year=2026`, { token: f.hrUser });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    expect(r.text.split('\n')[0]).toContain('Employee number');
    expect(r.text).toContain('EMP1');
    expect((await h.request('GET', `${base()}/leave-balances/export?year=2026`, { token: viewer })).status).toBe(403);
    expect((await h.request('GET', `${base()}/leave-balances?year=2026`, { token: viewer })).status).toBe(200);
    expect((await auditRows(h.admin, 'leave_balance.exported')).length).toBe(1);
  });

  it('queues the year close once per year (the queue job id is returned)', async () => {
    const r = await h.request('POST', `${base()}/leave-allocations/year-close`, { token: f.hrAdmin, body: { fromYear: 2025 } });
    expect(r.status).toBe(202);
    expect(r.body.data).toMatchObject({ status: 'QUEUED', fromYear: 2025, toYear: 2026 });
    const again = await h.request('POST', `${base()}/leave-allocations/year-close`, { token: f.hrAdmin, body: { fromYear: 2025 } });
    expect(again.body.data.jobId).toBe(r.body.data.jobId);
    const jobs = await queueJobs(h.admin, 'LEAVE_YEAR_CLOSE');
    expect(jobs.filter((j) => j.organizationId === f.orgId)).toHaveLength(1);
    expect(jobs[0]!.dedupeKey).toBe(`leave-year-close:${f.orgId}:2025`);
    expect((await h.request('POST', `${base()}/leave-allocations/year-close`, { token: f.hrAdmin, body: { fromYear: 2099 } })).status).toBe(400);
    expect((await h.request('POST', `${base()}/leave-allocations/year-close`, { token: f.hrUser, body: { fromYear: 2025 } })).status).toBe(202); // hr_user holds leave.manage
    expect((await h.request('POST', `${base()}/leave-allocations/year-close`, { token: lineMgr, body: { fromYear: 2025 } })).status).toBe(403);
  });
});

describe('comp-off', () => {
  const friday = pastWeekday(5, 7);
  let creditId: string; let creditRequest: string;

  it('previews a worked day and refuses what cannot earn a credit', async () => {
    const p = await h.request('GET', `${base()}/me/comp-off/preview?workedOn=${friday}`, { token: staff5 });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ workedOnType: 'weekly_off', eligible: true, alreadyRequested: false });
    const work = await h.request('POST', `${base()}/me/comp-off`, { token: staff5, body: { workedOn: pastWeekday(1, 7), workedOnType: 'weekly_off', workedMinutes: 480, location: 'HQ', summary: 'Release' } });
    expect(work.status).toBe(400);
    const future = await h.request('POST', `${base()}/me/comp-off`, { token: staff5, body: { workedOn: isoToday(14), workedOnType: 'weekly_off', workedMinutes: 480, location: 'HQ', summary: 'Release' } });
    expect(future.status).toBe(400);
    const short = await h.request('POST', `${base()}/me/comp-off`, { token: staff5, body: { workedOn: friday, workedOnType: 'weekly_off', workedMinutes: 90, location: 'HQ', summary: 'Release' } });
    expect(short.status).toBe(400);
  });

  it('requests a credit through the engine; the approver decides; it becomes usable for 90 days', async () => {
    await clearWorkflows();
    const r = await h.request('POST', `${base()}/me/comp-off`, { token: staff5, body: { workedOn: friday, workedOnType: 'weekly_off', workedMinutes: 480, location: 'Head office', summary: 'ERP cut-over' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'pending_approval', daysEarned: 1, workedOnType: 'weekly_off', approvalStatus: 'PENDING' });
    creditId = r.body.data.id; creditRequest = r.body.data.approvalRequestId;
    expect((await h.request('POST', `${base()}/me/comp-off`, { token: staff5, body: { workedOn: friday, workedOnType: 'weekly_off', workedMinutes: 480, location: 'HQ', summary: 'Again' } })).status).toBe(409);
    const ctx = await h.request('GET', `${base()}/approvals/${creditRequest}`, { token: f.hrAdmin });
    expect(ctx.body.data.context).toMatchObject({ kind: 'COMP_OFF', compOff: { workedOn: friday, daysEarned: 1 } });
    expect((await h.request('POST', `${base()}/approvals/${creditRequest}/decide`, { token: staff5, body: { decision: 'APPROVE', stepNo: 1 } })).status).toBe(403);
    const ok = await h.request('POST', `${base()}/approvals/${creditRequest}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE', stepNo: 1 } });
    expect(ok.status).toBe(200);
    const credit = await h.admin.selectFrom('compOffCredits').selectAll().where('id', '=', creditId).executeTakeFirstOrThrow();
    expect(credit.status).toBe('approved');
    expect(credit.expiresOn && new Date(credit.expiresOn).toISOString().slice(0, 10)).toBe(addDays(friday, 90));
    const mine = await h.request('GET', `${base()}/me/comp-off`, { token: staff5 });
    expect(mine.body.data.balance).toMatchObject({ earnedDays: 1, availableDays: 1, leaveTypeId: T['CO'] });
    expect(mine.body.data.rules).toMatchObject({ fullDayHours: 8, halfDayHours: 4, expiryDays: 90 });
  });

  it('redeems the credit as comp-off leave (never overdrawn) and releases it when the leave is cancelled', async () => {
    const two = await applyAs(staff5, { leaveTypeId: T['CO'], ...nextRange(2) });
    expect(two.status).toBe(400);
    expect(codes(two.body)).toContain('COMP_OFF_BALANCE');
    const one = await applyAs(staff5, { leaveTypeId: T['CO'], ...nextRange(1) });
    expect(one.status).toBe(201);
    expect(one.body.data.compOff).toBe(true);
    const ok = await h.request('POST', `${base()}/approvals/${one.body.data.approvalRequestId}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE', stepNo: 1 } });
    expect(ok.status).toBe(200);
    const used = await h.admin.selectFrom('compOffCredits').selectAll().where('id', '=', creditId).executeTakeFirstOrThrow();
    expect([used.status, Number(used.usedDays)]).toEqual(['used', 1]);
    expect((await h.request('GET', `${base()}/me/comp-off`, { token: staff5 })).body.data.balance).toMatchObject({ availableDays: 0, usedDays: 1 });
    const del = await h.request('DELETE', `${base()}/leave-records/${one.body.data.id}`, { token: f.hrAdmin });
    expect(del.status).toBe(200);
    const back = await h.admin.selectFrom('compOffCredits').selectAll().where('id', '=', creditId).executeTakeFirstOrThrow();
    expect([back.status, Number(back.usedDays)]).toEqual(['approved', 0]);
    const usage = await h.admin.selectFrom('compOffUsages').selectAll().where('leaveRecordId', '=', one.body.data.id).execute();
    expect(usage.every((u) => u.releasedAt !== null)).toBe(true);
  });

  it('a rejected request leaves no credit', async () => {
    // one seat (the only HR admin): a rejection closes the level (under ANY a rejection is terminal only when nobody else
    // could still approve — Finance B-94)
    await clearWorkflows();
    await workflow([{ order: 1, approverType: 'HR_ADMIN' }], 'COMP_OFF');
    const d = pastWeekday(6, 14);
    const r = await h.request('POST', `${base()}/me/comp-off`, { token: staff5, body: { workedOn: d, workedOnType: 'weekly_off', workedMinutes: 300, location: 'Site', summary: 'Inventory' } });
    expect(r.body.data.daysEarned).toBe(0.5);
    await h.request('POST', `${base()}/approvals/${r.body.data.approvalRequestId}/decide`, { token: f.hrAdmin, body: { decision: 'REJECT', comment: 'Not approved in advance', stepNo: 1 } });
    const c = await h.admin.selectFrom('compOffCredits').selectAll().where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect([c.status, c.decisionNote]).toEqual(['rejected', 'Not approved in advance']);
  });

  it('Settings → Leave: the organisation\'s comp-off expiry sets how long an approved credit lasts', async () => {
    const put = await h.request('PUT', `${base()}/settings/leave`, { token: f.owner, body: { compOffExpiryDays: 30 } });
    expect(put.status).toBe(200);
    expect((await h.request('GET', `${base()}/settings/leave`, { token: f.owner })).body.data).toMatchObject({ compOffExpiryDays: 30 });
    expect((await h.request('PUT', `${base()}/settings/leave`, { token: f.owner, body: { compOffExpiryDays: 0 } })).status).toBe(400);
    await clearWorkflows();
    const d = pastWeekday(5, 21);
    const r = await h.request('POST', `${base()}/me/comp-off`, { token: staff5, body: { workedOn: d, workedOnType: 'weekly_off', workedMinutes: 480, location: 'Warehouse', summary: 'Stock count' } });
    expect(r.status).toBe(201);
    expect((await h.request('POST', `${base()}/approvals/${r.body.data.approvalRequestId}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE', stepNo: 1 } })).status).toBe(200);
    const credit = await h.admin.selectFrom('compOffCredits').select('expiresOn').where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(credit.expiresOn && new Date(credit.expiresOn).toISOString().slice(0, 10)).toBe(addDays(d, 30));
    expect((await h.request('GET', `${base()}/me/comp-off`, { token: staff5 })).body.data.rules).toMatchObject({ expiryDays: 30 });
    expect((await h.request('PUT', `${base()}/settings/leave`, { token: f.owner, body: { compOffExpiryDays: 90 } })).status).toBe(200);
  });
});

describe('comments, team views and calendar', () => {
  let leaveId: string;
  it('keeps a thread readable by the leave\'s readers only, and tells the other participants', async () => {
    await clearWorkflows();
    await workflow([{ order: 1, approverType: 'MANAGER' }]);
    const r = await applyAs(staff5, { leaveTypeId: T['CL'], ...nextRange(1) });
    leaveId = r.body.data.id;
    const c = await h.request('POST', `${base()}/leave-records/${leaveId}/comments`, { token: staff5, body: { body: 'Handover notes are in the wiki' } });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ kind: 'comment', mine: true, authorName: 'Staff Five' });
    expect((await h.request('GET', `${base()}/leave-records/${leaveId}/comments`, { token: lineMgr })).body.data).toHaveLength(1);
    expect((await h.request('GET', `${base()}/leave-records/${leaveId}/comments`, { token: f.hrUser })).body.data[0].mine).toBe(false);
    expect((await h.request('GET', `${base()}/leave-records/${leaveId}/comments`, { token: f.employeeUser })).status).toBe(404);
    expect((await h.request('POST', `${base()}/leave-records/${leaveId}/comments`, { token: f.employeeUser, body: { body: 'Hi' } })).status).toBe(404);
    expect((await h.request('GET', `${base()}/leave-records/${leaveId}/comments`, { token: f.outsider })).status).toBe(403);
    const ev = (await domainEvents(h.admin, 'leave.comment_added')).filter((e) => e.aggregateId === leaveId);
    const recipients = ev.flatMap((e) => (e.payload as { userIds: string[] }).userIds);
    expect(recipients).toContain(lineMgr);
    expect(recipients).not.toContain(staff5);
    // the thread is append-only
    await expect(h.admin.updateTable('leaveRequestComments').set({ body: 'changed' }).where('leaveRecordId', '=', leaveId).execute()).rejects.toThrow();
  });

  it('shows a manager their team\'s upcoming leave on /my', async () => {
    const r = await h.request('GET', `${base()}/me/team/leave`, { token: lineMgr });
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    expect(r.body.data.every((x: { employeeId: string }) => x.employeeId === e5)).toBe(true);
    expect(r.body.data.every((x: { status: string }) => ['APPROVED', 'PENDING', 'INFO_REQUESTED'].includes(x.status))).toBe(true);
    expect(r.body.data.length).toBeLessThanOrEqual(20);
    expect((await h.request('GET', `${base()}/me/team/leave`, { token: staff5 })).status).toBe(403);
  });

  it('draws the month calendar for HR (branch scope) and for a manager (team only)', async () => {
    const leave = await leaveRow(leaveId);
    const month = new Date(leave.startDate).toISOString().slice(0, 7);
    const hr = await h.request('GET', `${base()}/leave-calendar?month=${month}`, { token: f.hrUser });
    expect(hr.status).toBe(200);
    expect(hr.body.data.entries.some((x: { id: string }) => x.id === leaveId)).toBe(true);
    const approvedOnly = await h.request('GET', `${base()}/leave-calendar?month=${month}&includePending=false`, { token: f.hrUser });
    expect(approvedOnly.body.data.entries.every((x: { status: string }) => x.status === 'APPROVED')).toBe(true);
    const mgr = await h.request('GET', `${base()}/leave-calendar?month=${month}`, { token: lineMgr });
    expect(mgr.body.data.employees.every((x: { employeeId: string }) => x.employeeId === e5)).toBe(true);
    expect((await h.request('GET', `${base()}/leave-calendar?month=${month}`, { token: f.employeeUser })).status).toBe(403);
  });
});

describe('backward compatibility (the current web keeps working)', () => {
  it('BC-1 HR PATCH {status, decisionNote} still decides through the engine for a seated HR user, old shape kept', async () => {
    await clearWorkflows();
    const r = await applyAs(f.employeeUser, { leaveTypeId: T['CL'], ...nextRange(1) });
    const d = await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: f.hrAdmin, body: { status: 'APPROVED', decisionNote: 'Fine' } });
    expect(d.status).toBe(200);
    for (const k of ['id', 'employeeId', 'employeeNumber', 'employeeName', 'leaveTypeId', 'leaveTypeName', 'branchId', 'startDate', 'endDate', 'isHalfDay', 'halfDayPart', 'reason', 'status', 'source', 'decisionNote', 'approvedBy', 'approvedAt', 'createdBy', 'createdAt', 'updatedAt', 'recalculationJobId']) expect(d.body.data).toHaveProperty(k);
    expect(d.body.data).toMatchObject({ status: 'APPROVED', decisionNote: 'Fine', approvedBy: f.hrAdmin });
    // a rejection closes a one-seat level (the only HR admin); with several seats it is recorded and the level stays open (B-94)
    await workflow([{ order: 1, approverType: 'HR_ADMIN' }]);
    const rej = await applyAs(f.employeeUser, { leaveTypeId: T['CL'], ...nextRange(1) });
    const x = await h.request('PATCH', `${base()}/leave-records/${rej.body.data.id}`, { token: f.hrAdmin, body: { status: 'REJECTED', decisionNote: 'Busy week' } });
    expect(x.status).toBe(200);
    expect(x.body.data).toMatchObject({ status: 'REJECTED', decisionNote: 'Busy week', approvalStatus: 'REJECTED' });
    await clearWorkflows();
  });

  it('BC-2 GET /me/leave keeps every pre-v2 field', async () => {
    const r = await h.request('GET', `${base()}/me/leave`, { token: f.employeeUser });
    expect(r.status).toBe(200);
    for (const k of ['year', 'types', 'balances', 'records', 'calendar']) expect(r.body.data).toHaveProperty(k);
    for (const k of ['id', 'code', 'name', 'nameAr', 'isPaid', 'color', 'annualAllowanceDays']) expect(r.body.data.types[0]).toHaveProperty(k);
    for (const k of ['leaveTypeId', 'allowanceDays', 'usedDays', 'pendingDays', 'remainingDays']) expect(r.body.data.balances[0]).toHaveProperty(k);
    for (const k of ['id', 'leaveTypeId', 'leaveTypeCode', 'leaveTypeName', 'color', 'isPaid', 'startDate', 'endDate', 'isHalfDay', 'halfDayPart', 'days', 'reason', 'status', 'decisionNote', 'approvedByName', 'approvedAt', 'createdAt', 'updatedAt', 'approvalRequestId', 'approvalStatus', 'approvalCurrentStep', 'approvalStepCount']) expect(r.body.data.records[0]).toHaveProperty(k);
    expect(r.body.data.calendar).toMatchObject({ weeklyOffDays: [5, 6] });
  });

  it('BC-3 POST /me/leave with the pre-v2 body still applies', async () => {
    const r = await h.request('POST', `${base()}/me/leave`, { token: f.employeeUser, body: { leaveTypeId: T['CL'], ...nextRange(2), isHalfDay: false, reason: 'Old client' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'PENDING', leaveTypeCode: 'CL', days: 2, approvedByName: null });
  });

  it('BC-4 POST /me/leave/:id/cancel without a body still withdraws (default reason)', async () => {
    const r = await applyAs(f.employeeUser, { leaveTypeId: T['CL'], ...nextRange(1) });
    const c = await h.request('POST', `${base()}/me/leave/${r.body.data.id}/cancel`, { token: f.employeeUser });
    expect(c.status).toBe(200);
    expect(c.body.data.status).toBe('CANCELLED');
    expect((await requestRow(r.body.data.approvalRequestId)).cancelReason).toBe('Withdrawn by the requester');
  });

  it('BC-5 GET /leave-records keeps the pre-v2 fields and adds the v2 ones', async () => {
    const r = await h.request('GET', `${base()}/leave-records?pageSize=5`, { token: f.hrUser });
    expect(r.status).toBe(200);
    for (const k of ['id', 'employeeId', 'employeeNumber', 'employeeName', 'leaveTypeId', 'leaveTypeName', 'branchId', 'startDate', 'endDate', 'isHalfDay', 'halfDayPart', 'reason', 'status', 'source', 'decisionNote', 'approvedBy', 'approvedAt', 'createdBy', 'createdAt', 'updatedAt']) expect(r.body.data[0]).toHaveProperty(k);
    for (const k of ['days', 'withdrawnAt', 'editedAt', 'approvalRequestId', 'approvalStatus', 'approvalCurrentStep', 'approvalStepCount', 'approvalWaitingFor', 'commentCount']) expect(r.body.data[0]).toHaveProperty(k);
    expect(r.body.meta).toMatchObject({ page: 1, pageSize: 5 });
  });
});
