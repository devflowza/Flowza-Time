import { z } from 'zod';
import { uuidSchema, type ReportFormat, type ReportType } from '@flowza/contracts';
import { AppError, errors, event } from '@flowza/shared';
import { emitDomainEvent, withContext } from '@flowza/database';
import type { WorkerDeps } from '../../deps.js';
import type { HandlerRegistry, JobContext } from '../types.js';
import { parsePayload } from '../attendance/common.js';
import { loadReportContext } from './context.js';
import { REPORT_DEFINITIONS } from './definitions/index.js';
import { renderDocument } from './render/index.js';
import type { Logger } from '@flowza/shared';

export const generateReportPayloadSchema = z.object({ organizationId: uuidSchema, reportRequestId: uuidSchema });
export const exportEmployeesPayloadSchema = z.object({
  employeeIds: z.array(uuidSchema).nullable().optional(),
  branchIds: z.array(uuidSchema).nullable().optional(),
  format: z.enum(['csv', 'xlsx', 'pdf']).default('xlsx'),
  requestedBy: uuidSchema.nullable().optional(),
});

/** Files live until the retention sweep removes them (RETENTION_FLOORS.report_files); the row says so up front. */
export const REPORT_FILE_TTL_DAYS = 7;
export const REPORTS_BUCKET = 'reports';

export interface GenerateResult { reportRequestId: string; status: 'COMPLETED' | 'FAILED' | 'SKIPPED'; rowCount?: number; bytes?: number; reason?: string }

const RETRYABLE_MAX_STATUS_RESET = 'QUEUED';

/**
 * Generate one report request end to end.
 *
 * Three short transactions, not one long one: claim (QUEUED → RUNNING), load the data, and finalise — rendering and the
 * storage upload happen between them with no connection held, because a PDF of a large tenant can take a minute and a
 * transaction that long would pin a pooled connection for nothing.
 *
 * Failure policy: a non-retryable error (bad parameters, unknown type, Chromium absent on this worker) marks the row
 * FAILED with the user-safe message and completes the job — retrying could not help. A retryable error (storage or
 * renderer hiccup) puts the row back to QUEUED and rethrows so the queue's backoff runs; on the final attempt it is
 * recorded as FAILED, so the requester never sees a report stuck RUNNING.
 */
export async function generateReportRequest(deps: WorkerDeps, log: Logger, job: JobContext['job'], organizationId: string, reportRequestId: string): Promise<GenerateResult> {
  const now = deps.now();
  const claimed = await withContext(deps.db, { kind: 'system', organizationId, jobId: job.id }, async (trx) => {
    const row = await trx.selectFrom('reportRequests').select(['id', 'reportType', 'format', 'parameters', 'status', 'requestedBy', 'branchId']).where('organizationId', '=', organizationId).where('id', '=', reportRequestId).forUpdate().executeTakeFirst();
    if (!row) throw errors.notFound('Report request', reportRequestId);
    if (row.status === 'CANCELLED' || row.status === 'COMPLETED' || row.status === 'EXPIRED') return { row, skip: true as const };
    await trx.updateTable('reportRequests').set({ status: 'RUNNING', startedAt: now, error: null }).where('id', '=', row.id).execute();
    return { row, skip: false as const };
  });
  if (claimed.skip) return { reportRequestId, status: 'SKIPPED', reason: claimed.row.status };
  const { row } = claimed;
  const reportType = row.reportType as ReportType;
  const format = row.format as ReportFormat;

  try {
    const def = REPORT_DEFINITIONS[reportType];
    if (!def) throw errors.validation('This report type is not available yet.', { reportType });
    const doc = await withContext(deps.db, { kind: 'system', organizationId, jobId: job.id }, async (trx) => {
      const ctx = await loadReportContext(trx, organizationId, { parameters: row.parameters, format }, now);
      return def.build(trx, ctx);
    });
    const { body, contentType } = await renderDocument(doc, format, deps.pdf);
    const path = `${organizationId}/${row.id}.${format}`;
    const stored = await deps.storage.upload(REPORTS_BUCKET, path, body, contentType);
    const completedAt = deps.now();
    const expiresAt = new Date(completedAt.getTime() + REPORT_FILE_TTL_DAYS * 86_400_000);
    await withContext(deps.db, { kind: 'system', organizationId, jobId: job.id }, async (trx) => {
      await trx.updateTable('reportRequests').set({ status: 'COMPLETED', filePath: stored.path, fileSizeBytes: String(stored.size), rowCount: doc.rowCount, completedAt, expiresAt, error: null }).where('id', '=', row.id).execute();
      await emitDomainEvent(trx, { organizationId, eventType: 'report.ready', aggregateType: 'report_request', aggregateId: row.id, payload: { reportId: row.id, reportType, reportTitle: doc.title, format, rowCount: doc.rowCount, userId: row.requestedBy ?? undefined } });
    });
    log.info(event('report_generated', { reportRequestId: row.id, reportType, format, rows: doc.rowCount, bytes: stored.size, ms: deps.now().getTime() - now.getTime() }));
    return { reportRequestId: row.id, status: 'COMPLETED', rowCount: doc.rowCount, bytes: stored.size };
  } catch (err) {
    const app = err instanceof AppError ? err : null;
    const retryable = !!app?.retryable && job.attempts < job.maxAttempts;
    const message = app ? app.message : 'Report generation failed.';
    await withContext(deps.db, { kind: 'system', organizationId, jobId: job.id }, async (trx) => {
      if (retryable) {
        await trx.updateTable('reportRequests').set({ status: RETRYABLE_MAX_STATUS_RESET, error: message }).where('id', '=', row.id).execute();
        return;
      }
      await trx.updateTable('reportRequests').set({ status: 'FAILED', error: message, completedAt: deps.now() }).where('id', '=', row.id).execute();
      await emitDomainEvent(trx, { organizationId, eventType: 'report.failed', aggregateType: 'report_request', aggregateId: row.id, payload: { reportId: row.id, reportType, error: message, userId: row.requestedBy ?? undefined } });
    });
    log.error(event('report_failed', { reportRequestId: row.id, reportType, format, retryable, code: app?.code ?? 'UNKNOWN', err: err instanceof Error ? err.message : String(err) }));
    if (retryable) throw err;
    return { reportRequestId: row.id, status: 'FAILED', reason: message };
  }
}

/** GENERATE_REPORT: payload `{ organizationId, reportRequestId }` (queued by POST /orgs/:orgId/reports). */
export async function generateReportHandler({ job, deps, log }: JobContext): Promise<GenerateResult> {
  const p = parsePayload(generateReportPayloadSchema, job.payload);
  return generateReportRequest(deps, log, job, p.organizationId, p.reportRequestId);
}

/**
 * EXPORT_EMPLOYEES: the employee list's bulk export. It arrives without a report_requests row, so one is created here —
 * that is what gives the requester a place to download from ("My reports") and gives the file an expiry and an audit trail.
 */
export async function exportEmployeesHandler({ job, deps, log }: JobContext): Promise<GenerateResult> {
  const p = parsePayload(exportEmployeesPayloadSchema, job.payload);
  const organizationId = job.organizationId;
  if (!organizationId) throw errors.validation('EXPORT_EMPLOYEES needs an organisation.');
  const requestId = await withContext(deps.db, { kind: 'system', organizationId, jobId: job.id }, async (trx) => {
    const parameters: Record<string, unknown> = { employmentStatus: 'all' };
    if (p.employeeIds?.length) parameters['employeeIds'] = p.employeeIds;
    if (p.branchIds?.length) parameters['branchIds'] = p.branchIds;
    const row = await trx.insertInto('reportRequests').values({
      organizationId, reportType: 'employee_directory', format: p.format, parameters: JSON.stringify(parameters), status: 'QUEUED', requestedBy: p.requestedBy ?? null,
      branchId: p.branchIds?.length === 1 ? p.branchIds[0]! : null, queueJobId: Number.isFinite(Number(job.id)) ? String(job.id) : null,
    }).returning('id').executeTakeFirstOrThrow();
    return row.id;
  });
  return generateReportRequest(deps, log, job, organizationId, requestId);
}

export function registerReportHandlers(registry: HandlerRegistry): void {
  // fifteen minutes: a month of a large tenant rendered to PDF, not the runner's five-minute default for device calls
  registry.register({ jobType: 'GENERATE_REPORT', handler: generateReportHandler, timeoutMs: 15 * 60_000 });
  registry.register({ jobType: 'EXPORT_EMPLOYEES', handler: exportEmployeesHandler, timeoutMs: 15 * 60_000 });
}
