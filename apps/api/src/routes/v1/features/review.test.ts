import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, queueJobs, seedDevice, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

/**
 * Adversarial review of the feature API: PATCH must not reset defaulted fields (Zod 4 `.partial()` re-applies defaults),
 * boolean query parameters must treat "false" as false, approvals need separation of duties + a row lock, branch-scoped
 * callers must not touch organisation-wide sync jobs, leave changes must respect period locks and report scopes must not be
 * widened through employee ids the caller cannot see.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
beforeAll(async () => { h = await createApiHarness(`flowza_api_review_${process.pid}`); f = await seedOrg(h.admin, 'rev'); });
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;
const recalcCount = async () => (await queueJobs(h.admin, 'RECALCULATE_RANGE')).length;

describe('PATCH keeps every field the client did not send', () => {
  it('rule sets: renaming does not reset the rules to their defaults', async () => {
    const r = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.hrAdmin, body: { name: 'Strict', branchId: f.branchA, effectiveFrom: '2026-01-01', graceInMinutes: 15, overtimeEnabled: false, punchInterpretation: 'PAIRED' } });
    expect(r.status).toBe(201);
    const before = await recalcCount();
    const p = await h.request('PATCH', `${base()}/attendance-rule-sets/${r.body.data.id}`, { token: f.hrAdmin, body: { name: 'Strict v2' } });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ name: 'Strict v2', graceInMinutes: 15, overtimeEnabled: false, punchInterpretation: 'PAIRED', branchId: f.branchA });
    const row = await h.admin.selectFrom('attendanceRuleSets').select(['graceInMinutes', 'overtimeEnabled']).where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ graceInMinutes: 15, overtimeEnabled: false });
    expect(await recalcCount()).toBe(before + 1); // the rename still records the version bump / recalc once
  });

  it('shifts: renaming keeps type, breaks and punch windows', async () => {
    const r = await h.request('POST', `${base()}/shifts`, { token: f.hrAdmin, body: { code: 'NIGHT', name: 'Night', type: 'FIXED', startTime: '22:00', endTime: '06:00', punchInWindowBeforeMinutes: 60, breaks: [{ start: '01:00', end: '01:30', paid: true }], status: 'inactive' } });
    expect(r.status).toBe(201);
    const p = await h.request('PATCH', `${base()}/shifts/${r.body.data.id}`, { token: f.hrAdmin, body: { name: 'Night shift' } });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ name: 'Night shift', type: 'FIXED', punchInWindowBeforeMinutes: 60, status: 'inactive', startTime: '22:00' });
    expect(p.body.data.breaks).toHaveLength(1);
    // switching to FIXED without times is still rejected on update
    const flex = await h.request('POST', `${base()}/shifts`, { token: f.hrAdmin, body: { code: 'FLEX', name: 'Flex', type: 'FLEXIBLE', requiredMinutes: 480 } });
    expect(flex.status).toBe(201);
    expect((await h.request('PATCH', `${base()}/shifts/${flex.body.data.id}`, { token: f.hrAdmin, body: { type: 'FIXED' } })).status).toBe(400);
  });

  it('approval workflows, holiday calendars, holidays and leave types keep their flags', async () => {
    const wf = await h.request('POST', `${base()}/approval-workflows`, { token: f.owner, body: { name: 'Secondary', isDefault: false, status: 'inactive', steps: [{ order: 1, approverType: 'ROLE', roleId: '10000000-0000-0000-0000-000000000003' }] } });
    expect(wf.status).toBe(201);
    const wfp = await h.request('PATCH', `${base()}/approval-workflows/${wf.body.data.id}`, { token: f.owner, body: { name: 'Secondary v2' } });
    expect(wfp.status).toBe(200);
    expect(wfp.body.data).toMatchObject({ name: 'Secondary v2', isDefault: false, status: 'inactive' });

    const cal = await h.request('POST', `${base()}/holiday-calendars`, { token: f.hrAdmin, body: { name: 'Main', isDefault: true } });
    expect(cal.status).toBe(201);
    const calp = await h.request('PATCH', `${base()}/holiday-calendars/${cal.body.data.id}`, { token: f.hrAdmin, body: { name: 'Main calendar' } });
    expect(calp.body.data).toMatchObject({ name: 'Main calendar', isDefault: true });

    const hol = await h.request('POST', `${base()}/holidays`, { token: f.hrAdmin, body: { calendarId: cal.body.data.id, name: 'Eid', date: '2030-03-30', type: 'RELIGIOUS', isTentative: true, isHalfDay: true } });
    expect(hol.status).toBe(201);
    const holp = await h.request('PATCH', `${base()}/holidays/${hol.body.data.id}`, { token: f.hrAdmin, body: { name: 'Eid al-Fitr' } });
    expect(holp.body.data).toMatchObject({ name: 'Eid al-Fitr', type: 'RELIGIOUS', isTentative: true, isHalfDay: true });

    const lt = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'UL', name: 'Unpaid', isPaid: false } });
    expect(lt.status).toBe(201);
    const before = await recalcCount();
    const ltp = await h.request('PATCH', `${base()}/leave-types/${lt.body.data.id}`, { token: f.hrAdmin, body: { name: 'Unpaid leave' } });
    expect(ltp.body.data).toMatchObject({ name: 'Unpaid leave', isPaid: false });
    expect(await recalcCount()).toBe(before); // the paid flag did not "change", so nothing is recomputed
  });
});

describe('boolean query parameters', () => {
  it('DELETE /devices/:id?decommission=false disables instead of decommissioning', async () => {
    const id = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'BOOL-1' });
    const r = await h.request('DELETE', `${base()}/devices/${id}?decommission=false`, { token: f.owner });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('disabled');
    const hidden = await h.request('GET', `${base()}/devices?includeDecommissioned=false`, { token: f.owner });
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.some((d: { id: string }) => d.id === id)).toBe(true);
    expect((await h.request('GET', `${base()}/devices?includeDecommissioned=maybe`, { token: f.owner })).status).toBe(400);
  });
});

describe('approvals: separation of duties and concurrency', () => {
  it('forbids approving your own correction and applies a single approval under concurrent requests', async () => {
    const wf = await h.request('POST', `${base()}/approval-workflows`, { token: f.owner, body: { name: 'HR approves', steps: [{ order: 1, approverType: 'ROLE', roleId: '10000000-0000-0000-0000-000000000003' }] } });
    expect(wf.status).toBe(201);
    const own = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrAdmin, body: { employeeId: f.e2, attendanceDate: '2026-08-10', type: 'ADD_PUNCH', proposedPunchedAt: '2026-08-10T04:00:00Z', reason: 'Own request' } });
    expect(own.status).toBe(201);
    expect(own.body.data.approval).toBe('PENDING');
    const self = await h.request('POST', `${base()}/approvals/${own.body.data.approvalRequestId}/approve`, { token: f.hrAdmin, body: {} });
    expect(self.status).toBe(403);
    expect((await h.request('POST', `${base()}/approvals/${own.body.data.approvalRequestId}/approve`, { token: f.owner, body: {} })).status).toBe(200);

    const other = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: { employeeId: f.e1, attendanceDate: '2026-08-11', type: 'ADD_PUNCH', proposedPunchedAt: '2026-08-11T04:00:00Z', reason: 'Device offline' } });
    expect(other.status).toBe(201);
    const requestId = other.body.data.approvalRequestId as string;
    const results = await Promise.all([1, 2, 3].map(() => h.request('POST', `${base()}/approvals/${requestId}/approve`, { token: f.hrAdmin, body: { comment: 'ok' } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const jobs = (await queueJobs(h.admin, 'APPLY_CORRECTION')).filter((j) => j.payload.correctionId === other.body.data.id);
    expect(jobs).toHaveLength(1);
    const steps = await h.admin.selectFrom('approvalSteps').select(['status', 'actedBy']).where('requestId', '=', requestId).execute();
    expect(steps).toEqual([{ status: 'APPROVED', actedBy: f.hrAdmin }]);
  });
});

describe('sync jobs: branch scope on organisation-wide jobs', () => {
  it('a branch manager cannot cancel or retry a job that spans other branches', async () => {
    await seedDevice(h.admin, f.orgId, f.branchA, { code: 'SC-A' });
    await seedDevice(h.admin, f.orgId, f.branchB, { code: 'SC-B' });
    const job = await h.request('POST', `${base()}/sync/attendance`, { token: f.owner, body: { all: true } });
    expect(job.status).toBe(202);
    expect(job.body.data.deviceCount).toBeGreaterThanOrEqual(2);
    const cancel = await h.request('POST', `${base()}/sync/jobs/${job.body.data.jobId}/cancel`, { token: f.branchManagerB });
    expect(cancel.status).toBe(403);
    expect((await h.admin.selectFrom('syncJobs').select('status').where('id', '=', job.body.data.jobId).executeTakeFirstOrThrow()).status).toBe('QUEUED');
    await h.admin.updateTable('syncJobItems').set({ status: 'FAILED' }).where('syncJobId', '=', job.body.data.jobId).execute();
    expect((await h.request('POST', `${base()}/sync/jobs/${job.body.data.jobId}/retry-failed`, { token: f.branchManagerB })).status).toBe(403);
    expect((await h.request('POST', `${base()}/sync/jobs/${job.body.data.jobId}/cancel`, { token: f.owner })).status).toBe(200);
  });

  it('retry-failed replays the original options (fullResync) instead of dropping them', async () => {
    const job = await h.request('POST', `${base()}/sync/attendance`, { token: f.owner, body: { branchId: f.branchA, fullResync: true } });
    expect(job.status).toBe(202);
    await h.admin.updateTable('syncJobItems').set({ status: 'FAILED' }).where('syncJobId', '=', job.body.data.jobId).execute();
    await h.admin.updateTable('syncJobs').set({ status: 'FAILED' }).where('id', '=', job.body.data.jobId).execute();
    const retry = await h.request('POST', `${base()}/sync/jobs/${job.body.data.jobId}/retry-failed`, { token: f.owner });
    expect(retry.status).toBe(202);
    const queued = (await queueJobs(h.admin, 'PULL_ATTENDANCE')).filter((j) => j.payload.syncJobId === retry.body.data.jobId);
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((j) => (j.payload.options as { fullResync?: boolean }).fullResync === true)).toBe(true);
  });
});

describe('leave records respect period locks', () => {
  it('rejects leave that overlaps a locked period on create, update and cancel', async () => {
    const lt = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'SL', name: 'Sick', isPaid: true } });
    const inMay = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: f.e3, leaveTypeId: lt.body.data.id, startDate: '2026-05-10', endDate: '2026-05-12' } });
    expect(inMay.status).toBe(201);
    const lock = await h.request('POST', `${base()}/attendance/periods/lock`, { token: f.hrAdmin, body: { periodStart: '2026-05-01', periodEnd: '2026-05-31', reason: 'Payroll May' } });
    expect(lock.status).toBe(201);
    const spanning = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: f.e1, leaveTypeId: lt.body.data.id, startDate: '2026-04-28', endDate: '2026-06-02' } });
    expect(spanning.status).toBe(409);
    expect(spanning.body.code).toBe('PERIOD_LOCKED');
    expect((await h.request('PATCH', `${base()}/leave-records/${inMay.body.data.id}`, { token: f.hrAdmin, body: { endDate: '2026-05-13' } })).status).toBe(409);
    expect((await h.request('DELETE', `${base()}/leave-records/${inMay.body.data.id}`, { token: f.hrAdmin })).status).toBe(409);
    const june = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: f.e1, leaveTypeId: lt.body.data.id, startDate: '2026-06-10', endDate: '2026-06-11' } });
    expect(june.status).toBe(201);
    expect((await h.request('PATCH', `${base()}/leave-records/${june.body.data.id}`, { token: f.hrAdmin, body: { startDate: '2026-05-20' } })).status).toBe(409);
    expect((await h.request('PATCH', `${base()}/leave-records/${june.body.data.id}`, { token: f.hrAdmin, body: { endDate: '2026-06-12' } })).status).toBe(200);
  });
});

describe('reports: employee scope', () => {
  it('rejects employee ids outside the caller branch scope instead of silently passing them to the worker', async () => {
    const r = await h.request('POST', `${base()}/reports`, { token: f.branchManagerB, body: { reportType: 'employee_attendance', format: 'csv', parameters: { from: '2026-08-01', to: '2026-08-31', employeeIds: [f.e1] } } });
    expect(r.status).toBe(400);
    const ok = await h.request('POST', `${base()}/reports`, { token: f.branchManagerB, body: { reportType: 'employee_attendance', format: 'csv', parameters: { from: '2026-08-01', to: '2026-08-31', employeeIds: [f.e2] } } });
    expect(ok.status).toBe(202);
  });
});
