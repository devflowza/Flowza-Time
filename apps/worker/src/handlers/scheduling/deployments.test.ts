import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultRegistry } from '@flowza/device-providers';
import { BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE, createSyncJob, withContext } from '@flowza/database';
import { addDays } from '@flowza/shared';
import { createHarness, type TestHarness } from '../../test/harness.js';
import { DEPLOYMENT_CLEANUP_LOCAL_HOUR, runBranchDeploymentSweep, scheduleDeploymentCleanup } from './index.js';

/*
 * The daily terminal sweep of temporary branch deployments (Enterprise, docs/enterprise/plan.md §4.7), every date the HOST
 * branch's:
 *   - access removal once the host date is toDate + 2 (the morning after the last day still belongs to the deployment) or at
 *     a cancellation (whatever it enrolled), from the terminals the deployment ENROLLED only (`enrolled_device_ids`) — never
 *     an enrolment by another path, nothing for a deployment that enrolled nothing — kept when the host is now the employee's
 *     branch, handed over to another deployment to the same host that covers today (and removed when THAT one is cancelled);
 *   - enrolment on the first day (not at creation), skipping (and not recording) the terminals the employee is already on;
 *   - removal runs whatever the module state; enrolment follows advanced_scheduling.
 */
const ORG = '0d000000-0000-4000-a000-000000000001';
const HOME = '0d000000-0000-4000-a000-0000000000b1';
const HOST = '0d000000-0000-4000-a000-0000000000b2';
const OTHER = '0d000000-0000-4000-a000-0000000000b3';
const RIYADH = '0d000000-0000-4000-a000-0000000000b4';
const E1 = '0d000000-0000-4000-a000-0000000000e1';
const E2 = '0d000000-0000-4000-a000-0000000000e2';
const E3 = '0d000000-0000-4000-a000-0000000000e3';
const E4 = '0d000000-0000-4000-a000-0000000000e4';
const E5 = '0d000000-0000-4000-a000-0000000000e5';
const E6 = '0d000000-0000-4000-a000-0000000000e6';
const E7 = '0d000000-0000-4000-a000-0000000000e7';
const E8 = '0d000000-0000-4000-a000-0000000000e8';
const HOST_DEV = '0d000000-0000-4000-a000-0000000000d1';
const HOST_NODEL = '0d000000-0000-4000-a000-0000000000d2';
const HOST_OFF = '0d000000-0000-4000-a000-0000000000d3';
const HOME_DEV = '0d000000-0000-4000-a000-0000000000d4';
const OTHER_DEV = '0d000000-0000-4000-a000-0000000000d5';
const HOST_DEV2 = '0d000000-0000-4000-a000-0000000000d6';
const D_ENDED = '0d000000-0000-4000-a000-0000000000f1';
const D_KEPT_OLD = '0d000000-0000-4000-a000-0000000000f2';
const D_KEPT_NOW = '0d000000-0000-4000-a000-0000000000f3';
const D_TRANSFERRED = '0d000000-0000-4000-a000-0000000000f4';
const D_GRACE = '0d000000-0000-4000-a000-0000000000f5';
const D_CANCELLED = '0d000000-0000-4000-a000-0000000000f6';
const D_ENROL_OFF = '0d000000-0000-4000-a000-0000000000f7';
const D_STARTS_TODAY = '0d000000-0000-4000-a000-0000000000f8';
const D_STARTS_TOMORROW = '0d000000-0000-4000-a000-0000000000f9';
const D_MODULE_OFF = '0d000000-0000-4000-a000-0000000000fa';
const D_LEAVER = '0d000000-0000-4000-a000-0000000000fb';
const D_ENROL_OFF_LATER = '0d000000-0000-4000-a000-0000000000fc';
const D_OLD8 = '0d000000-0000-4000-a000-0000000000fd';
const D_NOW8 = '0d000000-0000-4000-a000-0000000000fe';
const D_LEGACY = '0d000000-0000-4000-a000-0000000000ff';
const MUSCAT = 'Asia/Muscat';
// 00:30 in Muscat on 2026-10-08 — the clean-up hour of every Muscat branch
let now = new Date('2026-10-07T20:30:00Z');
const TODAY = '2026-10-08';

let h: TestHarness;
const CAPS = { attendancePull: true, employeePush: true, employeeDelete: true, deviceStatus: true };
const desiredOf = async (deviceId: string, employeeId: string) => (await h.tdb.adminDb.selectFrom('deviceEmployeeStates').select('desired').where('deviceId', '=', deviceId).where('employeeId', '=', employeeId).executeTakeFirst())?.desired;
const depRow = (id: string) => h.tdb.adminDb.selectFrom('employeeBranchDeployments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const itemsOf = (syncJobId: string) => h.tdb.adminDb.selectFrom('syncJobItems').select(['deviceId', 'employeeId', 'operation', 'status']).where('syncJobId', '=', syncJobId).orderBy('deviceId').execute();
const state = (deviceId: string, employeeId: string, deviceUserId: string) => ({ organizationId: ORG, deviceId, employeeId, deviceUserId, syncStatus: 'IN_SYNC' as const, desired: true });

beforeAll(async () => {
  h = await createHarness(`flowza_worker_deploy_${process.pid}`, defaultRegistry(), () => now);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'DEP', legalName: 'Dep', displayName: 'Dep', timezone: MUSCAT, status: 'active' }).execute();
  await a.insertInto('branches').values([
    { id: HOME, organizationId: ORG, code: 'HOME', name: 'Home', timezone: MUSCAT },
    { id: HOST, organizationId: ORG, code: 'HOST', name: 'Host', timezone: MUSCAT },
    { id: OTHER, organizationId: ORG, code: 'OTH', name: 'Other', timezone: MUSCAT },
    { id: RIYADH, organizationId: ORG, code: 'RUH', name: 'Riyadh', timezone: 'Asia/Riyadh' },
  ]).execute();
  const emp = (id: string, n: string, branchId: string) => ({ id, organizationId: ORG, employeeNumber: n, firstName: 'F', lastName: n, displayName: `F ${n}`, joiningDate: '2025-01-01', branchId, deviceUserId: n, customFields: JSON.stringify({}) });
  // E4 was deployed to HOST and has since been transferred there
  await a.insertInto('employees').values([emp(E1, '1', HOME), emp(E2, '2', HOME), emp(E3, '3', HOME), emp(E4, '4', HOST), emp(E5, '5', HOME), emp(E6, '6', HOME), emp(E7, '7', HOME), emp(E8, '8', HOME)]).execute();
  const dev = (id: string, branchId: string, name: string, caps: Record<string, boolean>, status: 'active' | 'disabled' = 'active') => ({
    id, organizationId: ORG, branchId, code: id.slice(-4), name, providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL' as const,
    capabilities: JSON.stringify(caps), config: JSON.stringify({ scenario: 'healthy' }), timezone: MUSCAT, status,
  });
  await a.insertInto('devices').values([
    dev(HOST_DEV, HOST, 'Host A', CAPS), dev(HOST_NODEL, HOST, 'Host B (no delete)', { ...CAPS, employeeDelete: false }), dev(HOST_OFF, HOST, 'Host C (off)', CAPS, 'disabled'), dev(HOST_DEV2, HOST, 'Host D', CAPS),
    dev(HOME_DEV, HOME, 'Home A', CAPS), dev(OTHER_DEV, OTHER, 'Other A', CAPS),
  ]).execute();
  await a.insertInto('deviceEmployeeStates').values([
    // E1: the ended deployment enrolled them on three host terminals; HOST_DEV2 they are on by another path
    state(HOST_DEV, E1, '1'), state(HOST_NODEL, E1, '1'), state(HOST_OFF, E1, '1'), state(HOST_DEV2, E1, '1'), state(HOME_DEV, E1, '1'),
    state(HOST_DEV, E2, '2'), state(HOST_DEV, E4, '4'), state(HOST_DEV, E8, '8'),
    // E3: their old deployment enrolled them on every host terminal that takes employees
    state(HOST_DEV, E3, '3'), state(HOST_NODEL, E3, '3'), state(HOST_DEV2, E3, '3'),
    // E5 and E6 are on HOST_DEV by another path (an explicit device sync)
    state(HOST_DEV, E5, '5'), state(HOST_DEV, E6, '6'),
  ]).execute();
  const dep = (id: string, employeeId: string, branchId: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ id, organizationId: ORG, employeeId, homeBranchId: HOME, branchId, fromDate: from, toDate: to, reason: 'Cover at the host branch', ...extra });
  await a.insertInto('employeeBranchDeployments').values([
    dep(D_ENDED, E1, HOST, addDays(TODAY, -6), addDays(TODAY, -2), { enrolledDeviceIds: [HOST_DEV, HOST_NODEL, HOST_OFF] }),
    // ended YESTERDAY: the morning after (a night shift's check-out) is over only today → its terminals go tomorrow
    dep(D_GRACE, E2, HOST, addDays(TODAY, -5), addDays(TODAY, -1), { enrolledDeviceIds: [HOST_DEV] }),
    // E3: an ended deployment to HOST, and another one to HOST from today that asks for the terminals — E3 is on all of them
    // already, so it gets no enrolment job of its own
    dep(D_KEPT_OLD, E3, HOST, addDays(TODAY, -6), addDays(TODAY, -2), { enrolledDeviceIds: [HOST_DEV, HOST_NODEL, HOST_DEV2] }),
    dep(D_KEPT_NOW, E3, HOST, TODAY, addDays(TODAY, 3)),
    // E8: the same, but the deployment from today does NOT ask for the terminals: it does not keep them
    dep(D_OLD8, E8, HOST, addDays(TODAY, -6), addDays(TODAY, -2), { enrolledDeviceIds: [HOST_DEV] }),
    dep(D_NOW8, E8, HOST, TODAY, addDays(TODAY, 3), { enrolOnDevices: false }),
    dep(D_TRANSFERRED, E4, HOST, addDays(TODAY, -9), addDays(TODAY, -3), { enrolledDeviceIds: [HOST_DEV] }),
    // terminals off: nothing was enrolled, nothing is removed (E5 is on HOST_DEV by another path)
    dep(D_ENROL_OFF, E5, HOST, addDays(TODAY, -6), addDays(TODAY, -2), { enrolOnDevices: false }),
    dep(D_STARTS_TOMORROW, E5, HOST, addDays(TODAY, 1), addDays(TODAY, 3)),
    dep(D_STARTS_TODAY, E6, HOST, TODAY, addDays(TODAY, 2)),
    dep(D_ENROL_OFF_LATER, E1, OTHER, addDays(TODAY, 20), addDays(TODAY, 21), { enrolOnDevices: false }),
  ]).execute();
  // a deployment cancelled while its enrolment was still queued
  const enrol = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => createSyncJob(trx, h.deps.queue, {
    organizationId: ORG, jobType: 'PUSH_EMPLOYEES', trigger: 'MANUAL', branchId: OTHER, correlationId: 'test-enrol', items: [{ deviceId: OTHER_DEV, employeeId: E2, operation: 'PUSH_EMPLOYEE', branchId: OTHER }],
  }));
  await a.insertInto('employeeBranchDeployments').values(dep(D_CANCELLED, E2, OTHER, addDays(TODAY, 5), addDays(TODAY, 7), { enrolJobId: enrol.syncJobId, enrolledDeviceIds: [OTHER_DEV], cancelledAt: new Date(), cancelReason: 'Plans changed' })).execute();
}, 240_000);
afterAll(async () => { await h?.close(); });

describe('branch deployment sweep', () => {
  it('enqueues one sweep per organisation when a local day begins in its timezone or a branch\'s, deduplicated per local date', async () => {
    expect(DEPLOYMENT_CLEANUP_LOCAL_HOUR).toBe(0);
    now = new Date('2026-10-07T12:00:00Z'); // 16:00 in Muscat, 15:00 in Riyadh
    expect((await scheduleDeploymentCleanup(h.deps)).enqueued).toBe(0);
    now = new Date('2026-10-07T20:30:00Z'); // 00:30 in Muscat
    expect((await scheduleDeploymentCleanup(h.deps)).enqueued).toBe(1);
    await scheduleDeploymentCleanup(h.deps);
    now = new Date('2026-10-07T21:30:00Z'); // 00:30 in Riyadh (a branch's zone): same local date → the pending job covers it
    expect((await scheduleDeploymentCleanup(h.deps)).enqueued).toBe(1);
    const jobs = await h.tdb.adminDb.selectFrom('jobs.queue').select(['jobType', 'organizationId', 'payload', 'dedupeKey', 'queueName']).where('jobType', '=', BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE).execute();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ organizationId: ORG, queueName: 'processing', dedupeKey: `branch-deployment-cleanup:${ORG}:${TODAY}`, payload: { organizationId: ORG, asOf: TODAY } });
    now = new Date('2026-10-07T20:30:00Z');
  });

  it('removes only what the deployment enrolled, from toDate + 2 at the host; keeps, hands over and enrols on the first day', async () => {
    const summary = await runBranchDeploymentSweep(h.deps, ORG, null);
    expect(summary).toMatchObject({ organizationId: ORG, today: TODAY, due: 6, cleanedUp: 6, pending: 0, removals: 2, enrolmentEnabled: true, enrolDue: 2, failed: 0 });
    expect(summary.syncJobIds).toHaveLength(2);
    expect(summary.enrolJobIds).toHaveLength(1);
    const a = h.tdb.adminDb;

    // the ended deployment: one item for the enrolled host terminal that can delete; the switched-off and the delete-less ones skipped
    const job = await a.selectFrom('syncJobs').selectAll().where('id', '=', (await depRow(D_ENDED)).cleanupJobId!).executeTakeFirstOrThrow();
    expect(summary.syncJobIds).toContain(job.id);
    expect(job).toMatchObject({ jobType: 'DELETE_EMPLOYEE', trigger: 'SCHEDULED', branchId: HOST, itemsTotal: 1 });
    expect(await itemsOf(job.id)).toEqual([{ deviceId: HOST_DEV, employeeId: E1, operation: 'DELETE_EMPLOYEE', status: 'QUEUED' }]);
    const queued = (await a.selectFrom('jobs.queue').select(['jobType', 'payload']).where('jobType', '=', 'DELETE_EMPLOYEE').execute()).filter((q) => (q.payload as Record<string, unknown>)['employeeId'] === E1);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ deviceId: HOST_DEV, employeeId: E1, options: { deviceUserId: '1' } });
    const ended = await depRow(D_ENDED);
    expect(ended.cleanupJobId).toBe(job.id);
    expect(ended.cleanedUpAt).not.toBeNull();
    // nobody wants E1 on the terminals the deployment gave them (no reconciliation puts them back) …
    expect([await desiredOf(HOST_DEV, E1), await desiredOf(HOST_NODEL, E1), await desiredOf(HOST_OFF, E1)]).toEqual([false, false, false]);
    // … while the host terminal they are on by another path, and their own branch's, are untouched
    expect(await desiredOf(HOST_DEV2, E1)).toBe(true);
    expect(await desiredOf(HOME_DEV, E1)).toBe(true);

    // ended yesterday (toDate + 1 today): the morning-after check-out still owns the terminal
    expect((await depRow(D_GRACE)).cleanedUpAt).toBeNull();
    expect(await desiredOf(HOST_DEV, E2)).toBe(true);

    // E3's old deployment hands its terminals over to the one running from today (which needs no job of its own: E3 is on
    // every host terminal already); E4 now belongs to the host: both keep them
    const keptOld = await depRow(D_KEPT_OLD);
    expect(keptOld.cleanedUpAt).not.toBeNull();
    expect(keptOld.cleanupJobId).toBeNull();
    const keptNow = await depRow(D_KEPT_NOW);
    expect([...keptNow.enrolledDeviceIds].sort()).toEqual([HOST_DEV, HOST_NODEL, HOST_DEV2].sort());
    expect(keptNow.enrolJobId).toBeNull();
    expect([await desiredOf(HOST_DEV, E3), await desiredOf(HOST_NODEL, E3), await desiredOf(HOST_DEV2, E3)]).toEqual([true, true, true]);
    expect(await desiredOf(HOST_DEV, E4)).toBe(true);
    // E8's deployment from today does not ask for the terminals: the old one's terminal is removed
    expect(await itemsOf((await depRow(D_OLD8)).cleanupJobId!)).toEqual([{ deviceId: HOST_DEV, employeeId: E8, operation: 'DELETE_EMPLOYEE', status: 'QUEUED' }]);
    expect(await desiredOf(HOST_DEV, E8)).toBe(false);
    expect((await depRow(D_NOW8)).enrolledDeviceIds).toEqual([]);
    expect((await depRow(D_TRANSFERRED)).cleanedUpAt).not.toBeNull();

    // terminals off: nothing enrolled, nothing removed (E5 stays on HOST_DEV, which another path gave them)
    const off = await depRow(D_ENROL_OFF);
    expect(off.cleanedUpAt).not.toBeNull();
    expect(off.cleanupJobId).toBeNull();
    expect(await desiredOf(HOST_DEV, E5)).toBe(true);

    // the cancelled deployment's queued enrolment never runs
    const cancelled = await depRow(D_CANCELLED);
    expect(cancelled.cleanedUpAt).not.toBeNull();
    expect((await itemsOf(cancelled.enrolJobId!)).map((i) => i.status)).toEqual(['CANCELLED']);
    expect((await a.selectFrom('syncJobs').select('status').where('id', '=', cancelled.enrolJobId!).executeTakeFirstOrThrow()).status).toBe('CANCELLED');
    const pushes = await a.selectFrom('jobs.queue').select(['payload']).where('jobType', '=', 'PUSH_EMPLOYEE').execute();
    expect(pushes.filter((p) => (p.payload as Record<string, unknown>)['syncJobId'] === cancelled.enrolJobId)).toHaveLength(0);

    // the deployment starting today is enrolled now — on the host terminals E6 is not on yet (HOST_DEV is theirs already:
    // neither pushed again nor recorded); the one starting tomorrow waits
    const today = await depRow(D_STARTS_TODAY);
    expect(today.enrolJobId).toBe(summary.enrolJobIds[0]);
    expect([...today.enrolledDeviceIds].sort()).toEqual([HOST_NODEL, HOST_DEV2].sort());
    const enrolJob = await a.selectFrom('syncJobs').selectAll().where('id', '=', today.enrolJobId!).executeTakeFirstOrThrow();
    expect(enrolJob).toMatchObject({ jobType: 'PUSH_EMPLOYEES', trigger: 'SCHEDULED', branchId: HOST });
    expect((await itemsOf(enrolJob.id)).map((i) => [i.deviceId, i.employeeId, i.operation])).toEqual([[HOST_NODEL, E6, 'PUSH_EMPLOYEE'], [HOST_DEV2, E6, 'PUSH_EMPLOYEE']].sort());
    const tomorrow = await depRow(D_STARTS_TOMORROW);
    expect(tomorrow.enrolJobId).toBeNull();
    expect(tomorrow.enrolledDeviceIds).toEqual([]);

    const audits = await a.selectFrom('audit.logs').select(['action', 'actorType', 'entityId', 'newValue']).where('action', 'in', ['employee.deployment_cleaned_up', 'employee.deployment_enrolled']).execute();
    expect(audits.filter((r) => r.action === 'employee.deployment_cleaned_up')).toHaveLength(6);
    expect(audits.filter((r) => r.action === 'employee.deployment_enrolled')).toHaveLength(1);
    expect(audits.every((r) => r.actorType === 'SYSTEM')).toBe(true);
    const byDep = (id: string) => audits.find((r) => (r.newValue as Record<string, unknown>)['deploymentId'] === id)!.newValue;
    expect(byDep(D_ENDED)).toMatchObject({ enrolledDevices: 3, removals: [{ deviceId: HOST_DEV, deviceUserId: '1' }], skipped: expect.arrayContaining([{ deviceId: HOST_NODEL, deviceUserId: '1', reason: 'delete_unsupported' }, { deviceId: HOST_OFF, deviceUserId: '1', reason: 'device_inactive' }]) });
    expect(byDep(D_KEPT_OLD)).toMatchObject({ kept: 'other_deployment', handedOverTo: D_KEPT_NOW, removals: [] });
    expect(byDep(D_TRANSFERRED)).toMatchObject({ kept: 'current_branch', removals: [] });
    expect(byDep(D_ENROL_OFF)).toMatchObject({ enrolledDevices: 0, kept: null, removals: [] });
    expect(byDep(D_STARTS_TODAY)).toMatchObject({ enrolled: expect.arrayContaining([HOST_NODEL, HOST_DEV2]), alreadyEnrolled: [HOST_DEV] });
  });

  it('is idempotent: a second run finds nothing to do (a deployment with nothing to push is looked at again, without a job)', async () => {
    const again = await runBranchDeploymentSweep(h.deps, ORG, null);
    expect(again).toMatchObject({ due: 0, cleanedUp: 0, removals: 0, syncJobIds: [], enrolDue: 1, enrolJobIds: [] });
    expect((await depRow(D_KEPT_NOW)).enrolJobId).toBeNull();
  });

  it('a deployment that took terminals over and is then cancelled (no enrolment job of its own) removes them', async () => {
    await h.tdb.adminDb.updateTable('employeeBranchDeployments').set({ cancelledAt: new Date(), cancelReason: 'Plans changed' }).where('id', '=', D_KEPT_NOW).execute();
    const run = await runBranchDeploymentSweep(h.deps, ORG, null);
    expect(run).toMatchObject({ due: 1, cleanedUp: 1, removals: 2 });
    expect(await itemsOf(run.syncJobIds[0]!)).toEqual([HOST_DEV, HOST_DEV2].sort().map((deviceId) => ({ deviceId, employeeId: E3, operation: 'DELETE_EMPLOYEE', status: 'QUEUED' })));
    // the delete-less terminal is reported as skipped, and nobody wants E3 there any more either
    expect([await desiredOf(HOST_DEV, E3), await desiredOf(HOST_NODEL, E3), await desiredOf(HOST_DEV2, E3)]).toEqual([false, false, false]);
    const row = await depRow(D_KEPT_NOW);
    expect(row.enrolJobId).toBeNull();
    expect(row.cleanupJobId).toBe(run.syncJobIds[0]);
  });

  it('the next day removes yesterday\'s grace deployment and enrols the one starting today', async () => {
    now = new Date('2026-10-08T20:30:00Z'); // 00:30 on the 9th
    const next = await runBranchDeploymentSweep(h.deps, ORG, null);
    expect(next).toMatchObject({ today: addDays(TODAY, 1), due: 1, cleanedUp: 1, removals: 1, enrolDue: 1 });
    expect(await itemsOf(next.syncJobIds[0]!)).toEqual([{ deviceId: HOST_DEV, employeeId: E2, operation: 'DELETE_EMPLOYEE', status: 'QUEUED' }]);
    expect(await desiredOf(HOST_DEV, E2)).toBe(false);
    const started = await depRow(D_STARTS_TOMORROW);
    expect(started.enrolJobId).toBe(next.enrolJobIds[0]);
    // E5 is on HOST_DEV by another path: not pushed, not recorded
    expect([...started.enrolledDeviceIds].sort()).toEqual([HOST_NODEL, HOST_DEV2].sort());
  });

  it('after the last day: an employee already on a host terminal keeps it; the pushed ones are removed from toDate + 2 only', async () => {
    // the enrolment of E6 ran on HOST_DEV2 (the device row the push writes)
    await h.tdb.adminDb.insertInto('deviceEmployeeStates').values(state(HOST_DEV2, E6, '6')).execute();
    // D_STARTS_TODAY ends on the 10th: the 11th is its morning-after, nothing goes
    now = new Date('2026-10-10T20:30:00Z'); // 00:30 on the 11th
    expect((await runBranchDeploymentSweep(h.deps, ORG, null)).due).toBe(0);
    expect(await desiredOf(HOST_DEV2, E6)).toBe(true);
    now = new Date('2026-10-11T20:30:00Z'); // 00:30 on the 12th = toDate + 2
    const run = await runBranchDeploymentSweep(h.deps, ORG, null);
    expect(run).toMatchObject({ due: 1, removals: 1 });
    expect(await itemsOf(run.syncJobIds[0]!)).toEqual([{ deviceId: HOST_DEV2, employeeId: E6, operation: 'DELETE_EMPLOYEE', status: 'QUEUED' }]);
    expect(await desiredOf(HOST_DEV2, E6)).toBe(false);
    expect(await desiredOf(HOST_DEV, E6)).toBe(true);
  });

  it('a leaver is never enrolled, even when their deployment\'s first day arrives', async () => {
    const a = h.tdb.adminDb;
    await a.updateTable('employees').set({ employmentStatus: 'terminated' }).where('id', '=', E7).execute();
    now = new Date('2026-10-12T20:30:00Z'); // 00:30 on the 13th
    await a.insertInto('employeeBranchDeployments').values({ id: D_LEAVER, organizationId: ORG, employeeId: E7, homeBranchId: HOME, branchId: HOST, fromDate: '2026-10-13', toDate: '2026-10-13', reason: 'Left since' }).execute();
    const run = await runBranchDeploymentSweep(h.deps, ORG, null);
    expect(run).toMatchObject({ enrolmentEnabled: true, enrolDue: 1, enrolJobIds: [] });
    expect((await depRow(D_LEAVER)).enrolJobId).toBeNull();
    await a.updateTable('employeeBranchDeployments').set({ cancelledAt: new Date(), cancelReason: 'Left' }).where('id', '=', D_LEAVER).execute();
    await a.updateTable('employees').set({ employmentStatus: 'active' }).where('id', '=', E7).execute();
    await runBranchDeploymentSweep(h.deps, ORG, null);
  });

  it('with advanced_scheduling off, removal still runs but nothing is enrolled', async () => {
    const a = h.tdb.adminDb;
    await a.insertInto('organizationModules').values({ organizationId: ORG, moduleKey: 'advanced_scheduling', enabled: false, reason: 'test' }).execute();
    now = new Date('2026-10-13T20:30:00Z'); // 00:30 on the 14th
    await a.insertInto('employeeBranchDeployments').values({ id: D_MODULE_OFF, organizationId: ORG, employeeId: E7, homeBranchId: HOME, branchId: HOST, fromDate: '2026-10-14', toDate: '2026-10-15', reason: 'Module off' }).execute();
    // a deployment cancelled while the module is off is still cleaned up
    await a.updateTable('employeeBranchDeployments').set({ cancelledAt: new Date(), cancelReason: 'Plans changed' }).where('id', '=', D_ENROL_OFF_LATER).execute();
    const run = await runBranchDeploymentSweep(h.deps, ORG, null);
    expect(run).toMatchObject({ enrolmentEnabled: false, enrolDue: 0, enrolJobIds: [], due: 1, cleanedUp: 1 });
    expect((await depRow(D_MODULE_OFF)).enrolJobId).toBeNull();
    expect((await depRow(D_ENROL_OFF_LATER)).cleanedUpAt).not.toBeNull();
  });

  it('a deployment enrolled before enrolled_device_ids existed is cleaned up from its enrolment job\'s terminals', async () => {
    const a = h.tdb.adminDb;
    const legacyEnrol = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => createSyncJob(trx, h.deps.queue, {
      organizationId: ORG, jobType: 'PUSH_EMPLOYEES', trigger: 'MANUAL', branchId: OTHER, correlationId: 'legacy-enrol', items: [{ deviceId: OTHER_DEV, employeeId: E8, operation: 'PUSH_EMPLOYEE', branchId: OTHER }],
    }));
    await a.updateTable('syncJobItems').set({ status: 'SUCCESS' }).where('syncJobId', '=', legacyEnrol.syncJobId).execute();
    await a.insertInto('deviceEmployeeStates').values(state(OTHER_DEV, E8, '8')).execute();
    // enrolled_device_ids left at its default: the row predates the column
    await a.insertInto('employeeBranchDeployments').values({ id: D_LEGACY, organizationId: ORG, employeeId: E8, homeBranchId: HOME, branchId: OTHER, fromDate: '2026-09-20', toDate: '2026-09-25', reason: 'Before the fix', enrolJobId: legacyEnrol.syncJobId }).execute();
    const run = await runBranchDeploymentSweep(h.deps, ORG, null);
    expect(run).toMatchObject({ due: 1, cleanedUp: 1, removals: 1 });
    expect(await itemsOf(run.syncJobIds[0]!)).toEqual([{ deviceId: OTHER_DEV, employeeId: E8, operation: 'DELETE_EMPLOYEE', status: 'QUEUED' }]);
    expect(await desiredOf(OTHER_DEV, E8)).toBe(false);
  });
});
