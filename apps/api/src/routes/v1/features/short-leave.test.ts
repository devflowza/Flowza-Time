/**
 * Short leave (migration 20261019000310): permission types (CRUD, seed, a one-field PATCH changes one field), the portal request
 * and its validation matrix (applicability, length, monthly quota, overlaps, HR-only types), routing through the approval engine
 * (SHORT_LEAVE: the leave.approve holders, or the org's workflow), approve → recompute job, withdraw / cancel, HR recording on
 * the employee's behalf (approved at once, quota only warns), reduced hours on the employee profile, the rule set's
 * out-of-office allowance and the daily record's new figures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditRows, createApiHarness, isoTodayIn, queueJobs, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
let e5: string; const staff5 = uuid('c');
const T: Record<string, string> = {};
const TZ = 'Asia/Muscat';
const base = () => `/api/v1/orgs/${f.orgId}`;
/** A date in the month after next (nothing else of these tests lands there unless it says so). */
const ahead = (day: number) => { const d = new Date(`${isoTodayIn(TZ)}T00:00:00Z`); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 2); d.setUTCDate(day); return d.toISOString().slice(0, 10); };
const codes = (body: { details?: { issues?: Array<{ code?: string }> } }) => (body.details?.issues ?? []).map((i) => i.code);
const ask = (token: string, body: Record<string, unknown>) => h.request('POST', `${base()}/me/time-off`, { token, body: { reason: 'Doctor appointment', ...body } });

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_short_leave_${process.pid}`);
  f = await seedOrg(h.admin, 'sl');
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5, { managerEmployeeId: f.e3, departmentId: f.departmentA });
  await h.admin.updateTable('employees').set({ gender: 'female' }).where('id', '=', e5).execute();
  await h.admin.updateTable('employees').set({ gender: 'male' }).where('id', '=', f.e1).execute();
  await seedUser(h.admin, staff5, 'staff5-sl@test.local', 'Staff Five');
  await seedMembership(h.admin, f.orgId, staff5, ROLE.employee, { employeeId: e5 });
  const seeded = await h.request('POST', `${base()}/time-off-types/seed-defaults`, { token: f.hrAdmin });
  expect(seeded.status).toBe(201);
  for (const t of seeded.body.data.types as Array<{ id: string; code: string }>) T[t.code] = t.id;
  const hrOnly = await h.request('POST', `${base()}/time-off-types`, { token: f.hrAdmin, body: { code: 'FIELD', name: 'Field visit', category: 'OFFICIAL', portalVisible: false } });
  expect(hrOnly.status).toBe(201);
  T['FIELD'] = hrOnly.body.data.id;
});
afterAll(async () => { await h?.close(); });

describe('short leave types', () => {
  it('seeds the default set once, with work-like categories counting as work', async () => {
    const r = await h.request('GET', `${base()}/time-off-types`, { token: f.hrUser });
    expect(r.status).toBe(200);
    const byCode = new Map((r.body.data as Array<{ code: string }>).map((t) => [t.code, t]));
    expect(byCode.get('PERSONAL')).toMatchObject({ category: 'PERSONAL', countsAsWork: false, maxMinutesPerRequest: 120, monthlyQuotaMinutes: 240, requiresApproval: true });
    expect(byCode.get('OFFICIAL')).toMatchObject({ countsAsWork: true });
    expect(byCode.get('REMOTE')).toMatchObject({ countsAsWork: true });
    expect(byCode.get('NURSING')).toMatchObject({ applicableGender: 'female', maxMinutesPerRequest: 60 });
    const again = await h.request('POST', `${base()}/time-off-types/seed-defaults`, { token: f.hrAdmin });
    expect(again.body.data.created).toEqual([]);
    // reading them needs leave.view, managing them leave.manage
    expect((await h.request('GET', `${base()}/time-off-types`, { token: f.employeeUser })).status).toBe(403);
    expect((await h.request('GET', `${base()}/time-off-types`, { token: f.payrollUser })).status).toBe(200);
    expect((await h.request('POST', `${base()}/time-off-types`, { token: f.payrollUser, body: { code: 'X1', name: 'X', category: 'OTHER' } })).status).toBe(403);
  });

  it('creates, patches one field without resetting the others, refuses a duplicate code and deletes an unused type', async () => {
    const c = await h.request('POST', `${base()}/time-off-types`, { token: f.hrAdmin, body: { code: 'TRAIN', name: 'Training', nameAr: 'تدريب', category: 'OTHER', monthlyQuotaCount: 2, maxMinutesPerRequest: 240, requiresApproval: false } });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ code: 'TRAIN', countsAsWork: false, monthlyQuotaCount: 2, requiresApproval: false, portalVisible: true, applicableGender: 'all', status: 'active' });
    const p = await h.request('PATCH', `${base()}/time-off-types/${c.body.data.id}`, { token: f.hrAdmin, body: { name: 'Training session' } });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ name: 'Training session', monthlyQuotaCount: 2, maxMinutesPerRequest: 240, requiresApproval: false, nameAr: 'تدريب' });
    expect((await h.request('POST', `${base()}/time-off-types`, { token: f.hrAdmin, body: { code: 'train', name: 'Dup', category: 'OTHER' } })).status).toBe(409);
    const del = await h.request('DELETE', `${base()}/time-off-types/${c.body.data.id}`, { token: f.hrAdmin });
    expect(del.body.data).toEqual({ archived: false });
    expect((await auditRows(h.admin, 'time_off_type.deleted')).length).toBe(1);
  });
});

describe('portal request validation', () => {
  it('offers the types that apply to the employee (gender, portal-visible)', async () => {
    const male = await h.request('GET', `${base()}/me/time-off`, { token: f.employeeUser });
    expect(male.status).toBe(200);
    const offered = (male.body.data.types as Array<{ code: string }>).map((t) => t.code);
    expect(offered).toEqual(expect.arrayContaining(['PERSONAL', 'OFFICIAL', 'REMOTE', 'DISABILITY']));
    expect(offered).not.toContain('NURSING');
    expect(offered).not.toContain('FIELD');
    const female = await h.request('GET', `${base()}/me/time-off`, { token: staff5 });
    expect((female.body.data.types as Array<{ code: string }>).map((t) => t.code)).toContain('NURSING');
  });

  it('refuses a backwards window, a type that does not apply, an HR-only type and a window over the per-request limit', async () => {
    expect((await ask(f.employeeUser, { typeId: T['PERSONAL'], date: ahead(3), startTime: '10:00', endTime: '09:00' })).status).toBe(400);
    expect((await ask(f.employeeUser, { typeId: T['PERSONAL'], date: ahead(3), startTime: '10:00', endTime: '25:00' })).status).toBe(400);
    const nursing = await ask(f.employeeUser, { typeId: T['NURSING'], date: ahead(3), startTime: '08:00', endTime: '09:00' });
    expect(nursing.status).toBe(400);
    expect(codes(nursing.body)).toContain('NOT_APPLICABLE');
    const field = await ask(f.employeeUser, { typeId: T['FIELD'], date: ahead(3), startTime: '08:00', endTime: '09:00' });
    expect(codes(field.body)).toContain('NOT_REQUESTABLE');
    const long = await ask(f.employeeUser, { typeId: T['PERSONAL'], date: ahead(3), startTime: '08:00', endTime: '11:00' });
    expect(long.status).toBe(400);
    expect(codes(long.body)).toContain('MAX_PER_REQUEST');
    // the end of the day is 24:00
    const late = await ask(staff5, { typeId: T['OFFICIAL'], date: ahead(4), startTime: '22:00', endTime: '24:00' });
    expect(late.status).toBe(201);
    expect(late.body.data).toMatchObject({ startTime: '22:00', endTime: '24:00', minutes: 120 });
  });

  it('enforces the monthly quota on pending + approved requests and refuses overlaps', async () => {
    const one = await ask(f.employeeUser, { typeId: T['PERSONAL'], date: ahead(10), startTime: '08:00', endTime: '10:00' });
    expect(one.status).toBe(201);
    expect(one.body.data).toMatchObject({ status: 'PENDING', minutes: 120, canWithdraw: true, recordedByHr: false });
    const overlap = await ask(f.employeeUser, { typeId: T['OFFICIAL'], date: ahead(10), startTime: '09:30', endTime: '12:00' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.details.reason).toBe('OVERLAP_SHORT_LEAVE');
    const two = await ask(f.employeeUser, { typeId: T['PERSONAL'], date: ahead(11), startTime: '14:00', endTime: '16:00' });
    expect(two.status).toBe(201);
    const three = await ask(f.employeeUser, { typeId: T['PERSONAL'], date: ahead(12), startTime: '14:00', endTime: '14:30' });
    expect(three.status).toBe(400);
    expect(codes(three.body)).toContain('MONTHLY_QUOTA_MINUTES');
    const usage = await h.request('GET', `${base()}/me/time-off?month=${ahead(1).slice(0, 7)}`, { token: f.employeeUser });
    expect(usage.body.data.usage.find((u: { typeId: string }) => u.typeId === T['PERSONAL'])).toMatchObject({ usedMinutes: 240, usedCount: 2, quotaMinutes: 240 });
    // withdrawing frees the quota
    const w = await h.request('POST', `${base()}/me/time-off/${two.body.data.id}/withdraw`, { token: f.employeeUser, body: { reason: 'Not needed any more' } });
    expect(w.status).toBe(200);
    expect(w.body.data.status).toBe('CANCELLED');
    expect((await h.admin.selectFrom('approvalRequests').select('status').where('id', '=', two.body.data.approvalRequestId).executeTakeFirstOrThrow()).status).toBe('CANCELLED');
    expect((await ask(f.employeeUser, { typeId: T['PERSONAL'], date: ahead(12), startTime: '14:00', endTime: '14:30' })).status).toBe(201);
    // the withdrawal is idempotent
    expect((await h.request('POST', `${base()}/me/time-off/${two.body.data.id}/withdraw`, { token: f.employeeUser, body: { reason: 'Again' } })).body.data.alreadyWithdrawn).toBe(true);
  });

  it('refuses a short leave on a day of full-day leave', async () => {
    const lt = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'CL', name: 'Casual Leave' } });
    expect(lt.status).toBe(201);
    const leave = await h.request('POST', `${base()}/leave-records`, { token: f.hrUser, body: { employeeId: f.e1, leaveTypeId: lt.body.data.id, startDate: ahead(15), endDate: ahead(16), reason: 'Family' } });
    expect(leave.status).toBe(201);
    const r = await ask(f.employeeUser, { typeId: T['OFFICIAL'], date: ahead(16), startTime: '08:00', endTime: '09:00' });
    expect(r.status).toBe(409);
    expect(r.body.details.reason).toBe('OVERLAP_LEAVE');
  });
});

describe('approval routing and the day recompute', () => {
  it('routes a portal request to the leave.approve holders (never the employee); approving it recomputes a past day', async () => {
    const date = isoTodayIn(TZ, -3);
    const r = await ask(f.employeeUser, { typeId: T['OFFICIAL'], date, startTime: '13:00', endTime: '15:00', reason: 'Ministry meeting' });
    expect(r.status).toBe(201);
    const reqId = r.body.data.approvalRequestId as string;
    expect(reqId).toBeTruthy();
    const request = await h.admin.selectFrom('approvalRequests').selectAll().where('id', '=', reqId).executeTakeFirstOrThrow();
    expect(request).toMatchObject({ entityType: 'SHORT_LEAVE', status: 'PENDING', employeeId: f.e1 });
    const actors = await h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select('a.userId').where('s.requestId', '=', reqId).execute();
    expect(actors.length).toBeGreaterThan(0);
    expect(actors.map((a) => a.userId)).not.toContain(f.employeeUser);
    // the inbox context of the request
    const detail = await h.request('GET', `${base()}/approvals/${reqId}`, { token: f.hrAdmin });
    expect(detail.status).toBe(200);
    expect(detail.body.data.context).toMatchObject({ kind: 'SHORT_LEAVE', shortLeave: { typeName: 'Official assignment', date, startTime: '13:00', endTime: '15:00', minutes: 120, countsAsWork: true } });
    // the employee cannot decide their own request
    expect((await h.request('POST', `${base()}/approvals/${reqId}/decide`, { token: f.employeeUser, body: { decision: 'APPROVE', stepNo: 1 } })).status).toBe(403);
    const before = (await queueJobs(h.admin, 'RECALCULATE_RANGE')).length;
    const ok = await h.request('POST', `${base()}/approvals/${reqId}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE', stepNo: 1, comment: 'Fine' } });
    expect(ok.status).toBe(200);
    const row = await h.admin.selectFrom('timeOffRequests').selectAll().where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'APPROVED', decidedBy: f.hrAdmin, decisionNote: 'Fine' });
    const jobs = await queueJobs(h.admin, 'RECALCULATE_RANGE');
    expect(jobs.length).toBe(before + 1);
    const recalc = await h.admin.selectFrom('attendanceRecalculationRequests').selectAll().where('id', '=', String(jobs[jobs.length - 1]!.payload['requestId'])).executeTakeFirstOrThrow();
    expect(recalc.employeeIds).toEqual([f.e1]);
    // an approved request is cancelled by HR, never withdrawn by the employee
    expect((await h.request('POST', `${base()}/me/time-off/${r.body.data.id}/withdraw`, { token: f.employeeUser, body: { reason: 'Changed my mind' } })).status).toBe(409);
    const cancel = await h.request('POST', `${base()}/time-off-requests/${r.body.data.id}/cancel`, { token: f.hrAdmin, body: { reason: 'Meeting cancelled' } });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');
    expect(cancel.body.data.recalculationJobId).toBeTruthy();
  });

  it('a rejection records the note; the organisation workflow for SHORT_LEAVE routes to the line manager', async () => {
    const wf = await h.request('POST', `${base()}/approval-workflows`, { token: f.owner, body: { name: 'Short leave by manager', entityType: 'SHORT_LEAVE', steps: [{ order: 1, approverType: 'MANAGER', mode: 'ANY' }] } });
    expect(wf.status).toBe(201);
    try {
      const r = await ask(f.employeeUser, { typeId: T['OFFICIAL'], date: ahead(20), startTime: '08:00', endTime: '09:00' });
      expect(r.status).toBe(201);
      const actors = await h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select('a.userId').where('s.requestId', '=', r.body.data.approvalRequestId).execute();
      // e1's manager is e3, whose login is managerUser
      expect(actors.map((a) => a.userId)).toEqual([f.managerUser]);
      const rej = await h.request('POST', `${base()}/approvals/${r.body.data.approvalRequestId}/decide`, { token: f.managerUser, body: { decision: 'REJECT', comment: 'Not needed', stepNo: 1 } });
      expect(rej.status).toBe(200);
      expect(await h.admin.selectFrom('timeOffRequests').select(['status', 'decisionNote']).where('id', '=', r.body.data.id).executeTakeFirstOrThrow()).toEqual({ status: 'REJECTED', decisionNote: 'Not needed' });
    } finally {
      await h.admin.deleteFrom('approvalWorkflows').where('id', '=', wf.body.data.id).execute();
    }
  });

  it('a type that needs no approval is approved at once', async () => {
    const c = await h.request('POST', `${base()}/time-off-types`, { token: f.hrAdmin, body: { code: 'WFH', name: 'Work from home day', category: 'REMOTE', requiresApproval: false } });
    const date = isoTodayIn(TZ, -2);
    const r = await ask(f.employeeUser, { typeId: c.body.data.id, date, startTime: '08:00', endTime: '16:00' });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('APPROVED');
    expect(r.body.data.recalculationJobId).toBeTruthy();
  });
});

describe('HR records on the employee\'s behalf', () => {
  it('approves at once, only warns about the quota, and lets HR cancel', async () => {
    const date = isoTodayIn(TZ, -4);
    const r = await h.request('POST', `${base()}/time-off-requests`, { token: f.hrUser, body: { employeeId: f.e1, typeId: T['PERSONAL'], date, startTime: '08:00', endTime: '12:00', reason: 'Recorded after the fact' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'APPROVED', minutes: 240, recordedByHr: true, canWithdraw: false });
    expect(r.body.data.warnings.map((w: { code: string }) => w.code)).toContain('MAX_PER_REQUEST');
    expect(r.body.data.recalculationJobId).toBeTruthy();
    // an HR-only type is fine for HR
    const field = await h.request('POST', `${base()}/time-off-requests`, { token: f.hrUser, body: { employeeId: f.e1, typeId: T['FIELD'], date, startTime: '13:00', endTime: '15:00', reason: 'Site visit' } });
    expect(field.status).toBe(201);
    // the employee sees it, but cannot withdraw what HR filed
    const mine = await h.request('GET', `${base()}/me/time-off?month=${date.slice(0, 7)}`, { token: f.employeeUser });
    expect((mine.body.data.requests as Array<{ id: string }>).map((x) => x.id)).toContain(field.body.data.id);
    // listed for HR, filterable
    const list = await h.request('GET', `${base()}/time-off-requests?employeeId=${f.e1}&status=APPROVED&from=${date}&to=${date}`, { token: f.hrUser });
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(2);
    expect((await h.request('GET', `${base()}/time-off-requests`, { token: f.employeeUser })).status).toBe(403);
    // a branch manager of another branch cannot record for e1 (outside their scope the employee is unknown)
    const other = await h.request('POST', `${base()}/time-off-requests`, { token: f.branchManagerB, body: { employeeId: f.e1, typeId: T['PERSONAL'], date, startTime: '16:00', endTime: '17:00', reason: 'Other branch' } });
    expect(other.status).toBe(400);
    expect(await h.admin.selectFrom('timeOffRequests').select('id').where('employeeId', '=', f.e1).where('startTime', '=', '16:00').execute()).toEqual([]);
  });
});

describe('reduced hours (nursing hour, disability)', () => {
  it('manages the allowances of an employee and recomputes the past days they touch', async () => {
    const url = `${base()}/employees/${e5}/hour-allowances`;
    const noEnd = await h.request('POST', url, { token: f.hrUser, body: { kind: 'NURSING', minutesPerDay: 60, position: 'START', validFrom: isoTodayIn(TZ, -10) } });
    expect(noEnd.status).toBe(400);
    const c = await h.request('POST', url, { token: f.hrUser, body: { kind: 'NURSING', minutesPerDay: 60, position: 'START', validFrom: isoTodayIn(TZ, -10), validTo: isoTodayIn(TZ, 200), reference: 'Birth certificate 123' } });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ kind: 'NURSING', minutesPerDay: 60, position: 'START', active: true });
    expect(c.body.data.recalculationJobId).toBeTruthy();
    const dup = await h.request('POST', url, { token: f.hrUser, body: { kind: 'NURSING', minutesPerDay: 30, position: 'END', validFrom: isoTodayIn(TZ, 5), validTo: isoTodayIn(TZ, 20) } });
    expect(dup.status).toBe(409);
    // an open-ended disability allowance next to it is fine
    const dis = await h.request('POST', url, { token: f.hrUser, body: { kind: 'DISABILITY', minutesPerDay: 120, position: 'EITHER', validFrom: isoTodayIn(TZ, 1) } });
    expect(dis.status).toBe(201);
    expect(dis.body.data.recalculationJobId).toBeNull();
    const p = await h.request('PATCH', `${base()}/hour-allowances/${c.body.data.id}`, { token: f.hrUser, body: { minutesPerDay: 45 } });
    expect(p.body.data).toMatchObject({ minutesPerDay: 45, position: 'START', reference: 'Birth certificate 123' });
    const list = await h.request('GET', url, { token: f.hrUser });
    expect(list.body.data.length).toBe(2);
    // the employee reads their own in the portal; nobody without leave.manage writes them
    const own = await h.request('GET', `${base()}/me/time-off`, { token: staff5 });
    expect((own.body.data.allowances as Array<{ kind: string }>).map((a) => a.kind).sort()).toEqual(['DISABILITY', 'NURSING']);
    expect((await h.request('POST', url, { token: staff5, body: { kind: 'OTHER', minutesPerDay: 30, position: 'END', validFrom: isoTodayIn(TZ) } })).status).toBe(403);
    // outside the caller's branch scope the employee does not exist for them
    expect((await h.request('GET', url, { token: f.branchManagerB })).status).toBe(404);
    const del = await h.request('DELETE', `${base()}/hour-allowances/${dis.body.data.id}`, { token: f.hrUser });
    expect(del.status).toBe(200);
    expect((await auditRows(h.admin, 'hour_allowance.deleted')).length).toBe(1);
  });
});

describe('attendance figures', () => {
  it('stores the out-of-office allowance on the rule set and keeps it on a one-field PATCH', async () => {
    const r = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Lost time policy', effectiveFrom: '2030-01-01', punchInterpretation: 'PAIRED', outOfOfficeAllowanceMinutes: 20 } });
    expect(r.status).toBe(201);
    expect(r.body.data.outOfOfficeAllowanceMinutes).toBe(20);
    const p = await h.request('PATCH', `${base()}/attendance-rule-sets/${r.body.data.id}`, { token: f.hrAdmin, body: { graceInMinutes: 5 } });
    expect(p.body.data).toMatchObject({ outOfOfficeAllowanceMinutes: 20, graceInMinutes: 5 });
    expect((await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Too much', effectiveFrom: '2031-01-01', branchId: f.branchB, outOfOfficeAllowanceMinutes: 500 } })).status).toBe(400);
  });

  it('returns the excused / credited / lost minutes of a daily record', async () => {
    const date = isoTodayIn(TZ, -20);
    await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId: f.e2, attendanceDate: date, branchId: f.branchB, timezone: TZ, engineVersion: 'attendance-engine/1.5.0', status: 'PRESENT', workedMinutes: 450, scheduledMinutes: 480, excusedMinutes: 30, creditedMinutes: 60, lostMinutes: 25, flags: ['SHORT_LEAVE', 'LOST_TIME'] }).execute();
    const r = await h.request('GET', `${base()}/attendance/daily?date=${date}`, { token: f.hrAdmin });
    expect(r.status).toBe(200);
    expect(r.body.data.find((x: { employeeId: string }) => x.employeeId === f.e2)).toMatchObject({ excusedMinutes: 30, creditedMinutes: 60, lostMinutes: 25, flags: ['SHORT_LEAVE', 'LOST_TIME'] });
  });
});
