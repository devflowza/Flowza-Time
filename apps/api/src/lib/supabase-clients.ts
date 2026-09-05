import { createClient } from '@supabase/supabase-js';
import type { Logger } from '@flowza/shared';
import type { RealtimePublisher, StorageSigner } from '../deps.js';

/**
 * The service-role key is used ONLY for two platform operations that Supabase requires it for:
 * broadcasting to private realtime channels and signing storage URLs. It is never used for table access.
 */
export function createSupabasePlatformClients(opts: { url: string; serviceRoleKey?: string; log: Logger }): { realtime: RealtimePublisher; storage: StorageSigner } {
  if (!opts.serviceRoleKey) {
    opts.log.warn({ event: 'supabase_platform_clients_disabled', reason: 'SUPABASE_SERVICE_ROLE_KEY not set; realtime broadcast and signed URLs are no-ops' });
    return {
      realtime: { async publish() {} },
      storage: { async signedUrl() { return null; } },
    };
  }
  const client = createClient(opts.url, opts.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    realtime: {
      async publish(channel, event, payload) {
        try {
          const ch = client.channel(channel, { config: { private: true } });
          await ch.send({ type: 'broadcast', event, payload });
          await client.removeChannel(ch);
        } catch (err) {
          opts.log.warn({ event: 'realtime_publish_failed', channel, err: (err as Error).message });
        }
      },
    },
    storage: {
      async signedUrl(bucket, path, expiresInSeconds = 300) {
        const { data, error } = await client.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
        if (error) { opts.log.warn({ event: 'storage_sign_failed', bucket, err: error.message }); return null; }
        return data.signedUrl;
      },
    },
  };
}
