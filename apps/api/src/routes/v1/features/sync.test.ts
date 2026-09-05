import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createApiHarness, queueJobs, seedDevice, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture; let devA1: string; let devA2: string; let devB: string;
beforeAll(async () => {
  h = await createApiHarness(`flowza_api_sync_${process.pid}`); f = await seedOrg(h.admin, 'sync');
  devA1 = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'A1' });
  devA2 = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'A2', capabilities: { attendancePull: false, employeePush: true } });
  devB = await seedDevice(h.admin, f.orgId, f.branchB, { code: 'B1' });
});
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}/sync`;

describe('sync jobs', () => {
  it('queues PULL_ATTENDANCE for all pull-capable devices with the worker payload contract', async () => {
    const r = await h.request('POST', `${base()}/attendance`, { token: f.owner, body: { all: true } });
    expect(r.status).toBe(202);
    expect(r.body.data).toMatchObject({ status: 'QUEUED', itemsTotal: 2, deviceCount: 2 });
    const jobs = await queueJobs(h.admin, 'PULL_ATTENDANCE');
    expect(jobs).toHaveLength(2);
    for (const j of jobs) {
      expect(j.queueName).toBe('sync');
      expect(j.organizationId).toBe(f.orgId);
      expect(Object.keys(j.payload).sort()).toEqual(['deviceId', 'employeeId', 'operation', 'options', 'organizationId', 'syncJobId', 'syncJobItemId']); // worker SyncItemPayload contract
      expect(j.payload.syncJobId).toBe(r.body.data.jobId);
    }
    const items = await h.admin.selectFrom('syncJobItems').select(['deviceId', 'queueJobId', 'status']).where('syncJobId', '=', r.body.data.jobId).execute();
    expect(items.map((i) => i.deviceId).sort()).toEqual([devA1, devB].sort());
    expect(items.every((i) => i.queueJobId !== null && i.status === 'QUEUED')).toBe(true);
  });

  it('scopes manual syncs to the caller branches and rejects foreign devices', async () => {
    const r = await h.request('POST', `${base()}/attendance`, { token: f.branchManagerB, body: { all: true } });
    expect(r.status).toBe(202);
    expect(r.body.data.deviceCount).toBe(1);
    // devB's pull from the previous test is still pending: the shared fan-out marks the item SKIPPED instead of polling twice
    expect(r.body.data).toMatchObject({ itemsTotal: 1, itemsQueued: 0, itemsSkipped: 1, status: 'SUCCESS' });
    expect((await queueJobs(h.admin, 'PULL_ATTENDANCE')).filter((j) => j.dedupeKey === `pull:${devB}`)).toHaveLength(1);
    const foreign = await h.request('POST', `${base()}/attendance`, { token: f.branchManagerB, body: { deviceIds: [devA1] } });
    expect(foreign.status).toBe(400);
    const noPerm = await h.request('POST', `${base()}/attendance`, { token: f.payrollUser, body: { all: true } });
    expect(noPerm.status).toBe(403);
  });

  it('fans PUSH_EMPLOYEES out per (device, employee) and honours the branch of each employee', async () => {
    const r = await h.request('POST', `${base()}/employees`, { token: f.owner, body: { branchId: f.branchA } });
    expect(r.status).toBe(202);
    expect(r.body.data.itemsTotal).toBe(4); // 2 employees × 2 employee-push devices in branch A
    const items = await h.admin.selectFrom('syncJobItems').select(['deviceId', 'employeeId', 'operation']).where('syncJobId', '=', r.body.data.jobId).execute();
    expect(new Set(items.map((i) => i.deviceId))).toEqual(new Set([devA1, devA2]));
    expect(items.every((i) => i.operation === 'PUSH_EMPLOYEE' && i.employeeId)).toBe(true);
    const payload = (await queueJobs(h.admin, 'PUSH_EMPLOYEE'))[0]!.payload;
    expect(payload.employeeId).toBeTypeOf('string');
    const explicit = await h.request('POST', `${base()}/employees`, { token: f.owner, body: { employeeIds: [f.e2], deviceIds: [devA1] } });
    expect(explicit.body.data.itemsTotal).toBe(1);
    const empty = await h.request('POST', `${base()}/employees`, { token: f.owner, body: { employeeIds: [f.e2], branchId: f.branchA } });
    expect(empty.status).toBe(400);
  });

  it('replays identical requests under an Idempotency-Key and rejects a different body', async () => {
    const headers = { 'idempotency-key': 'sync-key-1' };
    const a = await h.request('POST', `${base()}/health-check`, { token: f.owner, headers, body: { all: true } });
    const b = await h.request('POST', `${base()}/health-check`, { token: f.owner, headers, body: { all: true } });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.body.data.jobId).toBe(a.body.data.jobId);
    expect(b.headers.get('idempotency-replayed')).toBe('true');
    expect((await queueJobs(h.admin, 'DEVICE_HEALTH_CHECK')).length).toBe(3);
    const c = await h.request('POST', `${base()}/health-check`, { token: f.owner, headers, body: { deviceIds: [devB] } });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('lists jobs with items, cancels queued items and retries failed ones', async () => {
    const list = await h.request('GET', `${base()}/jobs?jobType=PULL_ATTENDANCE`, { token: f.owner });
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBeGreaterThanOrEqual(2);
    // the newest job may be one whose items were all SKIPPED (work already in flight); cancel needs a job with queued items
    const jobId = (list.body.data.find((j: { status: string }) => j.status === 'QUEUED') as { id: string }).id;
    const detail = await h.request('GET', `${base()}/jobs/${jobId}?pageSize=1`, { token: f.owner });
    expect(detail.body.data.items).toHaveLength(1);
    expect(detail.body.meta.items.total).toBeGreaterThanOrEqual(1);
    const bmList = await h.request('GET', `${base()}/jobs`, { token: f.branchManagerB });
    expect(bmList.body.data.every((j: { branchId: string | null }) => j.branchId === f.branchB || j.branchId === null)).toBe(true);

    const cancel = await h.request('POST', `${base()}/jobs/${jobId}/cancel`, { token: f.owner });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');
    expect(cancel.body.data.cancelledItems).toBeGreaterThanOrEqual(1);
    const items = await h.admin.selectFrom('syncJobItems').select(['status', 'queueJobId']).where('syncJobId', '=', jobId).execute();
    expect(items.every((i) => i.status === 'CANCELLED')).toBe(true);
    const archived = await h.admin.selectFrom('jobs.queueArchive').select('status').where('id', 'in', items.map((i) => i.queueJobId!)).execute();
    expect(archived.every((a) => a.status === 'cancelled')).toBe(true);
    const again = await h.request('POST', `${base()}/jobs/${jobId}/cancel`, { token: f.owner });
    expect(again.status).toBe(409);

    // simulate the worker failing one item of another job, then retry
    const r = await h.request('POST', `${base()}/attendance`, { token: f.owner, body: { deviceIds: [devA1, devB] } });
    const failedJob = r.body.data.jobId as string;
    const first = await h.admin.selectFrom('syncJobItems').select(['id', 'queueJobId']).where('syncJobId', '=', failedJob).where('deviceId', '=', devA1).executeTakeFirstOrThrow();
    await h.admin.updateTable('syncJobItems').set({ status: 'FAILED', lastErrorCode: 'TIMEOUT' }).where('id', '=', first.id).execute();
    await sql`select jobs.cancel(${String(first.queueJobId)}::bigint)`.execute(h.admin); // a failed item's queue job is no longer pending
    await h.admin.updateTable('syncJobItems').set({ status: 'SUCCESS' }).where('syncJobId', '=', failedJob).where('deviceId', '=', devB).execute();
    await h.admin.updateTable('syncJobs').set({ status: 'PARTIAL_SUCCESS', itemsFailed: 1, itemsSuccess: 1, itemsPending: 0 }).where('id', '=', failedJob).execute();
    const retry = await h.request('POST', `${base()}/jobs/${failedJob}/retry-failed`, { token: f.owner });
    expect(retry.status).toBe(202);
    expect(retry.body.data).toMatchObject({ itemsTotal: 1, itemsQueued: 1, itemsSkipped: 0, status: 'QUEUED', parentJobId: failedJob });
    const child = await h.admin.selectFrom('syncJobs').select(['parentJobId', 'jobType']).where('id', '=', retry.body.data.jobId).executeTakeFirstOrThrow();
    expect(child).toEqual({ parentJobId: failedJob, jobType: 'PULL_ATTENDANCE' });
    const nothing = await h.request('POST', `${base()}/jobs/${retry.body.data.jobId}/retry-failed`, { token: f.owner });
    expect(nothing.status).toBe(409);
  });

  it('exposes the latest reconciliation summary per device', async () => {
    const r = await h.request('POST', `${base()}/reconcile`, { token: f.owner, body: { deviceIds: [devB], repair: true } });
    expect(r.status).toBe(202);
    const item = await h.admin.selectFrom('syncJobItems').select('id').where('syncJobId', '=', r.body.data.jobId).executeTakeFirstOrThrow();
    await h.admin.updateTable('syncJobItems').set({ status: 'SUCCESS', result: JSON.stringify({ cloudOnly: 2, deviceOnly: 1, differing: 0 }), finishedAt: new Date() }).where('id', '=', item.id).execute();
    const summary = await h.request('GET', `${base()}/reconciliation`, { token: f.owner });
    expect(summary.status).toBe(200);
    const b = summary.body.data.find((d: { deviceId: string }) => d.deviceId === devB);
    expect(b.summary).toEqual({ cloudOnly: 2, deviceOnly: 1, differing: 0 });
    expect(summary.body.data.find((d: { deviceId: string }) => d.deviceId === devA2).summary).toBeNull();
    expect((await queueJobs(h.admin, 'RECONCILIATION'))[0]!.payload.options).toEqual({ repair: true });
  });
});
