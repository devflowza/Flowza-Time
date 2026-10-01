import { createClient } from '@supabase/supabase-js';
import type { Logger } from '@flowza/shared';
import type { RealtimePublisher, StorageSigner } from '../deps.js';

/**
 * The service-role key is used ONLY for platform operations that Supabase requires it for: broadcasting to private
 * realtime channels, signing storage URLs, and storing / reading the objects the API owns (selfie photos). It is never
 * used for table access.
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
          // an unjoined channel broadcasts over REST and reports a failure as its result ('error' / 'timed out'), never by throwing
          const result = await ch.send({ type: 'broadcast', event, payload });
          await client.removeChannel(ch);
          if (result !== 'ok') opts.log.warn({ event: 'realtime_publish_failed', channel, eventType: event, result });
        } catch (err) {
          opts.log.warn({ event: 'realtime_publish_failed', channel, eventType: event, err: (err as Error).message });
        }
      },
    },
    storage: {
      async signedUrl(bucket, path, expiresInSeconds = 300, sign) {
        const { data, error } = await client.storage.from(bucket).createSignedUrl(path, expiresInSeconds, sign?.download ? { download: sign.download } : undefined);
        if (error) { opts.log.warn({ event: 'storage_sign_failed', bucket, err: error.message }); return null; }
        return data.signedUrl;
      },
      async upload(bucket, path, body, contentType) {
        const { error } = await client.storage.from(bucket).upload(path, body, { contentType, upsert: false });
        if (error) { opts.log.warn({ event: 'storage_upload_failed', bucket, err: error.message }); return false; }
        return true;
      },
      async download(bucket, path) {
        const { data, error } = await client.storage.from(bucket).download(path);
        if (error || !data) { opts.log.warn({ event: 'storage_download_failed', bucket, err: error?.message ?? 'no data' }); return null; }
        return new Uint8Array(await data.arrayBuffer());
      },
    },
  };
}
