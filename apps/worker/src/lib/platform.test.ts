import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@flowza/shared';
import type { WorkerConfig } from '../config.js';
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
