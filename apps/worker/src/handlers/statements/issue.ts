import { z } from 'zod';
import { DateTime } from 'luxon';
import { statementSnapshotSchema, uuidSchema, type StatementSnapshot } from '@flowza/contracts';
import { buildStatementSnapshot, type StatementDayRecordInput } from '@flowza/domain';
import { errors, event, randomToken, sha256Hex, type Logger } from '@flowza/shared';
import { emitDomainEvent, withContext, type Trx } from '@flowza/database';
import type { WorkerDeps } from '../../deps.js';
import type { HandlerRegistry, JobContext } from '../types.js';
import { parsePayload } from '../attendance/common.js';
import { loadReportContext, type ReportContext } from '../reports/context.js';
import { loadRecords, type DailyRecord } from '../reports/data/records.js';
import { loadRoster, type RosterEmployee } from '../reports/data/roster.js';
import { statementEmail } from './email.js';

export const issueStatementsPayloadSchema = z.object({
  organizationId: uuidSchema,
  month: z.string().regex(/^\d{4}-\d{2}$/),
  employeeIds: z.array(uuidSchema).nullable().optional(),
  requestedBy: uuidSchema.nullable().optional(),
});

export const sendStatementEmailPayloadSchema = z.object({
  organizationId: uuidSchema,
  statementId: uuidSchema,
  requestedBy: uuidSchema.nullable().optional(),
});

const DEFAULT_LINK_VALIDITY_DAYS = 45;
/** Employees per insert transaction: short transactions (pooled connections), still one round trip per fifty. */
const INSERT_BATCH = 50;

export interface IssueResult {
  month: string;
  created: number;
  skippedExisting: number;
  skippedNoRecords: number;
  emailed: number;
  emailFailed: number;
  noEmail: number;
}

interface EmployeeContact { email: string | null }

interface PendingEmail { statementId: string; to: string; employeeName: string; token: string; periodLabel: string }

/**
 * Issue one month's statements for an organisation: build the immutable snapshot per employee from the daily records,
 * store it with a hashed review token, then email each employee their link. Idempotent per employee — an employee who
 * already has a live (non-VOID) statement for the month is skipped, so a retried or re-enqueued job never duplicates,
 * and a targeted re-run (employeeIds) fills gaps. Employees with no daily records in the month are skipped: there is
 * nothing for them to attest. Email failures are recorded on the statement row (the Statements page resends); they
 * never fail the job.
 */
export async function issueMonthlyStatements({ deps, log, job }: JobContext): Promise<IssueResult> {
  const payload = parsePayload(issueStatementsPayloadSchema, job.payload);
  const { organizationId, month } = payload;
  const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
  if (!start.isValid) throw errors.validation('Invalid statement month.', { month });
  const from = start.toISODate() as string;
  const to = start.endOf('month').toISODate() as string;
  const now = deps.now();

  const prepared = await withContext(deps.db, { kind: 'system', organizationId, jobId: job.id }, async (trx) => {
    const ctx = await loadReportContext(trx, organizationId, { parameters: { from, to, employeeIds: payload.employeeIds ?? undefined }, format: 'pdf' }, now);
    const roster = await loadRoster(trx, ctx, { employeeIds: payload.employeeIds ?? undefined, employedBetween: { from, to } });
    const records = await loadRecords(trx, ctx, { from, to, employeeIds: payload.employeeIds ?? undefined });
    const contacts = await loadContacts(trx, organizationId, roster.map((r) => r.id));
    const existing = await trx
      .selectFrom('attendanceStatements')
      .select('employeeId')
      .where('organizationId', '=', organizationId)
      .where('periodStart', '=', asDbDate(from))
      .where('status', '<>', 'VOID')
      .execute();
    const validityDays = ctx.settings.reports?.monthlyStatements?.linkValidityDays ?? DEFAULT_LINK_VALIDITY_DAYS;
    return { ctx, roster, records, contacts, existingIds: new Set(existing.map((e) => e.employeeId)), validityDays };
  });

  const { ctx, roster, contacts, existingIds, validityDays } = prepared;
  const recordsByEmployee = new Map<string, DailyRecord[]>();
  for (const r of prepared.records) {
    const list = recordsByEmployee.get(r.employeeId) ?? [];
    list.push(r);
    recordsByEmployee.set(r.employeeId, list);
  }

  const result: IssueResult = { month, created: 0, skippedExisting: 0, skippedNoRecords: 0, emailed: 0, emailFailed: 0, noEmail: 0 };
  const emails: PendingEmail[] = [];
  const expiresAt = new Date(now.getTime() + validityDays * 86_400_000);

  for (let i = 0; i < roster.length; i += INSERT_BATCH) {
    const batch = roster.slice(i, i + INSERT_BATCH);
    await withContext(deps.db, { kind: 'system', organizationId, jobId: job.id }, async (trx) => {
      for (const emp of batch) {
        if (existingIds.has(emp.id)) { result.skippedExisting++; continue; }
        const empRecords = recordsByEmployee.get(emp.id) ?? [];
        if (empRecords.length === 0) { result.skippedNoRecords++; continue; }
        const email = contacts.get(emp.id)?.email ?? null;
        const snapshot = buildSnapshot(ctx, emp, empRecords, from, to, now);
        const token = randomToken(32);
        const inserted = await trx
          .insertInto('attendanceStatements')
          .values({
            organizationId,
            employeeId: emp.id,
            branchId: emp.branchId,
            periodStart: asDbDate(from),
            periodEnd: asDbDate(to),
            snapshot: JSON.stringify(snapshot),
            recordVersions: JSON.stringify(Object.fromEntries(empRecords.map((r) => [r.id, r.calculationVersion]))),
            status: 'ISSUED',
            tokenHash: sha256Hex(token),
            tokenExpiresAt: expiresAt,
            emailTo: email,
            issuedAt: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        result.created++;
        if (email) {
          emails.push({ statementId: inserted.id, to: email, employeeName: emp.displayName, token: `${organizationId}.${token}`, periodLabel: snapshot.period.label });
        } else {
          result.noEmail++;
          await trx.updateTable('attendanceStatements').set({ emailError: 'NO_EMAIL' }).where('id', '=', inserted.id).execute();
        }
      }
      if (result.created > 0 && i + INSERT_BATCH >= roster.length) {
        await emitDomainEvent(trx, {
          organizationId,
          eventType: 'statement.issued',
          aggregateType: 'attendance_statement_batch',
          aggregateId: null,
          payload: { month, created: result.created, ...(payload.requestedBy ? { userId: payload.requestedBy } : {}) },
          actorUserId: payload.requestedBy ?? null,
        });
      }
    });
  }

  for (const mail of emails) {
    const sent = await deliverStatementEmail(deps, log, organizationId, mail, ctx.locale, ctx.company, job.id);
    if (sent) result.emailed++;
    else result.emailFailed++;
  }

  log.info(event('statements_issued', { organizationId, ...result }));
  return result;
}

/**
 * (Re)send one statement's review email. The stored hash cannot be reversed, so a resend ROTATES the token: new
 * secret, new hash, fresh validity window — the old link stops working, which is also the recovery path for a
 * mistyped address or a forwarded email. Refused for finalised or voided statements.
 */
export async function sendStatementEmail({ deps, log, job }: JobContext): Promise<{ statementId: string; sent: boolean; reason?: string }> {
  const payload = parsePayload(sendStatementEmailPayloadSchema, job.payload);
  const { organizationId, statementId } = payload;
  const now = deps.now();

  const prepared = await withContext(deps.db, { kind: 'system', organizationId, jobId: job.id }, async (trx) => {
    const row = await trx
      .selectFrom('attendanceStatements as s')
      .innerJoin('employees as e', 'e.id', 's.employeeId')
      .select(['s.id', 's.status', 's.snapshot', 'e.email', 'e.displayName'])
      .where('s.organizationId', '=', organizationId)
      .where('s.id', '=', statementId)
      .executeTakeFirst();
    if (!row) throw errors.notFound('Statement', statementId);
    if (row.status === 'FINALIZED' || row.status === 'VOID') return { skip: `Statement is ${row.status}.` };
    if (!row.email) {
      await trx.updateTable('attendanceStatements').set({ emailError: 'NO_EMAIL' }).where('id', '=', statementId).execute();
      return { skip: 'Employee has no email address.' };
    }
    const settings = await trx.selectFrom('organizationSettings').select('reports').where('organizationId', '=', organizationId).executeTakeFirst();
    const reports = (settings?.reports ?? {}) as { monthlyStatements?: { linkValidityDays?: number } };
    const validityDays = reports.monthlyStatements?.linkValidityDays ?? DEFAULT_LINK_VALIDITY_DAYS;
    const token = randomToken(32);
    await trx
      .updateTable('attendanceStatements')
      .set({ tokenHash: sha256Hex(token), tokenExpiresAt: new Date(now.getTime() + validityDays * 86_400_000), emailTo: row.email })
      .where('id', '=', statementId)
      .execute();
    const snapshot = statementSnapshotSchema.parse(row.snapshot);
    return {
      mail: { statementId, to: String(row.email), employeeName: row.displayName, token: `${organizationId}.${token}`, periodLabel: snapshot.period.label } satisfies PendingEmail,
      locale: snapshot.organization.locale,
      company: snapshot.organization.name,
    };
  });

  if ('skip' in prepared) return { statementId, sent: false, reason: prepared.skip };
  const sent = await deliverStatementEmail(deps, log, organizationId, prepared.mail, prepared.locale, prepared.company, job.id);
  return { statementId, sent };
}

/** Sends outside any transaction; success and failure land on the statement row, never fail the job. */
async function deliverStatementEmail(deps: WorkerDeps, log: Logger, organizationId: string, mail: PendingEmail, locale: 'en' | 'ar', company: string, jobId: string): Promise<boolean> {
  const link = `${deps.config.WEB_PUBLIC_URL}/statements/review?token=${encodeURIComponent(mail.token)}`;
  const message = statementEmail({ locale, company, employeeName: mail.employeeName, periodLabel: mail.periodLabel, link });
  let error: string | null = null;
  try {
    await deps.mailer.send({ to: mail.to, ...message });
  } catch (err) {
    error = String((err as Error).message).slice(0, 500);
    log.warn(event('statement_email_failed', { organizationId, statementId: mail.statementId, err: error }));
  }
  await withContext(deps.db, { kind: 'system', organizationId, jobId }, async (trx) => {
    await trx
      .updateTable('attendanceStatements')
      .set((eb) => ({
        ...(error ? { emailError: error } : { emailSentAt: deps.now(), emailError: null }),
        emailAttempts: eb('emailAttempts', '+', 1),
      }))
      .where('organizationId', '=', organizationId)
      .where('id', '=', mail.statementId)
      .execute();
  });
  return error === null;
}

function buildSnapshot(ctx: ReportContext, emp: RosterEmployee, records: DailyRecord[], from: string, to: string, now: Date): StatementSnapshot {
  const days: StatementDayRecordInput[] = records.map((r) => ({
    date: r.attendanceDate,
    status: r.status,
    flags: r.flags,
    firstInAt: r.firstInAt,
    lastOutAt: r.lastOutAt,
    workedMinutes: r.workedMinutes,
    scheduledMinutes: r.scheduledMinutes,
    lateMinutes: r.lateMinutes,
    earlyDepartureMinutes: r.earlyDepartureMinutes,
    overtimeMinutes: r.overtimeMinutes,
    overtimeCategory: r.overtimeCategory,
    leave: r.leave ? { code: r.leave.code, name: r.leave.name, nameAr: null, isPaid: r.leave.isPaid, treatAsPresent: r.leave.treatAsPresent } : null,
  }));
  const snapshot = buildStatementSnapshot({
    organization: {
      name: ctx.company,
      timezone: ctx.timezone,
      locale: ctx.locale,
      hoursNotation: ctx.notation,
      timeFormat: ctx.timeFormat,
      datePattern: ctx.datePattern,
      codeOverrides: ctx.codeOverrides,
    },
    period: { start: from, end: to },
    employee: {
      id: emp.id,
      displayName: emp.displayName,
      employeeNumber: emp.employeeNumber,
      branchName: emp.branchName,
      departmentName: emp.departmentName,
      designationName: emp.designationName,
      joiningDate: emp.joiningDate,
      exitDate: emp.exitDate,
    },
    records: days,
    leaveTypes: ctx.leaveTypes,
    now,
  });
  return statementSnapshotSchema.parse(snapshot);
}

async function loadContacts(trx: Trx, organizationId: string, employeeIds: string[]): Promise<Map<string, EmployeeContact>> {
  const out = new Map<string, EmployeeContact>();
  for (let i = 0; i < employeeIds.length; i += 1000) {
    const batch = employeeIds.slice(i, i + 1000);
    if (batch.length === 0) continue;
    const rows = await trx
      .selectFrom('employees')
      .select(['id', 'email'])
      .where('organizationId', '=', organizationId)
      .where('id', 'in', batch)
      .execute();
    for (const r of rows) out.set(r.id, { email: r.email === null ? null : String(r.email) });
  }
  return out;
}

/** Kysely date columns accept Date; keep local-date semantics by pinning midnight UTC. */
const asDbDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00Z`);

export function registerStatementHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'ISSUE_MONTHLY_STATEMENTS', handler: issueMonthlyStatements, timeoutMs: 900_000 });
  registry.register({ jobType: 'SEND_STATEMENT_EMAIL', handler: sendStatementEmail, timeoutMs: 120_000 });
}
