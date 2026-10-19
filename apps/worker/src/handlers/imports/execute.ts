import { sql } from 'kysely';
import { z } from 'zod';
import { FLOWZA_FINANCE_PROVIDER_KEY, SELF_SERVICE_PROVIDER_KEY, SYSTEM_ROLE_IDS, uuidSchema, type EmployeeDto } from '@flowza/contracts';
import { createSyncJob, emitDomainEvent, withContext, writeAudit, type AuditEntry, type Trx } from '@flowza/database';
import { AppError, errors, event } from '@flowza/shared';
import { DateTime } from 'luxon';
import { isLockLost, type JobContext } from '../types.js';
import { asObject, isoDate, parsePayload } from '../attendance/common.js';
import { enqueueRecalculationForScope } from '../attendance/recalculate.js';
import { classify } from '../../runner.js';

/*
 * EXECUTE_IMPORT — applies the VALID rows of an import job (docs/integrations/hrms.md §4). The job comes from the import page
 * (`source = upload`, confirmed by a person) or from an HR system batch (`source = hrms`, queued with the batch). The API
 * validated every row against the organisation when the import was created; here each row is applied in the organisation's
 * SYSTEM context (one organisation, AGENTS.md rule 1), re-checking what may have changed since (an employee number taken in
 * the meantime, the user limit, a manager link that would close a loop).
 *
 *  - EMPLOYEES: a row with `existingEmployeeId` updates that employee (only the fields the row carries); any other row creates
 *    one (device user id auto-assigned when absent, employment history "Joined", civil ID as an identity document). Managers
 *    named by employee number that are created by the same file are linked in a SECOND pass, once everybody exists. A status
 *    that becomes terminated / resigned ends the employee's logins (offboarding rules) and takes them off every terminal they
 *    are enrolled on (DELETE_EMPLOYEE sync items — AGENTS.md "Termination").
 *  - ORG_UNITS: departments upserted by code; parents linked by code in a second pass, refusing a link that would make a loop.
 *
 * Idempotent: rows are applied in chunks, each chunk in one transaction together with the row's status (`imported` + the
 * entity id, or `failed` + the reason), and a retried job skips the rows that are no longer `valid`. One row failing never
 * fails the others (a savepoint per row). The import ends COMPLETED with a summary (created / updated / failed / …), an
 * audit row and the `employee.imported` notification (for HR system batches only when rows failed: a feed that runs every
 * hour must not notify every hour).
 */

export const executeImportPayloadSchema = z.object({ organizationId: uuidSchema.optional(), importJobId: uuidSchema, requestedBy: uuidSchema.nullable().optional() });
type Payload = z.infer<typeof executeImportPayloadSchema>;

/** Rows per transaction. */
export const IMPORT_CHUNK = 100;
const LEFT: readonly string[] = ['terminated', 'resigned'];
const hasLeft = (s: string | null | undefined) => !!s && LEFT.includes(s);
const NOT_TERMINALS = [SELF_SERVICE_PROVIDER_KEY, FLOWZA_FINANCE_PROVIDER_KEY];

type RowResult = 'created' | 'updated' | 'unchanged';
interface ImportRow { id: string; rowNo: number; data: Record<string, unknown>; status: string; entityId: string | null }
interface ImportJobRow { id: string; type: string; source: string; status: string; requestedBy: string | null; apiKeyId: string | null; keyPrefix: string | null; reference: string | null }

interface RunContext {
  orgId: string;
  importId: string;
  job: ImportJobRow;
  jobId: string;
  today: string;
  /** Who the audit trail names: the person who confirmed the upload, or the HR system's API key. */
  actor: Pick<AuditEntry, 'actorUserId' | 'actorType' | 'actorLabel'>;
  /** Employees to push to terminals at the end (created / changed, not leavers), and leavers taken off them. */
  push: Set<string>;
  recalc: Array<{ employeeId: string; fromDate: string }>;
}

const toNumber = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const has = (d: Record<string, unknown>, k: string) => d[k] !== undefined && d[k] !== null && d[k] !== '';

/** A row's failure as text for the import page / the HRMS status: the rule that refused it, never SQL or a stack. */
export function rowFailureMessage(err: unknown): string {
  if (AppError.is(err)) return err.message.slice(0, 500);
  const e = err as { code?: string; constraint?: string; message?: string };
  if (typeof e?.message === 'string' && e.message.startsWith('reporting line cycle')) return 'The manager already reports to this employee (directly or through other managers): the reporting line would go round in a circle.';
  switch (e?.code) {
    case '23505':
      if (e.constraint?.includes('device_user_id')) return 'Device user id already exists';
      if (e.constraint?.includes('employee_number')) return 'Employee number already exists';
      if (e.constraint?.includes('code')) return 'Code already exists';
      return 'A value that must be unique is already used';
    case '23503': return 'A record this row refers to no longer exists';
    case '23514': return e.constraint === 'employees_exit_after_join' ? 'The exit date is before the joining date' : 'A value breaks a rule of the database';
    case '22P02': case '22007': case '22008': return 'A value has the wrong format';
    default: return 'The row could not be applied (internal error).';
  }
}

async function withSavepoint<T>(trx: Trx, name: string, fn: () => Promise<T>): Promise<T> {
  await sql`savepoint ${sql.raw(name)}`.execute(trx);
  try {
    const out = await fn();
    await sql`release savepoint ${sql.raw(name)}`.execute(trx);
    return out;
  } catch (err) {
    await sql`rollback to savepoint ${sql.raw(name)}`.execute(trx);
    throw err;
  }
}

async function orgToday(trx: Trx, orgId: string): Promise<string> {
  const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst();
  return DateTime.now().setZone(org?.timezone ?? 'UTC').toISODate() ?? DateTime.utc().toISODate()!;
}

/** The user limit the platform set (app.org_user_limits), re-checked in the transaction that adds the user. */
async function assertUserCapacity(trx: Trx, orgId: string, adding = 1): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`flowza:user-limit:${orgId}`}, 0))`.execute(trx);
  const { rows } = await sql<{ used: string | number; userLimit: number | null }>`select used, user_limit as "userLimit" from app.org_user_limits(${[orgId]}::uuid[])`.execute(trx);
  const r = rows[0];
  if (r && r.userLimit !== null && Number(r.used) + adding > r.userLimit) throw errors.userLimit(r.userLimit, Number(r.used), adding);
}

async function nextDeviceUserId(trx: Trx, orgId: string): Promise<string> {
  await sql`select pg_advisory_xact_lock(hashtext(${`${orgId}:device_user_id`}))`.execute(trx);
  const res = await sql<{ next: string }>`select coalesce(max(device_user_id::bigint), 0) + 1 as next from public.employees where organization_id = ${orgId}::uuid and device_user_id ~ '^[0-9]{1,15}$'`.execute(trx);
  return String(res.rows[0]?.next ?? 1);
}

interface Snapshot { branchId: string; departmentId: string | null; designationId: string | null; managerEmployeeId: string | null; employmentType: EmployeeDto['employmentType']; employmentStatus: EmployeeDto['employmentStatus'] }
const SNAPSHOT_KEYS: Array<keyof Snapshot> = ['branchId', 'departmentId', 'designationId', 'managerEmployeeId', 'employmentType', 'employmentStatus'];

/** Effective-dated history, the API's rule (employees.service applyHistoryTransition): a change dated on the open record's own start replaces it. */
async function applyHistoryTransition(trx: Trx, orgId: string, employeeId: string, next: Snapshot, effectiveFrom: string, reason: string, actorUserId: string | null): Promise<void> {
  const current = await trx.selectFrom('employmentHistory').select(['id', 'effectiveFrom']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('effectiveTo', 'is', null).orderBy('effectiveFrom', 'desc').executeTakeFirst();
  if (current) {
    const currentFrom = isoDate(current.effectiveFrom);
    if (effectiveFrom <= currentFrom) {
      await trx.updateTable('employmentHistory').set({ ...next, reason, createdBy: actorUserId }).where('id', '=', current.id).execute();
      return;
    }
    await trx.updateTable('employmentHistory').set({ effectiveTo: effectiveFrom }).where('id', '=', current.id).execute();
  }
  await trx.insertInto('employmentHistory').values({ organizationId: orgId, employeeId, effectiveFrom, effectiveTo: null, ...next, reason, createdBy: actorUserId }).execute();
}

/** The civil ID as the employee's `civil_id` identity document (one per employee: the number is replaced when it changes). */
async function upsertCivilId(trx: Trx, orgId: string, employeeId: string, branchId: string, civilId: string, actorUserId: string | null): Promise<boolean> {
  const doc = await trx.selectFrom('employeeIdentityDocuments').select(['id', 'number']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('type', '=', 'civil_id').orderBy('createdAt', 'desc').executeTakeFirst();
  if (doc?.number === civilId) return false;
  if (doc) await trx.updateTable('employeeIdentityDocuments').set({ number: civilId, branchId }).where('id', '=', doc.id).execute();
  else await trx.insertInto('employeeIdentityDocuments').values({ organizationId: orgId, employeeId, branchId, type: 'civil_id', number: civilId, issuingCountry: 'OM', createdBy: actorUserId }).execute();
  return true;
}

/**
 * B-75 for a leaver set by an import: the logins linked to the record are suspended, their sessions ended and pending
 * invitations revoked — with the member-suspension rules (an owner's login is never ended by an import; nobody ends their own).
 */
async function offboardLogins(trx: Trx, rc: RunContext, employeeId: string, employmentStatus: string): Promise<void> {
  const logins = await trx.selectFrom('orgMemberships').select(['id', 'userId', 'status', 'roleId']).where('organizationId', '=', rc.orgId).where('employeeId', '=', employeeId).where('status', '<>', 'suspended').orderBy('id').execute();
  const invitations = await trx.selectFrom('invitations').select(['id', 'email']).where('organizationId', '=', rc.orgId).where('employeeId', '=', employeeId).where('acceptedAt', 'is', null).where('revokedAt', 'is', null).orderBy('id').execute();
  for (const l of logins) {
    if (l.roleId === SYSTEM_ROLE_IDS.owner) throw errors.invalidState('This employee is linked to an owner\'s login: an import never ends it. Transfer ownership or suspend the member first, then import the change again.');
    if (rc.actor.actorUserId && l.userId === rc.actor.actorUserId) throw errors.invalidState('This employee record is linked to your own login: ending the employment would lock you out. Ask another administrator to import it.');
  }
  if (logins.length) await trx.updateTable('orgMemberships').set({ status: 'suspended' }).where('organizationId', '=', rc.orgId).where('id', 'in', logins.map((l) => l.id)).execute();
  if (invitations.length) await trx.updateTable('invitations').set({ revokedAt: new Date(), revokedBy: rc.actor.actorUserId ?? null, revokeReason: 'employee_left' }).where('organizationId', '=', rc.orgId).where('id', 'in', invitations.map((i) => i.id)).execute();
  const active = logins.filter((l) => l.status === 'active').map((l) => l.userId);
  let sessionsRevoked = 0;
  if (active.length) {
    const { rows } = await sql<{ n: number }>`select app.revoke_user_sessions(${active}::uuid[]) as n`.execute(trx);
    sessionsRevoked = Math.max(0, Number(rows[0]?.n ?? 0));
  }
  for (const l of logins) {
    await writeAudit(trx, { organizationId: rc.orgId, ...rc.actor, action: 'member.suspended', entityType: 'org_membership', entityId: l.id, oldValue: { status: l.status }, newValue: { status: 'suspended', userId: l.userId, employeeId, cause: 'employee_left', source: 'import', employmentStatus, sessionsRevoked }, reason: 'Employee left the organisation', jobId: rc.jobId });
  }
  for (const i of invitations) {
    await writeAudit(trx, { organizationId: rc.orgId, ...rc.actor, action: 'member.invitation_revoked', entityType: 'invitation', entityId: i.id, oldValue: { email: i.email, employeeId }, newValue: { cause: 'employee_left', source: 'import' }, reason: 'Employee left the organisation', jobId: rc.jobId });
  }
}

/** AGENTS.md "Termination": a leaver is taken off every terminal they are enrolled on (DELETE_EMPLOYEE per device row). */
async function removeFromDevices(trx: Trx, deps: JobContext['deps'], rc: RunContext, employeeId: string, employmentStatus: string): Promise<string | null> {
  const enrolled = await trx.selectFrom('deviceEmployeeStates as s')
    .innerJoin('devices as d', (j) => j.onRef('d.id', '=', 's.deviceId').onRef('d.organizationId', '=', 's.organizationId'))
    .select(['s.deviceId', 's.deviceUserId', 'd.branchId', 'd.status', 'd.capabilities'])
    .where('s.organizationId', '=', rc.orgId).where('s.employeeId', '=', employeeId).where('s.syncStatus', 'not in', ['REMOVED', 'REMOVING'])
    .where('d.providerKey', 'not in', NOT_TERMINALS).orderBy('s.deviceId').orderBy('s.deviceUserId').execute();
  await trx.updateTable('deviceEmployeeStates').set({ desired: false }).where('organizationId', '=', rc.orgId).where('employeeId', '=', employeeId).where('desired', '=', true).execute();
  const skipped: Array<{ deviceId: string; deviceUserId: string; reason: string }> = [];
  const items: Array<{ deviceId: string; employeeId: string; branchId: string | null; operation: 'DELETE_EMPLOYEE'; options: { deviceUserId: string } }> = [];
  for (const r of enrolled) {
    if (r.status !== 'active') skipped.push({ deviceId: r.deviceId, deviceUserId: r.deviceUserId, reason: 'device_inactive' });
    else if (asObject(r.capabilities)['employeeDelete'] !== true) skipped.push({ deviceId: r.deviceId, deviceUserId: r.deviceUserId, reason: 'delete_unsupported' });
    else items.push({ deviceId: r.deviceId, employeeId, branchId: r.branchId, operation: 'DELETE_EMPLOYEE', options: { deviceUserId: r.deviceUserId } });
  }
  if (items.length === 0 && skipped.length === 0) return null;
  const job = items.length > 0
    ? await createSyncJob(trx, deps.queue, {
      organizationId: rc.orgId, jobType: 'DELETE_EMPLOYEE', trigger: 'SYSTEM', scope: { employeeIds: [employeeId], cause: 'employee_left', source: 'import', importJobId: rc.importId },
      branchId: items.every((i) => i.branchId === items[0]!.branchId) ? items[0]!.branchId : null, requestedBy: rc.actor.actorUserId ?? null, priority: 6, items, maxAttempts: 6,
    })
    : null;
  await writeAudit(trx, {
    organizationId: rc.orgId, ...rc.actor, action: 'employee.device_removal_requested', entityType: 'employee', entityId: employeeId, jobId: rc.jobId, reason: 'Employee left the organisation',
    newValue: { employeeIds: [employeeId], cause: 'employee_left', source: 'import', employmentStatus, syncJobId: job?.syncJobId ?? null, removals: items.map((i) => ({ deviceId: i.deviceId, deviceUserId: i.options.deviceUserId })), skipped },
  });
  return job?.syncJobId ?? null;
}

async function resolveManagerId(trx: Trx, orgId: string, data: Record<string, unknown>): Promise<string | null | undefined> {
  if (str(data['managerEmployeeId'])) return str(data['managerEmployeeId'])!;
  const number = str(data['managerEmployeeNumber']);
  if (!number) return undefined;
  const m = await trx.selectFrom('employees').select('id').where('organizationId', '=', orgId).where(sql`lower(employee_number::text)`, '=', number.toLowerCase()).where('deletedAt', 'is', null).executeTakeFirst();
  return m?.id ?? null; // null: not there (yet) — the second pass links it
}

async function createEmployee(trx: Trx, rc: RunContext, d: Record<string, unknown>): Promise<string> {
  const number = str(d['employeeNumber'])!;
  const clash = await trx.selectFrom('employees').select('id').where('organizationId', '=', rc.orgId).where(sql`lower(employee_number::text)`, '=', number.toLowerCase()).executeTakeFirst();
  if (clash) throw errors.conflict('Employee number already exists (created after the file was validated)');
  const status = (str(d['employmentStatus']) ?? 'active') as EmployeeDto['employmentStatus'];
  if (!hasLeft(status)) await assertUserCapacity(trx, rc.orgId, 1);
  const managerId = await resolveManagerId(trx, rc.orgId, d);
  const firstName = str(d['firstName'])!; const lastName = str(d['lastName'])!;
  const joiningDate = str(d['joiningDate'])!;
  const branchId = str(d['branchId'])!;
  const deviceUserId = str(d['deviceUserId']) ?? (await nextDeviceUserId(trx, rc.orgId));
  const values = {
    organizationId: rc.orgId, employeeNumber: number, firstName, middleName: str(d['middleName']) ?? null, lastName, displayName: str(d['displayName']) ?? [firstName, lastName].join(' '), displayNameAr: str(d['displayNameAr']) ?? null,
    gender: (str(d['gender']) ?? 'unspecified') as EmployeeDto['gender'], dateOfBirth: str(d['dateOfBirth']) ?? null, nationalityCode: str(d['nationalityCode']) ?? null, email: str(d['email']) ?? null, phone: str(d['phone']) ?? null,
    joiningDate, exitDate: str(d['exitDate']) ?? null, employmentStatus: status, employmentType: (str(d['employmentType']) ?? 'full_time') as EmployeeDto['employmentType'], branchId,
    departmentId: str(d['departmentId']) ?? null, designationId: str(d['designationId']) ?? null, managerEmployeeId: managerId ?? null, deviceUserId, cardNumber: str(d['cardNumber']) ?? null,
    createdBy: rc.actor.actorUserId ?? null, updatedBy: rc.actor.actorUserId ?? null,
  };
  const row = await trx.insertInto('employees').values(values).returning('id').executeTakeFirstOrThrow();
  await applyHistoryTransition(trx, rc.orgId, row.id, { branchId, departmentId: values.departmentId, designationId: values.designationId, managerEmployeeId: values.managerEmployeeId, employmentType: values.employmentType, employmentStatus: status }, joiningDate, 'Joined', rc.actor.actorUserId ?? null);
  const civilId = str(d['civilId']);
  if (civilId) await upsertCivilId(trx, rc.orgId, row.id, branchId, civilId, rc.actor.actorUserId ?? null);
  const { civilId: _c, pin: _p, ...auditable } = d;
  await writeAudit(trx, { organizationId: rc.orgId, ...rc.actor, action: 'employee.created', entityType: 'employee', entityId: row.id, branchId, jobId: rc.jobId, newValue: { ...auditable, deviceUserId, source: 'import', importJobId: rc.importId, civilIdLast4: civilId ? civilId.slice(-4) : undefined } });
  await emitDomainEvent(trx, { organizationId: rc.orgId, eventType: 'employee.created', aggregateType: 'employee', aggregateId: row.id, payload: { employeeNumber: number, branchId, deviceUserId, source: 'import' }, actorUserId: rc.actor.actorUserId ?? null });
  if (!hasLeft(status)) rc.push.add(row.id);
  rc.recalc.push({ employeeId: row.id, fromDate: joiningDate });
  return row.id;
}

const UPDATABLE = ['firstName', 'middleName', 'lastName', 'displayName', 'displayNameAr', 'gender', 'dateOfBirth', 'nationalityCode', 'email', 'phone', 'joiningDate', 'exitDate', 'employmentStatus', 'employmentType', 'branchId', 'departmentId', 'designationId', 'deviceUserId', 'cardNumber'] as const;
const DEVICE_RELEVANT = new Set(['displayName', 'firstName', 'lastName', 'cardNumber', 'branchId', 'employmentStatus', 'deviceUserId']);

async function updateEmployee(trx: Trx, deps: JobContext['deps'], rc: RunContext, employeeId: string, d: Record<string, unknown>): Promise<RowResult> {
  await sql`select 1 from public.employees where organization_id = ${rc.orgId}::uuid and id = ${employeeId}::uuid for no key update`.execute(trx);
  const before = await trx.selectFrom('employees').selectAll().where('organizationId', '=', rc.orgId).where('id', '=', employeeId).executeTakeFirst();
  if (!before) throw errors.notFound('Employee', employeeId);
  if (before.deletedAt) throw errors.invalidState('The employee has been deleted.');
  const current: Record<string, unknown> = {
    ...before, joiningDate: isoDate(before.joiningDate), exitDate: before.exitDate ? isoDate(before.exitDate) : null, dateOfBirth: before.dateOfBirth ? isoDate(before.dateOfBirth) : null,
  };
  const patch: Record<string, unknown> = {};
  for (const k of UPDATABLE) if (has(d, k) && String(current[k] ?? '') !== String(d[k])) patch[k] = d[k];
  const managerId = await resolveManagerId(trx, rc.orgId, d);
  if (managerId && managerId !== before.managerEmployeeId) {
    if (managerId === employeeId) throw errors.validation('An employee cannot be their own manager.');
    patch['managerEmployeeId'] = managerId;
  }
  const civilId = str(d['civilId']);
  const civilChanged = civilId ? await upsertCivilId(trx, rc.orgId, employeeId, String(patch['branchId'] ?? before.branchId), civilId, rc.actor.actorUserId ?? null) : false;
  if (Object.keys(patch).length === 0) return civilChanged ? 'updated' : 'unchanged';

  const next: Snapshot = {
    branchId: String(patch['branchId'] ?? before.branchId), departmentId: (patch['departmentId'] ?? before.departmentId) as string | null, designationId: (patch['designationId'] ?? before.designationId) as string | null,
    managerEmployeeId: (patch['managerEmployeeId'] ?? before.managerEmployeeId) as string | null, employmentType: (patch['employmentType'] ?? before.employmentType) as Snapshot['employmentType'], employmentStatus: (patch['employmentStatus'] ?? before.employmentStatus) as Snapshot['employmentStatus'],
  };
  const leaving = hasLeft(next.employmentStatus) && !hasLeft(before.employmentStatus);
  if (hasLeft(before.employmentStatus) && !hasLeft(next.employmentStatus)) await assertUserCapacity(trx, rc.orgId, 1);
  // a leaver without an exit date leaves today (the history and the attendance engine read the exit date)
  if (leaving && !has(d, 'exitDate') && !before.exitDate) patch['exitDate'] = rc.today;
  const joiningDate = String(patch['joiningDate'] ?? current['joiningDate']);
  const transition = SNAPSHOT_KEYS.some((k) => next[k] !== (before as unknown as Snapshot)[k]);
  if (transition) {
    // dated on the exit date for a leaver (never before the joining date), today otherwise
    const exit = str(patch['exitDate']) ?? (current['exitDate'] as string | null) ?? undefined;
    const effective = leaving && exit ? (exit < joiningDate ? joiningDate : exit) : (rc.today < joiningDate ? joiningDate : rc.today);
    await applyHistoryTransition(trx, rc.orgId, employeeId, next, effective, leaving ? `Left (${next.employmentStatus}) — import` : 'Import', rc.actor.actorUserId ?? null);
  }
  await trx.updateTable('employees').set({ ...patch, updatedBy: rc.actor.actorUserId ?? null } as never).where('organizationId', '=', rc.orgId).where('id', '=', employeeId).execute();
  if (patch['joiningDate'] !== undefined || patch['exitDate'] !== undefined) {
    const dates = [current['joiningDate'], patch['joiningDate'], current['exitDate'], patch['exitDate']].filter((x): x is string => typeof x === 'string' && x <= rc.today);
    if (dates.length) rc.recalc.push({ employeeId, fromDate: dates.reduce((a, b) => (a < b ? a : b)) });
  }
  if (leaving) await offboardLogins(trx, rc, employeeId, next.employmentStatus);
  const oldValue: Record<string, unknown> = {}; const newValue: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) { oldValue[k] = current[k] ?? null; newValue[k] = patch[k]; }
  if (civilChanged) newValue['civilIdLast4'] = civilId!.slice(-4);
  await writeAudit(trx, { organizationId: rc.orgId, ...rc.actor, action: 'employee.updated', entityType: 'employee', entityId: employeeId, branchId: next.branchId, oldValue, newValue: { ...newValue, source: 'import', importJobId: rc.importId }, jobId: rc.jobId });
  await emitDomainEvent(trx, { organizationId: rc.orgId, eventType: 'employee.updated', aggregateType: 'employee', aggregateId: employeeId, payload: { changed: Object.keys(patch), transition, branchId: next.branchId, source: 'import' }, actorUserId: rc.actor.actorUserId ?? null });
  if (leaving) await removeFromDevices(trx, deps, rc, employeeId, next.employmentStatus);
  else if (!hasLeft(next.employmentStatus) && Object.keys(patch).some((k) => DEVICE_RELEVANT.has(k))) rc.push.add(employeeId);
  return 'updated';
}

async function upsertDepartment(trx: Trx, rc: RunContext, d: Record<string, unknown>): Promise<{ id: string; result: RowResult }> {
  const code = str(d['code'])!;
  const existing = await trx.selectFrom('departments').select(['id', 'name', 'nameAr', 'branchId', 'managerEmployeeId', 'status']).where('organizationId', '=', rc.orgId).where(sql`lower(code::text)`, '=', code.toLowerCase()).executeTakeFirst();
  const values: Record<string, unknown> = {};
  if (has(d, 'name')) values['name'] = d['name'];
  if (has(d, 'nameAr')) values['nameAr'] = d['nameAr'];
  if (has(d, 'branchId')) values['branchId'] = d['branchId'];
  if (has(d, 'managerEmployeeId')) values['managerEmployeeId'] = d['managerEmployeeId'];
  if (has(d, 'status')) values['status'] = d['status'];
  if (!existing) {
    const row = await trx.insertInto('departments').values({ organizationId: rc.orgId, code, name: String(d['name']), nameAr: str(d['nameAr']) ?? null, branchId: str(d['branchId']) ?? null, managerEmployeeId: str(d['managerEmployeeId']) ?? null, status: (str(d['status']) ?? 'active') as 'active' | 'inactive' }).returning('id').executeTakeFirstOrThrow();
    await writeAudit(trx, { organizationId: rc.orgId, ...rc.actor, action: 'department.created', entityType: 'department', entityId: row.id, branchId: str(d['branchId']) ?? null, newValue: { code, ...values, source: 'import', importJobId: rc.importId }, jobId: rc.jobId });
    return { id: row.id, result: 'created' };
  }
  if (existing.status === 'archived') throw errors.invalidState(`Department "${code}" is archived: restore it on the departments page first.`);
  const changed: Record<string, unknown> = {}; const old: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (String((existing as Record<string, unknown>)[k] ?? '') !== String(v)) { changed[k] = v; old[k] = (existing as Record<string, unknown>)[k] ?? null; }
  if (Object.keys(changed).length === 0) return { id: existing.id, result: 'unchanged' };
  await trx.updateTable('departments').set(changed as never).where('organizationId', '=', rc.orgId).where('id', '=', existing.id).execute();
  await writeAudit(trx, { organizationId: rc.orgId, ...rc.actor, action: 'department.updated', entityType: 'department', entityId: existing.id, branchId: (changed['branchId'] ?? existing.branchId) as string | null, oldValue: old, newValue: { ...changed, source: 'import', importJobId: rc.importId }, jobId: rc.jobId });
  return { id: existing.id, result: 'updated' };
}

/** Second pass of an org-unit import: the parent named by code, refused when it would close a loop (the API's tree rule). */
async function linkParent(trx: Trx, rc: RunContext, departmentId: string, parentCode: string): Promise<boolean> {
  const all = await trx.selectFrom('departments').select(['id', 'code', 'parentId', 'status']).where('organizationId', '=', rc.orgId).execute();
  const parent = all.find((x) => String(x.code).toLowerCase() === parentCode.toLowerCase());
  if (!parent || parent.status === 'archived') throw errors.validation(`Parent "${parentCode}" not found in the organisation.`);
  if (parent.id === departmentId) throw errors.validation('A department cannot be its own parent.');
  const parentOf = new Map(all.map((x) => [x.id, x.parentId]));
  for (let cursor: string | null | undefined = parent.id, depth = 0; cursor && depth < 1000; cursor = parentOf.get(cursor), depth += 1) {
    if (cursor === departmentId) throw errors.validation('This parent would create a cycle in the department tree.');
  }
  const self = all.find((x) => x.id === departmentId);
  if (self?.parentId === parent.id) return false;
  await trx.updateTable('departments').set({ parentId: parent.id }).where('organizationId', '=', rc.orgId).where('id', '=', departmentId).execute();
  await writeAudit(trx, { organizationId: rc.orgId, ...rc.actor, action: 'department.updated', entityType: 'department', entityId: departmentId, oldValue: { parentId: self?.parentId ?? null }, newValue: { parentId: parent.id, source: 'import', importJobId: rc.importId }, jobId: rc.jobId });
  return true;
}

/** Second pass of an employee import: managers created by the same file (their rows are applied now). */
async function linkManager(trx: Trx, rc: RunContext, employeeId: string, managerNumber: string): Promise<boolean> {
  const manager = await trx.selectFrom('employees').select('id').where('organizationId', '=', rc.orgId).where(sql`lower(employee_number::text)`, '=', managerNumber.toLowerCase()).where('deletedAt', 'is', null).executeTakeFirst();
  if (!manager) throw errors.validation(`Manager "${managerNumber}" was not imported.`);
  if (manager.id === employeeId) throw errors.validation('An employee cannot be their own manager.');
  const before = await trx.selectFrom('employees').selectAll().where('organizationId', '=', rc.orgId).where('id', '=', employeeId).executeTakeFirstOrThrow();
  if (before.managerEmployeeId === manager.id) return false;
  await trx.updateTable('employees').set({ managerEmployeeId: manager.id, updatedBy: rc.actor.actorUserId ?? null }).where('organizationId', '=', rc.orgId).where('id', '=', employeeId).execute();
  await applyHistoryTransition(trx, rc.orgId, employeeId, { branchId: before.branchId, departmentId: before.departmentId, designationId: before.designationId, managerEmployeeId: manager.id, employmentType: before.employmentType, employmentStatus: before.employmentStatus }, rc.today < isoDate(before.joiningDate) ? isoDate(before.joiningDate) : rc.today, 'Import', rc.actor.actorUserId ?? null);
  await writeAudit(trx, { organizationId: rc.orgId, ...rc.actor, action: 'employee.updated', entityType: 'employee', entityId: employeeId, branchId: before.branchId, oldValue: { managerEmployeeId: before.managerEmployeeId }, newValue: { managerEmployeeId: manager.id, source: 'import', importJobId: rc.importId }, jobId: rc.jobId });
  return true;
}

/**
 * Records a row's outcome with the row (same transaction as the change). A failed LINK (second pass) leaves the row imported —
 * the employee / department exists — with the reason in its errors and `importLinked: false`, counted as `linkFailed`.
 */
async function markRow(trx: Trx, rc: RunContext, row: ImportRow, outcome: { ok: true; entityId: string; result: RowResult } | { ok: false; message: string; field?: string }, pass: 'apply' | 'link' = 'apply'): Promise<void> {
  if (outcome.ok) {
    await trx.updateTable('importJobRows').set({ status: 'imported', entityId: outcome.entityId, data: sql`data || ${JSON.stringify(pass === 'apply' ? { importResult: outcome.result } : { importLinked: true })}::jsonb` })
      .where('organizationId', '=', rc.orgId).where('id', '=', row.id).execute();
  } else if (pass === 'link') {
    await trx.updateTable('importJobRows').set({ errors: sql`errors || ${JSON.stringify([{ field: outcome.field ?? null, message: outcome.message }])}::jsonb`, data: sql`data || '{"importLinked":false}'::jsonb` })
      .where('organizationId', '=', rc.orgId).where('id', '=', row.id).execute();
  } else {
    await trx.updateTable('importJobRows').set({ status: 'failed', errors: sql`errors || ${JSON.stringify([{ field: outcome.field ?? null, message: outcome.message }])}::jsonb` })
      .where('organizationId', '=', rc.orgId).where('id', '=', row.id).execute();
  }
}

async function loadJob(trx: Trx, orgId: string, importId: string): Promise<ImportJobRow | undefined> {
  return trx.selectFrom('importJobs as i').leftJoin('apiKeys as k', 'k.id', 'i.apiKeyId')
    .select(['i.id', 'i.type', 'i.source', 'i.status', 'i.requestedBy', 'i.apiKeyId', 'k.keyPrefix', 'i.reference'])
    .where('i.organizationId', '=', orgId).where('i.id', '=', importId).executeTakeFirst();
}

async function rowsWithStatus(trx: Trx, orgId: string, importId: string, status: 'valid' | 'imported', afterRowNo: number, limit: number): Promise<ImportRow[]> {
  const rows = await trx.selectFrom('importJobRows').select(['id', 'rowNo', 'data', 'status', 'entityId'])
    .where('organizationId', '=', orgId).where('importJobId', '=', importId).where('status', '=', status).where('rowNo', '>', afterRowNo).orderBy('rowNo').limit(limit).execute();
  return rows.map((r) => ({ id: String(r.id), rowNo: r.rowNo, data: asObject(r.data), status: r.status, entityId: r.entityId }));
}

export async function executeImport(ctx: JobContext): Promise<unknown> {
  const p = parsePayload(executeImportPayloadSchema, ctx.job.payload);
  const orgId = p.organizationId ?? ctx.job.organizationId;
  if (!orgId) throw new AppError('VALIDATION_ERROR', 'EXECUTE_IMPORT requires organizationId', { retryable: false });
  try {
    return await run(ctx, p, orgId);
  } catch (err) {
    await recordFailure(ctx, p, orgId, err);
    throw err;
  }
}

async function run(ctx: JobContext, p: Payload, orgId: string): Promise<unknown> {
  const { deps, log, job: qjob, signal } = ctx;
  const sys = <T>(fn: (trx: Trx) => Promise<T>) => withContext(deps.db, { kind: 'system', organizationId: orgId, jobId: qjob.id }, fn);
  const prepared = await sys(async (trx) => ({ job: await loadJob(trx, orgId, p.importJobId), today: await orgToday(trx, orgId) }));
  const job = prepared.job;
  if (!job || job.status !== 'IMPORTING') {
    log.info(event('import_skipped', { organizationId: orgId, jobId: qjob.id, importJobId: p.importJobId, status: job?.status ?? 'not_found' }));
    return { skipped: job?.status ?? 'not_found' };
  }
  const rc: RunContext = {
    orgId, importId: job.id, job, jobId: qjob.id, today: prepared.today, push: new Set(), recalc: [],
    actor: job.source === 'hrms' ? { actorUserId: null, actorType: 'API_KEY', actorLabel: job.keyPrefix ?? 'hrms' } : { actorUserId: p.requestedBy ?? job.requestedBy ?? null, actorType: 'USER' },
  };
  const kind = job.type === 'ORG_UNITS' ? 'ORG_UNITS' : 'EMPLOYEES';
  log.info(event('import_started', { organizationId: orgId, jobId: qjob.id, importJobId: job.id, kind, source: job.source }));

  // pass 1: create / update, IMPORT_CHUNK rows per transaction
  for (let last = 0; ;) {
    if (isLockLost(signal)) return { stopped: 'lock_lost' };
    const done = await sys(async (trx) => {
      const rows = await rowsWithStatus(trx, orgId, job.id, 'valid', last, IMPORT_CHUNK);
      for (const row of rows) {
        try {
          const out = await withSavepoint(trx, 'import_row', async () => {
            if (kind === 'ORG_UNITS') return upsertDepartment(trx, rc, row.data);
            const existing = str(row.data['existingEmployeeId']);
            if (existing) return { id: existing, result: await updateEmployee(trx, deps, rc, existing, row.data) };
            return { id: await createEmployee(trx, rc, row.data), result: 'created' as const };
          });
          await markRow(trx, rc, row, { ok: true, entityId: out.id, result: out.result });
        } catch (err) {
          await markRow(trx, rc, row, { ok: false, message: rowFailureMessage(err) });
        }
      }
      return rows.length === 0 ? null : rows[rows.length - 1]!.rowNo;
    });
    if (done === null) break;
    last = done;
  }

  // pass 2: links to rows of the same file (managers / parents), now that every row exists
  const linkField = kind === 'ORG_UNITS' ? 'parentCode' : 'managerEmployeeNumber';
  for (let last = 0; ;) {
    if (isLockLost(signal)) return { stopped: 'lock_lost' };
    const done = await sys(async (trx) => {
      const rows = (await rowsWithStatus(trx, orgId, job.id, 'imported', last, IMPORT_CHUNK));
      for (const row of rows) {
        const target = str(row.data[linkField]);
        if (!target || !row.entityId || row.data['importLinked'] !== undefined) continue;
        if (kind === 'EMPLOYEES' && str(row.data['managerEmployeeId'])) continue; // linked in pass 1 (manager already existed)
        try {
          await withSavepoint(trx, 'import_link', () => (kind === 'ORG_UNITS' ? linkParent(trx, rc, row.entityId!, target) : linkManager(trx, rc, row.entityId!, target)));
          await markRow(trx, rc, row, { ok: true, entityId: row.entityId, result: 'updated' }, 'link');
        } catch (err) {
          await markRow(trx, rc, row, { ok: false, message: rowFailureMessage(err), field: linkField }, 'link');
        }
      }
      return rows.length === 0 ? null : rows[rows.length - 1]!.rowNo;
    });
    if (done === null) break;
    last = done;
  }

  // finish: summary, follow-up jobs, audit, notification — one transaction
  return sys(async (trx) => {
    const current = await loadJob(trx, orgId, job.id);
    if (!current || current.status !== 'IMPORTING') return { skipped: current?.status ?? 'not_found' };
    const counts = await trx.selectFrom('importJobRows').select(['status', sql<string | null>`data ->> 'importResult'`.as('result'), (eb) => eb.fn.countAll().as('n')])
      .where('organizationId', '=', orgId).where('importJobId', '=', job.id).groupBy(['status', sql`data ->> 'importResult'`]).execute();
    const n = (status: string, result?: string) => counts.filter((c) => c.status === status && (result === undefined || c.result === result)).reduce((a, c) => a + Number(c.n), 0);
    const linkFailed = toNumber((await trx.selectFrom('importJobRows').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('importJobId', '=', job.id).where(sql`data ->> 'importLinked'`, '=', 'false').executeTakeFirst())?.n);
    const summaryCounts = { created: n('imported', 'created'), updated: n('imported', 'updated'), unchanged: n('imported', 'unchanged'), failed: n('failed'), invalid: n('invalid'), linkFailed };
    const imported = n('imported');
    const followUps: Record<string, unknown> = {};
    if (kind === 'EMPLOYEES' && rc.push.size > 0) {
      const settings = await trx.selectFrom('organizationSettings').select('sync').where('organizationId', '=', orgId).executeTakeFirst();
      if (asObject(settings?.sync)['autoPushNewEmployees'] !== false) {
        followUps['pushJobId'] = await deps.queue.enqueue({ queue: 'sync', jobType: 'PUSH_EMPLOYEES', organizationId: orgId, payload: { scope: { employeeIds: [...rc.push] }, trigger: 'SYSTEM', requestedBy: rc.actor.actorUserId ?? null }, priority: 6, correlationId: `import:${job.id}` }, trx);
      }
    }
    if (kind === 'EMPLOYEES' && rc.recalc.length > 0) {
      // the days since the earliest joining / changed date are calculated now (at most the last 366 days per request)
      const org = await trx.selectFrom('organizations').select(['createdAt', 'timezone']).where('id', '=', orgId).executeTakeFirst();
      const firstDay = org ? DateTime.fromJSDate(new Date(org.createdAt)).setZone(org.timezone).toISODate() : null;
      const floor = DateTime.fromISO(rc.today).minus({ days: 365 }).toISODate()!;
      const from = rc.recalc.map((r) => r.fromDate).reduce((a, b) => (a < b ? a : b));
      const bounded = [from, floor, firstDay ?? from].reduce((a, b) => (a > b ? a : b));
      if (bounded < rc.today) {
        const ids = [...new Set(rc.recalc.map((r) => r.employeeId))];
        const requests: string[] = [];
        for (let i = 0; i < ids.length; i += 1000) requests.push((await enqueueRecalculationForScope(trx, deps.queue, { organizationId: orgId, fromDate: bounded, toDate: rc.today, employeeIds: ids.slice(i, i + 1000), reason: `Import ${job.id.slice(0, 8)}`, requestedBy: rc.actor.actorUserId ?? null })).requestId);
        followUps['recalculationRequestIds'] = requests;
      }
    }
    const summaryBefore = asObject((await trx.selectFrom('importJobs').select('summary').where('id', '=', job.id).executeTakeFirst())?.summary);
    const summary = { ...summaryBefore, ...summaryCounts, ...followUps, finishedAt: new Date().toISOString() };
    await trx.updateTable('importJobs').set({ status: 'COMPLETED', importedRows: imported, summary: JSON.stringify(summary), error: null }).where('organizationId', '=', orgId).where('id', '=', job.id).execute();
    await writeAudit(trx, { organizationId: orgId, ...rc.actor, action: 'employee.import_completed', entityType: 'import_job', entityId: job.id, jobId: qjob.id, newValue: { kind, source: job.source, imported, ...summaryCounts, ...followUps } });
    if (job.source !== 'hrms' || summaryCounts.failed > 0 || linkFailed > 0) {
      await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.imported', aggregateType: 'import_job', aggregateId: job.id, payload: { phase: 'finished', importId: job.id, kind, source: job.source, imported, failed: summaryCounts.failed }, actorUserId: rc.actor.actorUserId ?? null });
    }
    log.info(event('import_completed', { organizationId: orgId, jobId: qjob.id, importJobId: job.id, kind, imported, ...summaryCounts }));
    return { importJobId: job.id, imported, ...summaryCounts };
  });
}

/** A job that will not be retried leaves the import FAILED with a reason the import page can show (never SQL). */
async function recordFailure(ctx: JobContext, p: Payload, orgId: string, err: unknown): Promise<void> {
  const { retryable } = classify(err);
  const final = !retryable || ctx.job.attempts >= ctx.job.maxAttempts;
  if (!final || isLockLost(ctx.signal)) return;
  try {
    await withContext(ctx.deps.db, { kind: 'system', organizationId: orgId, jobId: ctx.job.id }, (trx) => trx.updateTable('importJobs')
      .set({ status: 'FAILED', error: AppError.is(err) ? err.message.slice(0, 500) : 'The import stopped on an internal error; the rows marked imported were applied.' })
      .where('organizationId', '=', orgId).where('id', '=', p.importJobId).where('status', '=', 'IMPORTING').execute());
  } catch (recordErr) {
    ctx.log.warn(event('import_failure_unrecorded', { organizationId: orgId, jobId: ctx.job.id, importJobId: p.importJobId, err: (recordErr as Error).message }));
  }
  ctx.log.error(event('import_failed', { organizationId: orgId, jobId: ctx.job.id, importJobId: p.importJobId, attempt: ctx.job.attempts }));
}
