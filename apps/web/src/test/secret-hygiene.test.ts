/**
 * Secret hygiene (HR portal Prompt 10 — security gate). Everything under apps/web ships to the browser, and every VITE_*
 * variable is inlined into the bundle, so:
 *   - apps/web never names the service-role key, a secret key (sb_secret_…), a service-role JWT, a private key, the database
 *     URLs or a server-side secret variable, and never assigns a password literal outside its tests;
 *   - no committed file of the repository holds a private key, a service-role JWT or a Supabase secret key;
 *   - committed env files hold no secret value: secret-looking variables are empty or placeholders, credentialed URLs point at
 *     the local loopback database only;
 *   - the VITE_* variables are the listed public ones, and the anon key is a publishable one; Vite's env prefix stays VITE_.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = path.resolve(__dirname, '../..');
const REPO = path.resolve(WEB, '../..');

/** Committed files (git); without a git checkout, the known committed env files and apps/web's sources. */
function trackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').split('\0').filter(Boolean);
  } catch {
    return ['.env.example', 'apps/web/.env.example', 'apps/web/.env.production'];
  }
}
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|html|css|md|sql|sh|toml|ya?ml|txt|env|example|production)$|(^|\/)\.env[^/]*$/;
const files = trackedFiles().filter((f) => TEXT.test(f) && existsSync(path.join(REPO, f)) && statSync(path.join(REPO, f)).size < 5_000_000);
const read = (f: string) => readFileSync(path.join(REPO, f), 'utf8');
const webFiles = files.filter((f) => f.startsWith('apps/web/'));
const SELF = path.relative(REPO, __filename).split(path.sep).join('/');
const envFiles = files.filter((f) => /(^|\/)\.env[^/]*$/.test(f));

/** The public VITE_* variables the web reads, with why each may be public. */
const PUBLIC_VITE_VARS: Record<string, string> = {
  VITE_SUPABASE_URL: 'the project URL every browser talks to',
  VITE_SUPABASE_ANON_KEY: 'the publishable key: the anon role holds no table privilege and RLS denies it every row',
  VITE_API_URL: 'the API origin',
};
const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|SERVICE_ROLE|PRIVATE_KEY|MASTER_KEY|API_KEY|TOKEN|CREDENTIAL)/;
const PLACEHOLDER = /^(|replace-me|changeme|REPLACE_[A-Z0-9_]*|k1:REPLACE_WITH_BASE64_32_BYTES|e2e-anon-key|test-anon-key)$/;

function jwtRoles(text: string): string[] {
  const roles: string[] = [];
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]+/g)) {
    try {
      const payload = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as { role?: unknown };
      if (typeof payload.role === 'string') roles.push(payload.role);
    } catch { /* not a JWT */ }
  }
  return roles;
}
function envAssignments(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let value = m[2]!.replace(/\s+#.*$/, '').trim();
    if (/^".*"$|^'.*'$/.test(value)) value = value.slice(1, -1);
    out.push({ name: m[1]!, value });
  }
  return out;
}

describe('secret hygiene', () => {
  it('finds the files it checks', () => {
    expect(webFiles.length).toBeGreaterThan(100);
    // the one exclusion below names a real committed file, not a typo that excludes nothing
    if (trackedFiles().includes(SELF)) expect(webFiles).toContain(SELF);
    expect(envFiles).toEqual(expect.arrayContaining(['.env.example', 'apps/web/.env.production']));
  });

  it('apps/web never names or carries a server-side secret', () => {
    const bad: string[] = [];
    // this file names the needles it looks for; once committed it is one of the files it scans
    for (const f of webFiles.filter((file) => file !== SELF)) {
      // an env file's comments may name what must never go in it; its assignments may not
      const text = /(^|\/)\.env[^/]*$/.test(f) ? read(f).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n') : read(f);
      for (const needle of ['SUPABASE_SERVICE_ROLE_KEY', 'service_role', 'sb_secret_', 'FLOWZA_CREDENTIALS_MASTER_KEYS', 'DATABASE_URL', 'RESEND_API_KEY', 'FLOWZA_DEVICE_PUSH_SECRET', 'SUPABASE_JWT_SECRET']) {
        if (text.includes(needle)) bad.push(`${f}: ${needle}`);
      }
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) bad.push(`${f}: private key`);
      // a password value in code outside the tests (fixtures may type one into a login form); labels and autocomplete hints
      // (type="password", "current-password") are not values
      const code = /\.(ts|tsx|js|jsx)$/.test(f) && !/\.test\.(ts|tsx)$|\/e2e\//.test(f);
      const literal = /(?<![-\w])password['"]?\s*[:=]\s*['"]([^'"\s]{4,})['"]/gi;
      if (code && [...text.matchAll(literal)].some((m) => !/^(password|current-password|new-password)$/i.test(m[1]!))) bad.push(`${f}: password literal`);
    }
    expect(bad).toEqual([]);
  });

  it('no committed file holds a private key, a service-role JWT or a Supabase secret key', () => {
    const bad: string[] = [];
    for (const f of files) {
      const text = read(f);
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) bad.push(`${f}: private key`);
      if (/\bsb_secret_[A-Za-z0-9_-]{8,}/.test(text)) bad.push(`${f}: Supabase secret key`);
      if (jwtRoles(text).some((r) => r !== 'anon' && r !== 'authenticated')) bad.push(`${f}: JWT of role ${jwtRoles(text).join(', ')}`);
    }
    expect(bad).toEqual([]);
  });

  it('committed env files hold no secret value, and credentialed URLs point at the local database only', () => {
    const bad: string[] = [];
    for (const f of envFiles) {
      for (const { name, value } of envAssignments(read(f))) {
        if (SECRET_NAME.test(name) && name !== 'VITE_SUPABASE_ANON_KEY' && !PLACEHOLDER.test(value)) bad.push(`${f}: ${name} has a value`);
        const url = /^[a-z][a-z0-9+.-]*:\/\/([^/@\s]+)@([^/:?\s]+)/i.exec(value);
        if (url && url[1]!.includes(':') && !['127.0.0.1', 'localhost', '::1'].includes(url[2]!)) bad.push(`${f}: ${name} carries credentials for ${url[2]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the VITE_* variables are the listed public ones; the anon key is publishable; Vite\'s env prefix stays VITE_', () => {
    const used = new Set<string>();
    for (const f of [...webFiles, ...envFiles]) for (const m of read(f).matchAll(/\bVITE_[A-Z0-9_]+/g)) used.add(m[0]);
    expect([...used].filter((v) => PUBLIC_VITE_VARS[v] === undefined)).toEqual([]);
    expect([...used].filter((v) => SECRET_NAME.test(v.replace('VITE_SUPABASE_ANON_KEY', '')))).toEqual([]);
    for (const f of envFiles) {
      for (const { name, value } of envAssignments(read(f))) {
        if (name !== 'VITE_SUPABASE_ANON_KEY' || PLACEHOLDER.test(value)) continue;
        const publishable = value.startsWith('sb_publishable_') || (jwtRoles(value).length === 1 && jwtRoles(value)[0] === 'anon');
        expect(publishable, `${f}: VITE_SUPABASE_ANON_KEY must be a publishable (anon) key`).toBe(true);
      }
    }
    const viteConfig = read('apps/web/vite.config.ts');
    expect(viteConfig).not.toMatch(/envPrefix/);
  });
});
