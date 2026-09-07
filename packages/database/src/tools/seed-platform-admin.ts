/**
 * CLI: seed a platform ("super") administrator so tenant management (`/api/v1/platform/*`) can be used.
 * Implementation lives in ../seed/platform-admin.ts; see docs/go-live.md §6.
 *
 *   # local development database (Supabase shim)
 *   PLATFORM_ADMIN_PASSWORD='…' pnpm --filter @flowza/database run seed:platform-admin
 *
 *   # hosted Supabase project — the auth user goes through the Auth admin API
 *   DATABASE_URL_ADMIN='postgres://…' SUPABASE_URL='https://<ref>.supabase.co' \
 *   SUPABASE_SERVICE_ROLE_KEY='…' PLATFORM_ADMIN_PASSWORD='…' \
 *     pnpm --filter @flowza/database run seed:platform-admin -- --email dev@flowza.ai --level owner
 *
 * The password is read from the environment on purpose: an argv value is visible to every process on the host.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlatformAdminSeedError, seedPlatformAdmin, type SeedPlatformAdminOptions } from '../seed/platform-admin.js';
import type { PlatformAdminLevel } from '../generated/db.js';

const DEFAULT_EMAIL = 'dev@flowza.ai';
const DEFAULT_NAME = 'FlowZa Platform Owner';

/** Reads `--flag value` / `--flag=value` pairs; unknown flags are rejected so a typo never silently seeds a default. */
export function parseArgs(argv: readonly string[]): Record<string, string> {
  const known = new Set(['email', 'name', 'level']);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new PlatformAdminSeedError(`Unexpected argument "${arg}".`);
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey ?? '';
    if (!known.has(key)) throw new PlatformAdminSeedError(`Unknown option "--${key}" (expected ${[...known].map((k) => `--${k}`).join(', ')}).`);
    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new PlatformAdminSeedError(`Option "--${key}" needs a value.`);
    out[key] = value;
  }
  return out;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv, argv: readonly string[]): SeedPlatformAdminOptions {
  const args = parseArgs(argv);
  const password = env.PLATFORM_ADMIN_PASSWORD;
  if (!password) {
    throw new PlatformAdminSeedError(
      'PLATFORM_ADMIN_PASSWORD is not set. Pass the password through the environment (never on the command line), e.g.\n' +
        "  PLATFORM_ADMIN_PASSWORD='…' pnpm --filter @flowza/database run seed:platform-admin",
    );
  }
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    connectionString: env.DATABASE_URL_ADMIN ?? 'postgres://postgres@127.0.0.1:54329/flowza',
    email: args.email ?? env.PLATFORM_ADMIN_EMAIL ?? DEFAULT_EMAIL,
    fullName: args.name ?? env.PLATFORM_ADMIN_NAME ?? DEFAULT_NAME,
    level: (args.level ?? env.PLATFORM_ADMIN_LEVEL ?? 'owner') as PlatformAdminLevel,
    password,
    ...(url && serviceRoleKey ? { auth: { url, serviceRoleKey } } : {}),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  (async () => {
    const opts = optionsFromEnv(process.env, process.argv.slice(2));
    const result = await seedPlatformAdmin({ ...opts, log: (m) => console.warn(m) });
    console.warn('platform admin ready', result);
    if (!result.mfaEnrolled) {
      console.warn(
        `\nNext step: ${result.email} must enrol TOTP before the API answers.\n` +
          'The API rejects any platform-admin session below aal2, so sign in to the web app and complete\n' +
          'Settings → Security → Multi-factor authentication.',
      );
    }
  })().catch((err: unknown) => {
    console.error(err instanceof PlatformAdminSeedError ? err.message : err);
    process.exit(1);
  });
}
