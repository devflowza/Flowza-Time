import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dayOfWeek } from '@flowza/shared';
import { createApiHarness, domainEvents, isoToday, queueJobs, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
let e4: string; let emp4User: string; let otherManager: string;
const base = () => `/api/v1/orgs/${f.orgId}`;
const D = { absent: isoToday(-12), late: isoToday(-11), absent2: isoToday(-10), present: isoToday(-9), missed: isoToday(-8), wfh: isoToday(-7), cancel: isoToday(-6), wrong: isoToday(-5), mgr: isoToday(-4) };

async function seedDay(employeeId: string, date: string, status: string, flags: string[] = [], extra: Record<string, unknown> = {}) {
  await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId, attendanceDate: date, branchId: f.branchA, departmentId: f.departmentA, timezone: 'Asia/Muscat', engineVersion: 'test', status: status as never, flags, workedMinutes: status === 'PRESENT' ? 480 : 0, lateMinutes: flags.includes('LATE') ? 20 : 0, trace: JSON.stringify({ punches: [] }), ...extra }).execute();
}
async function marks(employeeId: string, date: string) {
  return h.admin.selectFrom('attendanceDayMarks').selectAll().where('employeeId', '=', employeeId).where('attendanceDate', '=', sql<Date>`${date}::date`).orderBy('createdAt').execute();
}
async function requestOf(entityId: string) {
  return h.admin.selectFrom('approvalRequests').selectAll().where('entityId', '=', entityId).orderBy('createdAt', 'desc').execute();
}
const note = (date: string, body: Record<string, unknown> = {}, token = f.employeeUser) => h.request('POST', `${base()}/me/attendance/notes`, { token, body: { date, category: 'absence_reason', note: 'I was at the clinic with my son', ...body } });
const review = (id: string, body: Record<string, unknown>, token = f.managerUser) => h.request('POST', `${base()}/attendance/notes/${id}/review`, { token, body });

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_portal_requests_${process.pid}`);
  f = await seedOrg(h.admin, 'requests');
  e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4);
  emp4User = uuid('c');
  await seedUser(h.admin, emp4User, 'emp4@test.local', 'Employee Four');
  await seedMembership(h.admin, f.orgId, emp4User, ROLE.employee, { employeeId: e4 });
  const e5 = await seedEmployee(h.admin, f.orgId, f.branchB, 5);
  otherManager = uuid('c');
  await seedUser(h.admin, otherManager, 'other-mgr@test.local', 'Other manager');
  await seedMembership(h.admin, f.orgId, otherManager, ROLE.manager, { employeeId: e5 });
  await seedDay(f.e1, D.absent, 'ABSENT');
  await seedDay(f.e1, D.late, 'PRESENT', ['LATE']);
  await seedDay(f.e1, D.absent2, 'ABSENT');
  await seedDay(f.e1, D.present, 'PRESENT');
  await seedDay(f.e3, D.mgr, 'ABSENT');
});
afterAll(async () => { await h?.close(); });

describe('attendance notes — the employee side', () => {
  let noteId: string;
  it('a reason undoes the sweep\'s charge while it is reviewed and is routed to the line manager', async () => {
    await h.admin.insertInto('attendanceDayMarks').values([
      { organizationId: f.orgId, employeeId: f.e1, attendanceDate: D.absent, branchId: f.branchA, kind: 'UNEXCUSED', payEffectDays: 1, source: 'SWEEP', reason: 'day close' },
      { organizationId: f.orgId, employeeId: f.e1, attendanceDate: D.absent, branchId: f.branchA, kind: 'LOP', payEffectDays: 1, source: 'SWEEP', reason: 'day close' },
      // HR's own verdict on another day: a reason never undoes it
      { organizationId: f.orgId, employeeId: f.e1, attendanceDate: D.absent2, branchId: f.branchA, kind: 'UNEXCUSED', payEffectDays: 0, source: 'HR', reason: 'HR decided' },
    ]).execute();
    const r = await note(D.absent);
    expect(r.status).toBe(201);
    noteId = r.body.data.id;
    expect(r.body.data).toMatchObject({ employeeId: f.e1, attendanceDate: D.absent, status: 'pending', category: 'absence_reason', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 1 });
    const m = await marks(f.e1, D.absent);
    expect(m.filter((x) => x.source === 'SWEEP')).toHaveLength(2);
    expect(m.every((x) => x.revokedAt !== null)).toBe(true);
    const [req] = await requestOf(noteId);
    expect(req).toMatchObject({ entityType: 'ATTENDANCE_NOTE', status: 'PENDING', workflowId: null, employeeId: f.e1 });
    const actors = await h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select(['a.userId', 's.approverType', 's.resolutionPath']).where('s.requestId', '=', req!.id).execute();
    expect(actors).toEqual([{ userId: f.managerUser, approverType: 'MANAGER', resolutionPath: 'primary' }]);
    expect((await queueJobs(h.admin, 'RECOMPUTE_DAILY')).some((j) => j.payload['employeeId'] === f.e1 && j.payload['date'] === D.absent)).toBe(true);
  });

  it('one active reason per day; the list shows it; nobody else\'s notes are visible', async () => {
    const dup = await note(D.absent);
    expect(dup.status).toBe(409);
    expect(dup.body.details).toMatchObject({ noteId, status: 'pending' });
    expect((await note(isoToday(45))).status).toBe(400);
    expect((await note(D.late, { note: 'x' })).status).toBe(400);
    const mine = await h.request('GET', `${base()}/me/attendance/notes`, { token: f.employeeUser });
    expect(mine.body.data.map((n: { id: string }) => n.id)).toEqual([noteId]);
    expect((await h.request('GET', `${base()}/me/attendance/notes`, { token: f.hrAdmin })).status).toBe(403);
  });

  it('a question from the manager and the employee\'s answer (a new request)', async () => {
    const q = await review(noteId, { decision: 'request_info', reason: 'Do you have the clinic slip?' });
    expect(q.status).toBe(200);
    expect(q.body.data).toMatchObject({ terminal: false, note: { status: 'info_requested', infoRequestMessage: 'Do you have the clinic slip?' } });
    expect((await domainEvents(h.admin, 'attendance.note_info_requested')).at(-1)!.payload).toMatchObject({ noteId, userIds: [f.employeeUser] });
    // the generic question notice skips the employee (the note-specific one told them)
    const generic = await domainEvents(h.admin, 'approval.info_requested');
    expect(generic.flatMap((e) => ((e.payload as Record<string, unknown>)['userIds'] as string[] | undefined) ?? [])).not.toContain(f.employeeUser);
    const [before] = await requestOf(noteId);
    const patched = await h.request('PATCH', `${base()}/me/attendance/notes/${noteId}`, { token: f.employeeUser, body: { note: 'Clinic slip attached in the HR portal' } });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ status: 'pending', note: 'Clinic slip attached in the HR portal', category: 'absence_reason', approvalStatus: 'PENDING' });
    const requests = await requestOf(noteId);
    expect(requests.map((r) => r.status).sort()).toEqual(['INVALIDATED', 'PENDING']);
    expect(requests.find((r) => r.id === before!.id)!.status).toBe('INVALIDATED');
  });
});

describe('attendance notes — the reviewer side', () => {
  let noteId: string;
  beforeAll(async () => {
    noteId = (await h.request('GET', `${base()}/me/attendance/notes`, { token: f.employeeUser })).body.data[0].id;
  });

  it('the manager\'s queue shows the day, the excused count and that they are not reviewing as oversight', async () => {
    const r = await h.request('GET', `${base()}/attendance/notes?scope=mine&open=true`, { token: f.managerUser });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([expect.objectContaining({ id: noteId, employeeName: 'Employee 1', dayStatus: 'ABSENT', excusedCountYear: 0, isOversight: false, canReview: true, branchName: 'Branch A' })]);
    const all = await h.request('GET', `${base()}/attendance/notes?scope=all`, { token: f.hrAdmin });
    expect(all.body.data).toEqual([expect.objectContaining({ id: noteId, isOversight: true, canReview: true })]);
    expect((await h.request('GET', `${base()}/attendance/notes?scope=all`, { token: otherManager })).status).toBe(403);
    expect((await h.request('GET', `${base()}/attendance/notes?scope=team`, { token: otherManager })).body.data).toEqual([]);
  });

  it('a manager of another team is refused; the employee never reviews themselves', async () => {
    expect((await review(noteId, { decision: 'approve' }, otherManager)).status).toBe(403);
    expect((await review(noteId, { decision: 'approve' }, f.employeeUser)).status).toBe(403);
    expect((await review(noteId, { decision: 'reject' })).status).toBe(400); // pay effect required
  });

  it('a rejection with no paid leave left is loss of pay (LOP) and tells the employee', async () => {
    const r = await review(noteId, { decision: 'reject', payEffectDays: 1, reason: 'A slip is needed the same day' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ terminal: true, requestStatus: 'REJECTED', charge: { outcome: 'lop', payEffectDays: 1 }, note: { status: 'rejected', lossOfPay: true, payEffectDays: 1, reviewVia: 'manager', reviewedBy: f.managerUser } });
    const m = (await marks(f.e1, D.absent)).filter((x) => x.revokedAt === null);
    expect(m.map((x) => `${x.kind}:${x.source}`).sort()).toEqual(['LOP:NOTE_REVIEW', 'UNEXCUSED:NOTE_REVIEW']);
    expect((await domainEvents(h.admin, 'attendance.note_decided')).at(-1)!.payload).toMatchObject({ decision: 'rejected', chargeOutcome: 'lop', payEffectDays: 1, userIds: [f.employeeUser] });
    expect((await review(noteId, { decision: 'approve' })).status).toBe(409);
  });

  it('a new reason after a rejection keeps the review\'s charge until it is decided; oversight excuses it (recorded as oversight)', async () => {
    const again = await note(D.absent, { category: 'other', note: 'Here is the clinic slip, stamped' });
    expect(again.status).toBe(201);
    // re-filing does not buy back the decided pay effect: the rejection's marks stay while the new reason waits
    expect((await marks(f.e1, D.absent)).filter((x) => x.revokedAt === null && x.source === 'NOTE_REVIEW').map((x) => x.kind).sort()).toEqual(['LOP', 'UNEXCUSED']);
    const r = await review(again.body.data.id, { decision: 'excuse', reason: 'Slip checked' }, f.hrAdmin);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ terminal: true, requestStatus: 'APPROVED', note: { status: 'excused', reviewVia: 'oversight', reviewReason: 'Slip checked' } });
    expect((await marks(f.e1, D.absent)).filter((x) => x.revokedAt === null).map((x) => `${x.kind}:${x.source}`).sort()).toEqual(['EXCUSED:NOTE_REVIEW']);
    const [req] = await requestOf(again.body.data.id);
    const events = await h.admin.selectFrom('approvalRequestEvents').select(['kind', 'detail']).where('requestId', '=', req!.id).execute();
    expect(events.map((e) => e.kind)).toContain('override');
    const listed = await h.request('GET', `${base()}/attendance/notes?scope=all&employeeId=${f.e1}`, { token: f.hrAdmin });
    expect(listed.body.data.find((n: { id: string }) => n.id === again.body.data.id).excusedCountYear).toBe(1);
  });

  it('a half-day rejection charges paid leave first (in the tenant\'s priority order)', async () => {
    await h.admin.insertInto('leaveTypes').values({ organizationId: f.orgId, code: 'AL', name: 'Annual Leave', isPaid: true, annualAllowanceDays: 30 }).execute();
    const n = await note(D.late, { category: 'late_reason', note: 'Traffic accident on the highway' });
    expect(n.status).toBe(201);
    const r = await review(n.body.data.id, { decision: 'reject', payEffectDays: 0.5 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ charge: { outcome: 'charged_leave', payEffectDays: 0.5, leaveTypeCode: 'AL' }, note: { status: 'rejected', lossOfPay: false, deductedLeaveTypeCode: 'AL', reviewReason: 'The reason was not accepted.' } });
    const leave = await h.admin.selectFrom('leaveRecords').selectAll().where('employeeId', '=', f.e1).where('source', '=', 'INTERNAL').execute();
    expect(leave).toEqual([expect.objectContaining({ status: 'APPROVED', isHalfDay: true, halfDayPart: 'FIRST_HALF' })]);
  });

  it('the approvals inbox decides the same note through the same hook (pay effect from the body)', async () => {
    const n = await note(D.absent2);
    const [req] = await requestOf(n.body.data.id);
    const inbox = await h.request('GET', `${base()}/approvals?scope=mine&view=pending`, { token: f.managerUser });
    const item = inbox.body.data.find((x: { id: string }) => x.id === req!.id);
    expect(item.context).toMatchObject({ kind: 'ATTENDANCE_NOTE', note: { id: n.body.data.id, dayStatus: 'ABSENT', category: 'absence_reason' } });
    expect(item.context.summary).toContain(D.absent2);
    const r = await h.request('POST', `${base()}/approvals/${req!.id}/decide`, { token: f.managerUser, body: { stepNo: 1, decision: 'REJECT', comment: 'Not a valid reason', payEffectDays: 0 } });
    expect(r.status).toBe(200);
    const after = await h.admin.selectFrom('attendanceNotes').selectAll().where('id', '=', n.body.data.id).executeTakeFirstOrThrow();
    expect(after).toMatchObject({ status: 'rejected', lossOfPay: false, reviewReason: 'Not a valid reason', reviewVia: 'manager' });
    // HR's UNEXCUSED mark on the day survived the reason and was not superseded by the review
    expect((await marks(f.e1, D.absent2)).filter((x) => x.revokedAt === null).map((x) => `${x.kind}:${x.source}`)).toEqual(['UNEXCUSED:HR']);
  });

  it('an inbox that predates the pay-effect choice still decides a reason: no pay effect sent = no charge', async () => {
    // outside the 30-day statistics window used further down, so no other assertion counts this day
    const day = isoToday(-40);
    await seedDay(f.e1, day, 'ABSENT');
    const n = await note(day);
    expect(n.status).toBe(201);
    const [req] = await requestOf(n.body.data.id);
    // the decide body of the web built before this prompt: the level, decision + comment, no payEffectDays
    const r = await h.request('POST', `${base()}/approvals/${req!.id}/decide`, { token: f.managerUser, body: { stepNo: 1, decision: 'REJECT', comment: 'No proof given' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: req!.id, status: 'REJECTED' });
    const after = await h.admin.selectFrom('attendanceNotes').selectAll().where('id', '=', n.body.data.id).executeTakeFirstOrThrow();
    expect(after).toMatchObject({ status: 'rejected', lossOfPay: false, deductedLeaveRecordId: null, reviewReason: 'No proof given', reviewVia: 'manager' });
    expect(Number(after.payEffectDays)).toBe(0);
    expect((await marks(f.e1, day)).filter((x) => x.revokedAt === null).map((x) => `${x.kind}:${x.source}:${Number(x.payEffectDays ?? 0)}`)).toEqual(['UNEXCUSED:NOTE_REVIEW:0']);
    expect(await h.admin.selectFrom('leaveRecords').select('id').where('employeeId', '=', f.e1).where('source', '=', 'INTERNAL').where('startDate', '=', sql<Date>`${day}::date`).execute()).toHaveLength(0);
  });

  it('the secondary manager stands in for the primary: one seat, so a rejection by either is final', async () => {
    await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: e4 }).where('id', '=', f.e1).execute();
    try {
      const n = await note(D.wfh, { category: 'wfh', note: 'Worked from home on the report' });
      expect(n.status).toBe(201);
      const [req] = await requestOf(n.body.data.id);
      const actors = await h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select(['a.userId', 'a.viaDelegationOf', 'a.resolutionPath']).where('s.requestId', '=', req!.id).orderBy('a.createdAt').execute();
      expect(actors).toEqual([{ userId: f.managerUser, viaDelegationOf: null, resolutionPath: 'primary' }, { userId: emp4User, viaDelegationOf: f.managerUser, resolutionPath: 'secondary' }]);
      expect((await domainEvents(h.admin, 'approval.pending')).some((e) => (e.payload as Record<string, unknown>)['requestId'] === req!.id && ((e.payload as Record<string, unknown>)['userIds'] as string[]).includes(emp4User))).toBe(true);
      const mine = await h.request('GET', `${base()}/attendance/notes?scope=mine&open=true`, { token: emp4User });
      expect(mine.body.data).toEqual([expect.objectContaining({ id: n.body.data.id, canReview: true, isOversight: false })]);
      const r = await review(n.body.data.id, { decision: 'reject', payEffectDays: 0, reason: 'Not agreed in advance' }, emp4User);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ terminal: true, requestStatus: 'REJECTED', charge: { outcome: 'not_applicable' }, note: { status: 'rejected', reviewVia: 'manager' } });
    } finally {
      await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: null }).where('id', '=', f.e1).execute();
    }
  });

  it('an approval accepts the reason; an HR admin\'s own reason is routed to another HR admin and they cannot decide it', async () => {
    const n = await note(D.present, { category: 'client_visit', note: 'Visited the client in Sohar' });
    const ok = await review(n.body.data.id, { decision: 'approve', reason: 'Fine' });
    expect(ok.body.data.note).toMatchObject({ status: 'approved', reviewVia: 'manager' });
    // an HR admin who is also an employee (live link) with every review key
    const e6 = await seedEmployee(h.admin, f.orgId, f.branchA, 6);
    const hr2 = uuid('c');
    await seedUser(h.admin, hr2, 'hr2@test.local', 'HR Two');
    await seedMembership(h.admin, f.orgId, hr2, ROLE.hr_admin, { employeeId: e6 });
    await seedDay(e6, D.mgr, 'ABSENT');
    const own = await note(D.mgr, {}, hr2);
    expect(own.status).toBe(201);
    const [req] = await requestOf(own.body.data.id);
    const actors = await h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select(['a.userId']).where('s.requestId', '=', req!.id).execute();
    expect(actors.map((a) => a.userId)).toEqual([f.hrAdmin]);
    const self = await review(own.body.data.id, { decision: 'approve' }, hr2);
    expect(self.status).toBe(403);
    expect(self.body.message).toContain('own');
    expect((await h.request('GET', `${base()}/attendance/notes?scope=all`, { token: hr2 })).body.data.map((x: { employeeId: string }) => x.employeeId)).not.toContain(e6);
  });
});

describe('regularisations', () => {
  it('validates the day and the times', async () => {
    const future = await h.request('POST', `${base()}/me/regularisations`, { token: f.employeeUser, body: { date: isoToday(3), type: 'missed_punch', proposedInAt: `${isoToday(3)}T05:00:00Z`, reason: 'Forgot to punch' } });
    expect(future.status).toBe(400);
    const far = await h.request('POST', `${base()}/me/regularisations`, { token: f.employeeUser, body: { date: D.missed, type: 'missed_punch', proposedInAt: `${isoToday(-30)}T05:00:00Z`, reason: 'Forgot to punch' } });
    expect(far.status).toBe(400);
    const none = await h.request('POST', `${base()}/me/regularisations`, { token: f.employeeUser, body: { date: D.missed, type: 'missed_punch', reason: 'Forgot to punch' } });
    expect(none.status).toBe(400);
  });

  it('a missed punch is applied through two approved corrections on the self-service device', async () => {
    const r = await h.request('POST', `${base()}/me/regularisations`, { token: f.employeeUser, body: { date: D.missed, type: 'missed_punch', proposedInAt: `${D.missed}T05:00:00Z`, proposedOutAt: `${D.missed}T13:00:00Z`, reason: 'The terminal was offline' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'pending', approvalStatus: 'PENDING', type: 'missed_punch' });
    const [req] = await requestOf(r.body.data.id);
    expect((await h.request('POST', `${base()}/approvals/${req!.id}/decide`, { token: f.employeeUser, body: { stepNo: 1, decision: 'APPROVE' } })).status).toBe(403);
    const ok = await h.request('POST', `${base()}/approvals/${req!.id}/decide`, { token: f.managerUser, body: { stepNo: 1, decision: 'APPROVE', comment: 'OK' } });
    expect(ok.status).toBe(200);
    const reg = await h.admin.selectFrom('attendanceRegularisationRequests').selectAll().where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(reg).toMatchObject({ status: 'approved', decidedBy: f.managerUser, decisionNote: 'OK' });
    const device = await h.admin.selectFrom('devices').select('id').where('organizationId', '=', f.orgId).where('providerKey', '=', 'self_service').executeTakeFirstOrThrow();
    const corrections = await h.admin.selectFrom('attendanceCorrections').selectAll().where('approvalRequestId', '=', req!.id).orderBy('proposedPunchedAt').execute();
    expect(corrections.map((c) => `${c.type}:${c.proposedEventType}:${c.status}`)).toEqual(['ADD_PUNCH:PUNCH_IN:APPROVED', 'ADD_PUNCH:PUNCH_OUT:APPROVED']);
    expect(corrections.every((c) => c.deviceId === device.id && c.reason.startsWith('Regularisation (missed punch)') && c.requestedBy === f.employeeUser)).toBe(true);
    expect(reg.appliedCorrectionId).toBe(corrections.find((c) => c.proposedEventType === 'PUNCH_IN')!.id);
    const jobs = (await queueJobs(h.admin, 'APPLY_CORRECTION')).filter((j) => corrections.some((c) => c.id === j.payload['correctionId']));
    expect(jobs).toHaveLength(2);
    expect((await domainEvents(h.admin, 'attendance.regularisation_decided')).at(-1)!.payload).toMatchObject({ decision: 'approved', userIds: [f.employeeUser] });
  });

  it('work from home not marked becomes present; a wrong punch edits the day\'s own punch', async () => {
    const wfh = await h.request('POST', `${base()}/me/regularisations`, { token: f.employeeUser, body: { date: D.wfh, type: 'wfh_unmarked', reason: 'Worked from home, approved by email' } });
    const [wreq] = await requestOf(wfh.body.data.id);
    await h.request('POST', `${base()}/approvals/${wreq!.id}/decide`, { token: f.managerUser, body: { stepNo: 1, decision: 'APPROVE' } });
    const wc = await h.admin.selectFrom('attendanceCorrections').selectAll().where('approvalRequestId', '=', wreq!.id).execute();
    expect(wc.map((c) => `${c.type}:${c.proposedStatus}`)).toEqual(['SET_STATUS:PRESENT']);
    const ev = await h.admin.insertInto('attendanceEvents').values({ organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, punchedAt: new Date(`${D.wrong}T06:30:00Z`), eventType: 'PUNCH_IN', source: 'DEVICE' }).returning('id').executeTakeFirstOrThrow();
    const wrong = await h.request('POST', `${base()}/me/regularisations`, { token: f.employeeUser, body: { date: D.wrong, type: 'wrong_punch', proposedInAt: `${D.wrong}T05:00:00Z`, reason: 'The terminal clock was wrong' } });
    const [rreq] = await requestOf(wrong.body.data.id);
    await h.request('POST', `${base()}/approvals/${rreq!.id}/decide`, { token: f.managerUser, body: { stepNo: 1, decision: 'APPROVE' } });
    const rc = await h.admin.selectFrom('attendanceCorrections').selectAll().where('approvalRequestId', '=', rreq!.id).execute();
    expect(rc).toEqual([expect.objectContaining({ type: 'EDIT_PUNCH', originalEventId: ev.id, proposedEventType: 'PUNCH_IN' })]);
  });

  it('a pending request can be withdrawn once; the list shows every state', async () => {
    const r = await h.request('POST', `${base()}/me/regularisations`, { token: f.employeeUser, body: { date: D.cancel, type: 'system_downtime', proposedInAt: `${D.cancel}T05:00:00Z`, reason: 'Network outage all morning' } });
    expect((await h.request('POST', `${base()}/me/regularisations`, { token: f.employeeUser, body: { date: D.cancel, type: 'system_downtime', reason: 'Twice' } })).status).toBe(409);
    const c = await h.request('POST', `${base()}/me/regularisations/${r.body.data.id}/cancel`, { token: f.employeeUser, body: {} });
    expect(c.status).toBe(200);
    expect(c.body.data).toMatchObject({ status: 'cancelled', approvalStatus: 'CANCELLED', decisionNote: 'Withdrawn by the employee' });
    expect((await h.request('POST', `${base()}/me/regularisations/${r.body.data.id}/cancel`, { token: f.employeeUser })).status).toBe(409);
    expect((await h.request('POST', `${base()}/me/regularisations/${r.body.data.id}/cancel`, { token: emp4User })).status).toBe(404);
    const list = await h.request('GET', `${base()}/me/regularisations`, { token: f.employeeUser });
    expect(list.body.data.map((x: { status: string }) => x.status).sort()).toEqual(['approved', 'approved', 'approved', 'cancelled']);
  });
});

describe('shift tab and swaps', () => {
  let S1: string; let S2: string; let day: string;
  beforeAll(async () => {
    const s1 = await h.admin.insertInto('shifts').values({ organizationId: f.orgId, code: 'MORN', name: 'Morning', type: 'FIXED', startTime: '08:00', endTime: '16:00' }).returning('id').executeTakeFirstOrThrow();
    const s2 = await h.admin.insertInto('shifts').values({ organizationId: f.orgId, code: 'EVE', name: 'Evening', type: 'FIXED', startTime: '14:00', endTime: '22:00' }).returning('id').executeTakeFirstOrThrow();
    S1 = s1.id; S2 = s2.id;
    await h.admin.insertInto('shiftAssignments').values([
      { organizationId: f.orgId, targetType: 'EMPLOYEE', targetId: f.e1, branchId: f.branchA, shiftId: S1, effectiveFrom: '2026-01-01' },
      { organizationId: f.orgId, targetType: 'EMPLOYEE', targetId: e4, branchId: f.branchA, shiftId: S2, effectiveFrom: '2026-01-01' },
    ]).execute();
    for (let i = 3; i < 14; i += 1) { const d = isoToday(i); if (![5, 6].includes(dayOfWeek(d))) { day = d; break; } }
  });

  it('the shift tab resolves today and the next 14 days (employees without shift.view read it)', async () => {
    const r = await h.request('GET', `${base()}/me/shift`, { token: f.employeeUser });
    expect(r.status).toBe(200);
    expect(r.body.data.upcoming).toHaveLength(14);
    const d = r.body.data.upcoming.find((x: { date: string }) => x.date === day);
    expect(d).toMatchObject({ shift: { id: S1, name: 'Morning', startTime: '08:00', endTime: '16:00' }, source: 'ASSIGNMENT', isOff: false, swap: null });
    expect(r.body.data.history).toEqual([expect.objectContaining({ targetType: 'EMPLOYEE', shiftName: 'Morning', effectiveFrom: '2026-01-01', isSwap: false })]);
  });

  it('candidates: colleagues of the branch, eligible when they work a different shift', async () => {
    const r = await h.request('GET', `${base()}/me/shift-swaps/candidates?date=${day}`, { token: f.employeeUser });
    expect(r.status).toBe(200);
    const byId = new Map(r.body.data.map((c: { employeeId: string }) => [c.employeeId, c]));
    expect(byId.get(e4)).toMatchObject({ eligible: true, shift: { id: S2 } });
    expect(byId.get(f.e3)).toMatchObject({ eligible: false, shift: null });
    expect(byId.has(f.e2)).toBe(false); // another branch
  });

  let swapId: string;
  it('validates and files a swap; the colleague is told', async () => {
    expect((await h.request('POST', `${base()}/me/shift-swaps`, { token: f.employeeUser, body: { date: day, withEmployeeId: f.e3, reason: 'Family event' } })).status).toBe(400);
    expect((await h.request('POST', `${base()}/me/shift-swaps`, { token: f.employeeUser, body: { date: day, withEmployeeId: f.e2, reason: 'Family event' } })).status).toBe(400);
    expect((await h.request('POST', `${base()}/me/shift-swaps`, { token: f.employeeUser, body: { date: isoToday(-2), withEmployeeId: e4, reason: 'Family event' } })).status).toBe(400);
    const r = await h.request('POST', `${base()}/me/shift-swaps`, { token: f.employeeUser, body: { date: day, withEmployeeId: e4, reason: 'Family event in the evening' } });
    expect(r.status).toBe(201);
    swapId = r.body.data.id;
    expect(r.body.data).toMatchObject({ status: 'pending', mine: true, requesterShift: { id: S1 }, targetShift: { id: S2 }, targetName: 'Employee 4', approvalStatus: 'PENDING' });
    expect((await domainEvents(h.admin, 'shift.swap_requested')).at(-1)!.payload).toMatchObject({ swapId, userIds: [emp4User] });
    expect((await h.request('POST', `${base()}/me/shift-swaps`, { token: emp4User, body: { date: day, withEmployeeId: f.e1, reason: 'Again' } })).status).toBe(409);
    const theirs = await h.request('GET', `${base()}/me/shift-swaps`, { token: emp4User });
    expect(theirs.body.data).toEqual([expect.objectContaining({ id: swapId, mine: false })]);
    expect((await h.request('POST', `${base()}/me/shift-swaps/${swapId}/cancel`, { token: emp4User })).status).toBe(403);
  });

  it('approval writes two one-day assignments and splits the ones that covered the day', async () => {
    const [req] = await requestOf(swapId);
    const ok = await h.request('POST', `${base()}/approvals/${req!.id}/decide`, { token: f.managerUser, body: { stepNo: 1, decision: 'APPROVE' } });
    expect(ok.status).toBe(200);
    const swap = await h.admin.selectFrom('shiftSwapRequests').selectAll().where('id', '=', swapId).executeTakeFirstOrThrow();
    expect(swap.status).toBe('approved');
    const iso = (d: Date | string | null) => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    const mine = (await h.admin.selectFrom('shiftAssignments').selectAll().where('targetId', '=', f.e1).orderBy('effectiveFrom').execute()).map((a) => `${iso(a.effectiveFrom)}→${iso(a.effectiveTo)}:${a.shiftId === S1 ? 'S1' : 'S2'}`);
    const next = new Date(`${day}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    const dayAfter = next.toISOString().slice(0, 10);
    expect(mine).toEqual([`2026-01-01→${day}:S1`, `${day}→${dayAfter}:S2`, `${dayAfter}→null:S1`]);
    const shiftTab = await h.request('GET', `${base()}/me/shift`, { token: f.employeeUser });
    expect(shiftTab.body.data.upcoming.find((x: { date: string }) => x.date === day)).toMatchObject({ shift: { id: S2 }, swap: { id: swapId, status: 'approved', withEmployeeName: 'Employee 4' } });
    expect((await domainEvents(h.admin, 'shift.swap_decided')).at(-1)!.payload).toMatchObject({ decision: 'approved', userIds: expect.arrayContaining([f.employeeUser, emp4User]) });
  });
});

describe('statistics and the portal home', () => {
  it('own statistics with hints and punctuality', async () => {
    const r = await h.request('GET', `${base()}/me/stats?range=30d`, { token: f.employeeUser });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ range: '30d', workingDays: 4, presentDays: 2, absentDays: 2, lateDays: 1, attendancePct: 50, targets: { attendancePct: 90, fullDayHours: 8 } });
    expect(r.body.data.hints.map((x: { kind: string }) => x.kind)).toEqual(expect.arrayContaining(['low_attendance', 'late_days', 'absent_days']));
    expect(r.body.data.punctuality).toHaveProperty('last7Days');
    expect((await h.request('GET', `${base()}/me/stats?range=decade`, { token: f.employeeUser })).status).toBe(400);
  });

  it('the overview keeps every existing field and adds the open items', async () => {
    const r = await h.request('GET', `${base()}/me/overview`, { token: f.employeeUser });
    expect(r.status).toBe(200);
    for (const key of ['date', 'timezone', 'today', 'month', 'recent', 'balances', 'upcomingLeave', 'pendingLeave', 'pendingCorrections', 'upcomingHolidays']) expect(r.body.data).toHaveProperty(key);
    expect(r.body.data).toMatchObject({ pendingNotes: 0, infoRequestedNotes: 0, pendingRegularisations: 0, pendingSwaps: 0 });
    expect(r.body.data.punch).toMatchObject({ lastDirection: null, checkInEnabled: false, canCheckIn: false });
    // no reason requirement switched on: the field is not sent at all
    expect(r.body.data).not.toHaveProperty('reasonsRequired');
  });

  it('counts the recent days that need a reason once the organisation requires one, until one is given', async () => {
    const days = { absent: isoToday(-3), late: isoToday(-2), present: isoToday(-1) };
    await seedDay(e4, days.absent, 'ABSENT');
    await seedDay(e4, days.late, 'PRESENT', ['LATE']);
    await seedDay(e4, days.present, 'PRESENT');
    await seedDay(e4, isoToday(0), 'ABSENT'); // today is still running: never counted
    const setNotes = async (notes: { requireReasonForLate: boolean; requireReasonForAbsent: boolean }) => {
      const row = await h.admin.selectFrom('organizationSettings').select('attendance').where('organizationId', '=', f.orgId).executeTakeFirstOrThrow();
      const att = (typeof row.attendance === 'string' ? JSON.parse(row.attendance) : row.attendance ?? {}) as Record<string, unknown>;
      await h.admin.updateTable('organizationSettings').set({ attendance: JSON.stringify({ ...att, notes }) }).where('organizationId', '=', f.orgId).execute();
    };
    const required = async () => (await h.request('GET', `${base()}/me/overview`, { token: emp4User })).body.data.reasonsRequired;
    await setNotes({ requireReasonForLate: false, requireReasonForAbsent: true });
    expect(await required()).toBe(1);
    await setNotes({ requireReasonForLate: true, requireReasonForAbsent: true });
    expect(await required()).toBe(2);
    expect((await note(days.absent, {}, emp4User)).status).toBe(201);
    expect(await required()).toBe(1);
    await setNotes({ requireReasonForLate: false, requireReasonForAbsent: false });
  });
});
