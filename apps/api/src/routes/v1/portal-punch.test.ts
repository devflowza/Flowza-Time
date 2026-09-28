import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, domainEvents, queueJobs, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
const base = () => `/api/v1/orgs/${f.orgId}`;
const OFFICE = { lat: 23.588, lng: 58.3829 };
const FAR = { lat: 23.62, lng: 58.45 }; // several km away
let keySeq = 0;
const key = () => `test-key-${process.pid}-${(keySeq += 1)}`;
// a tiny valid PNG (1×1)
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function setSelfService(patch: Record<string, unknown>): Promise<void> {
  const row = await h.admin.selectFrom('organizationSettings').select('attendance').where('organizationId', '=', f.orgId).executeTakeFirstOrThrow();
  const att = (row.attendance ?? {}) as Record<string, unknown>;
  const selfService = { ...((att['selfService'] as Record<string, unknown>) ?? {}), ...patch };
  await h.admin.updateTable('organizationSettings').set({ attendance: JSON.stringify({ ...att, selfService }) }).where('organizationId', '=', f.orgId).execute();
}
const punch = (body: Record<string, unknown>, headers: Record<string, string> = {}, token = f.employeeUser) => h.request('POST', `${base()}/me/punch`, { token, body: { channel: 'web', idempotencyKey: key(), ...body }, headers });
async function rawRows(employeeId: string) {
  return h.admin.selectFrom('attendanceRawTransactions').selectAll().where('organizationId', '=', f.orgId).where('employeeId', '=', employeeId).orderBy('punchedAt', 'asc').execute();
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_portal_punch_${process.pid}`);
  f = await seedOrg(h.admin, 'punch');
});
afterAll(async () => { await h?.close(); });

describe('self-service check-in / check-out', () => {
  it('refuses a web check-in while the organisation has it turned off, stores nothing and audits the refusal', async () => {
    const r = await punch({ direction: 'in', ...OFFICE, accuracy: 10 });
    expect(r.status).toBe(403);
    expect(r.body.details).toMatchObject({ reason: 'WEB_CHECKIN_DISABLED' });
    expect(await rawRows(f.e1)).toHaveLength(0);
    const audit = await h.admin.selectFrom('audit.logs').selectAll().where('action', '=', 'attendance.self_punch_refused').execute();
    expect(audit.length).toBeGreaterThan(0);
    // members without an employee link and non-members never reach the policy
    expect((await punch({ direction: 'in' }, {}, f.hrAdmin)).status).toBe(403);
    expect((await punch({ direction: 'in' }, {}, f.outsider)).status).toBe(403);
  });

  it('records one raw transaction on the virtual self-service device and queues the normaliser', async () => {
    await setSelfService({ webCheckIn: true, requireGeofence: 'block', duplicatePunchSeconds: 60 });
    const idempotencyKey = key();
    const r = await h.request('POST', `${base()}/me/punch`, { token: f.employeeUser, body: { direction: 'in', channel: 'web', ...OFFICE, accuracy: 12, idempotencyKey, clientQueuedAt: '2026-01-01T00:00:00Z' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ replayed: false, outOfWindow: false, flagged: false, verdict: { verdict: 'no_fence', reason: 'no_fences_assigned' }, punch: { direction: 'in', source: 'SELF_SERVICE', channel: 'web' } });
    const rows = await rawRows(f.e1);
    expect(rows).toHaveLength(1);
    const raw = rows[0]!;
    expect(raw).toMatchObject({ source: 'SELF_SERVICE', verificationMethod: 'mobile', direction: 'in', providerKey: 'self_service', deviceEmployeeId: f.e1, processingStatus: 'pending', branchId: f.branchA });
    expect(raw.providerTransactionId).toBe(`self:${f.e1}:${idempotencyKey}`);
    expect(raw.rawPayload).toMatchObject({ channel: 'web', lat: OFFICE.lat, lng: OFFICE.lng, accuracy: 12, verdict: 'no_fence', isMock: false, outOfWindow: false, clientQueuedAt: '2026-01-01T00:00:00Z' });
    // the server's clock, not the queued time
    expect(Math.abs(new Date(raw.punchedAt).getTime() - Date.now())).toBeLessThan(60_000);
    const device = await h.admin.selectFrom('devices').selectAll().where('id', '=', raw.deviceId).executeTakeFirstOrThrow();
    expect(device).toMatchObject({ providerKey: 'self_service', status: 'disabled', autoSyncEnabled: false, integrationType: 'DEVICE_PUSH', pushTokenHash: null, code: 'FLOWZA-SELF-SERVICE' });
    expect((await queueJobs(h.admin, 'NORMALIZE_RAW')).some((j) => j.payload['deviceId'] === device.id)).toBe(true);
    // a replay of the same key returns the original punch and records nothing new
    const again = await h.request('POST', `${base()}/me/punch`, { token: f.employeeUser, body: { direction: 'in', channel: 'web', idempotencyKey } });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ replayed: true, punch: { id: r.body.data.punch.id } });
    expect(await rawRows(f.e1)).toHaveLength(1);
  });

  it('keeps the in / out sequence and answers a double tap as a duplicate', async () => {
    const twice = await punch({ direction: 'in' });
    expect(twice.status).toBe(409);
    expect(twice.body.details.reason).toBe('ALREADY_CHECKED_IN');
    const quick = await punch({ direction: 'out' });
    expect(quick.status).toBe(409);
    expect(quick.body.details.reason).toBe('DUPLICATE_PUNCH');
    await setSelfService({ duplicatePunchSeconds: 0 });
    const out = await punch({ direction: 'out' });
    expect(out.status).toBe(201);
    expect((await punch({ direction: 'out' })).body.details.reason).toBe('NOT_CHECKED_IN');
  });

  it('the virtual device is invisible to the device screens, search and plan seats', async () => {
    const device = await h.admin.selectFrom('devices').select('id').where('organizationId', '=', f.orgId).where('providerKey', '=', 'self_service').executeTakeFirstOrThrow();
    const list = await h.request('GET', `${base()}/devices?includeDecommissioned=true`, { token: f.owner });
    expect(list.status).toBe(200);
    expect(list.body.data.map((d: { id: string }) => d.id)).not.toContain(device.id);
    expect((await h.request('GET', `${base()}/devices/${device.id}`, { token: f.owner })).status).toBe(404);
    expect((await h.request('PATCH', `${base()}/devices/${device.id}`, { token: f.owner, body: { name: 'hijack' } })).status).toBe(404);
    const summary = await h.request('GET', `${base()}/devices/summary`, { token: f.owner });
    expect(summary.body.data.total).toBe(0);
    const search = await h.request('GET', `${base()}/search?q=Self`, { token: f.owner });
    expect(JSON.stringify(search.body.data.devices ?? [])).not.toContain(device.id);
  });

  it('geofence block: outside a hard fence is refused (and the manager told), a mock location too, inside is allowed', async () => {
    const fence = await h.request('POST', `${base()}/geofences`, { token: f.hrAdmin, body: { name: 'HQ', latitude: OFFICE.lat, longitude: OFFICE.lng, radiusM: 150, enforcement: 'hard_block', accuracyThresholdM: 100 } });
    expect(fence.status).toBe(201);
    expect(fence.body.data.assignments).toEqual([expect.objectContaining({ scope: 'org', targetId: null })]);
    const before = (await domainEvents(h.admin, 'attendance.punch_flagged')).length;
    const outside = await punch({ direction: 'in', ...FAR, accuracy: 10 });
    expect(outside.status).toBe(403);
    expect(outside.body.details).toMatchObject({ reason: 'OUTSIDE_GEOFENCE', verdict: 'denied_outside' });
    const flagged = await domainEvents(h.admin, 'attendance.punch_flagged');
    expect(flagged.length).toBe(before + 1);
    expect((flagged.at(-1)!.payload as Record<string, unknown>)).toMatchObject({ outcome: 'denied', employeeId: f.e1, userIds: [f.managerUser] });
    const mock = await punch({ direction: 'in', ...OFFICE, accuracy: 5, isMock: true });
    expect(mock.status).toBe(403);
    expect(mock.body.details.reason).toBe('MOCK_LOCATION');
    const noFix = await punch({ direction: 'in' });
    expect(noFix.body.details.reason).toBe('OUTSIDE_GEOFENCE');
    const inside = await punch({ direction: 'in', ...OFFICE, accuracy: 20 });
    expect(inside.status).toBe(201);
    expect(inside.body.data.verdict).toMatchObject({ verdict: 'allowed', geofenceId: fence.body.data.id, geofenceName: 'HQ' });
    // the preview tells the same story before anything is sent
    const preview = await h.request('POST', `${base()}/me/punch/preview`, { token: f.employeeUser, body: { direction: 'out', ...FAR, accuracy: 10 } });
    expect(preview.status).toBe(200);
    expect(preview.body.data.refusals).toContain('OUTSIDE_GEOFENCE');
    // soft warn: recorded, flagged, the payload carries the verdict the engine turns into OUTSIDE_GEOFENCE
    await h.request('PATCH', `${base()}/geofences/${fence.body.data.id}`, { token: f.hrAdmin, body: { enforcement: 'soft_warn' } });
    const warned = await punch({ direction: 'out', ...FAR, accuracy: 10 });
    expect(warned.status).toBe(201);
    expect(warned.body.data).toMatchObject({ flagged: true, verdict: { verdict: 'flagged', reason: 'outside' } });
    const raw = (await rawRows(f.e1)).at(-1)!;
    expect(raw.rawPayload).toMatchObject({ verdict: 'flagged', geofenceId: fence.body.data.id });
    expect((await domainEvents(h.admin, 'attendance.punch_flagged')).at(-1)!.payload).toMatchObject({ outcome: 'flagged' });
  });

  it('enforces the IP allow-list, the check-in window and the mobile switch', async () => {
    await setSelfService({ ipAllowList: ['10.0.0.0/8', '2001:db8::/32'] });
    const blocked = await punch({ direction: 'in', ...OFFICE, accuracy: 10 }, { 'x-forwarded-for': '192.168.1.5' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.details.reason).toBe('IP_NOT_ALLOWED');
    // a window that excludes the current Muscat time, rejected then flagged
    const now = DateTime.now().setZone('Asia/Muscat');
    const start = now.plus({ hours: 3 }).toFormat('HH:mm'); const end = now.plus({ hours: 4 }).toFormat('HH:mm');
    await setSelfService({ checkInWindow: { start, end }, outOfWindowAction: 'reject' });
    const rejected = await punch({ direction: 'in', ...OFFICE, accuracy: 10 }, { 'x-forwarded-for': '10.1.2.3' });
    expect(rejected.status).toBe(403);
    expect(rejected.body.details.reason).toBe('OUT_OF_WINDOW');
    await setSelfService({ outOfWindowAction: 'flag' });
    const flagged = await punch({ direction: 'in', ...OFFICE, accuracy: 10 }, { 'x-forwarded-for': '10.1.2.3' });
    expect(flagged.status).toBe(201);
    expect(flagged.body.data).toMatchObject({ outOfWindow: true, flagged: true });
    expect((await rawRows(f.e1)).at(-1)!.rawPayload).toMatchObject({ outOfWindow: true, ip: '10.1.2.3' });
    await setSelfService({ checkInWindow: null, ipAllowList: [] });
    const mobile = await punch({ direction: 'out', channel: 'mobile', ...OFFICE, accuracy: 10 });
    expect(mobile.status).toBe(403);
    expect(mobile.body.details.reason).toBe('MOBILE_CHECKIN_DISABLED');
  });

  it('refuses a punch inside a locked period (409) and reports the blockers on the status endpoint', async () => {
    const today = DateTime.now().setZone('Asia/Muscat').toISODate()!;
    const lock = await h.admin.insertInto('attendancePeriodLocks').values({ organizationId: f.orgId, branchId: null, periodStart: today, periodEnd: today, lockedBy: f.owner, reason: 'test' }).returning('id').executeTakeFirstOrThrow();
    const r = await punch({ direction: 'out', ...OFFICE, accuracy: 10 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PERIOD_LOCKED');
    const status = await h.request('GET', `${base()}/me/punch/status`, { token: f.employeeUser });
    expect(status.status).toBe(200);
    expect(status.body.data.blockers).toContain('PERIOD_LOCKED');
    expect(status.body.data.canCheckIn).toBe(false);
    await h.admin.updateTable('attendancePeriodLocks').set({ unlockedAt: new Date(), unlockedBy: f.owner }).where('id', '=', lock.id).execute();
    const after = await h.request('GET', `${base()}/me/punch/status`, { token: f.employeeUser });
    expect(after.body.data).toMatchObject({ lastDirection: 'in', canCheckIn: false, canCheckOut: true, timezone: 'Asia/Muscat', blockers: [], selfieAvailable: false });
    expect(after.body.data.punches.length).toBeGreaterThanOrEqual(4);
    expect(after.body.data.fences).toEqual([expect.objectContaining({ name: 'HQ', scope: 'org' })]);
    expect(after.body.data.policy).toMatchObject({ webCheckIn: true, requireGeofence: 'block', ipRestricted: false });
  });
});

describe('selfie check-in and attendance grants', () => {
  it('needs the organisation switch and a grant from the manager', async () => {
    const off = await h.request('POST', `${base()}/me/selfie-checkin`, { token: f.employeeUser, body: { direction: 'in', imageBase64: PNG_BASE64, ...OFFICE, accuracy: 10 } });
    expect(off.status).toBe(403);
    expect(off.body.details.reason).toBe('SELFIE_DISABLED');
    await setSelfService({ allowSelfieCheckIn: true });
    const noGrant = await h.request('POST', `${base()}/me/selfie-checkin`, { token: f.employeeUser, body: { direction: 'in', imageBase64: PNG_BASE64 } });
    expect(noGrant.status).toBe(403);
    expect(noGrant.body.details.reason).toBe('SELFIE_NOT_GRANTED');
  });

  it('grants: the line manager or an attendance approver sets them; nobody grants themselves; employees cannot', async () => {
    expect((await h.request('PUT', `${base()}/employees/${f.e1}/attendance-grants`, { token: f.employeeUser, body: { openAttendance: true, selfieRequired: true } })).status).toBe(403);
    expect((await h.request('GET', `${base()}/employees/${f.e1}/attendance-grants`, { token: f.payrollUser })).status).toBe(403);
    // the manager's own record: self-grant refused even with the keys
    expect((await h.request('PUT', `${base()}/employees/${f.e3}/attendance-grants`, { token: f.managerUser, body: { openAttendance: true, selfieRequired: false } })).status).toBe(403);
    const r = await h.request('PUT', `${base()}/employees/${f.e1}/attendance-grants`, { token: f.managerUser, body: { openAttendance: true, selfieRequired: true } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ employeeId: f.e1, openAttendance: true, selfieRequired: true, grantedBy: f.managerUser, grantedByName: 'managerUser' });
    const read = await h.request('GET', `${base()}/employees/${f.e1}/attendance-grants`, { token: f.hrAdmin });
    expect(read.body.data).toMatchObject({ openAttendance: true, selfieRequired: true });
    expect((await h.admin.selectFrom('audit.logs').select('action').where('action', '=', 'attendance.grants_updated').execute()).length).toBe(1);
    // with a selfie required the plain punch is refused
    const plain = await punch({ direction: 'out', ...OFFICE, accuracy: 10 });
    expect(plain.status).toBe(403);
    expect(plain.body.details.reason).toBe('SELFIE_REQUIRED');
  });

  let selfieId: string;
  it('stores the photo privately, queues it for the manager, and approval records a face punch', async () => {
    const bad = await h.request('POST', `${base()}/me/selfie-checkin`, { token: f.employeeUser, body: { direction: 'out', imageBase64: Buffer.from('not an image at all, just text').toString('base64') } });
    expect(bad.status).toBe(400);
    const r = await h.request('POST', `${base()}/me/selfie-checkin`, { token: f.employeeUser, body: { direction: 'out', imageBase64: `data:image/png;base64,${PNG_BASE64}`, ...FAR, accuracy: 10 } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ employeeId: f.e1, direction: 'out', status: 'pending', verdict: 'flagged' });
    selfieId = r.body.data.id;
    const row = await h.admin.selectFrom('selfieCheckins').selectAll().where('id', '=', selfieId).executeTakeFirstOrThrow();
    expect(row.photoPath).toBe(`checkins/${f.orgId}/${f.e1}/${selfieId}.png`);
    expect(h.uploads.get(`employee-photos/${row.photoPath}`)?.contentType).toBe('image/png');
    expect((await domainEvents(h.admin, 'attendance.selfie_submitted')).at(-1)!.payload).toMatchObject({ selfieId, userIds: [f.managerUser] });
    const list = await h.request('GET', `${base()}/attendance/selfie-checkins?status=pending`, { token: f.managerUser });
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([expect.objectContaining({ id: selfieId, viaManager: true, employeeName: 'Employee 1' })]);
    const photo = await h.request('GET', `${base()}/attendance/selfie-checkins/${selfieId}/photo`, { token: f.managerUser });
    expect(photo.status).toBe(200);
    expect(photo.body.data).toMatchObject({ expiresInSeconds: 60 });
    expect(photo.body.data.url).toContain(`checkins/${f.orgId}/${f.e1}/`);
    // the employee cannot open the review side, nor review themselves
    expect((await h.request('POST', `${base()}/attendance/selfie-checkins/${selfieId}/review`, { token: f.employeeUser, body: { decision: 'approve' } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/attendance/selfie-checkins/${selfieId}/review`, { token: f.payrollUser, body: { decision: 'approve' } })).status).toBe(404);
    const ok = await h.request('POST', `${base()}/attendance/selfie-checkins/${selfieId}/review`, { token: f.managerUser, body: { decision: 'approve' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'approved', reviewedBy: f.managerUser });
    const raw = await h.admin.selectFrom('attendanceRawTransactions').selectAll().where('providerTransactionId', '=', `selfie:${selfieId}`).executeTakeFirstOrThrow();
    expect(raw).toMatchObject({ source: 'SELF_SERVICE', verificationMethod: 'face', direction: 'out', employeeId: f.e1 });
    expect(String(ok.body.data.rawTransactionId)).toBe(String(raw.id));
    expect((await domainEvents(h.admin, 'attendance.selfie_decided')).at(-1)!.payload).toMatchObject({ decision: 'approved', userIds: [f.employeeUser] });
    expect((await h.request('POST', `${base()}/attendance/selfie-checkins/${selfieId}/review`, { token: f.managerUser, body: { decision: 'approve' } })).status).toBe(409);
  });

  it('a rejection needs a reason; the multipart form works too', async () => {
    const form = new FormData();
    form.set('direction', 'in');
    form.set('lat', String(OFFICE.lat)); form.set('lng', String(OFFICE.lng)); form.set('accuracy', '15');
    form.set('photo', new Blob([Buffer.from(PNG_BASE64, 'base64')], { type: 'image/png' }), 'selfie.png');
    const res = await h.app.request(`${base()}/me/selfie-checkin`, { method: 'POST', headers: { authorization: `Bearer user:${f.employeeUser}` }, body: form });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string; verdict: string } }).data.id;
    expect((await h.request('POST', `${base()}/attendance/selfie-checkins/${id}/review`, { token: f.managerUser, body: { decision: 'reject' } })).status).toBe(400);
    const r = await h.request('POST', `${base()}/attendance/selfie-checkins/${id}/review`, { token: f.hrAdmin, body: { decision: 'reject', reason: 'Photo does not show you' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'rejected', reviewReason: 'Photo does not show you', viaManager: false });
    expect((await h.admin.selectFrom('attendanceRawTransactions').select('id').where('providerTransactionId', '=', `selfie:${id}`).execute())).toHaveLength(0);
  });
});

describe('geofence administration', () => {
  let fenceId: string;
  it('needs attendance.manage_geofences to write; readers see the list', async () => {
    expect((await h.request('POST', `${base()}/geofences`, { token: f.employeeUser, body: { name: 'X', latitude: 1, longitude: 1, radiusM: 100 } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/geofences`, { token: f.hrUser, body: { name: 'X', latitude: 1, longitude: 1, radiusM: 100 } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/geofences`, { token: f.hrAdmin, body: { name: 'X', latitude: 1, longitude: 1, radiusM: 10 } })).status).toBe(400);
    const r = await h.request('POST', `${base()}/geofences`, { token: f.hrAdmin, body: { name: 'Site B', branchId: f.branchB, latitude: 23.6, longitude: 58.5, radiusM: 300, enforcement: 'advisory_log', accuracyThresholdM: 80, graceM: 25, timeWindows: [{ days: [1, 2, 3, 4, 5], start: '06:00', end: '20:00' }] } });
    expect(r.status).toBe(201);
    fenceId = r.body.data.id;
    expect(r.body.data).toMatchObject({ branchId: f.branchB, branchName: 'Branch B', enforcement: 'advisory_log', graceM: 25, assignments: [expect.objectContaining({ scope: 'branch', targetId: f.branchB, targetName: 'Branch B' })] });
    const list = await h.request('GET', `${base()}/geofences`, { token: f.hrUser });
    expect(list.status).toBe(200);
    expect(list.body.data.map((g: { name: string }) => g.name).sort()).toEqual(['HQ', 'Site B']);
    expect((await h.request('GET', `${base()}/geofences`, { token: f.employeeUser })).status).toBe(403);
  });

  it('a one-field PATCH leaves every other setting alone', async () => {
    const r = await h.request('PATCH', `${base()}/geofences/${fenceId}`, { token: f.hrAdmin, body: { name: 'Site B (north)' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ name: 'Site B (north)', enforcement: 'advisory_log', accuracyThresholdM: 80, graceM: 25, isActive: true, radiusM: 300 });
    expect(r.body.data.timeWindows).toHaveLength(1);
    expect((await h.request('PATCH', `${base()}/geofences/${fenceId}`, { token: f.hrAdmin, body: { activeFrom: '2026-05-01', activeTo: '2026-04-01' } })).status).toBe(400);
  });

  it('assignments are replaced as a whole; a branch-scoped member stays inside their branches', async () => {
    const r = await h.request('PUT', `${base()}/geofences/${fenceId}/assignments`, { token: f.hrAdmin, body: { assignments: [{ scope: 'employee', targetId: f.e2, priority: 10 }, { scope: 'department', targetId: f.departmentA, requireOnCheckOut: false }] } });
    expect(r.status).toBe(200);
    expect(r.body.data.assignments.map((a: { scope: string; targetName: string }) => `${a.scope}:${a.targetName}`)).toEqual(['employee:Employee 2', 'department:Operations']);
    expect((await h.request('PUT', `${base()}/geofences/${fenceId}/assignments`, { token: f.hrAdmin, body: { assignments: [{ scope: 'employee', targetId: uuid('z') }] } })).status).toBe(400);
    expect((await h.request('PUT', `${base()}/geofences/${fenceId}/assignments`, { token: f.hrAdmin, body: { assignments: [{ scope: 'org', targetId: f.branchA }] } })).status).toBe(400);
  });

  it('the dry-run tester evaluates a spot for an employee without recording anything', async () => {
    const r = await h.request('POST', `${base()}/geofences/evaluate`, { token: f.hrAdmin, body: { employeeId: f.e2, lat: 23.6, lng: 58.5, accuracy: 10, at: '2026-09-28T08:00:00Z' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ requireGeofence: 'block', winningScope: 'employee', verdict: { verdict: 'allowed', geofenceId: fenceId } });
    expect(r.body.data.fences[0]).toMatchObject({ id: fenceId, considered: true, outcome: 'allowed' });
    const sunday = await h.request('POST', `${base()}/geofences/evaluate`, { token: f.hrAdmin, body: { employeeId: f.e2, lat: 23.6, lng: 58.5, accuracy: 10, at: '2026-09-27T08:00:00Z' } });
    expect(sunday.body.data.winningScope).toBe('org'); // the employee fence is outside its window on a Sunday: the org fence decides
    expect((await h.request('POST', `${base()}/geofences/evaluate`, { token: f.employeeUser, body: { employeeId: f.e1, lat: 1, lng: 1 } })).status).toBe(403);
  });

  it('delete removes the fence and its assignments', async () => {
    expect((await h.request('DELETE', `${base()}/geofences/${fenceId}`, { token: f.hrUser })).status).toBe(403);
    expect((await h.request('DELETE', `${base()}/geofences/${fenceId}`, { token: f.hrAdmin })).status).toBe(204);
    expect((await h.request('GET', `${base()}/geofences/${fenceId}`, { token: f.hrAdmin })).status).toBe(404);
    expect(await h.admin.selectFrom('geofenceAssignments').select('id').where('geofenceId', '=', fenceId).execute()).toHaveLength(0);
    const audits = await h.admin.selectFrom('audit.logs').select('action').where('entityType', '=', 'geofence').execute();
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['geofence.created', 'geofence.updated', 'geofence.assignments_replaced', 'geofence.deleted']));
  });

  it('isolates tenants: another organisation reads and writes none of it', async () => {
    const other = await seedOrg(h.admin, 'punch-other');
    const theirs = await h.request('GET', `/api/v1/orgs/${other.orgId}/geofences`, { token: other.hrAdmin });
    expect(theirs.body.data).toEqual([]);
    expect((await h.request('GET', `${base()}/geofences`, { token: other.hrAdmin })).status).toBe(403);
    expect((await h.request('GET', `${base()}/attendance/selfie-checkins`, { token: other.hrAdmin })).status).toBe(403);
    const cnt = await sql<{ n: number }>`select count(*)::int as n from public.selfie_checkins where organization_id = ${other.orgId}::uuid`.execute(h.admin);
    expect(cnt.rows[0]!.n).toBe(0);
  });
});

describe('an employee of another team', () => {
  it('a manager of a different team cannot grant, list or review', async () => {
    const e5 = await seedEmployee(h.admin, f.orgId, f.branchB, 5);
    const otherManager = uuid('c');
    await seedUser(h.admin, otherManager, 'other-manager@test.local', 'Other manager');
    await seedMembership(h.admin, f.orgId, otherManager, ROLE.manager, { employeeId: e5 });
    expect((await h.request('PUT', `${base()}/employees/${f.e1}/attendance-grants`, { token: otherManager, body: { openAttendance: true, selfieRequired: false } })).status).toBe(403);
    const list = await h.request('GET', `${base()}/attendance/selfie-checkins`, { token: otherManager });
    expect(list.status).toBe(403);
  });
});
