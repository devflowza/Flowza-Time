import { SELF_SERVICE_PROVIDER_KEY } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';

/**
 * The organisation's virtual self-service device (provider `self_service`, HR portal Prompt 4) records portal check-ins and
 * approved selfie check-ins; it is not a terminal. It is hidden from device lists, counts, seats and usage, and every generic
 * device operation named by id — sync, health check, reconcile, restart, test connection — is refused with 409
 * (INVALID_STATE), the way the Finance connector refuses the generic mutations.
 */
export const SELF_SERVICE_DEVICE_MESSAGE = 'The self-service device records portal check-ins; it is not a terminal and has no device operations.';

export function refuseSelfServiceProvider(providerKey: string): void {
  if (providerKey === SELF_SERVICE_PROVIDER_KEY) throw errors.invalidState(SELF_SERVICE_DEVICE_MESSAGE, { providerKey });
}

export async function refuseSelfServiceDevices(trx: Trx, orgId: string, deviceIds: readonly string[] | null | undefined): Promise<void> {
  if (!deviceIds || deviceIds.length === 0) return;
  const hit = await trx.selectFrom('devices').select('id').where('organizationId', '=', orgId).where('id', 'in', [...new Set(deviceIds)]).where('providerKey', '=', SELF_SERVICE_PROVIDER_KEY).executeTakeFirst();
  if (hit) throw errors.invalidState(SELF_SERVICE_DEVICE_MESSAGE, { deviceId: hit.id, providerKey: SELF_SERVICE_PROVIDER_KEY });
}
