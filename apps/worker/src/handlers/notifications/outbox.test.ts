import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { relayOutbox, deliverNotifications } from './outbox.js';
import { ensurePartitions, reapStaleJobs, applyRetention, meterUsage } from '../maintenance/index.js';

const ORG = '0a000000-0000-0000-0000-000000000000';
const OWNER = 'a0000000-0000-0000-0000-000000000001';
const EMP_USER = 'a0000000-0000-0000-0000-000000000003';
const BRANCH = '0a000000-0000-0000-0000-00000000000b';
const DEVICE = '0a000000-0000-0000-0000-0000000000d1';
let h: TestHarness;

beforeAll(async () => {
  h = await createHarness(`flowza_worker_${process.pid}`, { get() { throw new Error('n/a'); }, tryGet() { return undefined; }, list() { return []; }, pushProtocols() { return []; }, pushProtocol() { return undefined; } });
  const a = h.tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${OWNER}, 'owner@t.local'), (${EMP_USER}, 'emp@t.local')`.execute(a);
  await a.insertInto('userProfiles').values([{ id: OWNER, email: 'owner@t.local', fullName: 'Owner' }, { id: EMP_USER, email: 'emp@t.local', fullName: 'Emp' }]).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'WRK', legalName: 'W', displayName: 'W' }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ' }).execute();
  await a.insertInto('orgMemberships').values([
    { organizationId: ORG, userId: OWNER, roleId: '10000000-0000-0000-0000-000000000001', status: 'active', allBranches: true },
    { organizationId: ORG, userId: EMP_USER, roleId: '10000000-0000-0000-0000-000000000008', status: 'active', allBranches: true },
  ]).execute();
  await a.insertInto('notificationPreferences').values({ userId: OWNER, organizationId: ORG, category: 'DEVICE', channel: 'EMAIL', enabled: true }).execute();
  await a.insertInto('devices').values({ id: DEVICE, organizationId: ORG, branchId: BRANCH, code: 'D1', name: 'Gate', providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL' }).execute();
});
afterAll(async () => { await h?.close(); });

describe('outbox relay', () => {
  it('creates notifications for entitled users only, dedupes flapping, queues email per preference, coalesces realtime', async () => {
    const a = h.tdb.adminDb;
    await a.insertInto('domainEvents').values([
      { organizationId: ORG, eventType: 'device.offline', aggregateType: 'device', aggregateId: DEVICE, payload: JSON.stringify({ deviceId: DEVICE, deviceName: 'Gate', lastSeenAt: '2026-09-05T06:00:00Z' }) },
      { organizationId: ORG, eventType: 'device.offline', aggregateType: 'device', aggregateId: DEVICE, payload: JSON.stringify({ deviceId: DEVICE, deviceName: 'Gate' }) }, // flap → deduped
      { organizationId: ORG, eventType: 'sync.failed', aggregateType: 'sync_job', aggregateId: '11111111-1111-4111-a111-111111111111', payload: JSON.stringify({ jobType: 'PULL_ATTENDANCE', error: 'boom', syncJobId: '11111111-1111-4111-a111-111111111111' }) },
    ]).execute();
    const res = await relayOutbox({ job: fakeJob('RELAY_OUTBOX'), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    expect(res.relayed).toBe(3);
    const notifs = await a.selectFrom('notifications').select(['userId', 'type', 'category']).execute();
    // owner (device.view + device.sync) gets device.offline once and sync.failed once; the employee role gets nothing
    expect(notifs.filter((n) => n.userId === OWNER).map((n) => n.type).sort()).toEqual(['device.offline', 'sync.failed']);
    expect(notifs.filter((n) => n.userId === EMP_USER)).toHaveLength(0);
    const deliveries = await a.selectFrom('notificationDeliveries').select(['channel', 'status']).execute();
    expect(deliveries).toEqual([{ channel: 'EMAIL', status: 'pending' }]); // only DEVICE category has an email preference
    expect(h.published.map((p) => p.channel).sort()).toEqual([`org:${ORG}:devices`, `org:${ORG}:sync`]);
    expect((h.published.find((p) => p.channel.endsWith(':devices'))!.payload as { count: number }).count).toBe(2);
    const unpublished = await a.selectFrom('domainEvents').select('id').where('publishedAt', 'is', null).execute();
    expect(unpublished).toHaveLength(0);
    // delivery
    const d = await deliverNotifications({ job: fakeJob('DELIVER_NOTIFICATIONS'), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    expect(d.sent).toBe(1);
    expect(h.emails[0]!.to).toBe('owner@t.local');
  });
});

describe('maintenance handlers', () => {
  it('ensures future partitions, reaps stale jobs, applies retention respecting legal hold, meters usage', async () => {
    const ctx = (jobType: string, payload: Record<string, unknown> = {}) => ({ job: fakeJob(jobType, payload, payload['organizationId'] ? String(payload['organizationId']) : null), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    const created = await ensurePartitions(ctx('ENSURE_PARTITIONS'));
    expect(Object.keys(created)).toHaveLength(4); // idempotent; may be 0 new when seeds already cover the horizon
    expect((await reapStaleJobs(ctx('REAP_STALE'))).requeued).toBe(0);
    const a = h.tdb.adminDb;
    await a.insertInto('dataRetentionPolicies').values({ organizationId: ORG, dataClass: 'device_logs', retentionDays: 30, enabled: true }).execute();
    await sql`insert into public.device_logs (organization_id, device_id, level, event, created_at) values (${ORG}::uuid, ${DEVICE}::uuid, 'info', 'old', now() - interval '100 days'), (${ORG}::uuid, ${DEVICE}::uuid, 'info', 'new', now())`.execute(a);
    const r1 = await applyRetention(ctx('RETENTION', { organizationId: ORG }));
    expect(r1).toEqual({ device_logs: 1 });
    await a.updateTable('organizations').set({ legalHold: true }).where('id', '=', ORG).execute();
    expect(await applyRetention(ctx('RETENTION', { organizationId: ORG }))).toEqual({ skipped: 'legal_hold' });
    const m = await meterUsage(ctx('USAGE_METERING'));
    expect(m.rows).toBeGreaterThanOrEqual(5);
    const usage = await a.selectFrom('usageRecords').select(['metric', 'value']).where('organizationId', '=', ORG).execute();
    expect(usage.find((u) => u.metric === 'devices')?.value).toBe('1');
  });
});
