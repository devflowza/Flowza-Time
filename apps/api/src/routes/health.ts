import { Hono } from 'hono';
import { pingDatabase } from '@flowza/database';
import type { AppEnv } from '../middleware/request-context.js';
import type { ApiDeps } from '../deps.js';

export function healthRoutes(deps: ApiDeps) {
  const app = new Hono<AppEnv>();
  app.get('/health', (c) => c.json({ status: 'ok', service: 'flowza-api', time: new Date().toISOString() }));
  app.get('/ready', async (c) => {
    const db = await pingDatabase(deps.db);
    let queue: { ok: boolean; pending: number; running: number; dead: number } = { ok: false, pending: 0, running: 0, dead: 0 };
    try {
      const stats = await deps.queue.stats();
      queue = {
        ok: true,
        pending: stats.filter((s) => s.status === 'pending').reduce((a, s) => a + s.count, 0),
        running: stats.filter((s) => s.status === 'running').reduce((a, s) => a + s.count, 0),
        dead: stats.filter((s) => s.status === 'dead').reduce((a, s) => a + s.count, 0),
      };
    } catch { /* reported as not ok */ }
    const ready = db.ok && queue.ok;
    return c.json({ status: ready ? 'ready' : 'degraded', checks: { database: db, queue, providers: deps.providers.list().length } }, ready ? 200 : 503);
  });
  return app;
}
