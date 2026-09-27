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
  if (missing.length) await trx.insertInto('leaveTypes').values(missing.map((d) => ({ organizationId, code: d.code, name: d.name, nameAr: d.nameAr, isPaid: d.isPaid, treatAsPresent: d.treatAsPresent, color: d.color }))).execute();
  await ensureCompOffTypeRow(trx, organizationId, new Set([...existing, ...missing.map((d) => d.code.toUpperCase())]));
  return missing.map((d) => d.code);
}

/**
 * Leave v2: every organisation has exactly one comp-off type (system key COMP_OFF) — coded CO, or COFF when CO is taken —
 * that comp-off credits are redeemed through. It is special (never charged for unexcused days) and hidden from the ordinary
 * apply form. Created by the migration for existing organisations and here for new ones; returns its code when created.
 */
export async function ensureCompOffTypeRow(trx: Trx, organizationId: string, knownCodes?: ReadonlySet<string>): Promise<string | null> {
  const present = await trx.selectFrom('leaveTypes').select('id').where('organizationId', '=', organizationId).where('systemKey', '=', 'COMP_OFF').executeTakeFirst();
  if (present) return null;
  const codes = knownCodes ?? new Set((await trx.selectFrom('leaveTypes').select('code').where('organizationId', '=', organizationId).execute()).map((r) => String(r.code).toUpperCase()));
  const code = !codes.has('CO') ? 'CO' : !codes.has('COFF') ? 'COFF' : null;
  if (!code) return null;
  await trx.insertInto('leaveTypes').values({ organizationId, code, name: 'Compensatory Off', nameAr: 'إجازة تعويضية', isPaid: true, treatAsPresent: false, color: '#6941c6', requiresApproval: true, countMode: 'working', accrual: 'none', isSpecial: true, allowHalfDay: true, portalVisible: false, systemKey: 'COMP_OFF' }).execute();
  return code;
}
