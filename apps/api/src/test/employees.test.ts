import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createTestApi, F, type TestApi } from './harness.js';

let api: TestApi;
beforeAll(async () => { api = await createTestApi('employees'); }, 120_000);
afterAll(async () => { await api?.close(); });

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('structure', () => {
  it('branches: list, create (timezone validated), update, archive refused while employees exist', async () => {
    const list = await api.request('GET', `/orgs/${F.orgA}/branches`, { user: F.ownerA });
    expect(list.json.meta.total).toBe(2);
    expect(list.json.data.find((b: any) => b.id === F.branchHQ).employeeCount).toBe(1);
    const scoped = await api.request('GET', `/orgs/${F.orgA}/branches`, { user: F.branchManagerA });
    expect(scoped.json.data.map((b: any) => b.id)).toEqual([F.branchB2]);
    const badTz = await api.request('POST', `/orgs/${F.orgA}/branches`, { user: F.ownerA, body: { code: 'A-3', name: 'Third', timezone: 'Not/AZone' } });
    expect(badTz.status).toBe(400);
    const created = await api.request('POST', `/orgs/${F.orgA}/branches`, { user: F.ownerA, body: { code: 'A-3', name: 'Third', timezone: 'Asia/Dubai', city: 'Dubai' } });
    expect(created.status).toBe(201);
    const dup = await api.request('POST', `/orgs/${F.orgA}/branches`, { user: F.ownerA, body: { code: 'a-3', name: 'Dup', timezone: 'Asia/Dubai' } });
    expect(dup.status).toBe(409);
    const upd = await api.request('PATCH', `/orgs/${F.orgA}/branches/${created.json.data.id}`, { user: F.ownerA, body: { name: 'Third Renamed' } });
    expect(upd.json.data.name).toBe('Third Renamed');
    const archived = await api.request('DELETE', `/orgs/${F.orgA}/branches/${created.json.data.id}`, { user: F.ownerA });
    expect(archived.json.data.status).toBe('archived');
    const refused = await api.request('DELETE', `/orgs/${F.orgA}/branches/${F.branchHQ}`, { user: F.ownerA });
    expect(refused.status).toBe(409);
    const bmDenied = await api.request('PATCH', `/orgs/${F.orgA}/branches/${F.branchHQ}`, { user: F.branchManagerA, body: { name: 'x' } });
    expect(bmDenied.status).toBe(403);
  });

  it('departments: tree with cycle prevention; designations and teams CRUD', async () => {
    const cycle = await api.request('PATCH', `/orgs/${F.orgA}/departments/${F.deptOps}`, { user: F.ownerA, body: { parentId: F.deptSales } });
    expect(cycle.status).toBe(400);
    const self = await api.request('PATCH', `/orgs/${F.orgA}/departments/${F.deptOps}`, { user: F.ownerA, body: { parentId: F.deptOps } });
    expect(self.status).toBe(400);
    const dept = await api.request('POST', `/orgs/${F.orgA}/departments`, { user: F.ownerA, body: { code: 'FIN', name: 'Finance', parentId: F.deptOps, managerEmployeeId: F.empE1 } });
    expect(dept.status).toBe(201);
    expect(dept.json.data).toMatchObject({ parentId: F.deptOps, managerName: 'Ali Said' });
    const list = await api.request('GET', `/orgs/${F.orgA}/departments?search=fin`, { user: F.hrUserA });
    expect(list.json.data.map((d: any) => d.code)).toEqual(['FIN']);
    const refused = await api.request('DELETE', `/orgs/${F.orgA}/departments/${F.deptOps}`, { user: F.ownerA });
    expect(refused.status).toBe(409);
    const desig = await api.request('POST', `/orgs/${F.orgA}/designations`, { user: F.ownerA, body: { code: 'MGR', name: 'Manager', level: 5 } });
    expect(desig.status).toBe(201);
    const team = await api.request('POST', `/orgs/${F.orgA}/teams`, { user: F.ownerA, body: { code: 'T1', name: 'Team One', branchId: F.branchHQ, leadEmployeeId: F.empE1, memberIds: [F.empE1, F.empE2] } });
    expect(team.status).toBe(201);
    expect(team.json.data.memberCount).toBe(2);
    const teamUpd = await api.request('PATCH', `/orgs/${F.orgA}/teams/${team.json.data.id}`, { user: F.ownerA, body: { memberIds: [F.empE2] } });
    expect(teamUpd.json.data.members.map((m: any) => m.employeeId)).toEqual([F.empE2]);
    const badMember = await api.request('PATCH', `/orgs/${F.orgA}/teams/${team.json.data.id}`, { user: F.ownerA, body: { memberIds: [F.empB1] } });
    expect(badMember.status).toBe(400);
  });
});

describe('employees', () => {
  let createdId: string;

  it('branch manager sees only own-branch employees and cannot move an employee to another branch', async () => {
    const list = await api.request('GET', `/orgs/${F.orgA}/employees`, { user: F.branchManagerA });
    expect(list.status).toBe(200);
    expect(list.json.data.map((e: any) => e.employeeNumber)).toEqual(['E-002']);
    expect(list.json.data[0].deviceSyncSummary).toEqual({ total: 0, inSync: 0, pending: 0, failed: 0, offline: 0 }); // device state rows carry the device's (HQ) branch → hidden by RLS
    const otherBranch = await api.request('GET', `/orgs/${F.orgA}/employees?branchId=${F.branchHQ}`, { user: F.branchManagerA });
    expect(otherBranch.status).toBe(403);
    const move = await api.request('PATCH', `/orgs/${F.orgA}/employees/${F.empE2}`, { user: F.branchManagerA, body: { branchId: F.branchHQ } });
    expect(move.status).toBe(403);
    expect(move.json.code).toBe('FORBIDDEN');
    const foreign = await api.request('GET', `/orgs/${F.orgA}/employees/${F.empE1}`, { user: F.branchManagerA });
    expect(foreign.status).toBe(404); // RLS hides the row
  });

  it('lists with search, filters, sort and pagination', async () => {
    const search = await api.request('GET', `/orgs/${F.orgA}/employees?search=ali`, { user: F.ownerA });
    expect(search.json.data.map((e: any) => e.employeeNumber)).toEqual(['E-001']);
    const partial = await api.request('GET', `/orgs/${F.orgA}/employees?search=ass`, { user: F.ownerA }); // "Sara Nasser" via trigram fallback
    expect(partial.json.data.map((e: any) => e.employeeNumber)).toEqual(['E-002']);
    const sorted = await api.request('GET', `/orgs/${F.orgA}/employees?sort=displayName&order=desc&pageSize=1&page=2`, { user: F.ownerA });
    expect(sorted.json.meta).toMatchObject({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    expect(sorted.json.data[0].displayName).toBe('Ali Said');
    expect(sorted.json.data[0]).toMatchObject({ branchName: 'A HQ', departmentName: 'Operations', designationName: 'Engineer' });
    expect(sorted.json.data[0].deviceSyncSummary).toMatchObject({ total: 1, inSync: 1 });
    expect(partial.json.data[0].deviceSyncSummary).toMatchObject({ total: 1, failed: 1 });
    expect((await api.request('GET', `/orgs/${F.orgA}/employees?sort=pin_hash`, { user: F.ownerA })).status).toBe(400);
  });

  it('creates an employee: auto device_user_id, history row, audit row, outbox event and queued push job', async () => {
    const res = await api.request('POST', `/orgs/${F.orgA}/employees`, { user: F.ownerA, body: { employeeNumber: 'E-003', firstName: 'Noor', lastName: 'Hamad', joiningDate: '2026-02-01', branchId: F.branchHQ, departmentId: F.deptOps, managerEmployeeId: F.empE1, pin: '1234', email: 'noor@org-a.test' } });
    expect(res.status).toBe(201);
    createdId = res.json.data.id;
    expect(res.json.data).toMatchObject({ deviceUserId: '3', displayName: 'Noor Hamad', managerName: 'Ali Said', employmentStatus: 'active' });
    expect(res.json.data).not.toHaveProperty('pinHash');
    const history = await api.request('GET', `/orgs/${F.orgA}/employees/${createdId}/history`, { user: F.ownerA });
    expect(history.json.data).toHaveLength(1);
    expect(history.json.data[0]).toMatchObject({ effectiveFrom: '2026-02-01', effectiveTo: null, branchId: F.branchHQ, branchName: 'A HQ' });
    const stored = await api.tdb.adminDb.selectFrom('employees').select('pinHash').where('id', '=', createdId).executeTakeFirstOrThrow();
    expect(stored.pinHash).toMatch(/^scrypt\$/);
    const audit = await api.tdb.adminDb.selectFrom('audit.logs').select(['action', 'newValue', 'branchId']).where('entityId', '=', createdId).where('action', '=', 'employee.created').executeTakeFirstOrThrow();
    expect(audit.branchId).toBe(F.branchHQ);
    expect((audit.newValue as any).pin).toBeUndefined();
    expect((audit.newValue as any).pinSet).toBe(true);
    const event = await api.tdb.adminDb.selectFrom('domainEvents').select(['eventType', 'aggregateId']).where('aggregateId', '=', createdId).execute();
    expect(event.map((e) => e.eventType)).toEqual(['employee.created']);
    const jobs = await api.tdb.adminDb.selectFrom('jobs.queue').select(['jobType', 'queueName', 'payload', 'organizationId']).where('jobType', '=', 'PUSH_EMPLOYEES').execute();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ queueName: 'sync', organizationId: F.orgA });
    expect((jobs[0]!.payload as any).scope.employeeIds).toEqual([createdId]);
    const dupNumber = await api.request('POST', `/orgs/${F.orgA}/employees`, { user: F.ownerA, body: { employeeNumber: 'e-003', firstName: 'X', lastName: 'Y', joiningDate: '2026-02-01', branchId: F.branchHQ } });
    expect(dupNumber.status).toBe(409);
    const badBranch = await api.request('POST', `/orgs/${F.orgA}/employees`, { user: F.ownerA, body: { employeeNumber: 'E-004', firstName: 'X', lastName: 'Y', joiningDate: '2026-02-01', branchId: F.branchBHQ } });
    expect(badBranch.status).toBe(400);
  });

  it('PATCH with a branch change closes the current history row and opens a new one; rejects dates before joining', async () => {
    const early = await api.request('PATCH', `/orgs/${F.orgA}/employees/${createdId}`, { user: F.ownerA, body: { branchId: F.branchB2, effectiveFrom: '2025-12-31' } });
    expect(early.status).toBe(400);
    const res = await api.request('PATCH', `/orgs/${F.orgA}/employees/${createdId}`, { user: F.ownerA, body: { branchId: F.branchB2, employmentType: 'contract', effectiveFrom: '2026-06-01', changeReason: 'Transfer', phone: '+968 9000 0000' } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ branchId: F.branchB2, branchName: 'A Branch 2', employmentType: 'contract', phone: '+968 9000 0000' });
    const history = await api.request('GET', `/orgs/${F.orgA}/employees/${createdId}/history`, { user: F.ownerA });
    expect(history.json.data).toHaveLength(2);
    expect(history.json.data[0]).toMatchObject({ effectiveFrom: '2026-06-01', effectiveTo: null, branchId: F.branchB2, employmentType: 'contract', reason: 'Transfer' });
    expect(history.json.data[1]).toMatchObject({ effectiveFrom: '2026-02-01', effectiveTo: '2026-06-01', branchId: F.branchHQ });
    const sameDay = await api.request('PATCH', `/orgs/${F.orgA}/employees/${createdId}`, { user: F.ownerA, body: { departmentId: F.deptSales, effectiveFrom: '2026-06-01' } });
    expect(sameDay.status).toBe(200);
    expect((await api.request('GET', `/orgs/${F.orgA}/employees/${createdId}/history`, { user: F.ownerA })).json.data).toHaveLength(2);
    const detail = await api.request('GET', `/orgs/${F.orgA}/employees/${createdId}`, { user: F.ownerA });
    expect(detail.json.data.currentHistory).toMatchObject({ departmentId: F.deptSales, branchId: F.branchB2 });
    const noTransition = await api.request('PATCH', `/orgs/${F.orgA}/employees/${createdId}`, { user: F.ownerA, body: { displayNameAr: 'نور' } });
    expect(noTransition.status).toBe(200);
    expect((await api.request('GET', `/orgs/${F.orgA}/employees/${createdId}/history`, { user: F.ownerA })).json.data).toHaveLength(2);
    const events = await api.tdb.adminDb.selectFrom('domainEvents').select('eventType').where('aggregateId', '=', createdId).execute();
    expect(events.filter((e) => e.eventType === 'employee.updated').length).toBeGreaterThanOrEqual(3);
  });

  it('device states and identity documents (sensitive reads are audited)', async () => {
    const devices = await api.request('GET', `/orgs/${F.orgA}/employees/${F.empE1}/devices`, { user: F.ownerA });
    expect(devices.json.data).toHaveLength(1);
    expect(devices.json.data[0]).toMatchObject({ deviceCode: 'A-DEV-1', syncStatus: 'IN_SYNC', connectionStatus: 'online' });
    const denied = await api.request('GET', `/orgs/${F.orgA}/employees/${F.empE1}/documents`, { user: F.hrUserA }); // hr_user lacks employee.view_sensitive
    expect(denied.status).toBe(403);
    const doc = await api.request('POST', `/orgs/${F.orgA}/employees/${F.empE1}/documents`, { user: F.ownerA, body: { type: 'civil_id', number: '12345678', issuingCountry: 'OM', expiresAt: '2030-01-01' } });
    expect(doc.status).toBe(201);
    const list = await api.request('GET', `/orgs/${F.orgA}/employees/${F.empE1}/documents`, { user: F.ownerA });
    expect(list.json.data).toHaveLength(1);
    const audit = await api.tdb.adminDb.selectFrom('audit.logs').select(['action', 'newValue']).where('organizationId', '=', F.orgA).where('action', 'in', ['employee.sensitive_viewed', 'employee.document_added']).orderBy('id').execute();
    expect(audit.map((a) => a.action)).toEqual(['employee.document_added', 'employee.sensitive_viewed']);
    expect((audit[0]!.newValue as any).numberLast4).toBe('5678');
    expect(JSON.stringify(audit[0]!.newValue)).not.toContain('12345678');
    const del = await api.request('DELETE', `/orgs/${F.orgA}/employees/${F.empE1}/documents/${doc.json.data.id}`, { user: F.ownerA });
    expect(del.status).toBe(204);
  });

  it('soft-deletes an employee (deleted_at, terminated, exit date, history, audit, event)', async () => {
    const denied = await api.request('DELETE', `/orgs/${F.orgA}/employees/${createdId}`, { user: F.hrUserA });
    expect(denied.status).toBe(403);
    const res = await api.request('DELETE', `/orgs/${F.orgA}/employees/${createdId}`, { user: F.ownerA, body: { exitDate: '2026-08-31', reason: 'Resigned' } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ employmentStatus: 'terminated', exitDate: '2026-08-31' });
    expect(res.json.data.deletedAt).toBeTruthy();
    const list = await api.request('GET', `/orgs/${F.orgA}/employees`, { user: F.ownerA });
    expect(list.json.data.map((e: any) => e.employeeNumber)).toEqual(['E-001', 'E-002']);
    const withDeleted = await api.request('GET', `/orgs/${F.orgA}/employees?includeDeleted=true`, { user: F.ownerA });
    expect(withDeleted.json.meta.total).toBe(3);
    const history = await api.request('GET', `/orgs/${F.orgA}/employees/${createdId}/history`, { user: F.ownerA });
    expect(history.json.data[0]).toMatchObject({ effectiveFrom: '2026-08-31', employmentStatus: 'terminated' });
    expect(history.json.data[1]).toMatchObject({ effectiveTo: '2026-08-31' });
    const again = await api.request('DELETE', `/orgs/${F.orgA}/employees/${createdId}`, { user: F.ownerA });
    expect(again.status).toBe(409);
    const events = await api.tdb.adminDb.selectFrom('domainEvents').select('eventType').where('aggregateId', '=', createdId).where('eventType', '=', 'employee.deleted').execute();
    expect(events).toHaveLength(1);
  });

  it('bulk: synchronous assignment writes history; sync/export return 202 with a job id; idempotency replays the same job id', async () => {
    const assign = await api.request('POST', `/orgs/${F.orgA}/employees/bulk`, { user: F.ownerA, body: { action: 'assign_department', employeeIds: [F.empE1, F.empE2], departmentId: F.deptSales, effectiveFrom: '2026-07-01' } });
    expect(assign.status).toBe(200);
    expect(assign.json.data.updated).toBe(2); // E1: OPS → SALES, E2: none → SALES
    const hist2 = await api.request('GET', `/orgs/${F.orgA}/employees/${F.empE2}/history`, { user: F.ownerA });
    expect(hist2.json.data[0]).toMatchObject({ effectiveFrom: '2026-07-01', departmentId: F.deptSales });
    const bmDenied = await api.request('POST', `/orgs/${F.orgA}/employees/bulk`, { user: F.branchManagerA, body: { action: 'assign_branch', employeeIds: [F.empE2], branchId: F.branchHQ } });
    expect(bmDenied.status).toBe(403);
    const key = 'idem-sync-1';
    const first = await api.request('POST', `/orgs/${F.orgA}/employees/bulk`, { user: F.ownerA, body: { action: 'sync_devices', employeeIds: [F.empE1] }, headers: { 'idempotency-key': key } });
    expect(first.status).toBe(202);
    expect(first.json.data.status).toBe('QUEUED');
    const replay = await api.request('POST', `/orgs/${F.orgA}/employees/bulk`, { user: F.ownerA, body: { action: 'sync_devices', employeeIds: [F.empE1] }, headers: { 'idempotency-key': key } });
    expect(replay.status).toBe(202);
    expect(replay.json.data.jobId).toBe(first.json.data.jobId);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    const conflict = await api.request('POST', `/orgs/${F.orgA}/employees/bulk`, { user: F.ownerA, body: { action: 'sync_devices', employeeIds: [F.empE2] }, headers: { 'idempotency-key': key } });
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe('IDEMPOTENCY_CONFLICT');
    const jobs = await api.tdb.adminDb.selectFrom('jobs.queue').select('id').where('jobType', '=', 'PUSH_EMPLOYEES').where(sql`payload->>'trigger'`, '=', 'MANUAL').execute();
    expect(jobs).toHaveLength(1);
    const exp = await api.request('POST', `/orgs/${F.orgA}/employees/bulk`, { user: F.ownerA, body: { action: 'export', format: 'csv' } });
    expect(exp.status).toBe(202);
    const exportAudit = await api.tdb.adminDb.selectFrom('audit.logs').select('action').where('organizationId', '=', F.orgA).where('action', '=', 'employee.exported').execute();
    expect(exportAudit).toHaveLength(1);
  });
});

describe('imports', () => {
  let importId: string;

  it('serves the CSV template', async () => {
    const res = await api.request('GET', `/orgs/${F.orgA}/employees/imports/template`, { user: F.ownerA });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.text.split('\n')[0]).toBe('employeeNumber,firstName,middleName,lastName,displayName,gender,dateOfBirth,nationalityCode,email,phone,joiningDate,employmentStatus,employmentType,branchCode,departmentCode,designationCode,managerEmployeeNumber,deviceUserId,cardNumber');
  });

  it('validates rows (unknown branch code, duplicate employee number, in-file manager) and stores the job', async () => {
    const csv = [
      'employeeNumber,firstName,lastName,joiningDate,branchCode,departmentCode,managerEmployeeNumber,deviceUserId,email',
      'I-001,"Hamed, Jr.",Salim,2026-03-01,a-hq,OPS,E-001,,hamed@org-a.test',
      'I-002,Layla,Rashid,2026-03-01,NOPE,,I-001,,',
      'E-001,Dup,Licate,2026-03-01,A-HQ,,,,',
      'I-003,Dup,Device,2026-03-01,A-HQ,,,1,',
    ].join('\r\n');
    const denied = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.branchManagerA, body: { fileName: 'x.csv', contentBase64: b64(csv) } });
    expect(denied.status).toBe(403);
    const xlsx = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA, body: { fileName: 'x.xlsx', contentBase64: b64(csv) } });
    expect(xlsx.status).toBe(400);
    const res = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA, body: { fileName: 'staff.csv', contentBase64: b64(csv) } });
    expect(res.status).toBe(201);
    importId = res.json.data.id;
    expect(res.json.data).toMatchObject({ status: 'VALIDATED', totalRows: 4, validRows: 1, errorRows: 3, originalFilename: 'staff.csv' });
    const preview = res.json.data.preview;
    expect(preview).toHaveLength(4);
    expect(preview[0]).toMatchObject({ rowNo: 2, status: 'valid' });
    expect(preview[0].data).toMatchObject({ firstName: 'Hamed, Jr.', branchId: F.branchHQ, departmentId: F.deptOps, managerEmployeeId: F.empE1 });
    expect(preview[1].errors).toEqual([{ field: 'branchCode', message: 'Unknown branch code "NOPE"' }]);
    expect(preview[2].errors[0]).toMatchObject({ field: 'employeeNumber', message: 'Employee number already exists' });
    expect(preview[3].errors).toEqual([{ field: 'deviceUserId', message: 'Device user id already exists' }]);
    const invalidRows = await api.request('GET', `/orgs/${F.orgA}/employees/imports/${importId}?status=invalid`, { user: F.ownerA });
    expect(invalidRows.status).toBe(200);
    expect(invalidRows.json.meta.total).toBe(3);
    expect(invalidRows.json.data.rows.every((r: any) => r.status === 'invalid')).toBe(true);
    const list = await api.request('GET', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA });
    expect(list.json.data.map((j: any) => j.id)).toContain(importId);
    const missingCols = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA, body: { fileName: 'bad.csv', contentBase64: b64('firstName,lastName\nA,B') } });
    expect(missingCols.status).toBe(400);
    expect(missingCols.json.code).toBe('VALIDATION_ERROR');
  });

  it('confirm enqueues EXECUTE_IMPORT (202), sets IMPORTING and audits; cancel handles states', async () => {
    const res = await api.request('POST', `/orgs/${F.orgA}/employees/imports/${importId}/confirm`, { user: F.ownerA, headers: { 'idempotency-key': 'confirm-1' } });
    expect(res.status).toBe(202);
    expect(res.json.data.status).toBe('QUEUED');
    const jobs = await api.tdb.adminDb.selectFrom('jobs.queue').select(['id', 'queueName', 'payload']).where('jobType', '=', 'EXECUTE_IMPORT').execute();
    expect(jobs).toHaveLength(1);
    expect(String(jobs[0]!.id)).toBe(res.json.data.jobId);
    expect(jobs[0]).toMatchObject({ queueName: 'processing' });
    expect((jobs[0]!.payload as any).importJobId).toBe(importId);
    const detail = await api.request('GET', `/orgs/${F.orgA}/employees/imports/${importId}`, { user: F.ownerA });
    expect(detail.json.data).toMatchObject({ status: 'IMPORTING', queueJobId: res.json.data.jobId, confirmedBy: F.ownerA });
    const replay = await api.request('POST', `/orgs/${F.orgA}/employees/imports/${importId}/confirm`, { user: F.ownerA, headers: { 'idempotency-key': 'confirm-1' } });
    expect(replay.status).toBe(202);
    expect(replay.json.data.jobId).toBe(res.json.data.jobId);
    const again = await api.request('POST', `/orgs/${F.orgA}/employees/imports/${importId}/confirm`, { user: F.ownerA });
    expect(again.status).toBe(409);
    const audit = await api.tdb.adminDb.selectFrom('audit.logs').select('action').where('entityId', '=', importId).orderBy('id').execute();
    expect(audit.map((a) => a.action)).toEqual(['employee.import_uploaded', 'employee.import_confirmed']);
    const event = await api.tdb.adminDb.selectFrom('domainEvents').select('eventType').where('aggregateId', '=', importId).execute();
    expect(event.map((e) => e.eventType)).toEqual(['employee.imported']);
    // job still pending → cancellable
    const cancel = await api.request('POST', `/orgs/${F.orgA}/employees/imports/${importId}/cancel`, { user: F.ownerA });
    expect(cancel.status).toBe(200);
    expect(cancel.json.data.status).toBe('CANCELLED');
    expect(await api.tdb.adminDb.selectFrom('jobs.queue').select('id').where('jobType', '=', 'EXECUTE_IMPORT').execute()).toHaveLength(0);
  });
});

describe('search & dashboard', () => {
  it('search returns scoped results per type', async () => {
    const res = await api.request('GET', `/orgs/${F.orgA}/search?q=a`, { user: F.ownerA });
    expect(res.status).toBe(200);
    expect(res.json.data.employees.map((e: any) => e.subtitle).sort()).toEqual(['E-001', 'E-002']);
    expect(res.json.data.devices[0]).toMatchObject({ type: 'device', title: 'A Device 1' });
    expect(res.json.data.branches.length).toBeGreaterThanOrEqual(2);
    const bm = await api.request('GET', `/orgs/${F.orgA}/search?q=a&types=employee,device`, { user: F.branchManagerA });
    expect(bm.json.data.employees.map((e: any) => e.subtitle)).toEqual(['E-002']);
    expect(bm.json.data.devices).toEqual([]); // device is in HQ, outside the manager's scope
    expect(bm.json.data.branches).toEqual([]);
    const sn = await api.request('GET', `/orgs/${F.orgA}/search?q=SN-A`, { user: F.ownerA });
    expect(sn.json.data.devices).toHaveLength(1);
    expect((await api.request('GET', `/orgs/${F.orgA}/search`, { user: F.ownerA })).status).toBe(400);
  });

  it('dashboard summary/trends/branches aggregate the seeded records', async () => {
    const res = await api.request('GET', `/orgs/${F.orgA}/dashboard/summary?date=${F.RECORD_DATE}`, { user: F.ownerA });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ date: F.RECORD_DATE, employees: 2, presentToday: 1, absent: 1, late: 1, overtimeMinutes: 30, devicesOnline: 1, devicesOffline: 0, syncFailures24h: 1, pendingApprovals: 1 });
    const scoped = await api.request('GET', `/orgs/${F.orgA}/dashboard/summary?date=${F.RECORD_DATE}`, { user: F.branchManagerA });
    expect(scoped.json.data).toMatchObject({ employees: 1, presentToday: 0, absent: 1, devicesOnline: 0, syncFailures24h: 0, pendingApprovals: 0 });
    const trends = await api.request('GET', `/orgs/${F.orgA}/dashboard/trends?from=2026-08-31&to=2026-09-02`, { user: F.ownerA });
    expect(trends.json.data).toHaveLength(3);
    expect(trends.json.data[1]).toMatchObject({ date: F.RECORD_DATE, present: 1, absent: 1, late: 1, overtimeMinutes: 30 });
    expect(trends.json.data[0]).toMatchObject({ present: 0, absent: 0 });
    const tooLong = await api.request('GET', `/orgs/${F.orgA}/dashboard/trends?from=2026-01-01&to=2026-12-31`, { user: F.ownerA });
    expect(tooLong.status).toBe(400);
    const branches = await api.request('GET', `/orgs/${F.orgA}/dashboard/branches?date=${F.RECORD_DATE}`, { user: F.ownerA });
    const hq = branches.json.data.find((b: any) => b.branchId === F.branchHQ);
    expect(hq).toMatchObject({ branchCode: 'A-HQ', employees: 1, present: 1, late: 1, devicesOnline: 1 });
    const denied = await api.request('GET', `/orgs/${F.orgB}/dashboard/summary`, { user: F.ownerA });
    expect(denied.status).toBe(403);
  });
});
