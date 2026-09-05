import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { signMockWebhook } from '@flowza/device-providers';
import { sha256Hex } from '@flowza/shared';
import { dedupeHash } from '@flowza/database';
import { createApiHarness, queueJobs, seedDevice, seedOrg, type ApiHarness, type OrgFixture } from '../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
beforeAll(async () => { h = await createApiHarness(`flowza_api_inbound_${process.pid}`); f = await seedOrg(h.admin, 'inb'); });
afterAll(async () => { await h?.close(); });
const text = (path: string, method = 'GET', raw = '', headers: Record<string, string> = {}) => h.request(method, path, { raw, headers: { 'content-type': 'text/plain', 'x-forwarded-for': '203.0.113.9', ...headers } });

describe('device push: mock protocol', () => {
  const SERIAL = 'MOCK-SER-1';
  let deviceId: string; let token: string;
  it('records unknown serials as pending devices and keeps answering the protocol', async () => {
    const r = await text(`/device-push/mock/${SERIAL}/handshake`, 'GET');
    expect(r.status).toBe(200);
    expect(r.text).toBe('OK');
    const pending = await h.admin.selectFrom('pendingDevices').selectAll().where('serialNumber', '=', SERIAL).executeTakeFirstOrThrow();
    expect(pending.providerKey).toBe('mock');
    expect(pending.claimCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(pending.remoteIp).toBe('203.0.113.9');
    expect(pending.organizationId).toBeNull();
    // attendance from an unknown device is never stored — and never acknowledged, so the terminal keeps it until it is claimed
    const att = await text(`/device-push/mock/${SERIAL}/attendance`, 'POST', '1001,2026-08-03T08:00:00\n');
    expect(att.status).toBe(401);
    expect(att.text).not.toMatch(/^OK/);
    expect((await sql<{ n: string }>`select count(*) as n from public.attendance_raw_transactions`.execute(h.admin)).rows[0]!.n).toBe('0');
    expect((await h.admin.selectFrom('pendingDevices').select('lastSeenAt').where('id', '=', pending.id).executeTakeFirstOrThrow()).lastSeenAt.getTime()).toBeGreaterThanOrEqual(pending.lastSeenAt.getTime());
    // admins find it by serial and claim it into a branch
    const list = await h.request('GET', `/api/v1/orgs/${f.orgId}/devices/pending?serialNumber=${SERIAL}`, { token: f.owner });
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([pending.id]);
    expect((await h.request('POST', `/api/v1/orgs/${f.orgId}/devices/pending/${pending.id}/claim`, { token: f.hrUser, body: { branchId: f.branchA, name: 'Lobby', code: 'LOBBY' } })).status).toBe(403);
    const claim = await h.request('POST', `/api/v1/orgs/${f.orgId}/devices/pending/${pending.id}/claim`, { token: f.owner, body: { branchId: f.branchA, name: 'Lobby', code: 'LOBBY' } });
    expect(claim.status).toBe(201);
    expect(claim.body.data.device.serialNumber).toBe(SERIAL);
    expect(claim.body.data.pushToken).toBeTypeOf('string');
    deviceId = claim.body.data.device.id; token = claim.body.data.pushToken;
    expect((await h.admin.selectFrom('pendingDevices').select('claimedDeviceId').where('id', '=', pending.id).executeTakeFirstOrThrow()).claimedDeviceId).toBe(deviceId);
  });

  it('rejects a bad token, ingests attendance synchronously, dedupes replays', async () => {
    const bad = await text(`/device-push/mock/${SERIAL}/attendance?token=nope`, 'POST', '1001,2026-08-03T08:00:00\n');
    expect(bad.status).toBe(401);
    const body = '1001,2026-08-03T08:00:00,fingerprint,in\n1001,2026-08-03T17:02:00,fingerprint,out\nGHOST-9,2026-08-03T09:00:00\n1001,2099-01-01T08:00:00\n';
    const ok = await text(`/device-push/mock/${SERIAL}/attendance?token=${token}`, 'POST', body);
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('OK: 4');
    const rows = await h.admin.selectFrom('attendanceRawTransactions').selectAll().where('deviceId', '=', deviceId).orderBy('punchedAt').execute();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.source === 'DEVICE_PUSH' && r.assumedTimezone === 'Asia/Muscat' && r.branchId === f.branchA)).toBe(true);
    expect(rows[0]!.punchedAt.toISOString()).toBe('2026-08-03T04:00:00.000Z'); // 08:00 Muscat
    expect(rows[0]!.deviceLocalTime).toBe('2026-08-03T08:00:00');
    expect(rows[3]!.processingStatus).toBe('quarantined');
    expect(rows[0]!.dedupeHash).toBe(sha256Hex(`${deviceId}|1|1001|2026-08-03T04:00:00Z|fingerprint|in`));
    // the worker (PULL_ATTENDANCE / WEBHOOK_EVENT) hashes the same punch with the shared @flowza/database `dedupeHash`; a vendor
    // cloud re-offering it with an offset and milliseconds must collapse onto the row the device pushed
    expect(rows[0]!.dedupeHash).toBe(dedupeHash(deviceId, 1, { deviceEmployeeId: '1001', punchedAt: '2026-08-03T08:00:00.000+04:00', verificationMethod: 'fingerprint', direction: 'in' }));
    expect((await queueJobs(h.admin, 'NORMALIZE_RAW')).some((j) => j.dedupeKey === `normalize:${f.orgId}`)).toBe(true);
    const device = await h.admin.selectFrom('devices').select(['connectionStatus', 'lastHeartbeatAt', 'config']).where('id', '=', deviceId).executeTakeFirstOrThrow();
    expect(device.connectionStatus).toBe('online');
    expect((device.config as { lastSeenAt: string }).lastSeenAt).toBeTypeOf('string');
    // replay of the same body → duplicate, no new rows, still OK
    const again = await text(`/device-push/mock/${SERIAL}/attendance`, 'POST', body, { 'x-device-token': token });
    expect(again.status).toBe(200);
    expect((await h.admin.selectFrom('attendanceRawTransactions').select('id').where('deviceId', '=', deviceId).execute()).length).toBe(4);
    expect((await h.admin.selectFrom('deviceLogs').select('event').where('deviceId', '=', deviceId).where('event', '=', 'push.duplicate').execute()).length).toBe(1);
    const events = await h.admin.selectFrom('providerWebhookEvents').selectAll().where('deviceId', '=', deviceId).execute();
    expect(events.filter((e) => e.eventType === 'device_push:attendance')).toHaveLength(1);
    expect(events[0]!.status).toBe('processed'); // ingested inline: nothing for a worker to pick up
    expect(events[0]!.processedAt).not.toBeNull();
    expect(JSON.stringify(events[0]!.payload)).not.toContain(token);
    // same punch again in a new body (different padding) → hash dedupe on the raw table
    const partial = await text(`/device-push/mock/${SERIAL}/attendance?token=${token}`, 'POST', '1001,2026-08-03T08:00:00,fingerprint,in\n1001,2026-08-03T18:00:00,card,out\n');
    expect(partial.text).toBe('OK: 2');
    expect((await h.admin.selectFrom('attendanceRawTransactions').select('id').where('deviceId', '=', deviceId).execute()).length).toBe(5);
  });

  it('renders pending commands on poll and applies command results to sync items and employee states', async () => {
    const job = await h.admin.insertInto('syncJobs').values({ organizationId: f.orgId, jobType: 'PUSH_EMPLOYEES', status: 'RUNNING', itemsTotal: 1, itemsPending: 1, correlationId: 'test', branchId: f.branchA }).returning('id').executeTakeFirstOrThrow();
    const item = await h.admin.insertInto('syncJobItems').values({ organizationId: f.orgId, syncJobId: job.id, deviceId, employeeId: f.e1, branchId: f.branchA, operation: 'PUSH_EMPLOYEE', status: 'RUNNING' }).returning('id').executeTakeFirstOrThrow();
    await h.admin.insertInto('deviceEmployeeStates').values({ organizationId: f.orgId, deviceId, employeeId: f.e1, branchId: f.branchA, deviceUserId: '1001', desired: true, syncStatus: 'PENDING', cloudHash: 'abc123' }).execute();
    const cmd = await h.admin.insertInto('deviceCommands').values({ organizationId: f.orgId, deviceId, commandType: 'UPSERT_EMPLOYEE', payload: JSON.stringify({ employee: { deviceUserId: '1001', name: 'Employee 1' }, cloudHash: 'abc123' }), syncJobItemId: item.id }).returning(['id', 'sequence']).executeTakeFirstOrThrow();
    const poll = await text(`/device-push/mock/${SERIAL}/commands?token=${token}`, 'GET');
    expect(poll.status).toBe(200);
    expect(poll.body).toEqual([{ id: String(cmd.sequence), commandType: 'UPSERT_EMPLOYEE', payload: { employee: { deviceUserId: '1001', name: 'Employee 1' }, cloudHash: 'abc123' } }]);
    expect((await h.admin.selectFrom('deviceCommands').select('status').where('id', '=', cmd.id).executeTakeFirstOrThrow()).status).toBe('sent');
    const empty = await text(`/device-push/mock/${SERIAL}/commands?token=${token}`, 'GET');
    expect(empty.body).toEqual([]);
    const res = await text(`/device-push/mock/${SERIAL}/command-results?token=${token}`, 'POST', `${cmd.sequence},ok,done\n`);
    expect(res.text).toBe('OK');
    expect((await h.admin.selectFrom('deviceCommands').select('status').where('id', '=', cmd.id).executeTakeFirstOrThrow()).status).toBe('acked');
    expect((await h.admin.selectFrom('syncJobItems').select('status').where('id', '=', item.id).executeTakeFirstOrThrow()).status).toBe('SUCCESS');
    const sj = await h.admin.selectFrom('syncJobs').select(['status', 'itemsSuccess', 'itemsPending']).where('id', '=', job.id).executeTakeFirstOrThrow();
    expect(sj).toEqual({ status: 'SUCCESS', itemsSuccess: 1, itemsPending: 0 });
    const state = await h.admin.selectFrom('deviceEmployeeStates').select(['syncStatus', 'deviceHash']).where('deviceId', '=', deviceId).where('employeeId', '=', f.e1).executeTakeFirstOrThrow();
    expect(state).toEqual({ syncStatus: 'IN_SYNC', deviceHash: 'abc123' });
    const cmds = await h.request('GET', `/api/v1/orgs/${f.orgId}/devices/${deviceId}/commands?status=acked`, { token: f.owner });
    expect(cmds.body.meta.total).toBe(1);
  });

  it('answers 404 for unknown protocols, 400 when the device cannot be identified and 413 for oversized bodies', async () => {
    expect((await text('/device-push/nope/x', 'GET')).status).toBe(404);
    expect((await text('/device-push/mock/not-a-route', 'GET')).status).toBe(400);
    expect((await text(`/device-push/mock/${SERIAL}/attendance?token=${token}`, 'POST', '', { 'content-length': String(3 * 1024 * 1024) })).status).toBe(413);
  });
});

describe('device push: ZKTeco iclock protocol', () => {
  const SN = 'ZK7654321';
  let deviceId: string;
  const tokenPlain = 'zk-token-0123456789abcdef0123456789abcdef';
  beforeAll(async () => {
    deviceId = await seedDevice(h.admin, f.orgId, f.branchB, { providerKey: 'zkteco_push', integrationType: 'DEVICE_PUSH', serialNumber: SN, pushTokenHash: sha256Hex(tokenPlain), capabilities: { attendancePush: true, employeePush: true, devicePush: true }, config: { serialNumber: SN } });
  });
  const p = (rest: string) => `/device-push/iclock/~${tokenPlain}${rest}`;

  it('handshake returns the option block with persisted stamps; ATTLOG creates raw rows', async () => {
    const hs = await text(p(`/iclock/cdata?SN=${SN}&options=all&pushver=2.4.1`), 'GET');
    expect(hs.status).toBe(200);
    expect(hs.text).toContain(`GET OPTION FROM: ${SN}`);
    expect(hs.text).toContain('ATTLOGStamp=None');
    const badToken = await text(`/device-push/iclock/~wrongtoken0000000000000000/iclock/cdata?SN=${SN}&options=all`, 'GET');
    expect(badToken.status).toBe(401);
    const att = await text(p(`/iclock/cdata?SN=${SN}&table=ATTLOG&Stamp=9001`), 'POST', `1002\t2026-08-03 08:01:00\t0\t1\t0\n1002\t2026-08-03 17:00:00\t1\t15\t0\n`);
    expect(att.status).toBe(200);
    expect(att.text).toBe('OK: 2');
    const rows = await h.admin.selectFrom('attendanceRawTransactions').selectAll().where('deviceId', '=', deviceId).orderBy('punchedAt').execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ deviceEmployeeId: '1002', verificationMethod: 'fingerprint', direction: 'in', source: 'DEVICE_PUSH', providerKey: 'zkteco_push' });
    expect(rows[1]!.verificationMethod).toBe('face');
    const cursor = await h.admin.selectFrom('syncCursors').select('cursor').where('deviceId', '=', deviceId).where('stream', '=', 'attendance').executeTakeFirstOrThrow();
    expect((cursor.cursor as { stamps: Record<string, string> }).stamps).toEqual({ ATTLOG: '9001' });
    const hs2 = await text(p(`/iclock/cdata?SN=${SN}&options=all`), 'GET');
    expect(hs2.text).toContain('ATTLOGStamp=9001');
    const dup = await text(p(`/iclock/cdata?SN=${SN}&table=ATTLOG&Stamp=9001`), 'POST', `1002\t2026-08-03 08:01:00\t0\t1\t0\n1002\t2026-08-03 17:00:00\t1\t15\t0\n`);
    expect(dup.text).toBe('OK: 2');
    expect((await h.admin.selectFrom('attendanceRawTransactions').select('id').where('deviceId', '=', deviceId).execute()).length).toBe(2);
    const malformed = await text(p(`/iclock/cdata?SN=${SN}&table=ATTLOG`), 'POST', 'garbage\n');
    expect(malformed.status).toBe(400);
    expect(malformed.text).toBe('ERROR');
  });

  it('getrequest renders queued commands, devicecmd acknowledges them, OPERLOG users become device-only states', async () => {
    const cmd = await h.admin.insertInto('deviceCommands').values({ organizationId: f.orgId, deviceId, commandType: 'UPSERT_EMPLOYEE', payload: JSON.stringify({ pin: '1002', name: 'Employee 2', pri: 0, passwd: '', card: '', grp: 1, tz: '0000000100000000' }) }).returning('sequence').executeTakeFirstOrThrow();
    const poll = await text(p(`/iclock/getrequest?SN=${SN}&INFO=Ver6.60,12,3,240,192.168.1.10`), 'GET');
    expect(poll.status).toBe(200);
    expect(poll.text).toBe(`C:${cmd.sequence}:DATA UPDATE USERINFO PIN=1002\tName=Employee 2\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000100000000\n`);
    const dev = await h.admin.selectFrom('devices').select(['firmwareVersion', 'config']).where('id', '=', deviceId).executeTakeFirstOrThrow();
    expect(dev.firmwareVersion).toBe('Ver6.60');
    expect((dev.config as { deviceInfo: { userCount: number } }).deviceInfo.userCount).toBe(12);
    const ack = await text(p(`/iclock/devicecmd?SN=${SN}`), 'POST', `ID=${cmd.sequence}&Return=0&CMD=DATA\n`);
    expect(ack.text).toBe('OK');
    expect((await h.admin.selectFrom('deviceCommands').select('status').where('sequence', '=', cmd.sequence).executeTakeFirstOrThrow()).status).toBe('acked');
    expect((await text(p(`/iclock/getrequest?SN=${SN}`), 'GET')).text).toBe('OK');
    const oper = await text(p(`/iclock/cdata?SN=${SN}&table=OPERLOG&OpStamp=77`), 'POST', `USER PIN=1002\tName=Employee 2\tPri=0\tPasswd=\tCard=123456\tGrp=1\tTZ=0000000100000000\nUSER PIN=555\tName=Visitor\tPri=0\nFP PIN=555\tFID=0\tSize=10\tValid=1\tTMP=AAAA\n`);
    expect(oper.text).toBe('OK: 3');
    const states = await h.admin.selectFrom('deviceEmployeeStates').select(['deviceUserId', 'employeeId', 'desired']).where('deviceId', '=', deviceId).orderBy('deviceUserId').execute();
    expect(states).toEqual([{ deviceUserId: '1002', employeeId: f.e2, desired: true }, { deviceUserId: '555', employeeId: null, desired: false }]);
    expect(((await h.admin.selectFrom('syncCursors').select('cursor').where('deviceId', '=', deviceId).executeTakeFirstOrThrow()).cursor as { stamps: Record<string, string> }).stamps).toEqual({ ATTLOG: '9001', OPERLOG: '77' });
    expect(JSON.stringify(states)).not.toContain('AAAA');
    const stored = await h.admin.selectFrom('providerWebhookEvents').select(['payload', 'headers']).where('deviceId', '=', deviceId).execute();
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain('AAAA'); // biometric template lines are never persisted, not even in the replay log
  });

  it('isolates an unrenderable command instead of failing the whole batch, and marks only rendered commands as sent', async () => {
    const bogus = await h.admin.insertInto('deviceCommands').values({ organizationId: f.orgId, deviceId, commandType: 'BOGUS', payload: JSON.stringify({}) }).returning(['id', 'sequence']).executeTakeFirstOrThrow();
    const good = await h.admin.insertInto('deviceCommands').values({ organizationId: f.orgId, deviceId, commandType: 'RESTART', payload: JSON.stringify({}) }).returning(['id', 'sequence']).executeTakeFirstOrThrow();
    const poll = await text(p(`/iclock/getrequest?SN=${SN}`), 'GET');
    expect(poll.status).toBe(200);
    expect(poll.text).toBe(`C:${good.sequence}:REBOOT\n`);
    expect((await h.admin.selectFrom('deviceCommands').select('status').where('id', '=', good.id).executeTakeFirstOrThrow()).status).toBe('sent');
    expect((await h.admin.selectFrom('deviceCommands').select('status').where('id', '=', bogus.id).executeTakeFirstOrThrow()).status).toBe('failed');
  });

  it('refuses push traffic for a DEVICE_PUSH device that has no push token instead of trusting the serial', async () => {
    const serial = 'ZK-NOTOKEN';
    await seedDevice(h.admin, f.orgId, f.branchB, { providerKey: 'zkteco_push', integrationType: 'DEVICE_PUSH', serialNumber: serial, pushTokenHash: null, capabilities: { attendancePush: true, devicePush: true }, config: { serialNumber: serial } });
    const r = await text(`/device-push/iclock/iclock/cdata?SN=${serial}&options=all`, 'GET');
    expect(r.status).toBe(401);
    expect((await h.admin.selectFrom('pendingDevices').select('id').where('serialNumber', '=', serial).execute()).length).toBe(0);
    await h.admin.updateTable('devices').set({ status: 'decommissioned' }).where('serialNumber', '=', serial).execute(); // free the trial-plan device slot
  });

  it('rate-limits a chatty serial independently of the IP limiter', async () => {
    let status = 200;
    for (let i = 0; i < 70 && status !== 429; i += 1) status = (await text(`/device-push/iclock/cdata?SN=RATE-${'1'}&options=all`, 'GET')).status;
    expect(status).toBe(429);
  });
});

describe('vendor webhooks', () => {
  it('validates token + signature, stores events with replay protection and queues WEBHOOK_EVENT', async () => {
    const r = await h.request('POST', `/api/v1/orgs/${f.orgId}/devices`, { token: f.owner, body: { code: 'WH1', name: 'Cloud device', branchId: f.branchA, providerKey: 'mock', manufacturer: 'FlowZa', config: { scenario: 'healthy', webhookSecret: 'whsec-1' } } });
    expect(r.status).toBe(201);
    const deviceId = r.body.data.device.id as string;
    const url = new URL(r.body.data.webhookUrl as string).pathname;
    const payload = { eventId: 'evt-1', deviceSerial: 'WH1', transactions: [{ deviceUserId: '1001', punchedAt: '2026-08-03T04:00:00Z', method: 'face' as const }] };
    const signed = signMockWebhook('whsec-1', payload);
    const ok = await h.request('POST', url, { raw: signed.rawBody, headers: { ...signed.headers, 'x-device-token': 'must-not-persist', authorization: 'Bearer must-not-persist' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: 1 });
    const ev = await h.admin.selectFrom('providerWebhookEvents').selectAll().where('deviceId', '=', deviceId).executeTakeFirstOrThrow();
    expect(ev).toMatchObject({ status: 'queued', eventId: 'evt-1', signatureValid: true, organizationId: f.orgId, payloadHash: sha256Hex(signed.rawBody) });
    expect(JSON.stringify(ev.headers)).not.toContain('must-not-persist');
    // the signature was verified once, over the raw bytes; the row carries the verified *normalised* transactions (never the body)
    expect(ev.payload).toMatchObject({ vendorDeviceId: 'WH1', eventType: 'attendance', rawBodySha256: sha256Hex(signed.rawBody), rawBodyBytes: Buffer.byteLength(signed.rawBody), transactions: [{ deviceEmployeeId: '1001', punchedAt: '2026-08-03T04:00:00Z', verificationMethod: 'face', direction: 'unknown' }] });
    expect(JSON.stringify(ev.payload)).not.toContain('"rawBody":');
    const jobs = await queueJobs(h.admin, 'WEBHOOK_EVENT');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ organizationId: f.orgId, webhookEventId: ev.id, deviceId });
    const replay = await h.request('POST', url, { raw: signed.rawBody, headers: signed.headers });
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    expect((await queueJobs(h.admin, 'WEBHOOK_EVENT')).length).toBe(1);
    const forged = signMockWebhook('wrong-secret', { ...payload, eventId: 'evt-2' });
    const bad = await h.request('POST', url, { raw: forged.rawBody, headers: forged.headers });
    expect(bad.status).toBe(401);
    expect((await h.admin.selectFrom('providerWebhookEvents').select('status').where('deviceId', '=', deviceId).where('status', '=', 'rejected').execute()).length).toBe(1);
    const wrongToken = await h.request('POST', url.replace(/[^/]+$/, 'not-the-token'), { raw: signed.rawBody, headers: signed.headers });
    expect(wrongToken.status).toBe(401);
    expect((await h.request('POST', `/webhooks/providers/zkteco_push/${deviceId}/x`, { raw: '{}' })).status).toBe(404);
  });
});
