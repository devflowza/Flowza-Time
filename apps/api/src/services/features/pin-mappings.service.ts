import { sql } from 'kysely';
import {
  DEFAULT_DEVICE_USER_ID_RE, UNMATCHED_ASSIGN_BLOCKED_PROVIDERS, unmatchedAssignBlockedReason,
  type CreatePinMappingInput, type DeviceEmployeeSyncStatus, type EmploymentStatus, type PinMappingDto, type PinMappingListQuery, type PinMappingResultDto,
  type PinMappingScope, type PinUnmapResultDto, type UnmatchedAssignBlockedReason,
} from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors, type AppError } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { enqueueJob } from '../../lib/jobs.js';
import { isoDateTime, isoDateTimeOrNull } from '../../lib/mappers.js';
import { likeContains, pageOf, toCount } from '../../lib/pagination.js';
import { type Actor, audit, runUser } from '../../lib/service.js';
import { maybeEnqueuePush } from '../employees.service.js';
import { systemStep } from './context.js';

/**
 * PIN mapping (Devices & punches → PIN mapping, Unmapped punches → Assign, the device's Employees tab, the employee's Devices
 * tab): which employee the device user id a terminal reports with every punch belongs to. The normaliser resolves a punch
 * through (1) the device's `device_employee_states` row, (2) the provider identity, (3) `employees.device_user_id`
 * (apps/worker/src/handlers/attendance/normalize.ts) — this module writes (1) as a *device* mapping (marked `mapped_at`, so the
 * sync engine keeps it) and (3) as the employee's *default* mapping, then hands the PIN's unmatched punches back to the
 * normaliser in the same transaction. Punches already attributed are never moved (raw and events are append-only).
 *
 * Devices whose punches never go through those maps (the Flowza Finance connector: employee number; the self-service device:
 * the member's linked employee) refuse device mappings — the same rule as the unmatched-punch Assign.
 */

const BLOCKED_MESSAGES: Record<UnmatchedAssignBlockedReason, string> = {
  CONNECTOR_RESOLVES_BY_EMPLOYEE_NUMBER: 'Punches from the Flowza Finance connector are matched by employee number, not by a PIN mapping: fix the employee number in FlowZa Time or in Flowza Finance.',
  SELF_SERVICE_RESOLVES_BY_MEMBERSHIP: "Self-service punches are matched to the member's linked employee record, not by a PIN mapping.",
};
const BLOCKED_PROVIDERS = Object.keys(UNMATCHED_ASSIGN_BLOCKED_PROVIDERS);

interface DeviceRef { id: string; name: string; code: string; branchId: string | null; providerKey: string }
interface EmployeeRef { id: string; branchId: string; displayName: string; employeeNumber: string; deviceUserId: string; deletedAt: Date | null }

// ---- list ----------------------------------------------------------------------------------------------------------------

interface MappingRow {
  scope: PinMappingScope; rowId: string; deviceId: string | null; deviceName: string | null; deviceCode: string | null; deviceSerial: string | null; providerKey: string | null;
  deviceUserId: string; employeeId: string; employeeName: string; employeeNumber: string; employmentStatus: EmploymentStatus; branchId: string | null;
  syncStatus: DeviceEmployeeSyncStatus | null; desired: boolean | null; mappedAt: Date | null; updatedAt: Date;
}

/**
 * GET /pin-mappings — device mappings (every device state row linked to an employee: what the normaliser reads first) and the
 * employees' default device user ids, in PIN order (numeric PINs numerically). Reads run under the caller's RLS: device rows
 * need device.view, names and defaults employee.view — both are required.
 */
export async function listPinMappings(deps: ApiDeps, actor: Actor, orgId: string, q: PinMappingListQuery): Promise<{ data: PinMappingDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'device.view', 'employee.view');
  const branches = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const scope = q.deviceId ? 'device' : q.scope ?? null;
    const like = q.search ? likeContains(q.search) : null;
    const inner = sql`
      select 'device'::text as scope, s.id::text as "rowId", s.device_id as "deviceId", d.name as "deviceName", d.code as "deviceCode", d.serial_number as "deviceSerial",
        d.provider_key as "providerKey", s.device_user_id as "deviceUserId", e.id as "employeeId", e.display_name as "employeeName", e.employee_number::text as "employeeNumber",
        e.employment_status::text as "employmentStatus", d.branch_id as "branchId", s.sync_status::text as "syncStatus", s.desired, s.mapped_at as "mappedAt", s.updated_at as "updatedAt"
      from public.device_employee_states s
        join public.devices d on d.id = s.device_id and d.organization_id = s.organization_id
        join public.employees e on e.id = s.employee_id and e.organization_id = s.organization_id
      where s.organization_id = ${orgId}::uuid and s.employee_id is not null and d.provider_key <> all(${BLOCKED_PROVIDERS}::text[])
      union all
      select 'default'::text, e.id::text, null::uuid, null::text, null::text, null::text, null::text, e.device_user_id, e.id, e.display_name, e.employee_number::text,
        e.employment_status::text, e.branch_id, null::text, null::boolean, null::timestamptz, e.updated_at
      from public.employees e
      where e.organization_id = ${orgId}::uuid and e.deleted_at is null`;
    const where = sql`(${scope}::text is null or m.scope = ${scope}::text)
      and (${q.deviceId ?? null}::uuid is null or m."deviceId" = ${q.deviceId ?? null}::uuid)
      and (${q.employeeId ?? null}::uuid is null or m."employeeId" = ${q.employeeId ?? null}::uuid)
      and (${branches}::uuid[] is null or m."branchId" = any(${branches}::uuid[]))
      and (${like}::text is null or m."deviceUserId" ilike ${like}::text or m."employeeName" ilike ${like}::text or m."employeeNumber" ilike ${like}::text)`;
    const total = toCount((await sql<{ n: string }>`select count(*) as n from (${inner}) m where ${where}`.execute(trx)).rows[0]?.n);
    const page = pageOf(q);
    const rows = (await sql<MappingRow>`
      select * from (${inner}) m where ${where}
      order by case when m."deviceUserId" ~ '^[0-9]{1,18}$' then m."deviceUserId"::numeric end nulls last, m."deviceUserId", m.scope desc, m."deviceName", m."employeeName"
      limit ${page.pageSize} offset ${page.offset}`.execute(trx)).rows;
    return {
      data: rows.map((r): PinMappingDto => ({
        id: `${r.scope}:${r.rowId}`, scope: r.scope, stateId: r.scope === 'device' ? r.rowId : null, deviceUserId: r.deviceUserId,
        deviceId: r.deviceId, deviceName: r.deviceName, deviceCode: r.deviceCode, deviceSerial: r.deviceSerial, providerKey: r.providerKey,
        employeeId: r.employeeId, employeeName: r.employeeName, employeeNumber: r.employeeNumber, employmentStatus: r.employmentStatus, branchId: r.branchId,
        syncStatus: r.syncStatus, desired: r.desired, manual: r.mappedAt !== null, mappedAt: isoDateTimeOrNull(r.mappedAt), updatedAt: isoDateTime(r.updatedAt),
      })),
      total,
    };
  });
}

// ---- shared ----------------------------------------------------------------------------------------------------------------

async function loadDevice(trx: Trx, orgId: string, grant: MembershipGrant, deviceId: string): Promise<DeviceRef> {
  const d = await trx.selectFrom('devices').select(['id', 'name', 'code', 'branchId', 'providerKey']).where('organizationId', '=', orgId).where('id', '=', deviceId).executeTakeFirst();
  if (!d || (!grant.allBranches && (d.branchId === null || !grant.branchIds.includes(d.branchId)))) throw errors.notFound('Device', deviceId);
  return d;
}

async function loadEmployee(trx: Trx, orgId: string, grant: MembershipGrant, employeeId: string): Promise<EmployeeRef> {
  const e = await trx.selectFrom('employees').select(['id', 'branchId', 'displayName', 'employeeNumber', 'deviceUserId', 'deletedAt']).where('organizationId', '=', orgId).where('id', '=', employeeId).executeTakeFirst();
  if (!e || e.deletedAt) throw errors.validation('Employee not found.', { issues: [{ path: 'employeeId', message: 'Unknown employee' }] });
  requireBranchAccess(grant, e.branchId);
  return { ...e, employeeNumber: String(e.employeeNumber) };
}

/** Unmatched punches of `pin` on `deviceIds` → pending, plus one (deduplicated) normaliser run. Call in the organisation's system scope. */
async function requeueUnmatched(deps: ApiDeps, t: Trx, actor: Actor, orgId: string, deviceIds: string[], pin: string): Promise<{ rows: number; jobId: string | null }> {
  if (deviceIds.length === 0) return { rows: 0, jobId: null };
  const moved = await sql`update public.attendance_raw_transactions set processing_status = 'pending', processing_error = null, processed_at = null
    where organization_id = ${orgId}::uuid and device_id = any(${deviceIds}::uuid[]) and device_employee_id = ${pin} and processing_status = 'unmatched'`.execute(t);
  const rows = Number(moved.numAffectedRows ?? 0n);
  if (rows === 0) return { rows, jobId: null };
  const jobId = await enqueueJob(deps.queue, t, { queue: 'processing', jobType: 'NORMALIZE_RAW', organizationId: orgId, payload: { organizationId: orgId }, dedupeKey: `normalize:${orgId}`, correlationId: actor.requestId, priority: 6 });
  return { rows, jobId };
}

function conflict(reason: 'PIN_TAKEN' | 'EMPLOYEE_MAPPED', message: string, details: Record<string, unknown>): AppError {
  return errors.conflict(message, { reason, ...details });
}

// ---- device mapping ------------------------------------------------------------------------------------------------------------

export interface DeviceMappingOutcome { changed: boolean; created: boolean; releasedDeviceUserId: string | null; replacedEmployeeId: string | null }

/**
 * Maps `pin` to the employee on the device (organisation system scope; the caller was authorised for both). The (device, PIN)
 * row gains the employee and `mapped_at` — a device-only row keeps its device record and sync state; a new row starts PENDING
 * (IN_SYNC when the device already reported punches under the PIN: the user is on it). A PIN mapped to someone else, or an
 * employee mapped to another PIN on the device, is a conflict unless `replace`: then that employee / PIN is released first
 * (a released row the device never reported is deleted; one it did report stays as a device-only user).
 */
export async function mapDevicePin(t: Trx, orgId: string, actor: Actor, device: Pick<DeviceRef, 'id' | 'branchId'>, employeeId: string, pin: string, replace: boolean): Promise<DeviceMappingOutcome> {
  const rows = await t.selectFrom('deviceEmployeeStates').select(['id', 'employeeId', 'deviceUserId', 'mappedAt', 'deviceRecord'])
    .where('organizationId', '=', orgId).where('deviceId', '=', device.id)
    .where((eb) => eb.or([eb('deviceUserId', '=', pin), eb('employeeId', '=', employeeId)])).forUpdate().execute();
  const byUser = rows.find((r) => r.deviceUserId === pin);
  const byEmployee = rows.find((r) => r.employeeId === employeeId);
  const now = new Date();
  if (byUser && byUser.employeeId === employeeId) {
    if (byUser.mappedAt) return { changed: false, created: false, releasedDeviceUserId: null, replacedEmployeeId: null };
    await t.updateTable('deviceEmployeeStates').set({ mappedAt: now, mappedBy: actor.userId, desired: true }).where('id', '=', byUser.id).execute();
    return { changed: true, created: false, releasedDeviceUserId: null, replacedEmployeeId: null };
  }
  if (byUser?.employeeId && !replace) throw conflict('PIN_TAKEN', 'This PIN is already mapped to another employee on the device.', { employeeId: byUser.employeeId, deviceUserId: pin });
  if (byEmployee && !replace) throw conflict('EMPLOYEE_MAPPED', `The employee is already mapped to PIN ${byEmployee.deviceUserId} on this device.`, { employeeId, deviceUserId: byEmployee.deviceUserId });
  let releasedDeviceUserId: string | null = null;
  if (byEmployee) {
    releasedDeviceUserId = byEmployee.deviceUserId;
    if (byEmployee.deviceRecord === null) await t.deleteFrom('deviceEmployeeStates').where('id', '=', byEmployee.id).execute();
    else await t.updateTable('deviceEmployeeStates').set({ employeeId: null, mappedAt: null, mappedBy: null, desired: false }).where('id', '=', byEmployee.id).execute();
  }
  const replacedEmployeeId = byUser?.employeeId ?? null;
  if (byUser) {
    await t.updateTable('deviceEmployeeStates').set({ employeeId, desired: true, mappedAt: now, mappedBy: actor.userId }).where('id', '=', byUser.id).execute();
    return { changed: true, created: false, releasedDeviceUserId, replacedEmployeeId };
  }
  const seen = await t.selectFrom('attendanceRawTransactions').select('id').where('organizationId', '=', orgId).where('deviceId', '=', device.id).where('deviceEmployeeId', '=', pin).limit(1).executeTakeFirst();
  await t.insertInto('deviceEmployeeStates').values({
    organizationId: orgId, deviceId: device.id, branchId: device.branchId, deviceUserId: pin, employeeId, desired: true,
    syncStatus: seen ? 'IN_SYNC' : 'PENDING', lastSyncAt: seen ? now : null, mappedAt: now, mappedBy: actor.userId,
  }).execute();
  return { changed: true, created: true, releasedDeviceUserId, replacedEmployeeId };
}

// ---- create --------------------------------------------------------------------------------------------------------------------

/**
 * POST /pin-mappings — `deviceId` set: map the PIN to the employee on that device (device.sync); `deviceId` null: make the PIN
 * the employee's default device user id on every device (employee.update; auto-push re-enrols them under it where enabled).
 * Either way the PIN's unmatched punches go back to the normaliser in the same transaction.
 */
export async function createPinMapping(deps: ApiDeps, actor: Actor, orgId: string, input: CreatePinMappingInput): Promise<PinMappingResultDto> {
  return input.deviceId ? createDeviceMapping(deps, actor, orgId, { ...input, deviceId: input.deviceId }) : setDefaultPin(deps, actor, orgId, input);
}

async function createDeviceMapping(deps: ApiDeps, actor: Actor, orgId: string, input: CreatePinMappingInput & { deviceId: string }): Promise<PinMappingResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.sync');
  const pin = input.deviceUserId;
  return runUser(deps.db, actor, async (trx) => {
    const device = await loadDevice(trx, orgId, grant, input.deviceId);
    const blocked = unmatchedAssignBlockedReason(device.providerKey);
    if (blocked) throw errors.invalidState(BLOCKED_MESSAGES[blocked], { reason: blocked, providerKey: device.providerKey });
    const emp = await loadEmployee(trx, orgId, grant, input.employeeId);
    const res = await systemStep(trx, orgId, async (t) => {
      const outcome = await mapDevicePin(t, orgId, actor, device, emp.id, pin, input.replace === true);
      const requeued = await requeueUnmatched(deps, t, actor, orgId, [device.id], pin);
      return { outcome, requeued };
    });
    if (res.outcome.changed) {
      await audit(trx, actor, orgId, 'device.pin_mapped', 'device_employee_state', {
        entityId: `${device.id}:${pin}`, branchId: device.branchId,
        oldValue: res.outcome.replacedEmployeeId || res.outcome.releasedDeviceUserId ? { employeeId: res.outcome.replacedEmployeeId, employeeDeviceUserId: res.outcome.releasedDeviceUserId } : undefined,
        newValue: { deviceId: device.id, deviceUserId: pin, employeeId: emp.id, created: res.outcome.created, rowsRequeued: res.requeued.rows, jobId: res.requeued.jobId },
      });
    }
    return { scope: 'device', employeeId: emp.id, deviceId: device.id, deviceUserId: pin, changed: res.outcome.changed, previousDeviceUserId: res.outcome.releasedDeviceUserId, rowsRequeued: res.requeued.rows, jobId: res.requeued.jobId };
  });
}

async function setDefaultPin(deps: ApiDeps, actor: Actor, orgId: string, input: CreatePinMappingInput): Promise<PinMappingResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.update');
  const pin = input.deviceUserId;
  if (!DEFAULT_DEVICE_USER_ID_RE.test(pin)) {
    throw errors.validation('A default device ID is 1–32 letters, digits, "-" or "_". Map this PIN on a device instead.', { issues: [{ path: 'deviceUserId', message: 'Letters, digits, - and _ only (max 32)' }] });
  }
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployee(trx, orgId, grant, input.employeeId);
    if (emp.deviceUserId === pin) return { scope: 'default', employeeId: emp.id, deviceId: null, deviceUserId: pin, changed: false, previousDeviceUserId: null, rowsRequeued: 0, jobId: null };
    // the id is unique per organisation across every employee record (deleted ones and other branches included): system scope
    const holder = await systemStep(trx, orgId, (t) => t.selectFrom('employees').select(['id', 'displayName', 'deletedAt']).where('organizationId', '=', orgId).where('deviceUserId', '=', pin).where('id', '<>', emp.id).executeTakeFirst());
    if (holder) {
      throw conflict('PIN_TAKEN', holder.deletedAt
        ? `PIN ${pin} is the device ID of a deleted employee record (${holder.displayName}); map it on a device instead.`
        : `PIN ${pin} is already the default device ID of ${holder.displayName}. Change theirs first, or map the PIN on a device.`, { employeeId: holder.id, deviceUserId: pin });
    }
    // the write itself runs as the caller: RLS checks employee.update and the branch again
    await trx.updateTable('employees').set({ deviceUserId: pin, updatedBy: actor.userId }).where('organizationId', '=', orgId).where('id', '=', emp.id).execute();
    const res = await systemStep(trx, orgId, async (t) => {
      // re-queue on the devices the caller may see whose punches resolve through device user ids
      let devices = t.selectFrom('devices').select('id').where('organizationId', '=', orgId).where('providerKey', 'not in', BLOCKED_PROVIDERS);
      if (!grant.allBranches) devices = devices.where('branchId', 'in', grant.branchIds.length > 0 ? grant.branchIds : ['00000000-0000-0000-0000-000000000000']);
      const deviceIds = (await devices.execute()).map((d) => d.id);
      return requeueUnmatched(deps, t, actor, orgId, deviceIds, pin);
    });
    await audit(trx, actor, orgId, 'employee.updated', 'employee', { entityId: emp.id, branchId: emp.branchId, oldValue: { deviceUserId: emp.deviceUserId }, newValue: { deviceUserId: pin, rowsRequeued: res.rows, jobId: res.jobId }, reason: 'PIN mapping' });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.updated', aggregateType: 'employee', aggregateId: emp.id, payload: { changed: ['deviceUserId'], transition: false, branchId: emp.branchId }, actorUserId: actor.userId, requestId: actor.requestId });
    await maybeEnqueuePush(deps, trx, actor, orgId, [emp.id]);
    return { scope: 'default', employeeId: emp.id, deviceId: null, deviceUserId: pin, changed: true, previousDeviceUserId: emp.deviceUserId, rowsRequeued: res.rows, jobId: res.jobId };
  });
}

// ---- delete --------------------------------------------------------------------------------------------------------------------

/**
 * DELETE /pin-mappings/:stateId — the PIN no longer belongs to the employee on that device: new punches under it become unmatched
 * (unless the employee's default id or a provider identity still matches). A row the device never reported is deleted; one it
 * did stays as a device-only user. Punches already attributed stay attributed (fix them with corrections).
 */
export async function deletePinMapping(deps: ApiDeps, actor: Actor, orgId: string, stateId: string): Promise<PinUnmapResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.sync');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stateId)) throw errors.notFound('PIN mapping', stateId);
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.selectFrom('deviceEmployeeStates').select(['id', 'deviceId', 'deviceUserId', 'employeeId', 'deviceRecord', 'mappedAt']).where('organizationId', '=', orgId).where('id', '=', stateId).executeTakeFirst();
    if (!row || !row.employeeId) throw errors.notFound('PIN mapping', stateId);
    const device = await loadDevice(trx, orgId, grant, row.deviceId);
    const employeeId = row.employeeId;
    const removed = row.deviceRecord === null;
    // as the caller: RLS checks device.sync and the device's branch again
    if (removed) await trx.deleteFrom('deviceEmployeeStates').where('organizationId', '=', orgId).where('id', '=', row.id).execute();
    else await trx.updateTable('deviceEmployeeStates').set({ employeeId: null, mappedAt: null, mappedBy: null, desired: false }).where('organizationId', '=', orgId).where('id', '=', row.id).execute();
    await audit(trx, actor, orgId, 'device.pin_unmapped', 'device_employee_state', {
      entityId: `${device.id}:${row.deviceUserId}`, branchId: device.branchId,
      oldValue: { deviceId: device.id, deviceUserId: row.deviceUserId, employeeId, manual: row.mappedAt !== null }, newValue: { employeeId: null, rowDeleted: removed },
    });
    return { stateId: row.id, deviceId: device.id, deviceUserId: row.deviceUserId, employeeId, removed };
  });
}
