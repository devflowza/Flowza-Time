import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import { isoDate, isoDateOrNull } from '../../lib/mappers.js';
import { dv } from '../features/sql-helpers.js';

/**
 * Put an employee on a shift for a RANGE of days (Enterprise shift change requests, docs/enterprise/plan.md §6): the range
 * generalisation of the swap's one-day placement (swap-effects.ts `placeOneDayShift`, left as it is). Both effective-dated
 * tables keep at most ONE row per employee and date (no-overlap exclusion constraints), so a row that covers part of the
 * range is trimmed or split around it and the rest of it stays untouched:
 *
 *   existing  |-----------------------|            range        |=======|
 *   result    |-------|=======|-------|            (split: the head keeps its id, the tail is a new row)
 *
 * Ranges are half-open `[from, toExclusive)` with `null` = open-ended, exactly as stored. `planRangeSplit` is the pure part
 * (unit-tested); `placeEmployeeShiftRange` (shift_assignments, EMPLOYEE target) and `placeAdditionalShiftRange`
 * (additional_shift_assignments) apply it inside the caller's transaction — the approval hook's system step. The rows are
 * trimmed BEFORE the new one is inserted, so the exclusion constraints never see an overlap.
 */

export interface RangeRow { id: string; from: string; /** exclusive; null = open-ended */ to: string | null }

export type SplitAction =
  /** The row lies entirely inside the range: it goes. */
  | { kind: 'delete'; id: string; from: string; to: string | null }
  /** The row starts before the range and ends inside it: it now ends where the range starts. */
  | { kind: 'trim_end'; id: string; from: string; to: string | null; newTo: string }
  /** The row starts inside the range and runs past it: it now starts where the range ends. */
  | { kind: 'trim_start'; id: string; from: string; to: string | null; newFrom: string }
  /** The row covers the range on both sides: it ends where the range starts and a copy continues after it. */
  | { kind: 'split'; id: string; from: string; to: string | null; newTo: string; restFrom: string; restTo: string | null };

/** Touched rows as recorded in the audit trail. */
export interface TouchedRow { id: string; from: string; to: string | null; action: 'replaced' | 'ends_before_change' | 'starts_after_change' | 'continues_after_change' }

const overlaps = (r: RangeRow, from: string, toExclusive: string): boolean => r.from < toExclusive && (r.to === null || r.to > from);

/** What to do with each existing row so that `[from, toExclusive)` is free. Rows that do not overlap are left out. Pure. */
export function planRangeSplit(rows: readonly RangeRow[], from: string, toExclusive: string): SplitAction[] {
  if (!(from < toExclusive)) throw errors.internal(`empty range [${from}, ${toExclusive})`);
  const out: SplitAction[] = [];
  for (const r of rows) {
    if (!overlaps(r, from, toExclusive)) continue;
    const startsBefore = r.from < from;
    const endsAfter = r.to === null || r.to > toExclusive;
    if (startsBefore && endsAfter) out.push({ kind: 'split', id: r.id, from: r.from, to: r.to, newTo: from, restFrom: toExclusive, restTo: r.to });
    else if (startsBefore) out.push({ kind: 'trim_end', id: r.id, from: r.from, to: r.to, newTo: from });
    else if (endsAfter) out.push({ kind: 'trim_start', id: r.id, from: r.from, to: r.to, newFrom: toExclusive });
    else out.push({ kind: 'delete', id: r.id, from: r.from, to: r.to });
  }
  return out;
}

/**
 * Maximal runs of consecutive dates (inclusive bounds) among `dates` (ascending ISO dates) that `keep` accepts. A CHANGE skips
 * the rotation pattern's rest days, so a fixed shift never turns a rest day of the employee's rotation into a working day.
 */
export function runsOf(dates: readonly string[], keep: (date: string) => boolean, nextDay: (date: string) => string): Array<{ from: string; to: string }> {
  const runs: Array<{ from: string; to: string }> = [];
  for (const d of dates) {
    if (!keep(d)) continue;
    const last = runs.at(-1);
    if (last && nextDay(last.to) === d) last.to = d;
    else runs.push({ from: d, to: d });
  }
  return runs;
}

function touchedOf(actions: readonly SplitAction[], restIds: ReadonlyMap<string, string>): TouchedRow[] {
  const out: TouchedRow[] = [];
  for (const a of actions) {
    if (a.kind === 'delete') out.push({ id: a.id, from: a.from, to: a.to, action: 'replaced' });
    else if (a.kind === 'trim_start') out.push({ id: a.id, from: a.from, to: a.to, action: 'starts_after_change' });
    else {
      out.push({ id: a.id, from: a.from, to: a.to, action: 'ends_before_change' });
      if (a.kind === 'split') out.push({ id: restIds.get(a.id)!, from: a.restFrom, to: a.restTo, action: 'continues_after_change' });
    }
  }
  return out;
}

export interface PlaceRangeInput { employeeId: string; branchId: string | null; shiftId: string; from: string; /** exclusive */ toExclusive: string; actorUserId: string }

/**
 * The employee works `shiftId` on `[from, toExclusive)`: ONE employee-level shift assignment for the range, every employee-level
 * assignment overlapping it trimmed / split around it (team, department, branch and organisation assignments stay: the
 * employee's own one is the most specific and wins). Returns the new assignment's id and what was touched.
 */
export async function placeEmployeeShiftRange(t: Trx, orgId: string, input: PlaceRangeInput): Promise<{ id: string; touched: TouchedRow[] }> {
  const existing = await t.selectFrom('shiftAssignments').select(['id', 'branchId', 'shiftId', 'shiftPatternId', 'effectiveFrom', 'effectiveTo'])
    .where('organizationId', '=', orgId).where('targetType', '=', 'EMPLOYEE').where('targetId', '=', input.employeeId)
    .where('effectiveFrom', '<', dv(input.toExclusive)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(input.from))]))
    .orderBy('effectiveFrom').execute();
  const byId = new Map(existing.map((r) => [r.id, r]));
  const actions = planRangeSplit(existing.map((r) => ({ id: r.id, from: isoDate(r.effectiveFrom), to: isoDateOrNull(r.effectiveTo) })), input.from, input.toExclusive);
  const restIds = new Map<string, string>();
  for (const a of actions) {
    if (a.kind === 'delete') await t.deleteFrom('shiftAssignments').where('id', '=', a.id).execute();
    else if (a.kind === 'trim_start') await t.updateTable('shiftAssignments').set({ effectiveFrom: a.newFrom }).where('id', '=', a.id).execute();
    else {
      await t.updateTable('shiftAssignments').set({ effectiveTo: a.newTo }).where('id', '=', a.id).execute();
      if (a.kind === 'split') {
        const src = byId.get(a.id)!;
        const rest = await t.insertInto('shiftAssignments').values({ organizationId: orgId, targetType: 'EMPLOYEE', targetId: input.employeeId, branchId: src.branchId, shiftId: src.shiftId, shiftPatternId: src.shiftPatternId, effectiveFrom: a.restFrom, effectiveTo: a.restTo, createdBy: input.actorUserId })
          .returning('id').executeTakeFirstOrThrow();
        restIds.set(a.id, rest.id);
      }
    }
  }
  const row = await t.insertInto('shiftAssignments').values({ organizationId: orgId, targetType: 'EMPLOYEE', targetId: input.employeeId, branchId: input.branchId, shiftId: input.shiftId, shiftPatternId: null, effectiveFrom: input.from, effectiveTo: input.toExclusive, createdBy: input.actorUserId })
    .returning('id').executeTakeFirstOrThrow();
  return { id: row.id, touched: touchedOf(actions, restIds) };
}

/**
 * The employee works `shiftId` as an ADDITIONAL (second) shift on `[from, toExclusive)`: one additional shift assignment for the
 * range, linked to the change request, every additional assignment overlapping it trimmed / split around it.
 */
export async function placeAdditionalShiftRange(t: Trx, orgId: string, input: PlaceRangeInput & { shiftChangeRequestId: string | null }): Promise<{ id: string; touched: TouchedRow[] }> {
  const existing = await t.selectFrom('additionalShiftAssignments').select(['id', 'branchId', 'shiftId', 'shiftChangeRequestId', 'effectiveFrom', 'effectiveTo'])
    .where('organizationId', '=', orgId).where('employeeId', '=', input.employeeId)
    .where('effectiveFrom', '<', dv(input.toExclusive)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(input.from))]))
    .orderBy('effectiveFrom').execute();
  const byId = new Map(existing.map((r) => [r.id, r]));
  const actions = planRangeSplit(existing.map((r) => ({ id: r.id, from: isoDate(r.effectiveFrom), to: isoDateOrNull(r.effectiveTo) })), input.from, input.toExclusive);
  const restIds = new Map<string, string>();
  for (const a of actions) {
    if (a.kind === 'delete') await t.deleteFrom('additionalShiftAssignments').where('id', '=', a.id).execute();
    else if (a.kind === 'trim_start') await t.updateTable('additionalShiftAssignments').set({ effectiveFrom: a.newFrom }).where('id', '=', a.id).execute();
    else {
      await t.updateTable('additionalShiftAssignments').set({ effectiveTo: a.newTo }).where('id', '=', a.id).execute();
      if (a.kind === 'split') {
        const src = byId.get(a.id)!;
        const rest = await t.insertInto('additionalShiftAssignments').values({ organizationId: orgId, employeeId: input.employeeId, branchId: src.branchId, shiftId: src.shiftId, shiftChangeRequestId: src.shiftChangeRequestId, effectiveFrom: a.restFrom, effectiveTo: a.restTo, createdBy: input.actorUserId })
          .returning('id').executeTakeFirstOrThrow();
        restIds.set(a.id, rest.id);
      }
    }
  }
  const row = await t.insertInto('additionalShiftAssignments').values({ organizationId: orgId, employeeId: input.employeeId, branchId: input.branchId, shiftId: input.shiftId, shiftChangeRequestId: input.shiftChangeRequestId, effectiveFrom: input.from, effectiveTo: input.toExclusive, createdBy: input.actorUserId })
    .returning('id').executeTakeFirstOrThrow();
  return { id: row.id, touched: touchedOf(actions, restIds) };
}
