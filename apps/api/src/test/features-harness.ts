import { sql } from 'kysely';
import pg from 'pg';
import { createTestDatabase, DeviceCredentialsStore, PgJobQueue, SecretsCipher, type Database, type TestDatabase } from '@flowza/database';
import { defaultRegistry } from '@flowza/device-providers';
import { SYSTEM_ROLE_IDS } from '@flowza/contracts';
import { createLogger } from '@flowza/shared';
import type { ApiConfig } from '../config.js';
import type { ApiDeps } from '../deps.js';
import { createApp } from '../app.js';

/**
 * HTTP-level test harness for the feature modules: real Postgres (shim + migrations), the real Hono app, a fake token
 * verifier ("user:<uuid>" bearer tokens) and in-memory realtime/storage doubles. Fixtures are inserted with the superuser
 * client (RLS bypass) — the API itself always goes through flowza_api + RLS.
 */
export interface ApiHarness {
  tdb: TestDatabase;
  admin: Database;
  deps: ApiDeps;
  app: ReturnType<typeof createApp>;
  published: Array<{ channel: string; event: string; payload: Record<string, unknown> }>;
  signedUrls: string[];
  request: (method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string }) => Promise<{ status: number; body: any; text: string; headers: Headers }>;
  close: () => Promise<void>;
}

export const TEST_MASTER_KEYS = [{ id: 't', material: Buffer.alloc(32, 7) }];

/** Test databases share cluster-wide roles: creating several concurrently can fail with "tuple concurrently updated", so creation is serialised + retried. */
async function createDatabaseSerialised(name: string): Promise<TestDatabase> {
  const base = process.env.TEST_PG_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';
  const lock = new pg.Client({ connectionString: base });
  await lock.connect();
  try {
    await lock.query('select pg_advisory_lock(7242027)');
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await createTestDatabase(name); } catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); }
    }
    throw lastErr;
  } finally {
    await lock.query('select pg_advisory_unlock(7242027)').catch(() => undefined);
    await lock.end();
  }
}

export async function createApiHarness(name: string, opts: { config?: Partial<ApiConfig> } = {}): Promise<ApiHarness> {
  const tdb = await createDatabaseSerialised(name);
  const published: ApiHarness['published'] = [];
  const signedUrls: string[] = [];
  const config = {
    NODE_ENV: 'test', LOG_LEVEL: 'silent', API_PORT: 0, API_PUBLIC_URL: 'https://api.test', WEB_ORIGINS: 'http://web.test', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', DATABASE_URL_API: tdb.connectionString,
    DATABASE_POOL_MAX: 4, FLOWZA_CREDENTIALS_MASTER_KEYS: TEST_MASTER_KEYS, FLOWZA_DEVICE_PUSH_SECRET: 'push-secret-1', RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX: 10_000, TRUST_PROXY: true, webOrigins: ['http://web.test'], ...(opts.config ?? {}),
  } as unknown as ApiConfig;
  const deps: ApiDeps = {
    config,
    log: createLogger({ name: 'api-test', level: process.env.API_TEST_LOG ? 'error' : 'silent' }),
    db: tdb.db,
    queue: new PgJobQueue(tdb.db),
    credentials: new DeviceCredentialsStore(new SecretsCipher(TEST_MASTER_KEYS)),
    providers: defaultRegistry(),
    verifyToken: async (token: string) => {
      const m = /^user:([0-9a-f-]{36})(?::(.+))?$/i.exec(token);
      if (!m) throw new Error('bad test token');
      return { sub: m[1]!, email: m[2] ?? `${m[1]}@test.local`, role: 'authenticated', raw: {} };
    },
    realtime: { async publish(channel, event, payload) { published.push({ channel, event, payload }); } },
    storage: { async signedUrl(bucket, path, expires = 300) { if (path.includes('missing')) return null; const u = `https://storage.test/${bucket}/${path}?exp=${expires}`; signedUrls.push(u); return u; } },
  };
  // the feature routes are registered by createApp → registerV1Routes → registerFeatureRoutes (same auth/MFA chain as production)
  const app = createApp(deps);
  const request: ApiHarness['request'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer user:${o.token}`;
    let body: string | undefined;
    if (o.raw !== undefined) body = o.raw;
    else if (o.body !== undefined) { body = JSON.stringify(o.body); headers['content-type'] ??= 'application/json'; }
    const res = await app.request(path, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return { tdb, admin: tdb.adminDb, deps, app, published, signedUrls, request, close: () => tdb.close() };
}

// ----- fixtures -------------------------------------------------------------------------------------------------------------

export const ROLE = SYSTEM_ROLE_IDS;
export const PLAN_TRIAL = '20000000-0000-0000-0000-000000000001';

export interface OrgFixture {
  orgId: string; branchA: string; branchB: string; departmentA: string;
  owner: string; hrAdmin: string; hrUser: string; branchManagerB: string; managerUser: string; payrollUser: string; employeeUser: string; outsider: string;
  e1: string; e2: string; e3: string; deviceUserIds: { e1: string; e2: string; e3: string };
}

let seq = 0;
export function uuid(prefix = 'f'): string {
  seq += 1;
  const n = seq.toString(16).padStart(12, '0');
  return `${prefix}0000000-0000-4000-8000-${n}`;
}

export async function seedUser(admin: Database, id: string, email: string, fullName: string): Promise<void> {
  await sql`insert into auth.users (id, email) values (${id}::uuid, ${email}) on conflict do nothing`.execute(admin);
  await admin.insertInto('userProfiles').values({ id, email, fullName }).onConflict((oc) => oc.doNothing()).execute();
}
export async function seedMembership(admin: Database, orgId: string, userId: string, roleId: string, opts: { branchIds?: string[]; employeeId?: string | null } = {}): Promise<string> {
  const m = await admin.insertInto('orgMemberships').values({ organizationId: orgId, userId, roleId, status: 'active', allBranches: !opts.branchIds, employeeId: opts.employeeId ?? null, joinedAt: new Date() }).returning('id').executeTakeFirstOrThrow();
  if (opts.branchIds) await admin.insertInto('membershipBranches').values(opts.branchIds.map((branchId) => ({ membershipId: m.id, branchId }))).execute();
  return m.id;
}
export async function seedEmployee(admin: Database, orgId: string, branchId: string, n: number, extra: Partial<{ managerEmployeeId: string; departmentId: string; deviceUserId: string; employmentStatus: 'active' | 'terminated' }> = {}): Promise<string> {
  const id = uuid('e');
  await admin.insertInto('employees').values({ id, organizationId: orgId, branchId, employeeNumber: `EMP${n}`, firstName: `First${n}`, lastName: `Last${n}`, displayName: `Employee ${n}`, joiningDate: '2024-01-01', deviceUserId: extra.deviceUserId ?? String(1000 + n), employmentStatus: extra.employmentStatus ?? 'active', managerEmployeeId: extra.managerEmployeeId ?? null, departmentId: extra.departmentId ?? null }).execute();
  await admin.insertInto('employmentHistory').values({ organizationId: orgId, employeeId: id, effectiveFrom: '2024-01-01', effectiveTo: null, branchId, departmentId: extra.departmentId ?? null, designationId: null, managerEmployeeId: extra.managerEmployeeId ?? null, employmentType: 'full_time', employmentStatus: 'active', reason: 'Joined' }).execute();
  return id;
}

export async function seedOrg(admin: Database, tag: string, opts: { plan?: string | null } = {}): Promise<OrgFixture> {
  const orgId = uuid('a');
  await admin.insertInto('organizations').values({ id: orgId, companyCode: `ORG-${tag}`, legalName: `Org ${tag}`, displayName: `Org ${tag}`, timezone: 'Asia/Muscat' }).execute();
  await admin.insertInto('organizationSettings').values({ organizationId: orgId }).onConflict((oc) => oc.doNothing()).execute();
  if (opts.plan !== null) await admin.insertInto('subscriptions').values({ organizationId: orgId, planId: opts.plan ?? PLAN_TRIAL, status: 'active' }).execute();
  const branchA = uuid('b'); const branchB = uuid('b');
  await admin.insertInto('branches').values([{ id: branchA, organizationId: orgId, code: 'A', name: 'Branch A', timezone: 'Asia/Muscat' }, { id: branchB, organizationId: orgId, code: 'B', name: 'Branch B', timezone: 'Asia/Muscat' }]).execute();
  const departmentA = uuid('d');
  await admin.insertInto('departments').values({ id: departmentA, organizationId: orgId, code: 'OPS', name: 'Operations', branchId: branchA }).execute();
  const e3 = await seedEmployee(admin, orgId, branchA, 3, { departmentId: departmentA });
  const e1 = await seedEmployee(admin, orgId, branchA, 1, { managerEmployeeId: e3, departmentId: departmentA });
  const e2 = await seedEmployee(admin, orgId, branchB, 2);
  const users = { owner: uuid('c'), hrAdmin: uuid('c'), hrUser: uuid('c'), branchManagerB: uuid('c'), managerUser: uuid('c'), payrollUser: uuid('c'), employeeUser: uuid('c'), outsider: uuid('c') };
  for (const [k, id] of Object.entries(users)) await seedUser(admin, id, `${k}-${tag}@test.local`, k);
  await seedMembership(admin, orgId, users.owner, ROLE.owner);
  await seedMembership(admin, orgId, users.hrAdmin, ROLE.hr_admin);
  await seedMembership(admin, orgId, users.hrUser, ROLE.hr_user);
  await seedMembership(admin, orgId, users.branchManagerB, ROLE.branch_manager, { branchIds: [branchB] });
  await seedMembership(admin, orgId, users.managerUser, ROLE.hr_user, { employeeId: e3 });
  await seedMembership(admin, orgId, users.payrollUser, ROLE.payroll);
  await seedMembership(admin, orgId, users.employeeUser, ROLE.employee, { employeeId: e1 });
  return { orgId, branchA, branchB, departmentA, ...users, e1, e2, e3, deviceUserIds: { e1: '1001', e2: '1002', e3: '1003' } };
}

export interface DeviceFixtureOptions { providerKey?: string; integrationType?: 'VENDOR_CLOUD_PULL' | 'DEVICE_PUSH' | 'VENDOR_WEBHOOK'; serialNumber?: string | null; pushTokenHash?: string | null; capabilities?: Record<string, boolean>; config?: Record<string, unknown>; code?: string; status?: 'active' | 'disabled' }
export async function seedDevice(admin: Database, orgId: string, branchId: string, opts: DeviceFixtureOptions = {}): Promise<string> {
  const id = uuid('d');
  const caps = opts.capabilities ?? { attendancePull: true, employeePush: true, employeeDelete: true, deviceStatus: true, attendancePush: false, devicePush: false, webhooks: true };
  await admin.insertInto('devices').values({ id, organizationId: orgId, branchId, code: opts.code ?? `DEV-${id.slice(-6)}`, name: `Device ${id.slice(-4)}`, providerKey: opts.providerKey ?? 'mock', manufacturer: 'FlowZa', integrationType: opts.integrationType ?? 'VENDOR_CLOUD_PULL', serialNumber: opts.serialNumber ?? null, pushTokenHash: opts.pushTokenHash ?? null, capabilities: JSON.stringify(caps), config: JSON.stringify(opts.config ?? { scenario: 'healthy' }), timezone: 'Asia/Muscat', status: opts.status ?? 'active' }).execute();
  return id;
}

export async function queueJobs(admin: Database, jobType?: string): Promise<Array<{ id: string; jobType: string; queueName: string; organizationId: string | null; payload: Record<string, unknown>; dedupeKey: string | null; status: string }>> {
  let q = admin.selectFrom('jobs.queue').select(['id', 'jobType', 'queueName', 'organizationId', 'payload', 'dedupeKey', 'status']);
  if (jobType) q = q.where('jobType', '=', jobType);
  return (await q.orderBy('id').execute()).map((r) => ({ ...r, id: String(r.id), payload: r.payload as Record<string, unknown> }));
}
export async function auditRows(admin: Database, action: string) {
  return admin.selectFrom('audit.logs').selectAll().where('action', '=', action).orderBy('id', 'desc').execute();
}
export async function domainEvents(admin: Database, eventType: string) {
  return admin.selectFrom('domainEvents').selectAll().where('eventType', '=', eventType).execute();
}
export function isoToday(offsetDays = 0): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
