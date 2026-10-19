import { sql } from 'kysely';
import {
  EMPLOYEE_IMPORT_COLUMNS, ORG_UNIT_IMPORT_COLUMNS, ORG_UNIT_IMPORT_REQUIRED_COLUMNS, employeeImportRowSchema, employeeImportUpdateRowSchema, orgUnitImportRowSchema,
  type ImportJobDto, type ImportJobRowDto, type ImportKind, type ImportRowError, type ImportSource, type ImportUploadInput, type PaginationQuery,
} from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors, chunk } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { hasPermission, requirePermission } from '../lib/authorize.js';
import { type Actor, runUser, audit } from '../lib/service.js';
import { enqueueJob } from '../lib/jobs.js';
import { csvToObjects, parseCsv, toCsvLine, type ParsedCsv } from '../lib/csv.js';
import { excelSerialToIsoDate, looksLikeZip, parseXlsx } from '../lib/xlsx.js';
import { pageOf, toCount } from '../lib/pagination.js';
import { isoDate, isoDateTime, isoDateTimeOrNull, jsonArray, jsonObject } from '../lib/mappers.js';
import { assertUserCapacity } from './features/user-limit.js';

const MAX_ROWS = 5000;
const PREVIEW_ROWS = 50;
const REQUIRED_COLUMNS = ['employeeNumber', 'firstName', 'lastName', 'joiningDate', 'branchCode'] as const;
const DATE_FIELDS = ['joiningDate', 'dateOfBirth', 'exitDate'] as const;
const ENUM_FIELDS = ['gender', 'employmentStatus', 'employmentType', 'status'] as const;

export function templateCsv(kind: ImportKind = 'EMPLOYEES'): string {
  return `${toCsvLine(kind === 'ORG_UNITS' ? ORG_UNIT_IMPORT_COLUMNS : EMPLOYEE_IMPORT_COLUMNS)}\n`;
}

const JOB_COLUMNS = ['i.id', 'i.organizationId', 'i.type', 'i.source', 'i.originalFilename', 'i.status', 'i.totalRows', 'i.validRows', 'i.errorRows', 'i.importedRows', 'i.options', 'i.summary', 'i.error', 'i.queueJobId', 'i.requestedBy', 'i.confirmedBy', 'i.confirmedAt', 'i.createdAt', 'i.updatedAt', 'u.fullName as requestedByName'] as const;
interface JobRow { id: string; organizationId: string; type: string; source: string; originalFilename: string | null; status: ImportJobDto['status']; totalRows: number; validRows: number; errorRows: number; importedRows: number; options: unknown; summary: unknown; error: string | null; queueJobId: string | null; requestedBy: string | null; confirmedBy: string | null; confirmedAt: Date | null; createdAt: Date; updatedAt: Date; requestedByName: string | null }

function toJobDto(r: JobRow, preview?: ImportJobRowDto[]): ImportJobDto {
  return {
    id: r.id, organizationId: r.organizationId, type: r.type, source: r.source === 'hrms' ? 'hrms' : 'upload', originalFilename: r.originalFilename, status: r.status, totalRows: r.totalRows, validRows: r.validRows, errorRows: r.errorRows, importedRows: r.importedRows,
    options: jsonObject(r.options), summary: r.summary ? jsonObject(r.summary) : null, error: r.error, queueJobId: r.queueJobId === null ? null : String(r.queueJobId), requestedBy: r.requestedBy, requestedByName: r.requestedByName,
    confirmedBy: r.confirmedBy, confirmedAt: isoDateTimeOrNull(r.confirmedAt), createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt), preview,
  };
}

/** A civil ID is sensitive (AGENTS.md "Exports"): rows show its last four characters unless the reader holds employee.view_sensitive. */
export function maskRowData(data: Record<string, unknown>, canSeeSensitive: boolean): Record<string, unknown> {
  if (canSeeSensitive || typeof data['civilId'] !== 'string') return data;
  const v = data['civilId'] as string;
  return { ...data, civilId: `****${v.slice(-4)}` };
}

function toRowDto(r: { id: string; rowNo: number; data: unknown; errors: unknown; status: ImportJobRowDto['status']; entityId: string | null }, canSeeSensitive: boolean): ImportJobRowDto {
  return { id: String(r.id), rowNo: r.rowNo, data: maskRowData(jsonObject(r.data), canSeeSensitive), errors: jsonArray<ImportRowError>(r.errors), status: r.status, entityId: r.entityId };
}

function jobQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('importJobs as i').leftJoin('userProfiles as u', 'u.id', 'i.requestedBy').where('i.organizationId', '=', orgId);
}

async function loadJob(trx: Trx, orgId: string, id: string): Promise<JobRow> {
  const row = await jobQuery(trx, orgId).select(JOB_COLUMNS).where('i.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Import job', id);
  return row as JobRow;
}

export interface ValidatedRow { rowNo: number; data: Record<string, unknown>; errors: ImportRowError[] }
export type RawObject = Record<string, string | undefined>;
/** The branches a validation may touch: a membership's scope, or null for the organisation's system context (every branch). */
export type ImportScope = Pick<MembershipGrant, 'allBranches' | 'branchIds'> | null;
const inScope = (scope: ImportScope, branchId: string) => !scope || scope.allBranches || scope.branchIds.includes(branchId);

/** Header normalisation: case-insensitive match on the template column names (spaces/underscores ignored). */
function normaliseHeader(header: string[], columns: readonly string[]): string[] {
  const canonical = new Map(columns.map((c) => [c.toLowerCase().replace(/[\s_-]/g, ''), c]));
  return header.map((h) => canonical.get(h.toLowerCase().replace(/[\s_-]/g, '')) ?? h);
}

/** An uploaded file (CSV, or an .xlsx workbook recognised by its name or its ZIP signature) as header + rows. */
export function decodeUpload(fileName: string, bytes: Buffer): { parsed: ParsedCsv; format: 'csv' | 'xlsx' } {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xls')) throw errors.validation('Old Excel files (.xls) are not supported: save the workbook as .xlsx, or export the sheet as CSV (UTF-8).', { issues: [{ path: 'fileName', message: 'Unsupported format' }] });
  if (lower.endsWith('.xlsx') || looksLikeZip(bytes)) return { parsed: parseXlsx(bytes, { maxRows: MAX_ROWS }), format: 'xlsx' };
  return { parsed: parseCsv(bytes.toString('utf8'), { maxRows: MAX_ROWS }), format: 'csv' };
}

/**
 * Value clean-up shared by files and HRMS batches: dates written DD/MM/YYYY (or an ISO date-time, or an Excel serial number
 * from a cell that was not formatted as a date) become YYYY-MM-DD; enum labels are lower-cased with spaces as underscores
 * ("Full Time" → full_time). Anything still invalid is reported by the row schema.
 */
export function normaliseValues(obj: RawObject, opts: { excelSerials?: boolean } = {}): RawObject {
  const out: RawObject = { ...obj };
  for (const f of DATE_FIELDS) {
    const v = out[f];
    if (!v) continue;
    const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
    if (dmy) out[f] = `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
    else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(v)) out[f] = v.slice(0, 10);
    else if (opts.excelSerials && /^\d{4,5}(\.\d+)?$/.test(v)) out[f] = excelSerialToIsoDate(Number(v)) ?? v;
  }
  for (const f of ENUM_FIELDS) {
    const v = out[f];
    if (v) out[f] = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  }
  return out;
}

export interface EmployeeValidationOptions {
  updateExisting: boolean;
  scope: ImportScope;
  /** May the rows carry a civil ID (employee.view_sensitive, or an HR system feed the organisation configured)? */
  canWriteSensitive: boolean;
  /** Branch of a new employee whose row names none (HRMS setting). */
  defaultBranchCode?: string | null;
  /** Number of the first row (2 for a file: row 1 is the header; 1 for an HRMS batch: record 1). */
  firstRowNo?: number;
}

/**
 * Validates employee rows against the organisation (codes → ids, duplicates, scope) under the RLS of `trx`. A row whose
 * employee number exists is an UPDATE when `updateExisting` (only the fields present change), else an error. Shared by the
 * import page and the HRMS inbound batches, so both obey the same rules; the worker (EXECUTE_IMPORT) applies the valid rows.
 */
export async function validateEmployeeRows(trx: Trx, orgId: string, objects: RawObject[], opts: EmployeeValidationOptions): Promise<ValidatedRow[]> {
  // Reference data: codes → ids
  const branches = new Map((await trx.selectFrom('branches').select(['id', 'code', 'status']).where('organizationId', '=', orgId).execute()).map((b) => [String(b.code).toLowerCase(), b]));
  const departments = new Map((await trx.selectFrom('departments').select(['id', 'code']).where('organizationId', '=', orgId).where('status', '!=', 'archived').execute()).map((d) => [String(d.code).toLowerCase(), d.id]));
  const designations = new Map((await trx.selectFrom('designations').select(['id', 'code']).where('organizationId', '=', orgId).where('status', '!=', 'archived').execute()).map((d) => [String(d.code).toLowerCase(), d.id]));
  const numbers = [...new Set(objects.flatMap((o) => [o['employeeNumber'], o['managerEmployeeNumber']]).filter((v): v is string => !!v).map((v) => v.toLowerCase()))];
  const deviceIds = [...new Set(objects.map((o) => o['deviceUserId']).filter((v): v is string => !!v))];
  const emails = [...new Set(objects.map((o) => o['email']).filter((v): v is string => !!v).map((v) => v.toLowerCase()))];
  const existingByNumber = new Map<string, { id: string; deletedAt: Date | null; branchId: string; joiningDate: Date | string }>();
  for (const part of chunk(numbers, 500)) for (const e of await trx.selectFrom('employees').select(['id', 'employeeNumber', 'deletedAt', 'branchId', 'joiningDate']).where('organizationId', '=', orgId).where(sql`lower(employee_number::text)`, 'in', part).execute()) existingByNumber.set(String(e.employeeNumber).toLowerCase(), e);
  const deviceIdOwner = new Map<string, string>();
  for (const part of chunk(deviceIds, 500)) for (const e of await trx.selectFrom('employees').select(['id', 'deviceUserId']).where('organizationId', '=', orgId).where('deviceUserId', 'in', part).execute()) deviceIdOwner.set(e.deviceUserId, e.id);
  const emailOwner = new Map<string, string>();
  for (const part of chunk(emails, 500)) for (const e of await trx.selectFrom('employees').select(['id', 'email']).where('organizationId', '=', orgId).where('deletedAt', 'is', null).where(sql`lower(email::text)`, 'in', part).execute()) if (e.email) emailOwner.set(String(e.email).toLowerCase(), e.id);

  const seenNumbers = new Map<string, number>(); const seenDeviceIds = new Map<string, number>(); const seenEmails = new Map<string, number>();
  const fileNumbers = new Set(objects.map((o) => o['employeeNumber']?.toLowerCase()).filter(Boolean));
  return objects.map((source, idx) => {
    const rowNo = idx + (opts.firstRowNo ?? 2); // 1-based, header is row 1
    const rowErrors: ImportRowError[] = [];
    const raw = { ...source };
    const numberKey = raw['employeeNumber']?.toLowerCase();
    const existing = numberKey ? existingByNumber.get(numberKey) : undefined;
    const isUpdate = !!existing && !existing.deletedAt && opts.updateExisting;
    if (!isUpdate && !raw['branchCode'] && opts.defaultBranchCode) raw['branchCode'] = opts.defaultBranchCode;
    // PINs are never persisted or echoed in clear (valid or invalid rows); the worker asks for them out of band.
    const data: Record<string, unknown> = { ...raw };
    if (raw['pin'] !== undefined) { data['pin'] = '[REDACTED]'; data['pinProvided'] = true; }
    if (existing && !isUpdate) rowErrors.push({ field: 'employeeNumber', message: existing.deletedAt ? 'Employee number belongs to a deleted employee' : 'Employee number already exists' });
    const res = isUpdate ? employeeImportUpdateRowSchema.safeParse(raw) : employeeImportRowSchema.safeParse(raw);
    if (!res.success) {
      for (const issue of res.error.issues) rowErrors.push({ field: issue.path.join('.') || null, message: issue.message });
      return { rowNo, data, errors: rowErrors };
    }
    const { pin: _pin, ...v } = res.data as typeof res.data & { pin?: string };
    Object.assign(data, v);
    const key = v.employeeNumber.toLowerCase();
    if (isUpdate && existing) {
      data['existingEmployeeId'] = existing.id;
      if (!inScope(opts.scope, existing.branchId)) rowErrors.push({ field: 'employeeNumber', message: 'The employee is outside your branch scope' });
    }
    if (v.branchCode) {
      const branch = branches.get(v.branchCode.toLowerCase());
      if (!branch) rowErrors.push({ field: 'branchCode', message: `Unknown branch code "${v.branchCode}"` });
      else if (branch.status === 'archived') rowErrors.push({ field: 'branchCode', message: `Branch "${v.branchCode}" is archived` });
      else {
        data['branchId'] = branch.id;
        if (!inScope(opts.scope, branch.id)) rowErrors.push({ field: 'branchCode', message: 'Branch is outside your access scope' });
      }
    }
    if (v.departmentCode) { const d = departments.get(v.departmentCode.toLowerCase()); if (d) data['departmentId'] = d; else rowErrors.push({ field: 'departmentCode', message: `Unknown department code "${v.departmentCode}"` }); }
    if (v.designationCode) { const d = designations.get(v.designationCode.toLowerCase()); if (d) data['designationId'] = d; else rowErrors.push({ field: 'designationCode', message: `Unknown designation code "${v.designationCode}"` }); }
    if (v.managerEmployeeNumber) {
      const mk = v.managerEmployeeNumber.toLowerCase();
      const manager = existingByNumber.get(mk);
      if (manager && !manager.deletedAt) data['managerEmployeeId'] = manager.id;
      else if (!fileNumbers.has(mk)) rowErrors.push({ field: 'managerEmployeeNumber', message: `Manager "${v.managerEmployeeNumber}" not found in the organisation or in this file` });
      if (mk === key) rowErrors.push({ field: 'managerEmployeeNumber', message: 'An employee cannot be their own manager' });
    }
    if (v.civilId && !opts.canWriteSensitive) rowErrors.push({ field: 'civilId', message: 'Importing civil IDs needs the employee.view_sensitive permission' });
    const joining = v.joiningDate ?? (existing ? isoDate(existing.joiningDate) : undefined);
    if (v.exitDate && joining && v.exitDate < joining) rowErrors.push({ field: 'exitDate', message: `Must be on/after the joining date ${joining}` });
    const dupRow = seenNumbers.get(key);
    if (dupRow) rowErrors.push({ field: 'employeeNumber', message: `Duplicate employee number in file (also on row ${dupRow})` });
    else seenNumbers.set(key, rowNo);
    const selfId = isUpdate ? existing?.id : undefined;
    if (v.deviceUserId) {
      const dup = seenDeviceIds.get(v.deviceUserId);
      if (dup) rowErrors.push({ field: 'deviceUserId', message: `Duplicate device user id in file (also on row ${dup})` }); else seenDeviceIds.set(v.deviceUserId, rowNo);
      const owner = deviceIdOwner.get(v.deviceUserId);
      if (owner && owner !== selfId) rowErrors.push({ field: 'deviceUserId', message: 'Device user id already exists' });
    }
    if (v.email) {
      const ek = v.email.toLowerCase();
      const dup = seenEmails.get(ek);
      if (dup) rowErrors.push({ field: 'email', message: `Duplicate email in file (also on row ${dup})` }); else seenEmails.set(ek, rowNo);
      const owner = emailOwner.get(ek);
      if (owner && owner !== selfId) rowErrors.push({ field: 'email', message: 'Email already used by another employee' });
    }
    return { rowNo, data, errors: rowErrors };
  });
}

/**
 * Validates organisational units (departments) by code: a known code is updated, an unknown one created. Parents are named by
 * code (in the organisation or in the same file) and linked by the worker in a second pass; a parent that would close a loop
 * — through the file's rows and the existing tree together — is refused on every row of the loop, and a row whose parent row
 * is refused is refused too (its parent would not exist).
 */
export async function validateOrgUnitRows(trx: Trx, orgId: string, objects: RawObject[], opts: { scope: ImportScope; firstRowNo?: number }): Promise<ValidatedRow[]> {
  const branches = new Map((await trx.selectFrom('branches').select(['id', 'code', 'status']).where('organizationId', '=', orgId).execute()).map((b) => [String(b.code).toLowerCase(), b]));
  const existingRows = await trx.selectFrom('departments').select(['id', 'code', 'parentId', 'status', 'branchId']).where('organizationId', '=', orgId).execute();
  const existing = new Map(existingRows.map((d) => [String(d.code).toLowerCase(), d]));
  const codeById = new Map(existingRows.map((d) => [d.id, String(d.code).toLowerCase()]));
  const managerNumbers = [...new Set(objects.map((o) => o['managerEmployeeNumber']).filter((v): v is string => !!v).map((v) => v.toLowerCase()))];
  const managers = new Map<string, string>();
  for (const part of chunk(managerNumbers, 500)) for (const e of await trx.selectFrom('employees').select(['id', 'employeeNumber']).where('organizationId', '=', orgId).where('deletedAt', 'is', null).where(sql`lower(employee_number::text)`, 'in', part).execute()) managers.set(String(e.employeeNumber).toLowerCase(), e.id);

  const fileCodes = new Map<string, number>();
  const rows: Array<ValidatedRow & { code?: string; parent?: string }> = objects.map((raw, idx) => {
    const rowNo = idx + (opts.firstRowNo ?? 2);
    const data: Record<string, unknown> = { ...raw };
    const rowErrors: ImportRowError[] = [];
    const res = orgUnitImportRowSchema.safeParse(raw);
    if (!res.success) {
      for (const issue of res.error.issues) rowErrors.push({ field: issue.path.join('.') || null, message: issue.message });
      return { rowNo, data, errors: rowErrors };
    }
    const v = res.data;
    Object.assign(data, v);
    const code = v.code.toLowerCase();
    const dup = fileCodes.get(code);
    if (dup) rowErrors.push({ field: 'code', message: `Duplicate code in file (also on row ${dup})` }); else fileCodes.set(code, rowNo);
    const known = existing.get(code);
    if (known) {
      data['existingDepartmentId'] = known.id;
      if (known.status === 'archived') rowErrors.push({ field: 'code', message: `Department "${v.code}" is archived: restore it on the departments page first` });
      if (known.branchId ? !inScope(opts.scope, known.branchId) : opts.scope !== null && !opts.scope.allBranches) rowErrors.push({ field: 'code', message: 'The department is outside your branch scope' });
    }
    if (v.branchCode) {
      const branch = branches.get(v.branchCode.toLowerCase());
      if (!branch) rowErrors.push({ field: 'branchCode', message: `Unknown branch code "${v.branchCode}"` });
      else if (branch.status === 'archived') rowErrors.push({ field: 'branchCode', message: `Branch "${v.branchCode}" is archived` });
      else {
        data['branchId'] = branch.id;
        if (!inScope(opts.scope, branch.id)) rowErrors.push({ field: 'branchCode', message: 'Branch is outside your access scope' });
      }
    } else if (!known && opts.scope && !opts.scope.allBranches) {
      // a branch-scoped caller never creates an organisation-wide department (structure.service says the same)
      rowErrors.push({ field: 'branchCode', message: 'Required: you can only create departments in your own branches' });
    }
    if (v.managerEmployeeNumber) {
      const m = managers.get(v.managerEmployeeNumber.toLowerCase());
      if (m) data['managerEmployeeId'] = m; else rowErrors.push({ field: 'managerEmployeeNumber', message: `Employee "${v.managerEmployeeNumber}" not found in the organisation` });
    }
    let parent: string | undefined;
    if (v.parentCode) {
      parent = v.parentCode.toLowerCase();
      if (parent === code) rowErrors.push({ field: 'parentCode', message: 'A department cannot be its own parent' });
      else {
        const p = existing.get(parent);
        if (p && p.status !== 'archived') data['parentId'] = p.id;
        else if (!objects.some((o) => o['code']?.toLowerCase() === parent)) rowErrors.push({ field: 'parentCode', message: p ? `Parent "${v.parentCode}" is archived` : `Parent "${v.parentCode}" not found in the organisation or in this file` });
      }
    }
    return { rowNo, data, errors: rowErrors, code, parent };
  });

  // the tree after the import: existing parents, overridden by the parents the file names
  const parentOf = new Map<string, string | null>();
  for (const d of existingRows) parentOf.set(String(d.code).toLowerCase(), d.parentId ? codeById.get(d.parentId) ?? null : null);
  for (const r of rows) if (r.code && r.parent && r.errors.length === 0) parentOf.set(r.code, r.parent);
  for (const r of rows) {
    if (!r.code || !r.parent || r.errors.length > 0) continue;
    let cursor: string | null | undefined = r.parent;
    for (let depth = 0; cursor && depth < 1000; depth += 1) {
      if (cursor === r.code) { r.errors.push({ field: 'parentCode', message: 'This parent would create a cycle in the department tree' }); break; }
      cursor = parentOf.get(cursor);
    }
  }
  // a parent row of the file that is refused will not exist: its children cannot link to it
  const byCode = new Map(rows.filter((r) => r.code).map((r) => [r.code!, r]));
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows) {
      if (r.errors.length > 0 || !r.parent || existing.get(r.parent)) continue;
      const p = byCode.get(r.parent);
      if (p && p.errors.length > 0) { r.errors.push({ field: 'parentCode', message: `Parent "${String(r.data['parentCode'])}" has errors in this file` }); changed = true; }
    }
  }
  return rows.map(({ rowNo, data, errors: e }) => ({ rowNo, data, errors: e }));
}

export interface StoreImportInput {
  kind: ImportKind;
  source: ImportSource;
  fileName: string | null;
  filePath: string;
  rows: ValidatedRow[];
  options: Record<string, unknown>;
  summary: Record<string, unknown>;
  requestedBy: string | null;
  apiKeyId?: string | null;
  reference?: string | null;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}

/** Stores a validated import (status VALIDATED) and its rows; returns the import id. */
export async function storeImport(trx: Trx, orgId: string, input: StoreImportInput): Promise<string> {
  const validRows = input.rows.filter((r) => r.errors.length === 0).length;
  const job = await trx.insertInto('importJobs').values({
    organizationId: orgId, type: input.kind, source: input.source, filePath: input.filePath, originalFilename: input.fileName,
    status: 'VALIDATED', totalRows: input.rows.length, validRows, errorRows: input.rows.length - validRows, options: JSON.stringify(input.options), requestedBy: input.requestedBy,
    summary: JSON.stringify(input.summary), apiKeyId: input.apiKeyId ?? null, reference: input.reference ?? null, idempotencyKey: input.idempotencyKey ?? null, requestHash: input.requestHash ?? null,
  }).returning('id').executeTakeFirstOrThrow();
  for (const part of chunk(input.rows, 500)) {
    await trx.insertInto('importJobRows').values(part.map((r) => ({ organizationId: orgId, importJobId: job.id, rowNo: r.rowNo, data: JSON.stringify(r.data), errors: JSON.stringify(r.errors), status: r.errors.length ? 'invalid' as const : 'valid' as const }))).execute();
  }
  return job.id;
}

/** Valid rows of an employee import that would add an active (licensed) user: new employees who have not left. */
export async function countAddedUsers(trx: Trx, orgId: string, importJobId: string): Promise<number> {
  return toCount((await trx.selectFrom('importJobRows').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('importJobId', '=', importJobId)
    .where('status', '=', 'valid').where(sql`data ->> 'existingEmployeeId'`, 'is', null)
    .where(sql`coalesce(data ->> 'employmentStatus', 'active')`, 'not in', ['terminated', 'resigned']).executeTakeFirst())?.n);
}

/** Queues EXECUTE_IMPORT for a validated import (same transaction) and marks it IMPORTING; returns the queue job id. */
export async function queueImport(deps: ApiDeps, trx: Trx, orgId: string, importJobId: string, opts: { requestedBy: string | null; correlationId: string }): Promise<string> {
  const jobId = await enqueueJob(deps.queue, trx, { queue: 'processing', jobType: 'EXECUTE_IMPORT', organizationId: orgId, payload: { organizationId: orgId, importJobId, requestedBy: opts.requestedBy }, dedupeKey: `import:${importJobId}`, correlationId: opts.correlationId, maxAttempts: 3, lockTimeoutSeconds: 1800 });
  await trx.updateTable('importJobs').set({ status: 'IMPORTING', queueJobId: jobId }).where('organizationId', '=', orgId).where('id', '=', importJobId).execute();
  return jobId;
}

/** The keys an import of this kind needs (upload, confirm). */
function kindPermissions(kind: ImportKind) {
  return kind === 'ORG_UNITS' ? (['employee.import', 'department.manage'] as const) : (['employee.import'] as const);
}

export async function createImport(deps: ApiDeps, actor: Actor, orgId: string, input: { fileName: string; bytes: Buffer; options: ImportUploadInput['options']; kind?: ImportKind }): Promise<ImportJobDto> {
  const kind = input.kind ?? 'EMPLOYEES';
  const grant = requirePermission(actor.principal, orgId, ...kindPermissions(kind));
  const { parsed, format } = decodeUpload(input.fileName, input.bytes);
  const columns = kind === 'ORG_UNITS' ? ORG_UNIT_IMPORT_COLUMNS : EMPLOYEE_IMPORT_COLUMNS;
  parsed.header = normaliseHeader(parsed.header, columns);
  const duplicates = [...new Set(parsed.header.filter((h, i) => h && parsed.header.indexOf(h) !== i))];
  if (duplicates.length) throw errors.validation(`Duplicate columns: ${duplicates.join(', ')}.`, { issues: duplicates.map((d) => ({ path: d, message: 'Duplicate column' })) });
  const required: readonly string[] = kind === 'ORG_UNITS' ? ORG_UNIT_IMPORT_REQUIRED_COLUMNS : REQUIRED_COLUMNS;
  const missing = required.filter((c) => !parsed.header.includes(c));
  if (missing.length) throw errors.validation(`Missing required columns: ${missing.join(', ')}.`, { issues: missing.map((m) => ({ path: m, message: 'Missing column' })) });
  if (parsed.rows.length === 0) throw errors.validation('The file has no data rows.');
  if (parsed.rows.length > MAX_ROWS) throw errors.validation(`The file has more than ${MAX_ROWS} rows.`);
  const objects = csvToObjects(parsed).map((o) => normaliseValues(o, { excelSerials: format === 'xlsx' }));
  const options = { ...(input.options ?? {}) };
  const canSeeSensitive = hasPermission(grant, 'employee.view_sensitive');

  return runUser(deps.db, actor, async (trx) => {
    const rows = kind === 'ORG_UNITS'
      ? await validateOrgUnitRows(trx, orgId, objects, { scope: grant })
      : await validateEmployeeRows(trx, orgId, objects, { updateExisting: options.updateExisting ?? false, scope: grant, canWriteSensitive: canSeeSensitive });
    const id = await storeImport(trx, orgId, {
      kind, source: 'upload', fileName: input.fileName, filePath: `imports/${orgId}/${Date.now()}/${input.fileName.replace(/[^\w.-]+/g, '_')}`, rows, options, requestedBy: actor.userId,
      summary: { columns: parsed.header, format, delimiterDetected: format === 'csv', validatedAt: new Date().toISOString() },
    });
    const validRows = rows.filter((r) => r.errors.length === 0).length;
    await audit(trx, actor, orgId, 'employee.import_uploaded', 'import_job', { entityId: id, newValue: { fileName: input.fileName, kind, format, totalRows: rows.length, validRows, errorRows: rows.length - validRows, options } });
    const preview = rows.slice(0, PREVIEW_ROWS).map((r) => ({ id: `${id}:${r.rowNo}`, rowNo: r.rowNo, data: maskRowData(r.data, canSeeSensitive), errors: r.errors, status: r.errors.length ? 'invalid' as const : 'valid' as const, entityId: null }));
    return toJobDto(await loadJob(trx, orgId, id), preview);
  });
}

export async function listImports(deps: ApiDeps, actor: Actor, orgId: string, q: PaginationQuery & { status?: ImportJobDto['status']; kind?: ImportKind }): Promise<{ data: ImportJobDto[]; total: number }> {
  requirePermission(actor.principal, orgId, 'employee.import');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = jobQuery(trx, orgId);
    if (q.status) base = base.where('i.status', '=', q.status);
    if (q.kind) base = base.where('i.type', '=', q.kind);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(JOB_COLUMNS).orderBy('i.createdAt', 'desc').limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map((r) => toJobDto(r as JobRow)), total };
  });
}

export async function getImport(deps: ApiDeps, actor: Actor, orgId: string, id: string, rowsQuery: PaginationQuery & { status?: ImportJobRowDto['status'] }): Promise<{ job: ImportJobDto; rows: ImportJobRowDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'employee.import');
  const canSeeSensitive = hasPermission(grant, 'employee.view_sensitive');
  return runUser(deps.db, actor, async (trx) => {
    const job = await loadJob(trx, orgId, id);
    const page = pageOf(rowsQuery);
    let base = trx.selectFrom('importJobRows').where('organizationId', '=', orgId).where('importJobId', '=', id);
    if (rowsQuery.status) base = base.where('status', '=', rowsQuery.status);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(['id', 'rowNo', 'data', 'errors', 'status', 'entityId']).orderBy('rowNo').limit(page.pageSize).offset(page.offset).execute();
    return { job: toJobDto(job), rows: rows.map((r) => toRowDto(r, canSeeSensitive)), total };
  });
}

export async function confirmImport(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<{ jobId: string; importJobId: string }> {
  requirePermission(actor.principal, orgId, 'employee.import');
  return runUser(deps.db, actor, async (trx) => {
    const job = await loadJob(trx, orgId, id);
    const kind: ImportKind = job.type === 'ORG_UNITS' ? 'ORG_UNITS' : 'EMPLOYEES';
    requirePermission(actor.principal, orgId, ...(kind === 'ORG_UNITS' ? kindPermissions(kind) : (['employee.import', 'employee.create'] as const)));
    if (job.status !== 'VALIDATED') throw errors.invalidState(`Only validated imports can be confirmed (current status ${job.status}).`);
    if (job.validRows === 0) throw errors.invalidState('The import has no valid rows.');
    // every new employee who has not left takes a user: all of them must fit under the user limit the platform set, or the
    // import is refused before anything is queued. The EXECUTE_IMPORT handler checks the limit again in the transaction
    // that inserts (apps/worker/src/handlers/imports).
    if (kind === 'EMPLOYEES') {
      const adding = await countAddedUsers(trx, orgId, id);
      if (adding > 0) await assertUserCapacity(trx, orgId, adding);
    }
    const jobId = await queueImport(deps, trx, orgId, id, { requestedBy: actor.userId, correlationId: actor.requestId });
    await trx.updateTable('importJobs').set({ confirmedBy: actor.userId, confirmedAt: new Date() }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'employee.import_confirmed', 'import_job', { entityId: id, newValue: { kind, validRows: job.validRows, errorRows: job.errorRows, jobId } });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.imported', aggregateType: 'import_job', aggregateId: id, payload: { phase: 'queued', importId: id, kind, validRows: job.validRows, jobId }, actorUserId: actor.userId, requestId: actor.requestId });
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
