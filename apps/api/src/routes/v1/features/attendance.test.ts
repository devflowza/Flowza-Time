import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { auditRows, createApiHarness, domainEvents, queueJobs, seedDevice, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture; let device: string;
const DAY = '2026-08-03';
beforeAll(async () => {
  h = await createApiHarness(`flowza_api_att_${process.pid}`); f = await seedOrg(h.admin, 'att');
  device = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'ATT-1' });
  for (const [emp, branch, status, flags] of [[f.e1, f.branchA, 'PRESENT', ['LATE']], [f.e3, f.branchA, 'ABSENT', []], [f.e2, f.branchB, 'PRESENT', []]] as const) {
    await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId: emp, attendanceDate: DAY, branchId: branch, timezone: 'Asia/Muscat', engineVersion: 'test', status, flags: [...flags], workedMinutes: status === 'PRESENT' ? 480 : 0, lateMinutes: flags.includes('LATE') ? 12 : 0, trace: JSON.stringify({ punches: [] }) }).execute();
  }
  await h.admin.insertInto('attendanceEvents').values({ organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, punchedAt: new Date(`${DAY}T04:12:00Z`), eventType: 'PUNCH', source: 'DEVICE', deviceId: device }).execute();
});
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;

describe('attendance reads', () => {
  it('returns the daily grid with branch scope and self-service restriction', async () => {
    const all = await h.request('GET', `${base()}/attendance/daily?date=${DAY}`, { token: f.hrAdmin });
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(3);
    expect(all.body.meta.byStatus).toEqual({ PRESENT: 2, ABSENT: 1 });
    const late = await h.request('GET', `${base()}/attendance/daily?date=${DAY}&flag=LATE`, { token: f.hrAdmin });
    expect(late.body.data.map((r: { employeeId: string }) => r.employeeId)).toEqual([f.e1]);
    const bm = await h.request('GET', `${base()}/attendance/daily?date=${DAY}`, { token: f.branchManagerB });
    expect(bm.body.data.map((r: { employeeId: string }) => r.employeeId)).toEqual([f.e2]);
    const self = await h.request('GET', `${base()}/attendance/daily?date=${DAY}`, { token: f.employeeUser });
    expect(self.body.data.map((r: { employeeId: string }) => r.employeeId)).toEqual([f.e1]);
    const outsider = await h.request('GET', `${base()}/attendance/daily?date=${DAY}`, { token: f.outsider });
    expect(outsider.status).toBe(403);
  });

  it('builds the monthly grid and the record detail with events/history', async () => {
    const m = await h.request('GET', `${base()}/attendance/monthly?month=2026-08&branchId=${f.branchA}`, { token: f.hrAdmin });
    expect(m.status).toBe(200);
    expect(m.body.meta.days).toHaveLength(31);
    const e1 = m.body.data.find((r: { employeeId: string }) => r.employeeId === f.e1);
    expect(e1.days[DAY].status).toBe('PRESENT');
    expect(e1.totals.late).toBe(1);
    const recordId = e1.days[DAY].recordId as string;
    const detail = await h.request('GET', `${base()}/attendance/records/${recordId}`, { token: f.hrAdmin });
    expect(detail.status).toBe(200);
    expect(detail.body.data.events).toHaveLength(1);
    expect(detail.body.data.history).toEqual([]);
    const events = await h.request('GET', `${base()}/attendance/events?employeeId=${f.e1}&from=2026-08-01&to=2026-08-31`, { token: f.hrAdmin });
    expect(events.body.data).toHaveLength(1);
    const tooLong = await h.request('GET', `${base()}/attendance/events?employeeId=${f.e1}&from=2026-01-01&to=2026-08-31`, { token: f.hrAdmin });
    expect(tooLong.status).toBe(400);
    const bmDenied = await h.request('GET', `${base()}/attendance/records/${recordId}`, { token: f.branchManagerB });
    expect(bmDenied.status).toBe(404); // RLS hides the other branch's record entirely
  });

  it('lists raw transactions with cursor pagination and re-queues unmatched rows', async () => {
    await sql`insert into public.attendance_raw_transactions (organization_id, device_id, branch_id, provider_key, device_employee_id, punched_at, dedupe_hash, source, processing_status)
      values (${f.orgId}::uuid, ${device}::uuid, ${f.branchA}::uuid, 'mock', 'GHOST-1', '2026-08-03T05:00:00Z', 'h1', 'POLL', 'unmatched'), (${f.orgId}::uuid, ${device}::uuid, ${f.branchA}::uuid, 'mock', '1001', '2026-08-03T05:01:00Z', 'h2', 'POLL', 'normalized')`.execute(h.admin);
    const denied = await h.request('GET', `${base()}/attendance/raw`, { token: f.hrUser });
    expect(denied.status).toBe(403);
    const page1 = await h.request('GET', `${base()}/attendance/raw?limit=1`, { token: f.hrAdmin });
    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.meta.nextCursor).toBeTypeOf('string');
    const page2 = await h.request('GET', `${base()}/attendance/raw?limit=1&cursor=${page1.body.meta.nextCursor}`, { token: f.hrAdmin });
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    const unmatched = await h.request('GET', `${base()}/attendance/raw?processingStatus=unmatched`, { token: f.hrAdmin });
    const rawId = unmatched.body.data[0].id as string;
    const requeue = await h.request('POST', `${base()}/attendance/raw/${rawId}/requeue`, { token: f.hrAdmin });
    expect(requeue.status).toBe(200);
    expect(requeue.body.data.processingStatus).toBe('pending');
    expect((await queueJobs(h.admin, 'NORMALIZE_RAW')).some((j) => j.dedupeKey === `normalize:${f.orgId}`)).toBe(true);
    const normalizedId = (await h.request('GET', `${base()}/attendance/raw?processingStatus=normalized`, { token: f.hrAdmin })).body.data[0].id;
    expect((await h.request('POST', `${base()}/attendance/raw/${normalizedId}/requeue`, { token: f.hrAdmin })).status).toBe(409);
  });
});

describe('corrections and approvals', () => {
  it('routes a correction from a requester without approve rights to hr_admin and applies it on approval', async () => {
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: { employeeId: f.e1, attendanceDate: DAY, type: 'ADD_PUNCH', proposedPunchedAt: `${DAY}T13:05:00Z`, reason: 'Forgot to punch out' } });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('PENDING');
    expect(r.body.data.approval).toBe('PENDING');
    const requestId = r.body.data.approvalRequestId as string;
    const steps = await h.admin.selectFrom('approvalSteps').selectAll().where('requestId', '=', requestId).execute();
    expect(steps).toHaveLength(1);
    expect(steps[0]!.approverType).toBe('ROLE');
    expect((await domainEvents(h.admin, 'approval.pending')).length).toBe(1);
    // inbox: hr_admin sees it, hr_user does not, employee user does not
    const inbox = await h.request('GET', `${base()}/approvals/inbox`, { token: f.hrAdmin });
    expect(inbox.body.data.map((i: { requestId: string }) => i.requestId)).toContain(requestId);
    expect(inbox.body.data[0].correction.employeeId).toBe(f.e1);
    expect((await h.request('GET', `${base()}/approvals/inbox`, { token: f.hrUser })).body.data).toHaveLength(0);
    // only the step approver can act
    const wrong = await h.request('POST', `${base()}/approvals/${requestId}/approve`, { token: f.hrUser, body: {} });
    expect(wrong.status).toBe(403);
    const ok = await h.request('POST', `${base()}/approvals/${requestId}/approve`, { token: f.hrAdmin, body: { comment: 'Confirmed with supervisor' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('APPROVED');
    expect(ok.body.data.correction.status).toBe('APPROVED');
    const apply = await queueJobs(h.admin, 'APPLY_CORRECTION');
    expect(apply).toHaveLength(1);
    expect(apply[0]!.queueName).toBe('processing');
    expect(apply[0]!.payload).toEqual({ organizationId: f.orgId, correctionId: r.body.data.id });
    expect((await domainEvents(h.admin, 'attendance.correction_approved')).length).toBe(1);
    expect((await auditRows(h.admin, 'approval.approved')).length).toBe(1);
    const twice = await h.request('POST', `${base()}/approvals/${requestId}/approve`, { token: f.hrAdmin, body: {} });
    expect(twice.status).toBe(409);
  });

  it('auto-approves when the requester holds attendance.approve and no workflow exists', async () => {
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.owner, body: { employeeId: f.e2, attendanceDate: DAY, type: 'SET_STATUS', proposedStatus: 'LEAVE', reason: 'Approved sick leave' } });
    expect(r.status).toBe(201);
    expect(r.body.data.approval).toBe('AUTO_APPROVED');
    expect(r.body.data.status).toBe('APPROVED');
    expect((await queueJobs(h.admin, 'APPLY_CORRECTION')).length).toBe(2);
    const dup = await h.request('POST', `${base()}/attendance/corrections`, { token: f.owner, body: { employeeId: f.e2, attendanceDate: DAY, type: 'SET_STATUS', proposedStatus: 'LEAVE', reason: 'Approved sick leave again' } });
    expect(dup.status).toBe(409);
  });

  it('uses the default workflow: MANAGER step resolves to the manager user, rejection records the reason', async () => {
    const wf = await h.request('POST', `${base()}/approval-workflows`, { token: f.owner, body: { name: 'Manager then HR', steps: [{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'ROLE', roleId: '10000000-0000-0000-0000-000000000003' }] } });
    expect(wf.status).toBe(201);
    expect((await h.request('POST', `${base()}/approval-workflows`, { token: f.hrAdmin, body: { name: 'x', steps: [{ order: 1, approverType: 'MANAGER' }] } })).status).toBe(403);
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: { employeeId: f.e1, attendanceDate: '2026-08-04', type: 'ADD_PUNCH', proposedPunchedAt: '2026-08-04T04:00:00Z', reason: 'Device offline' } });
    expect(r.status).toBe(201);
    const requestId = r.body.data.approvalRequestId as string;
    const steps = await h.admin.selectFrom('approvalSteps').selectAll().where('requestId', '=', requestId).orderBy('stepNo').execute();
    expect(steps).toHaveLength(2);
    expect(steps[0]!.approverType).toBe('MANAGER');
    expect(steps[0]!.approverUserId).toBe(f.managerUser); // e1's manager is e3, linked to managerUser
    expect(steps[1]!.approverRoleId).toBe('10000000-0000-0000-0000-000000000003');
    // manager sees it in the inbox although the hr_user role lacks attendance.approve
    const inbox = await h.request('GET', `${base()}/approvals/inbox`, { token: f.managerUser });
    expect(inbox.body.data.map((i: { requestId: string }) => i.requestId)).toContain(requestId);
    expect((await h.request('POST', `${base()}/approvals/${requestId}/approve`, { token: f.hrAdmin, body: {} })).status).toBe(403); // step 1 is the manager's
    const step1 = await h.request('POST', `${base()}/approvals/${requestId}/approve`, { token: f.managerUser, body: { comment: 'ok' } });
    expect(step1.status).toBe(200);
    expect(step1.body.data.status).toBe('PENDING');
    expect(step1.body.data.currentStep).toBe(2);
    expect((await h.request('POST', `${base()}/approvals/${requestId}/reject`, { token: f.hrAdmin, body: {} })).status).toBe(400); // reject needs a comment
    const rejected = await h.request('POST', `${base()}/approvals/${requestId}/reject`, { token: f.hrAdmin, body: { comment: 'No evidence' } });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('REJECTED');
    expect(rejected.body.data.correction).toMatchObject({ status: 'REJECTED', rejectionReason: 'No evidence' });
    expect((await domainEvents(h.admin, 'attendance.correction_rejected')).length).toBe(1);
    expect((await queueJobs(h.admin, 'APPLY_CORRECTION')).length).toBe(2); // unchanged
    // requester can cancel their own pending correction; approvers can cancel others
    const c2 = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: { employeeId: f.e1, attendanceDate: '2026-08-05', type: 'ADD_PUNCH', proposedPunchedAt: '2026-08-05T04:00:00Z', reason: 'Late punch' } });
    expect((await h.request('POST', `${base()}/attendance/corrections/${c2.body.data.id}/cancel`, { token: f.employeeUser, body: {} })).status).toBe(403);
    const cancelled = await h.request('POST', `${base()}/attendance/corrections/${c2.body.data.id}/cancel`, { token: f.hrUser, body: { reason: 'mistake' } });
    expect(cancelled.body.data.status).toBe('CANCELLED');
    const list = await h.request('GET', `${base()}/attendance/corrections?status=CANCELLED`, { token: f.hrAdmin });
    expect(list.body.meta.total).toBe(1);
  });

  it('blocks corrections inside a locked period until it is unlocked', async () => {
    const noPerm = await h.request('POST', `${base()}/attendance/periods/lock`, { token: f.hrUser, body: { periodStart: '2026-07-01', periodEnd: '2026-07-31' } });
    expect(noPerm.status).toBe(403);
    const lock = await h.request('POST', `${base()}/attendance/periods/lock`, { token: f.hrAdmin, body: { periodStart: '2026-07-01', periodEnd: '2026-07-31', reason: 'Payroll July' } });
    expect(lock.status).toBe(201);
    expect(lock.body.data.active).toBe(true);
    const blocked = await h.request('POST', `${base()}/attendance/corrections`, { token: f.owner, body: { employeeId: f.e1, attendanceDate: '2026-07-15', type: 'ADD_PUNCH', proposedPunchedAt: '2026-07-15T04:00:00Z', reason: 'Missing punch' } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PERIOD_LOCKED');
    const overlap = await h.request('POST', `${base()}/attendance/periods/lock`, { token: f.hrAdmin, body: { periodStart: '2026-07-20', periodEnd: '2026-08-10' } });
    expect(overlap.status).toBe(409);
    const periods = await h.request('GET', `${base()}/attendance/periods`, { token: f.hrUser });
    expect(periods.body.data).toHaveLength(1);
    const unlock = await h.request('POST', `${base()}/attendance/periods/${lock.body.data.id}/unlock`, { token: f.hrAdmin, body: { reason: 'Late correction approved by finance' } });
    expect(unlock.status).toBe(200);
    expect(unlock.body.data.active).toBe(false);
    const allowed = await h.request('POST', `${base()}/attendance/corrections`, { token: f.owner, body: { employeeId: f.e1, attendanceDate: '2026-07-15', type: 'ADD_PUNCH', proposedPunchedAt: '2026-07-15T04:00:00Z', reason: 'Missing punch' } });
    expect(allowed.status).toBe(201);
    expect((await auditRows(h.admin, 'attendance.period_unlocked')).length).toBe(1);
  });

  it('creates recalculation requests and enqueues RECALCULATE_RANGE', async () => {
    const denied = await h.request('POST', `${base()}/attendance/recalculate`, { token: f.hrUser, body: { fromDate: '2026-08-01', toDate: '2026-08-03', reason: 'rules changed' } });
    expect(denied.status).toBe(403);
    const r = await h.request('POST', `${base()}/attendance/recalculate`, { token: f.hrAdmin, body: { fromDate: '2026-08-01', toDate: '2026-08-03', branchId: f.branchA, reason: 'rules changed' } });
    expect(r.status).toBe(202);
    expect(r.body.data.status).toBe('QUEUED');
    const jobs = await queueJobs(h.admin, 'RECALCULATE_RANGE');
    expect(jobs.some((j) => j.payload.requestId === r.body.data.requestId && j.payload.organizationId === f.orgId && j.queueName === 'processing')).toBe(true);
    const list = await h.request('GET', `${base()}/attendance/recalculations`, { token: f.hrAdmin });
    expect(list.body.data[0]).toMatchObject({ id: r.body.data.requestId, status: 'QUEUED', branchId: f.branchA });
  });
});
