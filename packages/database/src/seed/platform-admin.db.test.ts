import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from '../testing/index.js';
import { seedPlatformAdmin, PlatformAdminSeedError } from './platform-admin.js';

const EMAIL = 'dev@flowza.ai';
const PASSWORD = 'seed-platform-admin-test-pw';

let tdb: TestDatabase;

beforeAll(async () => { tdb = await createTestDatabase(`flowza_padmin_${process.pid}`); });
afterAll(async () => { await tdb?.close(); });

const passwordMatches = async (email: string, password: string): Promise<boolean> => {
  const { rows } = await sql<{ ok: boolean }>`
    select encrypted_password = extensions.crypt(${password}, encrypted_password) as ok
    from auth.users where email = ${email}`.execute(tdb.adminDb);
  return rows[0]?.ok === true;
};

describe('seedPlatformAdmin (local mode)', () => {
  it('creates the auth user, profile, admin row and audit entry', async () => {
    const result = await seedPlatformAdmin({ connectionString: tdb.connectionString, email: '  Dev@FlowZa.AI  ', password: PASSWORD, fullName: 'FlowZa Platform Owner' });
    expect(result).toMatchObject({ email: EMAIL, level: 'owner', mode: 'local', authUser: 'created', profile: 'created', admin: 'created' });

    const user = await sql<{ id: string; confirmed: boolean }>`
      select id, email_confirmed_at is not null as confirmed from auth.users where email = ${EMAIL}`.execute(tdb.adminDb);
    expect(user.rows).toHaveLength(1);
    expect(user.rows[0]?.confirmed).toBe(true);
    expect(user.rows[0]?.id).toBe(result.userId);
    expect(await passwordMatches(EMAIL, PASSWORD)).toBe(true);

    const profile = await tdb.adminDb.selectFrom('userProfiles').selectAll().where('id', '=', result.userId).executeTakeFirstOrThrow();
    expect(profile).toMatchObject({ email: EMAIL, fullName: 'FlowZa Platform Owner', status: 'active' });

    const admin = await tdb.adminDb.selectFrom('platformAdmins').selectAll().where('userId', '=', result.userId).executeTakeFirstOrThrow();
    expect(admin).toMatchObject({ level: 'owner', status: 'active' });

    const audit = await tdb.adminDb.selectFrom('audit.logs').selectAll().where('action', '=', 'platform_admin.seeded').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ organizationId: null, entityType: 'platform_admin', entityId: result.userId, actorType: 'SYSTEM' });

    // a brand-new admin has no verified factor, and the API refuses platform admins below aal2
    expect(result.mfaEnrolled).toBe(false);
  });

  it('is idempotent: re-running rotates the password and re-asserts the level without duplicating rows', async () => {
    const again = await seedPlatformAdmin({ connectionString: tdb.connectionString, email: EMAIL, password: `${PASSWORD}-rotated`, level: 'support' });
    expect(again).toMatchObject({ authUser: 'updated', profile: 'updated', admin: 'updated', level: 'support' });

    expect(await passwordMatches(EMAIL, `${PASSWORD}-rotated`)).toBe(true);
    expect(await passwordMatches(EMAIL, PASSWORD)).toBe(false);

    const counts = await sql<{ users: number; profiles: number; admins: number }>`
      select (select count(*)::int from auth.users where email = ${EMAIL}) as users,
             (select count(*)::int from public.user_profiles where email = ${EMAIL}) as profiles,
             (select count(*)::int from public.platform_admins) as admins`.execute(tdb.adminDb);
    expect(counts.rows[0]).toEqual({ users: 1, profiles: 1, admins: 1 });

    // promoting back to owner leaves the same user id in place
    const promoted = await seedPlatformAdmin({ connectionString: tdb.connectionString, email: EMAIL, password: `${PASSWORD}-rotated`, level: 'owner' });
    expect(promoted.userId).toBe(again.userId);
    expect(promoted.level).toBe('owner');
  });

  it('refuses to write auth.users on a non-loopback connection', async () => {
    await expect(
      seedPlatformAdmin({ connectionString: 'postgres://postgres:pw@db.example.supabase.co:5432/postgres', email: EMAIL, password: PASSWORD }),
    ).rejects.toThrow(PlatformAdminSeedError);
  });
});
