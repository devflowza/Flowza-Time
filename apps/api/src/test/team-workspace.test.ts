/**
 * The line manager's team workspace (HR portal Prompt 5): /team/summary, /team/attendance, /team/leave and the badge counts.
 * Scope = direct reports (primary or secondary) AND the team key the RLS predicate requires; crafted ids are refused; the
 * pending counts are the engine's actionable set + the reasons a mapped line manager may review, each half on its own.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, isoToday, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
// e4 (lineManager) manages e5 (primary, branch A) and e6 (secondary, branch B; primary e9 = mgr9); e7 unrelated; e8 reports to e5.
// e10 (hrScoped: hr_user limited to branch A, no attendance.view_team) manages e11 (branch A) and e12 (branch B).
let e4: string; let e5: string; let e6: string; let e7: string; let e8: string; let e9: string; let e10: string; let e11: string; let e12: string;
const lineManager = uuid('c'); const mgr9 = uuid('c'); const emp5 = uuid('c'); const emp6 = uuid('c'); const hrScoped = uuid('c'); const deputy = uuid('c'); const stranger = uuid('c');
const D = '2026-09-01';
const base = () => `/api/v1/orgs/${f.orgId}`;
let leaveTypeId: string;

async function seedDay(employeeId: string, branchId: string, date: string, status: string, flags: string[] = [], extra: Record<string, unknown> = {}) {
  await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId, attendanceDate: date, branchId, timezone: 'Asia/Muscat', engineVersion: 'test', status: status as never, flags, workedMinutes: 0, trace: JSON.stringify({ punches: [] }), ...extra }).execute();
}
async function punch(employeeId: string, branchId: string, at: string, eventType: 'PUNCH_IN' | 'PUNCH_OUT' | 'PUNCH') {
  await h.admin.insertInto('attendanceEvents').values({ organizationId: f.orgId, employeeId, branchId, punchedAt: new Date(at), eventType, source: 'DEVICE' }).execute();
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_team_ws_${process.pid}`); f = await seedOrg(h.admin, 'teamws');
  e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4);
  e9 = await seedEmployee(h.admin, f.orgId, f.branchB, 9);
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5, { managerEmployeeId: e4 });
  e6 = await seedEmployee(h.admin, f.orgId, f.branchB, 6, { managerEmployeeId: e9 });
  await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: e4 }).where('id', '=', e6).execute();
  e7 = await seedEmployee(h.admin, f.orgId, f.branchA, 7);
  e8 = await seedEmployee(h.admin, f.orgId, f.branchA, 8, { managerEmployeeId: e5 });
  e10 = await seedEmployee(h.admin, f.orgId, f.branchA, 10);
  e11 = await seedEmployee(h.admin, f.orgId, f.branchA, 11, { managerEmployeeId: e10 });
  e12 = await seedEmployee(h.admin, f.orgId, f.branchB, 12, { managerEmployeeId: e10 });
  for (const [id, email] of [[lineManager, 'lm-teamws'], [mgr9, 'mgr9-teamws'], [emp5, 'emp5-teamws'], [emp6, 'emp6-teamws'], [hrScoped, 'hrs-teamws'], [deputy, 'deputy-teamws'], [stranger, 'stranger-teamws']] as const) await seedUser(h.admin, id, `${email}@test.local`, email);
  await seedMembership(h.admin, f.orgId, lineManager, ROLE.manager, { employeeId: e4 });
  await seedMembership(h.admin, f.orgId, mgr9, ROLE.manager, { employeeId: e9 });
  await seedMembership(h.admin, f.orgId, emp5, ROLE.employee, { employeeId: e5 });
  await seedMembership(h.admin, f.orgId, emp6, ROLE.employee, { employeeId: e6 });
  await seedMembership(h.admin, f.orgId, hrScoped, ROLE.hr_user, { employeeId: e10, branchIds: [f.branchA] });
  await seedMembership(h.admin, f.orgId, deputy, ROLE.employee);
  await seedMembership(h.admin, f.orgId, stranger, ROLE.employee);
  // the day: e5 late and checked out, e6 absent, e11 present, e12 present; e7 / e8 present (never visible to lineManager)
  await seedDay(e5, f.branchA, D, 'PRESENT', ['LATE'], { firstInAt: new Date(`${D}T05:20:00Z`), lastOutAt: new Date(`${D}T13:00:00Z`), workedMinutes: 460, lateMinutes: 20 });
  await punch(e5, f.branchA, `${D}T05:20:00Z`, 'PUNCH_IN');
  await punch(e5, f.branchA, `${D}T13:00:00Z`, 'PUNCH_OUT');
  await seedDay(e6, f.branchB, D, 'ABSENT');
  for (const [e, b] of [[e7, f.branchA], [e8, f.branchA], [e11, f.branchA], [e12, f.branchB]] as const) await seedDay(e, b, D, 'PRESENT', [], { workedMinutes: 480 });
  const lt = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'AL', name: 'Annual Leave', annualAllowanceDays: 30 } });
  leaveTypeId = lt.body.data.id;
});
afterAll(async () => { await h?.close(); });

describe('GET /team/summary', () => {
  it('lists the direct reports only — primary and secondary — with the day read from the engine and the punches', async () => {
    const r = await h.request('GET', `${base()}/team/summary?date=${D}`, { token: lineManager });
    expect(r.status).toBe(200);
    const byId = new Map(r.body.data.members.map((m: { employeeId: string }) => [m.employeeId, m]));
    expect([...byId.keys()].sort()).toEqual([e5, e6].sort());
    expect(byId.get(e5)).toMatchObject({ relation: 'primary', status: 'late', recordStatus: 'PRESENT', liveState: 'OUT', workedMinutes: 460, workedIsLive: false, lateMinutes: 20, branchName: 'Branch A', timezone: 'Asia/Muscat', date: D });
    expect(byId.get(e6)).toMatchObject({ relation: 'secondary', status: 'absent', liveState: 'NONE', branchName: 'Branch B' });
    expect(r.body.data.totals).toMatchObject({ reports: 2, present: 1, late: 1, absent: 1, onLeave: 0, missingPunch: 0 });
  });

  it('an organisation-wide key alone reaches only the reports inside the caller\'s branches', async () => {
    const r = await h.request('GET', `${base()}/team/summary?date=${D}`, { token: hrScoped });
    expect(r.status).toBe(200);
    expect(r.body.data.members.map((m: { employeeId: string }) => m.employeeId)).toEqual([e11]);
  });

  it('needs a team or organisation-wide attendance key', async () => {
    expect((await h.request('GET', `${base()}/team/summary`, { token: emp5 })).status).toBe(403);
    expect((await h.request('GET', `${base()}/team/summary`, { token: f.outsider })).status).toBe(403);
    // a key holder without reports: an empty board, not an error
    const owner = await h.request('GET', `${base()}/team/summary?date=${D}`, { token: f.owner });
    expect(owner.status).toBe(200);
    expect(owner.body.data).toMatchObject({ members: [], totals: { reports: 0 } });
  });

  it('shows the live state while checked in, and approved leave', async () => {
    const D2 = '2026-09-02';
    await punch(e5, f.branchA, `${D2}T05:00:00Z`, 'PUNCH_IN');
    await h.admin.insertInto('leaveRecords').values({ organizationId: f.orgId, employeeId: e6, branchId: f.branchB, leaveTypeId, startDate: D2, endDate: D2, status: 'APPROVED' }).execute();
    const r = await h.request('GET', `${base()}/team/summary?date=${D2}`, { token: lineManager });
    const byId = new Map(r.body.data.members.map((m: { employeeId: string }) => [m.employeeId, m]));
    expect(byId.get(e5)).toMatchObject({ status: 'present', liveState: 'IN', workedIsLive: true, recordId: null });
    expect(byId.get(e6)).toMatchObject({ status: 'on_leave', leave: { leaveTypeName: 'Annual Leave', isHalfDay: false } });
    expect(r.body.data.totals).toMatchObject({ present: 1, onLeave: 1, inNow: 1 });
  });
});

describe('GET /team/attendance', () => {
  it('daily records of the reports, paginated by report', async () => {
    const r = await h.request('GET', `${base()}/team/attendance?from=${D}&to=${D}`, { token: lineManager });
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ total: 2, page: 1 });
    const rows = new Map(r.body.data.map((x: { employeeId: string }) => [x.employeeId, x]));
    expect((rows.get(e5) as { records: Array<{ status: string }> }).records.map((x) => x.status)).toEqual(['PRESENT']);
    expect((rows.get(e6) as { relation: string }).relation).toBe('secondary');
    const one = await h.request('GET', `${base()}/team/attendance?from=${D}&to=${D}&employeeId=${e6}`, { token: lineManager });
    expect(one.body.data.map((x: { employeeId: string }) => x.employeeId)).toEqual([e6]);
  });

  it('refuses a crafted id that is not a direct report (unrelated, an indirect report, oneself)', async () => {
    for (const id of [e7, e8, e4]) expect((await h.request('GET', `${base()}/team/attendance?from=${D}&to=${D}&employeeId=${id}`, { token: lineManager })).status).toBe(403);
    // an organisation-wide key does not stretch past the branch scope: e12 is hrScoped's report in branch B
    expect((await h.request('GET', `${base()}/team/attendance?from=${D}&to=${D}&employeeId=${e12}`, { token: hrScoped })).status).toBe(403);
    expect((await h.request('GET', `${base()}/team/attendance?from=${D}&to=${D}&employeeId=${e11}`, { token: hrScoped })).status).toBe(200);
  });

  it('validates the range (at most 62 days, to on/after from)', async () => {
    expect((await h.request('GET', `${base()}/team/attendance?from=2026-01-01&to=2026-03-31`, { token: lineManager })).status).toBe(400);
    expect((await h.request('GET', `${base()}/team/attendance?from=${D}&to=2026-08-01`, { token: lineManager })).status).toBe(400);
  });

  it('the record dialog opens a report\'s record for the line manager (team predicate, not a branch grant)', async () => {
    const rec = await h.admin.selectFrom('attendanceDailyRecords').select('id').where('employeeId', '=', e6).where('attendanceDate', '=', sql<Date>`${D}::date`).executeTakeFirstOrThrow();
    expect((await h.request('GET', `${base()}/attendance/records/${rec.id}`, { token: lineManager })).status).toBe(200);
    const other = await h.admin.selectFrom('attendanceDailyRecords').select('id').where('employeeId', '=', e7).where('attendanceDate', '=', sql<Date>`${D}::date`).executeTakeFirstOrThrow();
    expect((await h.request('GET', `${base()}/attendance/records/${other.id}`, { token: lineManager })).status).toBe(404);
  });
});

describe('GET /team/leave', () => {
  it('approved, pending and info-requested leave of the reports; the upcoming card ends today or later (max 20)', async () => {
    const future = isoToday(5);
    await h.admin.insertInto('leaveRecords').values([
      { organizationId: f.orgId, employeeId: e5, branchId: f.branchA, leaveTypeId, startDate: future, endDate: future, status: 'PENDING' },
      { organizationId: f.orgId, employeeId: e5, branchId: f.branchA, leaveTypeId, startDate: isoToday(-40), endDate: isoToday(-39), status: 'APPROVED' },
      { organizationId: f.orgId, employeeId: e5, branchId: f.branchA, leaveTypeId, startDate: future, endDate: future, status: 'REJECTED' },
      { organizationId: f.orgId, employeeId: e7, branchId: f.branchA, leaveTypeId, startDate: future, endDate: future, status: 'APPROVED' },
    ]).execute();
    const r = await h.request('GET', `${base()}/team/leave?from=${isoToday(-45)}&to=${isoToday(10)}`, { token: lineManager });
    expect(r.status).toBe(200);
    const statuses = r.body.data.entries.map((x: { employeeId: string; status: string }) => `${x.employeeId === e5 ? 'e5' : x.employeeId === e6 ? 'e6' : 'other'}:${x.status}`).sort();
    // (e6's approved day of 2026-09-02 from the board test is in the range too; the rejected one and e7's never are)
    expect(statuses).toEqual(['e5:APPROVED', 'e5:PENDING', 'e6:APPROVED']);
    expect(r.body.data.upcoming.map((x: { status: string; endDate: string }) => x.endDate >= r.body.data.today)).not.toContain(false);
    expect(r.body.data.upcoming.some((x: { employeeId: string }) => x.employeeId === e7)).toBe(false);
    expect((await h.request('GET', `${base()}/team/leave?from=${isoToday(-45)}&to=${isoToday(40)}`, { token: lineManager })).status).toBe(400);
    expect((await h.request('GET', `${base()}/team/leave?from=${D}&to=${D}`, { token: emp5 })).status).toBe(403);
  });
});

describe('GET /team/pending-counts', () => {
  let noteE5: string;
  it('approvals = /me.approvals.actionable; notes = reasons the caller may review as mapped manager; total never counts twice', async () => {
    const empty = await h.request('GET', `${base()}/team/pending-counts`, { token: lineManager });
    expect(empty.body.data).toEqual({ approvals: 0, notes: 0, total: 0 });
    // e5 (primary report) gives a reason → routed to lineManager (approvals half)
    await seedDay(e5, f.branchA, isoToday(-3), 'ABSENT');
    const n5 = await h.request('POST', `${base()}/me/attendance/notes`, { token: emp5, body: { date: isoToday(-3), category: 'absence_reason', note: 'Doctor appointment' } });
    expect(n5.status).toBe(201);
    noteE5 = n5.body.data.id;
    // e6 (secondary report of lineManager) → routed to mgr9 with lineManager standing in as the secondary manager
    await seedDay(e6, f.branchB, isoToday(-3), 'ABSENT');
    const n6 = await h.request('POST', `${base()}/me/attendance/notes`, { token: emp6, body: { date: isoToday(-3), category: 'absence_reason', note: 'Family matter' } });
    expect(n6.status).toBe(201);
    const standIn = await h.admin.selectFrom('approvalStepActors').select(['resolutionPath', 'viaDelegationOf']).where('userId', '=', lineManager).where('resolutionPath', '=', 'secondary').execute();
    expect(standIn).toEqual([{ resolutionPath: 'secondary', viaDelegationOf: mgr9 }]);
    const me = await h.request('GET', '/api/v1/me', { token: lineManager });
    const actionable = me.body.data.memberships.find((m: { organization: { id: string } }) => m.organization.id === f.orgId).approvals.actionable;
    const c = await h.request('GET', `${base()}/team/pending-counts`, { token: lineManager });
    expect(c.status).toBe(200);
    expect(c.body.data.approvals).toBe(actionable);
    // two items wait for lineManager — whichever half the engine files the stand-in seat under, each counts once
    expect(c.body.data.total).toBe(2);
    expect(c.body.data.approvals + c.body.data.notes).toBe(c.body.data.total);
    // the per-report counts on the board agree
    const board = await h.request('GET', `${base()}/team/summary?date=${D}`, { token: lineManager });
    const pending = Object.fromEntries(board.body.data.members.map((m: { employeeId: string; pendingItems: number }) => [m.employeeId, m.pendingItems]));
    expect(pending).toEqual({ [e5]: 1, [e6]: 1 });
    expect(board.body.data.totals.pendingItems).toBe(2);
  });

  it('assigned-only: the primary sees only their seat; a stranger sees nothing; a delegate sees the delegator\'s', async () => {
    expect((await h.request('GET', `${base()}/team/pending-counts`, { token: mgr9 })).body.data.total).toBe(1);
    expect((await h.request('GET', `${base()}/team/pending-counts`, { token: stranger })).body.data).toEqual({ approvals: 0, notes: 0, total: 0 });
    const d = await h.request('POST', `${base()}/approval-delegations`, { token: lineManager, body: { delegateUserId: deputy, startsOn: isoToday(-1), endsOn: isoToday(3), reason: 'Away' } });
    expect(d.status).toBe(201);
    const dep = await h.request('GET', `${base()}/team/pending-counts`, { token: deputy });
    const me = await h.request('GET', '/api/v1/me', { token: deputy });
    expect(dep.body.data.approvals).toBe(me.body.data.memberships[0].approvals.actionable);
    expect(dep.body.data.approvals).toBeGreaterThanOrEqual(1);
    await h.admin.updateTable('approvalDelegations').set({ isActive: false }).where('id', '=', d.body.data.id).execute();
  });

  it('a note without a live request counts for the line manager (they decide it directly); decided notes drop out', async () => {
    const orphan = await h.admin.insertInto('attendanceNotes').values({ organizationId: f.orgId, employeeId: e5, branchId: f.branchA, attendanceDate: isoToday(-6), category: 'late_reason', note: 'Traffic', status: 'pending' }).returning('id').executeTakeFirstOrThrow();
    const before = (await h.request('GET', `${base()}/team/pending-counts`, { token: lineManager })).body.data;
    expect(before.total).toBe(3);
    const rev = await h.request('POST', `${base()}/attendance/notes/${orphan.id}/review`, { token: lineManager, body: { decision: 'reject', payEffectDays: 0.5, reason: 'No evidence' } });
    expect(rev.status).toBe(200);
    const rev2 = await h.request('POST', `${base()}/attendance/notes/${noteE5}/review`, { token: lineManager, body: { decision: 'approve' } });
    expect(rev2.status).toBe(200);
    expect((await h.request('GET', `${base()}/team/pending-counts`, { token: lineManager })).body.data.total).toBe(1);
  });

  it('each half is computed on its own: a failing half reads 0, the other still counts', async () => {
    // one more reason of e5 on lineManager's own seat, so the approvals half has something to lose
    await seedDay(e5, f.branchA, isoToday(-8), 'ABSENT');
    expect((await h.request('POST', `${base()}/me/attendance/notes`, { token: emp5, body: { date: isoToday(-8), category: 'absence_reason', note: 'Sick' } })).status).toBe(201);
    const before = (await h.request('GET', `${base()}/team/pending-counts`, { token: lineManager })).body.data;
    expect(before.total).toBe(2);
    expect(before.approvals).toBeGreaterThanOrEqual(1);
    await sql`revoke execute on function app.approval_actionable_request_ids(uuid) from public, authenticated`.execute(h.admin);
    try {
      const broken = await h.request('GET', `${base()}/team/pending-counts`, { token: lineManager });
      expect(broken.status).toBe(200);
      expect(broken.body.data.approvals).toBe(0);
      expect(broken.body.data.total).toBe(broken.body.data.notes);
    } finally {
      await sql`grant execute on function app.approval_actionable_request_ids(uuid) to authenticated`.execute(h.admin);
    }
    await sql`revoke select on public.attendance_notes from authenticated`.execute(h.admin);
    try {
      const broken = await h.request('GET', `${base()}/team/pending-counts`, { token: lineManager });
      expect(broken.status).toBe(200);
      expect(broken.body.data.notes).toBe(0);
      expect(broken.body.data.approvals).toBe(before.approvals);
    } finally {
      await sql`grant select on public.attendance_notes to authenticated`.execute(h.admin);
    }
  });
});

describe('review 5 — one definition of "waiting for you" (stand-in seats, delegates, secondary managers)', () => {
  let MORN: string; let EVE: string; let e13: string;
  /** A working day (Sunday–Thursday: the organisation's weekly off is Friday + Saturday) at least `from` days ahead. */
  const workdayAhead = (from: number) => {
    for (let i = from; i < from + 7; i += 1) { const d = new Date(); d.setUTCDate(d.getUTCDate() + i); if (![5, 6].includes(d.getUTCDay())) return d.toISOString().slice(0, 10); }
    throw new Error('no working day');
  };
  /** Every surface built on the engine's actionable set: the badge counts, /me and the inbox "Mine" queue. */
  async function waitingFor(token: string) {
    const counts = (await h.request('GET', `${base()}/team/pending-counts`, { token })).body.data as { approvals: number; notes: number; total: number };
    const me = (await h.request('GET', '/api/v1/me', { token })).body.data.memberships.find((m: { organization: { id: string } }) => m.organization.id === f.orgId).approvals.actionable as number;
    const inbox = await h.request('GET', `${base()}/approvals?scope=mine&view=pending&pageSize=100`, { token });
    return { counts, me, inboxIds: inbox.body.data.map((x: { id: string }) => x.id) as string[], inboxTotal: inbox.body.meta.total as number };
  }
  const requestOfEntity = (entityId: string) => h.admin.selectFrom('approvalRequests').select(['id', 'status']).where('entityId', '=', entityId).executeTakeFirstOrThrow();
  const seatsOf = async (requestId: string) => h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select(['a.userId', 'a.resolutionPath', 'a.viaDelegationOf', 'a.decision']).where('s.requestId', '=', requestId).execute();

  beforeAll(async () => {
    MORN = (await h.admin.insertInto('shifts').values({ organizationId: f.orgId, code: 'MORN', name: 'Morning', type: 'FIXED', startTime: '08:00', endTime: '16:00' }).returning('id').executeTakeFirstOrThrow()).id;
    EVE = (await h.admin.insertInto('shifts').values({ organizationId: f.orgId, code: 'EVE', name: 'Evening', type: 'FIXED', startTime: '14:00', endTime: '22:00' }).returning('id').executeTakeFirstOrThrow()).id;
    e13 = await seedEmployee(h.admin, f.orgId, f.branchB, 13);
    const a = (targetId: string, shiftId: string) => ({ organizationId: f.orgId, targetType: 'EMPLOYEE' as const, targetId, branchId: f.branchB, shiftId, effectiveFrom: '2026-01-01' });
    await h.admin.insertInto('shiftAssignments').values([a(e6, MORN), a(e13, EVE)]).execute();
  });

  it('5-P1-3 a secondary manager\'s stand-in seat on a regularisation is listed, counted and decidable', async () => {
    const before = await waitingFor(lineManager);
    const date = isoToday(-2);
    const r = await h.request('POST', `${base()}/me/regularisations`, { token: emp6, body: { date, type: 'missed_punch', proposedInAt: `${date}T05:00:00Z`, proposedOutAt: `${date}T13:00:00Z`, reason: 'The terminal was offline' } });
    expect(r.status).toBe(201);
    const req = await requestOfEntity(r.body.data.id);
    expect(await seatsOf(req.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: mgr9, resolutionPath: 'primary', viaDelegationOf: null }),
      expect.objectContaining({ userId: lineManager, resolutionPath: 'secondary', viaDelegationOf: mgr9 }),
    ]));
    const after = await waitingFor(lineManager);
    expect(after.counts.approvals).toBe(before.counts.approvals + 1);
    expect(after.counts.total).toBe(before.counts.total + 1);
    expect(after.me).toBe(after.counts.approvals);
    expect(after.inboxTotal).toBe(after.counts.approvals);
    expect(after.inboxIds).toContain(req.id);
    // the team board counts it on the report's card
    const board = await h.request('GET', `${base()}/team/summary?date=${D}`, { token: lineManager });
    expect(board.body.data.totals.pendingItems).toBe(after.counts.total);
    // … and the stand-in decides it
    const d = await h.request('POST', `${base()}/approvals/${req.id}/decide`, { token: lineManager, body: { decision: 'APPROVE', stepNo: 1 } });
    expect(d.status).toBe(200);
    expect((await requestOfEntity(r.body.data.id)).status).toBe('APPROVED');
    expect((await waitingFor(lineManager)).counts.total).toBe(before.counts.total);
    expect((await waitingFor(mgr9)).inboxIds).not.toContain(req.id);
  });

  it('5-P1-3 … and on a shift swap', async () => {
    const before = await waitingFor(lineManager);
    const s = await h.request('POST', `${base()}/me/shift-swaps`, { token: emp6, body: { date: workdayAhead(3), withEmployeeId: e13, reason: 'Family event in the morning' } });
    expect(s.status).toBe(201);
    const req = await requestOfEntity(s.body.data.id);
    expect((await seatsOf(req.id)).find((x) => x.userId === lineManager)).toMatchObject({ resolutionPath: 'secondary', viaDelegationOf: mgr9 });
    const after = await waitingFor(lineManager);
    expect(after.counts.approvals).toBe(before.counts.approvals + 1);
    expect(after.me).toBe(after.counts.approvals);
    expect(after.inboxIds).toContain(req.id);
    expect((await waitingFor(mgr9)).inboxIds).toContain(req.id);
    const d = await h.request('POST', `${base()}/approvals/${req.id}/decide`, { token: lineManager, body: { decision: 'APPROVE', stepNo: 1 } });
    expect(d.status).toBe(200);
    expect((await h.admin.selectFrom('shiftSwapRequests').select('status').where('id', '=', s.body.data.id).executeTakeFirstOrThrow()).status).toBe('approved');
    expect((await waitingFor(lineManager)).counts.approvals).toBe(before.counts.approvals);
  });

  it('5-P2-1 a delegate\'s own request never waits for them (it waits for the approver they stand in for)', async () => {
    const d = await h.request('POST', `${base()}/approval-delegations`, { token: lineManager, body: { delegateUserId: emp5, startsOn: isoToday(-1), endsOn: isoToday(30), reason: 'Away' } });
    expect(d.status).toBe(201);
    try {
      const before = await waitingFor(emp5);
      const leave = await h.request('POST', `${base()}/me/leave`, { token: emp5, body: { leaveTypeId, startDate: workdayAhead(20), endDate: workdayAhead(20), reason: 'My own leave' } });
      expect(leave.status).toBe(201);
      const id = leave.body.data.approvalRequestId as string;
      // the line manager's seat: the delegate — who is the subject — would reach it only as the delegate
      expect((await waitingFor(lineManager)).inboxIds).toContain(id);
      const after = await waitingFor(emp5);
      expect(after.inboxIds).not.toContain(id);
      expect(after.me).toBe(before.me);
      expect(after.counts.approvals).toBe(before.counts.approvals);
      expect((await h.request('GET', `${base()}/approvals/${id}`, { token: emp5 })).body.data.abilities.canDecide).toBe(false);
      await h.request('POST', `${base()}/approvals/${id}/cancel`, { token: emp5, body: { reason: 'Test done' } });
    } finally {
      await h.admin.updateTable('approvalDelegations').set({ isActive: false }).where('id', '=', d.body.data.id).execute();
    }
  });

  it('5-P2-2 a secondary manager whose role carries no team key sees their stand-in seat in the badge', async () => {
    const eP = await seedEmployee(h.admin, f.orgId, f.branchA, 30);
    const eS = await seedEmployee(h.admin, f.orgId, f.branchA, 31);
    const eR = await seedEmployee(h.admin, f.orgId, f.branchA, 32, { managerEmployeeId: eP });
    await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: eS }).where('id', '=', eR).execute();
    const prim = uuid('c'); const sec = uuid('c'); const rep = uuid('c');
    for (const [id, email] of [[prim, 'prim-teamws'], [sec, 'sec-teamws'], [rep, 'rep-teamws']] as const) await seedUser(h.admin, id, `${email}@test.local`, email);
    await seedMembership(h.admin, f.orgId, prim, ROLE.manager, { employeeId: eP });
    await seedMembership(h.admin, f.orgId, sec, ROLE.employee, { employeeId: eS });
    await seedMembership(h.admin, f.orgId, rep, ROLE.employee, { employeeId: eR });
    await seedDay(eR, f.branchA, isoToday(-4), 'ABSENT');
    const n = await h.request('POST', `${base()}/me/attendance/notes`, { token: rep, body: { date: isoToday(-4), category: 'absence_reason', note: 'Doctor' } });
    expect(n.status).toBe(201);
    const standIn = await h.admin.selectFrom('approvalStepActors').select(['resolutionPath', 'viaDelegationOf']).where('userId', '=', sec).execute();
    expect(standIn).toEqual([{ resolutionPath: 'secondary', viaDelegationOf: prim }]);
    const w = await waitingFor(sec);
    expect(w.counts).toEqual({ approvals: 1, notes: 0, total: 1 });
    expect(w.me).toBe(1);
    expect(w.inboxTotal).toBe(1);
    // what the badge counts is what they may review
    const reasons = await h.request('GET', `${base()}/attendance/notes?scope=mine&open=true`, { token: sec });
    expect(reasons.body.data.filter((x: { canReview: boolean }) => x.canReview)).toHaveLength(1);
    expect((await h.request('POST', `${base()}/attendance/notes/${n.body.data.id}/review`, { token: sec, body: { decision: 'approve' } })).status).toBe(200);
    expect((await waitingFor(sec)).counts.total).toBe(0);
  });
});
