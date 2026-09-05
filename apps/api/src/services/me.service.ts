import type { MeDto, NotificationDto, NotificationListQuery, UpdateMeInput, UserProfileDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { type Actor, runUser, audit } from '../lib/service.js';
import { loadFeatureFlags, parseSettings } from '../lib/settings.js';
import { pageOf, toCount } from '../lib/pagination.js';
import { isoDateTime, isoDateTimeOrNull, jsonObject } from '../lib/mappers.js';
import { ORG_COLUMNS, toOrganizationDto } from './organizations.mappers.js';

/** Create the profile row for a first-time user (id = JWT sub, RLS allows self-insert only). */
export async function ensureProfile(trx: Trx, actor: Actor): Promise<UserProfileDto> {
  const existing = await trx.selectFrom('userProfiles').select(['id', 'email', 'fullName', 'avatarPath', 'locale', 'mfaEnrolled', 'status', 'lastLoginAt']).where('id', '=', actor.userId).executeTakeFirst();
  if (existing) return toProfileDto(existing);
  const email = actor.email || `${actor.userId}@users.flowza.invalid`;
  await trx.insertInto('userProfiles').values({ id: actor.userId, email, fullName: '' }).onConflict((oc) => oc.column('id').doNothing()).execute();
  const created = await trx.selectFrom('userProfiles').select(['id', 'email', 'fullName', 'avatarPath', 'locale', 'mfaEnrolled', 'status', 'lastLoginAt']).where('id', '=', actor.userId).executeTakeFirstOrThrow();
  return toProfileDto(created);
}

function toProfileDto(row: { id: string; email: string; fullName: string; avatarPath: string | null; locale: string; mfaEnrolled: boolean; status: string; lastLoginAt: Date | null }): UserProfileDto {
  return { id: row.id, email: row.email, fullName: row.fullName, avatarPath: row.avatarPath, locale: row.locale, mfaEnrolled: row.mfaEnrolled, status: row.status, lastLoginAt: isoDateTimeOrNull(row.lastLoginAt) };
}

export async function getMe(deps: ApiDeps, actor: Actor): Promise<MeDto> {
  return runUser(deps.db, actor, async (trx) => {
    const profile = await ensureProfile(trx, actor);
    const orgIds = [...new Set(actor.principal.memberships.map((m) => m.organizationId))];
    const orgs = orgIds.length ? await trx.selectFrom('organizations').select(ORG_COLUMNS).where('id', 'in', orgIds).execute() : [];
    const settings = orgIds.length ? await trx.selectFrom('organizationSettings').select(['organizationId', 'general', 'attendance', 'sync', 'notifications', 'security', 'integrations']).where('organizationId', 'in', orgIds).execute() : [];
    const roleIds = [...new Set(actor.principal.memberships.map((m) => m.roleId).filter((r) => /^[0-9a-f-]{36}$/i.test(r)))];
    const roles = roleIds.length ? await trx.selectFrom('roles').select(['id', 'name']).where('id', 'in', roleIds).execute() : [];
    const flags = await loadFeatureFlags(trx, orgIds);
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const settingsById = new Map(settings.map((s) => [s.organizationId, s]));
    const roleName = new Map(roles.map((r) => [r.id, r.name]));
    const memberships: MeDto['memberships'] = [];
    for (const m of actor.principal.memberships) {
      const org = orgById.get(m.organizationId);
      if (!org) continue; // suspended/closed organisations may be hidden by RLS
      memberships.push({
        membershipId: m.membershipId,
        organization: toOrganizationDto(org),
        roleId: m.roleId,
        roleKey: m.roleKey,
        roleName: roleName.get(m.roleId) ?? (m.roleKey.startsWith('platform_grant') ? 'Platform support access' : m.roleKey),
        permissions: m.permissions,
        allBranches: m.allBranches,
        branchIds: m.branchIds,
        employeeId: m.employeeId,
        featureFlags: flags.get(m.organizationId) ?? {},
        settings: parseSettings(settingsById.get(m.organizationId)),
      });
    }
    return {
      user: { id: profile.id, email: profile.email, fullName: profile.fullName, avatarUrl: profile.avatarPath, locale: profile.locale, mfaEnrolled: profile.mfaEnrolled, isPlatformAdmin: actor.principal.isPlatformAdmin },
      memberships,
    };
  });
}

export async function updateMe(deps: ApiDeps, actor: Actor, input: UpdateMeInput): Promise<UserProfileDto> {
  return runUser(deps.db, actor, async (trx) => {
    const before = await ensureProfile(trx, actor);
    const patch: { fullName?: string; locale?: string } = {};
    if (input.fullName !== undefined) patch.fullName = input.fullName;
    if (input.locale !== undefined) patch.locale = input.locale;
    if (Object.keys(patch).length > 0) await trx.updateTable('userProfiles').set(patch).where('id', '=', actor.userId).execute();
    const after = await ensureProfile(trx, actor);
    for (const m of actor.principal.memberships) {
      if (!/^[0-9a-f-]{36}$/i.test(m.membershipId)) continue;
      await audit(trx, actor, m.organizationId, 'user.profile_updated', 'user_profile', { entityId: actor.userId, oldValue: { fullName: before.fullName, locale: before.locale }, newValue: patch });
      break; // one row is enough for traceability; the profile is not org-scoped
    }
    return after;
  });
}

function toNotificationDto(n: { id: string; organizationId: string | null; category: NotificationDto['category']; type: string; title: string; body: string | null; data: unknown; link: string | null; readAt: Date | null; createdAt: Date }): NotificationDto {
  return { id: n.id, organizationId: n.organizationId, category: n.category, type: n.type, title: n.title, body: n.body, data: jsonObject(n.data), link: n.link, readAt: isoDateTimeOrNull(n.readAt), createdAt: isoDateTime(n.createdAt) };
}

export async function listNotifications(deps: ApiDeps, actor: Actor, q: NotificationListQuery): Promise<{ data: NotificationDto[]; total: number }> {
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = trx.selectFrom('notifications').where('userId', '=', actor.userId);
    if (q.unreadOnly) base = base.where('readAt', 'is', null);
    if (q.category) base = base.where('category', '=', q.category);
    if (q.organizationId) base = base.where('organizationId', '=', q.organizationId);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(['id', 'organizationId', 'category', 'type', 'title', 'body', 'data', 'link', 'readAt', 'createdAt']).orderBy('createdAt', 'desc').limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map(toNotificationDto), total };
  });
}

export async function unreadCount(deps: ApiDeps, actor: Actor): Promise<number> {
  return runUser(deps.db, actor, async (trx) => toCount((await trx.selectFrom('notifications').select((eb) => eb.fn.countAll().as('n')).where('userId', '=', actor.userId).where('readAt', 'is', null).executeTakeFirst())?.n));
}

export async function markRead(deps: ApiDeps, actor: Actor, id: string): Promise<NotificationDto> {
  return runUser(deps.db, actor, async (trx) => {
    const res = await trx.updateTable('notifications').set({ readAt: new Date() }).where('id', '=', id).where('userId', '=', actor.userId).where('readAt', 'is', null).executeTakeFirst();
    void res;
    const row = await trx.selectFrom('notifications').select(['id', 'organizationId', 'category', 'type', 'title', 'body', 'data', 'link', 'readAt', 'createdAt']).where('id', '=', id).where('userId', '=', actor.userId).executeTakeFirst();
    if (!row) throw errors.notFound('Notification', id);
    return toNotificationDto(row);
  });
}

export async function markAllRead(deps: ApiDeps, actor: Actor): Promise<{ updated: number }> {
  return runUser(deps.db, actor, async (trx) => {
    const res = await trx.updateTable('notifications').set({ readAt: new Date() }).where('userId', '=', actor.userId).where('readAt', 'is', null).executeTakeFirst();
    return { updated: Number(res.numUpdatedRows) };
  });
}
