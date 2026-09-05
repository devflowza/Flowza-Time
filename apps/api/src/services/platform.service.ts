import { type z } from 'zod';
import type { AccessGrantDto, CreateAccessGrantInput, CreateOrganizationInput, CreateOrganizationResult, FeatureFlagDto, OrgFeatureFlagDto, OrgStatus, PlanDto, PlatformHealthDto, PlatformOrganizationDto, accessGrantListQuerySchema, platformOrgListQuerySchema, putFeatureFlagsSchema, putOrgFeatureFlagsSchema, updateOrganizationStatusSchema } from '@flowza/contracts';
import { SYSTEM_ROLE_IDS } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors, isValidTimezone, newId, randomToken, sha256Hex } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requirePlatformAdmin } from '../lib/authorize.js';
import { type Actor, runUser, runSystem, audit, PLATFORM_SCOPE_ORG } from '../lib/service.js';
import { likeContains, pageOf, resolveSort, toCount } from '../lib/pagination.js';
import { isoDateTime, isoDateTimeOrNull, jsonObject } from '../lib/mappers.js';
import { ORG_COLUMNS, toOrganizationDto, type OrgRow } from './organizations.mappers.js';
import { sql } from 'kysely';

type OrgListQuery = z.infer<typeof platformOrgListQuerySchema>;
type GrantListQuery = z.infer<typeof accessGrantListQuerySchema>;
const ORG_SORT = { createdAt: 'o.created_at', displayName: 'o.display_name', companyCode: 'o.company_code', status: 'o.status' } as const;
const INVITATION_TTL_DAYS = 14;

/** Platform admin actions are audited with actor type PLATFORM_ADMIN on the target organisation (visible to the tenant) or organisation null. */
async function platformAudit(trx: Trx, actor: Actor, orgId: string | null, action: string, entityType: string, opts: Parameters<typeof audit>[5] = {}): Promise<void> {
  await audit(trx, actor, orgId, action, entityType, { ...opts, actorType: 'PLATFORM_ADMIN' });
}

function toPlatformOrgDto(row: OrgRow & { planKey?: string | null; planName?: string | null; subStatus?: PlatformOrganizationDto['subscription'] extends infer S ? S extends { status: infer T } ? T | null : never : never; trialEndsAt?: Date | null; currentPeriodEnd?: Date | null }, counts?: PlatformOrganizationDto['counts']): PlatformOrganizationDto {
  return {
    ...toOrganizationDto(row),
    legalHold: row.legalHold,
    regionCell: row.regionCell,
    subscription: row.planKey && row.subStatus ? { planKey: row.planKey, planName: row.planName ?? row.planKey, status: row.subStatus, trialEndsAt: isoDateTimeOrNull(row.trialEndsAt), currentPeriodEnd: isoDateTimeOrNull(row.currentPeriodEnd) } : null,
    counts,
    updatedAt: isoDateTime(row.updatedAt),
  };
}

function orgQuery(trx: Trx) {
  return trx.selectFrom('organizations as o').leftJoin('subscriptions as s', 's.organizationId', 'o.id').leftJoin('plans as p', 'p.id', 's.planId');
}
const PLATFORM_ORG_SELECT = [...ORG_COLUMNS.map((c) => `o.${c}` as const), 'p.key as planKey', 'p.name as planName', 's.status as subStatus', 's.trialEndsAt', 's.currentPeriodEnd'] as const;

export async function listOrganizations(deps: ApiDeps, actor: Actor, q: OrgListQuery): Promise<{ data: PlatformOrganizationDto[]; total: number }> {
  requirePlatformAdmin(actor.principal);
  const sort = resolveSort(ORG_SORT, q.sort, q.order, 'o.created_at');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = orgQuery(trx);
    if (q.status) base = base.where('o.status', '=', q.status);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('o.displayName', 'ilike', like), eb('o.legalName', 'ilike', like), eb(sql`o.company_code::text`, 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(PLATFORM_ORG_SELECT).orderBy(sql.raw(sort.column), sort.direction).orderBy('o.id').limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map((r) => toPlatformOrgDto(r as unknown as Parameters<typeof toPlatformOrgDto>[0])), total };
  });
}

export async function getOrganization(deps: ApiDeps, actor: Actor, id: string): Promise<PlatformOrganizationDto> {
  requirePlatformAdmin(actor.principal);
  const row = await runUser(deps.db, actor, async (trx) => orgQuery(trx).select(PLATFORM_ORG_SELECT).where('o.id', '=', id).executeTakeFirst());
  if (!row) throw errors.notFound('Organisation', id);
  const counts = await runSystem(deps.db, id, actor.requestId, async (trx) => ({
    employees: toCount((await trx.selectFrom('employees').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', id).where('deletedAt', 'is', null).executeTakeFirst())?.n),
    devices: toCount((await trx.selectFrom('devices').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', id).where('status', '!=', 'decommissioned').executeTakeFirst())?.n),
    branches: toCount((await trx.selectFrom('branches').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', id).where('status', '!=', 'archived').executeTakeFirst())?.n),
    users: toCount((await trx.selectFrom('orgMemberships').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', id).where('status', '=', 'active').executeTakeFirst())?.n),
  }));
  return toPlatformOrgDto(row as unknown as Parameters<typeof toPlatformOrgDto>[0], counts);
}

export async function createOrganization(deps: ApiDeps, actor: Actor, input: CreateOrganizationInput): Promise<CreateOrganizationResult> {
  requirePlatformAdmin(actor.principal);
  if (!isValidTimezone(input.timezone)) throw errors.validation('Invalid IANA timezone.', { issues: [{ path: 'timezone', message: 'Unknown timezone' }] });
  // Owner lookup and plan validation as the platform admin (read policies allow it)
  const { owner, plan } = await runUser(deps.db, actor, async (trx) => ({
    owner: await trx.selectFrom('userProfiles').select(['id', 'email']).where('email', '=', input.ownerEmail).executeTakeFirst(),
    plan: await trx.selectFrom('plans').select(['id', 'key', 'limits']).where('key', '=', input.planKey).where('isActive', '=', true).executeTakeFirst(),
  }));
  if (!plan) throw errors.validation(`Unknown or inactive plan "${input.planKey}".`, { issues: [{ path: 'planKey', message: 'Unknown plan' }] });
  const orgId = newId();
  // Writes run in the system context of the new organisation (a platform admin holds no tenant permissions without a grant).
  return runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    const clash = await trx.selectFrom('organizations').select('id').where('companyCode', '=', input.companyCode).executeTakeFirst();
    if (clash) throw errors.conflict('An organisation with this company code already exists.');
    const org = await trx.insertInto('organizations').values({
      id: orgId, companyCode: input.companyCode, legalName: input.legalName, displayName: input.displayName, countryCode: input.countryCode, timezone: input.timezone, currencyCode: input.currencyCode,
      locale: input.locale, weeklyOffDays: input.weeklyOffDays, contact: JSON.stringify(input.contact), address: JSON.stringify(input.address), status: input.planKey === 'trial' ? 'trial' : 'active', createdBy: actor.userId,
    }).returning(ORG_COLUMNS).executeTakeFirstOrThrow();
    await trx.insertInto('organizationSettings').values({ organizationId: orgId, updatedBy: actor.userId }).execute();
    const trialDays = 14;
    await trx.insertInto('subscriptions').values({ organizationId: orgId, planId: plan.id, status: input.planKey === 'trial' ? 'trialing' : 'active', trialEndsAt: input.planKey === 'trial' ? new Date(Date.now() + trialDays * 86_400_000) : null }).execute();
    let ownerMembershipId: string | null = null;
    let invitation: CreateOrganizationResult['invitation'] = null;
    if (owner) {
      const m = await trx.insertInto('orgMemberships').values({ organizationId: orgId, userId: owner.id, roleId: SYSTEM_ROLE_IDS.owner, status: 'active', allBranches: true, invitedBy: actor.userId, joinedAt: new Date() }).returning('id').executeTakeFirstOrThrow();
      ownerMembershipId = m.id;
      if (input.ownerFullName) await trx.updateTable('userProfiles').set({ fullName: sql`case when full_name = '' then ${input.ownerFullName} else full_name end` }).where('id', '=', owner.id).execute();
    } else {
      // The auth user does not exist yet: hand out an owner invitation (same token format as member invitations).
      const secret = randomToken(32);
      const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000);
      const inv = await trx.insertInto('invitations').values({ organizationId: orgId, email: input.ownerEmail, roleId: SYSTEM_ROLE_IDS.owner, allBranches: true, branchIds: [], tokenHash: sha256Hex(secret), invitedBy: actor.userId, expiresAt }).returning(['id']).executeTakeFirstOrThrow();
      invitation = { id: inv.id, email: input.ownerEmail, token: `${orgId}.${secret}`, expiresAt: expiresAt.toISOString() };
    }
    await platformAudit(trx, actor, orgId, 'organization.created', 'organization', { entityId: orgId, newValue: { companyCode: input.companyCode, displayName: input.displayName, planKey: input.planKey, ownerEmail: input.ownerEmail, ownerMembershipId, invitationId: invitation?.id ?? null } });
    return { organization: toOrganizationDto(org), ownerMembershipId, invitation };
  });
}

export async function updateOrganizationStatus(deps: ApiDeps, actor: Actor, id: string, input: z.infer<typeof updateOrganizationStatusSchema>): Promise<PlatformOrganizationDto> {
  requirePlatformAdmin(actor.principal);
  await runSystem(deps.db, id, actor.requestId, async (trx) => {
    const before = await trx.selectFrom('organizations').select(['id', 'status']).where('id', '=', id).executeTakeFirst();
    if (!before) throw errors.notFound('Organisation', id);
    if (before.status === input.status) return;
    await trx.updateTable('organizations').set({ status: input.status as OrgStatus }).where('id', '=', id).execute();
    await platformAudit(trx, actor, id, 'organization.status_changed', 'organization', { entityId: id, oldValue: { status: before.status }, newValue: { status: input.status }, reason: input.reason });
  });
  return getOrganization(deps, actor, id);
}

// Access grants ----------------------------------------------------------------------------------
const GRANT_SELECT = ['g.id', 'g.organizationId', 'g.platformAdminUserId', 'g.accessLevel', 'g.reason', 'g.ticketRef', 'g.grantedBy', 'g.approvedBy', 'g.startsAt', 'g.expiresAt', 'g.revokedAt', 'g.createdAt', 'o.displayName as organizationName', 'u.email as platformAdminEmail'] as const;
function toGrantDto(r: { id: string; organizationId: string; platformAdminUserId: string; accessLevel: 'read' | 'write'; reason: string; ticketRef: string | null; grantedBy: string | null; approvedBy: string | null; startsAt: Date; expiresAt: Date; revokedAt: Date | null; createdAt: Date; organizationName: string | null; platformAdminEmail: string | null }): AccessGrantDto {
  const now = Date.now();
  return {
    id: r.id, organizationId: r.organizationId, organizationName: r.organizationName, platformAdminUserId: r.platformAdminUserId, platformAdminEmail: r.platformAdminEmail, accessLevel: r.accessLevel, reason: r.reason, ticketRef: r.ticketRef,
    grantedBy: r.grantedBy, approvedBy: r.approvedBy, startsAt: isoDateTime(r.startsAt), expiresAt: isoDateTime(r.expiresAt), revokedAt: isoDateTimeOrNull(r.revokedAt),
    active: !r.revokedAt && r.startsAt.getTime() <= now && r.expiresAt.getTime() > now, createdAt: isoDateTime(r.createdAt),
  };
}

export async function listGrants(deps: ApiDeps, actor: Actor, q: GrantListQuery): Promise<{ data: AccessGrantDto[]; total: number }> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = trx.selectFrom('platformAccessGrants as g').leftJoin('organizations as o', 'o.id', 'g.organizationId').leftJoin('userProfiles as u', 'u.id', 'g.platformAdminUserId');
    if (q.organizationId) base = base.where('g.organizationId', '=', q.organizationId);
    if (q.activeOnly) base = base.where('g.revokedAt', 'is', null).where('g.expiresAt', '>', new Date());
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(GRANT_SELECT).orderBy('g.createdAt', 'desc').limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map(toGrantDto), total };
  });
}

export async function createGrant(deps: ApiDeps, actor: Actor, input: CreateAccessGrantInput): Promise<AccessGrantDto> {
  requirePlatformAdmin(actor.principal);
  if (input.accessLevel === 'write' && !input.approvedBy) throw errors.validation('Write grants require a second approver (approvedBy).', { issues: [{ path: 'approvedBy', message: 'Required for write access' }] });
  if (input.approvedBy && input.approvedBy === (input.platformAdminUserId ?? actor.userId)) throw errors.validation('The approver must be a different platform administrator.', { issues: [{ path: 'approvedBy', message: 'Must differ from the grantee' }] });
  const adminUserId = input.platformAdminUserId ?? actor.userId;
  const startsAt = new Date();
  const expiresAt = new Date(startsAt.getTime() + input.hours * 3_600_000);
  return runSystem(deps.db, input.organizationId, actor.requestId, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', input.organizationId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', input.organizationId);
    const admin = await trx.selectFrom('platformAdmins').select('userId').where('userId', '=', adminUserId).where('status', '=', 'active').executeTakeFirst();
    if (!admin) throw errors.validation('The grantee is not an active platform administrator.', { issues: [{ path: 'platformAdminUserId', message: 'Not a platform admin' }] });
    if (input.approvedBy) {
      const approver = await trx.selectFrom('platformAdmins').select('userId').where('userId', '=', input.approvedBy).where('status', '=', 'active').executeTakeFirst();
      if (!approver) throw errors.validation('The approver is not an active platform administrator.', { issues: [{ path: 'approvedBy', message: 'Not a platform admin' }] });
    }
    const row = await trx.insertInto('platformAccessGrants').values({ organizationId: input.organizationId, platformAdminUserId: adminUserId, accessLevel: input.accessLevel, reason: input.reason, ticketRef: input.ticketRef ?? null, grantedBy: actor.userId, approvedBy: input.approvedBy ?? null, startsAt, expiresAt }).returning('id').executeTakeFirstOrThrow();
    await platformAudit(trx, actor, input.organizationId, 'platform.access_granted', 'platform_access_grant', { entityId: row.id, newValue: { platformAdminUserId: adminUserId, accessLevel: input.accessLevel, hours: input.hours, ticketRef: input.ticketRef ?? null, approvedBy: input.approvedBy ?? null }, reason: input.reason });
    const full = await trx.selectFrom('platformAccessGrants as g').leftJoin('organizations as o', 'o.id', 'g.organizationId').leftJoin('userProfiles as u', 'u.id', 'g.platformAdminUserId').select(GRANT_SELECT).where('g.id', '=', row.id).executeTakeFirstOrThrow();
    return toGrantDto(full);
  });
}

export async function revokeGrant(deps: ApiDeps, actor: Actor, id: string): Promise<AccessGrantDto> {
  requirePlatformAdmin(actor.principal);
  const grant = await runUser(deps.db, actor, (trx) => trx.selectFrom('platformAccessGrants').select(['id', 'organizationId', 'revokedAt']).where('id', '=', id).executeTakeFirst());
  if (!grant) throw errors.notFound('Access grant', id);
  return runSystem(deps.db, grant.organizationId, actor.requestId, async (trx) => {
    if (!grant.revokedAt) {
      await trx.updateTable('platformAccessGrants').set({ revokedAt: new Date() }).where('id', '=', id).execute();
      await platformAudit(trx, actor, grant.organizationId, 'platform.access_revoked', 'platform_access_grant', { entityId: id });
    }
    const full = await trx.selectFrom('platformAccessGrants as g').leftJoin('organizations as o', 'o.id', 'g.organizationId').leftJoin('userProfiles as u', 'u.id', 'g.platformAdminUserId').select(GRANT_SELECT).where('g.id', '=', id).executeTakeFirstOrThrow();
    return toGrantDto(full);
  });
}

// Plans & feature flags --------------------------------------------------------------------------
export async function listPlans(deps: ApiDeps, actor: Actor): Promise<PlanDto[]> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => (await trx.selectFrom('plans').select(['id', 'key', 'name', 'description', 'prices', 'limits', 'features', 'isActive', 'sortOrder']).orderBy('sortOrder').execute())
    .map((p): PlanDto => ({ id: p.id, key: p.key, name: p.name, description: p.description, prices: jsonObject(p.prices), limits: jsonObject(p.limits), features: p.features, isActive: p.isActive, sortOrder: p.sortOrder })));
}

const toFlagDto = (f: { key: string; description: string; defaultEnabled: boolean; rolloutPercentage: number; updatedAt: Date }): FeatureFlagDto => ({ key: f.key, description: f.description, defaultEnabled: f.defaultEnabled, rolloutPercentage: f.rolloutPercentage, updatedAt: isoDateTime(f.updatedAt) });

export async function listFeatureFlags(deps: ApiDeps, actor: Actor): Promise<FeatureFlagDto[]> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => (await trx.selectFrom('featureFlags').select(['key', 'description', 'defaultEnabled', 'rolloutPercentage', 'updatedAt']).orderBy('key').execute()).map(toFlagDto));
}

export async function putFeatureFlags(deps: ApiDeps, actor: Actor, input: z.infer<typeof putFeatureFlagsSchema>): Promise<FeatureFlagDto[]> {
  requirePlatformAdmin(actor.principal);
  return runSystem(deps.db, PLATFORM_SCOPE_ORG, actor.requestId, async (trx) => {
    const before = new Map((await trx.selectFrom('featureFlags').select(['key', 'description', 'defaultEnabled', 'rolloutPercentage']).execute()).map((f) => [f.key, f]));
    for (const f of input.flags) {
      const prev = before.get(f.key);
      if (!prev && !f.description) throw errors.validation(`New flag "${f.key}" needs a description.`, { issues: [{ path: 'description', message: 'Required for new flags' }] });
      await trx.insertInto('featureFlags').values({ key: f.key, description: f.description ?? prev?.description ?? '', defaultEnabled: f.defaultEnabled ?? prev?.defaultEnabled ?? false, rolloutPercentage: f.rolloutPercentage ?? prev?.rolloutPercentage ?? 0 })
        .onConflict((oc) => oc.column('key').doUpdateSet({ description: f.description ?? prev?.description ?? '', defaultEnabled: f.defaultEnabled ?? prev?.defaultEnabled ?? false, rolloutPercentage: f.rolloutPercentage ?? prev?.rolloutPercentage ?? 0, updatedAt: new Date() })).execute();
      await platformAudit(trx, actor, null, 'platform.feature_flag_updated', 'feature_flag', { entityId: f.key, oldValue: prev ?? null, newValue: f });
    }
    return (await trx.selectFrom('featureFlags').select(['key', 'description', 'defaultEnabled', 'rolloutPercentage', 'updatedAt']).orderBy('key').execute()).map(toFlagDto);
  });
}

async function orgFlags(trx: Trx, orgId: string): Promise<OrgFeatureFlagDto[]> {
  const flags = await trx.selectFrom('featureFlags').select(['key', 'description', 'defaultEnabled']).orderBy('key').execute();
  const overrides = new Map((await trx.selectFrom('organizationFeatureFlags').select(['flagKey', 'enabled']).where('organizationId', '=', orgId).execute()).map((o) => [o.flagKey, o.enabled]));
  return flags.map((f) => { const o = overrides.get(f.key); return { key: f.key, description: f.description, defaultEnabled: f.defaultEnabled, override: o ?? null, effective: o ?? f.defaultEnabled }; });
}

export async function getOrgFeatureFlags(deps: ApiDeps, actor: Actor, orgId: string): Promise<OrgFeatureFlagDto[]> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', orgId);
    return orgFlags(trx, orgId);
  });
}

export async function putOrgFeatureFlags(deps: ApiDeps, actor: Actor, orgId: string, input: z.infer<typeof putOrgFeatureFlagsSchema>): Promise<OrgFeatureFlagDto[]> {
  requirePlatformAdmin(actor.principal);
  return runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', orgId);
    const known = new Set((await trx.selectFrom('featureFlags').select('key').execute()).map((f) => f.key));
    const before = Object.fromEntries((await orgFlags(trx, orgId)).map((f) => [f.key, f.override]));
    for (const [key, enabled] of Object.entries(input.flags)) {
      if (!known.has(key)) throw errors.validation(`Unknown feature flag "${key}".`, { issues: [{ path: `flags.${key}`, message: 'Unknown flag' }] });
      if (enabled === null) await trx.deleteFrom('organizationFeatureFlags').where('organizationId', '=', orgId).where('flagKey', '=', key).execute();
      else await trx.insertInto('organizationFeatureFlags').values({ organizationId: orgId, flagKey: key, enabled, updatedBy: actor.userId }).onConflict((oc) => oc.columns(['organizationId', 'flagKey']).doUpdateSet({ enabled, updatedBy: actor.userId, updatedAt: new Date() })).execute();
    }
    await platformAudit(trx, actor, orgId, 'platform.org_feature_flags_updated', 'organization_feature_flags', { entityId: orgId, oldValue: Object.fromEntries(Object.keys(input.flags).map((k) => [k, before[k] ?? null])), newValue: input.flags });
    return orgFlags(trx, orgId);
  });
}

export async function health(deps: ApiDeps, actor: Actor): Promise<PlatformHealthDto> {
  requirePlatformAdmin(actor.principal);
  const queue = (await deps.queue.stats()).map((s) => ({ queueName: s.queueName, status: s.status, count: s.count, oldestRunAt: isoDateTimeOrNull(s.oldestRunAt) }));
  const { organizations, platformAdmins, activeGrants } = await runUser(deps.db, actor, async (trx) => ({
    organizations: Object.fromEntries((await trx.selectFrom('organizations').select(['status', (eb) => eb.fn.countAll().as('n')]).groupBy('status').execute()).map((r) => [r.status, toCount(r.n)])),
    platformAdmins: toCount((await trx.selectFrom('platformAdmins').select((eb) => eb.fn.countAll().as('n')).where('status', '=', 'active').executeTakeFirst())?.n),
    activeGrants: toCount((await trx.selectFrom('platformAccessGrants').select((eb) => eb.fn.countAll().as('n')).where('revokedAt', 'is', null).where('expiresAt', '>', new Date()).executeTakeFirst())?.n),
  }));
  return { time: new Date().toISOString(), queue, organizations, platformAdmins, activeGrants };
}
