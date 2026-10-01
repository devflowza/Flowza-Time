import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@flowza/shared';
import type { WorkerConfig } from '../config.js';

// the configured path talks to Supabase: a stand-in client whose broadcast result each test sets
const realtime = vi.hoisted(() => ({ send: vi.fn(), removeChannel: vi.fn(async () => 'ok') }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ channel: () => ({ send: realtime.send }), removeChannel: realtime.removeChannel, storage: { from: () => ({}) } }),
}));

import { createPlatformClients } from './platform.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log } as unknown as Logger;
const config = (env: WorkerConfig['NODE_ENV']) => ({ NODE_ENV: env, SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined } as unknown as WorkerConfig);

describe('createPlatformClients without SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY', () => {
  it('keeps an in-memory storage for development and tests', async () => {
    const { storage } = createPlatformClients(config('test'), log);
    await storage.upload('reports', 'org/file.csv', Buffer.from('a,b'), 'text/csv');
    expect((await storage.download('reports', 'org/file.csv')).toString()).toBe('a,b');
  });

  it('refuses storage in production so a report fails with the reason instead of completing with a phantom file', async () => {
    const { storage, realtime } = createPlatformClients(config('production'), log);
    await expect(storage.upload('reports', 'org/file.csv', Buffer.from('a,b'), 'text/csv')).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: false, message: expect.stringContaining('SUPABASE_SERVICE_ROLE_KEY') });
    await expect(storage.download('reports', 'org/file.csv')).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    await expect(realtime.publish('org:x:sync', 'sync.completed', {})).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'platform_clients_unconfigured' }));
  });
});

describe('createPlatformClients realtime with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY', () => {
  const configured = { NODE_ENV: 'production', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service' } as unknown as WorkerConfig;

  it('logs a broadcast the server did not accept (send() reports it as its result, it does not throw)', async () => {
    const warn = vi.fn();
    const l = { ...log, warn } as unknown as Logger;
    const { realtime: publisher } = createPlatformClients(configured, l);
    realtime.send.mockResolvedValueOnce('ok');
    await publisher.publish('org:x:attendance', 'attendance.updated', { ids: ['r1'] });
    expect(warn).not.toHaveBeenCalled();

    realtime.send.mockResolvedValueOnce('error');
    await publisher.publish('org:x:attendance', 'attendance.updated', { ids: ['r1'] });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'realtime_publish_failed', channel: 'org:x:attendance', eventType: 'attendance.updated', result: 'error' }));

    realtime.send.mockRejectedValueOnce(new Error('socket closed'));
    await expect(publisher.publish('org:x:attendance', 'attendance.created', {})).resolves.toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'realtime_publish_failed', err: 'socket closed' }));
    expect(realtime.removeChannel).toHaveBeenCalled();
  });
});
