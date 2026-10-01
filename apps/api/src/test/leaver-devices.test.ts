/**
 * AGENTS.md "Termination": an employee who leaves (terminated / resigned / archived) is taken off every terminal they are
 * enrolled on. One DELETE_EMPLOYEE sync job is queued in the same transaction as the change, with one item per device row
 * still on a device (its own PIN, so manual mappings included); inactive devices and devices that cannot delete users are
 * audited instead of queued; every row of the leaver becomes desired = false. A leaver is never pushed; a re-activated
 * employee is pushed again. Before this, terminating only queued a PUSH_EMPLOYEES that skipped the leaver, so the person
 * stayed "In sync" on the terminal and could keep punching.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withContext } from '@flowza/database';
import { auditRows, createApiHarness, queueJobs, seedDevice, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
let devA: string; let devB: string; let devOff: string; let devNoDelete: string; let devGone: string; let connector: string;
const hrOnly = uuid('c'); // employee.view + employee.update only: no device permission at all
const base = () => `/api/v1/orgs/${f.orgId}`;
const EXIT = '2026-09-20';

type SyncStatus = 'IN_SYNC' | 'PENDING' | 'REMOVED';
const enrol = (deviceId: string, employeeId: string, deviceUserId: string, extra: { syncStatus?: SyncStatus; mappedAt?: Date } = {}) =>
  h.admin.insertInto('deviceEmployeeStates').values({ organizationId: f.orgId, deviceId, employeeId, deviceUserId, desired: extra.syncStatus !== 'REMOVED', syncStatus: extra.syncStatus ?? 'IN_SYNC', mappedAt: extra.mappedAt ?? null }).execute();
const statesOf = (employeeId: string) => h.admin.selectFrom('deviceEmployeeStates').select(['deviceId', 'deviceUserId', 'syncStatus', 'desired']).where('employeeId', '=', employeeId).execute();
/** Queued sync work naming the employee: per-item jobs carry `employeeId`, a PUSH_EMPLOYEES fan-out `scope.employeeIds`. */
const queuedFor = async (jobType: string, employeeId: string) => (await queueJobs(h.admin, jobType))
  .filter((j) => j.payload['employeeId'] === employeeId || ((j.payload['scope'] as { employeeIds?: string[] } | undefined)?.employeeIds ?? []).includes(employeeId));
const removalItems = (employeeId: string) => h.admin.selectFrom('syncJobItems as i').innerJoin('syncJobs as j', 'j.id', 'i.syncJobId')
  .select(['j.id as syncJobId', 'j.trigger', 'j.status', 'j.scope', 'j.branchId', 'i.deviceId', 'i.operation'])
  .where('i.employeeId', '=', employeeId).where('j.jobType', '=', 'DELETE_EMPLOYEE').execute();
const removalAudit = async (employeeId: string) => (await auditRows(h.admin, 'employee.device_removal_requested'))
  .filter((r) => ((r.newValue as { employeeIds: string[] }).employeeIds).includes(employeeId));
const byDevice = <T extends { deviceId: string }>(rows: T[]) => [...rows].sort((a, b) => a.deviceId.localeCompare(b.deviceId));

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_leaver_devices_${process.pid}`); f = await seedOrg(h.admin, 'leavers');
  devA = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'LV-A', serialNumber: 'GN6733356' });
  devB = await seedDevice(h.admin, f.orgId, f.branchB, { code: 'LV-B' });
  devOff = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'LV-OFF', status: 'disabled' });
  devNoDelete = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'LV-ND', capabilities: { attendancePull: true, employeePush: false, employeeDelete: false } });
  devGone = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'LV-GONE' });
  connector = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'LV-FIN', providerKey: 'flowza_finance' });
  const roleId = uuid('9');
  await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, async (trx) => {
    await trx.insertInto('roles').values({ id: roleId, organizationId: f.orgId, key: 'hr_no_devices', name: 'HR without devices', isSystem: false }).execute();
    await trx.insertInto('rolePermissions').values(['employee.view', 'employee.update'].map((permissionKey) => ({ roleId, permissionKey }))).execute();
  });
  await seedUser(h.admin, hrOnly, 'hr-only-leavers@test.local', 'HR Only');
  await seedMembership(h.admin, f.orgId, hrOnly, roleId);
});
afterAll(async () => { await h?.close(); });

describe('an employee who leaves is taken off every terminal', () => {
  let e: string;

  it('PATCH terminated queues one DELETE_EMPLOYEE per enrolled terminal under its own PIN, even for an actor without device permissions', async () => {
    e = await seedEmployee(h.admin, f.orgId, f.branchA, 40);
    await enrol(devA, e, '1040');
    await enrol(devB, e, '77', { mappedAt: new Date() }); // a manual mapping under another PIN, on another branch's device
    await enrol(devOff, e, '1040');
    await enrol(devNoDelete, e, '1040');
    await enrol(devGone, e, '1040', { syncStatus: 'REMOVED' });
    await enrol(connector, e, '1040');

    const res = await h.request('PATCH', `${base()}/employees/${e}`, { token: hrOnly, body: { employmentStatus: 'terminated', exitDate: EXIT, effectiveFrom: EXIT } });
    expect(res.status).toBe(200);

    // one sync job, one item per terminal the person is still on: not the removed row, the inactive or delete-less device, nor the connector
    const items = await removalItems(e);
    expect(byDevice(items).map((i) => i.deviceId)).toEqual([devA, devB].sort());
    expect(new Set(items.map((i) => i.syncJobId)).size).toBe(1);
    expect(items[0]).toMatchObject({ trigger: 'SYSTEM', status: 'QUEUED', operation: 'DELETE_EMPLOYEE', branchId: null, scope: expect.objectContaining({ employeeIds: [e], cause: 'employee_left', source: 'update' }) });
    const queued = byDevice((await queuedFor('DELETE_EMPLOYEE', e)).map((j) => ({ deviceId: j.payload['deviceId'] as string, deviceUserId: (j.payload['options'] as { deviceUserId: string }).deviceUserId, queueName: j.queueName })));
    expect(queued).toEqual(byDevice([{ deviceId: devA, deviceUserId: '1040', queueName: 'sync' }, { deviceId: devB, deviceUserId: '77', queueName: 'sync' }]));

    // nothing may put them back; the rows the worker has not touched keep their status until it does
    const states = await statesOf(e);
    expect(states.every((s) => s.desired === false)).toBe(true);
    expect(states.find((s) => s.deviceId === devNoDelete)?.syncStatus).toBe('IN_SYNC');

    const [audited] = await removalAudit(e);
    expect(audited).toMatchObject({ entityId: e, reason: 'Employee left the organisation' });
    const value = audited!.newValue as { syncJobId: string; removals: unknown[]; skipped: Array<{ deviceId: string }>; source: string; employmentStatus: string };
    expect(value).toMatchObject({ syncJobId: items[0]!.syncJobId, source: 'update', employmentStatus: 'terminated' });
    expect(value.removals).toHaveLength(2);
    expect(byDevice(value.skipped)).toEqual(byDevice([{ deviceId: devOff, deviceUserId: '1040', reason: 'device_inactive' }, { deviceId: devNoDelete, deviceUserId: '1040', reason: 'delete_unsupported' }]));

    // a leaver is never pushed (the old behaviour: a PUSH_EMPLOYEES that skipped them and left them on the device)
    expect(await queuedFor('PUSH_EMPLOYEES', e)).toEqual([]);
  });

  it('editing a leaver removes nothing twice; re-activating them pushes them back', async () => {
    const rename = await h.request('PATCH', `${base()}/employees/${e}`, { token: f.hrAdmin, body: { displayName: 'Still Gone' } });
    expect(rename.status).toBe(200);
    expect(await queuedFor('DELETE_EMPLOYEE', e)).toHaveLength(2);
    expect(await queuedFor('PUSH_EMPLOYEES', e)).toEqual([]);

    const back = await h.request('PATCH', `${base()}/employees/${e}`, { token: f.hrAdmin, body: { employmentStatus: 'active', exitDate: null } });
    expect(back.status).toBe(200);
    expect(await queuedFor('PUSH_EMPLOYEES', e)).toHaveLength(1);
    expect(await queuedFor('DELETE_EMPLOYEE', e)).toHaveLength(2);
    expect(await removalAudit(e)).toHaveLength(1);
  });

  it('bulk set_status resigned removes every leaver in one sync job and pushes none of them', async () => {
    const a = await seedEmployee(h.admin, f.orgId, f.branchA, 41);
    const b = await seedEmployee(h.admin, f.orgId, f.branchB, 42);
    await enrol(devA, a, '1041');
    await enrol(devB, b, '1042', { syncStatus: 'PENDING' });
    const res = await h.request('POST', `${base()}/employees/bulk`, { token: f.hrAdmin, body: { action: 'set_status', employeeIds: [a, b], employmentStatus: 'resigned', effectiveFrom: EXIT } });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(2);
    const items = [...await removalItems(a), ...await removalItems(b)];
    expect(byDevice(items).map((i) => i.deviceId)).toEqual([devA, devB].sort());
    expect(new Set(items.map((i) => i.syncJobId)).size).toBe(1);
    const scope = items[0]!.scope as { employeeIds: string[]; source: string };
    expect({ employeeIds: [...scope.employeeIds].sort(), source: scope.source }).toEqual({ employeeIds: [a, b].sort(), source: 'bulk_set_status' });
    expect([...await queuedFor('PUSH_EMPLOYEES', a), ...await queuedFor('PUSH_EMPLOYEES', b)]).toEqual([]);
    expect((await removalAudit(a))[0]?.entityId).toBeNull();
  });

  it('archiving takes off a record that left earlier and is still on a terminal', async () => {
    const left = await seedEmployee(h.admin, f.orgId, f.branchA, 43, { employmentStatus: 'terminated', deviceUserId: '2' });
    await enrol(devA, left, '2');
    const res = await h.request('DELETE', `${base()}/employees/${left}`, { token: f.hrAdmin, body: { exitDate: EXIT, reason: 'Left in August' } });
    expect(res.status).toBe(200);
    const queued = await queuedFor('DELETE_EMPLOYEE', left);
    expect(queued.map((j) => [j.payload['deviceId'], (j.payload['options'] as { deviceUserId: string }).deviceUserId])).toEqual([[devA, '2']]);
    expect((await removalItems(left))[0]?.scope).toMatchObject({ source: 'delete' });
    expect(await statesOf(left)).toEqual([{ deviceId: devA, deviceUserId: '2', syncStatus: 'IN_SYNC', desired: false }]);
    expect(await queuedFor('PUSH_EMPLOYEES', left)).toEqual([]);
  });

  it('an employee on no terminal leaves without a sync job or a removal audit', async () => {
    const solo = await seedEmployee(h.admin, f.orgId, f.branchA, 44);
    const res = await h.request('PATCH', `${base()}/employees/${solo}`, { token: f.hrAdmin, body: { employmentStatus: 'terminated', exitDate: EXIT, effectiveFrom: EXIT } });
    expect(res.status).toBe(200);
    expect(await removalItems(solo)).toEqual([]);
    expect(await removalAudit(solo)).toEqual([]);
  });
});
