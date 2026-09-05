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
    expect(types.body.data.find((t: { key: string }) => t.key === 'payroll_summary').allowed).toBe(true);
    expect(types.body.data.find((t: { key: string }) => t.key === 'audit_report').allowed).toBe(false);
    const missing = await h.request('POST', `${base()}/reports`, { token: f.hrAdmin, body: { reportType: 'late_report', parameters: { from: '2026-08-01' } } });
    expect(missing.status).toBe(400);
    const noPerm = await h.request('POST', `${base()}/reports`, { token: f.hrUser, body: { reportType: 'audit_report', parameters: { from: '2026-08-01', to: '2026-08-31' } } });
    expect(noPerm.status).toBe(403);
  });

  it('queues GENERATE_REPORT, injects branch scope for restricted callers and gates download on COMPLETED', async () => {
    const r = await h.request('POST', `${base()}/reports`, { token: f.branchManagerB, body: { reportType: 'late_report', format: 'csv', parameters: { from: '2026-08-01', to: '2026-08-31' } } });
    expect(r.status).toBe(202);
    expect(r.body.data.status).toBe('QUEUED');
    expect(r.body.data.parameters.branchId).toBe(f.branchB);
    const jobs = await queueJobs(h.admin, 'GENERATE_REPORT');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.queueName).toBe('reports');
    expect(jobs[0]!.payload).toEqual({ organizationId: f.orgId, reportRequestId: r.body.data.id });
    const widen = await h.request('POST', `${base()}/reports`, { token: f.branchManagerB, body: { reportType: 'late_report', parameters: { from: '2026-08-01', to: '2026-08-31', branchId: f.branchA } } });
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
