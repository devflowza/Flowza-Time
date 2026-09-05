import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from './testing/index.js';
import { PgJobQueue } from './queue.js';
import { withContext } from './context.js';
import { DeviceCredentialsStore, SecretsCipher } from './secrets.js';
import { writeAudit } from './audit.js';

const ORG_A = '0a000000-0000-0000-0000-000000000000';
const ORG_B = '0b000000-0000-0000-0000-000000000000';
const USER_A = 'a0000000-0000-0000-0000-000000000001';
const BRANCH_A = '0a000000-0000-0000-0000-00000000000b';
const DEVICE_A = '0a000000-0000-0000-0000-0000000000d1';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase(`flowza_dbpkg_${process.pid}`);
  const admin = tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${USER_A}, 'owner-a@test.local')`.execute(admin);
  await admin.insertInto('userProfiles').values({ id: USER_A, email: 'owner-a@test.local', fullName: 'Owner A' }).execute();
  await admin.insertInto('organizations').values([
    { id: ORG_A, companyCode: 'DBT-A', legalName: 'A', displayName: 'A' },
    { id: ORG_B, companyCode: 'DBT-B', legalName: 'B', displayName: 'B' },
  ]).execute();
  await admin.insertInto('branches').values({ id: BRANCH_A, organizationId: ORG_A, code: 'HQ', name: 'HQ' }).execute();
  await admin.insertInto('orgMemberships').values({ organizationId: ORG_A, userId: USER_A, roleId: '10000000-0000-0000-0000-000000000001', status: 'active', allBranches: true }).execute();
  await admin.insertInto('devices').values({ id: DEVICE_A, organizationId: ORG_A, branchId: BRANCH_A, code: 'D1', name: 'D1', providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL' }).execute();
});
afterAll(async () => { await tdb?.close(); });

describe('PgJobQueue', () => {
  it('enqueues idempotently, dequeues fairly, retries with backoff and dead-letters', async () => {
    const q = new PgJobQueue(tdb.workerDb);
    const id1 = await q.enqueue({ queue: 'sync', jobType: 'PULL', organizationId: ORG_A, payload: { n: 1 }, dedupeKey: 'pull:1', maxAttempts: 2 });
    const id1b = await q.enqueue({ queue: 'sync', jobType: 'PULL', organizationId: ORG_A, payload: { n: 1 }, dedupeKey: 'pull:1' });
    expect(id1b).toBe(id1);
    await q.enqueue({ queue: 'sync', jobType: 'PULL', organizationId: ORG_A, payload: { n: 2 }, priority: 9 });
    const idB = await q.enqueue({ queue: 'sync', jobType: 'PULL', organizationId: ORG_B, payload: { n: 3 }, priority: 1 });

    const first = await q.dequeue('w1', ['sync'], 1, 1);
    expect(first).toHaveLength(1);
    expect(first[0]!.organizationId).toBe(ORG_A);
    expect(first[0]!.priority).toBe(9);
    // org A already has one running and the cap is 1 → org B must be served next despite lower priority
    const second = await q.dequeue('w1', ['sync'], 1, 1);
    expect(second[0]!.id).toBe(idB);
    // nothing else eligible while A is capped
    expect(await q.dequeue('w1', ['sync'], 5, 1)).toHaveLength(0);
    await q.complete(first[0]!.id);
    await q.complete(idB);
    const third = await q.dequeue('w1', ['sync'], 1, 5);
    expect(third[0]!.id).toBe(id1);
    expect(await q.fail(third[0]!.id, 'TIMEOUT', 'boom')).toBe('pending');
    // retry is delayed → not immediately dequeuable
    expect(await q.dequeue('w1', ['sync'], 1, 5)).toHaveLength(0);
    await sql`update jobs.queue set run_at = now() where id = ${id1}::bigint`.execute(tdb.adminDb);
    const again = await q.dequeue('w1', ['sync'], 1, 5);
    expect(again[0]!.attempts).toBe(2);
    expect(await q.fail(again[0]!.id, 'TIMEOUT', 'boom again')).toBe('dead');
    const stats = await q.stats();
    expect(stats.every((s) => s.status !== 'running')).toBe(true);
    const archived = await sql<{ status: string }>`select status from jobs.queue_archive where id = ${id1}::bigint`.execute(tdb.adminDb);
    expect(archived.rows[0]!.status).toBe('dead');
  });

  it('reaps stale locks', async () => {
    const q = new PgJobQueue(tdb.workerDb);
    const id = await q.enqueue({ queue: 'maintenance', jobType: 'X', organizationId: null, payload: {}, lockTimeoutSeconds: 1 });
    const got = await q.dequeue('w-crash', ['maintenance'], 1, 5);
    expect(got[0]!.id).toBe(id);
    await sql`update jobs.queue set locked_at = now() - interval '10 seconds' where id = ${id}::bigint`.execute(tdb.adminDb);
    expect(await q.reapStale()).toBe(1);
    const back = await q.dequeue('w2', ['maintenance'], 1, 5);
    expect(back[0]!.id).toBe(id);
    await q.complete(id);
  });
});

describe('withContext (RLS impersonation)', () => {
  it('user context sees own org only; system context is scoped to one org', async () => {
    const asUser = await withContext(tdb.db, { kind: 'user', userId: USER_A }, (trx) => trx.selectFrom('organizations').select('id').execute());
    expect(asUser.map((r) => r.id)).toEqual([ORG_A]);
    const asSystemB = await withContext(tdb.workerDb, { kind: 'system', organizationId: ORG_B }, (trx) => trx.selectFrom('devices').select('id').execute());
    expect(asSystemB).toHaveLength(0);
    const asSystemA = await withContext(tdb.workerDb, { kind: 'system', organizationId: ORG_A }, (trx) => trx.selectFrom('devices').select('id').execute());
    expect(asSystemA.map((r) => r.id)).toEqual([DEVICE_A]);
  });

  it('writes audit rows in user context and refuses cross-tenant audit', async () => {
    await withContext(tdb.db, { kind: 'user', userId: USER_A }, (trx) => writeAudit(trx, { organizationId: ORG_A, actorUserId: USER_A, action: 'device.updated', entityType: 'device', entityId: DEVICE_A, newValue: { name: 'x', apiKey: 'secret' } }));
    await expect(
      withContext(tdb.db, { kind: 'user', userId: USER_A }, (trx) => writeAudit(trx, { organizationId: ORG_B, actorUserId: USER_A, action: 'device.updated', entityType: 'device' })),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('defence in depth: login roles have no direct table access', () => {
  it('flowza_api / flowza_worker cannot read tenant tables without SET ROLE (noinherit)', async () => {
    await expect(tdb.db.selectFrom('employees').select('id').execute()).rejects.toThrow(/permission denied/);
    await expect(tdb.workerDb.selectFrom('organizations').select('id').execute()).rejects.toThrow(/permission denied/);
    // but the worker login role may use the job queue directly (no tenant data inside)
    await expect(sql`select count(*) from jobs.queue`.execute(tdb.workerDb)).resolves.toBeTruthy();
  });
});

describe('DeviceCredentialsStore', () => {
  const keys = [{ id: 'k2', material: Buffer.alloc(32, 2) }, { id: 'k1', material: Buffer.alloc(32, 1) }];
  it('round-trips encrypted credentials in system context and never exposes them to users', async () => {
    const store = new DeviceCredentialsStore(new SecretsCipher(keys));
    await withContext(tdb.workerDb, { kind: 'system', organizationId: ORG_A }, async (trx) => {
      const version = await store.put(trx, { organizationId: ORG_A, deviceId: DEVICE_A }, { apiKey: 'sk-live-abcd1234', username: 'admin' }, { apiKey: '****1234', username: 'admin' }, USER_A);
      expect(version).toBe(1);
      const back = await store.get(trx, { organizationId: ORG_A, deviceId: DEVICE_A });
      expect(back).toEqual({ apiKey: 'sk-live-abcd1234', username: 'admin' });
      expect(await store.put(trx, { organizationId: ORG_A, deviceId: DEVICE_A }, { apiKey: 'sk-live-new' }, { apiKey: '****-new' }, USER_A)).toBe(2);
    });
    // another organisation's system context cannot read them
    await withContext(tdb.workerDb, { kind: 'system', organizationId: ORG_B }, async (trx) => {
      expect(await store.get(trx, { organizationId: ORG_B, deviceId: DEVICE_A })).toBeNull();
    });
    // a user only gets the masked view
    await withContext(tdb.db, { kind: 'user', userId: USER_A }, async (trx) => {
      const masked = await store.masked(trx, DEVICE_A);
      expect(masked.apiKey).toBe('****-new');
      expect(masked.version).toBe(2);
      await expect(store.get(trx, { organizationId: ORG_A, deviceId: DEVICE_A })).rejects.toThrow(/permission denied/);
    });
    // ciphertext is bound to the device id (AAD): decrypting with another id fails
    const cipher = new SecretsCipher(keys);
    const blob = cipher.encrypt({ a: 1 }, { organizationId: ORG_A, deviceId: 'device-1' });
    expect(() => cipher.decrypt(blob, { organizationId: ORG_A, deviceId: 'device-2' })).toThrow();
    // ...and the data key is per organisation: another org cannot decrypt even with the same device id
    expect(() => cipher.decrypt(blob, { organizationId: ORG_B, deviceId: 'device-1' })).toThrow();
    // old key still decrypts
    const old = new SecretsCipher([keys[1]!]).encrypt({ a: 2 }, { organizationId: ORG_A, deviceId: 'x' });
    expect(cipher.decrypt(old, { organizationId: ORG_A, deviceId: 'x' })).toEqual({ a: 2 });
  });
});
