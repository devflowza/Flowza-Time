import { type z } from 'zod';
import { sql } from 'kysely';
import { organizationSettingsSchema, SYSTEM_ROLE_IDS, type createOwnOrganizationSchema, type updateOrganizationSchema, type CreateOwnOrganizationResult, type OrganizationDto, type OrganizationSettings, type SettingsGroup } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors, isValidTimezone, newId } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requireMembership, requirePermission } from '../lib/authorize.js';
import { type Actor, runUser, runSystem, audit, diffObjects } from '../lib/service.js';
import { loadSettings } from '../lib/settings.js';
import { ORG_COLUMNS, toOrganizationDto, type OrgRow } from './organizations.mappers.js';
import { provisionTenant } from './tenant-provisioning.js';

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type CreateOwnOrganizationInput = z.infer<typeof createOwnOrganizationSchema>;

const SELF_SERVE_PLAN_KEY = 'trial';
const CODE_MAX = 24;

/** "Al Bahja Trading LLC" → "AL-BAHJA-TRADING-LLC": the organisations.company_code format, from a display name. */
export function deriveCompanyCode(displayName: string): string {
  const base = displayName.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase().slice(0, CODE_MAX).replace(/-+$/, '');
  return base.length >= 2 ? base : 'ORG';
}

/** A unique-index rejection on organisations.company_code (citext, so case-insensitive). */
function isCompanyCodeClash(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && /company_code/.test(e.constraint ?? '');
}

/**
 * Provision under the first free code in `base, base-2, base-3, …`. The system context is scoped to the NEW organisation
 * and RLS hides every other tenant's row, so a select can never see a clash — the unique index is the only reliable
 * signal. Each attempt runs in a savepoint so a rejected insert does not doom the transaction.
 */
async function provisionUnderFreeCode(trx: Trx, base: string, explicit: boolean, make: (code: string) => Promise<OrgRow>): Promise<OrgRow> {
  const attempts = explicit ? 1 : 50;
  for (let n = 1; n <= attempts; n++) {
    const code = n === 1 ? base : `${base.slice(0, CODE_MAX - String(n).length - 1)}-${n}`;
    await sql`savepoint company_code`.execute(trx);
    try {
      const org = await make(code);
      await sql`release savepoint company_code`.execute(trx);
      return org;
    } catch (err) {
      if (!isCompanyCodeClash(err)) throw err;
      await sql`rollback to savepoint company_code`.execute(trx);
    }
  }
  throw errors.conflict(explicit ? 'An organisation with this company code already exists.' : 'Could not find a free company code for this name. Choose a company code explicitly.');
}

/**
 * Self-service tenant creation: the signed-in caller becomes the owner of a new trial organisation.
 *
 * Only a user with no active membership may do this — sign-up onboarding, not a way for an existing member to mint
 * tenants (that stays with the platform console). The writes run in the system context of the new organisation
 * exactly like the platform path does: the caller has no tenant permissions until the owner membership exists.
 */
export async function createOwnOrganization(deps: ApiDeps, actor: Actor, input: CreateOwnOrganizationInput): Promise<CreateOwnOrganizationResult> {
  if (actor.principal.memberships.length > 0) throw errors.invalidState('Your account already belongs to an organisation. Ask an administrator to create another one.');
  if (!isValidTimezone(input.timezone)) throw errors.validation('Invalid IANA timezone.', { issues: [{ path: 'timezone', message: 'Unknown timezone' }] });
  const plan = await runUser(deps.db, actor, (trx) => trx.selectFrom('plans').select(['id', 'key']).where('key', '=', SELF_SERVE_PLAN_KEY).where('isActive', '=', true).executeTakeFirst());
  if (!plan) throw errors.invalidState('Self-service sign-up is not available right now.');
  const orgId = newId();
  return runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    const org = await provisionUnderFreeCode(trx, input.companyCode ?? deriveCompanyCode(input.displayName), !!input.companyCode, (companyCode) => provisionTenant(trx, {
      orgId, companyCode, legalName: input.legalName ?? input.displayName, displayName: input.displayName, countryCode: input.countryCode, timezone: input.timezone, currencyCode: input.currencyCode,
      locale: input.locale, weeklyOffDays: [5, 6], contact: {}, address: {}, plan, createdBy: actor.userId,
    }));
    const companyCode = org.companyCode;
    // A brand-new auth user may not have hit /me yet, so the profile row may not exist (RLS allows self-insert only).
    const email = actor.email || `${actor.userId}@users.flowza.invalid`;
    await trx.insertInto('userProfiles').values({ id: actor.userId, email, fullName: input.ownerFullName ?? '' }).onConflict((oc) => oc.column('id').doNothing()).execute();
    if (input.ownerFullName) await trx.updateTable('userProfiles').set({ fullName: sql`case when full_name = '' then ${input.ownerFullName} else full_name end` }).where('id', '=', actor.userId).execute();
    const membership = await trx.insertInto('orgMemberships').values({ organizationId: orgId, userId: actor.userId, roleId: SYSTEM_ROLE_IDS.owner, status: 'active', allBranches: true, joinedAt: new Date() }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'organization.created', 'organization', { entityId: orgId, newValue: { companyCode, displayName: input.displayName, planKey: plan.key, source: 'self_serve', ownerMembershipId: membership.id } });
    return { organization: toOrganizationDto(org), membershipId: membership.id };
  });
}

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
