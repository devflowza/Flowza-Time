/**
 * Bootstraps a platform ("super") administrator: auth user → `user_profiles` → `platform_admins`.
 *
 * Platform admins are the cross-tenant role behind `/api/v1/platform/*` (organisations, plans, feature flags,
 * time-boxed access grants). They hold **no** tenant permissions on their own: reading a customer's rows still
 * requires a `platform_access_grants` row (docs/go-live.md §6), which is deliberate — do not work around it.
 *
 * Two provisioning modes, because `auth.users` belongs to Supabase Auth and only the local shim lets us write it:
 *  - hosted   — `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`: the user is created/updated through the Auth admin API.
 *  - local    — loopback databases only: the row is written directly with a bcrypt hash (same trick as the demo seed).
 * Both paths are idempotent: re-running rotates the password and re-asserts the level, never duplicating rows.
 *
 * Like the demo seed this runs on the admin connection and bypasses RLS on purpose — it is bootstrap tooling that
 * creates the very first principal, not application code.
 */
import { sql } from 'kysely';
import { createDatabase, type Database } from '../client.js';
import type { PlatformAdminLevel } from '../generated/db.js';

export const PLATFORM_ADMIN_LEVELS: readonly PlatformAdminLevel[] = ['support', 'admin', 'owner'];
/** Supabase Auth's own floor; the project's password policy may require more. */
export const MIN_PASSWORD_LENGTH = 8;

export interface SupabaseAuthAdmin {
  /** Project URL, e.g. https://<ref>.supabase.co */
  url: string;
  serviceRoleKey: string;
  fetch?: typeof globalThis.fetch;
}

export interface SeedPlatformAdminOptions {
  connectionString: string;
  email: string;
  password: string;
  fullName?: string;
  level?: PlatformAdminLevel;
  /** Set for hosted projects; omit to write `auth.users` directly (loopback databases only). */
  auth?: SupabaseAuthAdmin;
  log?: (message: string) => void;
}

export interface SeedPlatformAdminResult {
  userId: string;
  email: string;
  level: PlatformAdminLevel;
  mode: 'hosted' | 'local';
  authUser: 'created' | 'updated';
  profile: 'created' | 'updated';
  admin: 'created' | 'updated';
  /** True once a verified MFA factor exists — the API rejects platform admins below aal2 (apps/api middleware/auth.ts). */
  mfaEnrolled: boolean;
}

export class PlatformAdminSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformAdminSeedError';
  }
}

/** Loopback hosts are the only ones allowed to have `auth.users` written by hand (the local Supabase shim). */
export function isLoopbackConnection(connectionString: string): boolean {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Validates the options a caller controls before any connection is opened, so misuse fails fast and loudly. */
export function validateOptions(opts: SeedPlatformAdminOptions): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normaliseEmail(opts.email))) {
    throw new PlatformAdminSeedError(`"${opts.email}" is not a valid email address.`);
  }
  if (opts.password.length < MIN_PASSWORD_LENGTH) {
    throw new PlatformAdminSeedError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (opts.level && !PLATFORM_ADMIN_LEVELS.includes(opts.level)) {
    throw new PlatformAdminSeedError(`Unknown level "${opts.level}" (expected one of ${PLATFORM_ADMIN_LEVELS.join(', ')}).`);
  }
  if (!opts.auth && !isLoopbackConnection(opts.connectionString)) {
    throw new PlatformAdminSeedError(
      'Refusing to write auth.users on a non-loopback database. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY so the ' +
        'user is provisioned through the Supabase Auth admin API instead.',
    );
  }
}

interface AuthAdminUser { id: string }

async function authAdminRequest(auth: SupabaseAuthAdmin, path: string, method: 'POST' | 'PUT', body: unknown): Promise<AuthAdminUser> {
  const doFetch = auth.fetch ?? globalThis.fetch;
  const res = await doFetch(`${auth.url.replace(/\/+$/, '')}/auth/v1/admin/users${path}`, {
    method,
    headers: { apikey: auth.serviceRoleKey, authorization: `Bearer ${auth.serviceRoleKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new PlatformAdminSeedError(`Supabase Auth admin API ${method} ${path || '/'} failed (${res.status}): ${text}`);
  const parsed = JSON.parse(text) as Partial<AuthAdminUser>;
  if (!parsed.id) throw new PlatformAdminSeedError(`Supabase Auth admin API returned no user id for ${method} ${path || '/'}.`);
  return { id: parsed.id };
}

/** Existing `auth.users` id for the email, looked up over the admin connection (the Auth API has no email filter). */
async function findAuthUserId(db: Database, email: string): Promise<string | null> {
  const found = await sql<{ id: string }>`select id from auth.users where lower(email) = ${email} limit 1`.execute(db);
  return found.rows[0]?.id ?? null;
}

async function provisionHosted(db: Database, auth: SupabaseAuthAdmin, email: string, password: string, fullName: string): Promise<{ userId: string; authUser: 'created' | 'updated' }> {
  const existing = await findAuthUserId(db, email);
  const metadata = { full_name: fullName };
  if (existing) {
    const user = await authAdminRequest(auth, `/${existing}`, 'PUT', { password, email_confirm: true, user_metadata: metadata });
    return { userId: user.id, authUser: 'updated' };
  }
  const user = await authAdminRequest(auth, '', 'POST', { email, password, email_confirm: true, user_metadata: metadata });
  return { userId: user.id, authUser: 'created' };
}

async function provisionLocal(db: Database, email: string, password: string, fullName: string): Promise<{ userId: string; authUser: 'created' | 'updated' }> {
  const existing = await findAuthUserId(db, email);
  const metadata = JSON.stringify({ full_name: fullName });
  if (existing) {
    await sql`update auth.users
      set encrypted_password = extensions.crypt(${password}, extensions.gen_salt('bf')),
          email_confirmed_at = coalesce(email_confirmed_at, now()),
          raw_user_meta_data = ${metadata}::jsonb,
          updated_at = now()
      where id = ${existing}::uuid`.execute(db);
    return { userId: existing, authUser: 'updated' };
  }
  const inserted = await sql<{ id: string }>`insert into auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
    values (${email}, extensions.crypt(${password}, extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, ${metadata}::jsonb)
    returning id`.execute(db);
  const userId = inserted.rows[0]?.id;
  if (!userId) throw new PlatformAdminSeedError('Failed to create the local auth.users row.');
  return { userId, authUser: 'created' };
}

/** Creates or updates the platform administrator and returns what changed. */
export async function seedPlatformAdmin(opts: SeedPlatformAdminOptions): Promise<SeedPlatformAdminResult> {
  validateOptions(opts);
  const log = opts.log ?? (() => {});
  const email = normaliseEmail(opts.email);
  const fullName = opts.fullName?.trim() || 'FlowZa Platform Owner';
  const level: PlatformAdminLevel = opts.level ?? 'owner';
  const mode: 'hosted' | 'local' = opts.auth ? 'hosted' : 'local';
  const { db, pool } = createDatabase({ connectionString: opts.connectionString, max: 2, applicationName: 'flowza-seed-platform-admin' });
  try {
    const { userId, authUser } = opts.auth
      ? await provisionHosted(db, opts.auth, email, opts.password, fullName)
      : await provisionLocal(db, email, opts.password, fullName);
    log(`auth user ${authUser} (${mode}): ${email} → ${userId}`);

    const profileExisted = !!(await db.selectFrom('userProfiles').select('id').where('id', '=', userId).executeTakeFirst());
    await db
      .insertInto('userProfiles')
      .values({ id: userId, email, fullName })
      .onConflict((oc) => oc.column('id').doUpdateSet({ email, fullName, status: 'active' }))
      .execute();
    const profile = profileExisted ? 'updated' : 'created';
    log(`user profile ${profile}`);

    const adminExisted = !!(await db.selectFrom('platformAdmins').select('userId').where('userId', '=', userId).executeTakeFirst());
    await db
      .insertInto('platformAdmins')
      .values({ userId, level, status: 'active' })
      .onConflict((oc) => oc.column('userId').doUpdateSet({ level, status: 'active' }))
      .execute();
    const admin = adminExisted ? 'updated' : 'created';
    log(`platform admin ${admin} at level "${level}"`);

    // Bootstrap belongs in the audit trail like every other grant of privilege (organisation_id stays null: not tenant scoped).
    await db
      .insertInto('audit.logs')
      .values({
        organizationId: null,
        actorUserId: null,
        actorType: 'SYSTEM',
        actorLabel: 'seed-platform-admin',
        action: 'platform_admin.seeded',
        entityType: 'platform_admin',
        entityId: userId,
        newValue: JSON.stringify({ email, level, status: 'active', fullName, mode }),
        reason: 'Platform administrator bootstrap',
      })
      .execute();

    const mfaEnrolled = await hasVerifiedMfaFactor(db, userId);
    return { userId, email, level, mode, authUser, profile, admin, mfaEnrolled };
  } finally {
    await db.destroy();
    await pool.end().catch(() => undefined);
  }
}

/**
 * The API refuses every request from a platform admin whose session is below `aal2`, so a freshly seeded admin
 * must enrol TOTP before the platform routes answer. `auth.mfa_factors` does not exist in the local shim.
 */
async function hasVerifiedMfaFactor(db: Database, userId: string): Promise<boolean> {
  const exists = await sql<{ n: number }>`
    select count(*)::int as n from auth.mfa_factors where user_id = ${userId}::uuid and status = 'verified'`
    .execute(db)
    .catch(() => ({ rows: [] as Array<{ n: number }> }));
  return (exists.rows[0]?.n ?? 0) > 0;
}
