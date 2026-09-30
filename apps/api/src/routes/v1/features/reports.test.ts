import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditRows, createApiHarness, queueJobs, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
beforeAll(async () => { h = await createApiHarness(`flowza_api_reports_${process.pid}`); f = await seedOrg(h.admin, 'rep'); });
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;

describe('reports', () => {
  it('lists report types with permission hints and validates requests', async () => {
    const types = await h.request('GET', `/api/v1/report-types?orgId=${f.orgId}`, { token: f.payrollUser });
    expect(types.status).toBe(200);
    expect(types.body.data.find((t: { key: string }) => t.key === 'daily_attendance').allowed).toBe(true);
    // planned types (no generator yet) are not offered at all — offering them queued jobs that could only dead-letter
    expect(types.body.data.find((t: { key: string }) => t.key === 'payroll_summary')).toBeUndefined();
    expect(types.body.data.every((t: { status: string }) => t.status === 'available')).toBe(true);
    const asEmployee = await h.request('GET', `/api/v1/report-types?orgId=${f.orgId}`, { token: f.employeeUser });
    expect(asEmployee.body.data.find((t: { key: string }) => t.key === 'daily_attendance').allowed).toBe(false);
    const missing = await h.request('POST', `${base()}/reports`, { token: f.hrAdmin, body: { reportType: 'daily_attendance', parameters: {} } });
    expect(missing.status).toBe(400);
    const planned = await h.request('POST', `${base()}/reports`, { token: f.hrAdmin, body: { reportType: 'payroll_summary', parameters: { from: '2026-08-01', to: '2026-08-31' } } });
    expect(planned.status).toBe(400);
    const noPerm = await h.request('POST', `${base()}/reports`, { token: f.employeeUser, body: { reportType: 'daily_attendance', parameters: { from: '2026-08-01' } } });
    expect(noPerm.status).toBe(403);
  });

  it('queues GENERATE_REPORT, injects branch scope for restricted callers and gates download on COMPLETED', async () => {
    const r = await h.request('POST', `${base()}/reports`, { token: f.branchManagerB, body: { reportType: 'daily_attendance', format: 'csv', parameters: { from: '2026-08-01' } } });
    expect(r.status).toBe(202);
    expect(r.body.data.status).toBe('QUEUED');
    expect(r.body.data.parameters.branchId).toBe(f.branchB);
    const jobs = await queueJobs(h.admin, 'GENERATE_REPORT');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.queueName).toBe('reports');
    expect(jobs[0]!.payload).toEqual({ organizationId: f.orgId, reportRequestId: r.body.data.id });
    const widen = await h.request('POST', `${base()}/reports`, { token: f.branchManagerB, body: { reportType: 'daily_attendance', parameters: { from: '2026-08-01', branchId: f.branchA } } });
    expect(widen.status).toBe(403);
    const early = await h.request('GET', `${base()}/reports/${r.body.data.id}/download`, { token: f.branchManagerB });
    expect(early.status).toBe(409);
    await h.admin.updateTable('reportRequests').set({ status: 'COMPLETED', filePath: `${f.orgId}/reports/late.csv`, rowCount: 42, completedAt: new Date() }).where('id', '=', r.body.data.id).execute();
    const dl = await h.request('GET', `${base()}/reports/${r.body.data.id}/download`, { token: f.branchManagerB });
    expect(dl.status).toBe(200);
    expect(dl.body.data.url).toContain(`/reports/${f.orgId}/reports/late.csv`);
    const exported = await auditRows(h.admin, 'report.exported');
    expect((exported[0]!.newValue as { rowCount: number }).rowCount).toBe(42);
    // visibility: the requester and report.manage holders see it, another plain report.view user does not
    expect((await h.request('GET', `${base()}/reports`, { token: f.hrAdmin })).body.meta.total).toBe(1);
    expect((await h.request('GET', `${base()}/reports`, { token: f.hrUser })).body.meta.total).toBe(0);
    expect((await h.request('GET', `${base()}/reports/${r.body.data.id}`, { token: f.hrUser })).status).toBe(404);
    const cancelDone = await h.request('POST', `${base()}/reports/${r.body.data.id}/cancel`, { token: f.branchManagerB });
    expect(cancelDone.status).toBe(409);
  });

  it('6a-ATT21 the Daily Report takes a range of at most 62 days', async () => {
    const over = await h.request('POST', `${base()}/reports`, { token: f.hrAdmin, body: { reportType: 'daily_attendance', format: 'xlsx', parameters: { from: '2026-06-01', to: '2026-08-02' } } }); // 63 days
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/at most 62 days/);
    const ok = await h.request('POST', `${base()}/reports`, { token: f.hrAdmin, body: { reportType: 'daily_attendance', format: 'xlsx', parameters: { from: '2026-06-02', to: '2026-08-02' } } }); // 62 days
    expect(ok.status).toBe(202);
    expect(ok.body.data.parameters).toMatchObject({ from: '2026-06-02', to: '2026-08-02' });
  });

  it('6a-M14 a recipient cancelling their queued copy settles its delivery as cancelled', async () => {
    const request = (await h.admin.insertInto('reportRequests').values({ organizationId: f.orgId, reportType: 'late_report', format: 'csv', parameters: JSON.stringify({ from: '2026-08-01', to: '2026-08-31' }), status: 'QUEUED', requestedBy: f.hrUser }).returning('id').executeTakeFirstOrThrow()).id;
    const delivery = (await h.admin.insertInto('reportDeliveries').values({ organizationId: f.orgId, runKey: 'send:m14', mode: 'send_now', reportType: 'late_report', format: 'csv', recipientUserId: f.hrUser, sentBy: f.owner, status: 'queued', reportRequestId: request }).returning('id').executeTakeFirstOrThrow()).id;
    const cancel = await h.request('POST', `${base()}/reports/${request}/cancel`, { token: f.hrUser });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');
    const row = await h.admin.selectFrom('reportDeliveries').select(['status', 'deliveredAt']).where('id', '=', delivery).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'cancelled', deliveredAt: null });
    const trail = await h.request('GET', `${base()}/report-deliveries?status=cancelled`, { token: f.hrUser });
    expect(trail.body.data.map((d: { id: string }) => d.id)).toEqual([delivery]);
  });

  it('applies the per-organisation hourly quota', async () => {
    let last = 0;
    for (let i = 0; i < 20; i += 1) { last = (await h.request('POST', `${base()}/reports`, { token: f.hrAdmin, body: { reportType: 'daily_attendance', parameters: { from: '2026-08-01' } } })).status; if (last === 429) break; }
    const over = await h.request('POST', `${base()}/reports`, { token: f.hrAdmin, body: { reportType: 'daily_attendance', parameters: { from: '2026-08-01' } } });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
    const quota = await h.admin.selectFrom('usageQuotas').selectAll().where('organizationId', '=', f.orgId).where('metric', '=', 'reports').executeTakeFirstOrThrow();
    expect(quota.count).toBe(20); // the refused request rolled back its increment
    const cancel = await h.request('POST', `${base()}/reports/${(await h.request('GET', `${base()}/reports?status=QUEUED&pageSize=1`, { token: f.hrAdmin })).body.data[0].id}/cancel`, { token: f.hrAdmin });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');
  });
});

describe('an employee\'s own copy of a shared report (each employee receives the report about themselves)', () => {
  // what the worker writes for a self-scoped delivery (RUN_REPORT_SCHEDULE → scopeReportForRecipient kind SELF)
  const selfCopy = async (userId: string, employeeId: string, over: Record<string, unknown> = {}) => (await h.admin.insertInto('reportRequests').values({
    organizationId: f.orgId, reportType: 'monthly_attendance', format: 'pdf', status: 'COMPLETED', requestedBy: userId, filePath: `${f.orgId}/self-${employeeId}.pdf`, rowCount: 1, completedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000), parameters: JSON.stringify({ month: '2026-09', employeeIds: [employeeId], selfEmployeeId: employeeId, ...over }),
  }).returning('id').executeTakeFirstOrThrow()).id;

  it('lists the employee\'s own copies at /me/reports and lets them view (inline) and download (attachment) them', async () => {
    const mine = await selfCopy(f.employeeUser, f.e1);
    const list = await h.request('GET', `${base()}/me/reports`, { token: f.employeeUser });
    expect(list.status).toBe(200);
    expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([mine]);
    const view = await h.request('GET', `${base()}/reports/${mine}/download?disposition=inline`, { token: f.employeeUser });
    expect(view.status).toBe(200);
    expect(view.body.data).toMatchObject({ disposition: 'inline', fileName: expect.stringMatching(/^monthly_attendance-\d{4}-\d{2}-\d{2}\.pdf$/) });
    expect(view.body.data.url).not.toContain('download=');
    const dl = await h.request('GET', `${base()}/reports/${mine}/download`, { token: f.employeeUser });
    expect(dl.body.data.disposition).toBe('attachment');
    expect(dl.body.data.url).toContain('download=monthly_attendance-');
    const trail = (await auditRows(h.admin, 'report.exported')).filter((a) => a.entityId === mine);
    expect(trail.map((a) => (a.newValue as { disposition: string; selfCopy?: boolean }))).toEqual(expect.arrayContaining([expect.objectContaining({ disposition: 'inline', selfCopy: true }), expect.objectContaining({ disposition: 'attachment', selfCopy: true })]));
  });

  it('never opens anything else to an employee: another person\'s copy, a copy about somebody else, a report they merely requested', async () => {
    const other = await selfCopy(f.managerUser, f.e3);                              // somebody else's own copy
    const forged = await selfCopy(f.employeeUser, f.e1, { employeeIds: [f.e1, f.e2] }); // marker without the one-employee filter
    const aboutE2 = await selfCopy(f.employeeUser, f.e2);                            // requested by them, about somebody else
    // refused as it always was without report.view / report.export (403), whether the report exists or not
    for (const id of [other, forged, aboutE2, '00000000-0000-4000-8000-000000000000']) expect((await h.request('GET', `${base()}/reports/${id}/download`, { token: f.employeeUser })).status).toBe(403);
    const ids = (await h.request('GET', `${base()}/me/reports`, { token: f.employeeUser })).body.data.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(other); expect(ids).not.toContain(forged); expect(ids).not.toContain(aboutE2);
    // the Reports page itself stays closed to them
    expect((await h.request('GET', `${base()}/reports`, { token: f.employeeUser })).status).toBe(403);
    // a member without an employee record has no "own" reports
    expect((await h.request('GET', `${base()}/me/reports`, { token: f.hrAdmin })).status).toBe(403);
  });
});

describe('payroll', () => {
  it('derives periods from settings and requires a lock to finalise', async () => {
    const periods = await h.request('GET', `${base()}/payroll/periods?year=2026`, { token: f.payrollUser });
    expect(periods.status).toBe(200);
    expect(periods.body.data).toHaveLength(12);
    expect(periods.body.data[0]).toMatchObject({ periodStart: '2026-01-01', periodEnd: '2026-01-31', locked: false });
    expect((await h.request('GET', `${base()}/payroll/periods`, { token: f.hrUser })).status).toBe(403);
    const build = await h.request('POST', `${base()}/payroll/periods/build`, { token: f.payrollUser, body: { periodStart: '2026-07-01', periodEnd: '2026-07-31' } });
    expect(build.status).toBe(202);
    const jobs = await queueJobs(h.admin, 'BUILD_PERIOD_SUMMARY');
    expect(jobs[0]!.payload).toMatchObject({ organizationId: f.orgId, periodStart: '2026-07-01', periodEnd: '2026-07-31', finalize: false, requestedBy: f.payrollUser });
    const noLock = await h.request('POST', `${base()}/payroll/periods/finalize`, { token: f.payrollUser, body: { periodStart: '2026-07-01', periodEnd: '2026-07-31' } });
    expect(noLock.status).toBe(409);
    expect((await h.request('POST', `${base()}/payroll/periods/finalize`, { token: f.hrAdmin, body: { periodStart: '2026-07-01', periodEnd: '2026-07-31' } })).status).toBe(403);
    const lock = await h.request('POST', `${base()}/attendance/periods/lock`, { token: f.hrAdmin, body: { periodStart: '2026-07-01', periodEnd: '2026-07-31' } });
    expect(lock.status).toBe(201);
    const fin = await h.request('POST', `${base()}/payroll/periods/finalize`, { token: f.payrollUser, body: { periodStart: '2026-07-01', periodEnd: '2026-07-31' } });
    expect(fin.status).toBe(202);
    expect((await queueJobs(h.admin, 'BUILD_PERIOD_SUMMARY')).some((j) => j.payload.finalize === true)).toBe(true);
    const after = await h.request('GET', `${base()}/payroll/periods?year=2026`, { token: f.payrollUser });
    expect(after.body.data.find((p: { periodStart: string }) => p.periodStart === '2026-07-01').locked).toBe(true);
    await h.admin.insertInto('attendancePeriodSummaries').values({ organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, periodStart: '2026-07-01', periodEnd: '2026-07-31', workingDays: 22, presentDays: 20, status: 'draft' }).execute();
    const sums = await h.request('GET', `${base()}/payroll/summaries?periodStart=2026-07-01&periodEnd=2026-07-31`, { token: f.payrollUser });
    expect(sums.body.meta.total).toBe(1);
    expect(sums.body.data[0]).toMatchObject({ employeeId: f.e1, presentDays: 20, status: 'draft' });
    expect((await h.request('GET', `${base()}/payroll/summaries?periodStart=2026-07-01&periodEnd=2026-07-31`, { token: f.branchManagerB })).status).toBe(403);
  });
});

describe('leave type defaults', () => {
  it('seeds the GCC default set once, marks Site Duty as counting for presence, and leaves existing codes alone', async () => {
    await h.admin.insertInto('leaveTypes').values({ organizationId: f.orgId, code: 'AL', name: 'Annual (custom)', isPaid: true }).execute();
    const first = await h.request('POST', `${base()}/leave-types/seed-defaults`, { token: f.hrAdmin });
    expect(first.status).toBe(201);
    expect(first.body.data.created.sort()).toEqual(['CL', 'EL', 'ML', 'NP', 'SD', 'SL', 'SPL']);
    const types = first.body.data.leaveTypes as Array<{ code: string; name: string; isPaid: boolean; treatAsPresent: boolean }>;
    expect(types.find((t) => t.code === 'AL')?.name).toBe('Annual (custom)'); // untouched
    expect(types.find((t) => t.code === 'SD')).toMatchObject({ isPaid: true, treatAsPresent: true });
    expect(types.find((t) => t.code === 'NP')).toMatchObject({ isPaid: false, treatAsPresent: false });
    const again = await h.request('POST', `${base()}/leave-types/seed-defaults`, { token: f.hrAdmin });
    expect(again.body.data.created).toEqual([]);
    expect((await h.request('POST', `${base()}/leave-types/seed-defaults`, { token: f.payrollUser })).status).toBe(403);
    // a leave report may now be requested for one of them (case-insensitively); an unknown code is refused. The quota test
    // above spends the organisation's hourly allowance, so it is reset first — this test is about leave types, not quotas.
    await h.admin.deleteFrom('usageQuotas').where('organizationId', '=', f.orgId).execute();
    const ok = await h.request('POST', `${base()}/reports`, { token: f.hrAdmin, body: { reportType: 'leave_report', parameters: { from: '2026-08-01', to: '2026-08-31', leaveTypeCode: 'sl' } } });
    expect([ok.status, ok.body.code ?? null, ok.body.message ?? null, ok.body.details ?? null]).toEqual([202, null, null, null]);
    expect(ok.body.data.parameters.leaveTypeCode).toBe('SL');
    expect((await h.request('POST', `${base()}/reports`, { token: f.hrAdmin, body: { reportType: 'leave_report', parameters: { from: '2026-08-01', to: '2026-08-31', leaveTypeCode: 'XX' } } })).status).toBe(400);
  });
});
