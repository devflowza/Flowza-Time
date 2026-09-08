import { sql } from 'kysely';
import type { Trx } from '@flowza/database';
import type { TracePunchLike } from '@flowza/domain';
import { asArray, asDate, asObject, chunk, isoDate, toDate } from '../../attendance/common.js';
import type { ReportContext } from '../context.js';

export interface RecordLeave { code: string; name: string; isPaid: boolean; treatAsPresent: boolean; isHalfDay: boolean }

export interface DailyRecord {
  id: string;
  employeeId: string;
  attendanceDate: string;
  branchId: string;
  departmentId: string | null;
  timezone: string;
  shiftId: string | null;
  status: string;
  flags: string[];
  firstInAt: string | null;
  lastOutAt: string | null;
  workedMinutes: number;
  scheduledMinutes: number;
  overtimeMinutes: number;
  overtimeCategory: string | null;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  punches: TracePunchLike[];
  /** The approved leave covering the day, when there is one (the record itself does not store the leave type). */
  leave: RecordLeave | null;
  calculationVersion: number;
}

export interface RecordsQuery {
  from: string;
  to: string;
  /** Restrict to these employees; null = everyone in the branch/department scope. */
  employeeIds?: readonly string[] | null;
}

/**
 * Daily records of the period in the report's scope, with the leave type joined in. Scope is applied on the record's
 * own branch/department (effective on that date), not the employee's current placement, so a transferred employee's
 * days land in the branch they were worked in.
 */
export async function loadRecords(trx: Trx, ctx: ReportContext, q: RecordsQuery): Promise<DailyRecord[]> {
  const ids = q.employeeIds ?? ctx.scope.employeeIds;
  const batches: Array<readonly string[] | null> = ids ? chunk(ids, 1000) : [null];
  const rows: Array<Omit<DailyRecord, 'leave' | 'punches'> & { punches: unknown }> = [];
  for (const batch of batches) {
    if (batch && batch.length === 0) continue;
    let sel = trx.selectFrom('attendanceDailyRecords as r')
      .select(['r.id', 'r.employeeId', 'r.attendanceDate', 'r.branchId', 'r.departmentId', 'r.timezone', 'r.shiftId', 'r.status', 'r.flags', 'r.firstInAt', 'r.lastOutAt', 'r.workedMinutes', 'r.scheduledMinutes', 'r.overtimeMinutes', 'r.overtimeCategory', 'r.lateMinutes', 'r.earlyDepartureMinutes', 'r.calculationVersion'])
      .select(sql<unknown>`r.trace -> 'punches'`.as('punches'))
      .where('r.organizationId', '=', ctx.organizationId).where('r.attendanceDate', '>=', asDate(q.from)).where('r.attendanceDate', '<=', asDate(q.to));
    if (batch) sel = sel.where('r.employeeId', 'in', [...batch]);
    if (ctx.scope.branchIds) sel = sel.where('r.branchId', 'in', ctx.scope.branchIds.length ? ctx.scope.branchIds : ['00000000-0000-0000-0000-000000000000']);
    if (ctx.scope.departmentId) sel = sel.where('r.departmentId', '=', ctx.scope.departmentId);
    const got = await sel.orderBy('r.attendanceDate', 'asc').execute();
    for (const r of got) {
      rows.push({
        id: r.id, employeeId: r.employeeId, attendanceDate: isoDate(r.attendanceDate), branchId: r.branchId, departmentId: r.departmentId, timezone: r.timezone, shiftId: r.shiftId, status: r.status,
        flags: Array.isArray(r.flags) ? r.flags.map(String) : asArray(r.flags).map(String), firstInAt: r.firstInAt ? toDate(r.firstInAt).toISOString() : null, lastOutAt: r.lastOutAt ? toDate(r.lastOutAt).toISOString() : null,
        workedMinutes: r.workedMinutes, scheduledMinutes: r.scheduledMinutes, overtimeMinutes: r.overtimeMinutes, overtimeCategory: r.overtimeCategory, lateMinutes: r.lateMinutes, earlyDepartureMinutes: r.earlyDepartureMinutes,
        punches: r.punches, calculationVersion: r.calculationVersion,
      });
    }
  }
  const leaves = await loadLeaves(trx, ctx, q.from, q.to, [...new Set(rows.map((r) => r.employeeId))]);
  return rows.map((r) => ({
    ...r,
    punches: asArray(r.punches).map((p) => { const o = asObject(p); return { punchedAt: typeof o['punchedAt'] === 'string' ? o['punchedAt'] : undefined, role: typeof o['role'] === 'string' ? o['role'] : undefined }; }),
    leave: (r.status === 'LEAVE' || r.flags.includes('HALF_DAY_LEAVE')) ? leaveOn(leaves.get(r.employeeId), r.attendanceDate) : null,
  }));
}

interface LeaveSpan extends RecordLeave { startDate: string; endDate: string; createdAt: Date }

async function loadLeaves(trx: Trx, ctx: ReportContext, from: string, to: string, employeeIds: readonly string[]): Promise<Map<string, LeaveSpan[]>> {
  const out = new Map<string, LeaveSpan[]>();
  for (const batch of chunk(employeeIds, 1000)) {
    if (batch.length === 0) continue;
    const rows = await trx.selectFrom('leaveRecords as l').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
      .select(['l.employeeId', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.createdAt', 't.code', 't.name', 't.nameAr', 't.isPaid', 't.treatAsPresent'])
      .where('l.organizationId', '=', ctx.organizationId).where('l.status', '=', 'APPROVED').where('l.employeeId', 'in', batch)
      .where('l.startDate', '<=', asDate(to)).where('l.endDate', '>=', asDate(from)).execute();
    for (const r of rows) {
      const list = out.get(r.employeeId) ?? [];
      list.push({ code: String(r.code), name: (ctx.locale === 'ar' && r.nameAr) || r.name, isPaid: r.isPaid, treatAsPresent: r.treatAsPresent, isHalfDay: r.isHalfDay, startDate: isoDate(r.startDate), endDate: isoDate(r.endDate), createdAt: toDate(r.createdAt) });
      out.set(r.employeeId, list);
    }
  }
  return out;
}

/** Same choice the engine makes when two approved leaves cover a day: a full day beats a half day, then the newest wins. */
function leaveOn(spans: LeaveSpan[] | undefined, date: string): RecordLeave | null {
  if (!spans) return null;
  const covering = spans.filter((s) => s.startDate <= date && s.endDate >= date).sort((a, b) => Number(a.isHalfDay) - Number(b.isHalfDay) || b.createdAt.getTime() - a.createdAt.getTime());
  const s = covering[0];
  return s ? { code: s.code, name: s.name, isPaid: s.isPaid, treatAsPresent: s.treatAsPresent, isHalfDay: s.isHalfDay } : null;
}

/** Code input for one record. */
export function codeInputOf(r: DailyRecord) {
  return { status: r.status, flags: r.flags, leaveTypeCode: r.leave?.code ?? null, leaveTreatAsPresent: r.leave?.treatAsPresent ?? null, leaveIsPaid: r.leave?.isPaid ?? null };
}
