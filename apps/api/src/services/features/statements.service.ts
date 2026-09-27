import { timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import {
  SYSTEM_ROLE_IDS,
  statementSnapshotSchema,
  type IssueStatementsInput,
  type PublicStatementDto,
  type PublicStatementSubmitInput,
  type StatementCommentDto,
  type StatementDetailDto,
  type StatementFinalizedReason,
  type StatementListItemDto,
  type StatementListQuery,
  type StatementSnapshot,
  type StatementStatus,
  type StatementsIssueAcceptedDto,
} from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import { errors, sha256Hex } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { hasPermission, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runSystem, runUser } from '../../lib/service.js';
import { enqueueJob } from '../../lib/jobs.js';
import { pageOf, toCount } from '../../lib/pagination.js';
import { isoDate, isoDateTime, isoDateTimeOrNull } from '../../lib/mappers.js';

/**
 * Monthly attendance statements (docs/statements.md). Admin routes run as the caller under RLS; the public review
 * routes carry only the emailed token (`<org id>.<secret>`) — they parse the organisation from it, run in
 * system-for-org context (the employee is usually not a portal user), and verify sha256(secret) against the stored
 * hash in constant time before touching anything else.
 */

const STATEMENT_COLUMNS = [
  's.id', 's.employeeId', 's.branchId', 's.periodStart', 's.periodEnd', 's.status', 's.emailTo', 's.emailSentAt',
  's.emailError', 's.issuedAt', 's.firstViewedAt', 's.submittedAt', 's.signedName', 's.commentCount',
  's.approverUserId', 's.approvedAt', 's.finalizedAt', 's.finalizedReason',
  'e.displayName as employeeName', 'e.employeeNumber as employeeNumber', 'd.name as departmentName',
  'au.fullName as approverName',
] as const;

interface StatementRow {
  id: string; employeeId: string; branchId: string; periodStart: Date | string; periodEnd: Date | string;
  status: StatementStatus; emailTo: string | null; emailSentAt: Date | string | null; emailError: string | null;
  issuedAt: Date | string; firstViewedAt: Date | string | null; submittedAt: Date | string | null;
  signedName: string | null; commentCount: number; approverUserId: string | null; approvedAt: Date | string | null;
  finalizedAt: Date | string | null; finalizedReason: StatementFinalizedReason | null;
  employeeName: string; employeeNumber: string; departmentName: string | null; approverName: string | null;
}

function statementQuery(trx: Trx, orgId: string) {
  return trx
    .selectFrom('attendanceStatements as s')
    .innerJoin('employees as e', 'e.id', 's.employeeId')
    .leftJoin('departments as d', 'd.id', 'e.departmentId')
    .leftJoin('userProfiles as au', 'au.id', 's.approverUserId')
    .where('s.organizationId', '=', orgId);
}

function toListItem(r: StatementRow): StatementListItemDto {
  return {
    id: r.id,
    employeeId: r.employeeId,
    employeeName: r.employeeName,
    employeeNumber: String(r.employeeNumber),
    departmentName: r.departmentName,
    branchId: r.branchId,
    periodStart: isoDate(r.periodStart),
    periodEnd: isoDate(r.periodEnd),
    status: r.status,
    emailTo: r.emailTo === null ? null : String(r.emailTo),
    emailSentAt: isoDateTimeOrNull(r.emailSentAt),
    emailError: r.emailError,
    issuedAt: isoDateTime(r.issuedAt),
    firstViewedAt: isoDateTimeOrNull(r.firstViewedAt),
    submittedAt: isoDateTimeOrNull(r.submittedAt),
    signedName: r.signedName,
    commentCount: r.commentCount,
    approverUserId: r.approverUserId,
    approverName: r.approverName,
    approvedAt: isoDateTimeOrNull(r.approvedAt),
    finalizedAt: isoDateTimeOrNull(r.finalizedAt),
    finalizedReason: r.finalizedReason,
  };
}

/** Issued months must be finished: the running month's records are still moving under the engine. */
function assertIssuableMonth(month: string, now: Date): { from: string; to: string } {
  const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
  if (!start.isValid) throw errors.validation('Invalid month.', { month });
  const currentMonth = DateTime.fromJSDate(now, { zone: 'utc' }).toFormat('yyyy-MM');
  if (month >= currentMonth) throw errors.validation('Statements can only be issued for a finished month.', { month });
  if (start < DateTime.fromJSDate(now, { zone: 'utc' }).minus({ months: 24 })) throw errors.validation('Statements can be issued at most 24 months back.', { month });
  return { from: start.toISODate() as string, to: start.endOf('month').toISODate() as string };
}

export async function issueStatements(deps: ApiDeps, actor: Actor, orgId: string, input: IssueStatementsInput): Promise<StatementsIssueAcceptedDto> {
  requirePermission(actor.principal, orgId, 'statement.issue');
  assertIssuableMonth(input.month, new Date());
  return runUser(deps.db, actor, async (trx) => {
    const jobId = await enqueueJob(deps.queue, trx, {
      queue: 'processing',
      jobType: 'ISSUE_MONTHLY_STATEMENTS',
      organizationId: orgId,
      payload: { organizationId: orgId, month: input.month, employeeIds: input.employeeIds ?? null, requestedBy: actor.userId },
      correlationId: actor.requestId,
      priority: 5,
    });
    await audit(trx, actor, orgId, 'statement.issue', 'attendance_statement_batch', { newValue: { month: input.month, employeeIds: input.employeeIds?.length ?? null } });
    return { jobId, status: 'QUEUED', month: input.month };
  });
}

export async function listStatements(deps: ApiDeps, actor: Actor, orgId: string, q: StatementListQuery): Promise<{ data: StatementListItemDto[]; total: number }> {
  const inbox = q.inbox === true;
  if (!inbox) requirePermission(actor.principal, orgId, 'statement.view');
  return runUser(deps.db, actor, async (trx) => {
    let base = statementQuery(trx, orgId);
    if (inbox) base = base.where('s.approverUserId', '=', actor.userId).where('s.status', '=', 'PENDING_APPROVAL');
    if (q.month) base = base.where('s.periodStart', '=', new Date(`${q.month}-01T00:00:00Z`));
    if (q.status && !inbox) base = base.where('s.status', '=', q.status);
    if (q.employeeId) base = base.where('s.employeeId', '=', q.employeeId);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base
      .select([...STATEMENT_COLUMNS])
      .orderBy('s.periodStart', 'desc')
      .orderBy('e.employeeNumber')
      .limit(page.pageSize)
      .offset(page.offset)
      .execute()) as unknown as StatementRow[];
    return { data: rows.map(toListItem), total };
  });
}

export async function getStatement(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<StatementDetailDto> {
  // RLS gates visibility (statement.view in branch scope, the employee's own row, or the assigned approver); the
  // caller needs no specific permission here, so a manager who is otherwise a plain employee can open their inbox item.
  return runUser(deps.db, actor, async (trx) => {
    const row = (await statementQuery(trx, orgId)
      .leftJoin('userProfiles as ab', 'ab.id', 's.approvedBy')
      .select([...STATEMENT_COLUMNS, 's.snapshot', 's.approvalNote', 's.voidReason', 's.tokenExpiresAt', 'ab.fullName as approvedByName'])
      .where('s.id', '=', id)
      .executeTakeFirst()) as unknown as (StatementRow & { snapshot: unknown; approvalNote: string | null; voidReason: string | null; tokenExpiresAt: Date | string; approvedByName: string | null }) | undefined;
    if (!row) throw errors.notFound('Statement', id);
    const comments = await loadComments(trx, orgId, id);
    return {
      ...toListItem(row),
      snapshot: statementSnapshotSchema.parse(row.snapshot),
      comments,
      approvalNote: row.approvalNote,
      approvedByName: row.approvedByName,
      voidReason: row.voidReason,
      tokenExpiresAt: isoDateTime(row.tokenExpiresAt),
    };
  });
}

export async function approveStatement(deps: ApiDeps, actor: Actor, orgId: string, id: string, note: string | undefined): Promise<StatementDetailDto> {
  const grant = actor.principal.memberships.find((m) => m.organizationId === orgId);
  await runUser(deps.db, actor, async (trx) => {
    // No FOR UPDATE here: under RLS it would hide the row from callers who may read but not update, turning their
    // 403 into a 404. The guarded UPDATE below is the atomicity point instead.
    const row = await trx
      .selectFrom('attendanceStatements')
      .select(['id', 'status', 'approverUserId', 'employeeId', 'branchId', 'periodStart', 'commentCount', 'snapshot'])
      .where('organizationId', '=', orgId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('Statement', id);
    if (row.status !== 'PENDING_APPROVAL') throw errors.invalidState(`Only a statement pending approval can be approved (this one is ${row.status}).`);
    const isAssignee = row.approverUserId !== null && row.approverUserId === actor.userId;
    if (!isAssignee && !(grant && hasPermission(grant, 'statement.approve'))) throw errors.forbidden('Only the assigned approver or a statement.approve holder can approve this statement.');
    const now = new Date();
    const updated = await trx
      .updateTable('attendanceStatements')
      .set({ status: 'FINALIZED', finalizedAt: now, finalizedReason: 'MANAGER_APPROVED', approvedBy: actor.userId, approvedAt: now, approvalNote: note ?? null })
      .where('id', '=', id)
      .where('status', '=', 'PENDING_APPROVAL')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw errors.invalidState('This statement was decided by someone else just now.');
    const snapshot = statementSnapshotSchema.parse(row.snapshot);
    await emitDomainEvent(trx, {
      organizationId: orgId,
      eventType: 'statement.finalized',
      aggregateType: 'attendance_statement',
      aggregateId: id,
      payload: { statementId: id, employeeId: row.employeeId, periodLabel: snapshot.period.label, reason: 'MANAGER_APPROVED', approvedBy: actor.userId },
      actorUserId: actor.userId,
      requestId: actor.requestId,
    });
    await audit(trx, actor, orgId, 'statement.approve', 'attendance_statement', { entityId: id, branchId: row.branchId, newValue: { note: note ?? null } });
  });
  return getStatement(deps, actor, orgId, id);
}

export async function resendStatement(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<{ jobId: string; status: 'QUEUED' }> {
  requirePermission(actor.principal, orgId, 'statement.issue');
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.selectFrom('attendanceStatements').select(['id', 'status', 'branchId']).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!row) throw errors.notFound('Statement', id);
    if (row.status === 'FINALIZED' || row.status === 'VOID') throw errors.invalidState(`A ${row.status} statement cannot be re-sent.`);
    const jobId = await enqueueJob(deps.queue, trx, {
      queue: 'processing',
      jobType: 'SEND_STATEMENT_EMAIL',
      organizationId: orgId,
      payload: { organizationId: orgId, statementId: id, requestedBy: actor.userId },
      correlationId: actor.requestId,
      priority: 6,
    });
    await audit(trx, actor, orgId, 'statement.resend', 'attendance_statement', { entityId: id, branchId: row.branchId });
    return { jobId, status: 'QUEUED' as const };
  });
}

export async function voidStatement(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason: string): Promise<StatementDetailDto> {
  requirePermission(actor.principal, orgId, 'statement.issue');
  await runUser(deps.db, actor, async (trx) => {
    const row = await trx.selectFrom('attendanceStatements').select(['id', 'status', 'branchId']).where('organizationId', '=', orgId).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw errors.notFound('Statement', id);
    if (row.status === 'FINALIZED') throw errors.invalidState('A finalised statement is the signed record; it cannot be voided.');
    if (row.status === 'VOID') throw errors.invalidState('This statement is already void.');
    await trx.updateTable('attendanceStatements').set({ status: 'VOID', voidedAt: new Date(), voidedBy: actor.userId, voidReason: reason }).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'statement.void', 'attendance_statement', { entityId: id, branchId: row.branchId, reason });
  });
  return getStatement(deps, actor, orgId, id);
}

/* ── Public token flow ─────────────────────────────────────────────────────────────────────────────────────────── */

interface TokenParts { orgId: string; hash: string }

function parseToken(token: string): TokenParts | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const orgId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(orgId) || secret.length < 20) return null;
  return { orgId, hash: sha256Hex(secret) };
}

/** Both digests are hex of fixed length; compare in constant time (AGENTS.md invitation rule). */
function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb);
}

interface PublicRow {
  id: string; status: StatementStatus; tokenHash: string; tokenExpiresAt: Date | string; periodStart: Date | string;
  periodEnd: Date | string; snapshot: unknown; submittedAt: Date | string | null; signedName: string | null;
  approvedAt: Date | string | null; approvalNote: string | null; finalizedAt: Date | string | null;
  finalizedReason: StatementFinalizedReason | null; firstViewedAt: Date | string | null; employeeId: string; branchId: string;
}

async function findByToken(trx: Trx, orgId: string, hash: string): Promise<PublicRow> {
  const row = (await trx
    .selectFrom('attendanceStatements')
    .select(['id', 'status', 'tokenHash', 'tokenExpiresAt', 'periodStart', 'periodEnd', 'snapshot', 'submittedAt', 'signedName', 'approvedAt', 'approvalNote', 'finalizedAt', 'finalizedReason', 'firstViewedAt', 'employeeId', 'branchId'])
    .where('organizationId', '=', orgId)
    .where('tokenHash', '=', hash)
    .executeTakeFirst()) as PublicRow | undefined;
  if (!row || !sameHash(row.tokenHash, hash)) throw errors.notFound('Statement');
  if (row.status === 'VOID') throw errors.notFound('Statement');
  if (new Date(row.tokenExpiresAt).getTime() < Date.now()) throw errors.invalidState('This statement link has expired. Please ask HR to send a fresh link.');
  return row;
}

function toPublicDto(row: PublicRow, comments: StatementCommentDto[]): PublicStatementDto {
  return {
    status: row.status,
    periodStart: isoDate(row.periodStart),
    periodEnd: isoDate(row.periodEnd),
    snapshot: statementSnapshotSchema.parse(row.snapshot),
    comments,
    submittedAt: isoDateTimeOrNull(row.submittedAt),
    signedName: row.signedName,
    approvedAt: isoDateTimeOrNull(row.approvedAt),
    approvalNote: row.approvalNote,
    finalizedAt: isoDateTimeOrNull(row.finalizedAt),
    finalizedReason: row.finalizedReason,
    tokenExpiresAt: isoDateTime(row.tokenExpiresAt),
  };
}

async function loadComments(trx: Trx, orgId: string, statementId: string): Promise<StatementCommentDto[]> {
  const rows = await trx
    .selectFrom('attendanceStatementComments')
    .select(['id', 'attendanceDate', 'comment', 'createdAt'])
    .where('organizationId', '=', orgId)
    .where('statementId', '=', statementId)
    .orderBy('attendanceDate')
    .execute();
  return rows.map((c) => ({ id: c.id, attendanceDate: isoDate(c.attendanceDate), comment: c.comment, createdAt: isoDateTime(c.createdAt) }));
}

export async function publicViewStatement(deps: ApiDeps, requestId: string, token: string): Promise<PublicStatementDto> {
  const parts = parseToken(token);
  if (!parts) throw errors.notFound('Statement');
  return runSystem(deps.db, parts.orgId, requestId, async (trx) => {
    const row = await findByToken(trx, parts.orgId, parts.hash);
    if (!row.firstViewedAt) {
      await trx.updateTable('attendanceStatements').set({ firstViewedAt: new Date() }).where('id', '=', row.id).execute();
    }
    return toPublicDto(row, await loadComments(trx, parts.orgId, row.id));
  });
}

/** MANAGER resolution, corrections pattern: the manager's active membership, else the hr_admin system role. */
async function resolveApprover(trx: Trx, orgId: string, employeeId: string): Promise<{ userId: string | null; roleId: string | null }> {
  const emp = await trx.selectFrom('employees').select('managerEmployeeId').where('organizationId', '=', orgId).where('id', '=', employeeId).executeTakeFirst();
  if (emp?.managerEmployeeId) {
    const m = await trx
      .selectFrom('orgMemberships')
      .select('userId')
      .where('organizationId', '=', orgId)
      .where('employeeId', '=', emp.managerEmployeeId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (m) return { userId: m.userId, roleId: null };
  }
  return { userId: null, roleId: SYSTEM_ROLE_IDS.hr_admin };
}

export async function publicSubmitStatement(deps: ApiDeps, requestId: string, input: PublicStatementSubmitInput, meta: { ip: string | null; userAgent: string | null }): Promise<PublicStatementDto> {
  const parts = parseToken(input.token);
  if (!parts) throw errors.notFound('Statement');
  return runSystem(deps.db, parts.orgId, requestId, async (trx) => {
    const row = await (async () => {
      const r = (await trx
        .selectFrom('attendanceStatements')
        .selectAll()
        .where('organizationId', '=', parts.orgId)
        .where('tokenHash', '=', parts.hash)
        .forUpdate()
        .executeTakeFirst()) as unknown as (PublicRow & { organizationId: string }) | undefined;
      if (!r || !sameHash(r.tokenHash, parts.hash) || r.status === 'VOID') throw errors.notFound('Statement');
      if (new Date(r.tokenExpiresAt).getTime() < Date.now()) throw errors.invalidState('This statement link has expired. Please ask HR to send a fresh link.');
      return r;
    })();
    if (row.status !== 'ISSUED') throw errors.invalidState('This statement has already been submitted.');

    const snapshot: StatementSnapshot = statementSnapshotSchema.parse(row.snapshot);
    const commentable = new Map(snapshot.days.map((d) => [d.date, d.commentable]));
    const seen = new Set<string>();
    for (const c of input.comments) {
      if (seen.has(c.date)) throw errors.validation('One comment per day.', { issues: [{ path: 'comments', message: `Duplicate comment for ${c.date}` }] });
      seen.add(c.date);
      const ok = commentable.get(c.date);
      if (ok === undefined) throw errors.validation('Comments must be about days inside the statement period.', { issues: [{ path: 'comments', message: `${c.date} is outside the period` }] });
      if (!ok) throw errors.validation('This day is not open for comments.', { issues: [{ path: 'comments', message: `${c.date} is outside your employment` }] });
    }

    const now = new Date();
    if (input.comments.length > 0) {
      await trx
        .insertInto('attendanceStatementComments')
        .values(input.comments.map((c) => ({
          organizationId: parts.orgId,
          statementId: row.id,
          employeeId: row.employeeId,
          branchId: row.branchId,
          attendanceDate: new Date(`${c.date}T00:00:00Z`),
          comment: c.comment,
        })))
        .execute();
    }

    const hasComments = input.comments.length > 0;
    const approver = hasComments ? await resolveApprover(trx, parts.orgId, row.employeeId) : { userId: null, roleId: null };
    await trx
      .updateTable('attendanceStatements')
      .set({
        status: hasComments ? 'PENDING_APPROVAL' : 'FINALIZED',
        submittedAt: now,
        signedName: input.signedName,
        signedIp: meta.ip,
        signedUserAgent: meta.userAgent,
        commentCount: input.comments.length,
        approverUserId: approver.userId,
        approverRoleId: approver.roleId,
        ...(hasComments ? {} : { finalizedAt: now, finalizedReason: 'EMPLOYEE_CONFIRMED' as const }),
      })
      .where('id', '=', row.id)
      .execute();

    await emitDomainEvent(trx, {
      organizationId: parts.orgId,
      eventType: hasComments ? (approver.userId ? 'statement.approval_pending' : 'statement.approval_pending_role') : 'statement.finalized',
      aggregateType: 'attendance_statement',
      aggregateId: row.id,
      payload: {
        statementId: row.id,
        employeeId: row.employeeId,
        employeeName: snapshot.employee.name,
        periodLabel: snapshot.period.label,
        commentCount: input.comments.length,
        ...(hasComments && approver.userId ? { userId: approver.userId } : {}),
        ...(hasComments ? {} : { reason: 'EMPLOYEE_CONFIRMED' }),
      },
      actorUserId: null,
      requestId,
    });

    const fresh = (await trx.selectFrom('attendanceStatements').selectAll().where('id', '=', row.id).executeTakeFirst()) as unknown as PublicRow;
    return toPublicDto(fresh, await loadComments(trx, parts.orgId, row.id));
  });
}
