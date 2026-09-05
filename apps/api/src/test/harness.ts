/**
 * API integration test harness: isolated test database (shim + all migrations), deterministic fixtures for two
 * organisations, and the real Hono app with a fake token verifier ('Bearer user:<uuid>').
 * Fixtures are loaded with the superuser connection (fixture loader, not application code).
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { createLogger } from '@flowza/shared';
import { createTestDatabase, PgJobQueue, DeviceCredentialsStore, SecretsCipher, type Database, type TestDatabase } from '@flowza/database';
import type { ProviderRegistry } from '@flowza/device-providers';
import { SYSTEM_ROLE_IDS } from '@flowza/contracts';
import { loadApiConfig } from '../config.js';
import { createApp } from '../app.js';
import type { ApiDeps } from '../deps.js';

export const F = {
  orgA: '0a000000-0000-0000-0000-000000000000',
  orgB: '0b000000-0000-0000-0000-000000000000',
  ownerA: 'a0000000-0000-0000-0000-000000000001',
  branchManagerA: 'a0000000-0000-0000-0000-000000000002',
  hrUserA: 'a0000000-0000-0000-0000-000000000004',
  ownerB: 'b0000000-0000-0000-0000-000000000001',
  platformAdmin: 'c0000000-0000-0000-0000-000000000001',
  invitee: 'd0000000-0000-0000-0000-000000000001',
  branchHQ: '0a000000-0000-0000-0000-00000000000b',
  branchB2: '0a000000-0000-0000-0000-00000000000c',
  branchBHQ: '0b000000-0000-0000-0000-00000000000b',
  deptOps: '0a000000-0000-0000-0000-0000000000d0',
  deptSales: '0a000000-0000-0000-0000-0000000000d2',
  desigEng: '0a000000-0000-0000-0000-0000000000f0',
  empE1: '0a000000-0000-0000-0000-0000000000e1', // HQ
  empE2: '0a000000-0000-0000-0000-0000000000e2', // B2
  empB1: '0b000000-0000-0000-0000-0000000000e1',
  deviceA: '0a000000-0000-0000-0000-0000000000d1',
  membershipOwnerA: '0a000000-0000-0000-0000-0000000000a1',
  membershipBmA: '0a000000-0000-0000-0000-0000000000a2',
  membershipHrA: '0a000000-0000-0000-0000-0000000000a4',
  syncJobA: '0a000000-0000-0000-0000-0000000000f1',
  RECORD_DATE: '2026-09-01',
} as const;

export const EMAILS: Record<string, string> = {
  [F.ownerA]: 'owner-a@test.local',
  [F.branchManagerA]: 'bm-a@test.local',
  [F.hrUserA]: 'hr-a@test.local',
  [F.ownerB]: 'owner-b@test.local',
  [F.platformAdmin]: 'platform@test.local',
  [F.invitee]: 'invitee@test.local',
};

export async function seedFixtures(admin: Database): Promise<void> {
  const users = Object.entries(EMAILS);
  for (const [id, email] of users) await sql`insert into auth.users (id, email) values (${id}::uuid, ${email})`.execute(admin);
  await admin.insertInto('userProfiles').values(users.map(([id, email]) => ({ id, email, fullName: email.split('@')[0]! }))).execute();
  await admin.insertInto('organizations').values([
    { id: F.orgA, companyCode: 'TEST-A', legalName: 'Org A LLC', displayName: 'Org A', timezone: 'Asia/Muscat' },
    { id: F.orgB, companyCode: 'TEST-B', legalName: 'Org B LLC', displayName: 'Org B', timezone: 'Asia/Muscat' },
  ]).execute();
  await admin.insertInto('organizationSettings').values([{ organizationId: F.orgA }, { organizationId: F.orgB }]).execute();
  await admin.insertInto('subscriptions').values([{ organizationId: F.orgA, planId: '20000000-0000-0000-0000-000000000003', status: 'active' }, { organizationId: F.orgB, planId: '20000000-0000-0000-0000-000000000001', status: 'trialing' }]).execute();
  await admin.insertInto('branches').values([
    { id: F.branchHQ, organizationId: F.orgA, code: 'A-HQ', name: 'A HQ', timezone: 'Asia/Muscat' },
    { id: F.branchB2, organizationId: F.orgA, code: 'A-2', name: 'A Branch 2', timezone: 'Asia/Muscat' },
    { id: F.branchBHQ, organizationId: F.orgB, code: 'B-HQ', name: 'B HQ', timezone: 'Asia/Muscat' },
  ]).execute();
  await admin.insertInto('departments').values([
    { id: F.deptOps, organizationId: F.orgA, code: 'OPS', name: 'Operations' },
    { id: F.deptSales, organizationId: F.orgA, code: 'SALES', name: 'Sales', parentId: F.deptOps },
  ]).execute();
  await admin.insertInto('designations').values({ id: F.desigEng, organizationId: F.orgA, code: 'ENG', name: 'Engineer', level: 3 }).execute();
  await admin.insertInto('employees').values([
    { id: F.empE1, organizationId: F.orgA, employeeNumber: 'E-001', firstName: 'Ali', lastName: 'Said', displayName: 'Ali Said', joiningDate: '2025-01-01', branchId: F.branchHQ, departmentId: F.deptOps, designationId: F.desigEng, deviceUserId: '1', email: 'ali@org-a.test' },
    { id: F.empE2, organizationId: F.orgA, employeeNumber: 'E-002', firstName: 'Sara', lastName: 'Nasser', displayName: 'Sara Nasser', joiningDate: '2025-01-01', branchId: F.branchB2, deviceUserId: '2' },
    { id: F.empB1, organizationId: F.orgB, employeeNumber: 'B-001', firstName: 'Omar', lastName: 'Khalid', displayName: 'Omar Khalid', joiningDate: '2025-01-01', branchId: F.branchBHQ, deviceUserId: '1' },
  ]).execute();
  await admin.insertInto('employmentHistory').values([
    { organizationId: F.orgA, employeeId: F.empE1, effectiveFrom: '2025-01-01', branchId: F.branchHQ, departmentId: F.deptOps, designationId: F.desigEng, employmentType: 'full_time', employmentStatus: 'active', reason: 'Joined' },
    { organizationId: F.orgA, employeeId: F.empE2, effectiveFrom: '2025-01-01', branchId: F.branchB2, employmentType: 'full_time', employmentStatus: 'active', reason: 'Joined' },
    { organizationId: F.orgB, employeeId: F.empB1, effectiveFrom: '2025-01-01', branchId: F.branchBHQ, employmentType: 'full_time', employmentStatus: 'active', reason: 'Joined' },
  ]).execute();
  await admin.insertInto('orgMemberships').values([
    { id: F.membershipOwnerA, organizationId: F.orgA, userId: F.ownerA, roleId: SYSTEM_ROLE_IDS.owner, status: 'active', allBranches: true, joinedAt: new Date() },
    { id: F.membershipBmA, organizationId: F.orgA, userId: F.branchManagerA, roleId: SYSTEM_ROLE_IDS.branch_manager, status: 'active', allBranches: false, joinedAt: new Date() },
    { id: F.membershipHrA, organizationId: F.orgA, userId: F.hrUserA, roleId: SYSTEM_ROLE_IDS.hr_user, status: 'active', allBranches: true, joinedAt: new Date() },
    { organizationId: F.orgB, userId: F.ownerB, roleId: SYSTEM_ROLE_IDS.owner, status: 'active', allBranches: true, joinedAt: new Date() },
  ]).execute();
  await admin.insertInto('membershipBranches').values({ membershipId: F.membershipBmA, branchId: F.branchB2 }).execute();
  await admin.insertInto('platformAdmins').values({ userId: F.platformAdmin, level: 'support' }).execute();
  await admin.insertInto('devices').values({ id: F.deviceA, organizationId: F.orgA, branchId: F.branchHQ, code: 'A-DEV-1', name: 'A Device 1', providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL', connectionStatus: 'online', serialNumber: 'SN-A-1' }).execute();
  await admin.insertInto('deviceEmployeeStates').values([
    { organizationId: F.orgA, deviceId: F.deviceA, employeeId: F.empE1, branchId: F.branchHQ, deviceUserId: '1', syncStatus: 'IN_SYNC' },
    { organizationId: F.orgA, deviceId: F.deviceA, employeeId: F.empE2, branchId: F.branchHQ, deviceUserId: '2', syncStatus: 'FAILED', lastErrorCode: 'TIMEOUT' },
  ]).execute();
  await admin.insertInto('attendanceDailyRecords').values([
    { organizationId: F.orgA, employeeId: F.empE1, attendanceDate: F.RECORD_DATE, branchId: F.branchHQ, timezone: 'Asia/Muscat', engineVersion: 'test', status: 'PRESENT', flags: ['LATE'], lateMinutes: 12, overtimeMinutes: 30, workedMinutes: 500 },
    { organizationId: F.orgA, employeeId: F.empE2, attendanceDate: F.RECORD_DATE, branchId: F.branchB2, timezone: 'Asia/Muscat', engineVersion: 'test', status: 'ABSENT' },
    { organizationId: F.orgB, employeeId: F.empB1, attendanceDate: F.RECORD_DATE, branchId: F.branchBHQ, timezone: 'Asia/Muscat', engineVersion: 'test', status: 'PRESENT' },
  ]).execute();
  await admin.insertInto('syncJobs').values({ id: F.syncJobA, organizationId: F.orgA, jobType: 'PULL_ATTENDANCE', trigger: 'SCHEDULED', correlationId: 'cor_test', status: 'FAILED', branchId: F.branchHQ }).execute();
  await admin.insertInto('syncJobItems').values({ organizationId: F.orgA, syncJobId: F.syncJobA, deviceId: F.deviceA, branchId: F.branchHQ, operation: 'PULL_ATTENDANCE', status: 'FAILED', lastErrorCode: 'TIMEOUT', finishedAt: new Date() }).execute();
  await admin.insertInto('approvalRequests').values({ organizationId: F.orgA, entityType: 'ATTENDANCE_CORRECTION', entityId: '0a000000-0000-0000-0000-0000000000c1', branchId: F.branchHQ, employeeId: F.empE1, status: 'PENDING' }).execute();
}

type FetchBody = NonNullable<Parameters<typeof fetch>[1]>['body'];

export interface TestApi {
  tdb: TestDatabase;
  deps: ApiDeps;
  request(method: string, path: string, opts?: { user?: string; body?: unknown; headers?: Record<string, string>; raw?: FetchBody }): Promise<{ status: number; json: any; headers: Headers; text: string }>;
  close(): Promise<void>;
}

/**
 * createTestDatabase() applies the shim, which sets the (cluster-wide) passwords of the application roles; two test
 * files migrating in parallel can collide on that pg_authid row ("tuple concurrently updated"), so retry a few times.
 */
async function createDatabaseWithRetry(name: string, attempts = 4): Promise<TestDatabase> {
  for (let i = 1; ; i++) {
    try {
      return await createTestDatabase(`${name}_${randomBytes(3).toString('hex')}`);
    } catch (err) {
      if (i >= attempts || !/concurrently updated|deadlock detected/i.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, 200 * i + Math.floor(Math.random() * 200)));
    }
  }
}

export async function createTestApi(name: string): Promise<TestApi> {
  const tdb = await createDatabaseWithRetry(`flowza_api_${name}_${process.pid}`);
  await seedFixtures(tdb.adminDb);
  const masterKey = randomBytes(32);
  const config = loadApiConfig({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', SUPABASE_URL: 'http://localhost:54321', SUPABASE_ANON_KEY: 'anon', DATABASE_URL_API: 'postgres://unused',
    FLOWZA_CREDENTIALS_MASTER_KEYS: `k1:${masterKey.toString('base64')}`, FLOWZA_DEVICE_PUSH_SECRET: 'test-push-secret', RATE_LIMIT_MAX: '100000', TRUST_PROXY: 'false',
  });
  const deps: ApiDeps = {
    config,
    log: createLogger({ name: 'flowza-api-test', level: 'silent' }),
    db: tdb.db,
    queue: new PgJobQueue(tdb.db),
    credentials: new DeviceCredentialsStore(new SecretsCipher([{ id: 'k1', material: masterKey }])),
    providers: { list: () => [] } as unknown as ProviderRegistry,
    verifyToken: async (token) => {
      const [kind, sub] = token.split(':');
      if (kind !== 'user' || !sub) throw new Error('bad token');
      return { sub, email: EMAILS[sub], role: 'authenticated', raw: {} };
    },
    realtime: { async publish() {} },
    storage: { async signedUrl() { return null; } },
  };
  const app = createApp(deps);
  return {
    tdb,
    deps,
    async request(method, path, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.user) headers['authorization'] = `Bearer user:${opts.user}`;
      let body: FetchBody | undefined = opts.raw;
      if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
      const res = await app.request(`/api/v1${path}`, { method, headers, body });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, json, headers: res.headers, text };
    },
    close: () => tdb.close(),
  };
}
