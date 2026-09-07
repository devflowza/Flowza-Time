import { describe, it, expect } from 'vitest';
import { isLoopbackConnection, normaliseEmail, validateOptions, PlatformAdminSeedError, type SeedPlatformAdminOptions } from './platform-admin.js';
import { optionsFromEnv, parseArgs } from '../tools/seed-platform-admin.js';

const LOCAL = 'postgres://postgres@127.0.0.1:54329/flowza';
const HOSTED = 'postgres://postgres:pw@db.example.supabase.co:5432/postgres';
const base = (over: Partial<SeedPlatformAdminOptions> = {}): SeedPlatformAdminOptions =>
  ({ connectionString: LOCAL, email: 'dev@flowza.ai', password: 'a-long-enough-password', ...over });

describe('isLoopbackConnection', () => {
  it('accepts loopback hosts only', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) expect(isLoopbackConnection(`postgres://postgres@${host}:5432/flowza`)).toBe(true);
    expect(isLoopbackConnection(HOSTED)).toBe(false);
    // a hosted host that merely starts with a loopback-looking label must not slip through
    expect(isLoopbackConnection('postgres://postgres@localhost.attacker.example:5432/flowza')).toBe(false);
    expect(isLoopbackConnection('not a url')).toBe(false);
  });
});

describe('normaliseEmail', () => {
  it('trims and lower-cases (user_profiles.email is citext and unique)', () => {
    expect(normaliseEmail('  Dev@FlowZa.AI ')).toBe('dev@flowza.ai');
  });
});

describe('validateOptions', () => {
  it('accepts a well-formed local seed', () => {
    expect(() => validateOptions(base())).not.toThrow();
  });

  it('refuses writing auth.users on a remote database without the Auth admin API', () => {
    expect(() => validateOptions(base({ connectionString: HOSTED }))).toThrow(/Auth admin API/);
    expect(() => validateOptions(base({ connectionString: HOSTED, auth: { url: 'https://x.supabase.co', serviceRoleKey: 'k' } }))).not.toThrow();
  });

  it('rejects short passwords, bad emails and unknown levels', () => {
    expect(() => validateOptions(base({ password: 'short' }))).toThrow(PlatformAdminSeedError);
    expect(() => validateOptions(base({ email: 'not-an-email' }))).toThrow(/valid email/);
    expect(() => validateOptions(base({ level: 'root' as never }))).toThrow(/Unknown level/);
  });
});

describe('parseArgs', () => {
  it('reads both --flag value and --flag=value', () => {
    expect(parseArgs(['--email', 'a@b.co', '--level=support'])).toEqual({ email: 'a@b.co', level: 'support' });
  });

  it('rejects typos and missing values instead of silently seeding a default', () => {
    expect(() => parseArgs(['--emial', 'a@b.co'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['--email'])).toThrow(/needs a value/);
    expect(() => parseArgs(['dev@flowza.ai'])).toThrow(/Unexpected argument/);
  });
});

describe('optionsFromEnv', () => {
  it('defaults to dev@flowza.ai at owner level against the local database', () => {
    const opts = optionsFromEnv({ PLATFORM_ADMIN_PASSWORD: 'a-long-enough-password' } as NodeJS.ProcessEnv, []);
    expect(opts).toMatchObject({ email: 'dev@flowza.ai', level: 'owner', fullName: 'FlowZa Platform Owner', connectionString: LOCAL });
    expect(opts.auth).toBeUndefined();
  });

  it('lets flags win over environment defaults', () => {
    const env = { PLATFORM_ADMIN_PASSWORD: 'a-long-enough-password', PLATFORM_ADMIN_EMAIL: 'env@flowza.ai', PLATFORM_ADMIN_LEVEL: 'admin' } as NodeJS.ProcessEnv;
    expect(optionsFromEnv(env, ['--email', 'flag@flowza.ai'])).toMatchObject({ email: 'flag@flowza.ai', level: 'admin' });
  });

  it('switches to the Auth admin API only when url and service role key are both present', () => {
    const env = { PLATFORM_ADMIN_PASSWORD: 'a-long-enough-password', SUPABASE_URL: 'https://x.supabase.co' } as NodeJS.ProcessEnv;
    expect(optionsFromEnv(env, []).auth).toBeUndefined();
    expect(optionsFromEnv({ ...env, SUPABASE_SERVICE_ROLE_KEY: 'k' }, []).auth).toEqual({ url: 'https://x.supabase.co', serviceRoleKey: 'k' });
  });

  it('never falls back to a built-in password', () => {
    expect(() => optionsFromEnv({} as NodeJS.ProcessEnv, [])).toThrow(/PLATFORM_ADMIN_PASSWORD/);
  });
});
