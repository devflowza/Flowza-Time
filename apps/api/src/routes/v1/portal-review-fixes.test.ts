import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, dayOfWeek, eachDate } from '@flowza/shared';
import { auditRows, createApiHarness, domainEvents, isoToday, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../test/features-harness.js';

/**
 * Regression tests of the HR portal Prompt 4 adversarial review (docs/hr-portal/reviews/04-employee-portal-attendance-review.md)
 * at the HTTP layer, one per defect and named after it (`4-<id>`), mostly replaying the reviewer's probes (scratchpad rev4/).
 * Every area has its own organisation, so the routing, settings and workflows of one never leak into another. The IP
 * allow-list behind the edge, the selfie image validation and the punch payload's geofence fact live in
 * portal-review-fixes-punch.test.ts (a harness with EDGE_SHARED_SECRET).
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });
let h: ApiHarness;
const base = (orgId: string) => `/api/v1/orgs/${orgId}`;
let seq = 0;
const key = () => `p4f-${process.pid}-${(seq += 1)}-${Date.now()}`;

beforeAll(async () => { h = await createApiHarness(`flowza_api_portal_fixes_${process.pid}`); });
afterAll(async () => { await h?.close(); });

// ----- helpers ------------------------------------------------------------------------------------------------------------------

async function attendanceOf(orgId: string): Promise<Record<string, unknown>> {
  const row = await h.admin.selectFrom('organizationSettings').select('attendance').where('organizationId', '=', orgId).executeTakeFirstOrThrow();
  return (typeof row.attendance === 'string' ? JSON.parse(row.attendance) : row.attendance ?? {}) as Record<string, unknown>;
}
async function setAttendance(orgId: string, patch: Record<string, unknown>): Promise<void> {
  await h.admin.updateTable('organizationSettings').set({ attendance: JSON.stringify({ ...(await attendanceOf(orgId)), ...patch }) }).where('organizationId', '=', orgId).execute();
}
async function setSelfService(orgId: string, patch: Record<string, unknown>): Promise<void> {
  const att = await attendanceOf(orgId);
  await setAttendance(orgId, { selfService: { ...((att['selfService'] as Record<string, unknown>) ?? {}), ...patch } });
}
async function seedDay(orgId: string, employeeId: string, branchId: string, date: string, status: string, flags: string[] = []): Promise<void> {
  await h.admin.insertInto('attendanceDailyRecords').values({
    organizationId: orgId, employeeId, attendanceDate: date, branchId, timezone: 'Asia/Muscat', engineVersion: 'test', status: status as never, flags: flags as never,
    workedMinutes: status === 'PRESENT' || status === 'MISSING_PUNCH' ? 480 : status === 'HALF_DAY' ? 240 : 0, lateMinutes: flags.includes('LATE') ? 20 : 0, trace: JSON.stringify({ punches: [] }),
  }).execute();
}
const requestsOf = (entityId: string) => h.admin.selectFrom('approvalRequests').selectAll().where('entityId', '=', entityId).orderBy('createdAt', 'asc').orderBy('id', 'asc').execute();
async function actorsOf(requestId: string) {
  return h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId')
    .select(['a.userId', 's.stepNo', 'a.resolutionPath', 'a.decision', 'a.onBehalfOfUserId', 'a.viaDelegationOf']).where('s.requestId', '=', requestId).orderBy('s.stepNo').orderBy('a.userId').execute();
}
const eventsOf = async (requestId: string) => (await h.admin.selectFrom('approvalRequestEvents').select(['kind', 'detail']).where('requestId', '=', requestId).orderBy('id').execute());
/** A login of a new employee (role `employee` unless told otherwise). */
async function linked(g: OrgFixture, n: number, branchId: string, roleId: string = ROLE.employee, extra: Parameters<typeof seedEmployee>[4] = {}): Promise<{ id: string; user: string }> {
  const id = await seedEmployee(h.admin, g.orgId, branchId, n, extra);
  const user = uuid('c');
  await seedUser(h.admin, user, `p4f-${g.orgId.slice(-6)}-${n}@test.local`, `P4F user ${n}`);
  await seedMembership(h.admin, g.orgId, user, roleId, { employeeId: id });
  return { id, user };
}
const decide = (orgId: string, requestId: string, body: Record<string, unknown>, token: string) => h.request('POST', `${base(orgId)}/approvals/${requestId}/decide`, { token, body });
const note = (g: OrgFixture, date: string, body: Record<string, unknown> = {}, token = g.employeeUser) => h.request('POST', `${base(g.orgId)}/me/attendance/notes`, { token, body: { date, category: 'absence_reason', note: 'I was at the clinic with my son', ...body } });
const review = (g: OrgFixture, id: string, body: Record<string, unknown>, token = g.managerUser) => h.request('POST', `${base(g.orgId)}/attendance/notes/${id}/review`, { token, body });
const regularise = (g: OrgFixture, body: Record<string, unknown>, token = g.employeeUser) => h.request('POST', `${base(g.orgId)}/me/regularisations`, { token, body });
const swap = (g: OrgFixture, body: Record<string, unknown>, token: string) => h.request('POST', `${base(g.orgId)}/me/shift-swaps`, { token, body });
async function createWorkflow(g: OrgFixture, entityType: string, steps: unknown[]): Promise<string> {
  const r = await h.request('POST', `${base(g.orgId)}/approval-workflows`, { token: g.owner, body: { name: `p4f ${entityType} ${key()}`, entityType, steps } });
  if (r.status !== 201) throw new Error(`workflow ${r.status} ${r.text}`);
  return r.body.data.id as string;
}
async function dropWorkflow(g: OrgFixture, id: string): Promise<void> {
  const del = await h.request('DELETE', `${base(g.orgId)}/approval-workflows/${id}`, { token: g.owner });
  if (del.status !== 204) await h.request('PATCH', `${base(g.orgId)}/approval-workflows/${id}`, { token: g.owner, body: { status: 'inactive' } });
}
const iso = (d: Date | string | null) => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
/** Working days ahead (never Friday / Saturday, the organisation's default weekly off). */
function weekdaysAhead(count: number, from = 3): string[] {
  const out: string[] = [];
  for (let i = from; out.length < count && i < 60; i += 1) { const d = isoToday(i); if (![5, 6].includes(dayOfWeek(d))) out.push(d); }
  return out;
}

// ----- P0-1 geofences ------------------------------------------------------------------------------------------------------------

describe('4-P0-1 geofences are written by the API only, inside the caller\'s branches and the fence\'s reach', () => {
  let g: OrgFixture; let geoB: string;
  const F = { a: '', b: '', org: '', reach: '' };
  const url = (id = '') => `${base(g.orgId)}/geofences${id ? `/${id}` : ''}`;
  const snapshot = async () => ({
    fences: await h.admin.selectFrom('geofences').selectAll().where('organizationId', '=', g.orgId).orderBy('id').execute(),
    assignments: await h.admin.selectFrom('geofenceAssignments').selectAll().where('organizationId', '=', g.orgId).orderBy('id').execute(),
  });

  beforeAll(async () => {
    g = await seedOrg(h.admin, 'geo');
    // an HR admin restricted to branch B: attendance.view + attendance.manage_geofences, branch scope B only
    geoB = uuid('c');
    await seedUser(h.admin, geoB, 'geo-b@test.local', 'Branch B geofence manager');
    await seedMembership(h.admin, g.orgId, geoB, ROLE.hr_admin, { branchIds: [g.branchB] });
    const create = async (body: Record<string, unknown>) => {
      const r = await h.request('POST', url(), { token: g.hrAdmin, body: { latitude: 23.59, longitude: 58.39, radiusM: 150, ...body } });
      expect(r.status).toBe(201);
      return r.body.data.id as string;
    };
    F.a = await create({ name: 'A site', branchId: g.branchA, enforcement: 'hard_block' }); // assigned to branch A
    F.b = await create({ name: 'B site', branchId: g.branchB, assignments: [{ scope: 'employee', targetId: g.e2 }] });
    F.org = await create({ name: 'Org zone', radiusM: 300, enforcement: 'hard_block' }); // organisation-wide, assigned to the organisation
    F.reach = await create({ name: 'B yard', branchId: g.branchB, assignments: [{ scope: 'employee', targetId: g.e2 }, { scope: 'employee', targetId: g.e1 }] }); // also reaches branch A
  });

  it('4-P0-1 a branch-restricted manager reads their fences and the organisation-wide one; only what they may change is editable', async () => {
    const list = await h.request('GET', url(), { token: geoB });
    expect(list.status).toBe(200);
    const byName = Object.fromEntries(list.body.data.map((x: { name: string }) => [x.name, x]));
    expect(Object.keys(byName).sort()).toEqual(['B site', 'B yard', 'Org zone']);
    expect(byName['B site']).toMatchObject({ editable: true, hiddenAssignments: 0 });
    // the assignment to the branch-A employee is someone else's: hidden, and the fence is read-only
    expect(byName['B yard']).toMatchObject({ editable: false, hiddenAssignments: 1 });
    expect(byName['B yard'].assignments.map((a: { targetId: string }) => a.targetId)).toEqual([g.e2]);
    // organisation-wide: read-only context
    expect(byName['Org zone']).toMatchObject({ editable: false, hiddenAssignments: 0, assignments: [expect.objectContaining({ scope: 'org' })] });
    expect((await h.request('GET', url(F.a), { token: geoB })).status).toBe(404);
    // an unrestricted manager may change every fence
    const all = await h.request('GET', url(), { token: g.hrAdmin });
    expect(all.body.data.every((x: { editable: boolean; hiddenAssignments: number }) => x.editable && x.hiddenAssignments === 0)).toBe(true);
  });

  it('4-P0-1 the reviewer\'s six probes through the API are refused and change nothing (P-A1 … P-A6)', async () => {
    const before = await snapshot();
    const attempts = {
      'P-A1 loosen the organisation-wide fence': await h.request('PATCH', url(F.org), { token: geoB, body: { radiusM: 4999, enforcement: 'advisory_log' } }),
      'P-A2 turn their branch\'s fence organisation-wide': await h.request('PATCH', url(F.b), { token: geoB, body: { branchId: null } }),
      'P-A3 assign another branch\'s fence to its employee': await h.request('PUT', `${url(F.a)}/assignments`, { token: geoB, body: { assignments: [{ scope: 'employee', targetId: g.e1 }] } }),
      'P-A4 assign a fence to the whole organisation': await h.request('PUT', `${url(F.b)}/assignments`, { token: geoB, body: { assignments: [{ scope: 'org' }] } }),
      'P-A5 remove another branch\'s assignments': await h.request('PUT', `${url(F.a)}/assignments`, { token: geoB, body: { assignments: [] } }),
      'P-A6 delete the organisation-wide fence': await h.request('DELETE', url(F.org), { token: geoB }),
      'control: edit another branch\'s fence': await h.request('PATCH', url(F.a), { token: geoB, body: { radiusM: 31 } }),
    };
    expect(Object.fromEntries(Object.entries(attempts).map(([k, r]) => [k, r.status]))).toEqual(Object.fromEntries(Object.keys(attempts).map((k) => [k, 403])));
    expect(await snapshot()).toEqual(before);
  });

  it('4-P0-1 the fence\'s reach and every new target must stay inside the caller\'s branches', async () => {
    const before = await snapshot();
    const reach = await h.request('PATCH', url(F.reach), { token: geoB, body: { radiusM: 400 } });
    expect(reach.status).toBe(403);
    expect(reach.body.message).toMatch(/also applies to people outside your branch scope/);
    expect((await h.request('DELETE', url(F.reach), { token: geoB })).status).toBe(403);
    const target = await h.request('PUT', `${url(F.b)}/assignments`, { token: geoB, body: { assignments: [{ scope: 'employee', targetId: g.e2 }, { scope: 'employee', targetId: g.e1 }] } });
    expect(target.status).toBe(403);
    expect(target.body.message).toMatch(/outside your branch scope/);
    expect((await h.request('PUT', `${url(F.b)}/assignments`, { token: geoB, body: { assignments: [{ scope: 'department', targetId: g.departmentA }] } })).status).toBe(403);
    expect((await h.request('POST', url(), { token: geoB, body: { name: 'A annex', branchId: g.branchA, latitude: 23.6, longitude: 58.4, radiusM: 100 } })).status).toBe(403);
    expect((await h.request('POST', url(), { token: geoB, body: { name: 'Everywhere', latitude: 23.6, longitude: 58.4, radiusM: 100 } })).status).toBe(403);
    expect((await h.request('POST', url(), { token: geoB, body: { name: 'B, but org-wide', branchId: g.branchB, latitude: 23.6, longitude: 58.4, radiusM: 100, assignments: [{ scope: 'org' }] } })).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it('4-P0-1 an in-scope manager still makes every legitimate change (the system step writes after the checks), audited as themselves', async () => {
    const created = await h.request('POST', url(), { token: geoB, body: { name: 'B gate', branchId: g.branchB, latitude: 23.6, longitude: 58.4, radiusM: 120, assignments: [{ scope: 'employee', targetId: g.e2 }] } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ branchId: g.branchB, editable: true, assignments: [expect.objectContaining({ scope: 'employee', targetId: g.e2 })] });
    const id = created.body.data.id as string;
    const edited = await h.request('PATCH', url(id), { token: geoB, body: { radiusM: 250, enforcement: 'soft_warn' } });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ radiusM: 250, enforcement: 'soft_warn' });
    const reassigned = await h.request('PUT', `${url(id)}/assignments`, { token: geoB, body: { assignments: [{ scope: 'branch', targetId: g.branchB }] } });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.data.assignments).toEqual([expect.objectContaining({ scope: 'branch', targetId: g.branchB })]);
    expect((await h.request('PATCH', url(F.b), { token: geoB, body: { name: 'B site (north gate)' } })).status).toBe(200);
    expect((await h.request('DELETE', url(id), { token: geoB })).status).toBe(204);
    expect(await h.admin.selectFrom('geofences').select('id').where('id', '=', id).executeTakeFirst()).toBeUndefined();
    for (const action of ['geofence.created', 'geofence.updated', 'geofence.assignments_replaced', 'geofence.deleted']) {
      expect((await auditRows(h.admin, action)).some((a) => a.entityId === id && a.actorUserId === geoB)).toBe(true);
    }
    // an unrestricted manager changes the organisation-wide fence
    expect((await h.request('PATCH', url(F.org), { token: g.hrAdmin, body: { radiusM: 320 } })).status).toBe(200);
  });
});

// ----- P0-2 / P2-11 / P2-12 swaps ----------------------------------------------------------------------------------------------

describe('shift swaps: the colleague is a party to the request (4-P0-2), employment is re-checked on approval (4-P2-11), one open swap per person and day (4-P2-12)', () => {
  let s: OrgFixture; let MORN: string; let EVE: string; let wd: string[] = [];
  let e4: { id: string; user: string }; let eH: { id: string; user: string }; let eS2: { id: string; user: string }; let r1: { id: string; user: string };
  let eT: { id: string; user: string }; let eR: { id: string; user: string }; let eM: { id: string; user: string };
  const swapRow = (id: string) => h.admin.selectFrom('shiftSwapRequests').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const assignmentsOf = async (employeeId: string) => (await h.admin.selectFrom('shiftAssignments').select(['effectiveFrom', 'effectiveTo', 'shiftId']).where('targetType', '=', 'EMPLOYEE').where('targetId', '=', employeeId).orderBy('effectiveFrom').execute())
    .map((a) => `${iso(a.effectiveFrom as Date | string)}→${iso(a.effectiveTo as Date | string | null)}:${a.shiftId === MORN ? 'MORN' : 'EVE'}`);

  beforeAll(async () => {
    s = await seedOrg(h.admin, 'swaps');
    MORN = (await h.admin.insertInto('shifts').values({ organizationId: s.orgId, code: 'MORN', name: 'Morning', type: 'FIXED', startTime: '08:00', endTime: '16:00' }).returning('id').executeTakeFirstOrThrow()).id;
    EVE = (await h.admin.insertInto('shifts').values({ organizationId: s.orgId, code: 'EVE', name: 'Evening', type: 'FIXED', startTime: '14:00', endTime: '22:00' }).returning('id').executeTakeFirstOrThrow()).id;
    e4 = await linked(s, 14, s.branchA); // no manager: routed to the HR admins
    const eHId = await seedEmployee(h.admin, s.orgId, s.branchA, 15);
    const hrS = uuid('c');
    await seedUser(h.admin, hrS, 'hr-shifts@test.local', 'HR admin who works shifts');
    await seedMembership(h.admin, s.orgId, hrS, ROLE.hr_admin, { employeeId: eHId });
    eH = { id: eHId, user: hrS };
    eS2 = await linked(s, 21, s.branchA);
    r1 = await linked(s, 22, s.branchA, ROLE.employee, { managerEmployeeId: s.e3 });
    await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: eS2.id }).where('id', '=', r1.id).execute();
    eT = await linked(s, 16, s.branchA);
    eR = await linked(s, 17, s.branchA);
    eM = await linked(s, 18, s.branchA);
    const a = (targetId: string, shiftId: string) => ({ organizationId: s.orgId, targetType: 'EMPLOYEE' as const, targetId, branchId: s.branchA, shiftId, effectiveFrom: '2026-01-01' });
    await h.admin.insertInto('shiftAssignments').values([a(s.e1, MORN), a(s.e3, EVE), a(e4.id, EVE), a(eH.id, MORN), a(eS2.id, EVE), a(r1.id, MORN), a(eT.id, EVE), a(eR.id, EVE), a(eM.id, MORN)]).execute();
    wd = weekdaysAhead(5);
  });

  it('4-P0-2 the swapped colleague who is the requester\'s line manager is never seated and can never decide the swap (probe S1)', async () => {
    const r = await swap(s, { date: wd[0], withEmployeeId: s.e3, reason: 'Family event in the morning' }, s.employeeUser);
    expect(r.status).toBe(201);
    const [req] = await requestsOf(r.body.data.id);
    expect(req).toMatchObject({ employeeId: s.e1, coSubjectEmployeeIds: [s.e3], coSubjectUserIds: [s.managerUser] });
    const seated = (await actorsOf(req!.id)).map((x) => x.userId);
    expect(seated).not.toContain(s.managerUser);
    expect(seated).toContain(s.hrAdmin); // the reporting line fell through to the HR admins
    const byColleague = await decide(s.orgId, req!.id, { stepNo: 1, decision: 'APPROVE' }, s.managerUser);
    expect(byColleague.status).toBe(403);
    expect((await h.request('POST', `${base(s.orgId)}/approvals/${req!.id}/request-info`, { token: s.managerUser, body: { comment: 'Which shift do you want?' } })).status).toBe(403);
    expect((await swapRow(r.body.data.id)).status).toBe('pending');
    expect((await decide(s.orgId, req!.id, { stepNo: 1, decision: 'APPROVE' }, s.hrAdmin)).status).toBe(200);
    expect((await swapRow(r.body.data.id)).status).toBe('approved');
  });

  it('4-P0-2 an HR admin who is the colleague is dropped from the HR-admin rung and refused every approver action (probe S2)', async () => {
    const r = await swap(s, { date: wd[4], withEmployeeId: eH.id, reason: 'Doctor appointment in the evening' }, e4.user);
    expect(r.status).toBe(201);
    const [req] = await requestsOf(r.body.data.id);
    expect((await actorsOf(req!.id)).map((x) => x.userId)).toEqual([s.hrAdmin]);
    const seen = await h.request('GET', `${base(s.orgId)}/approvals/${req!.id}`, { token: eH.user });
    expect(seen.status).toBe(200);
    expect(seen.body.data.abilities).toMatchObject({ canDecide: false, canBypass: false, canCancel: false, canRequestInfo: false });
    expect((await decide(s.orgId, req!.id, { stepNo: 1, decision: 'APPROVE' }, eH.user)).status).toBe(403);
    expect((await h.request('POST', `${base(s.orgId)}/approvals/${req!.id}/bypass`, { token: eH.user, body: { reason: 'Approving my own swap' } })).status).toBe(403);
    expect((await h.request('POST', `${base(s.orgId)}/approvals/${req!.id}/request-info`, { token: eH.user, body: { comment: 'Why?' } })).status).toBe(403);
    expect((await h.request('POST', `${base(s.orgId)}/approvals/${req!.id}/cancel`, { token: eH.user, body: { reason: 'Withdrawing it for them' } })).status).toBe(403);
    const moved = await h.request('POST', `${base(s.orgId)}/approvals/${req!.id}/reassign`, { token: s.owner, body: { userId: eH.user, reason: 'They know the rota best' } });
    expect(moved.status).toBe(400);
    expect(moved.body.message).toMatch(/A person this request is about cannot be its approver/);
    expect((await swapRow(r.body.data.id)).status).toBe('pending');
    expect((await decide(s.orgId, req!.id, { stepNo: 1, decision: 'APPROVE' }, s.hrAdmin)).status).toBe(200);
  });

  it('4-P0-2 the requester\'s secondary manager who is the colleague never stands in (probe S2b)', async () => {
    const r = await swap(s, { date: wd[1], withEmployeeId: eS2.id, reason: 'Family event in the morning' }, r1.user);
    expect(r.status).toBe(201);
    const [req] = await requestsOf(r.body.data.id);
    expect((await actorsOf(req!.id)).map((x) => x.userId)).toEqual([s.managerUser]);
    expect((await decide(s.orgId, req!.id, { stepNo: 1, decision: 'APPROVE' }, eS2.user)).status).toBe(403);
    expect((await decide(s.orgId, req!.id, { stepNo: 1, decision: 'APPROVE' }, s.managerUser)).status).toBe(200);
  });

  it('4-P2-11 approving a swap whose colleague has left since is refused: the system rejects it with the reason (probe S3)', async () => {
    const r = await swap(s, { date: wd[2], withEmployeeId: eT.id, reason: 'Exam in the morning' }, s.employeeUser);
    expect(r.status).toBe(201);
    const [req] = await requestsOf(r.body.data.id);
    await h.admin.updateTable('employees').set({ employmentStatus: 'terminated', exitDate: isoToday(0) }).where('id', '=', eT.id).execute();
    const before = { e1: await assignmentsOf(s.e1), eT: await assignmentsOf(eT.id) };
    const res = await decide(s.orgId, req!.id, { stepNo: 1, decision: 'APPROVE', comment: 'Fine by me' }, s.managerUser);
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'SYSTEM_REJECTED', status: 'REJECTED', requestId: req!.id });
    expect(res.body.message).toMatch(/rejected automatically: .*no longer employed on/);
    // committed: the request and the swap are closed by the system, nobody recorded as the decider, nothing assigned
    expect((await requestsOf(r.body.data.id))[0]).toMatchObject({ status: 'REJECTED', decidedBy: null });
    const row = await swapRow(r.body.data.id);
    expect(row).toMatchObject({ status: 'rejected', decidedBy: null });
    expect(row.decisionNote).toMatch(/no longer employed on/);
    expect({ e1: await assignmentsOf(s.e1), eT: await assignmentsOf(eT.id) }).toEqual(before);
    const timeline = await eventsOf(req!.id);
    expect(timeline.map((e) => e.kind)).toContain('system_rejected');
    expect(timeline.find((e) => e.kind === 'system_rejected')!.detail).toMatchObject({ attemptedBy: s.managerUser, attemptedDecision: 'APPROVED' });
    expect((await auditRows(h.admin, 'approval.system_rejected')).some((x) => x.entityId === req!.id && x.actorUserId === s.managerUser)).toBe(true);
    expect((await domainEvents(h.admin, 'shift.swap_decided')).at(-1)!.payload).toMatchObject({ swapId: r.body.data.id, decision: 'rejected', system: true });
  });

  it('4-P2-12 two colleagues asking the same person for the same day at once file exactly one swap (probe S6); an approved swap holds the day too', async () => {
    const [a, b] = await Promise.all([swap(s, { date: wd[3], withEmployeeId: s.e1, reason: 'Race A' }, e4.user), swap(s, { date: wd[3], withEmployeeId: s.e1, reason: 'Race B' }, eR.user)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const open = await h.admin.selectFrom('shiftSwapRequests').select('id').where('organizationId', '=', s.orgId).where('swapDate', '=', sql<Date>`${wd[3]}::date`).where('status', 'in', ['pending', 'approved']).execute();
    expect(open).toHaveLength(1);
    // wd[0] was swapped by e1 and e3 (approved in the first test): nobody files another swap with either of them that day
    const late = await swap(s, { date: wd[0], withEmployeeId: s.e1, reason: 'After the approval' }, eM.user);
    expect(late.status).toBe(409);
    expect(late.body.message).toMatch(/approved swap/);
  });
});

// ----- P2-13 the branch of the date -------------------------------------------------------------------------------------------

describe('4-P2-13 the portal shift tab and the swap rules use the branch effective on each date', () => {
  it('4-P2-13 after a future-dated transfer, the days before it keep the old branch (probe S5)', async () => {
    const t = await seedOrg(h.admin, 'transfer');
    const MORN = (await h.admin.insertInto('shifts').values({ organizationId: t.orgId, code: 'MORN', name: 'Morning', type: 'FIXED', startTime: '08:00', endTime: '16:00' }).returning('id').executeTakeFirstOrThrow()).id;
    const EVE = (await h.admin.insertInto('shifts').values({ organizationId: t.orgId, code: 'EVE', name: 'Evening', type: 'FIXED', startTime: '14:00', endTime: '22:00' }).returning('id').executeTakeFirstOrThrow()).id;
    await h.admin.insertInto('shiftAssignments').values([
      { organizationId: t.orgId, targetType: 'BRANCH', targetId: t.branchA, branchId: t.branchA, shiftId: MORN, effectiveFrom: '2026-01-01' },
      { organizationId: t.orgId, targetType: 'BRANCH', targetId: t.branchB, branchId: t.branchB, shiftId: EVE, effectiveFrom: '2026-01-01' },
    ]).execute();
    const eX = await linked(t, 18, t.branchA);
    const transfer = isoToday(7);
    const patch = await h.request('PATCH', `${base(t.orgId)}/employees/${eX.id}`, { token: t.owner, body: { branchId: t.branchB, effectiveFrom: transfer, changeReason: 'Transfer next week' } });
    expect(patch.status).toBe(200);
    // the employee row moved at once; the history keeps branch A until the transfer date
    expect((await h.admin.selectFrom('employees').select('branchId').where('id', '=', eX.id).executeTakeFirstOrThrow()).branchId).toBe(t.branchB);
    const before = isoToday(3); const after = isoToday(10);
    const resolved = async (date: string) => (await h.request('GET', `${base(t.orgId)}/shifts/resolve?employeeId=${eX.id}&date=${date}`, { token: t.owner })).body?.data?.shift?.name ?? null;
    expect(await resolved(before)).toBe('Morning');
    expect(await resolved(after)).toBe('Evening');
    const my = await h.request('GET', `${base(t.orgId)}/me/shift`, { token: eX.user });
    expect(my.status).toBe(200);
    expect(my.body.data.today?.shift?.name).toBe('Morning');
    const day = (date: string) => my.body.data.upcoming.find((d: { date: string }) => d.date === date);
    expect(day(before)).toMatchObject({ shift: { name: 'Morning' } });
    expect(day(after)).toMatchObject({ shift: { name: 'Evening' } });
    // candidates: the colleagues of the branch of THAT date
    const candidates = async (date: string) => (await h.request('GET', `${base(t.orgId)}/me/shift-swaps/candidates?date=${date}`, { token: eX.user })).body.data.map((c: { employeeId: string }) => c.employeeId);
    const beforeIds = await candidates(before); const afterIds = await candidates(after);
    expect(beforeIds).toContain(t.e1); expect(beforeIds).not.toContain(t.e2);
    expect(afterIds).toContain(t.e2); expect(afterIds).not.toContain(t.e1);
    // and the swap check: a branch-B colleague before the transfer is from another branch
    const otherBranch = await swap(t, { date: before, withEmployeeId: t.e2, reason: 'Before the transfer' }, eX.user);
    expect(otherBranch.status).toBe(400);
    expect(otherBranch.body.message).toMatch(/within your branch/);
  });
});

// ----- P2-14 one attendance rate --------------------------------------------------------------------------------------------------

describe('4-P2-14 one attendance percentage on /my/attendance', () => {
  it('4-P2-14 the statistics card and the month card agree (approved leave outside the denominator); today\'s open day is never a missing check-out (probe E1)', async () => {
    const st = await seedOrg(h.admin, 'rate');
    const today = DateTime.now().setZone('Asia/Muscat').toISODate()!;
    const monthStart = `${today.slice(0, 8)}01`;
    const past = monthStart < today ? eachDate(monthStart, addDays(today, -1)) : [];
    const pattern: Array<[string, string[]]> = [['PRESENT', []], ['ABSENT', []], ['LEAVE', []], ['HALF_DAY', []], ['MISSING_PUNCH', ['MISSING_OUT']], ['PRESENT', ['LATE']], ['PRESENT', ['HALF_DAY_LEAVE']], ['WEEKLY_OFF', []]];
    const seeded = past.map((d, i) => ({ date: d, status: pattern[i % pattern.length]![0], flags: pattern[i % pattern.length]![1] }));
    for (const x of seeded) await seedDay(st.orgId, st.e1, st.branchA, x.date, x.status, x.flags);
    // today: checked in, the check-out is still to come
    await seedDay(st.orgId, st.e1, st.branchA, today, 'MISSING_PUNCH', ['MISSING_OUT']);
    const all = [...seeded, { date: today, status: 'MISSING_PUNCH', flags: ['MISSING_OUT'] }];
    // the documented definition, computed independently
    let expected = 0; let attended = 0;
    for (const d of all) {
      if (!['PRESENT', 'HALF_DAY', 'ABSENT', 'MISSING_PUNCH'].includes(d.status)) continue;
      const w = d.flags.includes('HALF_DAY_LEAVE') ? 0.5 : 1;
      expected += w;
      attended += w * (d.status === 'PRESENT' || d.status === 'MISSING_PUNCH' ? 1 : d.status === 'HALF_DAY' ? (w === 0.5 ? 1 : 0.5) : 0);
    }
    const stats = await h.request('GET', `${base(st.orgId)}/me/stats?range=month`, { token: st.employeeUser });
    const month = await h.request('GET', `${base(st.orgId)}/me/attendance?month=${today.slice(0, 7)}`, { token: st.employeeUser });
    expect(stats.status).toBe(200); expect(month.status).toBe(200);
    expect(month.body.data.totals.workingDays).toBe(expected);
    expect(month.body.data.totals.attendedDays).toBe(attended);
    expect(stats.body.data.workingDays).toBe(expected);
    const pct = Math.round(Math.min(1, attended / expected) * 1000) / 10;
    expect(stats.body.data.attendancePct).toBe(pct);
    expect(Math.round(month.body.data.totals.attendanceRate * 1000) / 10).toBe(pct);
    // the running day is not a missing punch on either card
    const missingPast = seeded.filter((x) => x.flags.includes('MISSING_OUT')).length;
    expect(month.body.data.totals.missingPunch).toBe(missingPast);
    expect(stats.body.data.missingCheckouts).toBe(missingPast);
  });
});

// ----- P1-5 note edits ---------------------------------------------------------------------------------------------------------------

describe('4-P1-5 editing a reason sends it back for review', () => {
  let n: OrgFixture;
  const patchNote = (id: string, body: Record<string, unknown>) => h.request('PATCH', `${base(n.orgId)}/me/attendance/notes/${id}`, { token: n.employeeUser, body });
  beforeAll(async () => { n = await seedOrg(h.admin, 'noteedit'); });

  it('4-P1-5 a pending reason whose text or category changes invalidates its request and routes a new one (probe N2a)', async () => {
    const d = isoToday(-21);
    await seedDay(n.orgId, n.e1, n.branchA, d, 'ABSENT');
    const r = await note(n, d, { note: 'Text A: I was at the clinic' });
    expect(r.status).toBe(201);
    const id = r.body.data.id as string;
    const [before] = await requestsOf(id);
    // an edit that changes nothing keeps the request
    expect((await patchNote(id, { note: 'Text A: I was at the clinic' })).status).toBe(200);
    expect((await requestsOf(id)).map((x) => [x.id, x.status])).toEqual([[before!.id, 'PENDING']]);
    const p = await patchNote(id, { note: 'Text B: actually a family trip', category: 'other' });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ status: 'pending', note: 'Text B: actually a family trip', category: 'other', approvalStatus: 'PENDING', approvalCurrentStep: 1 });
    const reqs = await requestsOf(id);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ id: before!.id, status: 'INVALIDATED' });
    expect(reqs[0]!.invalidationReason).toMatch(/changed the reason while it was waiting for review/);
    expect(reqs[1]).toMatchObject({ status: 'PENDING', currentStep: 1 });
    expect((await eventsOf(before!.id)).map((e) => e.kind)).toContain('invalidated');
    // the superseded request can no longer be decided
    expect((await decide(n.orgId, before!.id, { stepNo: 1, decision: 'APPROVE' }, n.managerUser)).status).toBe(409);
    expect((await auditRows(h.admin, 'attendance.note_resubmitted')).some((a) => a.entityId === id)).toBe(true);
  });

  it('4-P1-5 a level-1 approval of the old text never carries over to the new one (probe N2b)', async () => {
    const wf = await createWorkflow(n, 'ATTENDANCE_NOTE', [{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'HR_ADMIN' }]);
    try {
      const d = isoToday(-22);
      await seedDay(n.orgId, n.e1, n.branchA, d, 'ABSENT');
      const r = await note(n, d, { note: 'Text A: the manager approved this one' });
      const id = r.body.data.id as string;
      const [req] = await requestsOf(id);
      expect((await decide(n.orgId, req!.id, { stepNo: 1, decision: 'APPROVE', comment: 'A is fine' }, n.managerUser)).status).toBe(200);
      expect((await patchNote(id, { note: 'Text B: a completely different story' })).status).toBe(200);
      const reqs = await requestsOf(id);
      expect(reqs.map((x) => x.status)).toEqual(['INVALIDATED', 'PENDING']);
      expect(reqs[1]).toMatchObject({ currentStep: 1 });
      // the new request starts again at level 1 with nobody's approval on it
      expect((await actorsOf(reqs[1]!.id)).filter((a) => a.decision !== 'PENDING')).toEqual([]);
      // level 2 of the old request can no longer be completed on text B
      expect((await decide(n.orgId, req!.id, { stepNo: 2, decision: 'APPROVE' }, n.hrAdmin)).status).toBe(409);
      expect((await h.admin.selectFrom('attendanceNotes').select(['status', 'note']).where('id', '=', id).executeTakeFirstOrThrow())).toEqual({ status: 'pending', note: 'Text B: a completely different story' });
    } finally { await dropWorkflow(n, wf); }
  });
});

describe('integration: a note whose level is approved over an open question', () => {
  let g: OrgFixture;
  beforeAll(async () => { g = await seedOrg(h.admin, 'noteclose'); });
  it('7-P2-3 (notes) the request moves on without the question and the note is pending again, not waiting on an answer', async () => {
    const wf = await createWorkflow(g, 'ATTENDANCE_NOTE', [{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'HR_ADMIN' }]);
    try {
      const d = isoToday(-23);
      await seedDay(g.orgId, g.e1, g.branchA, d, 'ABSENT');
      const r = await note(g, d, { note: 'I was stuck at the border crossing' });
      const id = r.body.data.id as string;
      const [req] = await requestsOf(id);
      expect((await h.request('POST', `${base(g.orgId)}/approvals/${req!.id}/request-info`, { token: g.managerUser, body: { comment: 'Which crossing?' } })).status).toBe(200);
      expect((await h.admin.selectFrom('attendanceNotes').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('info_requested');
      expect((await decide(g.orgId, req!.id, { stepNo: 1, decision: 'APPROVE' }, g.managerUser)).status).toBe(200);
      const after = await h.admin.selectFrom('approvalRequests').select(['status', 'currentStep', 'infoRequestedAt']).where('id', '=', req!.id).executeTakeFirstOrThrow();
      expect([after.status, after.currentStep, after.infoRequestedAt]).toEqual(['PENDING', 2, null]);
      expect((await h.admin.selectFrom('attendanceNotes').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('pending');
    } finally { await dropWorkflow(g, wf); }
  });
});

// ----- seat choice on the note review ---------------------------------------------------------------------------------------------------

describe('4-seat-choice the HR note review names the seat an override fills (engine §9.8)', () => {
  it('4-seat-choice on a level waiting for several HR admins, an organisation-wide reviewer must name whose seat the decision fills', async () => {
    const sc = await seedOrg(h.admin, 'seat');
    const hr2 = uuid('c');
    await seedUser(h.admin, hr2, 'hr2-seat@test.local', 'HR Two');
    await seedMembership(h.admin, sc.orgId, hr2, ROLE.hr_admin);
    const wf = await createWorkflow(sc, 'ATTENDANCE_NOTE', [{ order: 1, approverType: 'ROLE', roleId: ROLE.hr_admin, mode: 'ALL' }]);
    try {
      const d = isoToday(-9);
      await seedDay(sc.orgId, sc.e1, sc.branchA, d, 'ABSENT');
      const r = await note(sc, d);
      const id = r.body.data.id as string;
      const [req] = await requestsOf(id);
      expect((await actorsOf(req!.id)).map((a) => a.userId)).toEqual([sc.hrAdmin, hr2].sort());
      const seen = await h.request('GET', `${base(sc.orgId)}/approvals/${req!.id}`, { token: sc.owner });
      expect(seen.body.data.abilities).toMatchObject({ canDecide: true, decideVia: 'override', mustChooseSeat: true });
      const unnamed = await review(sc, id, { decision: 'approve' }, sc.owner);
      expect(unnamed.status).toBe(400);
      expect(unnamed.body.message).toMatch(/^Choose which approver you are deciding for/);
      expect((await review(sc, id, { decision: 'approve', onBehalfOfUserId: sc.hrUser }, sc.owner)).status).toBe(400);
      expect((await actorsOf(req!.id)).every((a) => a.decision === 'PENDING')).toBe(true);
      const named = await review(sc, id, { decision: 'approve', reason: 'Checked with HR Two', onBehalfOfUserId: hr2 }, sc.owner);
      expect(named.status).toBe(200);
      expect(named.body.data).toMatchObject({ requestStatus: 'PENDING', terminal: false, note: { status: 'pending' } });
      expect((await actorsOf(req!.id)).find((a) => a.userId === sc.owner)).toMatchObject({ onBehalfOfUserId: hr2, decision: 'APPROVED', resolutionPath: 'override' });
      expect((await h.admin.selectFrom('audit.logs').select(['newValue']).where('entityId', '=', id).where('action', 'like', 'attendance.note_%').execute())
        .some((a) => (a.newValue as Record<string, unknown> | null)?.['onBehalfOfUserId'] === hr2)).toBe(true);
      // the remaining seated HR admin decides their own seat: nothing to choose
      const last = await review(sc, id, { decision: 'approve' }, sc.hrAdmin);
      expect(last.status).toBe(200);
      expect(last.body.data).toMatchObject({ requestStatus: 'APPROVED', terminal: true, note: { status: 'approved' } });
    } finally { await dropWorkflow(sc, wf); }
  });
});

// ----- regularisations: P1-6, P2-9, P2-10 ------------------------------------------------------------------------------------------------

describe('regularisations', () => {
  let rg: OrgFixture;
  const correctionsOf = (requestId: string) => h.admin.selectFrom('attendanceCorrections').select(['id', 'type', 'originalEventId', 'proposedEventType', 'proposedPunchedAt', 'proposedStatus', 'status']).where('approvalRequestId', '=', requestId).orderBy('createdAt').execute();
  const addEvent = async (date: string, time: string, eventType: 'PUNCH_IN' | 'PUNCH_OUT' | 'PUNCH') => (await h.admin.insertInto('attendanceEvents').values({ organizationId: rg.orgId, employeeId: rg.e1, branchId: rg.branchA, punchedAt: new Date(`${date}T${time}Z`), eventType, source: 'DEVICE' }).returning('id').executeTakeFirstOrThrow()).id;
  const approveRegularisation = async (id: string) => {
    const [req] = await requestsOf(id);
    const ok = await decide(rg.orgId, req!.id, { stepNo: 1, decision: 'APPROVE' }, rg.managerUser);
    expect(ok.status).toBe(200);
    return req!.id;
  };
  beforeAll(async () => { rg = await seedOrg(h.admin, 'regfix'); });

  it('4-P1-6 a wrong check-out on a day with only a check-in adds the check-out; the check-in is never edited into one (probe R1)', async () => {
    const d = isoToday(-2);
    const inEvent = await addEvent(d, '06:30:00', 'PUNCH_IN');
    const r = await regularise(rg, { date: d, type: 'wrong_punch', proposedOutAt: `${d}T13:00:00Z`, reason: 'I left at 17:00; the terminal recorded nothing' });
    expect(r.status).toBe(201);
    const corr = await correctionsOf(await approveRegularisation(r.body.data.id));
    expect(corr.map((c) => `${c.type}:${c.proposedEventType}`)).toEqual(['ADD_PUNCH:PUNCH_OUT']);
    expect(corr.some((c) => c.originalEventId === inEvent)).toBe(false);
  });

  it('4-P1-6 a wrong check-in on a day with only a check-out adds the check-in (probe R1b); a punch without a direction is never guessed at', async () => {
    const d = isoToday(-3);
    const outEvent = await addEvent(d, '13:30:00', 'PUNCH_OUT');
    const r = await regularise(rg, { date: d, type: 'wrong_punch', proposedInAt: `${d}T05:00:00Z`, reason: 'I arrived at 09:00; the terminal missed it' });
    const corr = await correctionsOf(await approveRegularisation(r.body.data.id));
    expect(corr.map((c) => `${c.type}:${c.proposedEventType}`)).toEqual(['ADD_PUNCH:PUNCH_IN']);
    expect(corr.some((c) => c.originalEventId === outEvent)).toBe(false);
    // a direction-less device punch is not taken for the check-in either
    const d2 = isoToday(-4);
    const plain = await addEvent(d2, '06:00:00', 'PUNCH');
    const r2 = await regularise(rg, { date: d2, type: 'wrong_punch', proposedInAt: `${d2}T05:00:00Z`, reason: 'The clock of the terminal was wrong' });
    const corr2 = await correctionsOf(await approveRegularisation(r2.body.data.id));
    expect(corr2.map((c) => `${c.type}:${c.proposedEventType}`)).toEqual(['ADD_PUNCH:PUNCH_IN']);
    expect(corr2.some((c) => c.originalEventId === plain)).toBe(false);
    // and a same-direction punch IS edited
    const d3 = isoToday(-5);
    const own = await addEvent(d3, '06:30:00', 'PUNCH_IN');
    const r3 = await regularise(rg, { date: d3, type: 'wrong_punch', proposedInAt: `${d3}T05:00:00Z`, reason: 'The terminal clock was 90 minutes fast' });
    expect(await correctionsOf(await approveRegularisation(r3.body.data.id))).toEqual([expect.objectContaining({ type: 'EDIT_PUNCH', originalEventId: own, proposedEventType: 'PUNCH_IN' })]);
  });

  it('4-P2-9 regularisation requests have their own switch; approved ones are applied on behalf of the approval, whatever direct corrections allow (probe R3)', async () => {
    const d = isoToday(-6);
    await setSelfService(rg.orgId, { regularisation: false });
    const off = await regularise(rg, { date: d, type: 'wfh_unmarked', reason: 'I worked from home all day' });
    expect(off.status).toBe(403);
    expect(off.body.details).toMatchObject({ reason: 'REGULARISATION_DISABLED' });
    await setSelfService(rg.orgId, { regularisation: true });
    // direct self-service corrections stay HR's (the default): a status change is refused to the employee...
    const direct = await h.request('POST', `${base(rg.orgId)}/attendance/corrections`, { token: rg.employeeUser, body: { employeeId: rg.e1, attendanceDate: d, type: 'SET_STATUS', proposedStatus: 'PRESENT', reason: 'I worked from home' }, headers: { 'Idempotency-Key': key() } });
    expect(direct.status).toBe(403);
    // ...while the regularisation, decided through its own approval, is applied on the approver's behalf
    const r = await regularise(rg, { date: d, type: 'wfh_unmarked', reason: 'I worked from home all day' });
    expect(r.status).toBe(201);
    const requestId = await approveRegularisation(r.body.data.id);
    const corr = await correctionsOf(requestId);
    expect(corr.map((c) => `${c.type}:${c.proposedStatus}:${c.status}`)).toEqual(['SET_STATUS:PRESENT:APPROVED']);
    const applied = (await auditRows(h.admin, 'attendance.regularisation_applied')).find((a) => a.entityId === r.body.data.id);
    expect(applied).toMatchObject({ actorUserId: rg.managerUser, newValue: expect.objectContaining({ approvedBy: rg.managerUser, onBehalfOfApproval: requestId, correctionIds: corr.map((c) => c.id) }) });
  });

  it('4-P2-10 applying a regularisation never duplicates an approved correction or a punch the day already has (probe R2)', async () => {
    await setAttendance(rg.orgId, { allowSelfServiceCorrections: true });
    try {
      const d = isoToday(-7);
      const at = new Date(`${d}T05:00:00Z`);
      const c = await h.request('POST', `${base(rg.orgId)}/attendance/corrections`, { token: rg.employeeUser, body: { employeeId: rg.e1, attendanceDate: d, type: 'ADD_PUNCH', proposedPunchedAt: at.toISOString(), proposedEventType: 'PUNCH_IN', reason: 'Forgot to punch in' }, headers: { 'Idempotency-Key': key() } });
      expect(c.status).toBe(201);
      const r = await regularise(rg, { date: d, type: 'missed_punch', proposedInAt: at.toISOString(), reason: 'Forgot to punch in (again)' });
      expect(r.status).toBe(201);
      const cReq = c.body.data.approvalRequestId as string;
      const approver = (await actorsOf(cReq)).map((a) => a.userId).find((u) => u === rg.hrAdmin) ?? (await actorsOf(cReq))[0]!.userId;
      expect((await decide(rg.orgId, cReq, { stepNo: 1, decision: 'APPROVE' }, approver)).status).toBe(200);
      const regRequest = await approveRegularisation(r.body.data.id);
      const approved = await h.admin.selectFrom('attendanceCorrections').select(['id']).where('employeeId', '=', rg.e1).where('attendanceDate', '=', sql<Date>`${d}::date`)
        .where('status', 'in', ['APPROVED', 'APPLIED']).where('type', '=', 'ADD_PUNCH').where('proposedPunchedAt', '=', at).execute();
      expect(approved).toHaveLength(1);
      expect(await correctionsOf(regRequest)).toEqual([]);
      const audit = (await auditRows(h.admin, 'attendance.regularisation_applied')).find((a) => a.entityId === r.body.data.id);
      expect((audit!.newValue as { skipped: Array<{ why: string }> }).skipped).toEqual([expect.objectContaining({ type: 'ADD_PUNCH', why: expect.stringMatching(/equivalent correction is already approved/) })]);
    } finally { await setAttendance(rg.orgId, { allowSelfServiceCorrections: false }); }

    // a punch the day already has at the same instant, in the same direction, is not added again
    const d2 = isoToday(-8);
    await addEvent(d2, '05:00:00', 'PUNCH_IN');
    const r2 = await regularise(rg, { date: d2, type: 'missed_punch', proposedInAt: `${d2}T05:00:00Z`, proposedOutAt: `${d2}T13:00:00Z`, reason: 'The terminal lost my check-out' });
    const corr2 = await correctionsOf(await approveRegularisation(r2.body.data.id));
    expect(corr2.map((c) => `${c.type}:${c.proposedEventType}`)).toEqual(['ADD_PUNCH:PUNCH_OUT']);
    const audit2 = (await auditRows(h.admin, 'attendance.regularisation_applied')).find((a) => a.entityId === r2.body.data.id);
    expect((audit2!.newValue as { skipped: Array<{ why: string }> }).skipped).toEqual([expect.objectContaining({ why: 'the day already has this check-in' })]);
  });
});

// ----- ATT-82 special leave --------------------------------------------------------------------------------------------------------------

describe('4-ATT-82 marriage, bereavement, adoption and compassionate leave are never charged for an unexcused day', () => {
  it('4-ATT-82 a full-day rejection with annual leave exhausted is loss of pay, not a special leave (probe N5)', async () => {
    const sp = await seedOrg(h.admin, 'special');
    await h.admin.insertInto('leaveTypes').values([
      { organizationId: sp.orgId, code: 'AL', name: 'Annual Leave', isPaid: true, annualAllowanceDays: 0 },
      { organizationId: sp.orgId, code: 'MARRIAGE', name: 'Marriage Leave', isPaid: true, annualAllowanceDays: 5 },
      { organizationId: sp.orgId, code: 'BEREAVEMENT', name: 'Bereavement Leave', isPaid: true, annualAllowanceDays: 5 },
      { organizationId: sp.orgId, code: 'ADOPTION', name: 'Adoption Leave', isPaid: true, annualAllowanceDays: 5 },
      { organizationId: sp.orgId, code: 'COMPASSIONATE', name: 'Compassionate Leave', isPaid: true, annualAllowanceDays: 5 },
    ]).execute();
    const d = isoToday(-15);
    await seedDay(sp.orgId, sp.e1, sp.branchA, d, 'ABSENT');
    const n = await note(sp, d);
    const rejected = await review(sp, n.body.data.id, { decision: 'reject', payEffectDays: 1, reason: 'No proof' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.charge).toMatchObject({ outcome: 'lop', leaveTypeCode: null });
    expect(await h.admin.selectFrom('leaveRecords').select('id').where('organizationId', '=', sp.orgId).where('employeeId', '=', sp.e1).execute()).toEqual([]);
  });
});

// ----- P2-18 without the edge secret --------------------------------------------------------------------------------------------

describe('4-P2-18 without EDGE_SHARED_SECRET the IP allow-list is off', () => {
  it('4-P2-18 a list cannot be saved, and one saved earlier is ignored with a warning (never trust a forwarded header)', async () => {
    const ip = await seedOrg(h.admin, 'noedge');
    const current = (await h.request('GET', `${base(ip.orgId)}/settings/attendance`, { token: ip.owner })).body.data;
    const refused = await h.request('PUT', `${base(ip.orgId)}/settings/attendance`, { token: ip.owner, body: { ...current, selfService: { ...current.selfService, webCheckIn: true, ipAllowList: ['10.0.0.0/8'] } } });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/EDGE_SHARED_SECRET/);
    const saved = await h.request('PUT', `${base(ip.orgId)}/settings/attendance`, { token: ip.owner, body: { ...current, selfService: { ...current.selfService, webCheckIn: true, requireGeofence: 'off', ipAllowList: [] } } });
    expect(saved.status).toBe(200);
    // a list stored before the fix (written straight to the row)
    await setSelfService(ip.orgId, { ipAllowList: ['10.0.0.0/8'] });
    const warn = vi.spyOn(h.deps.log, 'warn');
    try {
      const r = await h.request('POST', `${base(ip.orgId)}/me/punch`, { token: ip.employeeUser, body: { direction: 'in', channel: 'web', idempotencyKey: key() }, headers: { 'x-forwarded-for': '192.168.1.5' } });
      expect(r.status).toBe(201);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'ip_allow_list_ignored', organizationId: ip.orgId }));
    } finally { warn.mockRestore(); }
  });
});
