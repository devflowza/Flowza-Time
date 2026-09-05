import { serve } from '@hono/node-server';
import { createLogger } from '@flowza/shared';
import { createDatabase, PgJobQueue, DeviceCredentialsStore, SecretsCipher } from '@flowza/database';
import { defaultRegistry } from '@flowza/device-providers';
import { loadApiConfig } from './config.js';
import { createApp } from './app.js';
import { createTokenVerifier } from './lib/jwt.js';
import { createSupabasePlatformClients } from './lib/supabase-clients.js';

const config = loadApiConfig();
const log = createLogger({ name: 'flowza-api', level: config.LOG_LEVEL });
const { db, pool } = createDatabase({ connectionString: config.DATABASE_URL_API, max: config.DATABASE_POOL_MAX, applicationName: 'flowza-api' });
const platform = createSupabasePlatformClients({ url: config.SUPABASE_URL, serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY, log });

const app = createApp({
  config,
  log,
  db,
  queue: new PgJobQueue(db),
  credentials: new DeviceCredentialsStore(new SecretsCipher(config.FLOWZA_CREDENTIALS_MASTER_KEYS)),
  providers: defaultRegistry(),
  verifyToken: createTokenVerifier({ supabaseUrl: config.SUPABASE_URL, jwtSecret: config.SUPABASE_JWT_SECRET }),
  realtime: platform.realtime,
  storage: platform.storage,
});

const server = serve({ fetch: app.fetch, port: config.API_PORT }, (info) => {
  log.info({ event: 'api_started', port: info.port, env: config.NODE_ENV });
});

async function shutdown(signal: string) {
  log.info({ event: 'api_shutdown', signal });
  server.close();
  await db.destroy().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
