import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import type { Logger } from '@flowza/shared';
import type { WorkerConfig } from '../config.js';
import type { Mailer, RealtimePublisher, StorageWriter } from '../deps.js';

/** Realtime broadcast + Storage through the Supabase platform client (service key needed by Supabase for these two APIs only). */
export function createPlatformClients(config: WorkerConfig, log: Logger): { realtime: RealtimePublisher; storage: StorageWriter } {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
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
  return {
    async send(msg) {
      log.info({ event: 'email_console', to: msg.to, subject: msg.subject });
      return { id: null, provider: 'console' };
    },
  };
}
