/**
 * HR admin parity (HR portal Prompt 6b): the regularisation register — decisions only through the approval engine, bulk with
 * per-item authorisation and results — and the comments & approvals report with its CSV (report.export, escaped, audited).
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditRows, createApiHarness, isoToday, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
const emp2 = uuid('c'); const lineMgr = uuid('c'); const emp6 = uuid('c');
let e5: string; let e6: string;
const base = () => `/api/v1/orgs/${f.orgId}`;
const reg = (token: string, date: string, body: Record<string, unknown> = {}) => h.request('POST', `${base()}/me/regularisations`, { token, body: { date, type: 'missed_punch', proposedInAt: `${date}T05:00:00Z`, proposedOutAt: `${date}T13:00:00Z`, reason: 'The terminal was offline', ...body } });
async function requestOf(entityId: string) {
  return h.admin.selectFrom('approvalRequests').selectAll().where('entityId', '=', entityId).orderBy('createdAt', 'desc').executeTakeFirstOrThrow();
}
async function seedDay(employeeId: string, branchId: string, date: string, status: string, flags: string[] = []) {
  await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId, attendanceDate: date, branchId, timezone: 'Asia/Muscat', engineVersion: 'test', status: status as never, flags, workedMinutes: 0, trace: JSON.stringify({ punches: [] }) }).execute();
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_att_admin_${process.pid}`); f = await seedOrg(h.admin, 'attadm');
  await seedUser(h.admin, emp2, 'emp2-attadm@test.local', 'Employee Two');
  await seedMembership(h.admin, f.orgId, emp2, ROLE.employee, { employeeId: f.e2 });
  // e5 reports to e4 (lineMgr, manager role: attendance.approve without attendance.view / report.export); e6 has a login too
  const e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4);
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5, { managerEmployeeId: e4 });
  e6 = await seedEmployee(h.admin, f.orgId, f.branchA, 6, { managerEmployeeId: e4 });
  await seedUser(h.admin, lineMgr, 'linemgr-attadm@test.local', 'Line Manager');
  await seedMembership(h.admin, f.orgId, lineMgr, ROLE.manager, { employeeId: e4 });
  await seedUser(h.admin, emp6, 'emp6-attadm@test.local', 'Employee Six');
  await seedMembership(h.admin, f.orgId, emp6, ROLE.employee, { employeeId: e6 });
});
afterAll(async () => { await h?.close(); });

describe('regularisation register', () => {
  let regA: string; let regB: string; let regC: string; let regD: string;
  beforeAll(async () => {
    regA = (await reg(f.employeeUser, isoToday(-10))).body.data.id;
    regB = (await reg(emp2, isoToday(-10), { reason: '=HYPERLINK("http://evil")' })).body.data.id;
    regC = (await reg(f.employeeUser, isoToday(-9), { type: 'wfh_unmarked', proposedInAt: undefined, proposedOutAt: undefined, reason: 'Worked from home' })).body.data.id;
    regD = (await reg(emp2, isoToday(-9))).body.data.id;
    expect([regA, regB, regC, regD].every(Boolean)).toBe(true);
  });

  it('lists the organisation\'s requests with the current level and approver (org-wide, branch-scoped by RLS)', async () => {
    const all = await h.request('GET', `${base()}/attendance/regularisations`, { token: f.hrAdmin });
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(4);
    const a = all.body.data.find((x: { id: string }) => x.id === regA);
    expect(a).toMatchObject({ employeeName: 'Employee 1', branchName: 'Branch A', status: 'pending', approvalStatus: 'PENDING', approvalCurrentStep: 1 });
    expect(a.approval).toMatchObject({ status: 'PENDING', currentStep: 1, stepCount: 1, approverType: 'MANAGER', canDecide: true, decideVia: 'override' });
    expect(a.approval.approvers.map((x: { userId: string }) => x.userId)).toEqual([f.managerUser]);
    // the seated manager decides as actor
    const mgr = await h.request('GET', `${base()}/attendance/regularisations?search=Employee 1`, { token: f.managerUser });
    expect(mgr.body.data.map((x: { id: string }) => x.id).sort()).toEqual([regA, regC].sort());
    expect(mgr.body.data.find((x: { id: string }) => x.id === regA).approval).toMatchObject({ canDecide: true, decideVia: 'actor' });
    // branch B's manager reads branch B only
    const bm = await h.request('GET', `${base()}/attendance/regularisations`, { token: f.branchManagerB });
    expect(bm.body.data.map((x: { id: string }) => x.id).sort()).toEqual([regB, regD].sort());
    // filters
    expect((await h.request('GET', `${base()}/attendance/regularisations?type=wfh_unmarked`, { token: f.hrAdmin })).body.data.map((x: { id: string }) => x.id)).toEqual([regC]);
    expect((await h.request('GET', `${base()}/attendance/regularisations?from=${isoToday(-9)}&to=${isoToday(-9)}`, { token: f.hrAdmin })).body.meta.total).toBe(2);
    expect((await h.request('GET', `${base()}/attendance/regularisations?branchId=${f.branchB}`, { token: f.hrAdmin })).body.meta.total).toBe(2);
    expect((await h.request('GET', `${base()}/attendance/regularisations?branchId=${f.branchA}`, { token: f.branchManagerB })).status).toBe(403);
    // attendance.approve or attendance.review_notes is required
    expect((await h.request('GET', `${base()}/attendance/regularisations`, { token: f.payrollUser })).status).toBe(403);
    expect((await h.request('GET', `${base()}/attendance/regularisations`, { token: f.employeeUser })).status).toBe(403);
  });

  it('a single decision goes through the engine on the linked request (an override names its level)', async () => {
    expect((await h.request('POST', `${base()}/attendance/regularisations/${regA}/decide`, { token: f.hrAdmin, body: { decision: 'approve' } })).status).toBe(400);
    const r = await h.request('POST', `${base()}/attendance/regularisations/${regA}/decide`, { token: f.hrAdmin, body: { decision: 'approve', stepNo: 1, comment: 'Checked the gate log' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: regA, ok: true, status: 'approved', requestStatus: 'APPROVED' });
    const req = await requestOf(regA);
    expect(req.status).toBe('APPROVED');
    const row = await h.admin.selectFrom('attendanceRegularisationRequests').selectAll().where('id', '=', regA).executeTakeFirstOrThrow();
    expect(row.appliedCorrectionId).not.toBeNull();
    expect((await auditRows(h.admin, 'attendance.regularisation_approved')).some((x) => x.entityId === regA)).toBe(true);
    // a second decision on a decided request is refused
    expect((await h.request('POST', `${base()}/attendance/regularisations/${regA}/decide`, { token: f.hrAdmin, body: { decision: 'approve', stepNo: 1 } })).status).toBe(409);
    // a rejection needs a comment
    expect((await h.request('POST', `${base()}/attendance/regularisations/${regC}/decide`, { token: f.managerUser, body: { decision: 'reject' } })).status).toBe(400);
  });

  it('bulk: every item is authorised on its own; refusals do not stop the others; the engine state agrees', async () => {
    // branch B's manager may override branch B's requests but cannot see branch A's
    const r = await h.request('POST', `${base()}/attendance/regularisations/bulk-decide`, { token: f.branchManagerB, body: { items: [{ id: regB, stepNo: 1 }, { id: regC, stepNo: 1 }, { id: regD, stepNo: 1 }], decision: 'reject', comment: 'Please attach the gate log' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ succeeded: 2, failed: 1 });
    const byId = new Map(r.body.data.results.map((x: { id: string }) => [x.id, x]));
    expect(byId.get(regB)).toMatchObject({ ok: true, status: 'rejected', requestStatus: 'REJECTED' });
    expect(byId.get(regD)).toMatchObject({ ok: true, status: 'rejected' });
    expect(byId.get(regC)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect((await requestOf(regB)).status).toBe('REJECTED');
    expect((await requestOf(regC)).status).toBe('PENDING');
    expect((await auditRows(h.admin, 'attendance.regularisations_bulk_decided')).at(0)!.newValue).toMatchObject({ decision: 'reject', count: 3, succeeded: 2, failed: 1 });
    // a decided one reports its state per item
    const again = await h.request('POST', `${base()}/attendance/regularisations/bulk-decide`, { token: f.hrAdmin, body: { items: [{ id: regB, stepNo: 1 }, { id: regC, stepNo: 1 }], decision: 'approve' } });
    expect(again.body.data.results).toEqual([
      expect.objectContaining({ id: regB, ok: false, code: 'INVALID_STATE' }),
      expect.objectContaining({ id: regC, ok: true, status: 'approved' }),
    ]);
    // a line manager without organisation-wide keys decides only the levels they sit on
    const e5reg = (await reg(emp6, isoToday(-8))).body.data.id as string;
    const lm = await h.request('POST', `${base()}/attendance/regularisations/bulk-decide`, { token: lineMgr, body: { items: [{ id: e5reg, stepNo: 1 }], decision: 'approve' } });
    expect(lm.body.data.results[0]).toMatchObject({ ok: true, status: 'approved' });
    // no key → 403; reject without comment → 400; duplicates → 400
    expect((await h.request('POST', `${base()}/attendance/regularisations/bulk-decide`, { token: f.employeeUser, body: { items: [{ id: regD }], decision: 'approve' } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/attendance/regularisations/bulk-decide`, { token: f.hrAdmin, body: { items: [{ id: regD }], decision: 'reject' } })).status).toBe(400);
    expect((await h.request('POST', `${base()}/attendance/regularisations/bulk-decide`, { token: f.hrAdmin, body: { items: [{ id: regD }, { id: regD }], decision: 'approve' } })).status).toBe(400);
  });

  it('CSV export: report.export, formula-escaped, audited with its row count', async () => {
    const ok = await h.request('GET', `${base()}/attendance/regularisations/export`, { token: f.hrAdmin });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ contentType: 'text/csv', rowCount: 5 });
    const csv = ok.body.data.content as string;
    expect(csv.startsWith('﻿Employee No.,Employee,')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect((await auditRows(h.admin, 'attendance.regularisations_exported')).at(0)!.newValue).toMatchObject({ rowCount: 5 });
    // the manager role decides but does not export
    expect((await h.request('GET', `${base()}/attendance/regularisations/export`, { token: lineMgr })).status).toBe(403);
  });
});

describe('comments & approvals report', () => {
  beforeAll(async () => {
    await seedDay(f.e1, f.branchA, isoToday(-20), 'ABSENT');
    await seedDay(f.e1, f.branchA, isoToday(-19), 'PRESENT', ['LATE']);
    await seedDay(e5, f.branchA, isoToday(-20), 'ABSENT');
    const n1 = await h.request('POST', `${base()}/me/attendance/notes`, { token: f.employeeUser, body: { date: isoToday(-20), category: 'absence_reason', note: '=SUM(A1:A2) was sick' } });
    const n2 = await h.request('POST', `${base()}/me/attendance/notes`, { token: f.employeeUser, body: { date: isoToday(-19), category: 'late_reason', note: 'Traffic' } });
    expect(n1.status).toBe(201); expect(n2.status).toBe(201);
    // the line manager rejects one with a half-day pay effect and excuses the other
    expect((await h.request('POST', `${base()}/attendance/notes/${n1.body.data.id}/review`, { token: f.managerUser, body: { decision: 'reject', payEffectDays: 0.5, reason: 'No certificate' } })).status).toBe(200);
    expect((await h.request('POST', `${base()}/attendance/notes/${n2.body.data.id}/review`, { token: f.managerUser, body: { decision: 'excuse' } })).status).toBe(200);
    await h.admin.insertInto('attendanceNotes').values({ organizationId: f.orgId, employeeId: e5, branchId: f.branchA, attendanceDate: isoToday(-20), category: 'other', note: 'Pending one', status: 'pending' }).execute();
  });

  it('one row per reason with the day, the review, the pay effect and the excused count (oversight scope)', async () => {
    const r = await h.request('GET', `${base()}/attendance/notes/report?from=${isoToday(-30)}&to=${isoToday(0)}`, { token: f.hrAdmin });
    expect(r.status).toBe(200);
    expect(r.body.meta.totals).toMatchObject({ total: 3, pending: 1, rejected: 1, excused: 1 });
    const rejected = r.body.data.find((x: { status: string }) => x.status === 'rejected');
    expect(rejected).toMatchObject({ employeeName: 'Employee 1', dayStatus: 'ABSENT', category: 'absence_reason', payEffectDays: 0.5, reviewedByName: 'managerUser', reviewVia: 'manager', isOversight: true });
    expect(['leave', 'lop', 'none']).toContain(rejected.impact);
    const excused = r.body.data.find((x: { status: string }) => x.status === 'excused');
    expect(excused).toMatchObject({ impact: 'excused', excusedCountYear: 1, dayFlags: ['LATE'] });
    // filters
    expect((await h.request('GET', `${base()}/attendance/notes/report?from=${isoToday(-30)}&to=${isoToday(0)}&status=pending`, { token: f.hrAdmin })).body.meta.total).toBe(1);
    expect((await h.request('GET', `${base()}/attendance/notes/report?from=${isoToday(-30)}&to=${isoToday(0)}&category=late_reason`, { token: f.hrAdmin })).body.meta.total).toBe(1);
    // team scope: the line manager of e5 sees e5's reason only; scope all needs oversight keys
    const lm = await h.request('GET', `${base()}/attendance/notes/report?scope=team&from=${isoToday(-30)}&to=${isoToday(0)}`, { token: lineMgr });
    expect(lm.body.data.map((x: { employeeId: string }) => x.employeeId)).toEqual([e5]);
    expect(lm.body.data[0].isOversight).toBe(false);
    expect((await h.request('GET', `${base()}/attendance/notes/report?scope=all&from=${isoToday(-30)}&to=${isoToday(0)}`, { token: lineMgr })).status).toBe(403);
    expect((await h.request('GET', `${base()}/attendance/notes/report?from=${isoToday(-400)}&to=${isoToday(0)}`, { token: f.hrAdmin })).status).toBe(400);
  });

  it('CSV needs report.export; formula-leading comments are escaped; the export is audited with its row count', async () => {
    const r = await h.request('GET', `${base()}/attendance/notes/report/export?from=${isoToday(-30)}&to=${isoToday(0)}`, { token: f.hrUser });
    expect(r.status).toBe(200);
    expect(r.body.data.rowCount).toBe(3);
    expect(r.body.data.content).toContain(`'=SUM(A1:A2) was sick`);
    expect((await auditRows(h.admin, 'attendance.notes_report_exported')).at(0)!.newValue).toMatchObject({ rowCount: 3 });
    expect((await h.request('GET', `${base()}/attendance/notes/report/export?scope=team&from=${isoToday(-30)}&to=${isoToday(0)}`, { token: lineMgr })).status).toBe(403);
  });
});

describe('the regularisation register reads under the caller\'s RLS', () => {
  it('a crafted id outside the caller\'s branch is not found for decisions', async () => {
    const other = (await reg(emp2, isoToday(-7))).body.data.id as string;
    const r = await h.request('POST', `${base()}/attendance/regularisations/${other}/decide`, { token: lineMgr, body: { decision: 'approve', stepNo: 1 } });
    expect(r.status).toBe(404);
    const still = await h.admin.selectFrom('attendanceRegularisationRequests').select('status').where('id', '=', other).where('organizationId', '=', f.orgId).where(sql<boolean>`true`).executeTakeFirstOrThrow();
    expect(still.status).toBe('pending');
  });
});

describe('5-P1-1 the register names the seat an override fills (engine §9.8)', () => {
  const hr2 = uuid('c');
  const decideOne = (id: string, token: string, body: Record<string, unknown>) => h.request('POST', `${base()}/attendance/regularisations/${id}/decide`, { token, body });
  beforeAll(async () => {
    await seedUser(h.admin, hr2, 'hr2-attadm@test.local', 'HR Two');
    await seedMembership(h.admin, f.orgId, hr2, ROLE.hr_admin);
    // one level that needs EVERY HR admin: an override must say whose seat it fills
    const wf = await h.request('POST', `${base()}/approval-workflows`, { token: f.owner, body: { name: 'Regularisations — every HR admin', entityType: 'REGULARISATION', steps: [{ order: 1, approverType: 'ROLE', roleId: ROLE.hr_admin, mode: 'ALL' }] } });
    expect(wf.status).toBe(201);
  });
  afterAll(async () => { await h.admin.deleteFrom('approvalWorkflows').where('organizationId', '=', f.orgId).where('entityType', '=', 'REGULARISATION').execute(); });

  it('5-P1-1 the register decides an override on an ALL level with several waiting seats — single and bulk name the seat', async () => {
    const one = (await reg(f.employeeUser, isoToday(-5))).body.data.id as string;
    const two = (await reg(f.employeeUser, isoToday(-4))).body.data.id as string;
    const three = (await reg(f.employeeUser, isoToday(-3))).body.data.id as string;
    // the row says a seat must be chosen and lists the waiting seats — what the inbox says for the same request
    const list = await h.request('GET', `${base()}/attendance/regularisations?status=pending`, { token: f.owner });
    const row = list.body.data.find((x: { id: string }) => x.id === one);
    expect(row.approval).toMatchObject({ canDecide: true, decideVia: 'override', mustChooseSeat: true });
    expect(row.approval.pendingSeats.map((s: { userId: string }) => s.userId).sort()).toEqual([f.hrAdmin, hr2].sort());
    expect(row.approval.pendingSeats.every((s: { userName: string | null }) => !!s.userName)).toBe(true);
    const inbox = await h.request('GET', `${base()}/approvals/${(await requestOf(one)).id}`, { token: f.owner });
    expect(inbox.body.data.steps[0].pendingSeats.map((s: { userId: string }) => s.userId)).toEqual(row.approval.pendingSeats.map((s: { userId: string }) => s.userId));
    // unnamed: the engine's own refusal; nothing decided
    const unnamed = await decideOne(one, f.owner, { decision: 'approve', stepNo: 1 });
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.message).toMatch(/^Choose which approver you are deciding for/);
    // named: fills exactly that seat — the level still waits for the other HR admin
    const named = await decideOne(one, f.owner, { decision: 'approve', stepNo: 1, onBehalfOfUserId: hr2, comment: 'For HR Two' });
    expect(named.status).toBe(200);
    expect(named.body.data).toMatchObject({ ok: true, requestStatus: 'PENDING' });
    const actors = await h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select(['a.userId', 'a.onBehalfOfUserId', 'a.decision']).where('s.requestId', '=', (await requestOf(one)).id).execute();
    expect(actors.find((a) => a.userId === f.owner)).toMatchObject({ onBehalfOfUserId: hr2, decision: 'APPROVED' });
    expect((await auditRows(h.admin, 'attendance.regularisation_approved')).find((a) => a.entityId === one)!.newValue).toMatchObject({ onBehalfOfUserId: hr2, requestStatus: 'PENDING' });
    // the seated HR admin decides their own (last) seat without choosing
    const hrRow = (await h.request('GET', `${base()}/attendance/regularisations?status=pending`, { token: f.hrAdmin })).body.data.find((x: { id: string }) => x.id === one);
    expect(hrRow.approval).toMatchObject({ decideVia: 'actor', mustChooseSeat: false });
    expect((await decideOne(one, f.hrAdmin, { decision: 'approve', stepNo: 1 })).body.data).toMatchObject({ ok: true, status: 'approved', requestStatus: 'APPROVED' });
    // bulk: per item — a named item fills its seat; an unnamed one fails on its own and stays pending
    const bulk = await h.request('POST', `${base()}/attendance/regularisations/bulk-decide`, { token: f.owner, body: { items: [{ id: two, stepNo: 1, onBehalfOfUserId: f.hrAdmin }, { id: three, stepNo: 1 }], decision: 'approve' } });
    expect(bulk.status).toBe(200);
    const byId = new Map(bulk.body.data.results.map((x: { id: string }) => [x.id, x]));
    expect(byId.get(two)).toMatchObject({ ok: true, requestStatus: 'PENDING' });
    expect(byId.get(three)).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect((await requestOf(three)).status).toBe('PENDING');
    const twoActors = await h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select(['a.userId', 'a.onBehalfOfUserId', 'a.decision']).where('s.requestId', '=', (await requestOf(two)).id).execute();
    expect(twoActors.find((a) => a.userId === f.owner)).toMatchObject({ onBehalfOfUserId: f.hrAdmin, decision: 'APPROVED' });
    // the remaining seat is hr2's own: they see no choice to make and complete the level
    const own = await h.request('GET', `${base()}/attendance/regularisations?status=pending`, { token: hr2 });
    expect(own.body.data.find((x: { id: string }) => x.id === two).approval).toMatchObject({ decideVia: 'actor', mustChooseSeat: false });
    const done = await h.request('POST', `${base()}/attendance/regularisations/bulk-decide`, { token: hr2, body: { items: [{ id: two, stepNo: 1 }], decision: 'approve' } });
    expect(done.body.data.results[0]).toMatchObject({ ok: true, status: 'approved', requestStatus: 'APPROVED' });
  });
});

describe('5-P2-8 quota refusals say when to come back', () => {
  it('5-P2-8 a 429 from an organisation export quota carries Retry-After', async () => {
    const hour = 3_600_000;
    const windows = [new Date(Math.floor(Date.now() / hour) * hour), new Date(Math.floor(Date.now() / hour) * hour + hour)];
    for (const [metric, path, token] of [
      ['regularisation_exports', `${base()}/attendance/regularisations/export`, f.hrAdmin],
      ['attendance_notes_report_exports', `${base()}/attendance/notes/report/export?from=${isoToday(-30)}&to=${isoToday(0)}`, f.hrUser],
    ] as const) {
      for (const windowStart of windows) {
        await h.admin.insertInto('usageQuotas').values({ organizationId: f.orgId, metric, windowStart, windowSeconds: 3600, count: 10_000 })
          .onConflict((oc) => oc.columns(['organizationId', 'metric', 'windowStart']).doUpdateSet({ count: 10_000 })).execute();
      }
      const r = await h.request('GET', path, { token });
      expect(r.status).toBe(429);
      expect(r.body.code).toBe('RATE_LIMITED');
      const retry = Number(r.headers.get('retry-after'));
      expect(Number.isInteger(retry)).toBe(true);
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(3600);
    }
  });
});
