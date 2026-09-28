import { sql } from 'kysely';
import { FLOWZA_FINANCE_PROVIDER_KEY } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { isFinancePinIdentity } from '@flowza/device-providers';

export interface FinanceIdentityResolver {
  /** Employee id for a raw row of a connector device, or null when it matches no current employee (the row stays `unmatched`). */
  resolve(deviceId: string, deviceEmployeeId: string): string | null;
  /** Connector devices in this batch (raw rows of any other device never go through the resolver). */
  readonly deviceIds: ReadonlySet<string>;
}

const NONE: FinanceIdentityResolver = { resolve: () => null, deviceIds: new Set() };
/** Leavers are never matched: a punch attributed to a terminated employee would reopen their attendance. */
const EXCLUDED_EMPLOYMENT = ['terminated', 'resigned'] as const;

/**
 * Identity for punches PULLED from Flowza Finance (review D7). The raw row's `device_employee_id` is Finance's employee number, and
 * it is matched ONLY against our `employees.employee_number` — trimmed, case-insensitive, same organisation, not deleted, not
 * terminated/resigned. Nothing else is consulted: not the configured `pinKey` (that chooses what we SEND as the PIN), not our device
 * user ids or card numbers, not the generic device-identity fallbacks. A Finance punch Finance itself could not attribute arrives
 * under a namespaced `pin:<finance device serial>:<pin>` identity and stays `unmatched`: a Finance terminal's PIN that happens to equal
 * one of our device user ids belongs to somebody else, and a visible unmatched punch is fixable while a silent mis-attribution is not.
 * Employee numbers are citext; the comparison is `lower(::text)` because the worker's search_path lacks `extensions`.
 */
export async function buildFinanceIdentityResolver(trx: Trx, organizationId: string, devices: ReadonlyArray<{ id: string; providerKey: string }>, rows: ReadonlyArray<{ deviceId: string; deviceEmployeeId: string }>): Promise<FinanceIdentityResolver> {
  const connectors = new Set(devices.filter((d) => d.providerKey === FLOWZA_FINANCE_PROVIDER_KEY).map((d) => d.id));
  if (connectors.size === 0) return NONE;
  const numbers = new Set<string>();
  for (const r of rows) {
    if (!connectors.has(r.deviceId) || isFinancePinIdentity(r.deviceEmployeeId)) continue;
    const n = r.deviceEmployeeId.trim().toLowerCase();
    if (n.length > 0) numbers.add(n);
  }
  const byNumber = new Map<string, string>();
  if (numbers.size > 0) {
    const found = await trx.selectFrom('employees').select(['id', 'employeeNumber'])
      .where('organizationId', '=', organizationId).where('deletedAt', 'is', null).where('employmentStatus', 'not in', [...EXCLUDED_EMPLOYMENT])
      .where(sql<string>`lower(btrim(employee_number::text))`, 'in', [...numbers]).execute();
    for (const e of found) byNumber.set(e.employeeNumber.trim().toLowerCase(), e.id);
  }
  return {
    deviceIds: connectors,
    resolve(deviceId, deviceEmployeeId) {
      if (!connectors.has(deviceId) || isFinancePinIdentity(deviceEmployeeId)) return null;
      return byNumber.get(deviceEmployeeId.trim().toLowerCase()) ?? null;
    },
  };
}
