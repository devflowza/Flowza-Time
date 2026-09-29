import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { auditRows, createApiHarness, queueJobs, seedDevice, seedMembership, seedOrg, seedUser, uuid, ROLE, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

/**
 * PIN mapping (Devices & punches): device user id → employee per device (device_employee_states, marked `mapped_at`) or as the
 * employee's default device user id; unmatched punches of the PIN go back to the normaliser; conflicts are explicit and can be
 * replaced; unmapping never touches attributed punches. Plus the punch log's employee / mapping filters.
 */
let h: ApiHarness; let f: OrgFixture; let device: string; let deviceB: string; let connector: string;
let auditor: string;

const raw = (deviceId: string, user: string, minute: number, status = 'unmatched', employeeId: string | null = null) => sql`insert into public.attendance_raw_transactions (organization_id, device_id, branch_id, provider_key, device_employee_id, employee_id, punched_at, dedupe_hash, source, processing_status)
  values (${f.orgId}::uuid, ${deviceId}::uuid, null, 'mock', ${user}, ${employeeId}::uuid, ${`2026-09-20T05:${String(minute).padStart(2, '0')}:00Z`}, ${`pin-${deviceId}-${user}-${minute}`}, 'POLL', ${status})`.execute(h.admin);
const statuses = async (deviceId: string, user: string) => (await h.admin.selectFrom('attendanceRawTransactions').select('processingStatus').where('deviceId', '=', deviceId).where('deviceEmployeeId', '=', user).orderBy('id').execute()).map((r) => r.processingStatus);
const stateOf = (deviceId: string, user: string) => h.admin.selectFrom('deviceEmployeeStates').selectAll().where('deviceId', '=', deviceId).where('deviceUserId', '=', user).executeTakeFirst();

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_pins_${process.pid}`); f = await seedOrg(h.admin, 'pins');
  device = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'PIN-A', serialNumber: 'GN6733356' });
  deviceB = await seedDevice(h.admin, f.orgId, f.branchB, { code: 'PIN-B' });
  connector = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'FIN', providerKey: 'flowza_finance' });
  auditor = uuid('c'); await seedUser(h.admin, auditor, 'auditor-pins@test.local', 'Auditor'); await seedMembership(h.admin, f.orgId, auditor, ROLE.auditor);
  for (let i = 0; i < 3; i += 1) await raw(device, '2', i);
  await raw(deviceB, '2', 10);
  await raw(device, '4', 20);
  await raw(device, '1001', 30, 'normalized', f.e1);
});
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;

describe('PIN mapping', () => {
  it('lists every employee default and needs device.view + employee.view', async () => {
    const res = await h.request('GET', `${base()}/pin-mappings?pageSize=100`, { token: f.hrAdmin });
    expect(res.status).toBe(200);
    const defaults = res.body.data.filter((m: { scope: string }) => m.scope === 'default');
    expect(defaults.map((m: { deviceUserId: string }) => m.deviceUserId)).toEqual(['1001', '1002', '1003']);
    expect(defaults[0]).toMatchObject({ id: `default:${f.e1}`, employeeId: f.e1, deviceId: null, manual: false, stateId: null });
    expect((await h.request('GET', `${base()}/pin-mappings`, { token: auditor })).status).toBe(403);
    expect((await h.request('GET', `${base()}/pin-mappings`, { token: f.payrollUser })).status).toBe(403);
  });

  it('maps a PIN on one device, re-queues only that device\'s unmatched punches and marks the row manual', async () => {
    const res = await h.request('POST', `${base()}/pin-mappings`, { token: f.hrAdmin, body: { employeeId: f.e1, deviceUserId: '2', deviceId: device } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ scope: 'device', employeeId: f.e1, deviceId: device, deviceUserId: '2', changed: true, rowsRequeued: 3 });
    expect(await statuses(device, '2')).toEqual(['pending', 'pending', 'pending']);
    expect(await statuses(deviceB, '2')).toEqual(['unmatched']); // another device's PIN 2 is somebody else until mapped there
    const state = await stateOf(device, '2');
    expect(state).toMatchObject({ employeeId: f.e1, desired: true, syncStatus: 'IN_SYNC', mappedBy: f.hrAdmin });
    expect(state!.mappedAt).not.toBeNull();
    expect((await queueJobs(h.admin, 'NORMALIZE_RAW')).some((j) => j.dedupeKey === `normalize:${f.orgId}`)).toBe(true);
    expect((await auditRows(h.admin, 'device.pin_mapped'))[0]?.newValue).toMatchObject({ deviceId: device, deviceUserId: '2', employeeId: f.e1, rowsRequeued: 3 });
    // listed as a manual device mapping with the device's serial
    const list = await h.request('GET', `${base()}/pin-mappings?deviceId=${device}`, { token: f.hrAdmin });
    expect(list.body.data).toEqual([expect.objectContaining({ scope: 'device', deviceUserId: '2', employeeId: f.e1, deviceSerial: 'GN6733356', manual: true, stateId: state!.id })]);
    // mapping it again changes nothing
    const again = await h.request('POST', `${base()}/pin-mappings`, { token: f.hrAdmin, body: { employeeId: f.e1, deviceUserId: '2', deviceId: device } });
    expect(again.body.data).toMatchObject({ changed: false, rowsRequeued: 0 });
  });

  it('refuses a taken PIN or an already mapped employee with a reason, and replaces on request', async () => {
    const taken = await h.request('POST', `${base()}/pin-mappings`, { token: f.hrAdmin, body: { employeeId: f.e3, deviceUserId: '2', deviceId: device } });
    expect(taken.status).toBe(409);
    expect(taken.body.details).toMatchObject({ reason: 'PIN_TAKEN', employeeId: f.e1 });
    const mapped = await h.request('POST', `${base()}/pin-mappings`, { token: f.hrAdmin, body: { employeeId: f.e1, deviceUserId: '4', deviceId: device } });
    expect(mapped.status).toBe(409);
    expect(mapped.body.details).toMatchObject({ reason: 'EMPLOYEE_MAPPED', deviceUserId: '2' });
    // replace: e1 moves from PIN 2 to PIN 4 on the device; PIN 2 (never reported by the device as a user) is released
    const moved = await h.request('POST', `${base()}/pin-mappings`, { token: f.hrAdmin, body: { employeeId: f.e1, deviceUserId: '4', deviceId: device, replace: true } });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ changed: true, previousDeviceUserId: '2', rowsRequeued: 1 });
    expect(await stateOf(device, '2')).toBeUndefined();
    expect(await stateOf(device, '4')).toMatchObject({ employeeId: f.e1 });
    // the punches PIN 2 already had stay as they are (re-queued earlier; never re-attributed by a mapping change)
    expect(await statuses(device, '2')).toEqual(['pending', 'pending', 'pending']);
  });

  it('unmaps a device mapping; the attributed punches are untouched', async () => {
    const state = await stateOf(device, '4');
    const res = await h.request('DELETE', `${base()}/pin-mappings/${state!.id}`, { token: f.hrAdmin });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deviceUserId: '4', employeeId: f.e1, removed: true });
    expect(await stateOf(device, '4')).toBeUndefined();
    expect((await auditRows(h.admin, 'device.pin_unmapped'))[0]?.oldValue).toMatchObject({ deviceUserId: '4', employeeId: f.e1, manual: true });
    expect((await h.request('DELETE', `${base()}/pin-mappings/${state!.id}`, { token: f.hrAdmin })).status).toBe(404);
    // a device-only row (reported by the device) keeps existing as the device's user, without the employee
    await h.admin.insertInto('deviceEmployeeStates').values({ organizationId: f.orgId, deviceId: device, branchId: f.branchA, deviceUserId: '77', employeeId: null, desired: false, syncStatus: 'OUT_OF_SYNC', deviceRecord: JSON.stringify({ name: 'Visitor' }) }).execute();
    const map77 = await h.request('POST', `${base()}/pin-mappings`, { token: f.hrAdmin, body: { employeeId: f.e3, deviceUserId: '77', deviceId: device } });
    expect(map77.status).toBe(200);
    const s77 = await stateOf(device, '77');
    expect(s77).toMatchObject({ employeeId: f.e3, syncStatus: 'OUT_OF_SYNC' });
    const unmap = await h.request('DELETE', `${base()}/pin-mappings/${s77!.id}`, { token: f.hrAdmin });
    expect(unmap.body.data).toMatchObject({ removed: false });
    expect(await stateOf(device, '77')).toMatchObject({ employeeId: null, mappedAt: null, desired: false });
  });

  it('sets the employee default device ID (every device) and re-queues the PIN\'s unmatched punches everywhere', async () => {
    const res = await h.request('POST', `${base()}/pin-mappings`, { token: f.hrAdmin, body: { employeeId: f.e2, deviceUserId: '2', deviceId: null } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ scope: 'default', employeeId: f.e2, previousDeviceUserId: '1002', changed: true, rowsRequeued: 1 });
    expect(await statuses(deviceB, '2')).toEqual(['pending']);
    expect((await h.admin.selectFrom('employees').select('deviceUserId').where('id', '=', f.e2).executeTakeFirstOrThrow()).deviceUserId).toBe('2');
    const audits = await auditRows(h.admin, 'employee.updated');
    expect(audits[0]).toMatchObject({ entityId: f.e2, reason: 'PIN mapping' });
    expect(audits[0]?.oldValue).toMatchObject({ deviceUserId: '1002' });
    // another employee's default is never taken over
    const clash = await h.request('POST', `${base()}/pin-mappings`, { token: f.hrAdmin, body: { employeeId: f.e3, deviceUserId: '1001', deviceId: null } });
    expect(clash.status).toBe(409);
    expect(clash.body.details).toMatchObject({ reason: 'PIN_TAKEN', employeeId: f.e1 });
    // a default id keeps the employee-record format
    expect((await h.request('POST', `${base()}/pin-mappings`, { token: f.hrAdmin, body: { employeeId: f.e3, deviceUserId: '12 34', deviceId: null } })).status).toBe(400);
  });

  it('enforces permissions, branch scope and the connector rule', async () => {
    // hr_user holds device.sync + employee.update; the auditor neither
    expect((await h.request('POST', `${base()}/pin-mappings`, { token: auditor, body: { employeeId: f.e1, deviceUserId: '9', deviceId: device } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/pin-mappings`, { token: auditor, body: { employeeId: f.e1, deviceUserId: '9', deviceId: null } })).status).toBe(403);
    // branch manager of B: branch A's device and employee are invisible (RLS) — not found, nothing written
    expect((await h.request('POST', `${base()}/pin-mappings`, { token: f.branchManagerB, body: { employeeId: f.e2, deviceUserId: '9', deviceId: device } })).status).toBe(404);
    expect((await h.request('POST', `${base()}/pin-mappings`, { token: f.branchManagerB, body: { employeeId: f.e1, deviceUserId: '9', deviceId: deviceB } })).status).toBe(400);
    expect((await h.request('POST', `${base()}/pin-mappings`, { token: f.branchManagerB, body: { employeeId: f.e1, deviceUserId: '9', deviceId: null } })).status).toBe(400);
    expect(await stateOf(deviceB, '9')).toBeUndefined();
    const blocked = await h.request('POST', `${base()}/pin-mappings`, { token: f.hrAdmin, body: { employeeId: f.e1, deviceUserId: '9', deviceId: connector } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toMatchObject({ reason: 'CONNECTOR_RESOLVES_BY_EMPLOYEE_NUMBER' });
    // the branch manager only lists branch B
    const scoped = await h.request('GET', `${base()}/pin-mappings?pageSize=100`, { token: f.branchManagerB });
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.every((m: { branchId: string }) => m.branchId === f.branchB)).toBe(true);
  });
});

describe('punch log filters', () => {
  it('filters raw punches by employee and by mapping, with device serial and employee number', async () => {
    const mapped = await h.request('GET', `${base()}/attendance/raw?mapping=mapped`, { token: f.hrAdmin });
    expect(mapped.status).toBe(200);
    expect(mapped.body.data.map((r: { deviceEmployeeId: string }) => r.deviceEmployeeId)).toEqual(['1001']);
    expect(mapped.body.data[0]).toMatchObject({ employeeId: f.e1, employeeNumber: 'EMP1', deviceSerial: 'GN6733356', deviceTimezone: 'Asia/Muscat', dedupeHash: `pin-${device}-1001-30` });
    const unmapped = await h.request('GET', `${base()}/attendance/raw?mapping=unmapped&limit=100`, { token: f.hrAdmin });
    expect(unmapped.body.data.every((r: { employeeId: string | null }) => r.employeeId === null)).toBe(true);
    expect(unmapped.body.data.length).toBe(5);
    const byEmployee = await h.request('GET', `${base()}/attendance/raw?employeeId=${f.e1}`, { token: f.hrAdmin });
    expect(byEmployee.body.data.map((r: { employeeId: string }) => r.employeeId)).toEqual([f.e1]);
  });
});
