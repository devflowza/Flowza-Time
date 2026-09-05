import { z } from 'zod';
import { booleanFromEnv, intFromEnv, loadEnv, masterKeysSchema } from '@flowza/shared';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  API_PORT: intFromEnv(4000),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  WEB_ORIGINS: z.string().default('http://localhost:5173'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(), // ONLY for realtime broadcast publishing & storage signing, never for data access
  DATABASE_URL_API: z.string().min(1),
  DATABASE_POOL_MAX: intFromEnv(10),
  FLOWZA_CREDENTIALS_MASTER_KEYS: masterKeysSchema,
  FLOWZA_DEVICE_PUSH_SECRET: z.string().min(8),
  RATE_LIMIT_WINDOW_MS: intFromEnv(60_000),
  RATE_LIMIT_MAX: intFromEnv(600),
  TRUST_PROXY: booleanFromEnv.default(true),
});

export type ApiConfig = z.infer<typeof schema> & { webOrigins: string[] };

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = loadEnv(schema, env);
  return { ...parsed, webOrigins: parsed.WEB_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) };
}
