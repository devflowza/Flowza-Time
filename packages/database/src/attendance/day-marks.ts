import { sql } from 'kysely';
import type { DayMarkKind, DayMarkSource } from '@flowza/contracts';
import type { Trx } from '../context.js';
import type { JobQueue } from '../queue.js';
import { enqueueRecompute, type RecomputeReason } from './recompute-queue.js';

/**
 * `attendance_day_marks` — the reviewed verdicts on employee-days (HR portal Prompt 3). Shared by the API (HR endpoints,
 * the note review of Prompt 4) and the worker (day-close sweep, pay-effect charger). Every write enqueues the day's
 * RECOMPUTE_DAILY in the same transaction, so the daily record picks the mark up through the engine (flags, lopDays)
 * and never by a direct update of the record.
 *
 * Runs under whatever context the caller established: a user context needs `attendance.approve` (RLS write policy),
 * the worker uses the organisation's system context.
 */

export interface DayMarkRow {
  id: string;
  organizationId: string;
  employeeId: string;
  attendanceDate: string;
  branchId: string | null;
  kind: DayMarkKind;
  payEffectDays: number;
  source: DayMarkSource;
  sourceId: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export interface MarkDayInput {
  organizationId: string;
  employeeId: string;
  attendanceDate: string;
  kind: DayMarkKind;
  /** 0 / 0.5 / 1; required (> 0) for LOP and PAY_EFFECT, ignored for EXCUSED. */
  payEffectDays?: number;
  source: DayMarkSource;
  sourceId?: string | null;
  reason?: string | null;
  createdBy?: string | null;
  /** The employee's branch on the date; resolved from employment history when omitted. */
  branchId?: string | null;
}

export interface MarkDayOptions {
  now?: Date;
  /** History reason of the recompute (default MANUAL_OVERRIDE for HR / NOTE_REVIEW marks, RECALCULATION for SWEEP / SYSTEM). */
  recomputeReason?: RecomputeReason;
  correlationId?: string;
  /** When an active mark of the same kind exists with a different pay effect: revoke it and write the new one (default true). */
  supersede?: boolean;
}

export interface MarkDayResult { mark: DayMarkRow; created: boolean; supersededMarkId: string | null }

/** `date` columns arrive as JS Dates built from local components (pg-types) or as `YYYY-MM-DD` strings. */
export function isoDateOf(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
}
const dv = (date: string) => sql<Date>`${date}::date`;

type RawMarkRow = { id: string; organizationId: string; employeeId: string; attendanceDate: Date | string; branchId: string | null; kind: string; payEffectDays: string | number; source: string; sourceId: string | null; reason: string | null; createdBy: string | null; createdAt: Date | string; revokedAt: Date | string | null; revokedBy: string | null; revokeReason: string | null };
export function toDayMarkRow(r: RawMarkRow): DayMarkRow {
  return {
    id: r.id, organizationId: r.organizationId, employeeId: r.employeeId, attendanceDate: isoDateOf(r.attendanceDate), branchId: r.branchId, kind: r.kind as DayMarkKind, payEffectDays: Number(r.payEffectDays),
    source: r.source as DayMarkSource, sourceId: r.sourceId, reason: r.reason, createdBy: r.createdBy, createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
    revokedAt: r.revokedAt === null ? null : r.revokedAt instanceof Date ? r.revokedAt : new Date(r.revokedAt), revokedBy: r.revokedBy, revokeReason: r.revokeReason,
  };
}

/** A pay effect is 0, half a day or a full day. */
function normalisePayEffect(days: number | undefined): 0 | 0.5 | 1 {
  if (days === undefined || !Number.isFinite(days) || days < 0.5) return 0;
  return days >= 1 ? 1 : 0.5;
}

/** The employee's branch effective on a date: employment history (half-open `[from, to)`), else the master record. Null when the employee is unknown / deleted. */
export async function effectiveBranchOn(trx: Trx, organizationId: string, employeeId: string, date: string): Promise<string | null> {
  const hist = await trx.selectFrom('employmentHistory').select('branchId')
    .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId)
    .where('effectiveFrom', '<=', dv(date)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(date))]))
    .orderBy('effectiveFrom', 'desc').executeTakeFirst();
  if (hist) return hist.branchId;
  const emp = await trx.selectFrom('employees').select('branchId').where('organizationId', '=', organizationId).where('id', '=', employeeId).where('deletedAt', 'is', null).executeTakeFirst();
  return emp?.branchId ?? null;
}

/** Active (unrevoked) marks of one employee-day, oldest first. */
export async function activeMarksOn(trx: Trx, organizationId: string, employeeId: string, date: string): Promise<DayMarkRow[]> {
  const rows = await trx.selectFrom('attendanceDayMarks').selectAll()
    .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId).where('attendanceDate', '=', dv(date)).where('revokedAt', 'is', null)
    .orderBy('createdAt', 'asc').orderBy('id', 'asc').execute();
  return rows.map(toDayMarkRow);
}

/** Active marks of many employees over a date range (one query; the sweep and the loaders use it). */
export async function activeMarksBetween(trx: Trx, organizationId: string, employeeIds: readonly string[], from: string, to: string): Promise<DayMarkRow[]> {
  if (employeeIds.length === 0) return [];
  const rows = await trx.selectFrom('attendanceDayMarks').selectAll()
    .where('organizationId', '=', organizationId).where('employeeId', 'in', [...employeeIds]).where('attendanceDate', '>=', dv(from)).where('attendanceDate', '<=', dv(to)).where('revokedAt', 'is', null)
    .orderBy('attendanceDate', 'asc').orderBy('createdAt', 'asc').execute();
  return rows.map(toDayMarkRow);
}

const defaultReason = (source: DayMarkSource): RecomputeReason => (source === 'HR' || source === 'NOTE_REVIEW' ? 'MANUAL_OVERRIDE' : 'RECALCULATION');

/**
 * Write one mark for an employee-day and queue the day's recompute. Idempotent per (employee, date, kind): an active
 * mark of the same kind and pay effect is returned as is; one with a different pay effect is revoked (reason
 * "superseded") and replaced when `supersede` is on, otherwise returned unchanged.
 */
export async function markDay(trx: Trx, queue: JobQueue, input: MarkDayInput, opts: MarkDayOptions = {}): Promise<MarkDayResult> {
  const now = opts.now ?? new Date();
  const payEffectDays = input.kind === 'EXCUSED' ? 0 : normalisePayEffect(input.payEffectDays);
  if ((input.kind === 'LOP' || input.kind === 'PAY_EFFECT') && payEffectDays === 0) throw new Error(`${input.kind} mark needs a pay effect of 0.5 or 1 day`);
  const existing = (await activeMarksOn(trx, input.organizationId, input.employeeId, input.attendanceDate)).find((m) => m.kind === input.kind);
  let supersededMarkId: string | null = null;
  if (existing) {
    if (existing.payEffectDays === payEffectDays || opts.supersede === false) return { mark: existing, created: false, supersededMarkId: null };
    await trx.updateTable('attendanceDayMarks').set({ revokedAt: now, revokedBy: input.createdBy ?? null, revokeReason: `superseded by a new ${input.kind} mark (${payEffectDays} day)` }).where('id', '=', existing.id).execute();
    supersededMarkId = existing.id;
  }
  const branchId = input.branchId === undefined ? await effectiveBranchOn(trx, input.organizationId, input.employeeId, input.attendanceDate) : input.branchId;
  const inserted = await trx.insertInto('attendanceDayMarks').values({
    organizationId: input.organizationId, employeeId: input.employeeId, attendanceDate: input.attendanceDate, branchId, kind: input.kind, payEffectDays, source: input.source,
    sourceId: input.sourceId ?? null, reason: input.reason ?? null, createdBy: input.createdBy ?? null, createdAt: now,
  }).returningAll().executeTakeFirstOrThrow();
  await enqueueRecompute(queue, { organizationId: input.organizationId, employeeId: input.employeeId, date: input.attendanceDate, reason: opts.recomputeReason ?? defaultReason(input.source), triggeredBy: input.createdBy ?? null, ...(opts.correlationId ? { correlationId: opts.correlationId } : {}) }, trx);
  return { mark: toDayMarkRow(inserted), created: true, supersededMarkId };
}

export interface RevokeMarkInput { organizationId: string; markId: string; revokedBy?: string | null; reason: string }

/** Revoke one mark (idempotent: an already revoked mark is returned as is) and queue the day's recompute. Returns null when the mark is not visible to the caller. */
export async function revokeMark(trx: Trx, queue: JobQueue, input: RevokeMarkInput, opts: { now?: Date; recomputeReason?: RecomputeReason; correlationId?: string } = {}): Promise<DayMarkRow | null> {
  const now = opts.now ?? new Date();
  const row = await trx.selectFrom('attendanceDayMarks').selectAll().where('organizationId', '=', input.organizationId).where('id', '=', input.markId).forUpdate().executeTakeFirst();
  if (!row) return null;
  if (row.revokedAt !== null) return toDayMarkRow(row);
  const updated = await trx.updateTable('attendanceDayMarks').set({ revokedAt: now, revokedBy: input.revokedBy ?? null, revokeReason: input.reason }).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
  const mark = toDayMarkRow(updated);
  await enqueueRecompute(queue, { organizationId: input.organizationId, employeeId: mark.employeeId, date: mark.attendanceDate, reason: opts.recomputeReason ?? (mark.source === 'HR' || mark.source === 'NOTE_REVIEW' ? 'MANUAL_OVERRIDE' : 'RECALCULATION'), triggeredBy: input.revokedBy ?? null, ...(opts.correlationId ? { correlationId: opts.correlationId } : {}) }, trx);
  return mark;
}
