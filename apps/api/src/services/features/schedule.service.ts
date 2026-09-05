import { sql } from 'kysely';
import type { z } from 'zod';
import type { AttendanceRuleSetInput, HolidayInput, LeaveRecordInput, ShiftAssignmentInput, ShiftInput, ShiftPatternInput } from '@flowza/contracts';
import type { holidayCalendarInputSchema, leaveTypeInputSchema } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { resolveShift, resolveRuleSet, type EngineShiftAssignment, type EngineShiftPattern } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, diffObjects, runUser } from '../../lib/service.js';
import { likeContains, pageOf, toCount } from '../../lib/pagination.js';
import { isoDate, isoDateOrNull, isoDateTime, isoDateTimeOrNull, jsonArray, jsonObject } from '../../lib/mappers.js';
import type { UpdateLeaveRecordInput } from '../../routes/v1/features/dto.js';
import { enqueueRecalculation, orgToday } from './recalc.js';
import { dv, today } from './sql-helpers.js';

type HolidayCalendarInput = z.infer<typeof holidayCalendarInputSchema>;
type LeaveTypeInput = z.infer<typeof leaveTypeInputSchema>;

const minDate = (a: string, b: string) => (a < b ? a : b);
/** Recompute the affected range only when the change touches dates up to today (future dates recompute when they arrive). */
async function recalcIfPast(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, from: string, to: string | null, extra: { branchId?: string | null; employeeIds?: string[] | null; reason: string }): Promise<{ requestId: string; jobId: string } | null> {
  const today = await orgToday(trx, orgId);
  if (from > today) return null;
  return enqueueRecalculation(deps, trx, actor, orgId, { fromDate: from, toDate: minDate(to ?? today, today), branchId: extra.branchId ?? null, employeeIds: extra.employeeIds ?? null, reason: extra.reason });
}

// ----- shifts ------------------------------------------------------------------------------------------------------------------

export interface ShiftDto { id: string; code: string; name: string; nameAr: string | null; type: string; startTime: string | null; endTime: string | null; requiredMinutes: number | null; coreStart: string | null; coreEnd: string | null; dayBoundary: string; breaks: unknown[]; punchInWindowBeforeMinutes: number; punchOutWindowAfterMinutes: number; graceInMinutes: number | null; graceOutMinutes: number | null; color: string | null; status: string; crossesMidnight: boolean | null; assignmentCount?: number; createdAt: string; updatedAt: string }
const hhmm = (v: string | null) => (v === null ? null : v.slice(0, 5));
function toShiftDto(s: { id: string; code: string; name: string; nameAr: string | null; type: string; startTime: string | null; endTime: string | null; requiredMinutes: number | null; coreStart: string | null; coreEnd: string | null; dayBoundary: string; breaks: unknown; punchInWindowBeforeMinutes: number; punchOutWindowAfterMinutes: number; graceInMinutes: number | null; graceOutMinutes: number | null; color: string | null; status: string; crossesMidnight: boolean | null; createdAt: Date; updatedAt: Date }, assignmentCount?: number): ShiftDto {
  return { id: s.id, code: s.code, name: s.name, nameAr: s.nameAr, type: s.type, startTime: hhmm(s.startTime), endTime: hhmm(s.endTime), requiredMinutes: s.requiredMinutes, coreStart: hhmm(s.coreStart), coreEnd: hhmm(s.coreEnd), dayBoundary: hhmm(s.dayBoundary) ?? '04:00', breaks: jsonArray(s.breaks), punchInWindowBeforeMinutes: s.punchInWindowBeforeMinutes, punchOutWindowAfterMinutes: s.punchOutWindowAfterMinutes, graceInMinutes: s.graceInMinutes, graceOutMinutes: s.graceOutMinutes, color: s.color, status: s.status, crossesMidnight: s.crossesMidnight, ...(assignmentCount !== undefined ? { assignmentCount } : {}), createdAt: isoDateTime(s.createdAt), updatedAt: isoDateTime(s.updatedAt) };
}
function shiftValues(input: Partial<ShiftInput>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(input)) if (val !== undefined) v[k] = k === 'breaks' ? JSON.stringify(val) : val;
  if (input.type === 'FLEXIBLE') { v.startTime = input.startTime ?? null; v.endTime = input.endTime ?? null; }
  return v;
}

export async function listShifts(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; status?: string; search?: string }) {
  requirePermission(actor.principal, orgId, 'shift.view');
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('shifts').where('organizationId', '=', orgId);
    if (q.status) base = base.where('status', '=', q.status as never);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('name', 'ilike', like), eb('code', 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.selectAll().orderBy('name').limit(page.pageSize).offset(page.offset).execute();
    const counts = rows.length ? await trx.selectFrom('shiftAssignments').select(['shiftId', (eb) => eb.fn.countAll().as('n')]).where('organizationId', '=', orgId).where('shiftId', 'in', rows.map((r) => r.id)).groupBy('shiftId').execute() : [];
    const byShift = new Map(counts.map((c) => [c.shiftId, toCount(c.n)]));
    return { data: rows.map((r) => toShiftDto(r, byShift.get(r.id) ?? 0)), total };
  });
}
async function loadShift(trx: Trx, orgId: string, id: string) {
  const s = await trx.selectFrom('shifts').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
  if (!s) throw errors.notFound('Shift', id);
  return s;
}
export async function getShift(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<ShiftDto> {
  requirePermission(actor.principal, orgId, 'shift.view');
  return runUser(deps.db, actor, async (trx) => toShiftDto(await loadShift(trx, orgId, id)));
}
export async function createShift(deps: ApiDeps, actor: Actor, orgId: string, input: ShiftInput): Promise<ShiftDto> {
  requirePermission(actor.principal, orgId, 'shift.manage');
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.insertInto('shifts').values({ organizationId: orgId, ...shiftValues(input) } as never).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'shift.created', 'shift', { entityId: row.id, newValue: input });
    return toShiftDto(row);
  });
}
export async function updateShift(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: Partial<ShiftInput>): Promise<ShiftDto> {
  requirePermission(actor.principal, orgId, 'shift.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadShift(trx, orgId, id);
    const merged = { type: before.type, startTime: before.startTime, endTime: before.endTime, requiredMinutes: before.requiredMinutes, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as { type: string; startTime: string | null; endTime: string | null; requiredMinutes: number | null };
    if (merged.type === 'FIXED' && (!merged.startTime || !merged.endTime)) throw errors.validation('Fixed shifts need start and end time.', { issues: [{ path: 'startTime', message: 'Required for FIXED shifts' }] });
    if (merged.type === 'FLEXIBLE' && merged.requiredMinutes === null) throw errors.validation('Flexible shifts need required minutes.', { issues: [{ path: 'requiredMinutes', message: 'Required for FLEXIBLE shifts' }] });
    const values = shiftValues(input);
    if (Object.keys(values).length) await trx.updateTable('shifts').set(values as never).where('id', '=', id).execute();
    const after = await loadShift(trx, orgId, id);
    const diff = diffObjects(toShiftDto(before) as unknown as Record<string, unknown>, toShiftDto(after) as unknown as Record<string, unknown>);
    await audit(trx, actor, orgId, 'shift.updated', 'shift', { entityId: id, ...diff });
    const timingChanged = ['startTime', 'endTime', 'requiredMinutes', 'breaks', 'dayBoundary', 'punchInWindowBeforeMinutes', 'punchOutWindowAfterMinutes', 'graceInMinutes', 'graceOutMinutes', 'type', 'coreStart', 'coreEnd'].some((k) => k in diff.newValue);
    if (timingChanged) {
      const earliest = await trx.selectFrom('shiftAssignments').select((eb) => eb.fn.min('effectiveFrom').as('from')).where('organizationId', '=', orgId).where('shiftId', '=', id).executeTakeFirst();
      if (earliest?.from) await recalcIfPast(deps, trx, actor, orgId, isoDate(earliest.from as Date), null, { reason: `shift ${after.code} changed` });
    }
    return toShiftDto(after);
  });
}
export async function deleteShift(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  requirePermission(actor.principal, orgId, 'shift.manage');
  return runUser(deps.db, actor, async (trx) => {
    const s = await loadShift(trx, orgId, id);
    const assigned = toCount((await trx.selectFrom('shiftAssignments').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('shiftId', '=', id).executeTakeFirst())?.n);
    const inPattern = toCount((await sql<{ n: string }>`select count(*) as n from public.shift_patterns where organization_id = ${orgId}::uuid and sequence::text like ${'%' + id + '%'}`.execute(trx)).rows[0]?.n);
    if (assigned > 0 || inPattern > 0) throw errors.invalidState('The shift is assigned or used by a pattern; archive it instead of deleting.', { assignments: assigned, patterns: inPattern });
    await trx.deleteFrom('shifts').where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'shift.deleted', 'shift', { entityId: id, oldValue: { code: s.code, name: s.name } });
  });
}

// ----- patterns ----------------------------------------------------------------------------------------------------------------

export interface ShiftPatternDto { id: string; code: string; name: string; cycleLengthDays: number; sequence: unknown[]; anchorDate: string; status: string; createdAt: string; updatedAt: string }
const toPatternDto = (p: { id: string; code: string; name: string; cycleLengthDays: number; sequence: unknown; anchorDate: Date | string; status: string; createdAt: Date; updatedAt: Date }): ShiftPatternDto => ({ id: p.id, code: p.code, name: p.name, cycleLengthDays: p.cycleLengthDays, sequence: jsonArray(p.sequence), anchorDate: isoDate(p.anchorDate), status: p.status, createdAt: isoDateTime(p.createdAt), updatedAt: isoDateTime(p.updatedAt) });
async function validatePattern(trx: Trx, orgId: string, input: Partial<ShiftPatternInput>): Promise<void> {
  if (!input.sequence) return;
  const shiftIds = [...new Set(input.sequence.flatMap((s) => ('shiftId' in s ? [s.shiftId] : [])))];
  if (shiftIds.length) {
    const found = await trx.selectFrom('shifts').select('id').where('organizationId', '=', orgId).where('id', 'in', shiftIds).execute();
    if (found.length !== shiftIds.length) throw errors.validation('Pattern references unknown shifts.', { missing: shiftIds.filter((id) => !found.some((f) => f.id === id)) });
  }
  const cycle = input.cycleLengthDays;
  if (cycle !== undefined && input.sequence.some((s) => s.day >= cycle)) throw errors.validation('Sequence days must be below cycleLengthDays.');
  const days = input.sequence.map((s) => s.day);
  if (new Set(days).size !== days.length) throw errors.validation('Sequence days must be unique.');
}
export async function listPatterns(deps: ApiDeps, actor: Actor, orgId: string): Promise<ShiftPatternDto[]> {
  requirePermission(actor.principal, orgId, 'shift.view');
  return runUser(deps.db, actor, async (trx) => (await trx.selectFrom('shiftPatterns').selectAll().where('organizationId', '=', orgId).orderBy('name').execute()).map(toPatternDto));
}
export async function createPattern(deps: ApiDeps, actor: Actor, orgId: string, input: ShiftPatternInput): Promise<ShiftPatternDto> {
  requirePermission(actor.principal, orgId, 'shift.manage');
  return runUser(deps.db, actor, async (trx) => {
    await validatePattern(trx, orgId, input);
    const row = await trx.insertInto('shiftPatterns').values({ organizationId: orgId, code: input.code, name: input.name, cycleLengthDays: input.cycleLengthDays, sequence: JSON.stringify(input.sequence), anchorDate: input.anchorDate }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'shift_pattern.created', 'shift_pattern', { entityId: row.id, newValue: input });
    return toPatternDto(row);
  });
}
export async function updatePattern(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: Partial<ShiftPatternInput>): Promise<ShiftPatternDto> {
  requirePermission(actor.principal, orgId, 'shift.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await trx.selectFrom('shiftPatterns').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!before) throw errors.notFound('Shift pattern', id);
    await validatePattern(trx, orgId, { ...input, cycleLengthDays: input.cycleLengthDays ?? before.cycleLengthDays });
    const patch: Record<string, unknown> = {}; for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = k === 'sequence' ? JSON.stringify(v) : v;
    if (Object.keys(patch).length) await trx.updateTable('shiftPatterns').set(patch as never).where('id', '=', id).execute();
    const after = await trx.selectFrom('shiftPatterns').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'shift_pattern.updated', 'shift_pattern', { entityId: id, oldValue: toPatternDto(before), newValue: toPatternDto(after) });
    if (input.sequence || input.anchorDate || input.cycleLengthDays) {
      const earliest = await trx.selectFrom('shiftAssignments').select((eb) => eb.fn.min('effectiveFrom').as('from')).where('organizationId', '=', orgId).where('shiftPatternId', '=', id).executeTakeFirst();
      if (earliest?.from) await recalcIfPast(deps, trx, actor, orgId, isoDate(earliest.from as Date), null, { reason: `shift pattern ${after.code} changed` });
    }
    return toPatternDto(after);
  });
}
export async function deletePattern(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  requirePermission(actor.principal, orgId, 'shift.manage');
  return runUser(deps.db, actor, async (trx) => {
    const p = await trx.selectFrom('shiftPatterns').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!p) throw errors.notFound('Shift pattern', id);
    const assigned = toCount((await trx.selectFrom('shiftAssignments').select((eb) => eb.fn.countAll().as('n')).where('shiftPatternId', '=', id).executeTakeFirst())?.n);
    if (assigned > 0) throw errors.invalidState('The pattern is assigned; end the assignments first.', { assignments: assigned });
    await trx.deleteFrom('shiftPatterns').where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'shift_pattern.deleted', 'shift_pattern', { entityId: id, oldValue: { code: p.code } });
  });
}

// ----- assignments -------------------------------------------------------------------------------------------------------------

export interface ShiftAssignmentDto { id: string; targetType: string; targetId: string; targetName: string | null; branchId: string | null; shiftId: string | null; shiftName: string | null; shiftPatternId: string | null; patternName: string | null; effectiveFrom: string; effectiveTo: string | null; createdBy: string | null; createdAt: string }
const ASSIGNMENT_COLUMNS = ['a.id', 'a.targetType', 'a.targetId', 'a.branchId', 'a.shiftId', 's.name as shiftName', 'a.shiftPatternId', 'p.name as patternName', 'a.effectiveFrom', 'a.effectiveTo', 'a.createdBy', 'a.createdAt'] as const;
function assignmentQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('shiftAssignments as a').leftJoin('shifts as s', 's.id', 'a.shiftId').leftJoin('shiftPatterns as p', 'p.id', 'a.shiftPatternId').where('a.organizationId', '=', orgId);
}
async function targetNames(trx: Trx, orgId: string, rows: { targetType: string; targetId: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const by = (t: string) => [...new Set(rows.filter((r) => r.targetType === t).map((r) => r.targetId))];
  const emp = by('EMPLOYEE'); if (emp.length) for (const e of await trx.selectFrom('employees').select(['id', 'displayName']).where('organizationId', '=', orgId).where('id', 'in', emp).execute()) out.set(e.id, e.displayName);
  const br = by('BRANCH'); if (br.length) for (const b of await trx.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', br).execute()) out.set(b.id, b.name);
  const dp = by('DEPARTMENT'); if (dp.length) for (const d of await trx.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', dp).execute()) out.set(d.id, d.name);
  const tm = by('TEAM'); if (tm.length) for (const t of await trx.selectFrom('teams').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', tm).execute()) out.set(t.id, t.name);
  return out;
}
type AssignmentRow = { id: string; targetType: string; targetId: string; branchId: string | null; shiftId: string | null; shiftName: string | null; shiftPatternId: string | null; patternName: string | null; effectiveFrom: Date | string; effectiveTo: Date | string | null; createdBy: string | null; createdAt: Date };
const toAssignmentDto = (a: AssignmentRow, names: Map<string, string>): ShiftAssignmentDto => ({ id: a.id, targetType: a.targetType, targetId: a.targetId, targetName: a.targetType === 'ORGANIZATION' ? 'Organisation' : names.get(a.targetId) ?? null, branchId: a.branchId, shiftId: a.shiftId, shiftName: a.shiftName, shiftPatternId: a.shiftPatternId, patternName: a.patternName, effectiveFrom: isoDate(a.effectiveFrom), effectiveTo: isoDateOrNull(a.effectiveTo), createdBy: a.createdBy, createdAt: isoDateTime(a.createdAt) });

/** Branch used for RLS/scope: EMPLOYEE → employee branch, BRANCH → itself, DEPARTMENT/TEAM → their branch (may be null), ORGANIZATION → null. */
async function resolveTargetBranch(trx: Trx, orgId: string, targetType: string, targetId: string): Promise<{ branchId: string | null; employeeIds: string[] | null }> {
  switch (targetType) {
    case 'EMPLOYEE': { const e = await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', '=', targetId).where('deletedAt', 'is', null).executeTakeFirst(); if (!e) throw errors.validation('Employee not found.', { issues: [{ path: 'targetId', message: 'Unknown employee' }] }); return { branchId: e.branchId, employeeIds: [e.id] }; }
    case 'BRANCH': { const b = await trx.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', '=', targetId).executeTakeFirst(); if (!b) throw errors.validation('Branch not found.', { issues: [{ path: 'targetId', message: 'Unknown branch' }] }); return { branchId: b.id, employeeIds: null }; }
    case 'DEPARTMENT': { const d = await trx.selectFrom('departments').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', '=', targetId).executeTakeFirst(); if (!d) throw errors.validation('Department not found.', { issues: [{ path: 'targetId', message: 'Unknown department' }] }); return { branchId: d.branchId, employeeIds: null }; }
    case 'TEAM': { const t = await trx.selectFrom('teams').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', '=', targetId).executeTakeFirst(); if (!t) throw errors.validation('Team not found.', { issues: [{ path: 'targetId', message: 'Unknown team' }] }); return { branchId: t.branchId, employeeIds: null }; }
    case 'ORGANIZATION': if (targetId !== orgId) throw errors.validation('ORGANIZATION targets must reference the organisation itself.', { issues: [{ path: 'targetId', message: 'Must equal orgId' }] }); return { branchId: null, employeeIds: null };
    default: throw errors.validation('Unsupported target type.');
  }
}

export async function listAssignments(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; targetType?: string; targetId?: string; shiftId?: string; branchId?: string; activeOn?: string }) {
  const grant = requirePermission(actor.principal, orgId, 'shift.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = assignmentQuery(trx, orgId);
    if (scope) base = base.where((eb) => eb.or([eb('a.branchId', 'is', null), eb('a.branchId', 'in', scope)]));
    if (q.targetType) base = base.where('a.targetType', '=', q.targetType as never);
    if (q.targetId) base = base.where('a.targetId', '=', q.targetId);
    if (q.shiftId) base = base.where('a.shiftId', '=', q.shiftId);
    if (q.activeOn) base = base.where('a.effectiveFrom', '<=', dv(q.activeOn)).where((eb) => eb.or([eb('a.effectiveTo', 'is', null), eb('a.effectiveTo', '>', dv(q.activeOn!))]));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(ASSIGNMENT_COLUMNS).orderBy('a.effectiveFrom', 'desc').orderBy('a.id').limit(page.pageSize).offset(page.offset).execute()) as AssignmentRow[];
    const names = await targetNames(trx, orgId, rows);
    return { data: rows.map((r) => toAssignmentDto(r, names)), total };
  });
}
export async function createAssignment(deps: ApiDeps, actor: Actor, orgId: string, input: ShiftAssignmentInput): Promise<ShiftAssignmentDto & { recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'shift.assign');
  return runUser(deps.db, actor, async (trx) => {
    const target = await resolveTargetBranch(trx, orgId, input.targetType, input.targetId);
    if (target.branchId) requireBranchAccess(grant, target.branchId); else if (!grant.allBranches) throw errors.forbidden('Branch-scoped users can only assign shifts to employees or branches in their scope.');
    if (input.shiftId) await loadShift(trx, orgId, input.shiftId);
    if (input.shiftPatternId && !(await trx.selectFrom('shiftPatterns').select('id').where('organizationId', '=', orgId).where('id', '=', input.shiftPatternId).executeTakeFirst())) throw errors.validation('Shift pattern not found.', { issues: [{ path: 'shiftPatternId', message: 'Unknown pattern' }] });
    const row = await trx.insertInto('shiftAssignments').values({ organizationId: orgId, targetType: input.targetType, targetId: input.targetId, branchId: target.branchId, shiftId: input.shiftId ?? null, shiftPatternId: input.shiftPatternId ?? null, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, createdBy: actor.userId }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'shift.assigned', 'shift_assignment', { entityId: row.id, branchId: target.branchId, newValue: input });
    const recalc = await recalcIfPast(deps, trx, actor, orgId, input.effectiveFrom, input.effectiveTo ?? null, { branchId: target.branchId, employeeIds: target.employeeIds, reason: `shift assignment ${input.targetType} created` });
    const saved = (await assignmentQuery(trx, orgId).select(ASSIGNMENT_COLUMNS).where('a.id', '=', row.id).executeTakeFirstOrThrow()) as AssignmentRow;
    return { ...toAssignmentDto(saved, await targetNames(trx, orgId, [saved])), recalculationJobId: recalc?.jobId ?? null };
  });
}
export async function updateAssignment(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: { effectiveTo: string | null }): Promise<ShiftAssignmentDto & { recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'shift.assign');
  return runUser(deps.db, actor, async (trx) => {
    const before = (await assignmentQuery(trx, orgId).select(ASSIGNMENT_COLUMNS).where('a.id', '=', id).executeTakeFirst()) as AssignmentRow | undefined;
    if (!before) throw errors.notFound('Shift assignment', id);
    requireBranchAccess(grant, before.branchId);
    if (input.effectiveTo !== null && input.effectiveTo <= isoDate(before.effectiveFrom)) throw errors.validation('effectiveTo must be after effectiveFrom.', { issues: [{ path: 'effectiveTo', message: 'Invalid range' }] });
    await trx.updateTable('shiftAssignments').set({ effectiveTo: input.effectiveTo }).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'shift.assignment_updated', 'shift_assignment', { entityId: id, branchId: before.branchId, oldValue: { effectiveTo: isoDateOrNull(before.effectiveTo) }, newValue: input });
    const oldTo = isoDateOrNull(before.effectiveTo); const newTo = input.effectiveTo;
    const from = oldTo && newTo ? minDate(oldTo, newTo) : (oldTo ?? newTo ?? isoDate(before.effectiveFrom));
    const target = await resolveTargetBranch(trx, orgId, before.targetType, before.targetId).catch(() => ({ branchId: before.branchId, employeeIds: null }));
    const recalc = await recalcIfPast(deps, trx, actor, orgId, from, null, { branchId: before.branchId, employeeIds: target.employeeIds, reason: 'shift assignment end date changed' });
    const after = (await assignmentQuery(trx, orgId).select(ASSIGNMENT_COLUMNS).where('a.id', '=', id).executeTakeFirstOrThrow()) as AssignmentRow;
    return { ...toAssignmentDto(after, await targetNames(trx, orgId, [after])), recalculationJobId: recalc?.jobId ?? null };
  });
}
export async function deleteAssignment(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<{ recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'shift.assign');
  return runUser(deps.db, actor, async (trx) => {
    const before = (await assignmentQuery(trx, orgId).select(ASSIGNMENT_COLUMNS).where('a.id', '=', id).executeTakeFirst()) as AssignmentRow | undefined;
    if (!before) throw errors.notFound('Shift assignment', id);
    requireBranchAccess(grant, before.branchId);
    await trx.deleteFrom('shiftAssignments').where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'shift.unassigned', 'shift_assignment', { entityId: id, branchId: before.branchId, oldValue: toAssignmentDto(before, new Map()) });
    const target = await resolveTargetBranch(trx, orgId, before.targetType, before.targetId).catch(() => ({ branchId: before.branchId, employeeIds: null }));
    const recalc = await recalcIfPast(deps, trx, actor, orgId, isoDate(before.effectiveFrom), isoDateOrNull(before.effectiveTo), { branchId: before.branchId, employeeIds: target.employeeIds, reason: 'shift assignment removed' });
    return { recalculationJobId: recalc?.jobId ?? null };
  });
}

export async function resolveEmployeeShift(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, date: string) {
  const grant = requirePermission(actor.principal, orgId, 'shift.view');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await trx.selectFrom('employees').select(['id', 'branchId', 'departmentId']).where('organizationId', '=', orgId).where('id', '=', employeeId).executeTakeFirst();
    if (!emp) throw errors.notFound('Employee', employeeId);
    requireBranchAccess(grant, emp.branchId);
    // effective branch/department on the date (employment history) with the current row as fallback
    const hist = await trx.selectFrom('employmentHistory').select(['branchId', 'departmentId']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('effectiveFrom', '<=', dv(date)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(date))])).orderBy('effectiveFrom', 'desc').executeTakeFirst();
    const teams = (await trx.selectFrom('teamMembers').select('teamId').where('organizationId', '=', orgId).where('employeeId', '=', employeeId).execute()).map((t) => t.teamId);
    const assignments: EngineShiftAssignment[] = (await trx.selectFrom('shiftAssignments').selectAll().where('organizationId', '=', orgId).where('effectiveFrom', '<=', dv(date)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(date))])).execute())
      .map((a) => ({ id: a.id, targetType: a.targetType, targetId: a.targetId, shiftId: a.shiftId, shiftPatternId: a.shiftPatternId, effectiveFrom: isoDate(a.effectiveFrom), effectiveTo: isoDateOrNull(a.effectiveTo) }));
    const patterns: EngineShiftPattern[] = (await trx.selectFrom('shiftPatterns').selectAll().where('organizationId', '=', orgId).execute()).map((p) => ({ id: p.id, cycleLengthDays: p.cycleLengthDays, anchorDate: isoDate(p.anchorDate), sequence: jsonArray(p.sequence) as EngineShiftPattern['sequence'] }));
    const scope = { employeeId, teamIds: teams, departmentId: hist?.departmentId ?? emp.departmentId, branchId: hist?.branchId ?? emp.branchId, organizationId: orgId };
    const resolved = resolveShift(assignments, patterns, scope, date);
    const shift = resolved.shiftId ? await trx.selectFrom('shifts').selectAll().where('id', '=', resolved.shiftId).executeTakeFirst() : null;
    const ruleSets = (await trx.selectFrom('attendanceRuleSets').select(['id', 'branchId', 'effectiveFrom', 'effectiveTo', 'name']).where('organizationId', '=', orgId).execute()).map((r) => ({ id: r.id, branchId: r.branchId, effectiveFrom: isoDate(r.effectiveFrom), effectiveTo: isoDateOrNull(r.effectiveTo), name: r.name, rules: {} as never }));
    const ruleSet = resolveRuleSet(ruleSets, date, scope.branchId);
    return { employeeId, date, source: resolved.source, isPatternOff: resolved.isPatternOff, patternDay: resolved.patternDay, assignment: resolved.assignment, shift: shift ? toShiftDto(shift) : null, ruleSet: ruleSet ? { id: ruleSet.id, name: ruleSet.name, branchId: ruleSet.branchId } : null, scope };
  });
}

// ----- holidays --------------------------------------------------------------------------------------------------------------

export interface HolidayCalendarDto { id: string; name: string; countryCode: string | null; isDefault: boolean; holidayCount?: number; createdAt: string; updatedAt: string }
const toCalendarDto = (c: { id: string; name: string; countryCode: string | null; isDefault: boolean; createdAt: Date; updatedAt: Date }, holidayCount?: number): HolidayCalendarDto => ({ id: c.id, name: c.name, countryCode: c.countryCode, isDefault: c.isDefault, ...(holidayCount !== undefined ? { holidayCount } : {}), createdAt: isoDateTime(c.createdAt), updatedAt: isoDateTime(c.updatedAt) });
export interface HolidayDto { id: string; calendarId: string; name: string; nameAr: string | null; date: string; endDate: string | null; isHalfDay: boolean; type: string; branchIds: string[] | null; isTentative: boolean; createdAt: string }
const toHolidayDto = (h: { id: string; calendarId: string; name: string; nameAr: string | null; date: Date | string; endDate: Date | string | null; isHalfDay: boolean; type: string; branchIds: string[] | null; isTentative: boolean; createdAt: Date }): HolidayDto => ({ id: h.id, calendarId: h.calendarId, name: h.name, nameAr: h.nameAr, date: isoDate(h.date), endDate: isoDateOrNull(h.endDate), isHalfDay: h.isHalfDay, type: h.type, branchIds: h.branchIds, isTentative: h.isTentative, createdAt: isoDateTime(h.createdAt) });

export async function listCalendars(deps: ApiDeps, actor: Actor, orgId: string): Promise<HolidayCalendarDto[]> {
  requirePermission(actor.principal, orgId, 'holiday.view');
  return runUser(deps.db, actor, async (trx) => {
    const rows = await trx.selectFrom('holidayCalendars').selectAll().where('organizationId', '=', orgId).orderBy('name').execute();
    const counts = rows.length ? await trx.selectFrom('holidays').select(['calendarId', (eb) => eb.fn.countAll().as('n')]).where('organizationId', '=', orgId).where('calendarId', 'in', rows.map((r) => r.id)).groupBy('calendarId').execute() : [];
    const by = new Map(counts.map((c) => [c.calendarId, toCount(c.n)]));
    return rows.map((r) => toCalendarDto(r, by.get(r.id) ?? 0));
  });
}
export async function createCalendar(deps: ApiDeps, actor: Actor, orgId: string, input: HolidayCalendarInput): Promise<HolidayCalendarDto> {
  requirePermission(actor.principal, orgId, 'holiday.manage');
  return runUser(deps.db, actor, async (trx) => {
    if (input.isDefault) await trx.updateTable('holidayCalendars').set({ isDefault: false }).where('organizationId', '=', orgId).where('isDefault', '=', true).execute();
    const row = await trx.insertInto('holidayCalendars').values({ organizationId: orgId, name: input.name, countryCode: input.countryCode ?? null, isDefault: input.isDefault }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'holiday_calendar.created', 'holiday_calendar', { entityId: row.id, newValue: input });
    return toCalendarDto(row, 0);
  });
}
export async function updateCalendar(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: Partial<HolidayCalendarInput>): Promise<HolidayCalendarDto> {
  requirePermission(actor.principal, orgId, 'holiday.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await trx.selectFrom('holidayCalendars').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!before) throw errors.notFound('Holiday calendar', id);
    if (input.isDefault) await trx.updateTable('holidayCalendars').set({ isDefault: false }).where('organizationId', '=', orgId).where('isDefault', '=', true).where('id', '!=', id).execute();
    const patch: Record<string, unknown> = {}; for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length) await trx.updateTable('holidayCalendars').set(patch as never).where('id', '=', id).execute();
    const after = await trx.selectFrom('holidayCalendars').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'holiday_calendar.updated', 'holiday_calendar', { entityId: id, oldValue: toCalendarDto(before), newValue: toCalendarDto(after) });
    return toCalendarDto(after);
  });
}
export async function deleteCalendar(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  requirePermission(actor.principal, orgId, 'holiday.manage');
  return runUser(deps.db, actor, async (trx) => {
    const c = await trx.selectFrom('holidayCalendars').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!c) throw errors.notFound('Holiday calendar', id);
    const used = toCount((await trx.selectFrom('branches').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('holidayCalendarId', '=', id).executeTakeFirst())?.n);
    if (used > 0) throw errors.invalidState('The calendar is assigned to branches.', { branches: used });
    await trx.deleteFrom('holidays').where('calendarId', '=', id).execute();
    await trx.deleteFrom('holidayCalendars').where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'holiday_calendar.deleted', 'holiday_calendar', { entityId: id, oldValue: { name: c.name } });
  });
}
export async function listHolidays(deps: ApiDeps, actor: Actor, orgId: string, q: { calendarId?: string; year?: number; from?: string; to?: string }): Promise<HolidayDto[]> {
  requirePermission(actor.principal, orgId, 'holiday.view');
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('holidays').selectAll().where('organizationId', '=', orgId);
    if (q.calendarId) base = base.where('calendarId', '=', q.calendarId);
    const from = q.from ?? (q.year ? `${q.year}-01-01` : undefined); const to = q.to ?? (q.year ? `${q.year}-12-31` : undefined);
    if (from) base = base.where((eb) => eb.or([eb('date', '>=', dv(from)), eb('endDate', '>=', dv(from))]));
    if (to) base = base.where('date', '<=', dv(to));
    return (await base.orderBy('date').limit(2000).execute()).map(toHolidayDto);
  });
}
async function holidayRecalc(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, h: { date: string; endDate: string | null; branchIds: string[] | null }, reason: string) {
  // holidays may apply to several branches; recompute per branch (or organisation-wide when unrestricted)
  if (h.branchIds && h.branchIds.length) { for (const b of h.branchIds) await recalcIfPast(deps, trx, actor, orgId, h.date, h.endDate, { branchId: b, reason }); }
  else await recalcIfPast(deps, trx, actor, orgId, h.date, h.endDate, { reason });
}
export async function createHoliday(deps: ApiDeps, actor: Actor, orgId: string, input: HolidayInput): Promise<HolidayDto> {
  const grant = requirePermission(actor.principal, orgId, 'holiday.manage');
  for (const b of input.branchIds ?? []) requireBranchAccess(grant, b);
  if (input.endDate && input.endDate < input.date) throw errors.validation('endDate must be on/after date.', { issues: [{ path: 'endDate', message: 'Before date' }] });
  return runUser(deps.db, actor, async (trx) => {
    if (!(await trx.selectFrom('holidayCalendars').select('id').where('organizationId', '=', orgId).where('id', '=', input.calendarId).executeTakeFirst())) throw errors.validation('Holiday calendar not found.', { issues: [{ path: 'calendarId', message: 'Unknown calendar' }] });
    const row = await trx.insertInto('holidays').values({ organizationId: orgId, calendarId: input.calendarId, name: input.name, nameAr: input.nameAr ?? null, date: input.date, endDate: input.endDate ?? null, isHalfDay: input.isHalfDay, type: input.type, branchIds: input.branchIds ?? null, isTentative: input.isTentative }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'holiday.created', 'holiday', { entityId: row.id, newValue: input });
    await holidayRecalc(deps, trx, actor, orgId, { date: input.date, endDate: input.endDate ?? null, branchIds: input.branchIds ?? null }, `holiday ${input.name} added`);
    return toHolidayDto(row);
  });
}
export async function updateHoliday(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: Partial<HolidayInput>): Promise<HolidayDto> {
  const grant = requirePermission(actor.principal, orgId, 'holiday.manage');
  for (const b of input.branchIds ?? []) requireBranchAccess(grant, b);
  return runUser(deps.db, actor, async (trx) => {
    const before = await trx.selectFrom('holidays').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!before) throw errors.notFound('Holiday', id);
    const patch: Record<string, unknown> = {}; for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length) await trx.updateTable('holidays').set(patch as never).where('id', '=', id).execute();
    const after = await trx.selectFrom('holidays').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'holiday.updated', 'holiday', { entityId: id, oldValue: toHolidayDto(before), newValue: toHolidayDto(after) });
    const b = toHolidayDto(before); const a = toHolidayDto(after);
    await holidayRecalc(deps, trx, actor, orgId, { date: minDate(b.date, a.date), endDate: [b.endDate ?? b.date, a.endDate ?? a.date].sort().pop() ?? null, branchIds: b.branchIds && a.branchIds ? [...new Set([...b.branchIds, ...a.branchIds])] : null }, `holiday ${after.name} changed`);
    return a;
  });
}
export async function deleteHoliday(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  requirePermission(actor.principal, orgId, 'holiday.manage');
  return runUser(deps.db, actor, async (trx) => {
    const h = await trx.selectFrom('holidays').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!h) throw errors.notFound('Holiday', id);
    await trx.deleteFrom('holidays').where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'holiday.deleted', 'holiday', { entityId: id, oldValue: toHolidayDto(h) });
    await holidayRecalc(deps, trx, actor, orgId, { date: isoDate(h.date), endDate: isoDateOrNull(h.endDate), branchIds: h.branchIds }, `holiday ${h.name} removed`);
  });
}

// ----- leave -----------------------------------------------------------------------------------------------------------------

export interface LeaveTypeDto { id: string; code: string; name: string; nameAr: string | null; isPaid: boolean; color: string | null; status: string; createdAt: string }
const toLeaveTypeDto = (t: { id: string; code: string; name: string; nameAr: string | null; isPaid: boolean; color: string | null; status: string; createdAt: Date }): LeaveTypeDto => ({ id: t.id, code: t.code, name: t.name, nameAr: t.nameAr, isPaid: t.isPaid, color: t.color, status: t.status, createdAt: isoDateTime(t.createdAt) });
export async function listLeaveTypes(deps: ApiDeps, actor: Actor, orgId: string): Promise<LeaveTypeDto[]> {
  requirePermission(actor.principal, orgId, 'leave.view');
  return runUser(deps.db, actor, async (trx) => (await trx.selectFrom('leaveTypes').selectAll().where('organizationId', '=', orgId).orderBy('name').execute()).map(toLeaveTypeDto));
}
export async function createLeaveType(deps: ApiDeps, actor: Actor, orgId: string, input: LeaveTypeInput): Promise<LeaveTypeDto> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.insertInto('leaveTypes').values({ organizationId: orgId, code: input.code, name: input.name, nameAr: input.nameAr ?? null, isPaid: input.isPaid, color: input.color ?? null }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'leave_type.created', 'leave_type', { entityId: row.id, newValue: input });
    return toLeaveTypeDto(row);
  });
}
export async function updateLeaveType(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: Partial<LeaveTypeInput> & { status?: string }): Promise<LeaveTypeDto> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await trx.selectFrom('leaveTypes').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!before) throw errors.notFound('Leave type', id);
    const patch: Record<string, unknown> = {}; for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length) await trx.updateTable('leaveTypes').set(patch as never).where('id', '=', id).execute();
    const after = await trx.selectFrom('leaveTypes').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'leave_type.updated', 'leave_type', { entityId: id, oldValue: toLeaveTypeDto(before), newValue: toLeaveTypeDto(after) });
    if (before.isPaid !== after.isPaid) {
      const earliest = await trx.selectFrom('leaveRecords').select((eb) => eb.fn.min('startDate').as('from')).where('leaveTypeId', '=', id).where('status', '=', 'APPROVED').executeTakeFirst();
      if (earliest?.from) await recalcIfPast(deps, trx, actor, orgId, isoDate(earliest.from as Date), null, { reason: `leave type ${after.code} paid flag changed` });
    }
    return toLeaveTypeDto(after);
  });
}
export async function deleteLeaveType(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const t = await trx.selectFrom('leaveTypes').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!t) throw errors.notFound('Leave type', id);
    const used = toCount((await trx.selectFrom('leaveRecords').select((eb) => eb.fn.countAll().as('n')).where('leaveTypeId', '=', id).executeTakeFirst())?.n);
    if (used > 0) { await trx.updateTable('leaveTypes').set({ status: 'archived' }).where('id', '=', id).execute(); await audit(trx, actor, orgId, 'leave_type.archived', 'leave_type', { entityId: id, oldValue: { code: t.code }, reason: `${used} leave records reference it` }); return; }
    await trx.deleteFrom('leaveTypes').where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'leave_type.deleted', 'leave_type', { entityId: id, oldValue: { code: t.code } });
  });
}

export interface LeaveRecordDto { id: string; employeeId: string; employeeNumber?: string; employeeName?: string; leaveTypeId: string; leaveTypeName?: string; branchId: string | null; startDate: string; endDate: string; isHalfDay: boolean; halfDayPart: string | null; reason: string | null; status: string; source: string; approvedBy: string | null; approvedAt: string | null; createdBy: string | null; createdAt: string; updatedAt: string }
type LeaveRow = { id: string; employeeId: string; employeeNumber?: string; employeeName?: string; leaveTypeId: string; leaveTypeName?: string; branchId: string | null; startDate: Date | string; endDate: Date | string; isHalfDay: boolean; halfDayPart: string | null; reason: string | null; status: string; source: string; approvedBy: string | null; approvedAt: Date | null; createdBy: string | null; createdAt: Date; updatedAt: Date };
const toLeaveDto = (r: LeaveRow): LeaveRecordDto => ({ id: r.id, employeeId: r.employeeId, ...(r.employeeNumber ? { employeeNumber: r.employeeNumber } : {}), ...(r.employeeName ? { employeeName: r.employeeName } : {}), leaveTypeId: r.leaveTypeId, ...(r.leaveTypeName ? { leaveTypeName: r.leaveTypeName } : {}), branchId: r.branchId, startDate: isoDate(r.startDate), endDate: isoDate(r.endDate), isHalfDay: r.isHalfDay, halfDayPart: r.halfDayPart, reason: r.reason, status: r.status, source: r.source, approvedBy: r.approvedBy, approvedAt: isoDateTimeOrNull(r.approvedAt), createdBy: r.createdBy, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt) });
function leaveQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('leaveRecords as l').innerJoin('employees as e', 'e.id', 'l.employeeId').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId').where('l.organizationId', '=', orgId);
}
const LEAVE_COLUMNS = ['l.id', 'l.employeeId', 'e.employeeNumber', 'e.displayName as employeeName', 'l.leaveTypeId', 't.name as leaveTypeName', 'l.branchId', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.halfDayPart', 'l.reason', 'l.status', 'l.source', 'l.approvedBy', 'l.approvedAt', 'l.createdBy', 'l.createdAt', 'l.updatedAt'] as const;

export async function listLeaveRecords(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; employeeId?: string; branchId?: string; leaveTypeId?: string; status?: string; from?: string; to?: string }) {
  const grant = requirePermission(actor.principal, orgId, 'leave.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = leaveQuery(trx, orgId);
    if (scope) base = base.where('l.branchId', 'in', scope);
    if (q.employeeId) base = base.where('l.employeeId', '=', q.employeeId);
    if (q.leaveTypeId) base = base.where('l.leaveTypeId', '=', q.leaveTypeId);
    if (q.status) base = base.where('l.status', '=', q.status as never);
    if (q.from) base = base.where('l.endDate', '>=', dv(q.from));
    if (q.to) base = base.where('l.startDate', '<=', dv(q.to));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(LEAVE_COLUMNS).orderBy('l.startDate', 'desc').orderBy('l.id').limit(page.pageSize).offset(page.offset).execute()) as LeaveRow[];
    return { data: rows.map(toLeaveDto), total };
  });
}
/** Any day of [start, end] inside an active lock for the employee's branch (or an organisation-wide lock) → PERIOD_LOCKED. */
async function assertLeaveRangeUnlocked(trx: Trx, orgId: string, branchId: string | null, start: string, end: string): Promise<void> {
  const lock = await trx.selectFrom('attendancePeriodLocks').select('id').where('organizationId', '=', orgId).where('unlockedAt', 'is', null)
    .where('periodStart', '<=', dv(end)).where('periodEnd', '>=', dv(start))
    .where((eb) => branchId ? eb.or([eb('branchId', 'is', null), eb('branchId', '=', branchId)]) : eb('branchId', 'is', null)).executeTakeFirst();
  if (lock) throw errors.periodLocked('The period is locked; unlock it before changing leave in this range.');
}
async function assertNoLeaveOverlap(trx: Trx, orgId: string, employeeId: string, start: string, end: string, excludeId?: string): Promise<void> {
  let q = trx.selectFrom('leaveRecords').select('id').where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('status', 'in', ['PENDING', 'APPROVED']).where('startDate', '<=', dv(end)).where('endDate', '>=', dv(start));
  if (excludeId) q = q.where('id', '!=', excludeId);
  const clash = await q.executeTakeFirst();
  if (clash) throw errors.conflict('The employee already has leave in this range.', { leaveRecordId: clash.id });
}
export async function createLeaveRecord(deps: ApiDeps, actor: Actor, orgId: string, input: LeaveRecordInput): Promise<LeaveRecordDto & { recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  if (input.isHalfDay && input.startDate !== input.endDate) throw errors.validation('Half-day leave must be a single day.', { issues: [{ path: 'endDate', message: 'Must equal startDate' }] });
  return runUser(deps.db, actor, async (trx) => {
    const emp = await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', '=', input.employeeId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!emp) throw errors.validation('Employee not found.', { issues: [{ path: 'employeeId', message: 'Unknown employee' }] });
    requireBranchAccess(grant, emp.branchId);
    if (!(await trx.selectFrom('leaveTypes').select('id').where('organizationId', '=', orgId).where('id', '=', input.leaveTypeId).where('status', '=', 'active').executeTakeFirst())) throw errors.validation('Leave type not found or archived.', { issues: [{ path: 'leaveTypeId', message: 'Unknown leave type' }] });
    await assertLeaveRangeUnlocked(trx, orgId, emp.branchId, input.startDate, input.endDate);
    await assertNoLeaveOverlap(trx, orgId, input.employeeId, input.startDate, input.endDate);
    const row = await trx.insertInto('leaveRecords').values({ organizationId: orgId, employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, branchId: emp.branchId, startDate: input.startDate, endDate: input.endDate, isHalfDay: input.isHalfDay, halfDayPart: input.isHalfDay ? input.halfDayPart ?? 'FIRST_HALF' : null, reason: input.reason ?? null, status: 'APPROVED', approvedBy: actor.userId, approvedAt: new Date(), createdBy: actor.userId }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'leave.recorded', 'leave_record', { entityId: row.id, branchId: emp.branchId, newValue: input });
    const recalc = await recalcIfPast(deps, trx, actor, orgId, input.startDate, input.endDate, { branchId: emp.branchId, employeeIds: [input.employeeId], reason: 'leave recorded' });
    const saved = (await leaveQuery(trx, orgId).select(LEAVE_COLUMNS).where('l.id', '=', row.id).executeTakeFirstOrThrow()) as LeaveRow;
    return { ...toLeaveDto(saved), recalculationJobId: recalc?.jobId ?? null };
  });
}
export async function updateLeaveRecord(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateLeaveRecordInput): Promise<LeaveRecordDto & { recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = (await leaveQuery(trx, orgId).select(LEAVE_COLUMNS).where('l.id', '=', id).executeTakeFirst()) as LeaveRow | undefined;
    if (!before) throw errors.notFound('Leave record', id);
    requireBranchAccess(grant, before.branchId);
    const start = input.startDate ?? isoDate(before.startDate); const end = input.endDate ?? isoDate(before.endDate);
    if (end < start) throw errors.validation('endDate must be on/after startDate.', { issues: [{ path: 'endDate', message: 'Before startDate' }] });
    // both the range being left and the range being entered must be open (HR unlocks first, then edits)
    await assertLeaveRangeUnlocked(trx, orgId, before.branchId, isoDate(before.startDate), isoDate(before.endDate));
    await assertLeaveRangeUnlocked(trx, orgId, before.branchId, start, end);
    const status = input.status ?? before.status;
    if (status === 'APPROVED' || status === 'PENDING') await assertNoLeaveOverlap(trx, orgId, before.employeeId, start, end, id);
    const patch: Record<string, unknown> = {}; for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
    if (input.status === 'APPROVED' && before.status !== 'APPROVED') { patch.approvedBy = actor.userId; patch.approvedAt = new Date(); }
    if (Object.keys(patch).length) await trx.updateTable('leaveRecords').set(patch as never).where('id', '=', id).execute();
    const after = (await leaveQuery(trx, orgId).select(LEAVE_COLUMNS).where('l.id', '=', id).executeTakeFirstOrThrow()) as LeaveRow;
    await audit(trx, actor, orgId, 'leave.updated', 'leave_record', { entityId: id, branchId: before.branchId, ...diffObjects(toLeaveDto(before) as unknown as Record<string, unknown>, toLeaveDto(after) as unknown as Record<string, unknown>) });
    const recalc = await recalcIfPast(deps, trx, actor, orgId, minDate(isoDate(before.startDate), start), [isoDate(before.endDate), end].sort().pop() ?? end, { branchId: before.branchId, employeeIds: [before.employeeId], reason: 'leave changed' });
    return { ...toLeaveDto(after), recalculationJobId: recalc?.jobId ?? null };
  });
}
export async function deleteLeaveRecord(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<{ recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = (await leaveQuery(trx, orgId).select(LEAVE_COLUMNS).where('l.id', '=', id).executeTakeFirst()) as LeaveRow | undefined;
    if (!before) throw errors.notFound('Leave record', id);
    requireBranchAccess(grant, before.branchId);
    if (before.status === 'CANCELLED') throw errors.invalidState('The leave record is already cancelled.');
    await assertLeaveRangeUnlocked(trx, orgId, before.branchId, isoDate(before.startDate), isoDate(before.endDate));
    await trx.updateTable('leaveRecords').set({ status: 'CANCELLED' }).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'leave.cancelled', 'leave_record', { entityId: id, branchId: before.branchId, oldValue: toLeaveDto(before) });
    const recalc = before.status === 'APPROVED' ? await recalcIfPast(deps, trx, actor, orgId, isoDate(before.startDate), isoDate(before.endDate), { branchId: before.branchId, employeeIds: [before.employeeId], reason: 'leave cancelled' }) : null;
    return { recalculationJobId: recalc?.jobId ?? null };
  });
}

// ----- rule sets -------------------------------------------------------------------------------------------------------------

export interface RuleSetDto extends Record<string, unknown> { id: string; name: string; branchId: string | null; effectiveFrom: string; effectiveTo: string | null; version: number; createdAt: string; updatedAt: string }
const RULE_KEYS = ['graceInMinutes', 'graceOutMinutes', 'lateThresholdMinutes', 'earlyDepartureThresholdMinutes', 'minFullDayMinutes', 'halfDayThresholdMinutes', 'overtimeEnabled', 'overtimeStartAfterMinutes', 'overtimeMinBlockMinutes', 'overtimeRoundingMinutes', 'overtimeMaxMinutesPerDay', 'countEarlyInAsOvertime', 'punchRoundingMinutes', 'punchRoundingMode', 'workedRoundingMinutes', 'workedRoundingMode', 'punchInterpretation', 'duplicatePunchWindowSeconds', 'missingPunchBehavior', 'autoAbsentWithoutPunches', 'weeklyOffWorkCountsAsOvertime', 'holidayWorkCountsAsOvertime', 'ramadanMode'] as const;
function toRuleSetDto(r: Record<string, unknown> & { id: string; name: string; branchId: string | null; effectiveFrom: Date | string; effectiveTo: Date | string | null; version: number; createdAt: Date; updatedAt: Date }): RuleSetDto {
  const out: RuleSetDto = { id: r.id, name: r.name, branchId: r.branchId, effectiveFrom: isoDate(r.effectiveFrom), effectiveTo: isoDateOrNull(r.effectiveTo), version: r.version, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt) };
  for (const k of RULE_KEYS) out[k] = k === 'ramadanMode' ? jsonObject(r[k]) : r[k];
  return out;
}
export async function listRuleSets(deps: ApiDeps, actor: Actor, orgId: string, q: { branchId?: string; activeOn?: string; includeExpired: boolean }): Promise<RuleSetDto[]> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('attendanceRuleSets').selectAll().where('organizationId', '=', orgId);
    if (scope) base = base.where((eb) => eb.or([eb('branchId', 'is', null), eb('branchId', 'in', scope)]));
    if (q.activeOn) base = base.where('effectiveFrom', '<=', dv(q.activeOn)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(q.activeOn!))]));
    else if (!q.includeExpired) base = base.where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', today())]));
    return (await base.orderBy('branchId').orderBy('effectiveFrom', 'desc').execute()).map((r) => toRuleSetDto(r as never));
  });
}
function ruleSetValues(input: Partial<AttendanceRuleSetInput>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(input)) if (val !== undefined) v[k] = k === 'ramadanMode' ? JSON.stringify(val) : val;
  return v;
}
export async function createRuleSet(deps: ApiDeps, actor: Actor, orgId: string, input: AttendanceRuleSetInput): Promise<RuleSetDto & { recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_rules');
  requireBranchAccess(grant, input.branchId);
  if (!grant.allBranches && !input.branchId) throw errors.forbidden('Branch-scoped users cannot change the organisation-wide rule set.');
  if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) throw errors.validation('effectiveTo must be after effectiveFrom.', { issues: [{ path: 'effectiveTo', message: 'Invalid range' }] });
  return runUser(deps.db, actor, async (trx) => {
    if (input.branchId && !(await trx.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', '=', input.branchId).executeTakeFirst())) throw errors.validation('Branch not found.', { issues: [{ path: 'branchId', message: 'Unknown branch' }] });
    const row = await trx.insertInto('attendanceRuleSets').values({ organizationId: orgId, ...ruleSetValues(input), createdBy: actor.userId } as never).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'attendance.rule_set_created', 'attendance_rule_set', { entityId: row.id, branchId: input.branchId ?? null, newValue: input });
    const recalc = await recalcIfPast(deps, trx, actor, orgId, input.effectiveFrom, input.effectiveTo ?? null, { branchId: input.branchId ?? null, reason: `rule set ${input.name} created` });
    return { ...toRuleSetDto(row as never), recalculationJobId: recalc?.jobId ?? null };
  });
}
export async function updateRuleSet(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: Partial<AttendanceRuleSetInput>): Promise<RuleSetDto & { recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_rules');
  return runUser(deps.db, actor, async (trx) => {
    const before = await trx.selectFrom('attendanceRuleSets').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!before) throw errors.notFound('Rule set', id);
    requireBranchAccess(grant, before.branchId);
    if (input.branchId !== undefined && input.branchId !== before.branchId) throw errors.validation('The branch of a rule set cannot change; create a new rule set instead.', { issues: [{ path: 'branchId', message: 'Immutable' }] });
    const values = ruleSetValues(input); delete values.branchId;
    if (Object.keys(values).length) await trx.updateTable('attendanceRuleSets').set({ ...values, version: sql`version + 1` } as never).where('id', '=', id).execute();
    const after = await trx.selectFrom('attendanceRuleSets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const b = toRuleSetDto(before as never); const a = toRuleSetDto(after as never);
    await audit(trx, actor, orgId, 'attendance.rule_set_updated', 'attendance_rule_set', { entityId: id, branchId: before.branchId, ...diffObjects(b, a) });
    const recalc = await recalcIfPast(deps, trx, actor, orgId, minDate(b.effectiveFrom, a.effectiveFrom), null, { branchId: before.branchId, reason: `rule set ${after.name} changed` });
    return { ...a, recalculationJobId: recalc?.jobId ?? null };
  });
}
export async function deleteRuleSet(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<{ recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_rules');
  return runUser(deps.db, actor, async (trx) => {
    const r = await trx.selectFrom('attendanceRuleSets').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!r) throw errors.notFound('Rule set', id);
    requireBranchAccess(grant, r.branchId);
    await trx.deleteFrom('attendanceRuleSets').where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'attendance.rule_set_deleted', 'attendance_rule_set', { entityId: id, branchId: r.branchId, oldValue: toRuleSetDto(r as never) });
    const recalc = await recalcIfPast(deps, trx, actor, orgId, isoDate(r.effectiveFrom), isoDateOrNull(r.effectiveTo), { branchId: r.branchId, reason: `rule set ${r.name} deleted` });
    return { recalculationJobId: recalc?.jobId ?? null };
  });
}
