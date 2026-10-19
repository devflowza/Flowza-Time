import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { isoDate } from '../attendance/common.js';
import { executeImport, rowFailureMessage } from './execute.js';

/**
 * EXECUTE_IMPORT (HRMS workstream): the confirmed import / HR system batch is applied in the organisation's system context —
 * creates and updates by employee number, codes resolved, managers of the same file linked in a second pass, a termination
 * offboards the logins and takes the employee off the terminals (DELETE_EMPLOYEE), org units upserted by code with parents
 * linked (loops refused); per-row results, a summary, an audit row and the notification; idempotent on retry.
 */
const ORG = '0f000000-0000-0000-0000-000000000000';
const BRANCH = '0f000000-0000-0000-0000-0000000000b1';
const DEPT_OPS = '0f000000-0000-0000-0000-0000000000d1';
const DEPT_ROOT = '0f000000-0000-0000-0000-0000000000d2';
const DESIG = '0f000000-0000-0000-0000-0000000000f1';
const DEVICE = '0f000000-0000-0000-0000-0000000000c1';
const E = { e1: '0f000000-0000-0000-0000-0000000000e1', e2: '0f000000-0000-0000-0000-0000000000e2', e3: '0f000000-0000-0000-0000-0000000000e3' };
const U = { hr: 'f0000000-0000-0000-0000-000000000001', leaver: 'f0000000-0000-0000-0000-000000000003' };
const ROLE_EMPLOYEE = '10000000-0000-0000-0000-000000000008';
const ROLE_HR_ADMIN = '10000000-0000-0000-0000-000000000003';
let h: TestHarness;

beforeAll(async () => {
  h = await createHarness(`flowza_worker_imports_${process.pid}`, { get() { throw new Error('n/a'); }, tryGet() { return undefined; }, list() { return []; }, pushProtocols() { return []; }, pushProtocol() { return undefined; } });
  const a = h.tdb.adminDb;
  for (const [id, email] of [[U.hr, 'hr@imp.local'], [U.leaver, 'leaver@imp.local']] as const) {
    await sql`insert into auth.users (id, email) values (${id}::uuid, ${email})`.execute(a);
    await a.insertInto('userProfiles').values({ id, email, fullName: email.split('@')[0]! }).execute();
  }
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'IMP', legalName: 'Imports LLC', displayName: 'Imports', timezone: 'Asia/Muscat', createdAt: new Date('2025-01-01T00:00:00Z') }).execute();
  await a.insertInto('organizationSettings').values({ organizationId: ORG }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('departments').values([{ id: DEPT_OPS, organizationId: ORG, code: 'OPS', name: 'Operations' }, { id: DEPT_ROOT, organizationId: ORG, code: 'ROOT', name: 'Root' }]).execute();
  await a.insertInto('designations').values({ id: DESIG, organizationId: ORG, code: 'ENG', name: 'Engineer', level: 3 }).execute();
  await a.insertInto('employees').values([
    { id: E.e1, organizationId: ORG, employeeNumber: 'E-1', firstName: 'Ali', lastName: 'Said', displayName: 'Ali Said', joiningDate: '2025-01-01', branchId: BRANCH, deviceUserId: '1' },
    { id: E.e2, organizationId: ORG, employeeNumber: 'E-2', firstName: 'Sara', lastName: 'Nasser', displayName: 'Sara Nasser', joiningDate: '2025-01-01', branchId: BRANCH, deviceUserId: '2' },
    { id: E.e3, organizationId: ORG, employeeNumber: 'E-3', firstName: 'Omar', lastName: 'Leaver', displayName: 'Omar Leaver', joiningDate: '2025-01-01', branchId: BRANCH, deviceUserId: '3' },
  ]).execute();
  await a.insertInto('employmentHistory').values(Object.values(E).map((id) => ({ organizationId: ORG, employeeId: id, effectiveFrom: '2025-01-01', branchId: BRANCH, employmentType: 'full_time' as const, employmentStatus: 'active' as const, reason: 'Joined' }))).execute();
  await a.insertInto('orgMemberships').values([
    { organizationId: ORG, userId: U.hr, roleId: ROLE_HR_ADMIN, status: 'active', allBranches: true, joinedAt: new Date() },
    { organizationId: ORG, userId: U.leaver, roleId: ROLE_EMPLOYEE, status: 'active', allBranches: true, joinedAt: new Date(), employeeId: E.e3 },
  ]).execute();
  await a.insertInto('devices').values({ id: DEVICE, organizationId: ORG, branchId: BRANCH, code: 'T1', name: 'Terminal 1', providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL', status: 'active', capabilities: JSON.stringify({ employeeDelete: true, employeePush: true }) }).execute();
  await a.insertInto('deviceEmployeeStates').values({ organizationId: ORG, deviceId: DEVICE, employeeId: E.e3, branchId: BRANCH, deviceUserId: '3', syncStatus: 'IN_SYNC' }).execute();
}, 180_000);
afterAll(async () => { await h?.close(); });

async function seedImport(kind: 'EMPLOYEES' | 'ORG_UNITS', rows: Array<{ rowNo: number; data: Record<string, unknown>; status?: 'valid' | 'invalid' }>, extra: Record<string, unknown> = {}): Promise<string> {
  const a = h.tdb.adminDb;
  const job = await a.insertInto('importJobs').values({ organizationId: ORG, type: kind, filePath: 'imports/test', status: 'IMPORTING', totalRows: rows.length, validRows: rows.filter((r) => r.status !== 'invalid').length, errorRows: rows.filter((r) => r.status === 'invalid').length, requestedBy: U.hr, summary: JSON.stringify({ columns: [] }), ...extra }).returning('id').executeTakeFirstOrThrow();
  await a.insertInto('importJobRows').values(rows.map((r) => ({ organizationId: ORG, importJobId: job.id, rowNo: r.rowNo, data: JSON.stringify(r.data), status: r.status ?? 'valid', errors: JSON.stringify(r.status === 'invalid' ? [{ field: 'branchCode', message: 'Unknown branch code' }] : []) }))).execute();
  return job.id;
}
const ctxFor = (importJobId: string, attempts = 1) => ({ job: { ...fakeJob('EXECUTE_IMPORT', { importJobId, requestedBy: U.hr }, ORG), queueName: 'processing', attempts }, deps: h.deps, log: h.deps.log, signal: new AbortController().signal });
const rowsOf = (id: string) => h.tdb.adminDb.selectFrom('importJobRows').select(['rowNo', 'status', 'entityId', 'errors', 'data']).where('importJobId', '=', id).orderBy('rowNo').execute();
const employee = (number: string) => h.tdb.adminDb.selectFrom('employees').selectAll().where('organizationId', '=', ORG).where('employeeNumber', '=', number).executeTakeFirst();

describe('EXECUTE_IMPORT — employees', () => {
  let importId: string;

  it('creates, updates, links in-file managers, terminates (offboarding + DELETE_EMPLOYEE) and records per-row results', async () => {
    // N-001 reports to N-002, which comes LATER in the file (second pass); N-002 reports to E-1 (resolved at validation)
    importId = await seedImport('EMPLOYEES', [
      { rowNo: 2, data: { employeeNumber: 'N-001', firstName: 'Noor', lastName: 'Hamed', displayNameAr: 'نور حامد', joiningDate: '2026-10-01', gender: 'female', employmentStatus: 'active', employmentType: 'full_time', branchCode: 'HQ', branchId: BRANCH, departmentCode: 'OPS', departmentId: DEPT_OPS, managerEmployeeNumber: 'N-002', civilId: '12345678' } },
      { rowNo: 3, data: { employeeNumber: 'N-002', firstName: 'Badr', lastName: 'Salim', joiningDate: '2026-10-01', gender: 'male', employmentStatus: 'active', employmentType: 'full_time', branchCode: 'HQ', branchId: BRANCH, managerEmployeeNumber: 'E-1', managerEmployeeId: E.e1, deviceUserId: '77' } },
      { rowNo: 4, data: { employeeNumber: 'E-2', existingEmployeeId: E.e2, designationCode: 'ENG', designationId: DESIG, departmentCode: 'OPS', departmentId: DEPT_OPS, phone: '+96891234567' } },
      { rowNo: 5, data: { employeeNumber: 'E-3', existingEmployeeId: E.e3, employmentStatus: 'terminated', exitDate: '2026-10-10' } },
      { rowNo: 6, data: { employeeNumber: 'BAD-1', branchCode: 'NOPE' }, status: 'invalid' },
      { rowNo: 7, data: { employeeNumber: 'E-1', firstName: 'Clash', lastName: 'Taken', joiningDate: '2026-10-01', gender: 'unspecified', employmentStatus: 'active', employmentType: 'full_time', branchCode: 'HQ', branchId: BRANCH } },
    ]);
    const res = await executeImport(ctxFor(importId));
    expect(res).toMatchObject({ importJobId: importId, imported: 4, created: 2, updated: 2, failed: 1, invalid: 1, linkFailed: 0 });

    const rows = await rowsOf(importId);
    expect(rows.map((r) => [r.rowNo, r.status])).toEqual([[2, 'imported'], [3, 'imported'], [4, 'imported'], [5, 'imported'], [6, 'invalid'], [7, 'failed']]);
    expect((rows[5]!.errors as Array<{ message: string }>)[0]!.message).toMatch(/Employee number already exists/);

    const n1 = (await employee('N-001'))!; const n2 = (await employee('N-002'))!;
    expect(rows[0]!.entityId).toBe(n1.id);
    expect(n1).toMatchObject({ branchId: BRANCH, departmentId: DEPT_OPS, managerEmployeeId: n2.id, displayNameAr: 'نور حامد', gender: 'female', createdBy: U.hr });
    expect(n1.deviceUserId).toMatch(/^\d+$/); // auto-assigned
    expect(n2).toMatchObject({ managerEmployeeId: E.e1, deviceUserId: '77' });
    // civil ID → identity document, never in the audit trail in clear
    expect(await h.tdb.adminDb.selectFrom('employeeIdentityDocuments').select(['type', 'number']).where('employeeId', '=', n1.id).execute()).toEqual([{ type: 'civil_id', number: '12345678' }]);
    const created = await h.tdb.adminDb.selectFrom('audit.logs').select(['newValue', 'actorUserId']).where('action', '=', 'employee.created').where('entityId', '=', n1.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(created.newValue)).not.toContain('12345678');
    expect(created.actorUserId).toBe(U.hr);
    // history: joined, then the second-pass manager link
    const hist = await h.tdb.adminDb.selectFrom('employmentHistory').select(['managerEmployeeId', 'reason']).where('employeeId', '=', n1.id).orderBy('effectiveFrom').execute();
    expect(hist.at(-1)!.managerEmployeeId).toBe(n2.id);

    // update: only the fields the row carried changed
    const e2 = (await employee('E-2'))!;
    expect(e2).toMatchObject({ designationId: DESIG, departmentId: DEPT_OPS, phone: '+96891234567', firstName: 'Sara', lastName: 'Nasser' });

    // termination: status + exit date, history, login suspended, terminal removal queued
    const e3 = (await employee('E-3'))!;
    expect(e3.employmentStatus).toBe('terminated');
    expect(isoDate(e3.exitDate!)).toBe('2026-10-10');
    const m = await h.tdb.adminDb.selectFrom('orgMemberships').select('status').where('employeeId', '=', E.e3).executeTakeFirstOrThrow();
    expect(m.status).toBe('suspended');
    const del = await h.tdb.adminDb.selectFrom('syncJobs as j').innerJoin('syncJobItems as i', 'i.syncJobId', 'j.id').select(['j.jobType', 'i.operation', 'i.deviceId', 'i.employeeId']).where('j.organizationId', '=', ORG).where('j.jobType', '=', 'DELETE_EMPLOYEE').execute();
    expect(del).toEqual([{ jobType: 'DELETE_EMPLOYEE', operation: 'DELETE_EMPLOYEE', deviceId: DEVICE, employeeId: E.e3 }]);
    expect((await h.tdb.adminDb.selectFrom('deviceEmployeeStates').select('desired').where('employeeId', '=', E.e3).executeTakeFirstOrThrow()).desired).toBe(false);
    const removal = await h.tdb.adminDb.selectFrom('audit.logs').select('action').where('organizationId', '=', ORG).where('action', 'in', ['member.suspended', 'employee.device_removal_requested']).execute();
    expect(removal.map((r) => r.action).sort()).toEqual(['employee.device_removal_requested', 'member.suspended']);

    // the import: COMPLETED with its summary, audited, notified; the new employees are pushed to the terminals
    const job = await h.tdb.adminDb.selectFrom('importJobs').select(['status', 'importedRows', 'summary']).where('id', '=', importId).executeTakeFirstOrThrow();
    expect(job).toMatchObject({ status: 'COMPLETED', importedRows: 4 });
    expect(job.summary).toMatchObject({ created: 2, updated: 2, failed: 1, invalid: 1 });
    expect((job.summary as Record<string, unknown>)['pushJobId']).toBeTruthy();
    const push = await h.tdb.adminDb.selectFrom('jobs.queue').select('payload').where('jobType', '=', 'PUSH_EMPLOYEES').where('organizationId', '=', ORG).executeTakeFirstOrThrow();
    expect(((push.payload as { scope: { employeeIds: string[] } }).scope.employeeIds).sort()).toEqual([n1.id, n2.id].sort());
    expect(await h.tdb.adminDb.selectFrom('audit.logs').select('action').where('entityId', '=', importId).where('action', '=', 'employee.import_completed').execute()).toHaveLength(1);
    const ev = await h.tdb.adminDb.selectFrom('domainEvents').select(['eventType', 'payload']).where('aggregateId', '=', importId).execute();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ eventType: 'employee.imported', payload: { phase: 'finished', imported: 4, failed: 1 } });
  });

  it('is idempotent: a completed import is skipped, a retried one applies nothing twice', async () => {
    expect(await executeImport(ctxFor(importId))).toEqual({ skipped: 'COMPLETED' });
    // a retry of the job (status back to IMPORTING): every row is already imported / failed — nothing is created again
    await h.tdb.adminDb.updateTable('importJobs').set({ status: 'IMPORTING' }).where('id', '=', importId).execute();
    const before = await h.tdb.adminDb.selectFrom('employees').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', ORG).executeTakeFirstOrThrow();
    const res = await executeImport(ctxFor(importId, 2));
    expect(res).toMatchObject({ imported: 4, created: 2, updated: 2, failed: 1 });
    const after = await h.tdb.adminDb.selectFrom('employees').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', ORG).executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
    expect(await h.tdb.adminDb.selectFrom('syncJobs').select('id').where('organizationId', '=', ORG).where('jobType', '=', 'DELETE_EMPLOYEE').execute()).toHaveLength(1);
  });

  it('skips a cancelled import and an unknown one', async () => {
    const cancelled = await seedImport('EMPLOYEES', [{ rowNo: 2, data: { employeeNumber: 'C-1', firstName: 'C', lastName: 'C', joiningDate: '2026-10-01', branchId: BRANCH, branchCode: 'HQ' } }], { status: 'CANCELLED' });
    expect(await executeImport(ctxFor(cancelled))).toEqual({ skipped: 'CANCELLED' });
    expect(await employee('C-1')).toBeUndefined();
    expect(await executeImport(ctxFor('0f000000-0000-0000-0000-00000000ffff'))).toEqual({ skipped: 'not_found' });
  });

  it('an HR system batch is audited as its API key and notifies only when rows failed', async () => {
    const key = await h.tdb.adminDb.insertInto('apiKeys').values({ organizationId: ORG, name: 'Mawred', keyPrefix: 'fzk_TESTTEST', keyHash: 'a'.repeat(64), scopes: ['hrms:write'] }).returning('id').executeTakeFirstOrThrow();
    const batch = await seedImport('EMPLOYEES', [{ rowNo: 1, data: { employeeNumber: 'E-2', existingEmployeeId: E.e2, displayNameAr: 'سارة ناصر' } }], { source: 'hrms', apiKeyId: key.id, requestedBy: null });
    expect(await executeImport({ ...ctxFor(batch), job: { ...ctxFor(batch).job, payload: { organizationId: ORG, importJobId: batch, requestedBy: null } } })).toMatchObject({ imported: 1, updated: 1 });
    const audit = await h.tdb.adminDb.selectFrom('audit.logs').select(['actorType', 'actorLabel', 'actorUserId']).where('action', '=', 'employee.updated').where('entityId', '=', E.e2).orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(audit).toEqual({ actorType: 'API_KEY', actorLabel: 'fzk_TESTTEST', actorUserId: null });
    expect(await h.tdb.adminDb.selectFrom('domainEvents').select('id').where('aggregateId', '=', batch).execute()).toHaveLength(0);
  });
});

describe('EXECUTE_IMPORT — organisational units', () => {
  it('upserts departments by code, links parents of the same file in a second pass and refuses a loop', async () => {
    // a loop the validation did not see (the tree changed after the file was checked): Y is under X in the database, and the
    // file asks for X under Y
    const a = h.tdb.adminDb;
    const x = await a.insertInto('departments').values({ organizationId: ORG, code: 'X', name: 'X' }).returning('id').executeTakeFirstOrThrow();
    await a.insertInto('departments').values({ organizationId: ORG, code: 'Y', name: 'Y', parentId: x.id }).execute();
    const id = await seedImport('ORG_UNITS', [
      { rowNo: 2, data: { code: 'CHILD', name: 'Child unit', nameAr: 'وحدة فرعية', parentCode: 'PARENT', branchCode: 'HQ', branchId: BRANCH, managerEmployeeNumber: 'E-1', managerEmployeeId: E.e1 } },
      { rowNo: 3, data: { code: 'PARENT', name: 'Parent unit', parentCode: 'ROOT' } },
      { rowNo: 4, data: { code: 'ROOT', name: 'Root (renamed)', existingDepartmentId: DEPT_ROOT } },
      { rowNo: 5, data: { code: 'X', name: 'X', parentCode: 'Y', existingDepartmentId: x.id } },
    ]);
    const res = await executeImport(ctxFor(id));
    expect(res).toMatchObject({ imported: 4, created: 2, linkFailed: 1 });
    const dep = async (code: string) => a.selectFrom('departments').select(['id', 'name', 'nameAr', 'parentId', 'branchId', 'managerEmployeeId']).where('organizationId', '=', ORG).where('code', '=', code).executeTakeFirstOrThrow();
    const parent = await dep('PARENT'); const child = await dep('CHILD'); const root = await dep('ROOT');
    expect(child).toMatchObject({ parentId: parent.id, nameAr: 'وحدة فرعية', branchId: BRANCH, managerEmployeeId: E.e1 });
    expect(parent.parentId).toBe(DEPT_ROOT);
    expect(root.name).toBe('Root (renamed)');
    // X under Y while Y is under X: refused, X keeps no parent, the row says why
    expect((await dep('X')).parentId).toBeNull();
    const rows = await rowsOf(id);
    expect(rows[3]).toMatchObject({ status: 'imported' });
    expect((rows[3]!.errors as Array<{ field: string; message: string }>)[0]).toMatchObject({ field: 'parentCode', message: 'This parent would create a cycle in the department tree.' });
    expect(await a.selectFrom('audit.logs').select('action').where('organizationId', '=', ORG).where('action', '=', 'department.created').execute()).toHaveLength(2);
  });
});

describe('rowFailureMessage', () => {
  it('names the rule, never the SQL', () => {
    expect(rowFailureMessage({ code: '23505', constraint: 'employees_organization_id_device_user_id_key', message: 'duplicate key value violates unique constraint "employees_organization_id_device_user_id_key"' })).toBe('Device user id already exists');
    expect(rowFailureMessage({ message: 'reporting line cycle: employee x cannot report to y' })).toMatch(/go round in a circle/);
    expect(rowFailureMessage(new Error('select * from secret'))).toBe('The row could not be applied (internal error).');
  });
});
