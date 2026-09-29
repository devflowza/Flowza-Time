/**
 * Super-admin portal (/adm): the platform console's dashboard, tenant management beyond status and flags (details,
 * subscription, members, internal notes, account manager), the users directory, the platform administrator team and
 * the platform activity log.
 *
 * Every handler starts with `requirePlatformAdmin` (the route authorisation matrix proves a tenant owner is refused).
 * A platform admin holds no tenant permission without an access grant (docs/go-live.md §6), so:
 *  - reads use the caller's own session (platform-admin read policies) or the counts / directory functions of migration
 *    20260929000400 (`app.platform_org_counts`, `app.platform_memberships`) — counts and directory data, never a tenant's
 *    employee or attendance rows;
 *  - writes run in the target organisation's system context after the check and are audited as PLATFORM_ADMIN on that
 *    organisation, so the tenant sees what the platform changed;
 *  - team management (adding admins, changing levels) is reserved to `owner`-level administrators, and nobody can lock
 *    themselves out or remove the last active owner.
 */
import { type z } from 'zod';
import { sql } from 'kysely';
import type {
  CreatePlatformAdminInput, CreateTenantNoteInput, PlatformAdminDto, PlatformAdminLevel, PlatformAuditEntryDto, PlatformMembershipDto,
  PlatformOrgMembersDto, PlatformOverviewDto, PlatformSubscriptionDto, PlatformUserDetailDto, PlatformUserDto, PutTenantAccountInput,
  SubscriptionStatus, TenantAccountDto, TenantNoteDto, UpdateOrganizationInput, UpdatePlatformAdminInput, UpdateSubscriptionInput,
  platformActivityQuerySchema, platformUserListQuerySchema, PlatformOrganizationDto,
} from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors, isValidTimezone } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requirePlatformAdmin } from '../lib/authorize.js';
import { type Actor, runUser, runSystem, audit, diffObjects, PLATFORM_SCOPE_ORG } from '../lib/service.js';
import { likeContains, pageOf, toCount } from '../lib/pagination.js';
import { isoDateTime, isoDateTimeOrNull } from '../lib/mappers.js';
import { ORG_COLUMNS, toOrganizationDto } from './organizations.mappers.js';
import { getOrganization, orgCounts } from './platform.service.js';

type ActivityQuery = z.infer<typeof platformActivityQuerySchema>;
type UserListQuery = z.infer<typeof platformUserListQuerySchema>;

const platformAudit = (trx: Trx, actor: Actor, orgId: string | null, action: string, entityType: string, opts: Parameters<typeof audit>[5] = {}) =>
  audit(trx, actor, orgId, action, entityType, { ...opts, actorType: 'PLATFORM_ADMIN' });

const TRIAL_SOON_DAYS = 14;

// Overview ---------------------------------------------------------------------------------------------------------------

export async function overview(deps: ApiDeps, actor: Actor): Promise<PlatformOverviewDto> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const now = new Date();
    const byStatus = Object.fromEntries((await trx.selectFrom('organizations').select(['status', (eb) => eb.fn.countAll().as('n')]).groupBy('status').execute()).map((r) => [r.status, toCount(r.n)]));
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const newLast30Days = toCount((await trx.selectFrom('organizations').select((eb) => eb.fn.countAll().as('n')).where('createdAt', '>=', new Date(now.getTime() - 30 * 86_400_000)).executeTakeFirst())?.n);
    const subsByStatus = Object.fromEntries((await trx.selectFrom('subscriptions').select(['status', (eb) => eb.fn.countAll().as('n')]).groupBy('status').execute()).map((r) => [r.status, toCount(r.n)]));
    const byPlan = (await trx.selectFrom('subscriptions as s').innerJoin('plans as p', 'p.id', 's.planId')
      .select(['p.key as planKey', 'p.name as planName', (eb) => eb.fn.countAll().as('n')]).groupBy(['p.key', 'p.name', 'p.sortOrder']).orderBy('p.sortOrder').execute())
      .map((r) => ({ planKey: r.planKey, planName: r.planName, count: toCount(r.n) }));
    const counts = [...(await orgCounts(trx, null)).values()];
    const sum = (k: 'employees' | 'devices' | 'branches' | 'users') => counts.reduce((a, c) => a + c[k], 0);
    const users = toCount((await trx.selectFrom('userProfiles').select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const platformAdmins = toCount((await trx.selectFrom('platformAdmins').select((eb) => eb.fn.countAll().as('n')).where('status', '=', 'active').executeTakeFirst())?.n);
    const activeGrants = toCount((await trx.selectFrom('platformAccessGrants').select((eb) => eb.fn.countAll().as('n')).where('revokedAt', 'is', null).where('startsAt', '<=', now).where('expiresAt', '>', now).executeTakeFirst())?.n);
    const pendingGrants = toCount((await trx.selectFrom('platformAccessGrants').select((eb) => eb.fn.countAll().as('n'))
      .where('accessLevel', '=', 'write').where('approvedAt', 'is', null).where('revokedAt', 'is', null).where('createdAt', '>', new Date(now.getTime() - 24 * 3_600_000)).executeTakeFirst())?.n);
    const trialsEndingSoon = (await trx.selectFrom('subscriptions as s').innerJoin('organizations as o', 'o.id', 's.organizationId')
      .select(['o.id', 'o.displayName', 'o.companyCode', 's.trialEndsAt'])
      .where('s.status', '=', 'trialing').where('s.trialEndsAt', 'is not', null).where('s.trialEndsAt', '<=', new Date(now.getTime() + TRIAL_SOON_DAYS * 86_400_000))
      .orderBy('s.trialEndsAt').limit(10).execute())
      .map((r) => ({ id: r.id, displayName: r.displayName, companyCode: String(r.companyCode), trialEndsAt: isoDateTime(r.trialEndsAt!) }));
    const recentOrganizations = (await trx.selectFrom('organizations as o').leftJoin('subscriptions as s', 's.organizationId', 'o.id').leftJoin('plans as p', 'p.id', 's.planId')
      .select(['o.id', 'o.displayName', 'o.companyCode', 'o.status', 'o.createdAt', 'p.name as planName']).orderBy('o.createdAt', 'desc').limit(6).execute())
      .map((r) => ({ id: r.id, displayName: r.displayName, companyCode: String(r.companyCode), status: r.status, planName: r.planName ?? null, createdAt: isoDateTime(r.createdAt) }));
    const recentActivity = await activityRows(trx, { page: 1, pageSize: 8, order: 'desc' });
    return {
      time: now.toISOString(),
      organizations: { total, byStatus, newLast30Days },
      subscriptions: { byStatus: subsByStatus, byPlan },
      totals: { users, employees: sum('employees'), devices: sum('devices'), branches: sum('branches'), memberships: sum('users') },
      platformAdmins, activeGrants, pendingGrants, trialsEndingSoon, recentOrganizations, recentActivity: recentActivity.data,
    };
  });
}

// Tenant details & subscription --------------------------------------------------------------------------------------------

/** PATCH /platform/orgs/:id — the tenant's profile (names, locale, contact, address), audited as a platform change. */
export async function updateOrganizationDetails(deps: ApiDeps, actor: Actor, orgId: string, input: UpdateOrganizationInput): Promise<PlatformOrganizationDto> {
  requirePlatformAdmin(actor.principal);
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) throw errors.validation('Invalid IANA timezone.', { issues: [{ path: 'timezone', message: 'Unknown timezone' }] });
  await runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    const before = await trx.selectFrom('organizations').select(ORG_COLUMNS).where('id', '=', orgId).executeTakeFirst();
    if (!before) throw errors.notFound('Organisation', orgId);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = k === 'contact' || k === 'address' ? JSON.stringify(v) : v;
    if (Object.keys(patch).length === 0) return;
    await trx.updateTable('organizations').set(patch).where('id', '=', orgId).execute();
    const after = await trx.selectFrom('organizations').select(ORG_COLUMNS).where('id', '=', orgId).executeTakeFirstOrThrow();
    const diff = diffObjects(toOrganizationDto(before) as unknown as Record<string, unknown>, toOrganizationDto(after) as unknown as Record<string, unknown>);
    await platformAudit(trx, actor, orgId, 'organization.updated', 'organization', { entityId: orgId, ...diff });
  });
  return getOrganization(deps, actor, orgId);
}

async function loadSubscription(trx: Trx, orgId: string): Promise<PlatformSubscriptionDto | null> {
  const s = await trx.selectFrom('subscriptions as s').innerJoin('plans as p', 'p.id', 's.planId')
    .select(['p.key as planKey', 'p.name as planName', 's.status', 's.trialEndsAt', 's.currentPeriodStart', 's.currentPeriodEnd', 's.cancelAt', 's.updatedAt'])
    .where('s.organizationId', '=', orgId).executeTakeFirst();
  if (!s) return null;
  return {
    planKey: s.planKey, planName: s.planName, status: s.status, trialEndsAt: isoDateTimeOrNull(s.trialEndsAt), currentPeriodStart: isoDateTimeOrNull(s.currentPeriodStart),
    currentPeriodEnd: isoDateTimeOrNull(s.currentPeriodEnd), cancelAt: isoDateTimeOrNull(s.cancelAt), updatedAt: isoDateTimeOrNull(s.updatedAt),
  };
}

export async function getSubscription(deps: ApiDeps, actor: Actor, orgId: string): Promise<PlatformSubscriptionDto | null> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', orgId);
    return loadSubscription(trx, orgId);
  });
}

/** PATCH /platform/orgs/:id/subscription — plan change, status, trial / period dates. A tenant without one gets one (needs a plan). */
export async function updateSubscription(deps: ApiDeps, actor: Actor, orgId: string, input: UpdateSubscriptionInput): Promise<PlatformSubscriptionDto> {
  requirePlatformAdmin(actor.principal);
  const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));
  return runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', orgId);
    let planId: string | undefined;
    if (input.planKey !== undefined) {
      const plan = await trx.selectFrom('plans').select(['id', 'isActive']).where('key', '=', input.planKey).executeTakeFirst();
      if (!plan || !plan.isActive) throw errors.validation(`Unknown or inactive plan "${input.planKey}".`, { issues: [{ path: 'planKey', message: 'Unknown plan' }] });
      planId = plan.id;
    }
    const before = await loadSubscription(trx, orgId);
    const patch: { planId?: string; status?: SubscriptionStatus; trialEndsAt?: Date | null; currentPeriodEnd?: Date | null; cancelAt?: Date | null } = {};
    if (planId) patch.planId = planId;
    if (input.status) patch.status = input.status;
    const trialEndsAt = toDate(input.trialEndsAt); if (trialEndsAt !== undefined) patch.trialEndsAt = trialEndsAt;
    const periodEnd = toDate(input.currentPeriodEnd); if (periodEnd !== undefined) patch.currentPeriodEnd = periodEnd;
    const cancelAt = toDate(input.cancelAt); if (cancelAt !== undefined) patch.cancelAt = cancelAt;
    if (before) {
      await trx.updateTable('subscriptions').set(patch).where('organizationId', '=', orgId).execute();
    } else {
      if (!planId) throw errors.validation('This organisation has no subscription yet: choose a plan.', { issues: [{ path: 'planKey', message: 'Required' }] });
      await trx.insertInto('subscriptions').values({ organizationId: orgId, planId, status: patch.status ?? 'active', trialEndsAt: patch.trialEndsAt ?? null, currentPeriodEnd: patch.currentPeriodEnd ?? null, cancelAt: patch.cancelAt ?? null }).execute();
    }
    const after = (await loadSubscription(trx, orgId))!;
    const diff = diffObjects((before ?? {}) as Record<string, unknown>, after as unknown as Record<string, unknown>);
    await platformAudit(trx, actor, orgId, 'organization.subscription_changed', 'subscription', { entityId: orgId, ...diff, reason: input.reason });
    return after;
  });
}

// Members --------------------------------------------------------------------------------------------------------------------

interface MembershipRow {
  membershipId: string; organizationId: string; organizationName: string; companyCode: string; organizationStatus: PlatformMembershipDto['organizationStatus'];
  userId: string; email: string; fullName: string; roleId: string; roleKey: string; roleName: string; status: string;
  joinedAt: Date | null; createdAt: Date; lastLoginAt: Date | null; mfaEnrolled: boolean;
}
async function memberships(trx: Trx, userIds: string[] | null, orgId: string | null): Promise<PlatformMembershipDto[]> {
  const { rows } = await sql<MembershipRow>`
    select membership_id as "membershipId", organization_id as "organizationId", organization_name as "organizationName", company_code as "companyCode",
           organization_status as "organizationStatus", user_id as "userId", email, full_name as "fullName", role_id as "roleId", role_key as "roleKey",
           role_name as "roleName", status, joined_at as "joinedAt", created_at as "createdAt", last_login_at as "lastLoginAt", mfa_enrolled as "mfaEnrolled"
    from app.platform_memberships(${userIds ? sql`${userIds}::uuid[]` : sql`null`}, ${orgId ? sql`${orgId}::uuid` : sql`null`})`.execute(trx);
  return rows.map((r) => ({
    membershipId: r.membershipId, organizationId: r.organizationId, organizationName: r.organizationName, companyCode: r.companyCode, organizationStatus: r.organizationStatus,
    userId: r.userId, email: r.email, fullName: r.fullName, roleKey: r.roleKey, roleName: r.roleName, status: r.status,
    joinedAt: isoDateTimeOrNull(r.joinedAt), lastLoginAt: isoDateTimeOrNull(r.lastLoginAt), mfaEnrolled: r.mfaEnrolled,
  }));
}

export async function listOrganizationMembers(deps: ApiDeps, actor: Actor, orgId: string): Promise<PlatformOrgMembersDto> {
  requirePlatformAdmin(actor.principal);
  const members = await runUser(deps.db, actor, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', orgId);
    return memberships(trx, null, orgId);
  });
  // pending invitations are read in the organisation's system context (the platform admin is not a member)
  const invitations = await runSystem(deps.db, orgId, actor.requestId, async (trx) => (await trx.selectFrom('invitations as i').innerJoin('roles as r', 'r.id', 'i.roleId')
    .select(['i.id', 'i.email', 'r.name as roleName', 'i.expiresAt', 'i.createdAt'])
    .where('i.organizationId', '=', orgId).where('i.acceptedAt', 'is', null).where('i.revokedAt', 'is', null).orderBy('i.createdAt', 'desc').limit(100).execute())
    .map((i) => ({ id: i.id, email: String(i.email), roleName: i.roleName, expiresAt: isoDateTime(i.expiresAt), createdAt: isoDateTime(i.createdAt), expired: i.expiresAt.getTime() <= Date.now() })));
  return { members, invitations };
}

// Account management & notes ------------------------------------------------------------------------------------------------

async function loadAccount(trx: Trx, orgId: string): Promise<TenantAccountDto> {
  const a = await trx.selectFrom('platformTenantAccounts as a').leftJoin('userProfiles as u', 'u.id', 'a.accountManagerUserId')
    .select(['a.accountManagerUserId', 'a.tags', 'a.updatedAt', 'u.email', 'u.fullName']).where('a.organizationId', '=', orgId).executeTakeFirst();
  return {
    organizationId: orgId,
    accountManager: a?.accountManagerUserId ? { userId: a.accountManagerUserId, email: String(a.email ?? ''), fullName: a.fullName ?? '' } : null,
    tags: a?.tags ?? [],
    updatedAt: isoDateTimeOrNull(a?.updatedAt ?? null),
  };
}

export async function getTenantAccount(deps: ApiDeps, actor: Actor, orgId: string): Promise<TenantAccountDto> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', orgId);
    return loadAccount(trx, orgId);
  });
}

export async function putTenantAccount(deps: ApiDeps, actor: Actor, orgId: string, input: PutTenantAccountInput): Promise<TenantAccountDto> {
  requirePlatformAdmin(actor.principal);
  const before = await getTenantAccount(deps, actor, orgId);
  if (input.accountManagerUserId) {
    const manager = await runUser(deps.db, actor, (trx) => trx.selectFrom('platformAdmins').select('userId').where('userId', '=', input.accountManagerUserId!).where('status', '=', 'active').executeTakeFirst());
    if (!manager) throw errors.validation('The account manager must be an active platform administrator.', { issues: [{ path: 'accountManagerUserId', message: 'Not a platform admin' }] });
  }
  const tags = input.tags ? [...new Set(input.tags)] : undefined;
  await runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    const values = {
      organizationId: orgId,
      accountManagerUserId: input.accountManagerUserId !== undefined ? input.accountManagerUserId : before.accountManager?.userId ?? null,
      tags: tags ?? before.tags,
      updatedBy: actor.userId,
    };
    await trx.insertInto('platformTenantAccounts').values(values)
      .onConflict((oc) => oc.column('organizationId').doUpdateSet({ accountManagerUserId: values.accountManagerUserId, tags: values.tags, updatedBy: actor.userId })).execute();
    await platformAudit(trx, actor, orgId, 'platform.tenant_account_updated', 'platform_tenant_account', {
      entityId: orgId,
      oldValue: { accountManagerUserId: before.accountManager?.userId ?? null, tags: before.tags },
      newValue: { accountManagerUserId: values.accountManagerUserId, tags: values.tags },
    });
  });
  return getTenantAccount(deps, actor, orgId);
}

const toNoteDto = (n: { id: string; organizationId: string; authorUserId: string; authorLabel: string | null; body: string; createdAt: Date }): TenantNoteDto =>
  ({ id: n.id, organizationId: n.organizationId, authorUserId: n.authorUserId, authorLabel: n.authorLabel, body: n.body, createdAt: isoDateTime(n.createdAt) });

export async function listTenantNotes(deps: ApiDeps, actor: Actor, orgId: string): Promise<TenantNoteDto[]> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', orgId);
    return (await trx.selectFrom('platformTenantNotes').select(['id', 'organizationId', 'authorUserId', 'authorLabel', 'body', 'createdAt'])
      .where('organizationId', '=', orgId).orderBy('createdAt', 'desc').limit(200).execute()).map(toNoteDto);
  });
}

export async function addTenantNote(deps: ApiDeps, actor: Actor, orgId: string, input: CreateTenantNoteInput): Promise<TenantNoteDto> {
  requirePlatformAdmin(actor.principal);
  return runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', orgId);
    const note = await trx.insertInto('platformTenantNotes').values({ organizationId: orgId, authorUserId: actor.userId, authorLabel: actor.email || null, body: input.body })
      .returning(['id', 'organizationId', 'authorUserId', 'authorLabel', 'body', 'createdAt']).executeTakeFirstOrThrow();
    // the body stays in the platform table: the tenant's audit trail records that a note exists, not what it says
    await platformAudit(trx, actor, orgId, 'platform.tenant_note_added', 'platform_tenant_note', { entityId: note.id });
    return toNoteDto(note);
  });
}

// Activity ---------------------------------------------------------------------------------------------------------------------

async function activityRows(trx: Trx, q: Partial<ActivityQuery> & { page: number; pageSize: number }): Promise<{ data: PlatformAuditEntryDto[]; total: number }> {
  let base = trx.selectFrom('audit.logs as a').leftJoin('organizations as o', 'o.id', 'a.organizationId').where('a.actorType', '=', 'PLATFORM_ADMIN');
  if (q.organizationId) base = base.where('a.organizationId', '=', q.organizationId);
  if (q.actorUserId) base = base.where('a.actorUserId', '=', q.actorUserId);
  if (q.action) base = base.where('a.action', 'ilike', likeContains(q.action));
  if (q.from) base = base.where('a.createdAt', '>=', new Date(q.from));
  if (q.to) base = base.where('a.createdAt', '<', new Date(q.to));
  const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
  const page = pageOf(q);
  const rows = await base.select(['a.id', 'a.organizationId', 'o.displayName as organizationName', 'a.actorUserId', 'a.actorLabel', 'a.action', 'a.entityType', 'a.entityId', 'a.oldValue', 'a.newValue', 'a.reason', 'a.createdAt'])
    .orderBy('a.createdAt', q.order === 'asc' ? 'asc' : 'desc').orderBy('a.id', 'desc').limit(page.pageSize).offset(page.offset).execute();
  return {
    data: rows.map((r) => ({
      id: String(r.id), organizationId: r.organizationId, organizationName: r.organizationName ?? null, actorUserId: r.actorUserId, actorLabel: r.actorLabel,
      action: r.action, entityType: r.entityType, entityId: r.entityId, oldValue: r.oldValue ?? null, newValue: r.newValue ?? null, reason: r.reason, createdAt: isoDateTime(r.createdAt),
    })),
    total,
  };
}

/** GET /platform/activity — what platform administrators did, across organisations (newest first by default). */
export async function listActivity(deps: ApiDeps, actor: Actor, q: ActivityQuery): Promise<{ data: PlatformAuditEntryDto[]; total: number }> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, (trx) => activityRows(trx, { ...q, order: q.sort ? q.order : 'desc' }));
}

// Users directory ------------------------------------------------------------------------------------------------------------

export async function listUsers(deps: ApiDeps, actor: Actor, q: UserListQuery): Promise<{ data: PlatformUserDto[]; total: number }> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('userProfiles as u').leftJoin('platformAdmins as pa', 'pa.userId', 'u.id');
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb(sql`u.email::text`, 'ilike', like), eb('u.fullName', 'ilike', like)])); }
    if (q.platformAdmin === true) base = base.where('pa.userId', 'is not', null);
    if (q.platformAdmin === false) base = base.where('pa.userId', 'is', null);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const sortColumn = q.sort === 'email' ? 'u.email' : q.sort === 'lastLoginAt' ? 'u.lastLoginAt' : 'u.createdAt';
    const order = q.sort ? q.order : 'desc';
    const rows = await base.select(['u.id', 'u.email', 'u.fullName', 'u.status', 'u.mfaEnrolled', 'u.lastLoginAt', 'u.createdAt', 'pa.level as adminLevel', 'pa.status as adminStatus'])
      .orderBy(sortColumn, order).orderBy('u.id').limit(page.pageSize).offset(page.offset).execute();
    const counts = new Map<string, number>();
    if (rows.length) for (const m of await memberships(trx, rows.map((r) => r.id), null)) counts.set(m.userId, (counts.get(m.userId) ?? 0) + (m.status === 'active' ? 1 : 0));
    return { data: rows.map((r) => toUserDto(r, counts.get(r.id) ?? 0)), total };
  });
}

function toUserDto(r: { id: string; email: string; fullName: string; status: string; mfaEnrolled: boolean; lastLoginAt: Date | null; createdAt: Date; adminLevel: PlatformAdminLevel | null; adminStatus: string | null }, membershipCount: number): PlatformUserDto {
  return {
    id: r.id, email: String(r.email), fullName: r.fullName, status: r.status, mfaEnrolled: r.mfaEnrolled, lastLoginAt: isoDateTimeOrNull(r.lastLoginAt), createdAt: isoDateTime(r.createdAt),
    platformAdminLevel: r.adminLevel ?? null, platformAdminStatus: r.adminStatus ?? null, membershipCount,
  };
}

export async function getUser(deps: ApiDeps, actor: Actor, userId: string): Promise<PlatformUserDetailDto> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const r = await trx.selectFrom('userProfiles as u').leftJoin('platformAdmins as pa', 'pa.userId', 'u.id')
      .select(['u.id', 'u.email', 'u.fullName', 'u.status', 'u.mfaEnrolled', 'u.lastLoginAt', 'u.createdAt', 'pa.level as adminLevel', 'pa.status as adminStatus'])
      .where('u.id', '=', userId).executeTakeFirst();
    if (!r) throw errors.notFound('User', userId);
    const ms = await memberships(trx, [userId], null);
    return { ...toUserDto(r, ms.filter((m) => m.status === 'active').length), memberships: ms };
  });
}

// Platform administrator team ------------------------------------------------------------------------------------------------

async function listAdminRows(trx: Trx, viewerId: string): Promise<PlatformAdminDto[]> {
  const rows = await trx.selectFrom('platformAdmins as a').innerJoin('userProfiles as u', 'u.id', 'a.userId').leftJoin('userProfiles as g', 'g.id', 'a.grantedBy')
    .select(['a.userId', 'u.email', 'u.fullName', 'a.level', 'a.status', 'u.mfaEnrolled', 'u.lastLoginAt', 'g.email as grantedByEmail', 'a.createdAt'])
    .orderBy('a.createdAt').execute();
  return rows.map((r) => ({
    userId: r.userId, email: String(r.email), fullName: r.fullName, level: r.level, status: r.status as 'active' | 'disabled', mfaEnrolled: r.mfaEnrolled,
    lastLoginAt: isoDateTimeOrNull(r.lastLoginAt), grantedByEmail: r.grantedByEmail ? String(r.grantedByEmail) : null, createdAt: isoDateTime(r.createdAt), isSelf: r.userId === viewerId,
  }));
}

export async function listAdmins(deps: ApiDeps, actor: Actor): Promise<PlatformAdminDto[]> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, (trx) => listAdminRows(trx, actor.userId));
}

async function requireOwnerLevel(trx: Trx, actor: Actor): Promise<void> {
  const me = await trx.selectFrom('platformAdmins').select(['level', 'status']).where('userId', '=', actor.userId).executeTakeFirst();
  if (!me || me.status !== 'active' || me.level !== 'owner') throw errors.forbidden('Only a platform owner can manage the platform administrator team.');
}

/** POST /platform/admins — make an existing FlowZa Time account a platform administrator (owner-level callers only). */
export async function addAdmin(deps: ApiDeps, actor: Actor, input: CreatePlatformAdminInput): Promise<PlatformAdminDto> {
  requirePlatformAdmin(actor.principal);
  const target = await runUser(deps.db, actor, async (trx) => {
    await requireOwnerLevel(trx, actor);
    const profile = await trx.selectFrom('userProfiles').select(['id', 'email', 'status']).where(sql`lower(email::text)`, '=', input.email.toLowerCase()).executeTakeFirst();
    if (!profile) throw errors.validation('No FlowZa Time account uses this e-mail. The person must sign up (or accept an invitation) once before they can be made an administrator.', { issues: [{ path: 'email', message: 'No account' }] });
    if (profile.status !== 'active') throw errors.invalidState('This account is disabled.');
    const existing = await trx.selectFrom('platformAdmins').select(['level', 'status']).where('userId', '=', profile.id).executeTakeFirst();
    if (existing?.status === 'active') throw errors.conflict('This person is already a platform administrator.');
    return { id: profile.id, existing };
  });
  await runSystem(deps.db, PLATFORM_SCOPE_ORG, actor.requestId, async (trx) => {
    await trx.insertInto('platformAdmins').values({ userId: target.id, level: input.level, status: 'active', grantedBy: actor.userId })
      .onConflict((oc) => oc.column('userId').doUpdateSet({ level: input.level, status: 'active', grantedBy: actor.userId })).execute();
    await platformAudit(trx, actor, null, 'platform.admin_added', 'platform_admin', { entityId: target.id, oldValue: target.existing ?? null, newValue: { email: input.email, level: input.level, status: 'active' } });
  });
  const all = await listAdmins(deps, actor);
  return all.find((a) => a.userId === target.id)!;
}

/** PATCH /platform/admins/:userId — level or status (owner-level callers only; never oneself, never the last active owner). */
export async function updateAdmin(deps: ApiDeps, actor: Actor, userId: string, input: UpdatePlatformAdminInput): Promise<PlatformAdminDto> {
  requirePlatformAdmin(actor.principal);
  const before = await runUser(deps.db, actor, async (trx) => {
    await requireOwnerLevel(trx, actor);
    const row = await trx.selectFrom('platformAdmins').select(['level', 'status']).where('userId', '=', userId).executeTakeFirst();
    if (!row) throw errors.notFound('Platform administrator', userId);
    return row;
  });
  if (userId === actor.userId) throw errors.invalidState('You cannot change your own level or status. Ask another platform owner.');
  const nextLevel = input.level ?? before.level;
  const nextStatus = input.status ?? before.status;
  await runSystem(deps.db, PLATFORM_SCOPE_ORG, actor.requestId, async (trx) => {
    if (before.level === 'owner' && before.status === 'active' && (nextLevel !== 'owner' || nextStatus !== 'active')) {
      const owners = toCount((await trx.selectFrom('platformAdmins').select((eb) => eb.fn.countAll().as('n')).where('level', '=', 'owner').where('status', '=', 'active').executeTakeFirst())?.n);
      if (owners <= 1) throw errors.invalidState('The last active platform owner cannot be demoted or disabled.');
    }
    await trx.updateTable('platformAdmins').set({ level: nextLevel, status: nextStatus }).where('userId', '=', userId).execute();
    await platformAudit(trx, actor, null, 'platform.admin_updated', 'platform_admin', { entityId: userId, oldValue: before, newValue: { level: nextLevel, status: nextStatus } });
  });
  const all = await listAdmins(deps, actor);
  return all.find((a) => a.userId === userId)!;
}
