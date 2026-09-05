import { organizationSettingsSchema, SETTINGS_GROUPS, type OrganizationSettings, type SettingsGroup } from '@flowza/contracts';
import type { Trx } from '@flowza/database';

export type RawSettingsRow = { general: unknown; attendance: unknown; sync: unknown; notifications: unknown; security: unknown; integrations: unknown } | undefined | null;

/** Parse a settings row through the shared schema so defaults are always filled in. */
export function parseSettings(row: RawSettingsRow): OrganizationSettings {
  const input: Record<string, unknown> = {};
  for (const g of SETTINGS_GROUPS) input[g] = (row as Record<string, unknown> | null | undefined)?.[g] ?? {};
  const parsed = organizationSettingsSchema.safeParse(input);
  return parsed.success ? parsed.data : organizationSettingsSchema.parse({});
}

export function isSettingsGroup(value: string): value is SettingsGroup {
  return (SETTINGS_GROUPS as readonly string[]).includes(value);
}

export async function loadSettings(trx: Trx, organizationId: string): Promise<OrganizationSettings> {
  const row = await trx.selectFrom('organizationSettings').select(['general', 'attendance', 'sync', 'notifications', 'security', 'integrations']).where('organizationId', '=', organizationId).executeTakeFirst();
  return parseSettings(row);
}

/** Effective feature flags for organisations: platform defaults overridden by per-organisation rows. */
export async function loadFeatureFlags(trx: Trx, organizationIds: string[]): Promise<Map<string, Record<string, boolean>>> {
  const flags = await trx.selectFrom('featureFlags').select(['key', 'defaultEnabled']).execute();
  const out = new Map<string, Record<string, boolean>>();
  for (const orgId of organizationIds) out.set(orgId, Object.fromEntries(flags.map((f) => [f.key, f.defaultEnabled])));
  if (organizationIds.length > 0) {
    const overrides = await trx.selectFrom('organizationFeatureFlags').select(['organizationId', 'flagKey', 'enabled']).where('organizationId', 'in', organizationIds).execute();
    for (const o of overrides) { const m = out.get(o.organizationId); if (m) m[o.flagKey] = o.enabled; }
  }
  return out;
}
