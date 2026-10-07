import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultRegistry } from '@flowza/device-providers';
import { BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE, createSyncJob, withContext } from '@flowza/database';
import { addDays } from '@flowza/shared';
import { createHarness, type TestHarness } from '../../test/harness.js';
import { DEPLOYMENT_CLEANUP_LOCAL_HOUR, runBranchDeploymentCleanup, scheduleDeploymentCleanup } from './index.js';

/*
 * The daily access-removal sweep of temporary branch deployments (Enterprise, docs/enterprise/plan.md §4.7): an employee whose
 * deployment ended (or was cancelled after enrolling) is taken off the HOST branch's terminals — only there, not where they
 * still belong (their own branch, another deployment that has not ended) — in ONE DELETE_EMPLOYEE sync job; the enrolment
 * that has not run yet is stopped. Runs whatever the module state (the organisation below has no Enterprise module at all).
 */
const ORG = '0d000000-0000-4000-a000-000000000001';
const HOME = '0d000000-0000-4000-a000-0000000000b1';
const HOST = '0d000000-0000-4000-a000-0000000000b2';
const OTHER = '0d000000-0000-4000-a000-0000000000b3';
const E1 = '0d000000-0000-4000-a000-0000000000e1';
const E2 = '0d000000-0000-4000-a000-0000000000e2';
const E3 = '0d000000-0000-4000-a000-0000000000e3';
const HOST_DEV = '0d000000-0000-4000-a000-0000000000d1';
const HOST_NODEL = '0d000000-0000-4000-a000-0000000000d2';
const HOST_OFF = '0d000000-0000-4000-a000-0000000000d3';
const HOME_DEV = '0d000000-0000-4000-a000-0000000000d4';
const OTHER_DEV = '0d000000-0000-4000-a000-0000000000d5';
const D_ENDED = '0d000000-0000-4000-a000-0000000000f1';
const D_KEPT_OLD = '0d000000-0000-4000-a000-0000000000f2';
const D_KEPT_NOW = '0d000000-0000-4000-a000-0000000000f3';
const D_TRANSFERRED = '0d000000-0000-4000-a000-0000000000f4';
const D_ENDS_TODAY = '0d000000-0000-4000-a000-0000000000f5';
const D_CANCELLED = '0d000000-0000-4000-a000-0000000000f6';
const MUSCAT = 'Asia/Muscat';
// 00:30 in Muscat on 2026-10-08 — the clean-up hour
let now = new Date('2026-10-07T20:30:00Z');
const TODAY = '2026-10-08';

let h: TestHarness;
const CAPS = { attendancePull: true, employeePush: true, employeeDelete: true, deviceStatus: true };

beforeAll(async () => {
  h = await createHarness(`flowza_worker_deploy_${process.pid}`, defaultRegistry(), () => now);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'DEP', legalName: 'Dep', displayName: 'Dep', timezone: MUSCAT, status: 'active' }).execute();
  await a.insertInto('branches').values([
    { id: HOME, organizationId: ORG, code: 'HOME', name: 'Home', timezone: MUSCAT },
    { id: HOST, organizationId: ORG, code: 'HOST', name: 'Host', timezone: MUSCAT },
    { id: OTHER, organizationId: ORG, code: 'OTH', name: 'Other', timezone: MUSCAT },
  ]).execute();
  const emp = (id: string, n: string, branchId: string) => ({ id, organizationId: ORG, employeeNumber: n, firstName: 'F', lastName: n, displayName: `F ${n}`, joiningDate: '2025-01-01', branchId, deviceUserId: n, customFields: JSON.stringify({}) });
  // E3 was deployed to HOST and has since been transferred there
  await a.insertInto('employees').values([emp(E1, '1', HOME), emp(E2, '2', HOME), emp(E3, '3', HOST)]).execute();
  const dev = (id: string, branchId: string, caps: Record<string, boolean>, status: 'active' | 'disabled' = 'active') => ({
    id, organizationId: ORG, branchId, code: id.slice(-4), name: `Device ${id.slice(-2)}`, providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL' as const,
    capabilities: JSON.stringify(caps), config: JSON.stringify({ scenario: 'healthy' }), timezone: MUSCAT, status,
  });
  await a.insertInto('devices').values([dev(HOST_DEV, HOST, CAPS), dev(HOST_NODEL, HOST, { ...CAPS, employeeDelete: false }), dev(HOST_OFF, HOST, CAPS, 'disabled'), dev(HOME_DEV, HOME, CAPS), dev(OTHER_DEV, OTHER, CAPS)]).execute();
  const state = (deviceId: string, employeeId: string, deviceUserId: string) => ({ organizationId: ORG, deviceId, employeeId, deviceUserId, syncStatus: 'IN_SYNC' as const, desired: true });
  await a.insertInto('deviceEmployeeStates').values([
    state(HOST_DEV, E1, '1'), state(HOST_NODEL, E1, '1'), state(HOST_OFF, E1, '1'), state(HOME_DEV, E1, '1'),
    state(HOST_DEV, E2, '2'), state(HOST_DEV, E3, '3'),
  ]).execute();
  const dep = (id: string, employeeId: string, branchId: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ id, organizationId: ORG, employeeId, homeBranchId: HOME, branchId, fromDate: from, toDate: to, reason: 'Cover at the host branch', ...extra });
  await a.insertInto('employeeBranchDeployments').values([
    dep(D_ENDED, E1, HOST, addDays(TODAY, -5), addDays(TODAY, -1)),
    dep(D_KEPT_OLD, E2, HOST, addDays(TODAY, -5), addDays(TODAY, -1)),
    dep(D_KEPT_NOW, E2, HOST, TODAY, addDays(TODAY, 3)),
    dep(D_TRANSFERRED, E3, HOST, addDays(TODAY, -9), addDays(TODAY, -2)),
    dep(D_ENDS_TODAY, E1, OTHER, TODAY, TODAY),
  ]).execute();
  // a deployment cancelled while its enrolment was still queued
  const enrol = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => createSyncJob(trx, h.deps.queue, {
    organizationId: ORG, jobType: 'PUSH_EMPLOYEES', trigger: 'MANUAL', branchId: OTHER, correlationId: 'test-enrol', items: [{ deviceId: OTHER_DEV, employeeId: E2, operation: 'PUSH_EMPLOYEE', branchId: OTHER }],
  }));
  await a.insertInto('employeeBranchDeployments').values(dep(D_CANCELLED, E2, OTHER, addDays(TODAY, 5), addDays(TODAY, 7), { enrolJobId: enrol.syncJobId, cancelledAt: new Date(), cancelReason: 'Plans changed' })).execute();
}, 240_000);
afterAll(async () => { await h?.close(); });

describe('branch deployment clean-up', () => {
  it('enqueues one sweep per organisation in its local clean-up hour, deduplicated per local date', async () => {
    expect(DEPLOYMENT_CLEANUP_LOCAL_HOUR).toBe(0);
    now = new Date('2026-10-07T12:00:00Z'); // 16:00 in Muscat
    expect((await scheduleDeploymentCleanup(h.deps)).enqueued).toBe(0);
    now = new Date('2026-10-07T20:30:00Z');
    const first = await scheduleDeploymentCleanup(h.deps);
    expect(first.enqueued).toBe(1);
    await scheduleDeploymentCleanup(h.deps);
    const jobs = await h.tdb.adminDb.selectFrom('jobs.queue').select(['jobType', 'organizationId', 'payload', 'dedupeKey', 'queueName']).where('jobType', '=', BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE).execute();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ organizationId: ORG, queueName: 'processing', dedupeKey: `branch-deployment-cleanup:${ORG}:${TODAY}`, payload: { organizationId: ORG, asOf: TODAY } });
  });

  it('takes the employee off the host branch\'s terminals only, in one DELETE_EMPLOYEE job, and stops a queued enrolment', async () => {
    const summary = await runBranchDeploymentCleanup(h.deps, ORG, null);
    expect(summary).toMatchObject({ organizationId: ORG, today: TODAY, due: 4, cleanedUp: 4, pending: 0, removals: 1, failed: 0 });
    expect(summary.syncJobIds).toHaveLength(1);
    const a = h.tdb.adminDb;

    // the ended deployment: one item for the host terminal that can delete; the switched-off and the delete-less ones skipped
    const job = await a.selectFrom('syncJobs').selectAll().where('id', '=', summary.syncJobIds[0]!).executeTakeFirstOrThrow();
    expect(job).toMatchObject({ jobType: 'DELETE_EMPLOYEE', trigger: 'SCHEDULED', branchId: HOST, itemsTotal: 1 });
    const items = await a.selectFrom('syncJobItems').select(['deviceId', 'employeeId', 'operation', 'status']).where('syncJobId', '=', job.id).execute();
    expect(items).toEqual([{ deviceId: HOST_DEV, employeeId: E1, operation: 'DELETE_EMPLOYEE', status: 'QUEUED' }]);
    const queued = await a.selectFrom('jobs.queue').select(['jobType', 'payload']).where('jobType', '=', 'DELETE_EMPLOYEE').execute();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ deviceId: HOST_DEV, employeeId: E1, options: { deviceUserId: '1' } });
    const ended = await a.selectFrom('employeeBranchDeployments').selectAll().where('id', '=', D_ENDED).executeTakeFirstOrThrow();
    expect(ended.cleanupJobId).toBe(job.id);
    expect(ended.cleanedUpAt).not.toBeNull();

    // nobody wants E1 on the host terminals any more (no reconciliation puts them back); their own branch's terminal is untouched
    const states = await a.selectFrom('deviceEmployeeStates').select(['deviceId', 'employeeId', 'desired']).where('organizationId', '=', ORG).execute();
    const desired = (deviceId: string, employeeId: string) => states.find((s) => s.deviceId === deviceId && s.employeeId === employeeId)?.desired;
    expect([desired(HOST_DEV, E1), desired(HOST_NODEL, E1), desired(HOST_OFF, E1)]).toEqual([false, false, false]);
    expect(desired(HOME_DEV, E1)).toBe(true);
    // E2 is deployed to the same branch again from today; E3 now belongs to it: both keep the terminal
    expect(desired(HOST_DEV, E2)).toBe(true);
    expect(desired(HOST_DEV, E3)).toBe(true);
    for (const id of [D_KEPT_OLD, D_TRANSFERRED]) {
      const row = await a.selectFrom('employeeBranchDeployments').select(['cleanedUpAt', 'cleanupJobId']).where('id', '=', id).executeTakeFirstOrThrow();
      expect(row.cleanedUpAt).not.toBeNull();
      expect(row.cleanupJobId).toBeNull();
    }
    // a deployment that ends today, or is running, is not touched
    for (const id of [D_ENDS_TODAY, D_KEPT_NOW]) expect((await a.selectFrom('employeeBranchDeployments').select('cleanedUpAt').where('id', '=', id).executeTakeFirstOrThrow()).cleanedUpAt).toBeNull();

    // the cancelled deployment's enrolment never runs
    const cancelled = await a.selectFrom('employeeBranchDeployments').select(['enrolJobId', 'cleanedUpAt']).where('id', '=', D_CANCELLED).executeTakeFirstOrThrow();
    expect(cancelled.cleanedUpAt).not.toBeNull();
    const enrolItems = await a.selectFrom('syncJobItems').select(['status']).where('syncJobId', '=', cancelled.enrolJobId!).execute();
    expect(enrolItems.map((i) => i.status)).toEqual(['CANCELLED']);
    expect((await a.selectFrom('syncJobs').select('status').where('id', '=', cancelled.enrolJobId!).executeTakeFirstOrThrow()).status).toBe('CANCELLED');
    expect(await a.selectFrom('jobs.queue').select('id').where('jobType', '=', 'PUSH_EMPLOYEE').execute()).toHaveLength(0);

    const audits = await a.selectFrom('audit.logs').select(['action', 'actorType', 'entityId', 'newValue']).where('action', '=', 'employee.deployment_cleaned_up').execute();
    expect(audits).toHaveLength(4);
    expect(audits.every((r) => r.actorType === 'SYSTEM')).toBe(true);
    const e1Audit = audits.find((r) => (r.newValue as Record<string, unknown>)['deploymentId'] === D_ENDED)!;
    expect(e1Audit.newValue).toMatchObject({ removals: [{ deviceId: HOST_DEV, deviceUserId: '1' }], skipped: expect.arrayContaining([{ deviceId: HOST_NODEL, deviceUserId: '1', reason: 'delete_unsupported' }, { deviceId: HOST_OFF, deviceUserId: '1', reason: 'device_inactive' }]) });
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const again = await runBranchDeploymentCleanup(h.deps, ORG, null);
    expect(again).toMatchObject({ due: 0, cleanedUp: 0, removals: 0, syncJobIds: [] });
  });

  it('the next day picks up the deployment that ended today', async () => {
    now = new Date('2026-10-08T20:30:00Z');
    const next = await runBranchDeploymentCleanup(h.deps, ORG, null);
    // E1 → OTHER ended on the 8th; E1 has no device row on OTHER: nothing to remove, the deployment is stamped
    expect(next).toMatchObject({ today: addDays(TODAY, 1), due: 1, cleanedUp: 1, removals: 0 });
  });
});
