import { sql } from 'kysely';
import { EMPLOYEE_IMPORT_COLUMNS, employeeImportRowSchema, type ImportJobDto, type ImportJobRowDto, type ImportRowError, type ImportUploadInput, type PaginationQuery } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import { errors, chunk } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requirePermission } from '../lib/authorize.js';
import { type Actor, runUser, audit } from '../lib/service.js';
import { enqueueJob } from '../lib/jobs.js';
import { csvToObjects, parseCsv, toCsvLine } from '../lib/csv.js';
import { pageOf, toCount } from '../lib/pagination.js';
import { isoDateTime, isoDateTimeOrNull, jsonArray, jsonObject } from '../lib/mappers.js';

const MAX_ROWS = 5000;
const PREVIEW_ROWS = 50;
const REQUIRED_COLUMNS = ['employeeNumber', 'firstName', 'lastName', 'joiningDate', 'branchCode'] as const;

export function templateCsv(): string {
  return `${toCsvLine(EMPLOYEE_IMPORT_COLUMNS)}\n`;
}

const JOB_COLUMNS = ['i.id', 'i.organizationId', 'i.type', 'i.originalFilename', 'i.status', 'i.totalRows', 'i.validRows', 'i.errorRows', 'i.importedRows', 'i.options', 'i.summary', 'i.error', 'i.queueJobId', 'i.requestedBy', 'i.confirmedBy', 'i.confirmedAt', 'i.createdAt', 'i.updatedAt', 'u.fullName as requestedByName'] as const;
interface JobRow { id: string; organizationId: string; type: string; originalFilename: string | null; status: ImportJobDto['status']; totalRows: number; validRows: number; errorRows: number; importedRows: number; options: unknown; summary: unknown; error: string | null; queueJobId: string | null; requestedBy: string | null; confirmedBy: string | null; confirmedAt: Date | null; createdAt: Date; updatedAt: Date; requestedByName: string | null }

function toJobDto(r: JobRow, preview?: ImportJobRowDto[]): ImportJobDto {
  return {
    id: r.id, organizationId: r.organizationId, type: r.type, originalFilename: r.originalFilename, status: r.status, totalRows: r.totalRows, validRows: r.validRows, errorRows: r.errorRows, importedRows: r.importedRows,
    options: jsonObject(r.options), summary: r.summary ? jsonObject(r.summary) : null, error: r.error, queueJobId: r.queueJobId === null ? null : String(r.queueJobId), requestedBy: r.requestedBy, requestedByName: r.requestedByName,
    confirmedBy: r.confirmedBy, confirmedAt: isoDateTimeOrNull(r.confirmedAt), createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt), preview,
  };
}
function toRowDto(r: { id: string; rowNo: number; data: unknown; errors: unknown; status: ImportJobRowDto['status']; entityId: string | null }): ImportJobRowDto {
  return { id: String(r.id), rowNo: r.rowNo, data: jsonObject(r.data), errors: jsonArray<ImportRowError>(r.errors), status: r.status, entityId: r.entityId };
}

function jobQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('importJobs as i').leftJoin('userProfiles as u', 'u.id', 'i.requestedBy').where('i.organizationId', '=', orgId).where('i.type', '=', 'EMPLOYEES');
}

async function loadJob(trx: Trx, orgId: string, id: string): Promise<JobRow> {
  const row = await jobQuery(trx, orgId).select(JOB_COLUMNS).where('i.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Import job', id);
  return row as JobRow;
}

interface ValidatedRow { rowNo: number; data: Record<string, unknown>; errors: ImportRowError[] }

/** Header normalisation: case-insensitive match on the template column names (spaces/underscores ignored). */
function normaliseHeader(header: string[]): string[] {
  const canonical = new Map(EMPLOYEE_IMPORT_COLUMNS.map((c) => [c.toLowerCase().replace(/[\s_-]/g, ''), c]));
  return header.map((h) => canonical.get(h.toLowerCase().replace(/[\s_-]/g, '')) ?? h);
}

export async function createImport(deps: ApiDeps, actor: Actor, orgId: string, input: { fileName: string; content: string; options: ImportUploadInput['options'] }): Promise<ImportJobDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.import');
  const lower = input.fileName.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) throw errors.validation('XLSX files are not supported by the API yet; export the sheet as CSV (UTF-8).', { issues: [{ path: 'fileName', message: 'Unsupported format' }] });
  const parsed = parseCsv(input.content, { maxRows: MAX_ROWS });
  parsed.header = normaliseHeader(parsed.header);
  const duplicates = [...new Set(parsed.header.filter((h, i) => h && parsed.header.indexOf(h) !== i))];
  if (duplicates.length) throw errors.validation(`Duplicate columns: ${duplicates.join(', ')}.`, { issues: duplicates.map((d) => ({ path: d, message: 'Duplicate column' })) });
  const missing = REQUIRED_COLUMNS.filter((c) => !parsed.header.includes(c));
  if (missing.length) throw errors.validation(`Missing required columns: ${missing.join(', ')}.`, { issues: missing.map((m) => ({ path: m, message: 'Missing column' })) });
  if (parsed.rows.length === 0) throw errors.validation('The file has no data rows.');
  if (parsed.rows.length > MAX_ROWS) throw errors.validation(`The file has more than ${MAX_ROWS} rows.`);
  const objects = csvToObjects(parsed);

  return runUser(deps.db, actor, async (trx) => {
    // Reference data (RLS-scoped): codes → ids
    const branches = new Map((await trx.selectFrom('branches').select(['id', 'code', 'status']).where('organizationId', '=', orgId).execute()).map((b) => [String(b.code).toLowerCase(), b]));
    const departments = new Map((await trx.selectFrom('departments').select(['id', 'code']).where('organizationId', '=', orgId).where('status', '!=', 'archived').execute()).map((d) => [String(d.code).toLowerCase(), d.id]));
    const designations = new Map((await trx.selectFrom('designations').select(['id', 'code']).where('organizationId', '=', orgId).where('status', '!=', 'archived').execute()).map((d) => [String(d.code).toLowerCase(), d.id]));
    const numbers = [...new Set(objects.flatMap((o) => [o['employeeNumber'], o['managerEmployeeNumber']]).filter((v): v is string => !!v).map((v) => v.toLowerCase()))];
    const deviceIds = [...new Set(objects.map((o) => o['deviceUserId']).filter((v): v is string => !!v))];
    const emails = [...new Set(objects.map((o) => o['email']).filter((v): v is string => !!v).map((v) => v.toLowerCase()))];
    const existingByNumber = new Map<string, { id: string; deletedAt: Date | null }>();
    for (const part of chunk(numbers, 500)) for (const e of await trx.selectFrom('employees').select(['id', 'employeeNumber', 'deletedAt']).where('organizationId', '=', orgId).where(sql`lower(employee_number::text)`, 'in', part).execute()) existingByNumber.set(String(e.employeeNumber).toLowerCase(), e);
    const existingDeviceIds = new Set<string>();
    for (const part of chunk(deviceIds, 500)) for (const e of await trx.selectFrom('employees').select('deviceUserId').where('organizationId', '=', orgId).where('deviceUserId', 'in', part).execute()) existingDeviceIds.add(e.deviceUserId);
    const existingEmails = new Set<string>();
    for (const part of chunk(emails, 500)) for (const e of await trx.selectFrom('employees').select('email').where('organizationId', '=', orgId).where('deletedAt', 'is', null).where(sql`lower(email::text)`, 'in', part).execute()) if (e.email) existingEmails.add(String(e.email).toLowerCase());

    const seenNumbers = new Map<string, number>(); const seenDeviceIds = new Map<string, number>(); const seenEmails = new Map<string, number>();
    const fileNumbers = new Set(objects.map((o) => o['employeeNumber']?.toLowerCase()).filter(Boolean));
    const rows: ValidatedRow[] = objects.map((raw, idx) => {
      const rowNo = idx + 2; // 1-based, header is row 1
      const rowErrors: ImportRowError[] = [];
      const res = employeeImportRowSchema.safeParse(raw);
      // PINs are never persisted or echoed in clear (valid or invalid rows); the worker asks for them out of band.
      const data: Record<string, unknown> = { ...raw };
      if (raw['pin'] !== undefined) { data['pin'] = '[REDACTED]'; data['pinProvided'] = true; }
      if (!res.success) {
        for (const issue of res.error.issues) rowErrors.push({ field: issue.path.join('.') || null, message: issue.message });
        return { rowNo, data, errors: rowErrors };
      }
      const { pin: _pin, ...v } = res.data;
      Object.assign(data, v);
      const numberKey = v.employeeNumber.toLowerCase();
      const branch = branches.get(v.branchCode.toLowerCase());
      if (!branch) rowErrors.push({ field: 'branchCode', message: `Unknown branch code "${v.branchCode}"` });
      else if (branch.status === 'archived') rowErrors.push({ field: 'branchCode', message: `Branch "${v.branchCode}" is archived` });
      else {
        data['branchId'] = branch.id;
        if (!grant.allBranches && !grant.branchIds.includes(branch.id)) rowErrors.push({ field: 'branchCode', message: 'Branch is outside your access scope' });
      }
      if (v.departmentCode) { const d = departments.get(v.departmentCode.toLowerCase()); if (d) data['departmentId'] = d; else rowErrors.push({ field: 'departmentCode', message: `Unknown department code "${v.departmentCode}"` }); }
      if (v.designationCode) { const d = designations.get(v.designationCode.toLowerCase()); if (d) data['designationId'] = d; else rowErrors.push({ field: 'designationCode', message: `Unknown designation code "${v.designationCode}"` }); }
      if (v.managerEmployeeNumber) {
        const mk = v.managerEmployeeNumber.toLowerCase();
        const existing = existingByNumber.get(mk);
        if (existing && !existing.deletedAt) data['managerEmployeeId'] = existing.id;
        else if (!fileNumbers.has(mk)) rowErrors.push({ field: 'managerEmployeeNumber', message: `Manager "${v.managerEmployeeNumber}" not found in the organisation or in this file` });
        if (mk === numberKey) rowErrors.push({ field: 'managerEmployeeNumber', message: 'An employee cannot be their own manager' });
      }
      const dupRow = seenNumbers.get(numberKey);
      if (dupRow) rowErrors.push({ field: 'employeeNumber', message: `Duplicate employee number in file (also on row ${dupRow})` });
      else seenNumbers.set(numberKey, rowNo);
      const existing = existingByNumber.get(numberKey);
      if (existing) {
        if (input.options.updateExisting && !existing.deletedAt) data['existingEmployeeId'] = existing.id;
        else rowErrors.push({ field: 'employeeNumber', message: existing.deletedAt ? 'Employee number belongs to a deleted employee' : 'Employee number already exists' });
      }
      if (v.deviceUserId) {
        const dup = seenDeviceIds.get(v.deviceUserId);
        if (dup) rowErrors.push({ field: 'deviceUserId', message: `Duplicate device user id in file (also on row ${dup})` }); else seenDeviceIds.set(v.deviceUserId, rowNo);
        if (existingDeviceIds.has(v.deviceUserId) && !data['existingEmployeeId']) rowErrors.push({ field: 'deviceUserId', message: 'Device user id already exists' });
      }
      if (v.email) {
        const ek = v.email.toLowerCase();
        const dup = seenEmails.get(ek);
        if (dup) rowErrors.push({ field: 'email', message: `Duplicate email in file (also on row ${dup})` }); else seenEmails.set(ek, rowNo);
        if (existingEmails.has(ek) && !data['existingEmployeeId']) rowErrors.push({ field: 'email', message: 'Email already used by another employee' });
      }
      return { rowNo, data, errors: rowErrors };
    });

    const validRows = rows.filter((r) => r.errors.length === 0).length;
    const errorRows = rows.length - validRows;
    const job = await trx.insertInto('importJobs').values({
      organizationId: orgId, type: 'EMPLOYEES', filePath: `imports/${orgId}/${Date.now()}/${input.fileName.replace(/[^\w.-]+/g, '_')}`, originalFilename: input.fileName,
      status: 'VALIDATED', totalRows: rows.length, validRows, errorRows, options: JSON.stringify(input.options ?? {}), requestedBy: actor.userId,
      summary: JSON.stringify({ columns: parsed.header, delimiterDetected: true, validatedAt: new Date().toISOString() }),
    }).returning('id').executeTakeFirstOrThrow();
    for (const part of chunk(rows, 500)) {
      await trx.insertInto('importJobRows').values(part.map((r) => ({ organizationId: orgId, importJobId: job.id, rowNo: r.rowNo, data: JSON.stringify(r.data), errors: JSON.stringify(r.errors), status: r.errors.length ? 'invalid' as const : 'valid' as const }))).execute();
    }
    await audit(trx, actor, orgId, 'employee.import_uploaded', 'import_job', { entityId: job.id, newValue: { fileName: input.fileName, totalRows: rows.length, validRows, errorRows, options: input.options } });
    const preview = rows.slice(0, PREVIEW_ROWS).map((r) => ({ id: `${job.id}:${r.rowNo}`, rowNo: r.rowNo, data: r.data, errors: r.errors, status: r.errors.length ? 'invalid' as const : 'valid' as const, entityId: null }));
    return toJobDto(await loadJob(trx, orgId, job.id), preview);
  });
}

export async function listImports(deps: ApiDeps, actor: Actor, orgId: string, q: PaginationQuery & { status?: ImportJobDto['status'] }): Promise<{ data: ImportJobDto[]; total: number }> {
  requirePermission(actor.principal, orgId, 'employee.import');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = jobQuery(trx, orgId);
    if (q.status) base = base.where('i.status', '=', q.status);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(JOB_COLUMNS).orderBy('i.createdAt', 'desc').limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map((r) => toJobDto(r as JobRow)), total };
  });
}

export async function getImport(deps: ApiDeps, actor: Actor, orgId: string, id: string, rowsQuery: PaginationQuery & { status?: ImportJobRowDto['status'] }): Promise<{ job: ImportJobDto; rows: ImportJobRowDto[]; total: number }> {
  requirePermission(actor.principal, orgId, 'employee.import');
  return runUser(deps.db, actor, async (trx) => {
    const job = await loadJob(trx, orgId, id);
    const page = pageOf(rowsQuery);
    let base = trx.selectFrom('importJobRows').where('organizationId', '=', orgId).where('importJobId', '=', id);
    if (rowsQuery.status) base = base.where('status', '=', rowsQuery.status);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(['id', 'rowNo', 'data', 'errors', 'status', 'entityId']).orderBy('rowNo').limit(page.pageSize).offset(page.offset).execute();
    return { job: toJobDto(job), rows: rows.map(toRowDto), total };
  });
}

export async function confirmImport(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<{ jobId: string; importJobId: string }> {
  requirePermission(actor.principal, orgId, 'employee.import', 'employee.create');
  return runUser(deps.db, actor, async (trx) => {
    const job = await loadJob(trx, orgId, id);
    if (job.status !== 'VALIDATED') throw errors.invalidState(`Only validated imports can be confirmed (current status ${job.status}).`);
    if (job.validRows === 0) throw errors.invalidState('The import has no valid rows.');
    const jobId = await enqueueJob(deps.queue, trx, { queue: 'processing', jobType: 'EXECUTE_IMPORT', organizationId: orgId, payload: { importJobId: id, requestedBy: actor.userId }, dedupeKey: `import:${id}`, correlationId: actor.requestId, maxAttempts: 3, lockTimeoutSeconds: 1800 });
    await trx.updateTable('importJobs').set({ status: 'IMPORTING', confirmedBy: actor.userId, confirmedAt: new Date(), queueJobId: jobId }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'employee.import_confirmed', 'import_job', { entityId: id, newValue: { validRows: job.validRows, errorRows: job.errorRows, jobId } });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.imported', aggregateType: 'import_job', aggregateId: id, payload: { phase: 'queued', validRows: job.validRows, jobId }, actorUserId: actor.userId, requestId: actor.requestId });
    return { jobId, importJobId: id };
  });
}

export async function cancelImport(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<ImportJobDto> {
  requirePermission(actor.principal, orgId, 'employee.import');
  return runUser(deps.db, actor, async (trx) => {
    const job = await loadJob(trx, orgId, id);
    if (!['UPLOADED', 'VALIDATING', 'VALIDATED', 'IMPORTING'].includes(job.status)) throw errors.invalidState(`The import cannot be cancelled in status ${job.status}.`);
    if (job.status === 'IMPORTING') {
      const cancelled = job.queueJobId ? await deps.queue.cancel(String(job.queueJobId)) : false;
      if (!cancelled) throw errors.invalidState('The import is already running and cannot be cancelled.');
    }
    await trx.updateTable('importJobs').set({ status: 'CANCELLED' }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'employee.import_cancelled', 'import_job', { entityId: id, oldValue: { status: job.status }, newValue: { status: 'CANCELLED' } });
    return toJobDto(await loadJob(trx, orgId, id));
  });
}
