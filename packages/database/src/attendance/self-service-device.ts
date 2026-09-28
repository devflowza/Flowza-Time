import { sql } from 'kysely';
import { SELF_SERVICE_PROVIDER_KEY } from '@flowza/contracts';
import type { Trx } from '../context.js';

/**
 * The organisation's self-service "device" (HR portal Prompt 4, virtual-device convention §6.1): web / mobile check-ins and
 * approved selfie check-ins are stored as raw transactions of ONE virtual device per organisation, provider
 * `self_service`, so they flow through the same pipeline as terminal punches — raw (immutable) → normaliser → events →
 * daily record — with the same dedupe hash and the same audit trail.
 *
 * The row is created lazily (first self-service punch, selfie approval or regularisation), under a transaction-scoped
 * advisory lock so two concurrent first punches cannot create two rows. It is NOT a terminal: `status = 'disabled'` and
 * `auto_sync_enabled = false` keep it out of every scheduler scan (polls, health checks, employee sync, reconciliation and
 * metering all select `status = 'active'`), no push token is ever issued (so the push / webhook endpoints can never
 * authenticate as it), and the API hides it from device lists, counts, search and plan seats. Must run in the
 * organisation's system context (a user context would need `device.create`).
 */
export const SELF_SERVICE_DEVICE_CODE = 'FLOWZA-SELF-SERVICE';
export const SELF_SERVICE_DEVICE_NAME = 'FlowZa Self-Service';

export interface SelfServiceDevice { id: string; organizationId: string; generation: number; providerKey: string; branchId: string; timezone: string; created: boolean }

async function findSelfServiceDevice(trx: Trx, organizationId: string): Promise<Omit<SelfServiceDevice, 'created'> | undefined> {
  const row = await trx.selectFrom('devices').select(['id', 'organizationId', 'generation', 'providerKey', 'branchId', 'timezone'])
    .where('organizationId', '=', organizationId).where('providerKey', '=', SELF_SERVICE_PROVIDER_KEY)
    .orderBy('createdAt', 'asc').orderBy('id', 'asc').executeTakeFirst();
  return row ? { ...row, generation: Number(row.generation) } : undefined;
}

export async function ensureSelfServiceDevice(trx: Trx, organizationId: string): Promise<SelfServiceDevice> {
  const existing = await findSelfServiceDevice(trx, organizationId);
  if (existing) return { ...existing, created: false };
  await sql`select pg_advisory_xact_lock(hashtextextended(${`flowza:self-service-device:${organizationId}`}, 0))`.execute(trx);
  const again = await findSelfServiceDevice(trx, organizationId);
  if (again) return { ...again, created: false };

  const [org, branch, model, codeTaken] = await Promise.all([
    trx.selectFrom('organizations').select('timezone').where('id', '=', organizationId).executeTakeFirst(),
    trx.selectFrom('branches').select(['id', 'timezone']).where('organizationId', '=', organizationId)
      .orderBy(sql`case when status = 'active' then 0 else 1 end`).orderBy('createdAt', 'asc').orderBy('id', 'asc').executeTakeFirst(),
    trx.selectFrom('deviceModels').select('id').where('providerKey', '=', SELF_SERVICE_PROVIDER_KEY).orderBy('model', 'asc').executeTakeFirst(),
    trx.selectFrom('devices').select('id').where('organizationId', '=', organizationId).where('code', '=', SELF_SERVICE_DEVICE_CODE).executeTakeFirst(),
  ]);
  if (!branch) throw new Error('self-service device: the organisation has no branch');
  // a tenant terminal that happens to use the reserved code keeps it; the virtual device takes a suffixed one
  const code = codeTaken ? `${SELF_SERVICE_DEVICE_CODE}-${organizationId.slice(0, 8).toUpperCase()}` : SELF_SERVICE_DEVICE_CODE;
  const row = await trx.insertInto('devices').values({
    organizationId, branchId: branch.id, code, name: SELF_SERVICE_DEVICE_NAME, providerKey: SELF_SERVICE_PROVIDER_KEY, modelId: model?.id ?? null,
    manufacturer: 'FlowZa', modelName: SELF_SERVICE_DEVICE_NAME, integrationType: 'DEVICE_PUSH', status: 'disabled', autoSyncEnabled: false,
    capabilities: JSON.stringify({}), config: JSON.stringify({}), timezone: org?.timezone ?? branch.timezone ?? 'UTC', offlineThresholdMinutes: 1440, syncIntervalMinutes: 1440,
    tags: ['self-service', 'virtual'], notes: 'Virtual device of the employee portal (web / mobile / selfie check-ins). Created automatically; not a terminal.', createdBy: null,
  }).returning(['id', 'organizationId', 'generation', 'providerKey', 'branchId', 'timezone']).executeTakeFirstOrThrow();
  return { ...row, generation: Number(row.generation), created: true };
}
