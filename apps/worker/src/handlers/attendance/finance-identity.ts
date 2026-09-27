import { sql } from 'kysely';
import { FINANCE_PIN_KEYS, FLOWZA_FINANCE_PROVIDER_KEY, type FinancePinKey } from '@flowza/contracts';
import type { Trx } from '@flowza/database';

/** `devices.config.pinKey` of a Flowza Finance connector (validated by the API; anything else reads as the default). */
export function financePinKeyOf(config: unknown): FinancePinKey {
  const v = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>)['pinKey'] : undefined;
  return (FINANCE_PIN_KEYS as readonly string[]).includes(String(v)) ? (v as FinancePinKey) : 'employee_number';
}

export interface FinanceIdentityResolver {
  /** Employee id for a raw row of a connector device, or null when the PIN matches no live employee. */
  resolve(deviceId: string, deviceEmployeeId: string): string | null;
  /** Connector devices in this batch (raw rows of any other device never go through the resolver). */
  readonly deviceIds: ReadonlySet<string>;
}

const NONE: FinanceIdentityResolver = { resolve: () => null, deviceIds: new Set() };

/**
 * Identity for punches PULLED from Flowza Finance. The raw row's `device_employee_id` is Finance's `employee_number` (or the
 * producing device's PIN) — the same value the connector SENDS as the PIN on push — so it is matched against the employee field
 * the connector is configured with (`pinKey`: employee_number, device_user_id or card_number), same organisation, not deleted.
 * Employee numbers are citext in the database; the lookup is case-insensitive to match (lower(::text) on both sides). Rows the resolver cannot place fall
 * through to the normaliser's standard chain and, failing that, stay `unmatched` for reconciliation.
 */
export async function buildFinanceIdentityResolver(trx: Trx, organizationId: string, devices: ReadonlyArray<{ id: string; providerKey: string; config: unknown }>, rows: ReadonlyArray<{ deviceId: string; deviceEmployeeId: string }>): Promise<FinanceIdentityResolver> {
  const connectors = new Map(devices.filter((d) => d.providerKey === FLOWZA_FINANCE_PROVIDER_KEY).map((d) => [d.id, financePinKeyOf(d.config)]));
  if (connectors.size === 0) return NONE;
  const wanted: Record<FinancePinKey, Set<string>> = { employee_number: new Set(), device_user_id: new Set(), card_number: new Set() };
  for (const r of rows) {
    const key = connectors.get(r.deviceId);
    if (key) wanted[key].add(r.deviceEmployeeId);
  }
  const byNumber = new Map<string, string>();
  const byDeviceUser = new Map<string, string>();
  const byCard = new Map<string, string>();
  let q = trx.selectFrom('employees').select(['id', 'employeeNumber', 'deviceUserId', 'cardNumber']).where('organizationId', '=', organizationId).where('deletedAt', 'is', null);
  const numbers = [...wanted.employee_number];
  const deviceUsers = [...wanted.device_user_id];
  const cards = [...wanted.card_number];
  if (numbers.length + deviceUsers.length + cards.length === 0) return { resolve: () => null, deviceIds: new Set(connectors.keys()) };
  q = q.where((eb) => eb.or([
    // lower(::text), not the citext column itself: the worker's search_path does not include `extensions`, so a bare `=` on
    // citext resolves to text equality and turns case-sensitive (same pattern as the employee import)
    ...(numbers.length ? [eb(sql<string>`lower(employee_number::text)`, 'in', numbers.map((n) => n.trim().toLowerCase()))] : []),
    ...(deviceUsers.length ? [eb('deviceUserId', 'in', deviceUsers)] : []),
    ...(cards.length ? [eb('cardNumber', 'in', cards)] : []),
  ]));
  for (const e of await q.execute()) {
    byNumber.set(e.employeeNumber.toLowerCase(), e.id);
    byDeviceUser.set(e.deviceUserId, e.id);
    if (e.cardNumber) byCard.set(e.cardNumber, e.id);
  }
  return {
    deviceIds: new Set(connectors.keys()),
    resolve(deviceId, deviceEmployeeId) {
      const key = connectors.get(deviceId);
      if (!key) return null;
      const id = deviceEmployeeId.trim();
      if (key === 'employee_number') return byNumber.get(id.toLowerCase()) ?? null;
      if (key === 'device_user_id') return byDeviceUser.get(id) ?? null;
      return byCard.get(id) ?? null;
    },
  };
}
