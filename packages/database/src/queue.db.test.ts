import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from './testing/index.js';
import { DEAD_LETTER_NOW, PgJobQueue } from './queue.js';
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

  const lockAge = async (id: string) =>
    (await sql<{ s: number }>`select extract(epoch from now() - locked_at)::float8 as s from jobs.queue where id = ${id}::bigint`.execute(tdb.adminDb)).rows[0]!.s;
  const row = async (id: string) =>
    (await sql<{ status: string; attempts: number; lockedBy: string | null; lastErrorCode: string | null }>`select status, attempts, locked_by, last_error_code from jobs.queue where id = ${id}::bigint`.execute(tdb.adminDb)).rows[0];
  const archived = async (id: string) =>
    (await sql<{ status: string; lastErrorCode: string | null; lockedBy: string | null }>`select status, last_error_code, locked_by from jobs.queue_archive where id = ${id}::bigint`.execute(tdb.adminDb)).rows[0];

  it('heartbeat extends only the locks a worker still holds, for the same attempt, and keeps a long job from being reaped', async () => {
    const q = new PgJobQueue(tdb.workerDb);
    const id = await q.enqueue({ queue: 'reports', jobType: 'HEARTBEAT', organizationId: null, payload: {}, lockTimeoutSeconds: 30 });
    const [job] = await q.dequeue('w-hb', ['reports'], 1, 5);
    expect(job!.id).toBe(id);
    await sql`update jobs.queue set locked_at = now() - interval '25 seconds' where id = ${id}::bigint`.execute(tdb.adminDb);
    // another worker, or this worker for another attempt, does not hold the lock
    expect(await q.heartbeat('w-other', [{ id, attempts: job!.attempts }])).toEqual(new Set());
    expect(await q.heartbeat('w-hb', [{ id, attempts: job!.attempts + 1 }])).toEqual(new Set());
    expect(await lockAge(id)).toBeGreaterThan(20);
    expect(await q.heartbeat('w-hb', [{ id, attempts: job!.attempts }, { id: '999999999', attempts: 1 }])).toEqual(new Set([id]));
    expect(await lockAge(id)).toBeLessThan(5);
    // a job whose lock keeps being extended stays with its worker, however long it runs
    await q.reapStale();
    expect(await row(id)).toMatchObject({ status: 'running', attempts: 1, lockedBy: 'w-hb' });
    expect(await q.completeOwned(id, 'w-hb', job!.attempts)).toBe(true);
    expect(await archived(id)).toMatchObject({ status: 'completed', lockedBy: null });
    expect(await q.heartbeat('w-hb', [{ id, attempts: job!.attempts }])).toEqual(new Set());
    expect(await q.heartbeat('w-hb', [])).toEqual(new Set());
  });

  it('an execution whose lock was reaped can neither complete nor fail the attempt that replaced it', async () => {
    const q = new PgJobQueue(tdb.workerDb);
    const id = await q.enqueue({ queue: 'notifications', jobType: 'OWNED', organizationId: null, payload: {}, maxAttempts: 4 });
    const [first] = await q.dequeue('w-a', ['notifications'], 1, 5);
    expect(first).toMatchObject({ id, attempts: 1 });
    await sql`update jobs.queue set locked_at = now() - interval '1 hour' where id = ${id}::bigint`.execute(tdb.adminDb);
    await q.reapStale();
    expect(await row(id)).toMatchObject({ status: 'pending', attempts: 1, lockedBy: null, lastErrorCode: 'LOCK_EXPIRED' });
    const [second] = await q.dequeue('w-b', ['notifications'], 1, 5);
    expect(second).toMatchObject({ id, attempts: 2 });

    // the superseded execution (attempt 1) finishes late: nothing it reports touches attempt 2
    expect(await q.completeOwned(id, 'w-a', 1)).toBe(false);
    expect(await q.failOwned(id, 'w-a', 1, 'X', 'late failure', DEAD_LETTER_NOW)).toBeNull();
    // a worker id alone is not ownership: the attempt must match too
    expect(await q.completeOwned(id, 'w-b', 1)).toBe(false);
    expect(await row(id)).toMatchObject({ status: 'running', attempts: 2, lockedBy: 'w-b' });

    // the owner retries and then completes it
    expect(await q.failOwned(id, 'w-b', 2, 'TRANSIENT', 'retry me', 0)).toBe('pending');
    const [third] = await q.dequeue('w-b', ['notifications'], 1, 5);
    expect(third).toMatchObject({ id, attempts: 3 });
    expect(await q.completeOwned(id, 'w-b', 3)).toBe(true);
    expect(await q.completeOwned(id, 'w-b', 3)).toBe(false);
    expect(await archived(id)).toMatchObject({ status: 'completed', lockedBy: null });
  });

  it('a worker shutting down hands a job back at once without spending an attempt; only as its owner', async () => {
    const q = new PgJobQueue(tdb.workerDb);
    const id = await q.enqueue({ queue: 'sync', jobType: 'RELEASED', organizationId: null, payload: {}, maxAttempts: 2, lockTimeoutSeconds: 3600 });
    const [first] = await q.dequeue('w-old', ['sync'], 1, 5);
    expect(first).toMatchObject({ id, attempts: 1 });
    expect(await q.releaseOwned(id, 'w-other', 1)).toBe(false);
    expect(await q.releaseOwned(id, 'w-old', 2)).toBe(false);
    expect(await q.releaseOwned(id, 'w-old', 1)).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'pending', attempts: 1, lockedBy: null, lastErrorCode: 'WORKER_SHUTDOWN' });
    // the next worker takes it straight away, and still has every retry it had
    const [next] = await q.dequeue('w-new', ['sync'], 1, 5);
    expect(next).toMatchObject({ id, attempts: 2, maxAttempts: 3 });
    expect(await q.releaseOwned(id, 'w-old', 1)).toBe(false);
    expect(await q.completeOwned(id, 'w-new', 2)).toBe(true);
  });

  it('requeueing a job whose dedupe key a newer pending job already holds keeps both runs instead of failing', async () => {
    const q = new PgJobQueue(tdb.workerDb);
    // retry (jobs.fail) of a running job while its next run waits
    const running = await q.enqueue({ queue: 'sync', jobType: 'DEDUPE', organizationId: null, payload: { n: 1 }, dedupeKey: 'dedupe:fail' });
    await q.dequeue('w-d', ['sync'], 1, 5);
    const twin = await q.enqueue({ queue: 'sync', jobType: 'DEDUPE', organizationId: null, payload: { n: 2 }, dedupeKey: 'dedupe:fail', runAt: new Date(Date.now() + 3_600_000) });
    expect(twin).not.toBe(running);
    expect(await q.failOwned(running, 'w-d', 1, 'TRANSIENT', 'retry', 3_600)).toBe('pending');
    const keys = await sql<{ id: string; dedupeKey: string | null; status: string }>`select id::text, dedupe_key, status from jobs.queue where id in (${running}::bigint, ${twin}::bigint) order by id`.execute(tdb.adminDb);
    expect(keys.rows).toEqual([{ id: running, dedupeKey: null, status: 'pending' }, { id: twin, dedupeKey: 'dedupe:fail', status: 'pending' }]);
    // a new enqueue still merges into the pending job that kept the key
    expect(await q.enqueue({ queue: 'sync', jobType: 'DEDUPE', organizationId: null, payload: {}, dedupeKey: 'dedupe:fail' })).toBe(twin);
    await sql`delete from jobs.queue where id in (${running}::bigint, ${twin}::bigint)`.execute(tdb.adminDb);

    // reaping: one stale job with a pending twin, and two stale jobs sharing a key, in one batch
    const stale = await q.enqueue({ queue: 'maintenance', jobType: 'DEDUPE', organizationId: null, payload: {}, dedupeKey: 'dedupe:reap', lockTimeoutSeconds: 1 });
    await q.dequeue('w-dead', ['maintenance'], 1, 5);
    const waiting = await q.enqueue({ queue: 'maintenance', jobType: 'DEDUPE', organizationId: null, payload: {}, dedupeKey: 'dedupe:reap', runAt: new Date(Date.now() + 3_600_000) });
    const pairA = await q.enqueue({ queue: 'maintenance', jobType: 'DEDUPE', organizationId: null, payload: {}, dedupeKey: 'dedupe:pair', lockTimeoutSeconds: 1 });
    await q.dequeue('w-dead', ['maintenance'], 1, 5);
    const pairB = await q.enqueue({ queue: 'maintenance', jobType: 'DEDUPE', organizationId: null, payload: {}, dedupeKey: 'dedupe:pair', lockTimeoutSeconds: 1 });
    await q.dequeue('w-dead', ['maintenance'], 1, 5);
    await sql`update jobs.queue set locked_at = now() - interval '1 minute' where id in (${stale}::bigint, ${pairA}::bigint, ${pairB}::bigint)`.execute(tdb.adminDb);
    expect(await q.reapStale()).toBeGreaterThanOrEqual(3);
    const after = await sql<{ id: string; dedupeKey: string | null; status: string }>`select id::text, dedupe_key, status from jobs.queue where id in (${stale}::bigint, ${waiting}::bigint, ${pairA}::bigint, ${pairB}::bigint) order by id`.execute(tdb.adminDb);
    expect(after.rows).toEqual([
      { id: stale, dedupeKey: null, status: 'pending' },
      { id: waiting, dedupeKey: 'dedupe:reap', status: 'pending' },
      { id: pairA, dedupeKey: null, status: 'pending' },
      { id: pairB, dedupeKey: 'dedupe:pair', status: 'pending' },
    ]);
    await sql`delete from jobs.queue where id in (${stale}::bigint, ${waiting}::bigint, ${pairA}::bigint, ${pairB}::bigint)`.execute(tdb.adminDb);
  });

  it('jobs.complete leaves a job that was already archived as it was', async () => {
    const q = new PgJobQueue(tdb.workerDb);
    const id = await q.enqueue({ queue: 'reports', jobType: 'ARCHIVED', organizationId: null, payload: {} });
    await q.dequeue('w-c', ['reports'], 1, 5);
    expect(await q.failOwned(id, 'w-c', 1, 'BAD', 'no', DEAD_LETTER_NOW)).toBe('dead');
    const before = await sql<{ status: string; completedAt: Date }>`select status, completed_at from jobs.queue_archive where id = ${id}::bigint`.execute(tdb.adminDb);
    await q.complete(id);
    const after = await sql<{ status: string; completedAt: Date }>`select status, completed_at from jobs.queue_archive where id = ${id}::bigint`.execute(tdb.adminDb);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0]!.status).toBe('dead');
  });

  it('reaping counts a lost lock as an attempt and dead-letters a job whose attempts are spent', async () => {
    const q = new PgJobQueue(tdb.workerDb);
    const id = await q.enqueue({ queue: 'processing', jobType: 'CRASHES_ITS_WORKER', organizationId: null, payload: {}, maxAttempts: 2, lockTimeoutSeconds: 1 });
    await q.dequeue('w-crash-1', ['processing'], 1, 5);
    await sql`update jobs.queue set locked_at = now() - interval '10 seconds' where id = ${id}::bigint`.execute(tdb.adminDb);
    expect(await q.reapStale()).toBeGreaterThanOrEqual(1);
    expect(await row(id)).toMatchObject({ status: 'pending', attempts: 1, lastErrorCode: 'LOCK_EXPIRED' });

    const [again] = await q.dequeue('w-crash-2', ['processing'], 1, 5);
    expect(again).toMatchObject({ id, attempts: 2 });
    await sql`update jobs.queue set locked_at = now() - interval '10 seconds' where id = ${id}::bigint`.execute(tdb.adminDb);
    expect(await q.reapStale()).toBeGreaterThanOrEqual(1);
    expect(await row(id)).toBeUndefined();
    expect(await archived(id)).toMatchObject({ status: 'dead', lastErrorCode: 'LOCK_EXPIRED', lockedBy: null });
    // nothing is handed out again
    expect(await q.dequeue('w-crash-3', ['processing'], 5, 5)).toHaveLength(0);
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
