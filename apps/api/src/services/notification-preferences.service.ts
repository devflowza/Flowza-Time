import {
  NOTIFICATION_CATEGORY_AUDIENCE, NOTIFICATION_CATEGORY_ORDER, NOTIFICATION_LOCALES, notificationPreferenceCells,
  type NotificationCategory, type NotificationDeliveryChannel, type NotificationLocale, type NotificationPreferencesDto, type UpdateNotificationPreferencesInput,
} from '@flowza/contracts';
import type { MembershipGrant } from '@flowza/domain';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { hasPermission, requireMembership } from '../lib/authorize.js';
import { type Actor, audit, runUser } from '../lib/service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The member's own notification preferences (HR portal Prompt 8): a (category × channel) matrix per organisation, derived
 * from the notification catalogue. Only the caller's own rows are ever read or written (the service keys every statement on
 * the caller; RLS `notification_preferences_self_*` enforces it again and refuses an organisation the caller is not an
 * active member of). A platform support grant is not a membership: it keeps no preferences.
 */
function memberOf(actor: Actor, orgId: string): MembershipGrant {
  const m = requireMembership(actor.principal, orgId);
  if (!UUID_RE.test(m.membershipId)) throw errors.forbidden('Notification preferences are kept for members of the organisation.');
  return m;
}

/** The category can reach the member (their permissions); the profile shows these rows only. */
function relevantFor(m: MembershipGrant, category: NotificationCategory): boolean {
  const keys = NOTIFICATION_CATEGORY_AUDIENCE[category];
  return keys === null || keys.some((k) => hasPermission(m, k));
}

async function loadMatrix(trx: Trx, actor: Actor, orgId: string, m: MembershipGrant): Promise<NotificationPreferencesDto> {
  const [rows, profile] = await Promise.all([
    trx.selectFrom('notificationPreferences').select(['category', 'channel', 'enabled']).where('userId', '=', actor.userId).where('organizationId', '=', orgId).execute(),
    trx.selectFrom('userProfiles').select('locale').where('id', '=', actor.userId).executeTakeFirst(),
  ]);
  const stored = new Map(rows.map((r) => [`${r.category}:${r.channel}`, r.enabled]));
  const cells = notificationPreferenceCells();
  const locale = (NOTIFICATION_LOCALES as readonly string[]).includes(profile?.locale ?? '') ? (profile!.locale as NotificationLocale) : 'en';
  return {
    organizationId: orgId,
    locale,
    categories: NOTIFICATION_CATEGORY_ORDER.map((category) => ({
      category,
      relevant: relevantFor(m, category),
      channels: cells.filter((c) => c.category === category).map((c) => ({
        channel: c.channel,
        // absent = on; a cell nobody can switch is always on
        enabled: c.configurable ? stored.get(`${category}:${c.channel}`) ?? true : true,
        configurable: c.configurable,
        alwaysOn: c.alwaysOn,
      })),
    })),
  };
}

export async function getNotificationPreferences(deps: ApiDeps, actor: Actor, orgId: string): Promise<NotificationPreferencesDto> {
  const m = memberOf(actor, orgId);
  return runUser(deps.db, actor, (trx) => loadMatrix(trx, actor, orgId, m));
}

/** Bulk upsert of the caller's own cells; a cell the catalogue does not let a member switch is refused (400). */
export async function updateNotificationPreferences(deps: ApiDeps, actor: Actor, orgId: string, input: UpdateNotificationPreferencesInput): Promise<NotificationPreferencesDto> {
  const m = memberOf(actor, orgId);
  const cells = notificationPreferenceCells();
  const locked = input.preferences.filter((p) => !cells.some((c) => c.category === p.category && c.channel === p.channel && c.configurable));
  if (locked.length > 0) throw errors.validation('These notifications cannot be switched off.', { cells: locked.map((p) => `${p.category}:${p.channel}`) });
  return runUser(deps.db, actor, async (trx) => {
    const before = await trx.selectFrom('notificationPreferences').select(['category', 'channel', 'enabled']).where('userId', '=', actor.userId).where('organizationId', '=', orgId).execute();
    const now = new Date();
    await trx.insertInto('notificationPreferences')
      .values(input.preferences.map((p) => ({ userId: actor.userId, organizationId: orgId, category: p.category, channel: p.channel as NotificationDeliveryChannel, enabled: p.enabled, updatedAt: now })))
      .onConflict((oc) => oc.columns(['userId', 'organizationId', 'category', 'channel']).doUpdateSet((eb) => ({ enabled: eb.ref('excluded.enabled'), updatedAt: eb.ref('excluded.updatedAt') })))
      .execute();
    const cell = (r: { category: string; channel: string; enabled: boolean }) => [`${r.category}:${r.channel}`, r.enabled] as const;
    await audit(trx, actor, orgId, 'notification.preferences_updated', 'notification_preferences', {
      entityId: actor.userId,
      oldValue: Object.fromEntries(before.filter((b) => input.preferences.some((p) => p.category === b.category && p.channel === b.channel)).map(cell)),
      newValue: Object.fromEntries(input.preferences.map(cell)),
    });
    return loadMatrix(trx, actor, orgId, m);
  });
}
