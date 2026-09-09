import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { AppError, type Logger } from '@flowza/shared';
import type { WorkerConfig } from '../config.js';
import type { Mailer, RealtimePublisher, StorageWriter } from '../deps.js';

const STORAGE_UNCONFIGURED = 'Report storage is not configured on this worker: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (go-live §3).';

/**
 * Realtime broadcast + Storage through the Supabase platform client (service key needed by Supabase for these two APIs
 * only). Without the two variables, development and tests get an in-memory stand-in; production gets a storage that
 * refuses, so a report is recorded FAILED with the reason instead of COMPLETED with a file that exists only in RAM.
 */
export function createPlatformClients(config: WorkerConfig, log: Logger): { realtime: RealtimePublisher; storage: StorageWriter } {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    if (config.NODE_ENV === 'production') {
      log.error({ event: 'platform_clients_unconfigured', reason: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; storage operations will fail until they are' });
      const refuse = async (): Promise<never> => { throw new AppError('DEPENDENCY_UNAVAILABLE', STORAGE_UNCONFIGURED, { retryable: false }); };
      return { realtime: { async publish() {} }, storage: { upload: refuse, download: refuse, remove: refuse } };
    }
    log.warn({ event: 'platform_clients_disabled', reason: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; realtime and storage are in-memory no-ops' });
    const mem = new Map<string, Buffer>();
    return {
      realtime: { async publish() {} },
      storage: {
        async upload(bucket, path, body) { mem.set(`${bucket}/${path}`, body); return { path, size: body.length }; },
        async download(bucket, path) { const b = mem.get(`${bucket}/${path}`); if (!b) throw new Error('object not found'); return b; },
        async remove(bucket, paths) { for (const p of paths) mem.delete(`${bucket}/${p}`); },
      },
    };
  }
  const client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    realtime: {
      async publish(channel, ev, payload) {
        try {
          const ch = client.channel(channel, { config: { private: true } });
          await ch.send({ type: 'broadcast', event: ev, payload });
          await client.removeChannel(ch);
        } catch (err) { log.warn({ event: 'realtime_publish_failed', channel, err: (err as Error).message }); }
      },
    },
    storage: {
      async upload(bucket, path, body, contentType) {
        const { error } = await client.storage.from(bucket).upload(path, body, { contentType, upsert: true });
        if (error) throw new Error(`storage upload failed: ${error.message}`);
        return { path, size: body.length };
      },
      async download(bucket, path) {
        const { data, error } = await client.storage.from(bucket).download(path);
        if (error || !data) throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
        return Buffer.from(await data.arrayBuffer());
      },
      async remove(bucket, paths) {
        const { error } = await client.storage.from(bucket).remove(paths);
        if (error) throw new Error(`storage remove failed: ${error.message}`);
      },
    },
  };
}

export function createMailer(config: WorkerConfig, log: Logger): Mailer {
  if (config.EMAIL_PROVIDER === 'resend' && config.RESEND_API_KEY) {
    const resend = new Resend(config.RESEND_API_KEY);
    return {
      async send(msg) {
        const { data, error } = await resend.emails.send({ from: config.EMAIL_FROM, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
        if (error) throw new Error(`email send failed: ${error.message}`);
        return { id: data?.id ?? null, provider: 'resend' };
      },
    };
  }
  // Asking for a provider and silently getting a no-op is the worst of both worlds: deliveries are marked 'sent' with
  // provider 'console', so nothing retries and nothing looks wrong until someone asks why no mail arrived.
  if (config.EMAIL_PROVIDER === 'resend') {
    log.warn(
      { event: 'email_provider_unconfigured', provider: 'resend' },
      'EMAIL_PROVIDER=resend but RESEND_API_KEY is not set — falling back to console. No email will be sent.',
    );
  }
  return {
    async send(msg) {
      log.info({ event: 'email_console', to: msg.to, subject: msg.subject });
      return { id: null, provider: 'console' };
    },
  };
}
