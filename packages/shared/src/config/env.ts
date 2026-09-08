import { z } from 'zod';

/** Parse process.env against a schema and fail fast with a readable message. */
export function loadEnv<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

export const intFromEnv = (def: number) => z.coerce.number().int().default(def);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/**
 * Whether a Postgres connection should negotiate TLS when nothing was configured explicitly.
 *
 * The pg driver only encrypts when it is handed an `ssl` option, so an unset value means plaintext — fine for the
 * loopback Postgres the local scripts and DB integration suite start, wrong for a managed pooler reached over the
 * public internet. Defaults on everywhere except loopback, so a hosted deployment cannot silently be in the clear.
 * An explicit `sslmode` in the URL is honoured as the operator's decision and left alone.
 */
export function databaseSslDefault(connectionString: string): boolean {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return true; // unparseable: prefer the safe direction rather than silently disabling TLS
  }
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) return sslmode !== 'disable';
  return !LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

export interface MasterKey { id: string; material: Uint8Array }

/**
 * Master keys for envelope encryption: "k1:base64,k2:base64". First key encrypts; all keys decrypt.
 */
export const masterKeysSchema = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    const keys: MasterKey[] = [];
    for (const entry of raw.split(',')) {
      const idx = entry.indexOf(':');
      if (idx <= 0) {
        ctx.addIssue({ code: 'custom', message: 'expected key_id:base64' });
        continue;
      }
      const id = entry.slice(0, idx).trim();
      const material: Uint8Array = Buffer.from(entry.slice(idx + 1).trim(), 'base64');
      if (material.length !== 32) {
        ctx.addIssue({ code: 'custom', message: `key ${id} must be 32 bytes (base64)` });
        continue;
      }
      keys.push({ id, material });
    }
    return keys;
  });
