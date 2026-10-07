import { addDays } from '@flowza/shared';
import type { Trx } from '@flowza/database';
import type { ApiDeps } from '../../deps.js';
import type { Actor } from '../../lib/service.js';
import { enqueueRecalculation, orgToday } from '../features/recalc.js';

/*
 * Shared plumbing of the round-the-clock scheduling services (Enterprise, module `advanced_scheduling`,
 * docs/enterprise/plan.md §4.7–4.8, §8–§9): date arithmetic and the "recalculate the past part of a change" rule the schedule
 * service applies to shift assignments.
 */

export const minDate = (a: string, b: string): string => (a < b ? a : b);
export const maxDate = (a: string, b: string): string => (a > b ? a : b);

/** Whole days from `from` to `to` (to − from). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The inclusive dates [from, to], at most `cap` of them. */
export function datesFrom(from: string, to: string, cap: number): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < cap; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Recompute an employee's (or a set of employees') days of [from, to] that are not in the future: a change to future dates
 * recalculates when those dates arrive. Returns the queue job of the recalculation (a `jobs.queue` id — never a sync job).
 */
export async function recalcPastDays(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, from: string, to: string | null, scope: { employeeIds: string[]; branchId?: string | null; reason: string }): Promise<string | null> {
  if (scope.employeeIds.length === 0) return null;
  const today = await orgToday(trx, orgId);
  if (from > today) return null;
  const res = await enqueueRecalculation(deps, trx, actor, orgId, { fromDate: from, toDate: minDate(to ?? today, today), branchId: scope.branchId ?? null, employeeIds: scope.employeeIds, reason: scope.reason });
  return res?.jobId ?? null;
}
