import { sql } from 'kysely';
import { SYNC_TRIGGERS, type DeviceEmployee, type SyncJobType, type SyncTrigger } from '@flowza/contracts';
import { withContext, type DeviceEmployeeSyncStatus, type Trx } from '@flowza/database';
import { ProviderError, type DeviceOperationResult, type DeviceProvider } from '@flowza/device-providers';
import { AppError, event, newCorrelationId, sha256Hex } from '@flowza/shared';
import type { JobContext } from '../types.js';
import { addSyncJobItems, createSyncJob, DEFAULT_PRIORITY } from './api.js';
import { checkCircuit } from './circuit.js';
import { capabilitiesOf, circuitOpenError, handleProviderFailure, handleProviderSuccess, isProviderCode, loadDeviceOrThrow, requireCapability } from './common.js';
import { buildProviderContext, deviceConfig } from './context.js';
import { runItem } from './items.js';
import type { DeviceRow } from './types.js';

export const DEVICE_NAME_MAX = 24;
const ELIGIBLE_EMPLOYMENT = ['active', 'on_leave'] as const;
const MAX_LIST_PAGES = 200;

interface EmployeeRow { id: string; branchId: string; employeeNumber: string; displayName: string; deviceUserId: string; cardNumber: string | null; employmentStatus: string; deletedAt: Date | null }
interface IdentityRow { deviceUserId: string; cardNumber: string | null }

const asciiOnly = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

/** Does the device accept UTF-8 names? Providers/devices flag ASCII-only displays via config (`asciiNames: true` or `utf8Names: false`). */
export function deviceWantsAscii(device: Pick<DeviceRow, 'config'>): boolean {
  const cfg = deviceConfig(device);
  return cfg['asciiNames'] === true || cfg['utf8Names'] === false || cfg['utf8'] === false;
}

/** The representation a device cares about (§F.5). Pins are never part of it: they cannot be read back from a device. */
export function buildDeviceEmployee(emp: Pick<EmployeeRow, 'employeeNumber' | 'displayName' | 'deviceUserId' | 'cardNumber'>, identity: IdentityRow | null, opts: { ascii: boolean; pin?: string | null }): DeviceEmployee {
  let name = emp.displayName.trim();
  if (opts.ascii && !asciiOnly(name)) name = emp.employeeNumber;
  if (name.length === 0) name = emp.employeeNumber;
  name = [...name].slice(0, DEVICE_NAME_MAX).join('');
  return { deviceUserId: identity?.deviceUserId ?? emp.deviceUserId, name, cardNumber: identity?.cardNumber ?? emp.cardNumber ?? null, pin: opts.pin ?? null, privilege: 'user', enabled: true, photoUrl: null, extra: {} };
}

/** Stable hash of the fields compared between cloud and device (pin and vendor extras excluded). */
export function hashDeviceEmployee(e: DeviceEmployee): string {
  return sha256Hex(JSON.stringify({ deviceUserId: e.deviceUserId, name: e.name, cardNumber: e.cardNumber ?? null, privilege: e.privilege ?? 'user', enabled: e.enabled ?? true }));
}

async function loadEmployee(trx: Trx, organizationId: string, employeeId: string | null): Promise<EmployeeRow> {
  if (!employeeId) throw new AppError('VALIDATION_ERROR', 'sync item has no employee');
  const e = await trx.selectFrom('employees').select(['id', 'branchId', 'employeeNumber', 'displayName', 'deviceUserId', 'cardNumber', 'employmentStatus', 'deletedAt']).where('organizationId', '=', organizationId).where('id', '=', employeeId).executeTakeFirst();
  if (!e) throw new AppError('NOT_FOUND', `employee ${employeeId} not found`);
  return e;
}

const isEligible = (e: EmployeeRow): boolean => e.deletedAt === null && (ELIGIBLE_EMPLOYMENT as readonly string[]).includes(e.employmentStatus);

async function loadIdentity(trx: Trx, organizationId: string, employeeId: string, providerKey: string): Promise<IdentityRow | null> {
  const row = await trx.selectFrom('employeeProviderIdentities').select(['deviceUserId', 'cardNumber']).where('organizationId', '=', organizationId).where('employeeId', '=', employeeId).where('providerKey', '=', providerKey).executeTakeFirst();
  return row ?? null;
}

/** Push-protocol operations complete asynchronously: persist the protocol commands the device will fetch on its next poll. */
async function queueDeviceCommands(trx: Trx, device: DeviceRow, syncJobItemId: string, res: DeviceOperationResult): Promise<number> {
  const commands = Array.isArray(res.details?.['commands']) ? (res.details['commands'] as Array<{ commandType?: unknown; payload?: unknown }>) : [];
  const rows = commands.filter((c) => typeof c.commandType === 'string').map((c) => ({ organizationId: device.organizationId, deviceId: device.id, commandType: c.commandType as string, payload: JSON.stringify(c.payload && typeof c.payload === 'object' ? c.payload : {}), syncJobItemId }));
  if (rows.length > 0) await trx.insertInto('deviceCommands').values(rows).execute();
  return rows.length;
}

interface StatePatch { employeeId?: string | null; cloudHash?: string | null; deviceHash?: string | null; syncStatus: DeviceEmployeeSyncStatus; desired?: boolean; lastErrorCode?: string | null; lastError?: string | null; lastSuccessAt?: Date | null; deviceRecord?: Record<string, unknown> | null; fingerprintCount?: number; faceEnrolled?: boolean; cardEnrolled?: boolean }

/**
 * Upserts the (device, device_user_id) state row. Two unique keys exist — (device, device_user_id) and (device, employee) —
 * so a mapping change (new device user id for a known employee) re-points the employee's row instead of violating the index.
 */
async function upsertState(trx: Trx, device: DeviceRow, deviceUserId: string, patch: StatePatch, now: Date): Promise<void> {
  if (patch.employeeId) {
    const byEmployee = await trx.selectFrom('deviceEmployeeStates').select(['id', 'deviceUserId']).where('deviceId', '=', device.id).where('employeeId', '=', patch.employeeId).executeTakeFirst();
    if (byEmployee && byEmployee.deviceUserId !== deviceUserId) {
      await trx.deleteFrom('deviceEmployeeStates').where('deviceId', '=', device.id).where('deviceUserId', '=', deviceUserId).where('employeeId', 'is', null).execute();
      await trx.updateTable('deviceEmployeeStates').set({ deviceUserId }).where('id', '=', byEmployee.id).execute();
    }
  }
  const values = {
    organizationId: device.organizationId, deviceId: device.id, branchId: device.branchId, deviceUserId, employeeId: patch.employeeId ?? null, cloudHash: patch.cloudHash ?? null, deviceHash: patch.deviceHash ?? null,
    syncStatus: patch.syncStatus, desired: patch.desired ?? true, lastSyncAt: now, lastSuccessAt: patch.lastSuccessAt ?? null, lastErrorCode: patch.lastErrorCode ?? null, lastError: patch.lastError ?? null,
    deviceRecord: patch.deviceRecord ? JSON.stringify(patch.deviceRecord) : null, fingerprintCount: patch.fingerprintCount ?? 0, faceEnrolled: patch.faceEnrolled ?? false, cardEnrolled: patch.cardEnrolled ?? false,
  };
  const update: Record<string, unknown> = { syncStatus: patch.syncStatus, lastSyncAt: now, lastErrorCode: patch.lastErrorCode ?? null, lastError: patch.lastError ?? null, branchId: device.branchId };
  if (patch.employeeId !== undefined) update['employeeId'] = patch.employeeId;
  if (patch.cloudHash !== undefined) update['cloudHash'] = patch.cloudHash;
  if (patch.deviceHash !== undefined) update['deviceHash'] = patch.deviceHash;
  if (patch.desired !== undefined) update['desired'] = patch.desired;
  if (patch.lastSuccessAt !== undefined) update['lastSuccessAt'] = patch.lastSuccessAt;
  if (patch.deviceRecord !== undefined) update['deviceRecord'] = patch.deviceRecord ? JSON.stringify(patch.deviceRecord) : null;
  if (patch.fingerprintCount !== undefined) update['fingerprintCount'] = patch.fingerprintCount;
  if (patch.faceEnrolled !== undefined) update['faceEnrolled'] = patch.faceEnrolled;
  if (patch.cardEnrolled !== undefined) update['cardEnrolled'] = patch.cardEnrolled;
  await trx.insertInto('deviceEmployeeStates').values(values).onConflict((oc) => oc.columns(['deviceId', 'deviceUserId']).doUpdateSet(update as never)).execute();
}

type Prepared = Awaited<ReturnType<typeof buildProviderContext>> & { provider: DeviceProvider };

async function prepareDevice(ctx: JobContext, trx: Trx, deviceId: string | null, capability: 'employeePush' | 'employeeDelete' | 'employeePull', operation: string, now: Date): Promise<Prepared> {
  const device = await loadDeviceOrThrow(trx, deviceId);
  const provider = ctx.deps.providers.get(device.providerKey);
  requireCapability(capabilitiesOf(device, provider), capability, operation);
  const built = await buildProviderContext(trx, ctx.deps, device, ctx.job.id, ctx.signal, { log: ctx.log, provider, timeoutMs: 120_000 });
  const circuit = await checkCircuit(trx, { organizationId: device.organizationId, providerKey: device.providerKey, accountKey: built.accountKey }, now);
  if (!circuit.allow) { built.dispose(); throw circuitOpenError(circuit.halfOpenAt, now); }
  return built;
}

/** Marks the state row after a failed provider call (own transaction) — the error itself is handled by runItem. */
async function failState(ctx: JobContext, device: DeviceRow, deviceUserId: string, employeeId: string | null, err: unknown, removing: boolean): Promise<void> {
  const code = ProviderError.is(err) ? err.code : AppError.is(err) ? err.code : 'INTERNAL';
  const status: DeviceEmployeeSyncStatus = code === 'DEVICE_OFFLINE' ? 'OFFLINE' : code === 'UNSUPPORTED' || code === 'NOT_IMPLEMENTED' ? 'UNSUPPORTED' : 'FAILED';
  await withContext(ctx.deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, (trx) =>
    upsertState(trx, device, deviceUserId, { employeeId, syncStatus: status, desired: !removing, lastErrorCode: code, lastError: (err as Error).message?.slice(0, 500) ?? String(err) }, ctx.deps.now())).catch((e: Error) => ctx.log.warn(event('device_state_update_failed', { err: e.message })));
}

/**
 * PUSH_EMPLOYEE: desired representation (identity → device user id, ASCII fallback, ≤ 24 chars, pin only when supplied) is
 * hashed and compared with `device_employee_states.device_hash`; unchanged employees are skipped unless forced. Push devices
 * answer asynchronously → `device_commands` rows + state PENDING; synchronous devices → state IN_SYNC with the confirmed hash.
 */
export async function pushEmployee(ctx: JobContext) {
  const { deps } = ctx;
  return runItem(ctx, async (item, payload) => {
    const now = deps.now();
    const force = payload.options['force'] === true;
    const pin = typeof payload.options['pin'] === 'string' && payload.options['pin'].length > 0 ? payload.options['pin'] : null;
    const prep = await withContext(deps.db, { kind: 'system', organizationId: payload.organizationId, jobId: ctx.job.id }, async (trx) => {
      const employee = await loadEmployee(trx, payload.organizationId, payload.employeeId);
      if (!isEligible(employee)) throw new AppError('INVALID_STATE', `employee ${employee.employeeNumber} is ${employee.deletedAt ? 'deleted' : employee.employmentStatus}; not pushed to devices`);
      const device = await loadDeviceOrThrow(trx, payload.deviceId);
      const provider = deps.providers.get(device.providerKey);
      if (!capabilitiesOf(device, provider).employeePush) return { skip: false as const, unsupported: true as const, device, employee };
      const identity = await loadIdentity(trx, payload.organizationId, employee.id, device.providerKey);
      const desired = buildDeviceEmployee(employee, identity, { ascii: deviceWantsAscii(device), pin });
      const cloudHash = hashDeviceEmployee(desired);
      const state = await trx.selectFrom('deviceEmployeeStates').select(['deviceHash', 'syncStatus', 'deviceUserId']).where('deviceId', '=', device.id).where('employeeId', '=', employee.id).executeTakeFirst();
      if (!force && pin === null && state && state.syncStatus === 'IN_SYNC' && state.deviceHash === cloudHash && state.deviceUserId === desired.deviceUserId) return { skip: true as const, device, desired };
      await upsertState(trx, device, desired.deviceUserId, { employeeId: employee.id, cloudHash, syncStatus: 'PENDING', desired: true }, now);
      const built = await prepareDevice(ctx, trx, device.id, 'employeePush', 'upsertEmployee', now);
      return { skip: false as const, unsupported: false as const, device, desired, cloudHash, built, employee };
    });
    if (prep.skip) return { result: { skipped: 'in_sync', deviceUserId: prep.desired.deviceUserId } };
    if (prep.unsupported) {
      // recorded in its own transaction: the UNSUPPORTED error below is terminal for the item and the state must survive it
      await withContext(deps.db, { kind: 'system', organizationId: payload.organizationId, jobId: ctx.job.id }, (trx) => upsertState(trx, prep.device, prep.employee.deviceUserId, { employeeId: prep.employee.id, syncStatus: 'UNSUPPORTED', lastErrorCode: 'UNSUPPORTED', lastError: 'device cannot receive employees' }, now));
      throw new ProviderError('UNSUPPORTED', 'upsertEmployee is not supported by this device (capability employeePush)', { retryable: false, details: { capability: 'employeePush' } });
    }
    const { built, desired, cloudHash, device } = prep;
    try {
      const res = await built.provider.upsertEmployee(built.ctx, desired);
      if (!res.ok) throw new ProviderError('VENDOR_ERROR', res.message ?? 'device rejected the employee', { retryable: true });
      const out = await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, async (trx) => {
        await handleProviderSuccess(trx, device, built.accountKey);
        await trx.updateTable('devices').set({ lastEmployeeSyncAt: deps.now(), lastSuccessfulCommunicationAt: deps.now() }).where('id', '=', device.id).execute();
        if (res.async) {
          const commands = await queueDeviceCommands(trx, device, item.id, res);
          await upsertState(trx, device, desired.deviceUserId, { employeeId: prep.employee.id, cloudHash, syncStatus: 'PENDING', desired: true }, deps.now());
          return { async: true, commands, deviceUserId: desired.deviceUserId };
        }
        await upsertState(trx, device, desired.deviceUserId, { employeeId: prep.employee.id, cloudHash, deviceHash: cloudHash, syncStatus: 'IN_SYNC', desired: true, lastSuccessAt: deps.now(), deviceRecord: { deviceUserId: res.deviceUserId ?? desired.deviceUserId, name: desired.name, cardNumber: desired.cardNumber ?? null }, cardEnrolled: !!desired.cardNumber }, deps.now());
        return { async: false, deviceUserId: res.deviceUserId ?? desired.deviceUserId, created: res.details?.['created'] ?? null };
      });
      return { result: out };
    } catch (err) {
      await failState(ctx, device, desired.deviceUserId, prep.employee.id, err, false);
      await handleProviderFailure(ctx, device, built.accountKey, err);
      throw err;
    } finally {
      built.dispose();
    }
  });
}

/**
 * DELETE_EMPLOYEE: removes the employee (or a device-only user given by `options.deviceUserId`) from the device. NOT_FOUND from
 * the provider means "already gone" and counts as success. State → REMOVED (desired = false); push devices → REMOVING + commands.
 */
export async function deleteEmployee(ctx: JobContext) {
  const { deps } = ctx;
  return runItem(ctx, async (item, payload) => {
    const now = deps.now();
    const prep = await withContext(deps.db, { kind: 'system', organizationId: payload.organizationId, jobId: ctx.job.id }, async (trx) => {
      const device = await loadDeviceOrThrow(trx, payload.deviceId);
      let deviceUserId = typeof payload.options['deviceUserId'] === 'string' ? payload.options['deviceUserId'] : null;
      if (payload.employeeId) {
        const state = await trx.selectFrom('deviceEmployeeStates').select('deviceUserId').where('deviceId', '=', device.id).where('employeeId', '=', payload.employeeId).executeTakeFirst();
        deviceUserId ??= state?.deviceUserId ?? (await loadIdentity(trx, payload.organizationId, payload.employeeId, device.providerKey))?.deviceUserId ?? null;
        if (!deviceUserId) {
          const emp = await trx.selectFrom('employees').select('deviceUserId').where('organizationId', '=', payload.organizationId).where('id', '=', payload.employeeId).executeTakeFirst();
          deviceUserId = emp?.deviceUserId ?? null;
        }
      }
      if (!deviceUserId) throw new AppError('NOT_FOUND', 'no device user id to delete');
      const built = await prepareDevice(ctx, trx, device.id, 'employeeDelete', 'deleteEmployee', now);
      await upsertState(trx, device, deviceUserId, { employeeId: payload.employeeId, syncStatus: 'REMOVING', desired: false }, now);
      return { device, deviceUserId, built };
    });
    const { device, deviceUserId, built } = prep;
    try {
      let res: DeviceOperationResult;
      try { res = await built.provider.deleteEmployee(built.ctx, deviceUserId); }
      catch (err) { if (!isProviderCode(err, 'NOT_FOUND')) throw err; res = { ok: true, deviceUserId, message: 'not present on device', details: { alreadyRemoved: true } }; }
      if (!res.ok) throw new ProviderError('VENDOR_ERROR', res.message ?? 'device rejected the deletion', { retryable: true });
      const out = await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, async (trx) => {
        await handleProviderSuccess(trx, device, built.accountKey);
        await trx.updateTable('devices').set({ lastEmployeeSyncAt: deps.now(), lastSuccessfulCommunicationAt: deps.now() }).where('id', '=', device.id).execute();
        if (res.async) {
          const commands = await queueDeviceCommands(trx, device, item.id, res);
          return { async: true, commands, deviceUserId };
        }
        await upsertState(trx, device, deviceUserId, { employeeId: payload.employeeId, syncStatus: 'REMOVED', desired: false, deviceHash: null, lastSuccessAt: deps.now(), deviceRecord: null, fingerprintCount: 0, faceEnrolled: false, cardEnrolled: false }, deps.now());
        return { async: false, deviceUserId, alreadyRemoved: res.details?.['alreadyRemoved'] === true };
      });
      return { result: out };
    } catch (err) {
      await failState(ctx, device, deviceUserId, payload.employeeId, err, true);
      await handleProviderFailure(ctx, device, built.accountKey, err);
      throw err;
    } finally {
      built.dispose();
    }
  });
}

interface ResolvedEmployee { id: string; branchId: string; employeeNumber: string; displayName: string; deviceUserId: string; cardNumber: string | null; employmentStatus: string; deletedAt: Date | null; identity: IdentityRow | null }

/** device user ids → employees via employee_provider_identities first, then employees.device_user_id (§E.4 resolution order). */
async function resolveDeviceUsers(trx: Trx, organizationId: string, providerKey: string, deviceUserIds: string[]): Promise<Map<string, ResolvedEmployee>> {
  const out = new Map<string, ResolvedEmployee>();
  if (deviceUserIds.length === 0) return out;
  const cols = ['id', 'branchId', 'employeeNumber', 'displayName', 'deviceUserId', 'cardNumber', 'employmentStatus', 'deletedAt'] as const;
  const identities = await trx.selectFrom('employeeProviderIdentities as i').innerJoin('employees as e', 'e.id', 'i.employeeId')
    .select(['i.deviceUserId as identityUserId', 'i.cardNumber as identityCard', 'e.id', 'e.branchId', 'e.employeeNumber', 'e.displayName', 'e.deviceUserId', 'e.cardNumber', 'e.employmentStatus', 'e.deletedAt'])
    .where('i.organizationId', '=', organizationId).where('i.providerKey', '=', providerKey).where('i.deviceUserId', 'in', deviceUserIds).where('e.deletedAt', 'is', null).execute();
  for (const r of identities) out.set(r.identityUserId, { id: r.id, branchId: r.branchId, employeeNumber: r.employeeNumber, displayName: r.displayName, deviceUserId: r.deviceUserId, cardNumber: r.cardNumber, employmentStatus: r.employmentStatus, deletedAt: r.deletedAt, identity: { deviceUserId: r.identityUserId, cardNumber: r.identityCard } });
  const remaining = deviceUserIds.filter((id) => !out.has(id));
  if (remaining.length > 0) {
    const emps = await trx.selectFrom('employees').select([...cols]).where('organizationId', '=', organizationId).where('deletedAt', 'is', null).where('deviceUserId', 'in', remaining).execute();
    for (const e of emps) if (!out.has(e.deviceUserId)) out.set(e.deviceUserId, { ...e, identity: null });
  }
  return out;
}

const numberOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/**
 * PULL_EMPLOYEES: pages through the device's user list and reconciles `device_employee_states`: known users get the device hash
 * (IN_SYNC / OUT_OF_SYNC vs the cloud hash), unknown users become device-only rows (employee_id null, desired false).
 * Push devices report users asynchronously → the QUERY_USERS command is queued and the item completes with `{ async: true }`.
 */
export async function pullEmployees(ctx: JobContext) {
  const { deps } = ctx;
  return runItem(ctx, async (item, payload) => {
    const now = deps.now();
    const built = await withContext(deps.db, { kind: 'system', organizationId: payload.organizationId, jobId: ctx.job.id }, (trx) => prepareDevice(ctx, trx, payload.deviceId, 'employeePull', 'listEmployees', now));
    const { device } = built;
    const ascii = deviceWantsAscii(device);
    const totals = { listed: 0, known: 0, unknown: 0, inSync: 0, outOfSync: 0, pages: 0 };
    try {
      let page: string | null = null;
      for (let i = 0; i < MAX_LIST_PAGES; i++) {
        let res;
        try { res = await built.provider.listEmployees(built.ctx, page); }
        catch (err) {
          if (isProviderCode(err, 'UNSUPPORTED') && (err as ProviderError).details?.['async'] === true) {
            const commands = await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, (trx) => queueDeviceCommands(trx, device, item.id, { ok: true, async: true, details: (err as ProviderError).details }));
            return { result: { async: true, commands, ...totals } };
          }
          throw err;
        }
        const employees = res.employees;
        await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, async (trx) => {
          const resolved = await resolveDeviceUsers(trx, device.organizationId, device.providerKey, employees.map((e) => e.deviceUserId));
          // existing state rows for this page in one query (by device user id or by resolved employee) — no per-user lookup
          const knownEmployeeIds = [...resolved.values()].map((e) => e.id);
          const existingRows = employees.length > 0 ? await trx.selectFrom('deviceEmployeeStates').select(['deviceUserId', 'employeeId']).where('deviceId', '=', device.id)
            .where((eb) => eb.or([eb('deviceUserId', 'in', employees.map((e) => e.deviceUserId)), ...(knownEmployeeIds.length > 0 ? [eb('employeeId', 'in', knownEmployeeIds)] : [])])).execute() : [];
          const existingByUser = new Set(existingRows.map((r) => r.deviceUserId));
          const existingByEmployee = new Set(existingRows.map((r) => r.employeeId).filter((id): id is string => id !== null));
          const at = deps.now();
          for (const de of employees) {
            const deviceHash = hashDeviceEmployee(de);
            const emp = resolved.get(de.deviceUserId);
            const record = { deviceUserId: de.deviceUserId, name: de.name, cardNumber: de.cardNumber ?? null, privilege: de.privilege ?? 'user', enabled: de.enabled ?? true };
            const enrolment = { fingerprintCount: numberOf(de.extra?.['fingerprintCount']), faceEnrolled: de.extra?.['faceEnrolled'] === true, cardEnrolled: !!de.cardNumber };
            if (emp) {
              const cloudHash = hashDeviceEmployee(buildDeviceEmployee(emp, emp.identity, { ascii }));
              const inSync = cloudHash === deviceHash;
              // desired is only defaulted for rows we create (same branch + eligible); existing rows keep the decision made by push/delete
              const existing = existingByUser.has(de.deviceUserId) || existingByEmployee.has(emp.id);
              const desired = existing ? undefined : emp.branchId === device.branchId && isEligible(emp);
              await upsertState(trx, device, de.deviceUserId, { employeeId: emp.id, cloudHash, deviceHash, syncStatus: inSync ? 'IN_SYNC' : 'OUT_OF_SYNC', ...(desired === undefined ? {} : { desired }), lastSuccessAt: at, deviceRecord: record, ...enrolment }, at);
              totals.known++; if (inSync) totals.inSync++; else totals.outOfSync++;
            } else {
              await upsertState(trx, device, de.deviceUserId, { employeeId: null, deviceHash, syncStatus: 'OUT_OF_SYNC', desired: false, deviceRecord: record, ...enrolment }, at);
              totals.unknown++;
            }
          }
        });
        totals.listed += employees.length;
        totals.pages++;
        page = res.nextCursor;
        if (page === null) break;
        ctx.signal.throwIfAborted();
      }
      await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, async (trx) => {
        await handleProviderSuccess(trx, device, built.accountKey);
        await trx.updateTable('devices').set({ lastEmployeeSyncAt: deps.now(), lastSuccessfulCommunicationAt: deps.now() }).where('id', '=', device.id).execute();
        await trx.insertInto('deviceLogs').values({ organizationId: device.organizationId, deviceId: device.id, level: 'info', event: 'employees_pulled', jobId: item.syncJobId, message: `${totals.listed} users listed (${totals.unknown} unknown, ${totals.outOfSync} out of sync)`, details: JSON.stringify(totals) }).execute();
      });
      return { result: { async: false, ...totals } };
    } catch (err) {
      await handleProviderFailure(ctx, device, built.accountKey, err);
      throw err;
    } finally {
      built.dispose();
    }
  });
}

function ids(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : null;
}

/**
 * PUSH_EMPLOYEES fan-out (§F.2): one sync job → one PUSH_EMPLOYEE item per (employee, device). Accepts the API's
 * `{ scope: { employeeIds?, deviceIds?, branchId? }, trigger, requestedBy }` payload (the sync job is created here when the API
 * did not create one) as well as `{ syncJobId, employeeIds, deviceIds }`. Devices default to the active devices of each
 * employee's branch that can receive employees.
 */
export async function pushEmployees(ctx: JobContext) {
  const { deps, log, job } = ctx;
  const organizationId = typeof job.payload['organizationId'] === 'string' ? job.payload['organizationId'] : job.organizationId;
  if (!organizationId) throw new AppError('VALIDATION_ERROR', 'PUSH_EMPLOYEES requires organizationId');
  const scope = job.payload['scope'] && typeof job.payload['scope'] === 'object' ? (job.payload['scope'] as Record<string, unknown>) : {};
  const employeeIds = ids(job.payload['employeeIds']) ?? ids(scope['employeeIds']);
  const deviceIds = ids(job.payload['deviceIds']) ?? ids(scope['deviceIds']);
  const branchId = typeof scope['branchId'] === 'string' ? scope['branchId'] : null;
  const options = job.payload['options'] && typeof job.payload['options'] === 'object' ? (job.payload['options'] as Record<string, unknown>) : {};
  const trigger: SyncTrigger = (SYNC_TRIGGERS as readonly string[]).includes(String(job.payload['trigger'])) ? (job.payload['trigger'] as SyncTrigger) : 'SYSTEM';
  const requestedBy = typeof job.payload['requestedBy'] === 'string' ? job.payload['requestedBy'] : null;
  return withContext(deps.db, { kind: 'system', organizationId, jobId: job.id }, async (trx) => {
    let syncJobId = typeof job.payload['syncJobId'] === 'string' ? job.payload['syncJobId'] : null;
    let correlationId = job.correlationId ?? newCorrelationId('sync');
    let priority = job.priority;
    if (syncJobId) {
      const existing = await trx.selectFrom('syncJobs').select(['id', 'correlationId', 'priority', 'status']).where('id', '=', syncJobId).executeTakeFirst();
      if (!existing) throw new AppError('NOT_FOUND', `sync job ${syncJobId} not found`, { retryable: false });
      if (existing.status === 'CANCELLED') return { syncJobId, skipped: 'cancelled' };
      correlationId = existing.correlationId; priority = existing.priority;
    } else {
      const created = await trx.insertInto('syncJobs').values({ organizationId, jobType: 'PUSH_EMPLOYEES', trigger, scope: JSON.stringify({ employeeIds, deviceIds, branchId }), branchId, status: 'PENDING', priority: priority ?? DEFAULT_PRIORITY[trigger] ?? 5, requestedBy, correlationId }).returning('id').executeTakeFirstOrThrow();
      syncJobId = created.id;
    }
    let empQ = trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', organizationId).where('deletedAt', 'is', null).where('employmentStatus', 'in', [...ELIGIBLE_EMPLOYMENT]);
    if (employeeIds) empQ = empQ.where('id', 'in', employeeIds.length > 0 ? employeeIds : ['00000000-0000-0000-0000-000000000000']);
    if (branchId) empQ = empQ.where('branchId', '=', branchId);
    const employees = await empQ.execute();
    let devQ = trx.selectFrom('devices').select(['id', 'branchId', 'providerKey', 'capabilities']).where('organizationId', '=', organizationId).where('status', '=', 'active');
    if (deviceIds) devQ = devQ.where('id', 'in', deviceIds.length > 0 ? deviceIds : ['00000000-0000-0000-0000-000000000000']);
    const devices = (await devQ.execute()).filter((d) => { const p = deps.providers.tryGet(d.providerKey); return p ? capabilitiesOf(d, p).employeePush : false; });
    const existingItems = await trx.selectFrom('syncJobItems').select(['deviceId', 'employeeId']).where('syncJobId', '=', syncJobId).execute();
    const have = new Set(existingItems.map((i) => `${i.deviceId}:${i.employeeId}`));
    const items: Array<{ deviceId: string; employeeId: string; operation: SyncJobType; branchId: string | null }> = [];
    for (const e of employees) {
      const targets = deviceIds ? devices : devices.filter((d) => d.branchId === e.branchId);
      for (const d of targets) if (!have.has(`${d.id}:${e.id}`)) items.push({ deviceId: d.id, employeeId: e.id, operation: 'PUSH_EMPLOYEE', branchId: d.branchId });
    }
    const added = await addSyncJobItems(trx, deps.queue, { organizationId, syncJobId, items, priority: priority ?? 5, correlationId, options });
    const total = existingItems.length + items.length;
    if (total === 0 || (existingItems.length === 0 && added.queued === 0)) {
      await trx.updateTable('syncJobs').set({ status: 'SUCCESS', queuedAt: deps.now(), finishedAt: deps.now(), summary: JSON.stringify({ employees: employees.length, devices: devices.length, items: total, skipped: added.skipped }) }).where('id', '=', syncJobId).where('status', 'in', ['PENDING', 'QUEUED']).execute();
    }
    log.info(event('push_employees_fanned_out', { syncJobId, employees: employees.length, devices: devices.length, items: items.length, queued: added.queued, skipped: added.skipped }));
    return { syncJobId, employees: employees.length, devices: devices.length, items: items.length, queued: added.queued, skipped: added.skipped };
  });
}

/**
 * RECONCILIATION per device (§F.5): expected employees (active employees of the device's branch + explicitly desired states) vs
 * `device_employee_states` → device-only users, missing on device, hash mismatches, unmatched raw punches and duplicate provider
 * transaction ids in the last 7 days. The per-device summary is merged into `sync_jobs.summary.devices[deviceId]`; with
 * `options.repair` a child PUSH_EMPLOYEES job carries the PUSH_EMPLOYEE / DELETE_EMPLOYEE items.
 */
export async function reconciliation(ctx: JobContext) {
  const { deps } = ctx;
  return runItem(ctx, async (item, payload) => {
    const repair = payload.options['repair'] === true;
    return withContext(deps.db, { kind: 'system', organizationId: payload.organizationId, jobId: ctx.job.id }, async (trx) => {
      const device = await loadDeviceOrThrow(trx, payload.deviceId);
      const now = deps.now();
      const states = await trx.selectFrom('deviceEmployeeStates').select(['employeeId', 'deviceUserId', 'syncStatus', 'cloudHash', 'deviceHash', 'desired']).where('deviceId', '=', device.id).execute();
      const byEmployee = new Map(states.filter((s) => s.employeeId).map((s) => [s.employeeId as string, s]));
      const branchEmployees = await trx.selectFrom('employees').select(['id', 'employeeNumber', 'deviceUserId']).where('organizationId', '=', device.organizationId).where('branchId', '=', device.branchId).where('deletedAt', 'is', null).where('employmentStatus', 'in', [...ELIGIBLE_EMPLOYMENT]).execute();
      const explicitIds = states.filter((s) => s.employeeId && s.desired && !branchEmployees.some((e) => e.id === s.employeeId)).map((s) => s.employeeId as string);
      const explicit = explicitIds.length > 0 ? await trx.selectFrom('employees').select(['id', 'employeeNumber', 'deviceUserId']).where('id', 'in', explicitIds).where('deletedAt', 'is', null).where('employmentStatus', 'in', [...ELIGIBLE_EMPLOYMENT]).execute() : [];
      const expected = [...branchEmployees, ...explicit];
      const expectedIds = new Set(expected.map((e) => e.id));
      const deviceOnly = states.filter((s) => !s.employeeId && s.syncStatus !== 'REMOVED' && s.syncStatus !== 'REMOVING').map((s) => ({ deviceUserId: s.deviceUserId }));
      const notOnDevice = new Set<DeviceEmployeeSyncStatus>(['REMOVED', 'REMOVING', 'PENDING', 'FAILED', 'OFFLINE', 'UNSUPPORTED']);
      const missingOnDevice = expected.filter((e) => { const s = byEmployee.get(e.id); return !s || notOnDevice.has(s.syncStatus); }).map((e) => ({ employeeId: e.id, employeeNumber: e.employeeNumber }));
      const differing = states.filter((s) => s.employeeId && expectedIds.has(s.employeeId) && (s.syncStatus === 'OUT_OF_SYNC' || (s.cloudHash && s.deviceHash && s.cloudHash !== s.deviceHash))).map((s) => ({ employeeId: s.employeeId as string, deviceUserId: s.deviceUserId }));
      const stale = states.filter((s) => s.employeeId && !expectedIds.has(s.employeeId) && s.syncStatus !== 'REMOVED' && s.syncStatus !== 'REMOVING').map((s) => ({ employeeId: s.employeeId as string, deviceUserId: s.deviceUserId }));
      const unmatched = await trx.selectFrom('attendanceRawTransactions').select((eb) => eb.fn.countAll<string>().as('n')).where('deviceId', '=', device.id).where('processingStatus', '=', 'unmatched').executeTakeFirst();
      const dupes = await sql<{ n: string }>`select count(*) as n from (select provider_transaction_id from public.attendance_raw_transactions where organization_id = ${device.organizationId}::uuid and device_id = ${device.id}::uuid and provider_transaction_id is not null and punched_at > ${new Date(now.getTime() - 7 * 86_400_000)} group by provider_transaction_id having count(*) > 1) d`.execute(trx);
      const summary: Record<string, unknown> = {
        deviceId: device.id, deviceCode: device.code, computedAt: now.toISOString(), expected: expected.length, onDevice: states.filter((s) => s.employeeId && !notOnDevice.has(s.syncStatus)).length,
        deviceOnly: deviceOnly.slice(0, 500), deviceOnlyCount: deviceOnly.length, missingOnDevice: missingOnDevice.slice(0, 500), missingOnDeviceCount: missingOnDevice.length,
        differing: differing.slice(0, 500), differingCount: differing.length, stale: stale.slice(0, 500), staleCount: stale.length,
        unmatchedRaw: Number(unmatched?.n ?? 0), duplicateTransactions: Number(dupes.rows[0]?.n ?? 0),
      };
      if (repair && (missingOnDevice.length + differing.length + deviceOnly.length + stale.length > 0)) {
        const child = await createSyncJob(trx, deps.queue, {
          organizationId: device.organizationId, jobType: 'PUSH_EMPLOYEES', trigger: 'SYSTEM', parentJobId: item.syncJobId, scope: { reconciliationJobId: item.syncJobId, deviceId: device.id, repair: true }, branchId: device.branchId, correlationId: `${ctx.job.correlationId ?? item.syncJobId}:repair`,
          items: [
            ...[...missingOnDevice, ...differing].map((m) => ({ deviceId: device.id, employeeId: m.employeeId, operation: 'PUSH_EMPLOYEE' as const, options: { force: true } })),
            ...deviceOnly.map((d) => ({ deviceId: device.id, employeeId: null, operation: 'DELETE_EMPLOYEE' as const, options: { deviceUserId: d.deviceUserId } })),
            ...stale.map((s) => ({ deviceId: device.id, employeeId: s.employeeId, operation: 'DELETE_EMPLOYEE' as const, options: { deviceUserId: s.deviceUserId } })),
          ],
        });
        summary['repairJobId'] = child.syncJobId;
        summary['repairItems'] = child.itemIds.length;
      }
      await sql`update public.sync_jobs set summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('devices', coalesce(summary -> 'devices', '{}'::jsonb) || jsonb_build_object(${device.id}::text, ${JSON.stringify(summary)}::jsonb)) where id = ${item.syncJobId}::uuid`.execute(trx);
      return { result: summary };
    });
  });
}
