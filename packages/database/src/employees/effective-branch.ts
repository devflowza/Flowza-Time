import { sql } from 'kysely';
import type { Trx } from '../context.js';

/**
 * The branch an employee belonged to ON a date — the ONE definition shared by every date-dependent read that must not use the
 * employee's CURRENT branch (a future-dated transfer updates `employees.branch_id` at once while the history transition only
 * starts at `effective_from`): the employment-history row effective on the date (`effective_from ≤ date` and `effective_to`
 * open or after the date; the latest `effective_from` wins), falling back to `employees.branch_id` when no history row covers
 * the date. Null when the employee is unknown or deleted. Runs under whatever context the caller established (the portal
 * reads it in the organisation's system scope for an already authorised employee).
 *
 * Shared by the employee portal's shift tab / swap rules (HR portal Prompt 4 review, P2-13) and leave day counting (Prompt 7).
 */
export async function effectiveBranchIdOn(trx: Trx, orgId: string, employeeId: string, date: string /* YYYY-MM-DD */): Promise<string | null> {
  const hist = await trx.selectFrom('employmentHistory').select('branchId')
    .where('organizationId', '=', orgId).where('employeeId', '=', employeeId)
    .where('effectiveFrom', '<=', sql<Date>`${date}::date`)
    .where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', sql<Date>`${date}::date`)]))
    .orderBy('effectiveFrom', 'desc').limit(1).executeTakeFirst();
  if (hist) return hist.branchId;
  const emp = await trx.selectFrom('employees').select('branchId').where('organizationId', '=', orgId).where('id', '=', employeeId).where('deletedAt', 'is', null).executeTakeFirst();
  return emp?.branchId ?? null;
}
