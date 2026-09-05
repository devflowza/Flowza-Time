import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditRows, createApiHarness, queueJobs, ROLE, seedDevice, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

/**
 * Second adversarial pass: organisation-wide resources (period locks, rule sets, holidays, reports) must stay out of reach of
 * branch-scoped callers even when they hold the managing permission; device actions and health checks are audited and use the
 * shared sync fan-out (PUSH_EMPLOYEE items, SKIPPED duplicates instead of double polls).
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture; let scopedAdmin: string;
beforeAll(async () => {
  h = await createApiHarness(`flowza_api_secrev_${process.pid}`); f = await seedOrg(h.admin, 'sec');
  // hr_admin permissions (lock_period, manage_rules, holiday.manage, report.manage) restricted to branch B
  scopedAdmin = uuid('c');
  await seedUser(h.admin, scopedAdmin, 'scoped-admin-sec@test.local', 'Scoped admin');
  await seedMembership(h.admin, f.orgId, scopedAdmin, ROLE.hr_admin, { branchIds: [f.branchB] });
});
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;

describe('organisation-wide resources vs branch-scoped managers', () => {
  it('period locks: a branch-scoped user cannot unlock an organisation-wide lock', async () => {
    const org = await h.request('POST', `${base()}/attendance/periods/lock`, { token: f.owner, body: { periodStart: '2025-01-01', periodEnd: '2025-01-31', reason: 'Payroll Jan' } });
    expect(org.status).toBe(201);
    const denied = await h.request('POST', `${base()}/attendance/periods/${org.body.data.id}/unlock`, { token: scopedAdmin, body: { reason: 'oops' } });
    expect(denied.status).toBe(403);
    expect((await h.admin.selectFrom('attendancePeriodLocks').select('unlockedAt').where('id', '=', org.body.data.id).executeTakeFirstOrThrow()).unlockedAt).toBeNull();
    const own = await h.request('POST', `${base()}/attendance/periods/lock`, { token: scopedAdmin, body: { branchId: f.branchB, periodStart: '2025-02-01', periodEnd: '2025-02-28' } });
    expect(own.status).toBe(201);
    expect((await h.request('POST', `${base()}/attendance/periods/${own.body.data.id}/unlock`, { token: scopedAdmin, body: { reason: 'reopen' } })).status).toBe(200);
    expect((await h.request('POST', `${base()}/attendance/periods/${org.body.data.id}/unlock`, { token: f.owner, body: { reason: 'reopen' } })).status).toBe(200);
  });

  it('rule sets: the organisation-wide set can neither be edited nor deleted by a branch-scoped user', async () => {
    const org = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.owner, body: { name: 'Org default', effectiveFrom: '2025-01-01' } });
    expect(org.status).toBe(201);
    // the recompute range (2025-01-01 → today) exceeds the 366-day limit of one recalculation request: it is chunked, never a 500
    const chunks = await h.admin.selectFrom('attendanceRecalculationRequests').select(['fromDate', 'toDate', 'queueJobId']).where('reason', '=', 'rule set Org default created').orderBy('fromDate').execute();
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.queueJobId !== null)).toBe(true);
    expect(chunks[0]!.fromDate.toISOString().slice(0, 10)).toBe('2025-01-01');
    expect((await h.request('PATCH', `${base()}/attendance-rule-sets/${org.body.data.id}`, { token: scopedAdmin, body: { graceInMinutes: 59 } })).status).toBe(403);
    expect((await h.request('DELETE', `${base()}/attendance-rule-sets/${org.body.data.id}`, { token: scopedAdmin })).status).toBe(403);
    expect((await h.admin.selectFrom('attendanceRuleSets').select('graceInMinutes').where('id', '=', org.body.data.id).executeTakeFirstOrThrow()).graceInMinutes).not.toBe(59);
    const own = await h.request('POST', `${base()}/attendance-rule-sets`, { token: scopedAdmin, body: { name: 'Branch B', branchId: f.branchB, effectiveFrom: '2025-01-01' } });
    expect(own.status).toBe(201);
    expect((await h.request('PATCH', `${base()}/attendance-rule-sets/${own.body.data.id}`, { token: scopedAdmin, body: { graceInMinutes: 12 } })).status).toBe(200);
    expect((await h.request('DELETE', `${base()}/attendance-rule-sets/${own.body.data.id}`, { token: scopedAdmin })).status).toBe(200);
  });

  it('holidays: branch-scoped users cannot declare, widen or remove organisation-wide holidays', async () => {
    const cal = await h.request('POST', `${base()}/holiday-calendars`, { token: f.owner, body: { name: 'Security' } });
    expect(cal.status).toBe(201);
    const calendarId = cal.body.data.id as string;
    expect((await h.request('POST', `${base()}/holidays`, { token: scopedAdmin, body: { calendarId, name: 'Org day', date: '2030-01-01' } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/holidays`, { token: scopedAdmin, body: { calendarId, name: 'Other branch', date: '2030-01-02', branchIds: [f.branchA] } })).status).toBe(403);
    const own = await h.request('POST', `${base()}/holidays`, { token: scopedAdmin, body: { calendarId, name: 'Branch B day', date: '2030-01-03', branchIds: [f.branchB] } });
    expect(own.status).toBe(201);
    expect((await h.request('PATCH', `${base()}/holidays/${own.body.data.id}`, { token: scopedAdmin, body: { branchIds: null } })).status).toBe(403);
    expect((await h.request('PATCH', `${base()}/holidays/${own.body.data.id}`, { token: scopedAdmin, body: { branchIds: [f.branchA, f.branchB] } })).status).toBe(403);
    expect((await h.request('PATCH', `${base()}/holidays/${own.body.data.id}`, { token: scopedAdmin, body: { name: 'Branch B holiday' } })).status).toBe(200);
    const org = await h.request('POST', `${base()}/holidays`, { token: f.owner, body: { calendarId, name: 'National day', date: '2030-11-18' } });
    expect(org.status).toBe(201);
    expect((await h.request('PATCH', `${base()}/holidays/${org.body.data.id}`, { token: scopedAdmin, body: { name: 'renamed' } })).status).toBe(403);
    expect((await h.request('DELETE', `${base()}/holidays/${org.body.data.id}`, { token: scopedAdmin })).status).toBe(403);
    expect((await h.admin.selectFrom('holidays').select('name').where('id', '=', org.body.data.id).executeTakeFirstOrThrow()).name).toBe('National day');
    expect((await h.request('DELETE', `${base()}/holidays/${org.body.data.id}`, { token: f.owner })).status).toBe(204);
  });

  it('reports: a branch-scoped report.manage holder cannot read or download organisation-wide reports of others', async () => {
    const org = await h.request('POST', `${base()}/reports`, { token: f.owner, body: { reportType: 'daily_attendance', format: 'csv', parameters: { from: '2026-08-01' } } });
    expect(org.status).toBe(202);
    const id = org.body.data.id as string;
    await h.admin.updateTable('reportRequests').set({ status: 'COMPLETED', filePath: `${f.orgId}/reports/${id}.csv`, rowCount: 3, completedAt: new Date() }).where('id', '=', id).execute();
    expect((await h.request('GET', `${base()}/reports/${id}`, { token: f.hrAdmin })).status).toBe(200); // unrestricted manager
    expect((await h.request('GET', `${base()}/reports/${id}`, { token: scopedAdmin })).status).toBe(404);
    expect((await h.request('GET', `${base()}/reports/${id}/download`, { token: scopedAdmin })).status).toBe(404);
    expect((await auditRows(h.admin, 'report.exported')).filter((a) => a.entityId === id)).toHaveLength(0);
    const list = await h.request('GET', `${base()}/reports`, { token: scopedAdmin });
    expect(list.body.data.some((r: { id: string }) => r.id === id)).toBe(false);
    const own = await h.request('POST', `${base()}/reports`, { token: scopedAdmin, body: { reportType: 'daily_attendance', format: 'csv', parameters: { from: '2026-08-01' } } });
    expect(own.status).toBe(202);
    expect(own.body.data.branchId).toBe(f.branchB); // scope injected server-side
    expect((await h.request('GET', `${base()}/reports/${own.body.data.id}`, { token: scopedAdmin })).status).toBe(200);
  });
});

describe('sync fan-out through the shared createSyncJob', () => {
  it('device action sync-employees fans out PUSH_EMPLOYEE items and every device action is audited', async () => {
    const dev = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'ACT-A' });
    const r = await h.request('POST', `${base()}/devices/${dev}/actions/sync-employees`, { token: f.owner });
    expect(r.status).toBe(202);
    expect(r.body.data).toMatchObject({ status: 'QUEUED', itemsTotal: 2, itemsQueued: 2, itemsSkipped: 0 }); // e1 + e3 in branch A
    const items = await h.admin.selectFrom('syncJobItems').select(['operation', 'employeeId', 'status']).where('syncJobId', '=', r.body.data.jobId).execute();
    expect(items.every((i) => i.operation === 'PUSH_EMPLOYEE' && i.employeeId && i.status === 'QUEUED')).toBe(true);
    const queued = (await queueJobs(h.admin, 'PUSH_EMPLOYEE')).filter((j) => j.payload.syncJobId === r.body.data.jobId);
    expect(queued).toHaveLength(2);
    expect(queued.every((j) => j.dedupeKey?.startsWith(`push:${dev}:`))).toBe(true);
    expect((await auditRows(h.admin, 'device.action_sync_employees')).filter((a) => a.entityId === dev)).toHaveLength(1);
    const hc = await h.request('POST', `${base()}/devices/${dev}/actions/health-check`, { token: f.owner });
    expect(hc.status).toBe(202);
    expect((await auditRows(h.admin, 'device.action_health_check')).filter((a) => a.entityId === dev)).toHaveLength(1);
  });

  it('work already in flight is SKIPPED (one queue job per dedupe key) and reported honestly; health checks are audited', async () => {
    const dev = await seedDevice(h.admin, f.orgId, f.branchB, { code: 'DUP-B' });
    const first = await h.request('POST', `${base()}/sync/attendance`, { token: f.owner, body: { deviceIds: [dev] } });
    expect(first.status).toBe(202);
    expect(first.body.data).toMatchObject({ status: 'QUEUED', itemsTotal: 1, itemsQueued: 1, itemsSkipped: 0 });
    const second = await h.request('POST', `${base()}/sync/attendance`, { token: f.owner, body: { deviceIds: [dev] } });
    expect(second.status).toBe(202);
    expect(second.body.data).toMatchObject({ status: 'SUCCESS', itemsTotal: 1, itemsQueued: 0, itemsSkipped: 1 });
    expect((await queueJobs(h.admin, 'PULL_ATTENDANCE')).filter((j) => j.dedupeKey === `pull:${dev}`)).toHaveLength(1);
    const job = await h.admin.selectFrom('syncJobs').select(['status', 'itemsTotal', 'itemsPending']).where('id', '=', second.body.data.jobId).executeTakeFirstOrThrow();
    expect(job).toEqual({ status: 'SUCCESS', itemsTotal: 1, itemsPending: 0 });
    const item = await h.admin.selectFrom('syncJobItems').select(['status', 'result']).where('syncJobId', '=', second.body.data.jobId).executeTakeFirstOrThrow();
    expect(item.status).toBe('SKIPPED');
    expect((item.result as { skipped: string }).skipped).toBe('duplicate_in_flight');
    const hc = await h.request('POST', `${base()}/sync/health-check`, { token: f.owner, body: { deviceIds: [dev] } });
    expect(hc.status).toBe(202);
    expect((await auditRows(h.admin, 'sync.health_check_requested')).filter((a) => a.entityId === hc.body.data.jobId)).toHaveLength(1);
  });
});
