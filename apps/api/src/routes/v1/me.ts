import type { Hono } from 'hono';
import { notificationListQuerySchema, updateMeSchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { ok, paginated } from '../../lib/http.js';
import { body, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as me from '../../services/me.service.js';

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
}
