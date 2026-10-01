import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@flowza/shared';

// a stand-in Supabase client whose broadcast result each test sets
const realtime = vi.hoisted(() => ({ send: vi.fn(), removeChannel: vi.fn(async () => 'ok') }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ channel: () => ({ send: realtime.send }), removeChannel: realtime.removeChannel }) }));

import { createSupabasePlatformClients } from './supabase-clients.js';

describe('createSupabasePlatformClients realtime', () => {
  it('logs a broadcast the server did not accept (send() reports it as its result, it does not throw)', async () => {
    const warn = vi.fn();
    const log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const { realtime: publisher } = createSupabasePlatformClients({ url: 'https://x.supabase.co', serviceRoleKey: 'service', log });
    realtime.send.mockResolvedValueOnce('ok');
    await publisher.publish('org:x:sync', 'sync.progress', { ids: ['j1'] });
    expect(warn).not.toHaveBeenCalled();

    realtime.send.mockResolvedValueOnce('timed out');
    await publisher.publish('org:x:sync', 'sync.progress', { ids: ['j1'] });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'realtime_publish_failed', channel: 'org:x:sync', eventType: 'sync.progress', result: 'timed out' }));

    realtime.send.mockRejectedValueOnce(new Error('socket closed'));
    await expect(publisher.publish('org:x:sync', 'sync.progress', {})).resolves.toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'realtime_publish_failed', err: 'socket closed' }));
  });
});
