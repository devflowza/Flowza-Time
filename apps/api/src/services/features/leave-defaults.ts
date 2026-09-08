import { DEFAULT_LEAVE_TYPES } from '@flowza/contracts';
import type { Trx } from '@flowza/database';

/**
 * The GCC default leave-type set (decision #3 of the reports plan): Annual, Casual, Sick, Emergency, Special, Maternity
 * (paid), No-Pay (unpaid → counts with absences), Site Duty (paid, counts as present). Inserted for a new organisation and
 * offered as a one-click seed for existing ones; codes the organisation already has are left untouched, so running it
 * again never duplicates or overwrites anything. Returns the codes that were created.
 */
export async function seedDefaultLeaveTypes(trx: Trx, organizationId: string): Promise<string[]> {
  const existing = new Set((await trx.selectFrom('leaveTypes').select('code').where('organizationId', '=', organizationId).execute()).map((r) => String(r.code).toUpperCase()));
  const missing = DEFAULT_LEAVE_TYPES.filter((d) => !existing.has(d.code.toUpperCase()));
  if (missing.length === 0) return [];
  await trx.insertInto('leaveTypes').values(missing.map((d) => ({ organizationId, code: d.code, name: d.name, nameAr: d.nameAr, isPaid: d.isPaid, treatAsPresent: d.treatAsPresent, color: d.color }))).execute();
  return missing.map((d) => d.code);
}
