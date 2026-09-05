import { type z } from 'zod';
import { organizationSettingsSchema, type updateOrganizationSchema, type OrganizationDto, type OrganizationSettings, type SettingsGroup } from '@flowza/contracts';
import { errors, isValidTimezone } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requireMembership, requirePermission } from '../lib/authorize.js';
import { type Actor, runUser, audit, diffObjects } from '../lib/service.js';
import { loadSettings } from '../lib/settings.js';
import { ORG_COLUMNS, toOrganizationDto } from './organizations.mappers.js';

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export async function getOrganization(deps: ApiDeps, actor: Actor, orgId: string): Promise<OrganizationDto> {
  requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.selectFrom('organizations').select(ORG_COLUMNS).where('id', '=', orgId).executeTakeFirst();
    if (!row) throw errors.notFound('Organisation', orgId);
    return toOrganizationDto(row);
  });
}

export async function updateOrganization(deps: ApiDeps, actor: Actor, orgId: string, input: UpdateOrganizationInput): Promise<OrganizationDto> {
  requirePermission(actor.principal, orgId, 'organization.manage');
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) throw errors.validation('Invalid IANA timezone.', { issues: [{ path: 'timezone', message: 'Unknown timezone' }] });
  return runUser(deps.db, actor, async (trx) => {
    const before = await trx.selectFrom('organizations').select(ORG_COLUMNS).where('id', '=', orgId).executeTakeFirst();
    if (!before) throw errors.notFound('Organisation', orgId);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = k === 'contact' || k === 'address' ? JSON.stringify(v) : v;
    if (Object.keys(patch).length > 0) {
      await trx.updateTable('organizations').set(patch).where('id', '=', orgId).execute();
    }
    const after = await trx.selectFrom('organizations').select(ORG_COLUMNS).where('id', '=', orgId).executeTakeFirstOrThrow();
    const beforeDto = toOrganizationDto(before); const afterDto = toOrganizationDto(after);
    const diff = diffObjects(beforeDto as unknown as Record<string, unknown>, afterDto as unknown as Record<string, unknown>);
    await audit(trx, actor, orgId, 'organization.updated', 'organization', { entityId: orgId, ...diff });
    return afterDto;
  });
}

export async function getSettings(deps: ApiDeps, actor: Actor, orgId: string): Promise<OrganizationSettings> {
  requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, (trx) => loadSettings(trx, orgId));
}

export async function getSettingsGroup(deps: ApiDeps, actor: Actor, orgId: string, group: SettingsGroup): Promise<OrganizationSettings[SettingsGroup]> {
  const all = await getSettings(deps, actor, orgId);
  return all[group];
}

export async function putSettingsGroup(deps: ApiDeps, actor: Actor, orgId: string, group: SettingsGroup, payload: unknown): Promise<OrganizationSettings[SettingsGroup]> {
  requirePermission(actor.principal, orgId, 'organization.manage');
  const groupSchema = organizationSettingsSchema.shape[group];
  const value = groupSchema.parse(payload ?? {}); // ZodError → 400 VALIDATION_ERROR envelope
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadSettings(trx, orgId);
    await trx.insertInto('organizationSettings')
      .values({ organizationId: orgId, [group]: JSON.stringify(value), updatedBy: actor.userId } as never)
      .onConflict((oc) => oc.column('organizationId').doUpdateSet({ [group]: JSON.stringify(value), updatedBy: actor.userId } as never))
      .execute();
    await audit(trx, actor, orgId, 'organization.settings_updated', 'organization_settings', { entityId: `${orgId}:${group}`, oldValue: before[group], newValue: value, reason: null });
    return (await loadSettings(trx, orgId))[group];
  });
}
