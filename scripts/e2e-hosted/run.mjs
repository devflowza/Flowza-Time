#!/usr/bin/env node
/**
 * FlowZa Time — end-to-end test matrix (HR portal Prompt 11).
 *
 * Drives the REAL API through the HR-portal flows with real tokens, asserting status codes AND state transitions (every
 * step re-reads the resource it changed). Node 22, no dependencies: fetch, node:crypto, node:http, node:child_process.
 *
 *   node scripts/e2e-hosted/run.mjs --mode=local  [--reset] [--start] [--db=flowza_p11] [--api-port=4310] [--flows=1,2,…]
 *   node scripts/e2e-hosted/run.mjs --mode=hosted --i-understand-this-writes-to-the-demo-tenant [--flows=…]
 *
 * See README.md next to this file. Exit code = number of failed flows (0 = green).
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RESULTS_DIR = path.join(HERE, 'results');
/** The only tenant hosted mode may write to: Majan Gulf Trading (supabase/seeds/demo-tenant/README.md). */
const DEMO_TENANT_ID = '27bfe270-5dea-4587-aec3-0f5c23113261';

// ================================================================================================================ CLI ===

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(a);
    if (!m) fail(`Unknown argument: ${a} (see scripts/e2e-hosted/README.md)`);
    out[m[1]] = m[2] ?? true;
  }
  return out;
}
function fail(message) { console.error(`e2e: ${message}`); process.exit(100); }

const args = parseArgs(process.argv.slice(2));
const MODE = args.mode;
if (MODE !== 'local' && MODE !== 'hosted') fail('--mode=local or --mode=hosted is required.');
const RUN_ID = (typeof args['run-id'] === 'string' ? args['run-id'] : `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`);
const TAG = `e2e:${RUN_ID}`;
const VERBOSE = !!args.verbose;
const ONLY = typeof args.flows === 'string' ? new Set(args.flows.split(',').map((s) => s.trim()).filter(Boolean)) : null;
/** Bounded waits for the worker (normaliser, recompute, corrections, reports): seconds. */
const WORKER_TIMEOUT_MS = Number(args['worker-timeout'] ?? (MODE === 'local' ? 150 : 300)) * 1000;

const LOGINS = MODE === 'local'
  ? { owner: 'owner@albahja.example', hr: 'hr@albahja.example', manager: 'manager@albahja.example', employee: 'employee@albahja.example', auditor: 'auditor@albahja.example', branchManager: 'sohar.manager@albahja.example', delegate: 'payroll@albahja.example' }
  : { owner: 'acme@flowza.ai', hr: 'hradmin@flowza.ai', manager: 'manager@flowza.ai', employee: 'employee@flowza.ai', auditor: 'auditor@flowza.ai', branchManager: 'brmanager@flowza.ai', delegate: 'payroll@flowza.ai' };
// any login can be overridden: E2E_LOGIN_OWNER, E2E_LOGIN_HR, E2E_LOGIN_MANAGER, E2E_LOGIN_EMPLOYEE, E2E_LOGIN_AUDITOR, E2E_LOGIN_BRANCHMANAGER, E2E_LOGIN_DELEGATE
for (const role of Object.keys(LOGINS)) { const v = process.env[`E2E_LOGIN_${role.toUpperCase()}`]; if (v) LOGINS[role] = v; }

// ---------------------------------------------------------------------------------------------------- mode configuration
const cfg = {};
if (MODE === 'hosted') {
  for (const k of ['E2E_SUPABASE_URL', 'E2E_SUPABASE_ANON_KEY', 'E2E_API_URL', 'E2E_PASSWORD', 'E2E_ORG_ID']) if (!process.env[k]) fail(`hosted mode needs ${k} in the environment (never on the command line, never in the file).`);
  if (process.env.E2E_ORG_ID !== DEMO_TENANT_ID) fail(`hosted mode only runs against the demo tenant ${DEMO_TENANT_ID} (E2E_ORG_ID is ${process.env.E2E_ORG_ID}).`);
  if (!args['i-understand-this-writes-to-the-demo-tenant']) fail('hosted mode creates and changes data in the demo tenant: pass --i-understand-this-writes-to-the-demo-tenant to confirm.');
  if (args.reset || args.start) fail('--reset and --start are local-mode options.');
  cfg.supabaseUrl = process.env.E2E_SUPABASE_URL.replace(/\/$/, '');
  cfg.anonKey = process.env.E2E_SUPABASE_ANON_KEY;
  cfg.api = process.env.E2E_API_URL.replace(/\/$/, '');
  cfg.orgId = process.env.E2E_ORG_ID;
} else {
  cfg.apiPort = Number(args['api-port'] ?? 4310);
  if ([4000, 4173, 5173].includes(cfg.apiPort)) fail(`port ${cfg.apiPort} is reserved for other tools; pick another (--api-port).`);
  cfg.api = (typeof args.api === 'string' ? args.api : `http://127.0.0.1:${cfg.apiPort}/api/v1`).replace(/\/$/, '');
  cfg.db = typeof args.db === 'string' ? args.db : (process.env.PGDATABASE || 'flowza_p11');
  cfg.pg = { host: process.env.PGHOST || '127.0.0.1', port: process.env.PGPORT || '54329', user: process.env.PGUSER || 'postgres' };
  // the issuer the API verifies (`${SUPABASE_URL}/auth/v1`); nothing listens there, so JWKS fails fast and HS256 is used
  cfg.supabaseUrl = (typeof args['supabase-url'] === 'string' ? args['supabase-url'] : (process.env.E2E_LOCAL_SUPABASE_URL || 'http://127.0.0.1:54399')).replace(/\/$/, '');
  cfg.jwtSecret = process.env.E2E_JWT_SECRET || (args.start ? randomBytes(32).toString('base64url') : null);
  if (!cfg.jwtSecret) fail('local mode mints HS256 tokens: set E2E_JWT_SECRET to the API\'s SUPABASE_JWT_SECRET, or pass --start so the script runs the API with its own.');
}
cfg.apiRoot = cfg.api.replace(/\/v1$/, '');

// ============================================================================================================ helpers ===

const log = (...m) => { if (VERBOSE) console.log(...m); };
const today0 = () => new Date();
/** YYYY-MM-DD of an instant in an IANA zone. */
function dateIn(tz, at = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
/** Milliseconds a zone is ahead of UTC at an instant. */
function tzOffsetMs(tz, at) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(at / 1000) * 1000;
}
/** The UTC instant (ms) of local midnight of `date` in `tz`. */
function startOfDayUtc(date, tz) { const guess = Date.parse(`${date}T00:00:00Z`); return guess - tzOffsetMs(tz, guess); }
function addDays(date, n) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
/** 0 = Sunday … 6 = Saturday (the organisation's weekly-off convention). */
function weekday(date) { return new Date(`${date}T00:00:00Z`).getUTCDay(); }
const monthOf = (date) => date.slice(0, 7);
function prevMonth(month) { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; }

class AssertionFailure extends Error {}
function check(cond, message) { if (!cond) throw new AssertionFailure(message); }
function eq(actual, expected, what) { if (actual !== expected) throw new AssertionFailure(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
function short(v) { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > 160 ? `${s.slice(0, 157)}…` : s; }
/** What the results table shows for a step's return value: text as is, a record as "<status> <id prefix>". */
function display(v) {
  if (v === undefined || v === null) return 'ok';
  if (typeof v !== 'object') return short(String(v));
  if (Array.isArray(v)) return `${v.length} item(s)`;
  const id = v.id ?? v.requestId ?? v.employeeId;
  const status = v.status ?? v.verdict?.verdict ?? v.state;
  if (id || status) return [status, id ? `id ${String(id).slice(0, 8)}` : null].filter(Boolean).join(' ');
  return short(v);
}

async function poll(what, fn, { timeoutMs = WORKER_TIMEOUT_MS, intervalMs = 1500 } = {}) {
  const started = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (last && last.done) return last.value;
    if (Date.now() - started > timeoutMs) throw new AssertionFailure(`${what}: not reached after ${Math.round(timeoutMs / 1000)} s (last: ${short(last?.state ?? last)})`);
    await sleep(intervalMs);
  }
}

// ======================================================================================================== local tools ===

function psql(sqlText) {
  return execFileSync('psql', ['-h', cfg.pg.host, '-p', cfg.pg.port, '-U', cfg.pg.user, '-d', cfg.db, '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sqlText], { encoding: 'utf8' }).trim();
}

function b64url(v) { return Buffer.from(v).toString('base64url'); }
/** A Supabase-shaped access token signed HS256 with the local API's SUPABASE_JWT_SECRET (local mode only). */
function mintToken(sub, email) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: `${cfg.supabaseUrl}/auth/v1`, aud: 'authenticated', sub, email, role: 'authenticated', aal: 'aal1', session_id: randomUUID(), iat: now, exp: now + 4 * 3600 }));
  const sig = createHmac('sha256', cfg.jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

/** Supabase Auth password grant (hosted mode). The password comes from E2E_PASSWORD only. */
async function passwordGrant(email) {
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: cfg.anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: process.env.E2E_PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`sign-in failed for ${email}: HTTP ${res.status} ${short(body.error_description ?? body.msg ?? body.error ?? '')}`);
  return body.access_token;
}

// ------------------------------------------------------------------------------------------------ local servers (--start)
const children = [];
function localEnv() {
  const pgUrl = (user) => `postgres://${user}:${user}@${cfg.pg.host}:${cfg.pg.port}/${cfg.db}`;
  const masterKey = process.env.E2E_MASTER_KEYS || `k1:${createHash('sha256').update(`flowza-e2e-local-${cfg.db}`).digest('base64')}`;
  return {
    NODE_ENV: 'development', LOG_LEVEL: process.env.E2E_LOG_LEVEL || 'info',
    SUPABASE_URL: cfg.supabaseUrl, SUPABASE_ANON_KEY: 'local-anon-key', SUPABASE_JWT_SECRET: cfg.jwtSecret, SUPABASE_SERVICE_ROLE_KEY: '',
    DATABASE_URL_API: pgUrl('flowza_api'), DATABASE_URL_WORKER: pgUrl('flowza_worker'), DATABASE_POOL_MAX: '10',
    FLOWZA_CREDENTIALS_MASTER_KEYS: masterKey, FLOWZA_DEVICE_PUSH_SECRET: 'local-e2e-push-secret',
    API_PORT: String(cfg.apiPort), API_PUBLIC_URL: cfg.apiRoot.replace(/\/api$/, ''), WEB_ORIGINS: 'http://localhost:5173', WEB_PUBLIC_URL: 'http://localhost:5173',
    RATE_LIMIT_MAX: '100000', TRUST_PROXY: 'false',
    // the mock Finance server of flow 10 listens on 127.0.0.1 (local development only — never set in a deployed environment)
    FLOWZA_ALLOW_PRIVATE_EGRESS: 'true',
    SCHEDULER_ENABLED: 'true', SCHEDULER_TICK_MS: '2000', WORKER_POLL_INTERVAL_MS: '300', WORKER_CONCURRENCY: '8', EMAIL_PROVIDER: 'console',
  };
}
function startProcess(name, pkgDir, entry) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const logPath = path.join(RESULTS_DIR, `${RUN_ID}-${name}.log`);
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: path.join(ROOT, pkgDir), env: { ...process.env, ...localEnv(), PATH: process.env.PATH }, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  children.push({ name, child, logPath });
  child.on('exit', (code) => log(`${name} exited (${code})`));
  return child;
}
async function stopChildren() {
  for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (children.some(({ child }) => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) await sleep(200);
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
async function waitForApi() {
  const started = Date.now();
  for (;;) {
    try { const r = await fetch(`${cfg.apiRoot}/ready`); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() - started > 90_000) throw new Error(`the API did not become ready at ${cfg.apiRoot}/ready`);
    await sleep(500);
  }
}
/**
 * Dev hook of flow 8 (local only): runs the worker's approvals sweep once for one organisation with an injected clock
 * (apps/worker/src/tools/run-approval-reminders.ts), so an escalation due in hours is due now.
 */
function runApprovalSweep(orgId, nowIso) {
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/tools/run-approval-reminders.ts', `--org=${orgId}`, `--now=${nowIso}`], { cwd: path.join(ROOT, 'apps/worker'), env: { ...process.env, ...localEnv(), LOG_LEVEL: 'warn' }, encoding: 'utf8' });
  const line = out.trim().split('\n').filter(Boolean).pop() ?? '{}';
  return JSON.parse(line);
}

// ============================================================================================================== HTTP ===

const actors = {};
async function http(actor, method, pathOrUrl, { body, headers = {}, raw = false } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${cfg.api}${pathOrUrl}`;
  const started = performance.now();
  const init = { method, headers: { ...(actor ? { authorization: `Bearer ${actor.token}` } : {}), ...headers } };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const ms = Math.round(performance.now() - started);
  log(`${actor?.role ?? 'anon'} ${method} ${url.replace(cfg.api, '')} → ${res.status} (${ms} ms)`);
  return { status: res.status, json, data: json?.data, meta: json?.meta, text: raw ? text : undefined, code: json?.code, details: json?.details, ms };
}
const org = (p) => `/orgs/${cfg.orgId}${p}`;
/** Fail with the API's own error code / message when the status is not the expected one. */
function expectStatus(res, expected, what) {
  const ok = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
  if (!ok) throw new AssertionFailure(`${what}: expected HTTP ${Array.isArray(expected) ? expected.join('/') : expected}, got ${res.status}${res.code ? ` ${res.code}` : ''}${res.json?.message ? ` — ${short(res.json.message)}` : ''}${res.details ? ` ${short(res.details)}` : ''}`);
  return res;
}

// ========================================================================================================== results ===

const rows = [];
const flowOutcomes = [];
class Flow {
  constructor(id, title) { this.id = id; this.title = title; this.cleanups = []; this.failed = false; this.skipped = false; this.known = []; }
  /**
   * One step: `fn` performs the call(s), asserts, and returns the ACTUAL value shown in the table. `known` names the agent
   * that owns a defect already being fixed in parallel: a failure is then recorded as KNOWN and the flow goes on.
   */
  async step(name, expected, fn, { known = null, soft = false } = {}) {
    const started = performance.now();
    try {
      const actual = await fn();
      rows.push({ flow: this.id, step: name, expected, actual: display(actual), status: 'PASS', ms: Math.round(performance.now() - started) });
      return actual;
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      const message = err instanceof AssertionFailure ? err.message : `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
      if (known) { rows.push({ flow: this.id, step: name, expected, actual: short(message), status: `KNOWN: ${known}`, ms }); this.known.push(name); return undefined; }
      rows.push({ flow: this.id, step: name, expected, actual: short(message), status: 'FAIL', ms });
      if (!soft) { this.failed = true; throw new FlowAborted(); }
      this.failed = true;
      return undefined;
    }
  }
  skip(name, reason) { rows.push({ flow: this.id, step: name, expected: '-', actual: reason, status: 'SKIP', ms: 0 }); }
  cleanup(what, fn) { this.cleanups.push({ what, fn }); }
}
class FlowAborted extends Error {}

async function runFlow(id, title, fn, { localOnly = false } = {}) {
  if (ONLY && String(id) !== '0' && !ONLY.has(String(id))) return;
  const flow = new Flow(String(id), title);
  const started = performance.now();
  if (localOnly && MODE !== 'local') { flow.skipped = true; flow.skip('flow', 'local mode only'); flowOutcomes.push({ id: flow.id, title, status: 'SKIP', ms: 0 }); return; }
  console.log(`\n▶ flow ${id} — ${title}`);
  try { await fn(flow); } catch (err) {
    if (!(err instanceof FlowAborted)) { flow.failed = true; rows.push({ flow: flow.id, step: 'unexpected error', expected: '-', actual: short(`${err?.name}: ${err?.message}`), status: 'FAIL', ms: 0 }); if (VERBOSE) console.error(err); }
  }
  for (const c of flow.cleanups.reverse()) {
    const t = performance.now();
    try { const actual = await c.fn(); rows.push({ flow: flow.id, step: `cleanup: ${c.what}`, expected: 'done', actual: short(actual ?? 'done'), status: 'PASS', ms: Math.round(performance.now() - t) }); }
    catch (err) { flow.failed = true; rows.push({ flow: flow.id, step: `cleanup: ${c.what}`, expected: 'done', actual: short(err instanceof AssertionFailure ? err.message : `${err?.name}: ${err?.message}`), status: 'FAIL', ms: Math.round(performance.now() - t) }); }
  }
  const status = flow.failed ? 'FAIL' : flow.skipped ? 'SKIP' : flow.known.length ? 'PASS (KNOWN)' : 'PASS';
  flowOutcomes.push({ id: flow.id, title, status, ms: Math.round(performance.now() - started) });
  console.log(`  ${status} (${Math.round((performance.now() - started) / 1000)} s)`);
}

function printResults() {
  const cols = ['flow', 'step', 'expected', 'actual', 'status', 'ms'];
  const width = { flow: 5, step: 58, expected: 40, actual: 60, status: 24, ms: 7 };
  const cut = (s, w) => { const v = String(s ?? ''); return v.length > w ? `${v.slice(0, w - 1)}…` : v.padEnd(w); };
  console.log(`\n${cols.map((c) => cut(c, width[c])).join(' │ ')}`);
  console.log(cols.map((c) => '─'.repeat(width[c])).join('─┼─'));
  for (const r of rows) console.log(cols.map((c) => cut(r[c], width[c])).join(' │ '));
  console.log('\nFlows:');
  for (const f of flowOutcomes) console.log(`  ${f.id.padEnd(6)} ${f.status.padEnd(14)} ${String(Math.round(f.ms / 1000)).padStart(4)} s  ${f.title}`);
}

// ============================================================================================================== state ===

const S = { tz: 'Asia/Muscat' };
async function signIn() {
  if (MODE === 'local') {
    const emails = Object.values(LOGINS);
    const lines = psql(`select id, email from auth.users where email in (${emails.map((e) => `'${e.replace(/'/g, "''")}'`).join(',')})`).split('\n').filter(Boolean);
    const idOf = new Map(lines.map((l) => { const [id, email] = l.split('\t'); return [email, id]; }));
    for (const [role, email] of Object.entries(LOGINS)) {
      const id = idOf.get(email);
      if (!id) fail(`local login ${email} not found in ${cfg.db} (seed it: PGDATABASE=${cfg.db} bash scripts/db-reset-local.sh --seed, or pass --reset).`);
      actors[role] = { role, email, userId: id, token: mintToken(id, email) };
    }
  } else {
    for (const [role, email] of Object.entries(LOGINS)) actors[role] = { role, email, token: await passwordGrant(email) };
  }
  for (const a of Object.values(actors)) {
    const me = expectStatus(await http(a, 'GET', '/me'), 200, `/me as ${a.email}`).data;
    a.userId = me.user?.id ?? a.userId;
    a.name = me.user?.fullName || a.email;
    if (MODE === 'local' && !cfg.orgId) cfg.orgId = me.memberships.find((m) => m.roleKey === 'owner')?.organization.id ?? me.memberships[0]?.organization.id;
    a.me = me;
  }
  for (const a of Object.values(actors)) {
    const m = a.me.memberships.find((x) => x.organization.id === cfg.orgId);
    if (!m) fail(`${a.email} has no membership in organisation ${cfg.orgId}.`);
    a.membership = m; a.employeeId = m.employeeId; a.permissions = new Set(m.permissions); a.roleKey = m.roleKey;
    S.tz = m.organization.timezone || S.tz;
  }
  S.today = dateIn(S.tz);
}

// ============================================================================================================== setup ===

/** Everything the flows assume, checked before any of them runs (a broken fixture fails here, not halfway through a flow). */
async function prerequisites(flow) {
  await flow.step('every login signs in and has a membership', 'all 7 logins resolved', async () => `${Object.keys(actors).length} logins, org ${cfg.orgId}`);
  const { employee, manager, hr, owner, auditor, branchManager } = actors;
  await flow.step('employee login is linked to an employee record', 'employeeId set', () => { check(!!employee.employeeId, `${employee.email} has no employee link`); return employee.employeeId; });
  await flow.step('manager login is linked to an employee record', 'employeeId set', () => { check(!!manager.employeeId, `${manager.email} has no employee link`); return manager.employeeId; });
  S.emp = await flow.step('HR reads the employee: the manager login is the primary manager', 'managerEmployeeId = manager login', async () => {
    const e = expectStatus(await http(hr, 'GET', org(`/employees/${employee.employeeId}`)), 200, 'GET employee').data;
    eq(e.managerEmployeeId, manager.employeeId, 'the employee\'s primary manager (seed: the self-service employee reports to the line-manager login)');
    return e;
  });
  await flow.step('roles hold the keys the flows use', 'owner/hr/employee/manager keys', () => {
    for (const [a, keys] of [[owner, ['organization.manage', 'integration.manage']], [hr, ['attendance.manage_geofences', 'approval.manage', 'report.schedule', 'attendance.recalculate', 'leave.manage']], [employee, ['attendance.checkin', 'attendance.note', 'shift.request_swap', 'leave.request']], [manager, ['approval.delegate', 'attendance.approve', 'leave.approve']]]) {
      for (const k of keys) check(a.permissions.has(k), `${a.email} (${a.roleKey}) lacks ${k}`);
    }
    check(auditor.roleKey === 'auditor', `${auditor.email} is ${auditor.roleKey}, not auditor`);
    check(branchManager.membership.allBranches === false && branchManager.membership.branchIds.length > 0, `${branchManager.email} is not branch-restricted`);
    return 'ok';
  });
  // the organisation's attendance settings, restored at the very end
  S.attendanceSettings = await flow.step('owner reads the attendance settings', 'HTTP 200', async () => expectStatus(await http(owner, 'GET', org('/settings/attendance')), 200, 'GET settings/attendance').data);
  const selfService = { ...S.attendanceSettings.selfService, webCheckIn: true, requireGeofence: 'block', checkInWindow: null, checkOutWindow: null, outOfWindowAction: 'accept', ipAllowList: [], regularisation: true };
  await flow.step('owner turns web check-in on (geofence enforcement "block") for the run', 'HTTP 200 + re-read', async () => {
    expectStatus(await http(owner, 'PUT', org('/settings/attendance'), { body: { ...S.attendanceSettings, selfService } }), 200, 'PUT settings/attendance');
    S.settingsChanged = true;
    const back = expectStatus(await http(owner, 'GET', org('/settings/attendance')), 200, 'GET settings/attendance').data;
    eq(back.selfService.webCheckIn, true, 'selfService.webCheckIn'); eq(back.selfService.requireGeofence, 'block', 'selfService.requireGeofence');
    return 'webCheckIn=true requireGeofence=block';
  });
}

// ======================================================================================================= shared bits ===

const idemKey = (suffix) => `${RUN_ID}-${suffix}`.replace(/[^A-Za-z0-9_.:-]/g, '-');

async function myMonth(month) { return expectStatus(await http(actors.employee, 'GET', org(`/me/attendance?month=${month}`)), 200, `GET /me/attendance?month=${month}`).data; }
async function myDay(date) { return (await myMonth(monthOf(date))).days.find((d) => d.attendanceDate === date) ?? null; }
async function myNotes() { return expectStatus(await http(actors.employee, 'GET', org('/me/attendance/notes')), 200, 'GET /me/attendance/notes').data; }
async function getRequest(actor, id) { return expectStatus(await http(actor, 'GET', org(`/approvals/${id}`)), 200, `GET /approvals/${id}`).data; }
/** Active day marks of the employee on one date, read by the line manager (direct report, attendance.view_team). */
async function activeMarks(date) { return expectStatus(await http(actors.manager, 'GET', org(`/attendance/day-marks?employeeId=${actors.employee.employeeId}&from=${date}&to=${date}`)), 200, 'GET day-marks').data; }
const needsExplanation = (d) => !!d && (d.status === 'ABSENT' || d.status === 'MISSING_PUNCH' || d.flags.includes('LATE') || d.flags.includes('MISSING_IN') || d.flags.includes('MISSING_OUT'));

/**
 * Decide the current level of a request with whichever of `candidates` the engine lets decide it (abilities.canDecide), until
 * the request is no longer pending. Returns the decisions made ([{ stepNo, actor }]).
 */
async function driveApproval(requestId, candidates, comment) {
  const decisions = [];
  for (let guard = 0; guard < 6; guard += 1) {
    const req = await getRequest(actors.hr, requestId);
    if (req.status !== 'PENDING') return { status: req.status, decisions };
    let decided = false;
    for (const a of candidates) {
      const view = await getRequest(a, requestId).catch(() => null);
      if (!view?.abilities?.canDecide || view.abilities.mustChooseSeat) continue;
      expectStatus(await http(a, 'POST', org(`/approvals/${requestId}/decide`), { body: { stepNo: view.currentStep, decision: 'APPROVE', comment } }), 200, `decide level ${view.currentStep} as ${a.role}`);
      decisions.push({ stepNo: view.currentStep, actor: a.role });
      decided = true;
      break;
    }
    if (!decided) throw new AssertionFailure(`nobody of ${candidates.map((c) => c.role).join('/')} may decide level ${req.currentStep} of ${requestId}`);
  }
  throw new AssertionFailure(`request ${requestId} still pending after 6 decisions`);
}

/** Waits (bounded) until `actor` holds an in-app notification matching `pred`: the worker relays the outbox every few seconds. */
async function awaitNotification(actor, what, pred, timeoutMs = 60_000) {
  return poll(what, async () => {
    const list = expectStatus(await http(actor, 'GET', `/me/notifications?organizationId=${cfg.orgId}&pageSize=50`), 200, 'GET /me/notifications').data;
    const n = list.find(pred);
    return { done: !!n, value: n, state: list.slice(0, 4).map((x) => x.type) };
  }, { timeoutMs });
}
const about = (id) => (n) => n.data?.aggregateId === id;

async function restoreSettings() {
  if (!S.settingsChanged) return 'nothing changed';
  expectStatus(await http(actors.owner, 'PUT', org('/settings/attendance'), { body: S.attendanceSettings }), 200, 'restore settings/attendance');
  const back = expectStatus(await http(actors.owner, 'GET', org('/settings/attendance')), 200, 'GET settings/attendance').data;
  eq(JSON.stringify(back.selfService), JSON.stringify(S.attendanceSettings.selfService), 'selfService restored');
  return 'restored';
}

// ============================================================================================================ flow 1 ===

/** Check-in preview inside / outside a temporary geofence, punch in, status IN, punch out, the engine computes the day, stats. */
async function flowCheckIn(flow) {
  const { employee, hr } = actors;
  const branch = expectStatus(await http(hr, 'GET', org(`/branches/${S.emp.branchId}`)), 200, 'GET branch').data;
  const centre = { lat: Number(branch.latitude ?? 23.588), lng: Number(branch.longitude ?? 58.3829) };
  const fence = await flow.step('HR creates a temporary fence for the employee (150 m, hard block)', 'HTTP 201, assignment to the employee', async () => {
    const res = expectStatus(await http(hr, 'POST', org('/geofences'), { body: { name: `${TAG} check-in fence`, latitude: centre.lat, longitude: centre.lng, radiusM: 150, enforcement: 'hard_block', accuracyThresholdM: 100, isActive: true, assignments: [{ scope: 'employee', targetId: employee.employeeId }] } }), 201, 'POST /geofences').data;
    const back = expectStatus(await http(hr, 'GET', org(`/geofences/${res.id}`)), 200, 'GET geofence').data;
    check(back.assignments.some((a) => a.scope === 'employee' && a.targetId === employee.employeeId), 'the employee assignment is stored');
    return back;
  });
  flow.cleanup('delete the temporary fence', async () => { expectStatus(await http(hr, 'DELETE', org(`/geofences/${fence.id}`)), 204, 'DELETE geofence'); expectStatus(await http(hr, 'GET', org(`/geofences/${fence.id}`)), 404, 'GET deleted geofence'); return 'deleted'; });

  // The employee may already be checked in when the flow starts: an earlier run, or — in hosted mode during working hours —
  // the demo tenant's own terminal punches of today. A check-in preview is then (rightly) refused with ALREADY_CHECKED_IN,
  // so an open check-in is closed first, inside the fence, and the status re-read before anything is asserted.
  let before = await flow.step('status before punching', 'HTTP 200', async () => expectStatus(await http(employee, 'GET', org('/me/punch/status')), 200, 'status').data);
  if (before.lastDirection === 'in') {
    await flow.step('close an open check-in (an earlier run, or a terminal punch of today)', 'HTTP 201', async () => { expectStatus(await http(employee, 'POST', org('/me/punch'), { body: { direction: 'out', channel: 'web', lat: centre.lat, lng: centre.lng, accuracy: 15, idempotencyKey: idemKey('f1-prep-out') } }), 201, 'prep out'); return 'closed'; });
    before = await flow.step('status after closing it', 'HTTP 200, lastDirection out', async () => {
      const s = expectStatus(await http(employee, 'GET', org('/me/punch/status')), 200, 'status').data;
      eq(s.lastDirection, 'out', 'lastDirection');
      return s;
    });
  }
  await flow.step('preview inside the fence', 'verdict allowed, no refusal', async () => {
    const p = expectStatus(await http(employee, 'POST', org('/me/punch/preview'), { body: { direction: 'in', channel: 'web', lat: centre.lat + 0.0003, lng: centre.lng, accuracy: 15 } }), 200, 'preview').data;
    eq(p.verdict.verdict, 'allowed', 'verdict'); eq(p.verdict.geofenceId, fence.id, 'deciding fence'); eq(p.refusals.length, 0, `refusals (${p.refusals})`);
    return `allowed, ${p.verdict.distanceM} m`;
  });
  await flow.step('preview ~5.5 km outside the fence', 'verdict denied_outside, refusal OUTSIDE_GEOFENCE', async () => {
    const p = expectStatus(await http(employee, 'POST', org('/me/punch/preview'), { body: { direction: 'in', channel: 'web', lat: centre.lat + 0.05, lng: centre.lng, accuracy: 15 } }), 200, 'preview').data;
    eq(p.verdict.verdict, 'denied_outside', 'verdict'); check(p.refusals.includes('OUTSIDE_GEOFENCE'), `refusals ${p.refusals}`);
    return `${p.verdict.verdict}, ${p.verdict.distanceM} m`;
  });
  await flow.step('punch outside the fence is refused and not stored', '403 OUTSIDE_GEOFENCE, no new punch', async () => {
    const r = await http(employee, 'POST', org('/me/punch'), { body: { direction: before.lastDirection === 'in' ? 'out' : 'in', channel: 'web', lat: centre.lat + 0.05, lng: centre.lng, accuracy: 15, idempotencyKey: idemKey('f1-outside') } });
    expectStatus(r, 403, 'outside punch'); eq(r.details?.reason, 'OUTSIDE_GEOFENCE', 'details.reason');
    const after = expectStatus(await http(employee, 'GET', org('/me/punch/status')), 200, 'status').data;
    eq(after.punches.length, before.punches.length, 'punches today');
    return '403 OUTSIDE_GEOFENCE';
  });
  // the engine attributes a punch to the day whose shift punch window holds it (blueprint §G.3): shortly after midnight that is
  // yesterday's night-side window, so the punches' day is looked for on today and on yesterday
  const punchDays = [S.today, addDays(S.today, -1)];
  const dayBefore = {}; for (const d of punchDays) dayBefore[d] = await myDay(d);
  const inPunch = await flow.step('punch IN inside the fence', 'HTTP 201, verdict allowed, server time', async () => {
    const t0 = Date.now();
    const r = expectStatus(await http(employee, 'POST', org('/me/punch'), { body: { direction: 'in', channel: 'web', lat: centre.lat, lng: centre.lng, accuracy: 12, idempotencyKey: idemKey('f1-in') } }), 201, 'punch in').data;
    eq(r.replayed, false, 'replayed'); eq(r.punch.direction, 'in', 'direction'); eq(r.verdict.verdict, 'allowed', 'verdict');
    check(Math.abs(Date.parse(r.punch.punchedAt) - t0) < 60_000, `punchedAt ${r.punch.punchedAt} is the server's now`);
    return r.punch;
  });
  await flow.step('status shows IN', 'lastDirection in, canCheckIn false, canCheckOut true', async () => {
    const s = expectStatus(await http(employee, 'GET', org('/me/punch/status')), 200, 'status').data;
    eq(s.lastDirection, 'in', 'lastDirection'); eq(s.canCheckIn, false, 'canCheckIn'); eq(s.canCheckOut, true, 'canCheckOut');
    check(s.punches.some((p) => p.id === inPunch.id), 'the IN punch is listed');
    return `IN at ${inPunch.punchedAt}`;
  });
  const outPunch = await flow.step('punch OUT inside the fence', 'HTTP 201', async () => {
    const r = expectStatus(await http(employee, 'POST', org('/me/punch'), { body: { direction: 'out', channel: 'web', lat: centre.lat, lng: centre.lng, accuracy: 12, idempotencyKey: idemKey('f1-out') } }), 201, 'punch out').data;
    eq(r.punch.direction, 'out', 'direction');
    return r.punch;
  });
  await flow.step('status shows OUT', 'lastDirection out, canCheckIn true', async () => {
    const s = expectStatus(await http(employee, 'GET', org('/me/punch/status')), 200, 'status').data;
    eq(s.lastDirection, 'out', 'lastDirection'); eq(s.canCheckIn, true, 'canCheckIn');
    return 'OUT';
  });
  await flow.step('the worker normalises both punches', 'processingStatus normalized (bounded)', async () => poll('punches normalised', async () => {
    const s = expectStatus(await http(employee, 'GET', org('/me/punch/status')), 200, 'status').data;
    const mine = s.punches.filter((p) => p.id === inPunch.id || p.id === outPunch.id);
    return { done: mine.length === 2 && mine.every((p) => p.processingStatus === 'normalized'), value: mine.map((p) => p.processingStatus).join(','), state: mine.map((p) => p.processingStatus) };
  }));
  // The engine keeps a punch outside every shift's punch window out of the record and flags OUT_OF_WINDOW on its calendar day
  // (packages/domain attribute.ts; calculate.test "flags OUT_OF_WINDOW punches on the calendar day and keeps them out of the
  // record"). A day-shift employee punching between midnight and the shift's window therefore lands there: a run at that hour
  // asserts that rule instead.
  const day = await flow.step('the engine recomputes the day with the self-service punches', 'record computed after the OUT punch, SELF_SERVICE_PUNCH (or OUT_OF_WINDOW outside every shift window)', async () => poll('day recomputed', async () => {
    const days = []; for (const date of punchDays) days.push(await myDay(date));
    const after = (x) => !!x && Date.parse(x.computedAt) >= Date.parse(outPunch.punchedAt);
    const d = days.find((x) => after(x) && x.flags.includes('SELF_SERVICE_PUNCH') && x.punchCount >= (dayBefore[x.attendanceDate]?.punchCount ?? 0) + 2);
    // an unchanged recomputation is not rewritten (recompute.ts), so a repeat of the out-of-window case keeps the old computedAt:
    // it is accepted once the worker has had 45 s (it recomputes within ~30 s of normalising) to change the record
    const settled = (x) => after(x) || Date.now() - Date.parse(outPunch.punchedAt) >= 45_000;
    const stray = days.find((x) => !!x && settled(x) && x.attendanceDate === S.today && x.flags.includes('OUT_OF_WINDOW') && !x.flags.includes('SELF_SERVICE_PUNCH') && Date.parse(outPunch.punchedAt) < Date.parse(x.expectedStartAt ?? outPunch.punchedAt));
    const hit = d ?? (stray ? { ...stray, outOfWindow: true, id: undefined, status: `${stray.attendanceDate} OUT_OF_WINDOW (the punches are outside every shift window)` } : null);
    return { done: !!hit, value: hit, state: days.map((x) => x && { date: x.attendanceDate, computedAt: x.computedAt, flags: x.flags, punchCount: x.punchCount }) };
  }));
  if (day.outOfWindow) {
    flow.skip('punch count of the day grew by the two punches', `the punches (${inPunch.punchedAt}) fall outside every shift's punch window: kept out of the record, ${day.attendanceDate} flagged OUT_OF_WINDOW`);
  } else {
    await flow.step('punch count of the day grew by the two punches', 'punchCount ≥ before + 2', () => { const was = dayBefore[day.attendanceDate]?.punchCount ?? 0; check(day.punchCount >= was + 2, `punchCount ${day.punchCount}`); return `${day.attendanceDate} ${day.status} ${was} → ${day.punchCount} punches`; });
  }
  await flow.step('stats endpoint returns the day', 'range ends today, the day counted', async () => {
    const st = expectStatus(await http(employee, 'GET', org('/me/stats?range=30d')), 200, 'stats').data;
    eq(st.to, S.today, 'stats.to'); check(st.workedDays >= 1, `workedDays ${st.workedDays}`);
    check(st.punctuality.last7Days.to === S.today, `last7Days.to ${st.punctuality.last7Days.to}`);
    return `${st.workedDays} worked days, ${st.attendancePct}%`;
  });
}

// ======================================================================================================== HR helpers ===

/** The employee's leave balances by leave type id (GET /me/leave). */
async function myLeave(year) { return expectStatus(await http(actors.employee, 'GET', org(`/me/leave${year ? `?year=${year}` : ''}`)), 200, 'GET /me/leave').data; }
const balanceOf = (leave, typeId) => leave.balances.find((b) => b.leaveTypeId === typeId);

/**
 * HR sets the status of employee-days (POST /attendance/bulk-status: one SET_STATUS correction each). A correction the
 * organisation's workflow routes for approval is driven through the engine (line manager, then the owner — HR filed it and
 * never decides its own request); the worker applies it and recomputes the day, which is polled until it shows the status.
 */
async function hrSetStatus(label, items, status) {
  const { hr, manager, owner } = actors;
  const res = expectStatus(await http(hr, 'POST', org('/attendance/bulk-status'), { body: { items, status, reason: `${TAG} ${label}` }, headers: { 'idempotency-key': idemKey(`bulk-${label}-${status}`) } }), 200, 'POST bulk-status').data;
  eq(res.succeeded, items.length, `bulk-status succeeded (${short(res.results.map((r) => r.error?.code ?? r.approval))})`);
  const routed = [];
  for (const r of res.results) {
    if (r.approval !== 'PENDING') continue;
    const list = expectStatus(await http(hr, 'GET', org(`/attendance/corrections?employeeId=${r.employeeId}&from=${r.date}&to=${r.date}&pageSize=100`)), 200, 'GET corrections').data;
    const c = list.find((x) => x.id === r.correctionId);
    check(c?.approvalRequestId, `correction ${r.correctionId} carries its approval request`);
    const out = await driveApproval(c.approvalRequestId, [manager, owner], `${TAG} ${label}`);
    eq(out.status, 'APPROVED', 'correction request');
    routed.push(out.decisions.map((d) => `L${d.stepNo}:${d.actor}`).join('+'));
  }
  for (const it of items) {
    await poll(`${it.date} shows ${status}`, async () => {
      const t = expectStatus(await http(hr, 'GET', org(`/attendance/timeline?employeeId=${it.employeeId}&date=${it.date}`)), 200, 'GET timeline').data;
      return { done: t.status === status, value: t.status, state: t.status };
    });
  }
  return { results: res.results, routed };
}

/** Past days of the employee in this and last month (newest first), with the reasons already given. */
async function recentDays() {
  const days = [...(await myMonth(monthOf(S.today))).days, ...(await myMonth(prevMonth(monthOf(S.today)))).days]
    .filter((d) => d.attendanceDate < S.today).sort((a, b) => b.attendanceDate.localeCompare(a.attendanceDate));
  const notes = await myNotes();
  const withNote = new Set(notes.filter((n) => n.status !== 'rejected').map((n) => n.attendanceDate));
  return { days, withNote };
}
S.usedDates = new Set();

// ============================================================================================================ flow 2 ===

/** Late / absence reason → manager (scope=mine) and HR (oversight) see it → rejected with a half-day pay effect → re-given → approved. */
async function flowReasons(flow) {
  const { employee, manager, hr } = actors;
  let day = await flow.step('find a past day that needs an explanation and has none', 'late / absent / missing punch, no active reason', async () => {
    const { days, withNote } = await recentDays();
    for (const d of days.filter((x) => needsExplanation(x) && x.status !== 'LEAVE' && !withNote.has(x.attendanceDate)).slice(0, 6)) {
      const marks = await activeMarks(d.attendanceDate);
      if (!marks.some((m) => ['EXCUSED', 'PAY_EFFECT', 'LOP'].includes(m.kind))) return d;
    }
    return null;
  });
  if (!day) {
    // none left (a tenant whose late days all carry reasons): HR marks the latest ordinary working day absent — restored after
    day = await flow.step('no such day: HR marks a working day absent for the test', 'status ABSENT', async () => {
      const { days, withNote } = await recentDays();
      const d = days.find((x) => x.status === 'PRESENT' && !withNote.has(x.attendanceDate) && !S.usedDates.has(x.attendanceDate));
      check(d, 'no working day without a reason in the last two months');
      await hrSetStatus('f2-absent', [{ employeeId: employee.employeeId, date: d.attendanceDate }], 'ABSENT');
      flow.cleanup(`HR sets ${d.attendanceDate} back to PRESENT`, async () => { await hrSetStatus('f2-restore', [{ employeeId: employee.employeeId, date: d.attendanceDate }], 'PRESENT'); return 'PRESENT'; });
      return await myDay(d.attendanceDate);
    });
  }
  S.usedDates.add(day.attendanceDate);
  const category = day.status === 'ABSENT' ? 'absence_reason' : 'late_reason';
  const note = await flow.step(`employee explains ${day.attendanceDate} (${day.status} ${day.flags.join('/')})`, 'HTTP 201, pending, routed to the engine', async () => {
    const n = expectStatus(await http(employee, 'POST', org('/me/attendance/notes'), { body: { date: day.attendanceDate, category, note: `${TAG} the highway was closed after an accident` } }), 201, 'POST note').data;
    eq(n.status, 'pending', 'status'); check(!!n.approvalRequestId, 'approvalRequestId');
    return n;
  });
  await flow.step('manager sees it in scope=mine', 'listed, canReview, not oversight', async () => {
    const list = expectStatus(await http(manager, 'GET', org(`/attendance/notes?scope=mine&open=true&employeeId=${employee.employeeId}`)), 200, 'GET notes mine').data;
    const item = list.find((n) => n.id === note.id);
    check(item, 'the note is in the manager\'s queue'); eq(item.canReview, true, 'canReview'); eq(item.isOversight, false, 'isOversight');
    return `canReview, day ${item.dayStatus} ${item.dayFlags.join('/')}`;
  });
  await flow.step('HR sees it under oversight (scope=all)', 'listed, isOversight', async () => {
    const list = expectStatus(await http(hr, 'GET', org(`/attendance/notes?scope=all&employeeId=${employee.employeeId}&from=${day.attendanceDate}&to=${day.attendanceDate}`)), 200, 'GET notes all').data;
    const item = list.find((n) => n.id === note.id);
    check(item, 'the note is in the oversight list'); eq(item.isOversight, true, 'isOversight');
    return 'oversight';
  });
  const leaveBefore = await myLeave(Number(day.attendanceDate.slice(0, 4)));
  const review = await flow.step('manager rejects with a half-day pay effect', 'HTTP 200, rejected, charged to leave or LOP', async () => {
    const r = expectStatus(await http(manager, 'POST', org(`/attendance/notes/${note.id}/review`), { body: { decision: 'reject', payEffectDays: 0.5, reason: `${TAG} not accepted` } }), 200, 'review reject').data;
    eq(r.note.status, 'rejected', 'note status'); eq(r.terminal, true, 'terminal');
    check(r.charge && ['charged_leave', 'lop'].includes(r.charge.outcome), `charge ${short(r.charge)}`);
    return `${r.charge.outcome} ${r.charge.payEffectDays} day ${r.charge.leaveTypeCode ?? ''}`.trim();
  });
  const outcome = review.split(' ')[0];
  await flow.step('re-read: the reason is rejected and the day carries the charge', 'one active LOP / PAY_EFFECT mark of 0.5', async () => {
    const n = (await myNotes()).find((x) => x.id === note.id);
    eq(n.status, 'rejected', 'note status'); eq(n.payEffectDays, 0.5, 'payEffectDays');
    const charged = (await activeMarks(day.attendanceDate)).filter((m) => m.kind === 'LOP' || m.kind === 'PAY_EFFECT');
    check(charged.length === 1 && charged[0].payEffectDays === 0.5, `active charge marks ${short(charged.map((m) => `${m.kind}:${m.payEffectDays}`))}`);
    if (outcome === 'lop') eq(n.lossOfPay, true, 'lossOfPay');
    if (outcome === 'charged_leave') {
      const after = await myLeave(Number(day.attendanceDate.slice(0, 4)));
      const code = n.deductedLeaveTypeCode; const b0 = leaveBefore.balances.find((b) => b.code === code); const b1 = after.balances.find((b) => b.code === code);
      check(b0 && b1 && b1.takenDays === b0.takenDays + 0.5, `${code} taken ${b0?.takenDays} → ${b1?.takenDays}`);
    }
    return `${charged[0].kind} ${charged[0].payEffectDays}`;
  });
  await flow.step('the employee is told the reason was rejected (in-app)', 'attendance.note_decided, rejected', async () => {
    const n = await awaitNotification(employee, 'rejection notice', (x) => x.type === 'attendance.note_decided' && about(note.id)(x));
    eq(n.data?.decision, 'rejected', 'decision'); eq(n.data?.attendanceDate, day.attendanceDate, 'attendanceDate');
    return `"${n.title}"`;
  });
  const again = await flow.step('employee gives the reason again (re-submission)', 'HTTP 201, pending', async () => {
    const n = expectStatus(await http(employee, 'POST', org('/me/attendance/notes'), { body: { date: day.attendanceDate, category, note: `${TAG} with the police report number attached` } }), 201, 'POST note again').data;
    eq(n.status, 'pending', 'status'); check(n.id !== note.id, 'a new reason');
    return n;
  });
  await flow.step('manager approves the new reason', 'HTTP 200, approved', async () => {
    const r = expectStatus(await http(manager, 'POST', org(`/attendance/notes/${again.id}/review`), { body: { decision: 'approve', reason: `${TAG} accepted` } }), 200, 'review approve').data;
    eq(r.note.status, 'approved', 'note status');
    return 'approved';
  });
  await flow.step('the employee is told the new reason was approved (in-app)', 'attendance.note_decided, approved', async () => {
    const n = await awaitNotification(employee, 'approval notice', (x) => x.type === 'attendance.note_decided' && about(again.id)(x));
    eq(n.data?.decision, 'approved', 'decision');
    return `"${n.title}"`;
  });
  await flow.step('re-read: the charge is reversed', 'no active LOP / PAY_EFFECT / UNEXCUSED mark; balance restored', async () => {
    const marks = await activeMarks(day.attendanceDate);
    const left = marks.filter((m) => ['LOP', 'PAY_EFFECT', 'UNEXCUSED'].includes(m.kind));
    eq(left.length, 0, `active charge marks (${short(left.map((m) => m.kind))})`);
    if (outcome === 'charged_leave') {
      const after = await myLeave(Number(day.attendanceDate.slice(0, 4)));
      for (const b0 of leaveBefore.balances) { const b1 = after.balances.find((b) => b.leaveTypeId === b0.leaveTypeId); check(b1 && b1.takenDays === b0.takenDays, `${b0.code} taken ${b0.takenDays} → ${b1?.takenDays}`); }
    }
    const n = (await myNotes()).find((x) => x.id === again.id);
    eq(n.status, 'approved', 'note status');
    return 'reversed';
  });
}

// ============================================================================================================ flow 3 ===

/** A regularisation through a two-level workflow (manager → HR) is applied through corrections and the day recomputed. */
async function flowRegularisation(flow) {
  const { employee, manager, hr } = actors;
  const wf = await flow.step('HR creates a two-level REGULARISATION workflow (manager → HR admin)', 'HTTP 201', async () => {
    const w = expectStatus(await http(hr, 'POST', org('/approval-workflows'), { body: {
      name: `${TAG} regularisation manager → HR`, entityType: 'REGULARISATION', branchId: S.emp.branchId, isDefault: true, status: 'active',
      appliesTo: S.emp.departmentId ? { departmentIds: [S.emp.departmentId] } : {},
      steps: [{ order: 1, approverType: 'MANAGER', mode: 'ANY' }, { order: 2, approverType: 'HR_ADMIN', mode: 'ANY' }],
    } }), 201, 'POST approval-workflows').data;
    eq(w.steps.length, 2, 'levels');
    return w;
  });
  flow.cleanup('archive the workflow', async () => {
    expectStatus(await http(hr, 'DELETE', org(`/approval-workflows/${wf.id}`)), 204, 'DELETE workflow');
    const list = expectStatus(await http(hr, 'GET', org('/approval-workflows')), 200, 'GET workflows').data;
    check(!list.some((w) => w.id === wf.id), 'the archived workflow is no longer listed');
    return 'archived';
  });
  const day = await flow.step('pick a past working day with a check-out', 'a PRESENT day', async () => {
    const { days } = await recentDays();
    const regs = expectStatus(await http(employee, 'GET', org('/me/regularisations')), 200, 'GET regularisations').data;
    const pending = new Set(regs.filter((r) => r.status === 'pending').map((r) => r.attendanceDate));
    const d = days.find((x) => x.status === 'PRESENT' && x.lastOutAt && !pending.has(x.attendanceDate) && !S.usedDates.has(x.attendanceDate) && x.attendanceDate < addDays(S.today, -1));
    check(d, 'no PRESENT day with a check-out in the last two months');
    S.usedDates.add(d.attendanceDate);
    return d;
  });
  // 25 minutes after the last punch: clear of the rule set's duplicate-punch window (a punch 60 s after another is collapsed
  // into it by the engine — DUPLICATE_PUNCHES_COLLAPSED — so a 1-minute regularisation would leave the day unchanged)
  const proposedOutAt = new Date(Date.parse(day.lastOutAt) + 25 * 60_000).toISOString();
  const reg = await flow.step(`employee files a missed check-out for ${day.attendanceDate}`, 'HTTP 201, pending, 2 levels', async () => {
    const r = expectStatus(await http(employee, 'POST', org('/me/regularisations'), { body: { date: day.attendanceDate, type: 'missed_punch', proposedOutAt, reason: `${TAG} left through the side gate` } }), 201, 'POST regularisation').data;
    eq(r.status, 'pending', 'status'); eq(r.approvalStepCount, 2, 'levels');
    return r;
  });
  await flow.step('level 1: the manager approves', 'HTTP 200, request moves to level 2', async () => {
    const req = await getRequest(manager, reg.approvalRequestId);
    eq(req.workflowId, wf.id, 'workflow used'); eq(req.currentStep, 1, 'current level'); eq(req.abilities.canDecide, true, 'manager may decide level 1');
    const d = expectStatus(await http(manager, 'POST', org(`/approvals/${reg.approvalRequestId}/decide`), { body: { stepNo: 1, decision: 'APPROVE', comment: `${TAG} ok` } }), 200, 'decide L1').data;
    eq(d.status, 'PENDING', 'request status'); eq(d.currentStep, 2, 'current level');
    return 'level 2';
  });
  await flow.step('re-read: level 1 approved, level 2 waits for HR', 'L1 APPROVED, L2 PENDING, regularisation pending', async () => {
    const req = await getRequest(hr, reg.approvalRequestId);
    eq(req.steps[0].status, 'APPROVED', 'L1'); eq(req.steps[1].status, 'PENDING', 'L2'); eq(req.abilities.canDecide, true, 'HR may decide level 2');
    const r = expectStatus(await http(employee, 'GET', org('/me/regularisations')), 200, 'GET regularisations').data.find((x) => x.id === reg.id);
    eq(r.status, 'pending', 'regularisation status');
    return 'L2 pending';
  });
  await flow.step('level 2: HR approves', 'HTTP 200, APPROVED', async () => {
    const d = expectStatus(await http(hr, 'POST', org(`/approvals/${reg.approvalRequestId}/decide`), { body: { stepNo: 2, decision: 'APPROVE', comment: `${TAG} ok` } }), 200, 'decide L2').data;
    eq(d.status, 'APPROVED', 'request status');
    return 'APPROVED';
  });
  await flow.step('the regularisation is applied through a correction', 'approved, appliedCorrectionId set', async () => {
    const r = expectStatus(await http(employee, 'GET', org('/me/regularisations')), 200, 'GET regularisations').data.find((x) => x.id === reg.id);
    eq(r.status, 'approved', 'status'); check(!!r.appliedCorrectionId, 'appliedCorrectionId');
    return `correction ${r.appliedCorrectionId.slice(0, 8)}`;
  });
  await flow.step('the worker applies it and recomputes the day (bounded)', `lastOutAt = ${proposedOutAt}`, async () => poll('day recomputed with the regularised check-out', async () => {
    const d = await myDay(day.attendanceDate);
    return { done: !!d && d.lastOutAt === proposedOutAt && d.hasCorrection, value: `${d?.status} out ${d?.lastOutAt}`, state: { lastOutAt: d?.lastOutAt, hasCorrection: d?.hasCorrection } };
  }));
}

// ============================================================================================================ flow 4 ===

/** Working days from `from` on that are neither weekly off nor holiday nor already on leave for the employee. */
function freeWorkingDays(leave, from, count, taken = new Set()) {
  const off = new Set(leave.calendar.offDates ?? []);
  const holidays = new Set(leave.calendar.holidays ?? []);
  const weeklyOff = new Set(leave.calendar.weeklyOffDays ?? []);
  const busy = new Set();
  for (const r of leave.records.filter((x) => ['PENDING', 'APPROVED', 'INFO_REQUESTED'].includes(x.status))) {
    for (let d = r.startDate; d <= r.endDate; d = addDays(d, 1)) busy.add(d);
  }
  const out = [];
  for (let d = from; out.length < count && d.slice(0, 4) === from.slice(0, 4); d = addDays(d, 1)) {
    if (off.has(d) || holidays.has(d) || weeklyOff.has(weekday(d)) || busy.has(d) || taken.has(d)) continue;
    out.push(d);
  }
  return out;
}

/** Apply → edit → ask info → reply → approve → balance; self-approval refused; a second pending request withdrawn. */
async function flowLeave(flow) {
  const { employee, manager, hr } = actors;
  const leave0 = await myLeave();
  const type = await flow.step('employee reads leave types and balances', 'an ordinary paid type offered', async () => {
    const t = leave0.types.find((x) => ['AL', 'ANNUAL'].includes(x.code) && !x.compOff) ?? leave0.types.find((x) => x.isPaid && !x.compOff && x.requiresApproval !== false);
    check(t, `no requestable paid leave type (${leave0.types.map((x) => x.code)})`);
    check(balanceOf(leave0, t.id), `no balance row for ${t.code}`);
    return t;
  });
  const [d1, d2, d3] = await flow.step('pick three free working days ahead', 'three dates', () => {
    const days = freeWorkingDays(leave0, addDays(S.today, 40 + (parseInt(RUN_ID.slice(-2), 16) % 20)), 3);
    eq(days.length, 3, 'free working days left this year');
    return days;
  });
  const b0 = balanceOf(leave0, type.id);
  const rec = await flow.step(`apply ${type.code} for ${d1}`, 'HTTP 201, PENDING, routed', async () => {
    const r = expectStatus(await http(employee, 'POST', org('/me/leave'), { body: { leaveTypeId: type.id, startDate: d1, endDate: d1, reason: `${TAG} family event` } }), 201, 'POST /me/leave').data;
    eq(r.status, 'PENDING', 'status'); check(!!r.approvalRequestId, 'approvalRequestId');
    return r;
  });
  flow.cleanup(`HR cancels the ${type.code} leave of ${d1}–${d2}`, async () => {
    const r = await http(hr, 'DELETE', org(`/leave-records/${rec.id}`));
    expectStatus(r, [200, 204], 'DELETE leave-record');
    const after = (await myLeave()).records.find((x) => x.id === rec.id);
    eq(after.status, 'CANCELLED', 'leave status');
    return 'CANCELLED';
  });
  const edited = await flow.step(`employee edits it to ${d1}–${d2}`, 'HTTP 200, a new request replaces the old one', async () => {
    const r = expectStatus(await http(employee, 'PATCH', org(`/me/leave/${rec.id}`), { body: { endDate: d2, reason: `${TAG} family event, two days` } }), 200, 'PATCH /me/leave').data;
    eq(r.status, 'PENDING', 'status'); eq(r.endDate, d2, 'endDate'); check(r.approvalRequestId && r.approvalRequestId !== rec.approvalRequestId, 'a new approval request');
    const old = await getRequest(employee, rec.approvalRequestId);
    eq(old.status, 'INVALIDATED', 'the old request');
    return r;
  });
  const reqId = edited.approvalRequestId;
  await flow.step('manager asks for more information', 'HTTP 200; leave INFO_REQUESTED', async () => {
    const req = await getRequest(manager, reqId);
    eq(req.abilities.canRequestInfo, true, 'manager may ask');
    expectStatus(await http(manager, 'POST', org(`/approvals/${reqId}/request-info`), { body: { comment: `${TAG} who covers your tickets?` } }), 200, 'request-info');
    const r = (await myLeave()).records.find((x) => x.id === rec.id);
    eq(r.status, 'INFO_REQUESTED', 'leave status');
    return 'INFO_REQUESTED';
  });
  await flow.step('the employee is told about the question (in-app)', 'leave.info_requested', async () => {
    const n = await awaitNotification(employee, 'question notice', (x) => x.type === 'leave.info_requested' && about(rec.id)(x));
    return `"${n.title}"`;
  });
  await flow.step('employee replies', 'HTTP 200; leave PENDING again', async () => {
    const r = expectStatus(await http(employee, 'POST', org(`/me/leave/${rec.id}/reply`), { body: { body: `${TAG} Omar covers them` } }), 200, 'reply').data;
    eq(r.status, 'PENDING', 'status');
    const thread = expectStatus(await http(employee, 'GET', org(`/leave-records/${rec.id}/comments`)), 200, 'comments').data;
    check(thread.some((c) => c.kind === 'info_request') && thread.some((c) => c.kind === 'reply'), `thread kinds ${thread.map((c) => c.kind)}`);
    return 'PENDING, thread has the question and the reply';
  });
  await flow.step('employee tries to approve their own request', '403', async () => {
    const req = await getRequest(employee, reqId);
    eq(req.abilities.canDecide, false, 'abilities.canDecide');
    const r = await http(employee, 'POST', org(`/approvals/${reqId}/decide`), { body: { stepNo: req.currentStep, decision: 'APPROVE' } });
    expectStatus(r, 403, 'self-approval');
    eq((await getRequest(employee, reqId)).status, 'PENDING', 'request status after the attempt');
    return `403 ${r.code}`;
  });
  await flow.step('manager approves', 'HTTP 200, APPROVED', async () => {
    const req = await getRequest(manager, reqId);
    const d = expectStatus(await http(manager, 'POST', org(`/approvals/${reqId}/decide`), { body: { stepNo: req.currentStep, decision: 'APPROVE', comment: `${TAG} enjoy` } }), 200, 'decide').data;
    eq(d.status, 'APPROVED', 'request status');
    return 'APPROVED';
  });
  await flow.step('the employee is told the leave was approved (in-app)', 'leave.approved', async () => {
    const n = await awaitNotification(employee, 'approval notice', (x) => x.type === 'leave.approved' && about(rec.id)(x));
    eq(n.data?.startDate, d1, 'startDate'); eq(n.data?.endDate, d2, 'endDate');
    return `"${n.title}"`;
  });
  await flow.step('balance updates', `${type.code}: taken +${edited.days}, pending back`, async () => {
    const l = await myLeave();
    const r = l.records.find((x) => x.id === rec.id); eq(r.status, 'APPROVED', 'leave status');
    const b1 = balanceOf(l, type.id);
    check(b1.takenDays === b0.takenDays + edited.days, `taken ${b0.takenDays} → ${b1.takenDays} (+${edited.days} expected)`);
    check(b1.pendingDays === b0.pendingDays, `pending ${b0.pendingDays} → ${b1.pendingDays}`);
    return `taken ${b0.takenDays} → ${b1.takenDays}`;
  });
  const second = await flow.step(`a second request (${d3})`, 'HTTP 201, PENDING', async () => {
    const r = expectStatus(await http(employee, 'POST', org('/me/leave'), { body: { leaveTypeId: type.id, startDate: d3, endDate: d3, reason: `${TAG} second request` } }), 201, 'POST /me/leave').data;
    eq(r.status, 'PENDING', 'status');
    return r;
  });
  await flow.step('withdrawing it cancels its engine request', 'leave CANCELLED, request CANCELLED', async () => {
    const r = expectStatus(await http(employee, 'POST', org(`/me/leave/${second.id}/withdraw`), { body: { reason: `${TAG} plans changed` } }), 200, 'withdraw').data;
    eq(r.status, 'CANCELLED', 'leave status');
    const req = await getRequest(employee, second.approvalRequestId);
    eq(req.status, 'CANCELLED', 'engine request');
    return 'CANCELLED / CANCELLED';
  });
}

// ============================================================================================================ flow 5 ===

/** A shift swap between two employees on different shifts that day → approved → the two one-day assignments swapped. */
async function flowSwap(flow) {
  const { employee, manager, hr } = actors;
  let chosen = await flow.step('find a day and a colleague on a different shift', 'an eligible colleague', async () => {
    const mine = expectStatus(await http(employee, 'GET', org('/me/shift-swaps')), 200, 'GET my swaps').data;
    const busy = new Set(mine.filter((s) => ['pending', 'approved'].includes(s.status)).map((s) => s.swapDate));
    for (let i = 30; i <= 85; i += 1) {
      const date = addDays(S.today, i);
      if (busy.has(date)) continue;
      const cands = expectStatus(await http(employee, 'GET', org(`/me/shift-swaps/candidates?date=${date}`)), 200, 'GET candidates').data;
      const c = cands.find((x) => x.eligible && x.employeeId !== actors.manager.employeeId);
      if (c) return { date, colleague: c, created: null };
      if (i >= 40 && cands.some((x) => !x.isOff && x.shift)) {
        // nobody on another shift that day: HR gives one colleague a one-day assignment on another shift (removed after)
        const shifts = expectStatus(await http(hr, 'GET', org('/shifts?pageSize=100')), 200, 'GET shifts').data;
        const other = cands.find((x) => !x.isOff && x.shift && x.employeeId !== actors.manager.employeeId);
        const alt = other && shifts.find((s) => s.id !== other.shift.id && s.status === 'active' && s.type === 'FIXED');
        if (!other || !alt) continue;
        const a = expectStatus(await http(hr, 'POST', org('/shift-assignments'), { body: { targetType: 'EMPLOYEE', targetId: other.employeeId, shiftId: alt.id, effectiveFrom: date, effectiveTo: addDays(date, 1) } }), 201, 'POST shift-assignments').data;
        const again = expectStatus(await http(employee, 'GET', org(`/me/shift-swaps/candidates?date=${date}`)), 200, 'GET candidates').data.find((x) => x.employeeId === other.employeeId);
        if (again?.eligible) return { date, colleague: again, created: a };
        expectStatus(await http(hr, 'DELETE', org(`/shift-assignments/${a.id}`)), [200, 204], 'DELETE assignment');
      }
    }
    return null;
  });
  check(chosen, 'no day in the next 30–85 days has a colleague on another shift');
  if (chosen.created) flow.cleanup('remove the helper assignment', async () => { expectStatus(await http(hr, 'DELETE', org(`/shift-assignments/${chosen.created.id}`)), [200, 204], 'DELETE assignment'); return 'removed'; });
  const { date, colleague } = chosen;
  const myShiftBefore = await flow.step('HR resolves both shifts of that day', 'two different shifts', async () => {
    const a = expectStatus(await http(hr, 'GET', org(`/shifts/resolve?employeeId=${employee.employeeId}&date=${date}`)), 200, 'resolve mine').data;
    const b = expectStatus(await http(hr, 'GET', org(`/shifts/resolve?employeeId=${colleague.employeeId}&date=${date}`)), 200, 'resolve colleague').data;
    check(a.shift?.id && b.shift?.id && a.shift.id !== b.shift.id, `shifts ${a.shift?.code} / ${b.shift?.code}`);
    return { mine: a.shift.id, theirs: b.shift.id, mineCode: a.shift.code, theirsCode: b.shift.code };
  });
  const swap = await flow.step(`employee asks ${colleague.displayName} to swap ${date}`, 'HTTP 201, pending', async () => {
    const s = expectStatus(await http(employee, 'POST', org('/me/shift-swaps'), { body: { date, withEmployeeId: colleague.employeeId, reason: `${TAG} medical appointment in the morning` } }), 201, 'POST shift-swaps').data;
    eq(s.status, 'pending', 'status'); check(!!s.approvalRequestId, 'approvalRequestId');
    return s;
  });
  await flow.step('manager approves the swap', 'HTTP 200, APPROVED', async () => {
    const req = await getRequest(manager, swap.approvalRequestId);
    eq(req.context.kind, 'SHIFT_SWAP', 'context');
    const d = expectStatus(await http(manager, 'POST', org(`/approvals/${swap.approvalRequestId}/decide`), { body: { stepNo: req.currentStep, decision: 'APPROVE', comment: `${TAG} fine` } }), 200, 'decide').data;
    eq(d.status, 'APPROVED', 'request status');
    return 'APPROVED';
  });
  await flow.step('the two one-day assignments are swapped', 'each resolves to the other\'s shift that day', async () => {
    const s = expectStatus(await http(employee, 'GET', org('/me/shift-swaps')), 200, 'GET my swaps').data.find((x) => x.id === swap.id);
    eq(s.status, 'approved', 'swap status');
    const a = expectStatus(await http(hr, 'GET', org(`/shifts/resolve?employeeId=${employee.employeeId}&date=${date}`)), 200, 'resolve mine').data;
    const b = expectStatus(await http(hr, 'GET', org(`/shifts/resolve?employeeId=${colleague.employeeId}&date=${date}`)), 200, 'resolve colleague').data;
    eq(a.shift?.id, myShiftBefore.theirs, 'employee\'s shift that day'); eq(b.shift?.id, myShiftBefore.mine, 'colleague\'s shift that day');
    for (const [who, r] of [['employee', a], ['colleague', b]]) {
      // effective ranges are half-open [from, to): a one-day assignment ends the day after
      check(r.assignment?.targetType === 'EMPLOYEE' && r.assignment.effectiveFrom === date && r.assignment.effectiveTo === addDays(date, 1), `${who}: the deciding assignment is a one-day EMPLOYEE assignment (${r.assignment?.targetType} ${r.assignment?.effectiveFrom}..${r.assignment?.effectiveTo})`);
    }
    return `${myShiftBefore.mineCode} ⇄ ${myShiftBefore.theirsCode}`;
  });
}

// ============================================================================================================ flow 6 ===

/** HR bulk status on two rows, "sync punches", the monthly summary, a report schedule run now → a copy for the recipient. */
async function flowHr(flow) {
  const { employee, hr, delegate } = actors;
  const rowsPicked = await flow.step('pick two ordinary working days of the employee', 'two PRESENT days', async () => {
    const { days, withNote } = await recentDays();
    const picked = days.filter((x) => x.status === 'PRESENT' && !withNote.has(x.attendanceDate) && !S.usedDates.has(x.attendanceDate) && !x.hasCorrection && x.attendanceDate < addDays(S.today, -2)).slice(0, 2);
    eq(picked.length, 2, 'days found');
    for (const p of picked) S.usedDates.add(p.attendanceDate);
    return picked;
  });
  const items = rowsPicked.map((d) => ({ employeeId: employee.employeeId, date: d.attendanceDate }));
  await flow.step('HR bulk-sets them HALF_DAY', 'both applied (through the correction workflow when it routes them)', async () => {
    const out = await hrSetStatus('f6-half', items, 'HALF_DAY');
    return out.routed.length ? `approved by ${out.routed.join(', ')}` : 'auto-approved';
  });
  flow.cleanup('HR sets both days back to PRESENT', async () => { await hrSetStatus('f6-restore', items, 'PRESENT'); return 'PRESENT'; });
  await flow.step('the days read Manual HALF_DAY', 'manual-statuses lists both', async () => {
    const from = items.map((i) => i.date).sort()[0]; const to = items.map((i) => i.date).sort()[1];
    const m = expectStatus(await http(hr, 'GET', org(`/attendance/manual-statuses?from=${from}&to=${to}&employeeId=${employee.employeeId}`)), 200, 'GET manual-statuses').data;
    for (const it of items) check(m.some((x) => x.date === it.date && x.status === 'HALF_DAY'), `${it.date} manual HALF_DAY (${short(m)})`);
    return 'Manual HALF_DAY × 2';
  });
  const recalc = await flow.step('HR syncs punches (recalculate the range)', 'HTTP 202, queued', async () => {
    const from = items.map((i) => i.date).sort()[0]; const to = items.map((i) => i.date).sort()[1];
    const r = await http(hr, 'POST', org('/attendance/recalculate'), { body: { fromDate: from, toDate: to, employeeIds: [employee.employeeId], reason: `${TAG} sync punches` }, headers: { 'idempotency-key': idemKey('f6-recalc') } });
    expectStatus(r, 202, 'POST recalculate'); check(r.data.requestId && r.data.jobId, 'requestId + jobId');
    return r.data;
  });
  await flow.step('the recalculation completes (bounded)', 'COMPLETED; the manual status survives', async () => {
    await poll('recalculation completed', async () => {
      const list = expectStatus(await http(hr, 'GET', org('/attendance/recalculations?pageSize=50')), 200, 'GET recalculations').data;
      const r = list.find((x) => x.id === recalc.requestId);
      if (r?.status === 'FAILED') throw new AssertionFailure(`recalculation FAILED ${short(r.summary)}`);
      return { done: r?.status === 'COMPLETED', value: r, state: r?.status };
    });
    for (const it of items) { const t = expectStatus(await http(hr, 'GET', org(`/attendance/timeline?employeeId=${it.employeeId}&date=${it.date}`)), 200, 'timeline').data; eq(t.status, 'HALF_DAY', `${it.date} after the recalculation`); }
    return 'COMPLETED';
  });
  const month = monthOf(items[0].date);
  await flow.step(`HR reads the monthly summary of ${month}`, 'the employee\'s row, ≥ 2 half days', async () => {
    const r = await http(hr, 'GET', org(`/attendance/summary?month=${month}&employeeId=${employee.employeeId}`));
    expectStatus(r, 200, 'GET summary');
    const row = r.data.find((x) => x.employeeId === employee.employeeId);
    check(row, 'the employee\'s row'); check(row.halfDays >= (items.every((i) => monthOf(i.date) === month) ? 2 : 1), `halfDays ${row.halfDays}`);
    return `present ${row.presentDays}, half days ${row.halfDays}, worked ${row.daysWorked}`;
  });
  const recipient = delegate; // a member holding report.view + report.export + attendance.view (payroll)
  const schedule = await flow.step('HR creates a monthly report schedule for a recipient', 'HTTP 201', async () => {
    const s = expectStatus(await http(hr, 'POST', org('/report-schedules'), { body: {
      name: `${TAG} monthly attendance`, reportType: 'monthly_attendance', format: 'csv', filters: { employeeIds: [employee.employeeId] }, cadence: 'monthly', runDay: 1, runTime: '07:00',
      periodRule: 'previous_month', recipients: { userIds: [recipient.userId], roleKeys: [] }, channels: ['in_app'], isActive: true,
    } }), 201, 'POST report-schedules').data;
    const back = expectStatus(await http(hr, 'GET', org(`/report-schedules/${s.id}`)), 200, 'GET schedule').data;
    eq(back.isActive, true, 'isActive');
    return s;
  });
  flow.cleanup('delete the report schedule', async () => { expectStatus(await http(hr, 'DELETE', org(`/report-schedules/${schedule.id}`)), [200, 204], 'DELETE schedule'); expectStatus(await http(hr, 'GET', org(`/report-schedules/${schedule.id}`)), 404, 'GET deleted schedule'); return 'deleted'; });
  const runNow = await flow.step('HR runs it now', 'HTTP 202', async () => {
    const r = await http(hr, 'POST', org(`/report-schedules/${schedule.id}/run-now`), { body: {} });
    expectStatus(r, 202, 'run-now');
    return r.data;
  });
  await flow.step('a report request is created for the recipient', 'a delivery to the recipient with a report', async () => poll('delivery created', async () => {
    const list = expectStatus(await http(hr, 'GET', org(`/report-deliveries?scheduleId=${schedule.id}`)), 200, 'GET report-deliveries').data;
    const d = list.find((x) => x.scheduleId === schedule.id && x.recipientUserId === recipient.userId);
    return { done: !!d?.reportRequestId, value: d, state: d?.status ?? 'none' };
  }).then((d) => { S.delivery = d; return `${d.status} report ${d.reportRequestId.slice(0, 8)}`; }));
  if (MODE === 'local') {
    await flow.step('local: the worker generates the recipient\'s copy', 'report COMPLETED, delivery delivered', async () => poll('report generated', async () => {
      const reports = expectStatus(await http(recipient, 'GET', org('/reports?pageSize=50')), 200, 'GET reports as recipient').data;
      const rep = reports.find((x) => x.id === S.delivery.reportRequestId);
      if (rep?.status === 'FAILED') throw new AssertionFailure(`the report FAILED: ${short(rep.error ?? rep.errorMessage ?? rep)}`);
      const del = expectStatus(await http(hr, 'GET', org(`/report-deliveries?scheduleId=${schedule.id}`)), 200, 'GET report-deliveries').data.find((x) => x.id === S.delivery.id);
      return { done: rep?.status === 'COMPLETED' && del?.status === 'delivered', value: `report ${rep?.status}, delivery ${del?.status}`, state: { report: rep?.status, delivery: del?.status } };
    }));
  }
  void runNow;
}

// ================================================================================================ shared bits, 7–10 ===

/** The requestable paid leave type the flows use (flow 4's choice). */
function requestableType(leave) {
  const t = leave.types.find((x) => ['AL', 'ANNUAL'].includes(x.code) && !x.compOff) ?? leave.types.find((x) => x.isPaid && !x.compOff && x.requiresApproval !== false);
  check(t, `no requestable paid leave type (${leave.types.map((x) => x.code)})`);
  return t;
}

/** `count` free working days for a new leave request: from `offset` days ahead, else from tomorrow (every flow cancels its leave). */
async function pickLeaveDays(count, offset) {
  const from = async (d) => freeWorkingDays(await myLeave(Number(d.slice(0, 4))), d, count);
  let days = await from(addDays(S.today, offset));
  if (days.length < count) days = await from(addDays(S.today, 1));
  check(days.length === count, `only ${days.length} free working day(s) found for a leave request`);
  return days;
}

/** HR cancels a leave record (any state but CANCELLED); re-read until it reads CANCELLED. */
async function cancelLeave(id, year) {
  const current = (await myLeave(year)).records.find((x) => x.id === id);
  if (!current) return 'not found (nothing to cancel)';
  if (current.status === 'CANCELLED') return 'already CANCELLED';
  expectStatus(await http(actors.hr, 'DELETE', org(`/leave-records/${id}`)), [200, 204], 'DELETE leave-record');
  eq((await myLeave(year)).records.find((x) => x.id === id)?.status, 'CANCELLED', 'leave status after the cancellation');
  return 'CANCELLED';
}

/** The employee applies one day of leave (`extra` is merged into the body: the abuse pass adds foreign ids). HR cancels it when the flow ends. */
async function applyLeave(flow, label, date, extra = {}) {
  const year = Number(date.slice(0, 4));
  const type = requestableType(await myLeave(year));
  const r = expectStatus(await http(actors.employee, 'POST', org('/me/leave'), { body: { leaveTypeId: type.id, startDate: date, endDate: date, reason: `${TAG} ${label}`, ...extra } }), 201, 'POST /me/leave').data;
  flow.cleanup(`HR cancels the "${label}" leave of ${date}`, () => cancelLeave(r.id, year));
  eq(r.status, 'PENDING', 'leave status'); check(!!r.approvalRequestId, 'approvalRequestId');
  return r;
}

/** Where the employee punches: the centre of their branch (or of the seed's head office). */
async function branchCentre() {
  if (S.centre) return S.centre;
  const branch = expectStatus(await http(actors.hr, 'GET', org(`/branches/${S.emp.branchId}`)), 200, 'GET branch').data;
  S.centre = { lat: Number(branch.latitude ?? 23.588), lng: Number(branch.longitude ?? 58.3829) };
  return S.centre;
}

/** A temporary 150 m fence around the branch centre assigned to the employee, so their punches there are allowed whatever other fences say. */
async function temporaryFence(flow, label) {
  const centre = await branchCentre();
  const fence = await flow.step(`HR creates a temporary fence for the employee (${label})`, 'HTTP 201', async () => {
    const f = expectStatus(await http(actors.hr, 'POST', org('/geofences'), { body: { name: `${TAG} ${label}`, latitude: centre.lat, longitude: centre.lng, radiusM: 150, enforcement: 'hard_block', accuracyThresholdM: 100, isActive: true, assignments: [{ scope: 'employee', targetId: actors.employee.employeeId }] } }), 201, 'POST /geofences').data;
    return f;
  });
  flow.cleanup(`delete the fence "${label}"`, async () => { expectStatus(await http(actors.hr, 'DELETE', org(`/geofences/${fence.id}`)), 204, 'DELETE geofence'); return 'deleted'; });
  return fence;
}

async function punchStatus(actor = actors.employee) { return expectStatus(await http(actor, 'GET', org('/me/punch/status')), 200, 'GET /me/punch/status').data; }
/**
 * The organisation refuses a second punch in the same direction within `selfService.duplicatePunchSeconds` (a double tap, 409):
 * wait until the employee's last punch in `direction` is clear of that window, so a flow's punch is never mistaken for one.
 */
async function clearOfDuplicateWindow(direction) {
  const secs = Number(S.attendanceSettings?.selfService?.duplicatePunchSeconds ?? 60);
  const s = await punchStatus();
  const last = s.punches.filter((p) => p.direction === direction).map((p) => Date.parse(p.punchedAt)).sort((a, b) => b - a)[0];
  const wait = last === undefined ? 0 : last + (secs + 2) * 1000 - Date.now();
  if (wait > 0) { log(`waiting ${wait} ms: clear of the ${secs} s duplicate window`); await sleep(wait); }
  return s;
}
/** One web punch of the employee at the branch centre in the direction that follows their last one. */
async function punchNext(key, extra = {}) {
  const centre = await branchCentre();
  const s = await punchStatus();
  const direction = s.lastDirection === 'in' ? 'out' : 'in';
  await clearOfDuplicateWindow(direction);
  const res = await http(actors.employee, 'POST', org('/me/punch'), { body: { direction, channel: 'web', lat: centre.lat, lng: centre.lng, accuracy: 12, idempotencyKey: idemKey(key), ...extra } });
  return { res, direction, before: s };
}

// ============================================================================================================ flow 7 ===

/** The manager delegates leave approvals for today; a new request routes to the delegate, who decides it "for" the manager. */
async function flowDelegation(flow) {
  const { manager, hr, delegate } = actors;
  const delegation = await flow.step('manager delegates leave approvals to a colleague for today', 'HTTP 201, active', async () => {
    const cands = expectStatus(await http(manager, 'GET', org(`/approval-delegations/candidates?search=${encodeURIComponent(delegate.email.split('@')[0])}`)), 200, 'GET delegate candidates').data;
    check(cands.some((c) => c.userId === delegate.userId), `${delegate.email} is offered as a delegate`);
    const d = expectStatus(await http(manager, 'POST', org('/approval-delegations'), { body: { delegateUserId: delegate.userId, entityTypes: ['LEAVE'], startsOn: S.today, endsOn: S.today, reason: `${TAG} covering while the manager is away` } }), 201, 'POST approval-delegations').data;
    eq(d.isActive, true, 'isActive'); eq(d.delegatorUserId, manager.userId, 'delegator'); eq(d.delegateUserId, delegate.userId, 'delegate');
    const active = expectStatus(await http(manager, 'GET', org('/approval-delegations?scope=mine&activeOnly=true')), 200, 'GET delegations').data;
    check(active.some((x) => x.id === d.id), 'listed among the manager\'s active delegations');
    return d;
  });
  flow.cleanup('revoke the delegation', async () => {
    expectStatus(await http(manager, 'DELETE', org(`/approval-delegations/${delegation.id}`)), 204, 'DELETE delegation');
    const d = expectStatus(await http(manager, 'GET', org('/approval-delegations?scope=mine')), 200, 'GET delegations').data.find((x) => x.id === delegation.id);
    check(d && d.isActive === false && d.revokedAt, `revoked (${short(d)})`);
    return 'revoked';
  });
  const [date] = await flow.step('pick a free working day ahead', 'one date', () => pickLeaveDays(1, 62));
  const rec = await flow.step(`employee applies leave for ${date}`, 'HTTP 201, PENDING', () => applyLeave(flow, 'delegation', date));
  await flow.step('the request routes to the delegate, in the manager\'s seat', 'delegate\'s queue; canDecide; acting for the manager', async () => {
    const inbox = expectStatus(await http(delegate, 'GET', org('/approvals?scope=mine&entityType=LEAVE&pageSize=100')), 200, 'GET inbox as the delegate').data;
    const item = inbox.find((x) => x.id === rec.approvalRequestId);
    check(item, 'the request is in the delegate\'s queue');
    eq(item.abilities.canDecide, true, 'abilities.canDecide'); eq(item.abilities.actingAsDelegateOf, manager.userId, 'abilities.actingAsDelegateOf');
    const row = (await getRequest(delegate, rec.approvalRequestId)).steps[0].actors.find((a) => a.userId === delegate.userId);
    check(row && row.viaDelegationOf === manager.userId && row.decision === 'PENDING', `the delegate's row on level 1 (${short(row)})`);
    return `in the queue, for ${row.viaDelegationOfName}`;
  });
  await flow.step('the delegate is told a request waits for them (in-app)', 'approval.pending', async () => {
    const n = await awaitNotification(delegate, 'pending notice', (x) => x.type === 'approval.pending' && about(rec.approvalRequestId)(x));
    return `"${n.title}"`;
  });
  await flow.step('the delegate approves', 'HTTP 200, APPROVED', async () => {
    const req = await getRequest(delegate, rec.approvalRequestId);
    const d = expectStatus(await http(delegate, 'POST', org(`/approvals/${rec.approvalRequestId}/decide`), { body: { stepNo: req.currentStep, decision: 'APPROVE', comment: `${TAG} approved for the manager` } }), 200, 'decide as the delegate').data;
    eq(d.status, 'APPROVED', 'request status');
    return 'APPROVED';
  });
  await flow.step('history shows the decision "for <manager>"', 'actor = delegate, viaDelegationOf = manager; leave APPROVED', async () => {
    const req = await getRequest(hr, rec.approvalRequestId);
    const row = req.steps[0].actors.find((a) => a.decision === 'APPROVED');
    check(row, 'an approving actor on level 1');
    eq(row.userId, delegate.userId, 'approved by'); eq(row.viaDelegationOf, manager.userId, 'viaDelegationOf'); eq(row.viaDelegationOfName, manager.name, 'viaDelegationOfName');
    const ev = (req.events ?? []).find((e) => e.actorUserId === delegate.userId && e.detail?.via === 'delegate');
    check(ev && ev.detail.delegateOf === manager.userId, `a timeline entry decided through the delegation (${short((req.events ?? []).map((e) => `${e.kind}:${e.detail?.via ?? ''}`))})`);
    const hist = expectStatus(await http(delegate, 'GET', org('/approvals/history?scope=mine&entityType=LEAVE&pageSize=100')), 200, 'GET history as the delegate').data;
    check(hist.some((x) => x.id === rec.approvalRequestId), 'the request is in the delegate\'s history');
    eq((await myLeave(Number(date.slice(0, 4)))).records.find((x) => x.id === rec.id)?.status, 'APPROVED', 'leave status');
    return `${row.userName} for ${row.viaDelegationOfName}`;
  });
}

// ============================================================================================================ flow 8 ===

/** An overdue level escalates to HR: a 1-hour escalation, the worker's sweep run once with the clock two hours on (dev hook). */
async function flowEscalation(flow) {
  const { manager, hr } = actors;
  const wf = await flow.step('HR creates a LEAVE workflow whose level escalates to HR after 1 hour', 'HTTP 201', async () => {
    const w = expectStatus(await http(hr, 'POST', org('/approval-workflows'), { body: {
      name: `${TAG} leave with escalation`, entityType: 'LEAVE', branchId: S.emp.branchId, isDefault: true, status: 'active',
      appliesTo: S.emp.departmentId ? { departmentIds: [S.emp.departmentId] } : {},
      steps: [{ order: 1, approverType: 'MANAGER', mode: 'ANY', escalateAfterHours: 1, escalateTo: 'HR_ADMIN' }],
    } }), 201, 'POST approval-workflows').data;
    eq(w.steps[0].escalateAfterHours, 1, 'escalateAfterHours'); eq(w.steps[0].escalateTo, 'HR_ADMIN', 'escalateTo');
    return w;
  });
  flow.cleanup('archive the workflow', async () => {
    expectStatus(await http(hr, 'DELETE', org(`/approval-workflows/${wf.id}`)), 204, 'DELETE workflow');
    check(!expectStatus(await http(hr, 'GET', org('/approval-workflows')), 200, 'GET workflows').data.some((w) => w.id === wf.id), 'the archived workflow is no longer listed');
    return 'archived';
  });
  const [date] = await flow.step('pick a free working day ahead', 'one date', () => pickLeaveDays(1, 70));
  const rec = await flow.step(`employee applies leave for ${date}`, 'routed by the new workflow; level 1 due 1 hour after it started', async () => {
    const r = await applyLeave(flow, 'escalation', date);
    const req = await getRequest(hr, r.approvalRequestId);
    eq(req.workflowId, wf.id, 'workflow used');
    const s = req.steps[0];
    check(s.dueAt && s.escalateTo === 'HR_ADMIN' && !s.escalatedAt, `level 1: due ${s.dueAt}, escalateTo ${s.escalateTo}, escalatedAt ${s.escalatedAt}`);
    check(Math.abs(Date.parse(s.dueAt) - Date.parse(s.activatedAt) - 3_600_000) < 5_000, `due one hour after activation (${s.activatedAt} → ${s.dueAt})`);
    check(!s.actors.some((a) => a.userId === hr.userId), 'HR is not an approver before the escalation');
    return r;
  });
  await flow.step('the worker\'s approvals sweep runs once, an hour after the due time (dev hook)', 'escalated ≥ 1', async () => {
    const req = await getRequest(hr, rec.approvalRequestId);
    const at = new Date(Date.parse(req.steps[0].dueAt) + 3_600_000).toISOString();
    const out = runApprovalSweep(cfg.orgId, at);
    check(out.escalated >= 1, `sweep result ${short(out)}`);
    return `escalated ${out.escalated}, reminded ${out.reminded}, digests ${out.digests} (clock ${at})`;
  });
  await flow.step('HR is added to level 1 as an escalated approver', 'escalatedAt set; HR row "escalated"; HR may decide', async () => {
    const req = await getRequest(hr, rec.approvalRequestId);
    const s = req.steps[0];
    check(s.escalatedAt, 'escalatedAt');
    const row = s.actors.find((a) => a.userId === hr.userId);
    check(row && row.resolutionPath === 'escalated' && row.decision === 'PENDING', `HR's row (${short(row)})`);
    eq(req.abilities.canDecide, true, 'HR may decide'); eq(req.abilities.decideVia, 'escalated', 'decideVia');
    const ev = (req.events ?? []).find((e) => e.kind === 'escalated');
    check(ev && (ev.detail.added ?? []).includes(hr.userId) && ev.detail.target === 'HR_ADMIN', `escalation timeline entry (${short(ev)})`);
    return `escalated to ${ev.detail.added.length} HR admin(s)`;
  });
  await flow.step('HR is notified (approval.escalated)', 'an in-app notification about the request', async () => poll('escalation notification', async () => {
    const list = expectStatus(await http(hr, 'GET', `/me/notifications?organizationId=${cfg.orgId}&pageSize=50`), 200, 'GET notifications').data;
    const n = list.find((x) => x.type === 'approval.escalated' && (x.data?.aggregateId === rec.approvalRequestId || x.data?.requestId === rec.approvalRequestId));
    return { done: !!n, value: n ? `"${n.title}"` : null, state: list.slice(0, 3).map((x) => x.type) };
  }, { timeoutMs: 90_000 }));
  await flow.step('HR decides as the escalated approver: it fills the manager\'s seat', 'APPROVED, on behalf of the manager', async () => {
    const d = expectStatus(await http(hr, 'POST', org(`/approvals/${rec.approvalRequestId}/decide`), { body: { stepNo: 1, decision: 'APPROVE', comment: `${TAG} approved after the escalation` } }), 200, 'decide as the escalated approver').data;
    eq(d.status, 'APPROVED', 'request status');
    const row = (await getRequest(hr, rec.approvalRequestId)).steps[0].actors.find((a) => a.userId === hr.userId);
    eq(row.decision, 'APPROVED', 'HR decision'); eq(row.onBehalfOfUserId, manager.userId, 'seat filled');
    return `APPROVED for ${row.onBehalfOfName}`;
  });
}

// ============================================================================================================ flow 9 ===

/** The auditor reads attendance / leave / approvals and is refused every write; the Sohar branch manager cannot read HQ. */
async function flowReadOnly(flow) {
  const { auditor, branchManager, employee, hr } = actors;
  const empId = employee.employeeId;
  const day = addDays(S.today, -1);
  const month = monthOf(S.today);
  await flow.step('auditor reads attendance (timeline, monthly summary, day marks)', 'HTTP 200 ×3', async () => {
    expectStatus(await http(auditor, 'GET', org(`/attendance/timeline?employeeId=${empId}&date=${day}`)), 200, 'GET timeline');
    const sum = expectStatus(await http(auditor, 'GET', org(`/attendance/summary?month=${month}&employeeId=${empId}`)), 200, 'GET summary').data;
    expectStatus(await http(auditor, 'GET', org(`/attendance/day-marks?employeeId=${empId}&from=${addDays(S.today, -7)}&to=${day}`)), 200, 'GET day-marks');
    return `summary rows ${sum.length}`;
  });
  await flow.step('auditor reads leave (records, balances, calendar)', 'HTTP 200 ×3', async () => {
    const recs = expectStatus(await http(auditor, 'GET', org(`/leave-records?employeeId=${empId}&pageSize=20`)), 200, 'GET leave-records').data;
    expectStatus(await http(auditor, 'GET', org(`/leave-balances?employeeId=${empId}`)), 200, 'GET leave-balances');
    expectStatus(await http(auditor, 'GET', org(`/leave-calendar?month=${month}`)), 200, 'GET leave-calendar');
    return `${recs.length} leave record(s)`;
  });
  await flow.step('auditor reads approvals (organisation queue, history)', 'HTTP 200 ×2', async () => {
    const all = expectStatus(await http(auditor, 'GET', org('/approvals?scope=all&pageSize=20')), 200, 'GET approvals scope=all');
    expectStatus(await http(auditor, 'GET', org('/approvals/history?scope=all&pageSize=20')), 200, 'GET approvals history');
    return `${all.meta?.total ?? all.data.length} pending in the organisation`;
  });
  // a pending request the auditor tries to decide (withdrawn by HR at the end)
  const [date] = await flow.step('a pending leave request to try to decide', 'one date', () => pickLeaveDays(1, 78));
  const pending = await flow.step(`employee applies leave for ${date}`, 'HTTP 201, PENDING', () => applyLeave(flow, 'auditor probe', date));
  const leaveType = requestableType(await myLeave(Number(date.slice(0, 4))));
  const current = expectStatus(await http(hr, 'GET', org('/settings/attendance')), 200, 'GET settings/attendance').data;
  const writes = [
    ['create a geofence', 'POST', org('/geofences'), { name: `${TAG} auditor fence`, latitude: 23.6, longitude: 58.4, radiusM: 100, enforcement: 'advisory_log', accuracyThresholdM: 100, isActive: true },
      async () => !expectStatus(await http(hr, 'GET', org('/geofences?includeInactive=true')), 200, 'GET geofences').data.some((g) => g.name === `${TAG} auditor fence`)],
    ['change the attendance settings', 'PUT', org('/settings/attendance'), { ...current, selfService: { ...current.selfService, webCheckIn: !current.selfService.webCheckIn } },
      async () => expectStatus(await http(hr, 'GET', org('/settings/attendance')), 200, 'GET settings').data.selfService.webCheckIn === current.selfService.webCheckIn],
    ['create an approval workflow', 'POST', org('/approval-workflows'), { name: `${TAG} auditor workflow`, entityType: 'LEAVE', steps: [{ order: 1, approverType: 'MANAGER', mode: 'ANY' }], isDefault: false },
      async () => !expectStatus(await http(hr, 'GET', org('/approval-workflows')), 200, 'GET workflows').data.some((w) => w.name === `${TAG} auditor workflow`)],
    ['bulk-set a status', 'POST', org('/attendance/bulk-status'), { items: [{ employeeId: empId, date: day }], status: 'ABSENT', reason: `${TAG} auditor` }, null],
    ['recalculate a range', 'POST', org('/attendance/recalculate'), { fromDate: day, toDate: day, employeeIds: [empId], reason: `${TAG} auditor` }, null],
    ['create a leave record for the employee', 'POST', org('/leave-records'), { employeeId: empId, leaveTypeId: leaveType.id, startDate: date, endDate: date, reason: `${TAG} auditor` }, null],
    ['edit the employee', 'PATCH', org(`/employees/${empId}`), { middleName: 'Auditor' },
      async () => expectStatus(await http(hr, 'GET', org(`/employees/${empId}`)), 200, 'GET employee').data.middleName !== 'Auditor'],
    ['create a report schedule', 'POST', org('/report-schedules'), { name: `${TAG} auditor schedule`, reportType: 'monthly_attendance', format: 'csv', filters: {}, cadence: 'monthly', runDay: 1, runTime: '07:00', periodRule: 'previous_month', recipients: { userIds: [auditor.userId], roleKeys: [] }, channels: ['in_app'], isActive: true }, null],
    ['configure the Finance connector', 'PUT', org('/integrations/finance'), { enabled: true, deviceSerial: 'AUDITOR-PROBE', token: 'auditor-probe-token' }, null],
    ['create an approval delegation', 'POST', org('/approval-delegations'), { delegateUserId: hr.userId, startsOn: S.today, endsOn: S.today }, null],
    ['decide a pending request', 'POST', org(`/approvals/${pending.approvalRequestId}/decide`), { stepNo: 1, decision: 'APPROVE' },
      async () => (await getRequest(hr, pending.approvalRequestId)).status === 'PENDING'],
  ];
  for (const [what, method, p, body, unchanged] of writes) {
    await flow.step(`auditor tries to ${what}`, '403, nothing changed', async () => {
      const r = await http(auditor, method, p, { body, headers: { 'idempotency-key': idemKey(`auditor-${what}`) } });
      expectStatus(r, 403, `${method} ${p.replace(`/orgs/${cfg.orgId}`, '')}`);
      if (unchanged) check(await unchanged(), 'the refused write changed nothing');
      return `403 ${r.code}`;
    });
  }

  // ---- the Sohar branch manager
  const mine = branchManager.membership.branchIds;
  const own = await flow.step('branch manager reads an employee of their own branch (control)', 'HTTP 200', async () => {
    const list = expectStatus(await http(branchManager, 'GET', org(`/employees?branchId=${mine[0]}&pageSize=5`)), 200, 'GET employees of the branch').data;
    check(list.length > 0 && list.every((e) => mine.includes(e.branchId)), `employees of their branch only (${list.map((e) => e.branchId)})`);
    expectStatus(await http(branchManager, 'GET', org(`/employees/${list[0].id}`)), 200, 'GET an own-branch employee');
    return list[0];
  });
  check(!mine.includes(S.emp.branchId), 'the self-service employee is outside the branch manager\'s branches');
  await flow.step('branch manager reads an HQ employee by id', '403/404', async () => {
    const r = await http(branchManager, 'GET', org(`/employees/${empId}`)); expectStatus(r, [403, 404], 'GET other-branch employee');
    return `${r.status} ${r.code}`;
  });
  await flow.step('… their attendance and leave', '403/404, or no rows', async () => {
    const t = await http(branchManager, 'GET', org(`/attendance/timeline?employeeId=${empId}&date=${day}`)); expectStatus(t, [403, 404], 'GET timeline of an HQ employee');
    const l = await http(branchManager, 'GET', org(`/leave-records?employeeId=${empId}&pageSize=20`));
    if (l.status === 200) eq(l.data.length, 0, 'HQ leave records visible to the branch manager'); else expectStatus(l, [403, 404], 'GET leave-records of an HQ employee');
    const list = expectStatus(await http(branchManager, 'GET', org(`/employees?search=${encodeURIComponent(S.emp.employeeNumber)}`)), 200, 'search the HQ employee').data;
    check(!list.some((e) => e.id === empId), 'the HQ employee is not found by search');
    return `timeline ${t.status}, leave ${l.status}${l.status === 200 ? ' (0 rows)' : ''}, search 0`;
  });
  await flow.step('branch manager edits the HQ employee', '403/404, unchanged', async () => {
    const r = await http(branchManager, 'PATCH', org(`/employees/${empId}`), { body: { middleName: 'Branch' } }); expectStatus(r, [403, 404], 'PATCH other-branch employee');
    check(expectStatus(await http(hr, 'GET', org(`/employees/${empId}`)), 200, 'GET employee').data.middleName !== 'Branch', 'unchanged');
    return `${r.status} ${r.code}`;
  });
  await flow.step('branch manager reads a crafted employee id', '404', async () => {
    const r = await http(branchManager, 'GET', org(`/employees/${randomUUID()}`)); expectStatus(r, [403, 404], 'GET crafted id');
    return `${r.status} ${r.code}`;
  });
  void own;
}

// =========================================================================================================== flow 10 ===

/**
 * A tiny stand-in for Flowza Finance's two Edge Functions (docs/integrations/flowza-finance.md): `attendance-export` (keyset paging
 * on created_at|id with an opaque base64url cursor) and `attendance-ingest` (dedupe on serial|pin|time|state, ≤ 500 per batch).
 * Serial + token authenticate every call (401 otherwise). Listens on 127.0.0.1 only.
 */
async function startMockFinance({ serial, token, punches }) {
  const ingested = [];
  const requests = [];
  const seen = new Set();
  const cursorOf = (p) => Buffer.from(`${p.created_at}|${p.id}`, 'utf8').toString('base64url');
  const keyOf = (p) => [Date.parse(p.created_at), p.id];
  const after = (p, c) => { const [t, id] = keyOf(p); return t > c[0] || (t === c[0] && id > c[1]); };
  const server = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
    const chunks = []; for await (const c of req) chunks.push(c);
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(400, { error: 'Invalid JSON body' }); }
    const fn = new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/functions\/v1\//, '');
    requests.push({ fn, at: new Date().toISOString() });
    if (body.device_serial !== serial || body.token !== token) return send(401, { error: 'Unknown device or bad token' });
    if (fn === 'attendance-export') {
      const limit = Math.min(1000, Math.max(1, Number(body.limit) || 500));
      let since = null;
      if (typeof body.since === 'string') { const [at, id] = Buffer.from(body.since, 'base64url').toString('utf8').split('|'); if (at && id && Number.isFinite(Date.parse(at))) since = [Date.parse(at), id]; }
      const ordered = [...punches].sort((a, b) => keyOf(a)[0] - keyOf(b)[0] || (a.id < b.id ? -1 : 1));
      const rest = since ? ordered.filter((p) => after(p, since)) : ordered;
      const page = rest.slice(0, limit);
      return send(200, { organization_id: randomUUID(), device_id: randomUUID(), punches: page, has_more: rest.length > page.length, next_cursor: page.length ? cursorOf(page.at(-1)) : null, server_time: new Date().toISOString() });
    }
    if (fn === 'attendance-ingest') {
      const list = body.punches;
      if (!Array.isArray(list) || list.length === 0) return send(400, { error: 'punches must be a non-empty array' });
      if (list.length > 500) return send(400, { error: 'Max 500 punches per request' });
      let ok = 0; let duplicates = 0; let errors = 0;
      for (const p of list) {
        if (!p || typeof p.pin !== 'string' || !Number.isFinite(Date.parse(p.time))) { errors += 1; continue; }
        const k = `${serial}|${p.pin}|${p.time}|${p.state ?? ''}`;
        if (seen.has(k)) { duplicates += 1; continue; }
        seen.add(k); ok += 1; ingested.push(p);
      }
      return send(200, { ok: true, serial, source: 'agent_rest', received: list.length, ingested: ok, duplicates, unmapped: 0, errors, skipped: 0 });
    }
    return send(404, { error: `Function ${fn} not found` });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/functions/v1`, ingested, requests, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

/** Finance connector: test connection against a mock Finance, save, push and pull one punch each way, loop guard, disconnect. */
async function flowFinance(flow) {
  const { owner, employee } = actors;
  if (MODE === 'hosted') {
    if (process.env.E2E_FINANCE_TEST !== '1') { flow.skip('test connection against the sandbox Finance device', 'skipped: set E2E_FINANCE_TEST=1 to call the connector configured on the demo tenant'); flow.skipped = true; return; }
    await flow.step('owner tests the stored Finance connection (sandbox device)', 'ok: true', async () => {
      const cur = expectStatus(await http(owner, 'GET', org('/integrations/finance')), 200, 'GET integration').data;
      check(cur.configured && cur.hasToken, 'a connector with a stored token is configured on the demo tenant');
      const t = expectStatus(await http(owner, 'POST', org('/integrations/finance/test'), { body: {} }), 200, 'POST test').data;
      check(t.ok === true, `test connection: ${t.code ?? ''} ${t.message}`); eq(t.usedStoredCredentials, true, 'usedStoredCredentials');
      return `${t.message} (${t.latencyMs} ms)`;
    });
    return;
  }
  const serial = `E2E-${RUN_ID}`.slice(0, 60);
  const token = randomBytes(18).toString('base64url');
  // the Finance punch pulled: ten minutes ago (never before the start of today, the connector's start date), the employee's number as PIN
  const startOfToday = startOfDayUtc(S.today, S.tz);
  const pulledAt = new Date(Math.max(Math.floor((Date.now() - 10 * 60_000) / 1000) * 1000, startOfToday + 60_000)).toISOString();
  const fixture = { id: randomUUID(), employee_id: null, employee_number: S.emp.employeeNumber, pin: S.emp.employeeNumber, device_serial: 'FIN-MOBILE-E2E', time_utc: pulledAt, device_timezone: S.tz, verify: 'mobile', state: 'check_in', workcode: null, source: 'mobile', lat: null, lng: null, accuracy: null, geofence_verdict: null, geo_flagged: false, created_at: new Date().toISOString() };
  const mock = await startMockFinance({ serial, token, punches: [fixture] });
  flow.cleanup('stop the mock Finance server', async () => { await mock.close(); return `stopped after ${mock.requests.length} request(s)`; });
  let connected = false;
  flow.cleanup('disconnect the connector (if still connected)', async () => {
    if (!connected) return 'not connected';
    expectStatus(await http(owner, 'DELETE', org('/integrations/finance')), 200, 'DELETE integration');
    return 'disconnected';
  });

  await flow.step('owner tests the connection with unsaved values', 'ok, Finance\'s first punch reported', async () => {
    const t = expectStatus(await http(owner, 'POST', org('/integrations/finance/test'), { body: { baseUrl: mock.baseUrl, deviceSerial: serial, token } }), 200, 'POST test').data;
    check(t.ok === true, `test: ${t.code ?? ''} ${t.message}`); eq(t.usedStoredCredentials, false, 'usedStoredCredentials');
    eq(t.firstPunchAt ? Date.parse(t.firstPunchAt) : null, Date.parse(pulledAt), 'firstPunchAt');
    return `${t.message} (${t.latencyMs} ms)`;
  });
  await flow.step('a wrong token is reported, not saved', 'ok false, AUTH_FAILED', async () => {
    const t = expectStatus(await http(owner, 'POST', org('/integrations/finance/test'), { body: { baseUrl: mock.baseUrl, deviceSerial: serial, token: 'not-the-right-token' } }), 200, 'POST test').data;
    eq(t.ok, false, 'ok'); eq(t.code, 'AUTH_FAILED', 'code');
    return `${t.code}`;
  });
  await flow.step('owner saves the connector (both directions, start date today)', 'HTTP 200; token masked, never returned', async () => {
    const r = await http(owner, 'PUT', org('/integrations/finance'), { body: { enabled: true, baseUrl: mock.baseUrl, deviceSerial: serial, token, direction: 'both', pinKey: 'employee_number', pollMinutes: 60, syncFrom: S.today } });
    expectStatus(r, 200, 'PUT integration'); connected = true;
    const g = await http(owner, 'GET', org('/integrations/finance')); expectStatus(g, 200, 'GET integration');
    eq(g.data.configured, true, 'configured'); eq(g.data.enabled, true, 'enabled'); eq(g.data.hasToken, true, 'hasToken'); eq(g.data.deviceSerial, serial, 'deviceSerial'); eq(g.data.syncFrom, S.today, 'syncFrom');
    check(g.data.tokenMasked?.endsWith(token.slice(-4)) && !JSON.stringify(g.json).includes(token) && !JSON.stringify(r.json).includes(token), 'the token is masked and never echoed');
    return `${g.data.connectionStatus ?? 'saved'}, ${g.data.tokenMasked}`;
  });
  await flow.step('test with the stored credentials', 'ok, usedStoredCredentials', async () => {
    const t = expectStatus(await http(owner, 'POST', org('/integrations/finance/test'), { body: {} }), 200, 'POST test').data;
    check(t.ok === true, `test: ${t.code ?? ''} ${t.message}`); eq(t.usedStoredCredentials, true, 'usedStoredCredentials');
    return t.message;
  });
  await temporaryFence(flow, 'finance punch fence');
  const pushed = await flow.step('the employee punches on the web (the punch to push)', 'HTTP 201, normalised', async () => {
    const { res, direction } = await punchNext('f10-push');
    const p = expectStatus(res, 201, `punch ${direction}`).data.punch;
    await poll('punch normalised', async () => { const s = await punchStatus(); const mine = s.punches.find((x) => x.id === p.id); return { done: mine?.processingStatus === 'normalized', value: mine, state: mine?.processingStatus }; });
    return p;
  });
  const runSync = async (label) => {
    const r = await http(owner, 'POST', org('/integrations/finance/sync-now'), { body: {}, headers: { 'idempotency-key': idemKey(`f10-sync-${label}`) } });
    expectStatus(r, 202, 'POST sync-now'); check(r.data.pullJobId && r.data.pushJobId, `pull + push jobs (${short(r.data)})`);
    return poll(`sync ${label} finished`, async () => {
      const st = expectStatus(await http(owner, 'GET', org('/integrations/finance/status')), 200, 'GET status').data;
      const jobs = [r.data.pullJobId, r.data.pushJobId].map((id) => st.lastJobs.find((j) => j.id === id));
      const failed = jobs.find((j) => j && ['FAILED', 'CANCELLED'].includes(j.status));
      if (failed) throw new AssertionFailure(`${failed.jobType} ${failed.status}: ${failed.errorCode ?? ''} ${failed.error ?? ''}`);
      return { done: jobs.every((j) => j && ['SUCCESS', 'PARTIAL_SUCCESS'].includes(j.status)), value: { st, jobs }, state: jobs.map((j) => `${j?.jobType}:${j?.status}`) };
    });
  };
  await flow.step('sync now: the worker pulls and pushes (bounded)', 'both jobs SUCCESS', async () => {
    // a push run leaves events younger than FINANCE_PUSH_SETTLE_SECONDS (5 s, database clock) for the next run: let it settle
    await sleep(7_000);
    const { jobs } = await runSync('1');
    return jobs.map((j) => `${j.jobType} ${j.status} ${j.recordsIngested}`).join(', ');
  });
  await flow.step('push: Finance received the web punch (one "Sync now")', `pin ${S.emp.employeeNumber}, the punch's server time`, async () => {
    // one manual sync is enough: a "Sync now" that finds the connector's first scheduled push still running waits for it and
    // then sends what that run could not see (defect found by this flow — it used to succeed with nothing pushed)
    const hit = mock.ingested.find((p) => p.pin === S.emp.employeeNumber && Date.parse(p.time) === Date.parse(pushed.punchedAt));
    check(hit, `the punch reached attendance-ingest (${mock.ingested.length} punch(es) received; ${mock.ingested.filter((p) => p.pin === S.emp.employeeNumber).map((p) => p.time).join(', ')})`);
    return `${hit.state} ${hit.time} (${mock.ingested.length} pushed in all)`;
  });
  await flow.step('pull: Finance\'s punch reaches the employee', 'a normalised punch at the Finance time', async () => poll('pulled punch normalised', async () => {
    const s = await punchStatus();
    const p = s.punches.find((x) => Date.parse(x.punchedAt) === Date.parse(pulledAt));
    return { done: p?.processingStatus === 'normalized', value: `${p?.direction} ${p?.punchedAt} via ${p?.deviceName}`, state: p ? `${p.processingStatus} (${p.deviceName})` : 'not yet' };
  }));
  await flow.step('loop guard: a second sync never sends the pulled punch back', 'no ingest of the Finance punch', async () => {
    await runSync('2');
    check(!mock.ingested.some((p) => p.pin === S.emp.employeeNumber && Date.parse(p.time) === Date.parse(pulledAt)), 'the pulled punch was pushed back to Finance');
    const st = expectStatus(await http(owner, 'GET', org('/integrations/finance/status')), 200, 'GET status').data;
    eq(st.unmatchedCount, 0, 'unmatched pulled punches');
    return `${mock.ingested.length} punch(es) pushed, none of them Finance's own`;
  });
  await flow.step('owner disconnects', 'HTTP 200; disabled, token gone', async () => {
    const d = expectStatus(await http(owner, 'DELETE', org('/integrations/finance')), 200, 'DELETE integration').data;
    connected = false;
    const g = expectStatus(await http(owner, 'GET', org('/integrations/finance')), 200, 'GET integration').data;
    eq(g.enabled, false, 'enabled'); eq(g.hasToken, false, 'hasToken'); eq(d.hasToken, false, 'hasToken in the answer');
    return 'disconnected';
  });
  await flow.step('the employee checks out again (closing the day)', 'HTTP 201 or already out', async () => {
    const s = await punchStatus();
    if (s.lastDirection !== 'in') return 'already out';
    const { res } = await punchNext('f10-close'); expectStatus(res, 201, 'punch out');
    return 'out';
  });
}

// ============================================================================================================= abuse ===

/**
 * Another organisation to probe. Local mode: a real one — an outsider signs up (auth.users row + minted token, POST /orgs) and adds
 * one employee. Hosted mode: a random organisation id (hosted mode never creates data outside the demo tenant).
 */
async function otherOrganisation() {
  if (MODE !== 'local') return { orgId: randomUUID(), employeeId: randomUUID(), branchId: randomUUID(), outsider: null, real: false };
  const id = randomUUID();
  const email = `outsider+${RUN_ID}@e2e.flowza.invalid`;
  psql(`insert into auth.users (id, email, email_confirmed_at) values ('${id}', '${email}', now())`);
  const outsider = { role: 'outsider', email, userId: id, token: mintToken(id, email) };
  const o = expectStatus(await http(outsider, 'POST', '/orgs', { body: { displayName: `${TAG} outsider org`, ownerFullName: 'E2E Outsider' } }), 201, 'POST /orgs (outsider sign-up)').data;
  const orgB = o.organization.id;
  const branch = expectStatus(await http(outsider, 'GET', `/orgs/${orgB}/branches`), 200, 'GET branches of the other organisation').data[0];
  check(branch, 'the new organisation has a branch');
  const e = expectStatus(await http(outsider, 'POST', `/orgs/${orgB}/employees`, { body: { employeeNumber: 'E2E-1', firstName: 'Other', lastName: 'Tenant', joiningDate: addDays(S.today, -30), branchId: branch.id } }), 201, 'POST employee in the other organisation').data;
  return { orgId: orgB, employeeId: e.id, branchId: branch.id, outsider, real: true };
}

async function flowAbuse(flow) {
  const { employee, manager, hr } = actors;
  const other = await flow.step('another organisation to probe', MODE === 'local' ? 'a second organisation with one employee' : 'a random organisation id', async () => {
    const o = await otherOrganisation(); S.other = o;
    return o.real ? `org ${o.orgId.slice(0, 8)}, employee ${o.employeeId.slice(0, 8)}` : `random org ${o.orgId.slice(0, 8)}`;
  }).then(() => S.other);
  const B = (p) => `/orgs/${other.orgId}${p}`;

  // ---- another organisation's id in the path
  await flow.step('employee reads / punches in another organisation', '403/404 ×2, no punch recorded', async () => {
    const before = (await punchStatus()).punches.length;
    const a = await http(employee, 'GET', B(`/me/attendance?month=${monthOf(S.today)}`)); expectStatus(a, [403, 404], 'GET other org attendance');
    const centre = await branchCentre();
    const p = await http(employee, 'POST', B('/me/punch'), { body: { direction: 'in', channel: 'web', lat: centre.lat, lng: centre.lng, accuracy: 10, idempotencyKey: idemKey('abuse-other-org') } }); expectStatus(p, [403, 404], 'POST other org punch');
    eq((await punchStatus()).punches.length, before, 'punches today');
    return `${a.status} / ${p.status}`;
  });
  await flow.step('HR lists employees of another organisation', '403/404', async () => {
    const r = await http(hr, 'GET', B('/employees')); expectStatus(r, [403, 404], 'GET other org employees');
    return `${r.status} ${r.code}`;
  });
  await flow.step('HR reads / edits another organisation\'s employee through its own organisation', '404 ×2', async () => {
    const g = await http(hr, 'GET', org(`/employees/${other.employeeId}`)); expectStatus(g, [403, 404], 'GET foreign employee id');
    const p = await http(hr, 'PATCH', org(`/employees/${other.employeeId}`), { body: { middleName: 'Crossed' } }); expectStatus(p, [403, 404], 'PATCH foreign employee id');
    const b = await http(hr, 'POST', org('/attendance/bulk-status'), { body: { items: [{ employeeId: other.employeeId, date: addDays(S.today, -1) }], status: 'ABSENT', reason: `${TAG} foreign id` }, headers: { 'idempotency-key': idemKey('abuse-foreign-bulk') } });
    if (b.status === 200) eq(b.data.succeeded, 0, 'bulk-status on a foreign employee'); else expectStatus(b, [400, 403, 404], 'bulk-status on a foreign employee');
    if (other.real) eq(expectStatus(await http(other.outsider, 'GET', B(`/employees/${other.employeeId}`)), 200, 'owner of B reads the employee').data.middleName ?? null, null, 'the foreign employee is unchanged');
    return `GET ${g.status}, PATCH ${p.status}, bulk ${b.status}${b.status === 200 ? ` (${b.data.failed} failed)` : ''}`;
  });
  if (other.real) {
    await flow.step('the other organisation\'s owner reads this organisation', '403, and 404 through their own path', async () => {
      const a = await http(other.outsider, 'GET', org(`/employees/${employee.employeeId}`)); expectStatus(a, [403, 404], 'GET this org employee as outsider');
      const b = await http(other.outsider, 'GET', B(`/employees/${employee.employeeId}`)); expectStatus(b, [403, 404], 'GET this org employee id through org B');
      const c = await http(other.outsider, 'GET', org('/approvals?scope=all')); expectStatus(c, [403, 404], 'GET this org approvals as outsider');
      return `${a.status} / ${b.status} / ${c.status}`;
    });
  }

  // ---- client-supplied organisation / employee ids in bodies
  await temporaryFence(flow, 'abuse punch fence');
  const managerPunchesBefore = (await punchStatus(manager)).punches.length;
  let firstPunch = null;
  await flow.step('punch carrying another employee\'s id and another organisation\'s id', 'recorded for the caller only', async () => {
    const before = (await punchStatus()).punches.length;
    const { res, direction } = await punchNext('abuse-replay', { employeeId: manager.employeeId, organizationId: other.orgId });
    if (res.status === 400) return `400 ${res.code} (refused)`;
    firstPunch = expectStatus(res, 201, `punch ${direction}`).data.punch;
    eq((await punchStatus()).punches.length, before + 1, 'the caller\'s punches today');
    eq((await punchStatus(manager)).punches.length, managerPunchesBefore, 'the manager\'s punches today');
    return `201 for the caller (${direction})`;
  });
  await flow.step('the same punch replayed (same idempotency key)', 'the original returned, one row', async () => {
    check(firstPunch, 'the first punch was stored');
    const before = (await punchStatus()).punches.length;
    const r = await http(employee, 'POST', org('/me/punch'), { body: { direction: firstPunch.direction, channel: 'web', lat: S.centre.lat, lng: S.centre.lng, accuracy: 12, idempotencyKey: idemKey('abuse-replay'), employeeId: manager.employeeId, organizationId: other.orgId } });
    expectStatus(r, [200, 201], 'replayed punch');
    eq(r.data.replayed, true, 'replayed'); eq(r.data.punch.id, firstPunch.id, 'the original punch'); eq((await punchStatus()).punches.length, before, 'punches today');
    return `replayed ${r.data.punch.id.slice(0, 8)}`;
  });
  await flow.step('a future-dated / client-timestamped punch', 'the punch time is the server\'s clock', async () => {
    const direction = (await punchStatus()).lastDirection === 'in' ? 'out' : 'in';
    const s0 = await clearOfDuplicateWindow(direction);
    const base = { direction, channel: 'web', lat: S.centre.lat, lng: S.centre.lng, accuracy: 12 };
    const t0 = Date.now();
    let r = await http(employee, 'POST', org('/me/punch'), { body: { ...base, idempotencyKey: idemKey('abuse-future'), clientQueuedAt: new Date(t0 + 2 * 86_400_000).toISOString(), punchedAt: '2030-01-01T08:00:00.000Z', timestamp: '2030-01-01T08:00:00.000Z' } });
    let note = '';
    if (r.status === 400) {
      eq((await punchStatus()).punches.length, s0.punches.length, 'punches after the refused future time');
      note = 'future clientQueuedAt refused (400); ';
      r = await http(employee, 'POST', org('/me/punch'), { body: { ...base, idempotencyKey: idemKey('abuse-past'), clientQueuedAt: new Date(t0 - 3 * 86_400_000).toISOString(), punchedAt: '2020-01-01T08:00:00.000Z' } });
    }
    const p = expectStatus(r, 201, 'client-timestamped punch').data.punch;
    check(Math.abs(Date.parse(p.punchedAt) - t0) < 60_000, `punchedAt ${p.punchedAt} is the server's now`);
    const back = (await punchStatus()).punches.find((x) => x.id === p.id);
    check(back && Math.abs(Date.parse(back.punchedAt) - t0) < 60_000, `stored punchedAt ${back?.punchedAt}`);
    return `${note}stored at ${p.punchedAt}`;
  });
  await flow.step('leave request carrying another employee\'s id and another organisation\'s id', 'filed for the caller only', async () => {
    const [date] = await pickLeaveDays(1, 86);
    const r = await applyLeave(flow, 'foreign ids in the body', date, { employeeId: manager.employeeId, organizationId: other.orgId });
    check(!r.employeeId || r.employeeId === employee.employeeId, `employeeId ${r.employeeId}`);
    const mine = (await myLeave(Number(date.slice(0, 4)))).records.find((x) => x.id === r.id);
    check(mine, 'in the employee\'s own leave');
    const managerLeave = expectStatus(await http(manager, 'GET', org(`/me/leave?year=${date.slice(0, 4)}`)), 200, 'GET manager leave').data;
    check(!managerLeave.records.some((x) => x.id === r.id), 'not in the manager\'s leave');
    return 'filed for the caller';
  });
  await flow.step('HR creates a fence naming another organisation in the body', 'created in the path\'s organisation', async () => {
    const f = expectStatus(await http(hr, 'POST', org('/geofences'), { body: { name: `${TAG} foreign org body`, latitude: 23.6, longitude: 58.4, radiusM: 100, enforcement: 'advisory_log', accuracyThresholdM: 100, isActive: true, organizationId: other.orgId } }), 201, 'POST geofence').data;
    flow.cleanup('delete the fence of the foreign-id probe', async () => { expectStatus(await http(hr, 'DELETE', org(`/geofences/${f.id}`)), 204, 'DELETE geofence'); return 'deleted'; });
    eq(expectStatus(await http(hr, 'GET', org(`/geofences/${f.id}`)), 200, 'GET geofence').data.organizationId ?? cfg.orgId, cfg.orgId, 'organisation of the fence');
    if (other.real) expectStatus(await http(other.outsider, 'GET', B(`/geofences/${f.id}`)), [403, 404], 'the fence through the other organisation');
    return 'in this organisation';
  });

  // ---- decisions
  await flow.step('deciding a level twice', 'the second decision changes nothing', async () => {
    const [date] = await pickLeaveDays(1, 90);
    const r = await applyLeave(flow, 'double decision', date);
    const req = await getRequest(manager, r.approvalRequestId);
    expectStatus(await http(manager, 'POST', org(`/approvals/${r.approvalRequestId}/decide`), { body: { stepNo: req.currentStep, decision: 'APPROVE', comment: `${TAG} once` } }), 200, 'first decision');
    const first = await getRequest(hr, r.approvalRequestId);
    const again = await http(manager, 'POST', org(`/approvals/${r.approvalRequestId}/decide`), { body: { stepNo: req.currentStep, decision: 'REJECT', comment: `${TAG} twice` } });
    if (again.status === 200) eq(again.data.noop, true, 'noop'); else expectStatus(again, 409, 'second decision');
    const after = await getRequest(hr, r.approvalRequestId);
    eq(after.status, 'APPROVED', 'request status'); eq(after.completedAt, first.completedAt, 'completedAt');
    eq(JSON.stringify(after.steps.map((s) => s.actors.map((a) => [a.userId, a.decision, a.decidedAt]))), JSON.stringify(first.steps.map((s) => s.actors.map((a) => [a.userId, a.decision, a.decidedAt]))), 'actor rows');
    return again.status === 200 ? 'noop' : `409 ${again.code}`;
  });
  await flow.step('editing an approved reason', 'refused, unchanged', async () => {
    const approved = (await myNotes()).find((n) => n.status === 'approved');
    if (!approved) return 'no approved reason to probe (flow 2 creates one)';
    const r = await http(employee, 'PATCH', org(`/me/attendance/notes/${approved.id}`), { body: { note: `${TAG} rewritten after approval` } });
    expectStatus(r, [403, 409], 'PATCH approved note');
    const back = (await myNotes()).find((n) => n.id === approved.id);
    eq(back.note, approved.note, 'note text'); eq(back.status, 'approved', 'status');
    return `${r.status} ${r.code}`;
  });
  await flow.step('batches above their limits', '400 ×2', async () => {
    const days = Array.from({ length: 201 }, (_, i) => addDays(S.today, -1 - (i % 60)));
    const items = days.map((d, i) => ({ employeeId: i % 2 ? employee.employeeId : manager.employeeId, date: d }));
    const b = await http(hr, 'POST', org('/attendance/bulk-status'), { body: { items, status: 'ABSENT', reason: `${TAG} too many` }, headers: { 'idempotency-key': idemKey('abuse-bulk-201') } });
    expectStatus(b, 400, 'bulk-status with 201 items');
    const d = await http(hr, 'POST', org('/approvals/bulk-decide'), { body: { items: Array.from({ length: 101 }, () => ({ requestId: randomUUID(), stepNo: 1 })), decision: 'APPROVE' } });
    expectStatus(d, 400, 'bulk-decide with 101 items');
    return `${b.code} / ${d.code}`;
  });
  await flow.step('the employee checks out again (closing the day)', 'HTTP 201 or already out', async () => {
    const s = await punchStatus();
    if (s.lastDirection !== 'in') return 'already out';
    const { res } = await punchNext('abuse-close'); expectStatus(res, 201, 'punch out');
    return 'out';
  });
}

// ============================================================================================================== main ===

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  if (MODE === 'local') {
    if (args.reset) {
      console.log(`resetting and seeding ${cfg.db} …`);
      execFileSync('bash', [path.join(ROOT, 'scripts/db-reset-local.sh'), '--seed'], { cwd: ROOT, env: { ...process.env, PGHOST: cfg.pg.host, PGPORT: cfg.pg.port, PGUSER: cfg.pg.user, PGDATABASE: cfg.db }, stdio: ['ignore', 'ignore', 'inherit'] });
    }
    if (args.start) {
      console.log(`starting the API on :${cfg.apiPort} and the worker against ${cfg.db} (logs in ${RESULTS_DIR}) …`);
      startProcess('api', 'apps/api', 'src/index.ts');
      startProcess('worker', 'apps/worker', 'src/index.ts');
      await waitForApi();
    }
    if (args.serve) {
      console.log(`serving: API ${cfg.api}, JWT secret in E2E_JWT_SECRET=${cfg.jwtSecret} — Ctrl-C to stop`);
      await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
      return 0;
    }
  }
  const started = Date.now();
  let setupOk = true;
  await runFlow('0', 'setup: logins, fixtures, temporary settings', async (flow) => { await signIn(); await prerequisites(flow); });
  if (flowOutcomes.at(-1)?.status === 'FAIL') setupOk = false;
  if (setupOk) {
    await runFlow('1', 'employee check-in inside / outside a geofence, status, stats', flowCheckIn);
    await runFlow('2', 'late / absence reason: manager queue, HR oversight, reject with half-day pay effect, re-submit, approve', flowReasons);
    await runFlow('3', 'regularisation through a two-level workflow (manager → HR), applied, day recomputed', flowRegularisation);
    await runFlow('4', 'leave: apply, edit, ask info, reply, approve, balance; self-approval refused; withdraw', flowLeave);
    await runFlow('5', 'shift swap between two employees on different shifts → approved → assignments swapped', flowSwap);
    await runFlow('6', 'HR: bulk status, sync punches, monthly summary, report schedule run now', flowHr);
    await runFlow('7', 'delegation: a new request routes to the delegate, who decides it "for" the manager', flowDelegation);
    await runFlow('8', 'escalation: an overdue level escalates to HR (worker sweep, injected clock) and HR is notified', flowEscalation, { localOnly: true });
    await runFlow('9', 'read-only: the auditor reads and is refused every write; the Sohar branch manager cannot read HQ', flowReadOnly);
    await runFlow('10', 'Flowza Finance connector: test connection, push and pull one punch each way (mock Finance)', flowFinance);
    await runFlow('abuse', 'abuse pass: foreign ids in paths and bodies, replay, client time, double decision, approved reason, batch limits', flowAbuse);
  }
  // the temporary settings are restored whatever happened
  if (S.settingsChanged) {
    const t = performance.now();
    try { rows.push({ flow: '0', step: 'restore the attendance settings', expected: 'restored', actual: await restoreSettings(), status: 'PASS', ms: Math.round(performance.now() - t) }); }
    catch (err) { rows.push({ flow: '0', step: 'restore the attendance settings', expected: 'restored', actual: short(err.message), status: 'FAIL', ms: Math.round(performance.now() - t) }); flowOutcomes.push({ id: '0', title: 'restore settings', status: 'FAIL', ms: 0 }); }
  }
  printResults();
  const failedFlows = flowOutcomes.filter((f) => f.status === 'FAIL').length;
  const file = path.join(RESULTS_DIR, `${RUN_ID}-${MODE}.json`);
  writeFileSync(file, JSON.stringify({ runId: RUN_ID, mode: MODE, api: cfg.api, organizationId: cfg.orgId, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), flows: flowOutcomes, steps: rows, failedFlows }, null, 2));
  console.log(`\n${failedFlows === 0 ? 'ALL FLOWS PASSED' : `${failedFlows} flow(s) FAILED`} — run ${RUN_ID}, results in ${path.relative(ROOT, file)}`);
  return failedFlows;
}

let exitCode = 1;
try { exitCode = await main(); } catch (err) { console.error(err); exitCode = 99; } finally { await stopChildren(); }
process.exit(exitCode);
