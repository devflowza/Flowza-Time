import type { Hono } from 'hono';
import { notificationListQuerySchema, notificationPreferencesQuerySchema, updateMeSchema, updateNotificationPreferencesSchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { ok, paginated } from '../../lib/http.js';
import { body, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as me from '../../services/me.service.js';
import * as preferences from '../../services/notification-preferences.service.js';

export function registerMeRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/me', async (c) => ok(c, await me.getMe(deps, actorOf(c, deps))));
  v1.patch('/me', async (c) => ok(c, await me.updateMe(deps, actorOf(c, deps), await body(c, updateMeSchema))));
  v1.get('/me/notifications', async (c) => {
    const q = query(c, notificationListQuerySchema);
    const { data, total } = await me.listNotifications(deps, actorOf(c, deps), q);
    return paginated(c, data, q.page, q.pageSize, total);
  });
  v1.get('/me/notifications/unread-count', async (c) => ok(c, { unread: await me.unreadCount(deps, actorOf(c, deps)) }));
  v1.post('/me/notifications/read-all', async (c) => ok(c, await me.markAllRead(deps, actorOf(c, deps))));
  v1.post('/me/notifications/:id/read', async (c) => ok(c, await me.markRead(deps, actorOf(c, deps), param(c, 'id'))));
  // the member's own notification preferences per organisation (HR portal Prompt 8); the organisation is a query parameter
  v1.get('/me/notification-preferences', async (c) => ok(c, await preferences.getNotificationPreferences(deps, actorOf(c, deps), query(c, notificationPreferencesQuerySchema).organizationId)));
  v1.put('/me/notification-preferences', async (c) => {
    const { organizationId } = query(c, notificationPreferencesQuerySchema);
    return ok(c, await preferences.updateNotificationPreferences(deps, actorOf(c, deps), organizationId, await body(c, updateNotificationPreferencesSchema)));
  });
}
