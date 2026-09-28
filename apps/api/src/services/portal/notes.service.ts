import type { ApprovalRequestStatus, AttendanceFlag, AttendanceNoteDto, AttendanceNoteReviewItemDto, AttendanceNotesQuery, NoteChargeDto, NoteReviewInput, NoteReviewResultDto, SelfNoteInput, SelfNoteUpdateInput } from '@flowza/contracts';
import { effectiveBranchOn, type Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { addDays, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, isTeamMember, requireMembership } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateTime, isoDateTimeOrNull, numberOrNull } from '../../lib/mappers.js';
import { pageOf, toCount } from '../../lib/pagination.js';
import { announceAnswer, decideWithin, invalidateForEntity, requestInfo, submit } from '../approvals/engine.js';
import { loadDelegationMap } from '../approvals/context.js';
import { systemStep } from '../features/context.js';
import { orgToday } from '../features/recalc.js';
import { dv } from '../features/sql-helpers.js';
import { emitToUsers, isPeriodLocked, isWorking, lineManagerUserIds, loadEmployeeCtx, localInstant, lockEmployee, portalSelf, reviewerRole } from './common.js';
import { pendingRequestOf, routedToUser, seatSecondaryManager } from './line-manager.js';
import { applyNoteDecision, applyNoteInfoRequest, clearReviewableMarks, dayFacts, excusedCounts, loadNote, NOTE_COLUMNS, OPEN_NOTE_STATUSES, type NoteRow } from './note-effects.js';

/**
 * Attendance notes — the employee's reason for a day (HR portal Prompt 4; Finance `attendance_notes`).
 *
 * The employee (attendance.note) gives ONE active reason per day (pending / info requested / approved / excused; a rejected
 * one is history and a new one may follow). Giving a reason undoes what the day-close sweep or an earlier review charged for
 * the day while it is reviewed — never HR's own marks — and routes it through the approval engine: the organisation's
 * ATTENDANCE_NOTE workflow, else the line manager (primary, the secondary standing in for them, then HR admins). The review
 * (approve / excuse / reject with a pay effect / ask for information) happens in the approvals inbox or on the notes review
 * page; both end in the same hook (note-effects.ts).
 *
 * Reviewers: the manager seated on the request, or organisation-wide oversight (`attendance.review_notes` or
 * `attendance.approve`, with `attendance.view`, within the branch scope) — the latter decides as an OVERRIDE naming the
 * current level, and is recorded as oversight. Nobody reviews their own reason.
 */

const OVERSIGHT_KEYS = ['attendance.review_notes', 'attendance.approve'] as const;
const REVIEW_AUDIT_ACTION = { approve: 'attendance.note_approved', excuse: 'attendance.note_excused', reject: 'attendance.note_rejected', request_info: 'attendance.note_info_requested' } as const;
const NOTE_AHEAD_DAYS = 30;

type RequestLite = { id: string; status: ApprovalRequestStatus; currentStep: number; stepCount: number };

async function requestsById(t: Trx, orgId: string, ids: readonly (string | null)[]): Promise<Map<string, RequestLite>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const reqs = await t.selectFrom('approvalRequests').select(['id', 'status', 'currentStep']).where('organizationId', '=', orgId).where('id', 'in', unique).execute();
  const counts = await t.selectFrom('approvalSteps').select(['requestId', (eb) => eb.fn.countAll<string>().as('n')]).where('requestId', 'in', unique).groupBy('requestId').execute();
  return new Map(reqs.map((r) => [r.id, { id: r.id, status: r.status as ApprovalRequestStatus, currentStep: r.currentStep, stepCount: Number(counts.find((c) => c.requestId === r.id)?.n ?? 0) }]));
}

/** Rows → DTOs (reviewer names, the charged leave type, the engine request's progress). System scope for the reference data. */
async function toNoteDtos(trx: Trx, orgId: string, rows: NoteRow[]): Promise<AttendanceNoteDto[]> {
  if (rows.length === 0) return [];
  return withSystemScope(trx, orgId, async (t) => {
    const userIds = [...new Set(rows.map((r) => r.reviewedBy).filter((x): x is string => !!x))];
    const users = userIds.length ? await t.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', userIds).execute() : [];
    const leaveIds = [...new Set(rows.map((r) => r.deductedLeaveRecordId).filter((x): x is string => !!x))];
    const leave = leaveIds.length ? await t.selectFrom('leaveRecords as l').innerJoin('leaveTypes as lt', 'lt.id', 'l.leaveTypeId').select(['l.id', 'lt.code', 'lt.name']).where('l.organizationId', '=', orgId).where('l.id', 'in', leaveIds).execute() : [];
    const requests = await requestsById(t, orgId, rows.map((r) => r.approvalRequestId));
    const nameOf = new Map(users.map((u) => [u.id, u.fullName || u.email]));
    const leaveOf = new Map(leave.map((l) => [l.id, l]));
    return rows.map((r): AttendanceNoteDto => {
      const req = r.approvalRequestId ? requests.get(r.approvalRequestId) : undefined;
      const l = r.deductedLeaveRecordId ? leaveOf.get(r.deductedLeaveRecordId) : undefined;
      return {
        id: r.id, employeeId: r.employeeId, attendanceDate: isoDate(r.attendanceDate), category: r.category, note: r.note, status: r.status, submittedAt: isoDateTime(r.submittedAt),
        reviewedBy: r.reviewedBy, reviewedByName: r.reviewedBy ? nameOf.get(r.reviewedBy) ?? null : null, reviewedAt: isoDateTimeOrNull(r.reviewedAt), reviewReason: r.reviewReason,
        reviewVia: r.reviewVia === 'manager' || r.reviewVia === 'oversight' ? r.reviewVia : null, infoRequestMessage: r.infoRequestMessage, infoRequestedAt: isoDateTimeOrNull(r.infoRequestedAt),
        payEffectDays: numberOrNull(r.payEffectDays), lossOfPay: r.lossOfPay, deductedLeaveTypeCode: l ? String(l.code) : null, deductedLeaveTypeName: l?.name ?? null,
        approvalRequestId: r.approvalRequestId, approvalStatus: req?.status ?? null, approvalCurrentStep: req?.currentStep ?? null, approvalStepCount: req?.stepCount ?? null,
        excusedAt: isoDateTimeOrNull(r.excusedAt), createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
      };
    });
  });
}

// ----- the employee's side -----------------------------------------------------------------------------------------------------------

export async function listMyNotes(deps: ApiDeps, actor: Actor, orgId: string, q: { from?: string | undefined; to?: string | undefined }): Promise<AttendanceNoteDto[]> {
  const self = portalSelf(actor, orgId, 'attendance.note', 'attendance.view_own');
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('attendanceNotes').select(NOTE_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', self.employeeId);
    if (q.from) base = base.where('attendanceDate', '>=', dv(q.from));
    if (q.to) base = base.where('attendanceDate', '<=', dv(q.to));
    const rows = (await base.orderBy('attendanceDate', 'desc').orderBy('submittedAt', 'desc').limit(500).execute()) as NoteRow[];
    return toNoteDtos(trx, orgId, rows);
  });
}

/**
 * Route a (re)submitted note: the workflow, else the line manager with the secondary standing in; returns the request id.
 * `answer`: the note was edited to answer an approver's question (review 8-P2-8) — its approvers hear "answer received" with
 * the new reason (`approval.info_answered`, recorded on the new request's timeline), not a fresh "waiting for your approval".
 */
async function routeNote(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, note: { id: string; attendanceDate: string }, emp: Awaited<ReturnType<typeof loadEmployeeCtx>>, branchId: string, opts: { answer?: string } = {}): Promise<string> {
  const answered = opts.answer !== undefined;
  const submitted = await submit(deps, trx, actor, orgId, { entityType: 'ATTENDANCE_NOTE', entityId: note.id, employeeId: emp.id, branchId, departmentId: emp.departmentId, units: null, requestedBy: actor.userId, noWorkflow: { kind: 'MANAGER' }, notifyFirstLevel: !answered });
  const secondary = await systemStep(trx, orgId, async (t) => {
    const s = await seatSecondaryManager(t, actor, orgId, { requestId: submitted.requestId, entityType: 'ATTENDANCE_NOTE', entityId: note.id, employeeId: emp.id, secondaryManagerEmployeeId: emp.secondaryManagerEmployeeId, employeeName: emp.displayName, notify: !answered });
    await t.updateTable('attendanceNotes').set({ approvalRequestId: submitted.requestId }).where('id', '=', note.id).execute();
    if (answered) await announceAnswer(t, actor, orgId, submitted.requestId, opts.answer ?? '');
    return s;
  });
  // the line managers who are NOT seated on the request (a workflow routed it elsewhere) still hear that a reason was given
  const seated = new Set([...submitted.firstStepActorIds, ...(secondary ? [secondary] : [])]);
  const managers = (await lineManagerUserIds(trx, orgId, emp, 'attendance.review_notes')).filter((u) => !seated.has(u));
  await emitToUsers(trx, actor, orgId, 'attendance.note_submitted', { type: 'attendance_note', id: note.id }, managers, { noteId: note.id, employeeId: emp.id, employeeName: emp.displayName, attendanceDate: note.attendanceDate, approvalRequestId: submitted.requestId });
  return submitted.requestId;
}

export async function submitNote(deps: ApiDeps, actor: Actor, orgId: string, input: SelfNoteInput): Promise<AttendanceNoteDto> {
  const self = portalSelf(actor, orgId, 'attendance.note');
  return runUser(deps.db, actor, async (trx) => {
    await lockEmployee(trx, 'notes', self.employeeId);
    const emp = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const today = localInstant(new Date(), emp.timezone).date;
    if (!isWorking(emp, today)) throw errors.forbidden('Your employment is not active.');
    if (input.date > addDays(today, NOTE_AHEAD_DAYS)) throw errors.validation(`A reason can be given at most ${NOTE_AHEAD_DAYS} days ahead.`, { issues: [{ path: 'date', message: 'Too far ahead' }] });
    if (input.date < emp.joiningDate) throw errors.validation('This date is before your joining date.', { issues: [{ path: 'date', message: 'Before joining date' }] });
    const branchId = (await withSystemScope(trx, orgId, (t) => effectiveBranchOn(t, orgId, emp.id, input.date))) ?? emp.branchId;
    if (await isPeriodLocked(trx, orgId, branchId, input.date)) throw errors.periodLocked('The attendance period of this date is locked.');
    const active = await withSystemScope(trx, orgId, (t) => t.selectFrom('attendanceNotes').select(['id', 'status']).where('organizationId', '=', orgId).where('employeeId', '=', emp.id).where('attendanceDate', '=', dv(input.date)).where('status', '!=', 'rejected').executeTakeFirst());
    if (active) {
      throw errors.conflict(OPEN_NOTE_STATUSES.includes(active.status) ? 'A reason for this day is already waiting for review; edit it instead.' : 'The reason for this day was already accepted.', { noteId: active.id, status: active.status });
    }
    const note = await systemStep(trx, orgId, async (t) => {
      const row = await t.insertInto('attendanceNotes').values({ organizationId: orgId, employeeId: emp.id, branchId, attendanceDate: input.date, category: input.category, note: input.note, status: 'pending', submittedBy: actor.userId })
        .returning('id').executeTakeFirstOrThrow();
      // while the reason is reviewed the day is not charged automatically: the day-close sweep's charge and marks are undone.
      // A reviewer's earlier rejection (NOTE_REVIEW) is NOT: re-filing must not buy back a decided pay effect — it stands until
      // this new reason is decided (approve / excuse reverse it, a new rejection replaces it).
      await clearReviewableMarks(t, deps, orgId, emp.id, input.date, actor.userId, 'reason given by the employee', actor.requestId, ['SWEEP']);
      return row;
    });
    await routeNote(deps, trx, actor, orgId, { id: note.id, attendanceDate: input.date }, emp, branchId);
    await audit(trx, actor, orgId, 'attendance.note_submitted', 'attendance_note', { entityId: note.id, branchId, newValue: input });
    const saved = (await withSystemScope(trx, orgId, (t) => loadNote(t, orgId, note.id)))!;
    return (await toNoteDtos(trx, orgId, [saved]))[0]!;
  });
}

/**
 * Edit one's own open reason. Any material change — the text or the category of a pending reason (HR portal Prompt 4 review,
 * P1-5; Finance B-96, like a leave edit), or an answer to a question (status info_requested) — sends it back for review: the
 * old request is INVALIDATED (the timeline reads "superseded") and a new one routed, so an approval given to the old text
 * never carries over to the new one. An edit that changes nothing leaves the request as it is. An ANSWER tells the approvers
 * so (review 8-P2-8): they hear `approval.info_answered` with the new reason, not "changed while pending" plus a new "waiting
 * for your approval" — the invalidation stays on the old request's timeline.
 */
export async function updateMyNote(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: SelfNoteUpdateInput): Promise<AttendanceNoteDto> {
  const self = portalSelf(actor, orgId, 'attendance.note');
  return runUser(deps.db, actor, async (trx) => {
    await lockEmployee(trx, 'notes', self.employeeId);
    const before = await withSystemScope(trx, orgId, (t) => loadNote(t, orgId, id));
    if (!before || before.employeeId !== self.employeeId) throw errors.notFound('Attendance note', id);
    if (!OPEN_NOTE_STATUSES.includes(before.status)) throw errors.invalidState(`Only a reason waiting for review can be edited (current: ${before.status}).`);
    const date = isoDate(before.attendanceDate);
    if (await isPeriodLocked(trx, orgId, before.branchId, date)) throw errors.periodLocked('The attendance period of this date is locked.');
    const emp = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const changed = (input.category !== undefined && input.category !== before.category) || (input.note !== undefined && input.note !== before.note);
    const answered = before.status === 'info_requested';
    const resubmit = answered || changed;
    await systemStep(trx, orgId, async (t) => {
      const res = await t.updateTable('attendanceNotes').set({ ...(input.category ? { category: input.category } : {}), ...(input.note ? { note: input.note } : {}), ...(resubmit ? { status: 'pending', submittedAt: new Date() } : {}) })
        .where('id', '=', id).where('status', '=', before.status).executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw errors.conflict('The reason changed meanwhile. Please refresh.');
      if (resubmit) await invalidateForEntity(t, actor, orgId, 'ATTENDANCE_NOTE', id, answered ? 'The employee answered the question and updated the reason.' : 'The employee changed the reason while it was waiting for review.', { notify: !answered });
    });
    if (resubmit) await routeNote(deps, trx, actor, orgId, { id, attendanceDate: date }, emp, before.branchId ?? emp.branchId, answered ? { answer: input.note ?? before.note } : {});
    await audit(trx, actor, orgId, resubmit ? 'attendance.note_resubmitted' : 'attendance.note_updated', 'attendance_note', { entityId: id, branchId: before.branchId, oldValue: { category: before.category, note: before.note, status: before.status }, newValue: input });
    const saved = (await withSystemScope(trx, orgId, (t) => loadNote(t, orgId, id)))!;
    return (await toNoteDtos(trx, orgId, [saved]))[0]!;
  });
}

// ----- the reviewer's side ------------------------------------------------------------------------------------------------------------

const hasOversightKeys = (grant: MembershipGrant) => hasPermission(grant, 'attendance.view') && OVERSIGHT_KEYS.some((k) => hasPermission(grant, k));
const NIL = '00000000-0000-0000-0000-000000000000';

async function delegatorsOf(t: Trx, orgId: string, userId: string): Promise<string[]> {
  const map = await loadDelegationMap(t, orgId, 'ATTENDANCE_NOTE', await orgToday(t, orgId));
  return [...map.entries()].filter(([, delegate]) => delegate === userId).map(([delegator]) => delegator);
}

/**
 * The review list. `mine` = my direct reports' reasons and the ones the engine routed to me (or to somebody who delegates to
 * me); `team` = my direct reports; `all` = the organisation within my branch scope (oversight keys). Read in the system
 * scope after the scope rule has decided which rows the caller may see (a line manager's role may not read notes by RLS).
 */
export async function listNotesForReview(deps: ApiDeps, actor: Actor, orgId: string, q: AttendanceNotesQuery): Promise<{ data: AttendanceNoteReviewItemDto[]; total: number }> {
  const grant = requireMembership(actor.principal, orgId);
  const oversight = hasOversightKeys(grant);
  if (q.scope === 'all' && !oversight) throw errors.forbidden('Missing permission: attendance.review_notes (or attendance.approve) with attendance.view.');
  const scope = q.scope === 'all' ? branchFilter(grant) : null;
  return runUser(deps.db, actor, async (trx) => withSystemScope(trx, orgId, async (t) => {
    const delegators = await delegatorsOf(t, orgId, actor.userId);
    const routedIds = q.scope === 'mine' ? [...await routedToUser(t, orgId, 'ATTENDANCE_NOTE', actor.userId, delegators)] : [];
    const team = grant.teamEmployeeIds.length ? grant.teamEmployeeIds : [NIL];
    let base = t.selectFrom('attendanceNotes as n').where('n.organizationId', '=', orgId).where('n.employeeId', '!=', grant.employeeId ?? NIL);
    if (q.scope === 'mine') {
      base = base.where((eb) => eb.or([eb('n.employeeId', 'in', team), ...(routedIds.length ? [eb('n.id', 'in', t.selectFrom('approvalRequests').select('entityId').where('id', 'in', routedIds))] : [])]));
    } else if (q.scope === 'team') base = base.where('n.employeeId', 'in', team);
    else if (scope) base = base.where((eb) => eb.or([eb('n.branchId', 'in', scope), eb('n.employeeId', 'in', team)]));
    if (q.status) base = base.where('n.status', '=', q.status);
    if (q.open) base = base.where('n.status', 'in', [...OPEN_NOTE_STATUSES]);
    if (q.employeeId) base = base.where('n.employeeId', '=', q.employeeId);
    if (q.from) base = base.where('n.attendanceDate', '>=', dv(q.from));
    if (q.to) base = base.where('n.attendanceDate', '<=', dv(q.to));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('c')).executeTakeFirst())?.c);
    const page = pageOf(q);
    const rows = (await base.selectAll('n').orderBy('n.attendanceDate', q.open ? 'asc' : 'desc').orderBy('n.submittedAt', 'asc').orderBy('n.id').limit(page.pageSize).offset(page.offset).execute()) as NoteRow[];
    return { data: await toReviewItems(t, actor, grant, orgId, rows, delegators), total };
  }));
}

async function toReviewItems(t: Trx, actor: Actor, grant: MembershipGrant, orgId: string, rows: NoteRow[], delegators: readonly string[]): Promise<AttendanceNoteReviewItemDto[]> {
  if (rows.length === 0) return [];
  const base = await toNoteDtos(t, orgId, rows);
  const employees = new Map((await t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', 'in', [...new Set(rows.map((r) => r.employeeId))]).execute()).map((e) => [e.id, e]));
  const branchIds = [...new Set(rows.map((r) => r.branchId).filter((x): x is string => !!x))];
  const branches = new Map(branchIds.length ? (await t.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', branchIds).execute()).map((b) => [b.id, b.name]) : []);
  const counts = await excusedCounts(t, orgId, rows.map((r) => ({ employeeId: r.employeeId, year: Number(isoDate(r.attendanceDate).slice(0, 4)) })));
  const liveRequests = rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x);
  const routed = await routedToUser(t, orgId, 'ATTENDANCE_NOTE', actor.userId, delegators, liveRequests);
  const pending = new Set((liveRequests.length ? await t.selectFrom('approvalRequests').select('id').where('id', 'in', liveRequests).where('status', '=', 'PENDING').execute() : []).map((r) => r.id));
  const out: AttendanceNoteReviewItemDto[] = [];
  for (const [i, r] of rows.entries()) {
    const date = isoDate(r.attendanceDate);
    const day = await dayFacts(t, orgId, r.employeeId, date);
    const isRouted = !!r.approvalRequestId && routed.has(r.approvalRequestId);
    const manager = isTeamMember(grant, r.employeeId);
    const role = reviewerRole(grant, { id: r.employeeId, branchId: r.branchId }, OVERSIGHT_KEYS);
    const live = !!r.approvalRequestId && pending.has(r.approvalRequestId);
    const open = OPEN_NOTE_STATUSES.includes(r.status);
    const e = employees.get(r.employeeId);
    out.push({
      ...base[i]!, employeeName: e?.displayName ?? '', employeeNumber: e?.employeeNumber ?? '', branchId: r.branchId, branchName: r.branchId ? branches.get(r.branchId) ?? null : null,
      dayStatus: day?.status ?? null, dayFlags: (day?.flags ?? []) as AttendanceFlag[], firstInAt: day?.firstInAt ?? null, lastOutAt: day?.lastOutAt ?? null, timezone: day?.timezone ?? null,
      excusedCountYear: counts.get(`${r.employeeId}|${date.slice(0, 4)}`) ?? 0,
      isOversight: !isRouted && !manager,
      // seated (or delegated) on the live request, organisation-wide oversight, or — without a live request — the line manager
      canReview: open && r.employeeId !== grant.employeeId && (isRouted || role === 'oversight' || (!live && role === 'manager')),
    });
  }
  return out;
}

function chargeOf(note: NoteRow | undefined): NoteChargeDto | null {
  if (!note || note.status !== 'rejected') return null;
  const days = numberOrNull(note.payEffectDays) ?? 0;
  return { outcome: note.lossOfPay ? 'lop' : note.deductedLeaveRecordId ? 'charged_leave' : days > 0 ? 'no_effect' : 'not_applicable', payEffectDays: days, leaveTypeCode: null };
}

export async function reviewNote(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: NoteReviewInput): Promise<NoteReviewResultDto> {
  const grant = requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const note = await withSystemScope(trx, orgId, (t) => loadNote(t, orgId, id));
    if (!note) throw errors.notFound('Attendance note', id);
    // segregation of duties on the LIVE employee link: nobody reviews their own reason, whatever their keys
    if (grant.employeeId && grant.employeeId === note.employeeId) throw errors.forbidden('You cannot review your own attendance reason.');
    const request = await withSystemScope(trx, orgId, (t) => pendingRequestOf(t, orgId, 'ATTENDANCE_NOTE', note.id));
    const routed = request ? (await withSystemScope(trx, orgId, async (t) => routedToUser(t, orgId, 'ATTENDANCE_NOTE', actor.userId, await delegatorsOf(t, orgId, actor.userId), [request.id]))).has(request.id) : false;
    const role = reviewerRole(grant, { id: note.employeeId, branchId: note.branchId }, OVERSIGHT_KEYS);
    if (!routed && !role) throw errors.forbidden('You are not a reviewer of this attendance reason.');
    if (!OPEN_NOTE_STATUSES.includes(note.status)) throw errors.invalidState(`This reason was already ${note.status}.`);
    const date = isoDate(note.attendanceDate);
    if (input.decision !== 'request_info' && await isPeriodLocked(trx, orgId, note.branchId, date)) throw errors.periodLocked('The attendance period of this date is locked.');
    let requestStatus: ApprovalRequestStatus | null = null; let terminal = true;
    const comment = input.reason ?? (input.decision === 'reject' ? 'The reason was not accepted.' : undefined);
    if (request) {
      if (input.decision === 'request_info') {
        await requestInfo(deps, trx, actor, orgId, request.id, input.reason!);
        requestStatus = 'PENDING'; terminal = false;
      } else {
        // the current level is named explicitly: an organisation-wide reviewer who is not seated decides as an override of it
        // the seat an override fills, when the level waits for several reviewers (engine §9.8): the review page names it
        const outcome = await decideWithin(deps, trx, actor, orgId, request.id, {
          stepNo: request.currentStep, decision: input.decision === 'reject' ? 'REJECT' : 'APPROVE', comment,
          ...(input.decision === 'reject' ? { payEffectDays: input.payEffectDays ?? 0 } : {}), ...(input.onBehalfOfUserId ? { onBehalfOfUserId: input.onBehalfOfUserId } : {}), detail: { outcome: input.decision, source: 'note_review' },
        });
        requestStatus = outcome.status as ApprovalRequestStatus; terminal = outcome.terminal;
      }
    } else {
      // no live request (withdrawn or superseded): the line manager or oversight decides the note directly
      if (!role) throw errors.forbidden('You are not a reviewer of this attendance reason.');
      await systemStep(trx, orgId, async (t) => {
        const ctx = { orgId, entityId: note.id, actor, comment: comment ?? null, detail: { outcome: input.decision, via: role === 'manager' ? 'actor' : 'permission', ...(input.decision === 'reject' ? { payEffectDays: input.payEffectDays ?? 0 } : {}) } };
        if (input.decision === 'request_info') await applyNoteInfoRequest(t, ctx);
        else await applyNoteDecision(deps, t, ctx, input.decision);
      });
      terminal = input.decision !== 'request_info';
    }
    await audit(trx, actor, orgId, REVIEW_AUDIT_ACTION[input.decision], 'attendance_note', {
      entityId: note.id, branchId: note.branchId, reason: input.reason ?? null, newValue: { decision: input.decision, payEffectDays: input.payEffectDays ?? null, via: routed ? 'seat' : role, requestId: request?.id ?? null, terminal, onBehalfOfUserId: input.onBehalfOfUserId ?? null },
    });
    const after = (await withSystemScope(trx, orgId, (t) => loadNote(t, orgId, note.id)))!;
    const [dto] = await toNoteDtos(trx, orgId, [after]);
    const charge = chargeOf(after);
    if (charge && after.deductedLeaveRecordId) charge.leaveTypeCode = dto!.deductedLeaveTypeCode;
    return { note: dto!, requestStatus, terminal, charge };
  });
}
