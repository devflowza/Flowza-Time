import { sql } from 'kysely';
import type { ApprovalContextDto, AttendanceNoteCategory, AttendanceNoteStatus, AttendanceStatus, DayMarkSource } from '@flowza/contracts';
import { activeMarksOn, chargeUnexcusedDay, markDay, reverseUnexcusedCharge, revokeMark, type ChargeOutcome, type Trx } from '@flowza/database';
import type { ApiDeps } from '../../deps.js';
import { isTeamMember } from '../../lib/authorize.js';
import { isoDate, isoDateTimeOrNull, numberOrNull } from '../../lib/mappers.js';
import type { Actor } from '../../lib/service.js';
import type { HookContext } from '../approvals/hooks/index.js';
import { attendancePolicy, emitToUsers, userIdsOfEmployees } from './common.js';

/**
 * What a decision on an attendance note DOES (HR portal Prompt 4; Finance `decide_attendance_note`). Shared by the approval
 * engine's ATTENDANCE_NOTE hook (a decision from the inbox, an e-mail link or the notes review page) and by the review
 * endpoint when a note has no live request. Runs in the organisation's system scope. Never imports the engine.
 *
 *   approve  the reason is accepted: whatever the day-close sweep or an earlier review charged for the day (PAY_EFFECT /
 *            LOP marks, the auto-charged leave row) is reversed and their UNEXCUSED marks revoked — never HR's own marks.
 *   excuse   as approve, plus an EXCUSED mark: the day keeps its late / absent facts but carries no pay effect.
 *   reject   the day stays unexplained: when it needed an explanation (absent, late, missing punch) it is marked UNEXCUSED
 *            (source NOTE_REVIEW) and the chosen pay effect (0 / ½ / 1 day) is charged through the one pay-effect charger —
 *            paid leave in the tenant's priority order first, loss of pay otherwise.
 *   info     the reviewer's question is stored on the note (status info_requested) until the employee answers.
 */

/** Sources whose marks an employee's reason may undo (the sweep's and a previous review's); HR's marks stay. */
export const REVIEWABLE_MARK_SOURCES: readonly DayMarkSource[] = ['SWEEP', 'NOTE_REVIEW'];
export const OPEN_NOTE_STATUSES: readonly AttendanceNoteStatus[] = ['pending', 'info_requested'];

export type NoteRow = {
  id: string; organizationId: string; employeeId: string; branchId: string | null; attendanceDate: Date | string; category: AttendanceNoteCategory; note: string; status: AttendanceNoteStatus;
  submittedBy: string | null; submittedAt: Date; reviewedBy: string | null; reviewedAt: Date | null; reviewReason: string | null; reviewVia: string | null;
  infoRequestMessage: string | null; infoRequestedAt: Date | null; infoRequestedBy: string | null; payEffectDays: string | number | null; lossOfPay: boolean;
  deductedLeaveRecordId: string | null; dayMarkId: string | null; approvalRequestId: string | null; excusedAt: Date | null; excusedBy: string | null; createdAt: Date; updatedAt: Date;
};
export const NOTE_COLUMNS = ['id', 'organizationId', 'employeeId', 'branchId', 'attendanceDate', 'category', 'note', 'status', 'submittedBy', 'submittedAt', 'reviewedBy', 'reviewedAt', 'reviewReason', 'reviewVia',
  'infoRequestMessage', 'infoRequestedAt', 'infoRequestedBy', 'payEffectDays', 'lossOfPay', 'deductedLeaveRecordId', 'dayMarkId', 'approvalRequestId', 'excusedAt', 'excusedBy', 'createdAt', 'updatedAt'] as const;

export async function loadNote(t: Trx, orgId: string, id: string): Promise<NoteRow | undefined> {
  return (await t.selectFrom('attendanceNotes').select(NOTE_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst()) as NoteRow | undefined;
}

export interface DayFacts { status: AttendanceStatus; flags: string[]; firstInAt: string | null; lastOutAt: string | null; timezone: string | null }
export async function dayFacts(t: Trx, orgId: string, employeeId: string, date: string): Promise<DayFacts | null> {
  const r = await t.selectFrom('attendanceDailyRecords').select(['status', 'flags', 'firstInAt', 'lastOutAt', 'timezone']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('attendanceDate', '=', sql<Date>`${date}::date`).executeTakeFirst();
  return r ? { status: r.status as AttendanceStatus, flags: (r.flags ?? []) as string[], firstInAt: isoDateTimeOrNull(r.firstInAt), lastOutAt: isoDateTimeOrNull(r.lastOutAt), timezone: r.timezone } : null;
}

/** A day that has to be explained: absent, late, or missing a punch (the day-close sweep's causes). */
export function needsExplanation(day: Pick<DayFacts, 'status' | 'flags'> | null): boolean {
  if (!day) return false;
  return day.status === 'ABSENT' || day.status === 'MISSING_PUNCH' || day.flags.includes('LATE') || day.flags.includes('MISSING_IN') || day.flags.includes('MISSING_OUT');
}

/**
 * Undo what the sweep or an earlier review charged or marked on the day (reversible charges, UNEXCUSED marks). Idempotent.
 * `sources` narrows it: a newly filed reason undoes only the automatic sweep's charge; a reviewer's rejection stands until
 * the new reason is itself decided.
 */
export async function clearReviewableMarks(t: Trx, deps: ApiDeps, orgId: string, employeeId: string, date: string, actorUserId: string | null, reason: string, correlationId?: string, sources: readonly DayMarkSource[] = REVIEWABLE_MARK_SOURCES): Promise<{ reversed: number }> {
  const res = await reverseUnexcusedCharge(t, deps.queue, { organizationId: orgId, employeeId, date, revokedBy: actorUserId, reason, sources }, correlationId ? { correlationId } : {});
  let reversed = res.reversedMarks.length;
  for (const m of await activeMarksOn(t, orgId, employeeId, date)) {
    if (m.kind === 'UNEXCUSED' && sources.includes(m.source)) {
      if (await revokeMark(t, deps.queue, { organizationId: orgId, markId: m.id, revokedBy: actorUserId, reason }, correlationId ? { correlationId } : {})) reversed += 1;
    }
  }
  return { reversed };
}

/** Whether the decider acted as the employee's line manager (a mapped manager, or seated on the level) or through organisation-wide oversight. */
export function reviewVia(actor: Actor, orgId: string, employeeId: string, via: unknown): 'manager' | 'oversight' {
  const grant = actor.principal.memberships.find((m) => m.organizationId === orgId);
  if (via === 'actor' || via === 'delegate') return 'manager';
  return grant && isTeamMember(grant, employeeId) ? 'manager' : 'oversight';
}

const payEffectOf = (v: unknown): 0 | 0.5 | 1 => (v === 1 || v === '1' ? 1 : v === 0.5 || v === '0.5' ? 0.5 : 0);

export interface NoteDecisionResult { outcome: 'approved' | 'excused' | 'rejected'; charge: { outcome: ChargeOutcome | 'not_applicable'; payEffectDays: number; leaveTypeCode: string | null } | null }

/** Apply an approve / excuse / reject to an OPEN note (a closed one is left alone: the call is idempotent). */
export async function applyNoteDecision(deps: ApiDeps, t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'actor' | 'comment' | 'detail'>, decision: 'approve' | 'excuse' | 'reject'): Promise<NoteDecisionResult | null> {
  const note = await loadNote(t, ctx.orgId, ctx.entityId);
  if (!note || !OPEN_NOTE_STATUSES.includes(note.status)) return null;
  const date = isoDate(note.attendanceDate);
  const via = reviewVia(ctx.actor, ctx.orgId, note.employeeId, ctx.detail?.['via']);
  const now = new Date();
  const correlationId = ctx.actor.requestId;
  let result: NoteDecisionResult;
  if (decision === 'reject') {
    const payEffectDays = payEffectOf(ctx.detail?.['payEffectDays']);
    const day = await dayFacts(t, ctx.orgId, note.employeeId, date);
    let dayMarkId: string | null = null; let leaveRecordId: string | null = null; let lossOfPay = false;
    let charge: NoteDecisionResult['charge'] = { outcome: 'not_applicable', payEffectDays: 0, leaveTypeCode: null };
    if (needsExplanation(day)) {
      // a fresh review replaces an earlier one's marks (a re-submitted note that is rejected again)
      await clearReviewableMarks(t, deps, ctx.orgId, note.employeeId, date, ctx.actor.userId, 'superseded by a new review', correlationId);
      // one active mark per kind: an UNEXCUSED mark HR already wrote stays as it is (never superseded by a review)
      const unexcused = await markDay(t, deps.queue, { organizationId: ctx.orgId, employeeId: note.employeeId, attendanceDate: date, kind: 'UNEXCUSED', payEffectDays, source: 'NOTE_REVIEW', sourceId: note.id, reason: `Reason not accepted${ctx.comment ? `: ${ctx.comment}` : ''}`.slice(0, 1000), createdBy: ctx.actor.userId }, { correlationId, supersede: false });
      dayMarkId = unexcused.mark.id;
      charge = { outcome: 'no_effect', payEffectDays, leaveTypeCode: null };
      if (payEffectDays > 0) {
        const settings = await attendancePolicy(t, ctx.orgId);
        const c = await chargeUnexcusedDay(t, deps.queue, { organizationId: ctx.orgId, employeeId: note.employeeId, date, payEffectDays, sourceKind: 'NOTE_REVIEW', sourceId: note.id, createdBy: ctx.actor.userId, reason: `Attendance reason not accepted (${date})`, halfDayPart: day?.flags.includes('LATE') ? 'FIRST_HALF' : 'SECOND_HALF' }, settings.unexcused, { correlationId });
        charge = { outcome: c.outcome, payEffectDays: c.payEffectDays, leaveTypeCode: c.leaveTypeCode };
        if (c.mark && (c.outcome === 'charged_leave' || c.outcome === 'lop')) dayMarkId = c.mark.id;
        leaveRecordId = c.leaveRecordId;
        lossOfPay = c.outcome === 'lop';
      }
    }
    await t.updateTable('attendanceNotes').set({ status: 'rejected', reviewedBy: ctx.actor.userId, reviewedAt: now, reviewReason: ctx.comment, reviewVia: via, payEffectDays, lossOfPay, deductedLeaveRecordId: leaveRecordId, dayMarkId })
      .where('id', '=', note.id).where('status', 'in', [...OPEN_NOTE_STATUSES]).execute();
    result = { outcome: 'rejected', charge };
  } else {
    await clearReviewableMarks(t, deps, ctx.orgId, note.employeeId, date, ctx.actor.userId, decision === 'excuse' ? 'excused on review' : 'reason accepted on review', correlationId);
    let dayMarkId: string | null = null;
    if (decision === 'excuse') {
      const m = await markDay(t, deps.queue, { organizationId: ctx.orgId, employeeId: note.employeeId, attendanceDate: date, kind: 'EXCUSED', source: 'NOTE_REVIEW', sourceId: note.id, reason: `Excused on review${ctx.comment ? `: ${ctx.comment}` : ''}`.slice(0, 1000), createdBy: ctx.actor.userId }, { correlationId, supersede: false });
      dayMarkId = m.mark.id;
    }
    await t.updateTable('attendanceNotes').set({
      status: decision === 'excuse' ? 'excused' : 'approved', reviewedBy: ctx.actor.userId, reviewedAt: now, reviewReason: ctx.comment, reviewVia: via, payEffectDays: null, lossOfPay: false, deductedLeaveRecordId: null, dayMarkId,
      ...(decision === 'excuse' ? { excusedAt: now, excusedBy: ctx.actor.userId } : {}),
    }).where('id', '=', note.id).where('status', 'in', [...OPEN_NOTE_STATUSES]).execute();
    result = { outcome: decision === 'excuse' ? 'excused' : 'approved', charge: null };
  }
  await emitToUsers(t, ctx.actor, ctx.orgId, 'attendance.note_decided', { type: 'attendance_note', id: note.id }, await userIdsOfEmployees(t, ctx.orgId, [note.employeeId]), {
    noteId: note.id, employeeId: note.employeeId, attendanceDate: date, decision: result.outcome, reason: ctx.comment, reviewVia: via,
    payEffectDays: result.charge?.payEffectDays ?? 0, chargeOutcome: result.charge?.outcome ?? null, leaveTypeCode: result.charge?.leaveTypeCode ?? null, lossOfPay: result.charge?.outcome === 'lop',
  });
  return result;
}

/** The reviewer asked a question: stored on the note, the employee is told (attendance.note_info_requested). */
export async function applyNoteInfoRequest(t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'actor' | 'comment'>): Promise<boolean> {
  const note = await loadNote(t, ctx.orgId, ctx.entityId);
  if (!note || !OPEN_NOTE_STATUSES.includes(note.status)) return false;
  await t.updateTable('attendanceNotes').set({ status: 'info_requested', infoRequestMessage: ctx.comment, infoRequestedAt: new Date(), infoRequestedBy: ctx.actor.userId }).where('id', '=', note.id).execute();
  await emitToUsers(t, ctx.actor, ctx.orgId, 'attendance.note_info_requested', { type: 'attendance_note', id: note.id }, await userIdsOfEmployees(t, ctx.orgId, [note.employeeId]),
    { noteId: note.id, employeeId: note.employeeId, attendanceDate: isoDate(note.attendanceDate), question: ctx.comment });
  return true;
}

/** The employee answered (in the inbox, or by editing the note): the note is pending again; the question stays for the record. */
export async function applyNoteInfoAnswered(t: Trx, orgId: string, noteId: string): Promise<void> {
  await t.updateTable('attendanceNotes').set({ status: 'pending' }).where('organizationId', '=', orgId).where('id', '=', noteId).where('status', '=', 'info_requested').execute();
}

/** Excused days of employees per calendar year (the reviewer's badge). */
export async function excusedCounts(t: Trx, orgId: string, pairs: ReadonlyArray<{ employeeId: string; year: number }>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const employeeIds = [...new Set(pairs.map((p) => p.employeeId))];
  if (employeeIds.length === 0) return out;
  const years = [...new Set(pairs.map((p) => p.year))];
  const rows = await t.selectFrom('attendanceNotes').select(['employeeId', sql<number>`extract(year from attendance_date)::int`.as('year'), (eb) => eb.fn.countAll<string>().as('n')])
    .where('organizationId', '=', orgId).where('employeeId', 'in', employeeIds).where('status', '=', 'excused')
    .where(sql<boolean>`extract(year from attendance_date)::int = any(${sql.val(years)}::int[])`)
    .groupBy(['employeeId', sql`extract(year from attendance_date)::int`]).execute();
  for (const r of rows) out.set(`${r.employeeId}|${r.year}`, Number(r.n));
  return out;
}

/** Inbox / detail context of ATTENDANCE_NOTE requests (system scope; ids the caller could already see). */
export async function noteContexts(t: Trx, orgId: string, ids: string[]): Promise<Map<string, ApprovalContextDto>> {
  const out = new Map<string, ApprovalContextDto>();
  if (ids.length === 0) return out;
  const notes = (await t.selectFrom('attendanceNotes').select(NOTE_COLUMNS).where('organizationId', '=', orgId).where('id', 'in', ids).execute()) as NoteRow[];
  const counts = await excusedCounts(t, orgId, notes.map((n) => ({ employeeId: n.employeeId, year: Number(isoDate(n.attendanceDate).slice(0, 4)) })));
  for (const n of notes) {
    const date = isoDate(n.attendanceDate);
    const day = await dayFacts(t, orgId, n.employeeId, date);
    const summary = `${n.category.replace('_', ' ')} · ${date}`;
    out.set(n.id, { kind: 'ATTENDANCE_NOTE', summary, note: { id: n.id, attendanceDate: date, category: n.category, note: n.note, status: n.status, dayStatus: day?.status ?? null, dayFlags: day?.flags ?? [], excusedCountYear: counts.get(`${n.employeeId}|${date.slice(0, 4)}`) ?? 0, payEffectDays: numberOrNull(n.payEffectDays), lossOfPay: n.lossOfPay, infoRequestMessage: n.infoRequestMessage } });
  }
  return out;
}
