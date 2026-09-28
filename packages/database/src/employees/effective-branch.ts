import { sql } from 'kysely';
import type { Trx } from '../context.js';

/**
 * The branch an employee belonged to on a date (`YYYY-MM-DD`): the `employment_history` row effective on that date — the
 * latest `effective_from` on or before it — falling back to `employees.branch_id`. Null when the employee is unknown.
 *
 * The one placement rule of the per-date working calendar (leave v2 review P1-2: `loadEmployeeWorkingCalendars` applies it
 * to pre-loaded history rows for bulk readers — the attendance input loader, leave counting, balances, the comp-off
 * preview) and of the portal. Runs under the caller's context (the history is branch-scoped by RLS: callers that authorised
 * the employee first usually read it in the organisation's system scope).
 */
export async function effectiveBranchIdOn(trx: Trx, orgId: string, employeeId: string, date: string): Promise<string | null> {
  const history = await trx.selectFrom('employmentHistory').select('branchId')
    .where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('effectiveFrom', '<=', sql<Date>`${date}::date`)
    .orderBy('effectiveFrom', 'desc').limit(1).executeTakeFirst();
  if (history) return history.branchId;
  const employee = await trx.selectFrom('employees').select('branchId').where('organizationId', '=', orgId).where('id', '=', employeeId).executeTakeFirst();
  return employee?.branchId ?? null;
}
