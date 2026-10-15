/**
 * Time away inside the working day (docs/time-away.md): the policy gate, planned windows and their limits (overlap, personal
 * quota, longest window), stepping out and coming back from the portal (break-out / break-in punches on the self-service
 * device), the approval hook (approved window → the day is recomputed), withdrawal, and the HR / manager lists.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY_SECTIONS } from '@flowza/contracts';
import { createApiHarness, isoTodayIn, queueJobs, seedDevice, type ApiHarness, type OrgFixture, seedOrg } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
const base = () => `/api/v1/orgs/${f.orgId}`;
const TZ = 'Asia/Muscat';
const today = () => isoTodayIn(TZ);
const at = (date: string, time: string) => new Date(`${date}T${time}:00+04:00`).toISOString();
const policySections = (timeAway: Record<string, unknown> = {}) => ({ ...DEFAULT_POLICY_SECTIONS, timeAway: { ...DEFAULT_POLICY_SECTIONS.timeAway, enabled: true, ...timeAway } });
let deviceId: string;

async function setPolicy(timeAway: Record<string, unknown> | null, mode: 'FIRST_LAST' | 'PAIRED' | 'DIRECTIONAL' = 'DIRECTIONAL') {
  await h.admin.deleteFrom('attendanceRuleSets').where('organizationId', '=', f.orgId).execute();
  await h.admin.insertInto('attendanceRuleSets').values({ organizationId: f.orgId, name: 'Org policy', effectiveFrom: '2020-01-01', punchInterpretation: mode, policy: JSON.stringify(timeAway === null ? DEFAULT_POLICY_SECTIONS : policySections(timeAway)) } as never).execute();
}
async function terminalPunch(direction: 'in' | 'out', minutesAgo: number) {
  const punchedAt = new Date(Date.now() - minutesAgo * 60_000);
  await h.admin.insertInto('attendanceRawTransactions').values({ organizationId: f.orgId, deviceId, branchId: f.branchA, providerKey: 'mock', deviceEmployeeId: f.deviceUserIds.e1, employeeId: f.e1, punchedAt, direction, source: 'DEVICE_PUSH', dedupeHash: `t-${direction}-${minutesAgo}-${Math.random()}`, processingStatus: 'normalized', deviceGeneration: 1 } as never).execute();
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_time_away_${process.pid}`);
  f = await seedOrg(h.admin, 'timeaway');
  deviceId = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'GATE-1' });
});
afterAll(async () => { await h?.close(); });

describe('policy gate', () => {
  it('refuses a window while the policy does not measure time away, and says why', async () => {
    await setPolicy(null);
    const r = await h.request('POST', `${base()}/me/time-away`, { token: f.employeeUser, body: { kind: 'OFFICIAL', startsAt: at(today(), '10:00'), endsAt: at(today(), '11:00'), reason: 'Client visit' } });
    expect(r.status).toBe(403);
    expect(r.body.details.reason).toBe('TIME_AWAY_DISABLED');
    await setPolicy({}, 'FIRST_LAST');
    const s = await h.request('GET', `${base()}/me/time-away/status`, { token: f.employeeUser });
    expect(s.status).toBe(200);
    expect(s.body.data.policy).toMatchObject({ enabled: true, inactiveReason: 'FIRST_LAST_INTERPRETATION' });
    expect(s.body.data.canStepOut).toBe(false);
  });

  it('a policy cannot switch time away on with FIRST_LAST punches (the engine would measure nothing)', async () => {
    const r = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.owner, body: { name: 'Bad', effectiveFrom: '2030-01-01', punchInterpretation: 'FIRST_LAST', policy: policySections() } });
    expect(r.status).toBe(400);
    expect(r.body.details.reason).toBe('TIME_AWAY_NEEDS_PAIRS');
    // the time-away section is core: no attendance_policies module needed for it
    const ok = await h.request('POST', `${base()}/attendance-rule-sets`, { token: f.owner, body: { name: 'Good', branchId: f.branchB, effectiveFrom: '2030-01-01', punchInterpretation: 'DIRECTIONAL', policy: policySections() } });
    expect(ok.status).toBe(201);
  });
});

describe('planned windows', () => {
  let personalId: string;
  beforeAll(async () => { await setPolicy({ personalMonthlyQuotaMinutes: 120, personalMaxMinutes: 90 }); });

  it('files a window for the line manager (approval engine, entity TIME_AWAY)', async () => {
    const r = await h.request('POST', `${base()}/me/time-away`, { token: f.employeeUser, body: { kind: 'PERSONAL', startsAt: at(today(), '10:00'), endsAt: at(today(), '11:00'), reason: 'School meeting', destination: 'Al Khuwair school' } });
    expect(r.status).toBe(201);
    personalId = r.body.data.id;
    expect(r.body.data).toMatchObject({ kind: 'PERSONAL', source: 'request', status: 'pending', minutes: 60, attendanceDate: today(), approvalStatus: 'PENDING', destination: 'Al Khuwair school' });
    const req = await h.admin.selectFrom('approvalRequests').selectAll().where('entityId', '=', personalId).executeTakeFirstOrThrow();
    expect(req).toMatchObject({ entityType: 'TIME_AWAY', status: 'PENDING', employeeId: f.e1 });
    const inbox = await h.request('GET', `${base()}/approvals?view=pending&scope=mine`, { token: f.managerUser });
    expect(inbox.status).toBe(200);
    const row = inbox.body.data.find((x: { entityId: string }) => x.entityId === personalId);
    expect(row.context).toMatchObject({ kind: 'TIME_AWAY', timeAway: { kind: 'PERSONAL', minutes: 60, personalUsedMinutes: 60, personalMonthlyQuotaMinutes: 120 } });
  });

  it('refuses an overlapping window, one beyond the personal maximum and one beyond the monthly quota', async () => {
    const overlap = await h.request('POST', `${base()}/me/time-away`, { token: f.employeeUser, body: { kind: 'OFFICIAL', startsAt: at(today(), '10:30'), endsAt: at(today(), '12:00'), reason: 'Bank' } });
    expect(overlap.status).toBe(409);
    const long = await h.request('POST', `${base()}/me/time-away`, { token: f.employeeUser, body: { kind: 'PERSONAL', startsAt: at(today(), '13:00'), endsAt: at(today(), '14:45'), reason: 'Clinic' } });
    expect(long.status).toBe(400);
    expect(long.body.details.reason).toBe('TIME_AWAY_TOO_LONG');
    const quota = await h.request('POST', `${base()}/me/time-away`, { token: f.employeeUser, body: { kind: 'PERSONAL', startsAt: at(today(), '13:00'), endsAt: at(today(), '14:10'), reason: 'Clinic' } });
    expect(quota.status).toBe(400);
    expect(quota.body.details).toMatchObject({ reason: 'TIME_AWAY_QUOTA', quotaMinutes: 120, usedMinutes: 60 });
  });

  it('approval makes the window count and recomputes its day', async () => {
    const req = await h.admin.selectFrom('approvalRequests').select('id').where('entityId', '=', personalId).executeTakeFirstOrThrow();
    const d = await h.request('POST', `${base()}/approvals/${req.id}/decide`, { token: f.managerUser, body: { decision: 'APPROVE', stepNo: 1, comment: 'Fine' } });
    expect(d.status).toBe(200);
    const row = await h.admin.selectFrom('timeAwayRequests').selectAll().where('id', '=', personalId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'approved', decisionNote: 'Fine' });
    const jobs = (await queueJobs(h.admin, 'RECOMPUTE_DAILY')).filter((j) => j.payload['employeeId'] === f.e1 && j.payload['reason'] === 'TIME_AWAY');
    expect(jobs.map((j) => j.payload['date'])).toContain(today());
  });

  it('withdraws a pending window (and its approval request); a decided one cannot be withdrawn by the employee', async () => {
    const r = await h.request('POST', `${base()}/me/time-away`, { token: f.employeeUser, body: { kind: 'OFFICIAL', startsAt: at(today(), '15:00'), endsAt: at(today(), '16:00'), reason: 'Ministry' } });
    expect(r.status).toBe(201);
    const c = await h.request('POST', `${base()}/me/time-away/${r.body.data.id}/cancel`, { token: f.employeeUser, body: {} });
    expect(c.status).toBe(200);
    expect(c.body.data.status).toBe('cancelled');
    expect((await h.admin.selectFrom('approvalRequests').select('status').where('entityId', '=', r.body.data.id).executeTakeFirstOrThrow()).status).toBe('CANCELLED');
    expect((await h.request('POST', `${base()}/me/time-away/${personalId}/cancel`, { token: f.employeeUser, body: {} })).status).toBe(409);
    // nobody else's
    expect((await h.request('POST', `${base()}/me/time-away/${personalId}/cancel`, { token: f.managerUser, body: {} })).status).toBe(403);
  });
});

describe('stepping out and coming back from the portal', () => {
  beforeAll(async () => {
    await setPolicy({ returnBy: 'device_or_portal', personalMonthlyQuotaMinutes: null, personalMaxMinutes: null });
    await h.admin.deleteFrom('timeAwayRequests').where('organizationId', '=', f.orgId).execute();
  });

  it('can only step out while on site', async () => {
    const r = await h.request('POST', `${base()}/me/time-away/step-out`, { token: f.employeeUser, body: { kind: 'OFFICIAL', expectedBackAt: new Date(Date.now() + 3_600_000).toISOString(), reason: 'Client visit', idempotencyKey: 'step-out-0001' } });
    expect(r.status).toBe(409);
    expect(r.body.details.reason).toBe('NOT_ON_SITE');
  });

  it('records a break-out punch and a window from now to the expected return; replays answer the same request', async () => {
    await terminalPunch('in', 90);
    const s0 = await h.request('GET', `${base()}/me/time-away/status`, { token: f.employeeUser });
    expect(s0.body.data).toMatchObject({ onSite: true, canStepOut: true, away: null });
    const body = { kind: 'OFFICIAL', expectedBackAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), reason: 'Client visit — Oman LNG', destination: 'Sur', idempotencyKey: 'step-out-0002' };
    const r = await h.request('POST', `${base()}/me/time-away/step-out`, { token: f.employeeUser, body });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ source: 'step_out', kind: 'OFFICIAL', status: 'pending', destination: 'Sur' });
    const raw = await h.admin.selectFrom('attendanceRawTransactions').selectAll().where('organizationId', '=', f.orgId).where('source', '=', 'SELF_SERVICE').execute();
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ direction: 'break_out', employeeId: f.e1 });
    const replay = await h.request('POST', `${base()}/me/time-away/step-out`, { token: f.employeeUser, body });
    expect(replay.body.data.id).toBe(r.body.data.id);
    const s1 = await h.request('GET', `${base()}/me/time-away/status`, { token: f.employeeUser });
    expect(s1.body.data).toMatchObject({ onSite: false, canStepOut: false, canComeBack: true, away: { requestId: r.body.data.id, kind: 'OFFICIAL' } });
    const again = await h.request('POST', `${base()}/me/time-away/step-out`, { token: f.employeeUser, body: { ...body, idempotencyKey: 'step-out-0003' } });
    expect(again.status).toBe(409);
    expect(again.body.details.reason).toBe('ALREADY_AWAY');
  });

  it('"I\'m back" records a break-in punch when the policy allows the portal, and only then', async () => {
    await setPolicy({ returnBy: 'device' });
    const refused = await h.request('POST', `${base()}/me/time-away/back`, { token: f.employeeUser, body: { idempotencyKey: 'back-0001' } });
    expect(refused.status).toBe(403);
    expect(refused.body.details.reason).toBe('RETURN_ON_DEVICE');
    await setPolicy({ returnBy: 'device_or_portal' });
    const r = await h.request('POST', `${base()}/me/time-away/back`, { token: f.employeeUser, body: { idempotencyKey: 'back-0002' } });
    expect(r.status).toBe(200);
    expect(r.body.data.returnedAt).not.toBeNull();
    const raw = await h.admin.selectFrom('attendanceRawTransactions').select(['direction']).where('organizationId', '=', f.orgId).where('source', '=', 'SELF_SERVICE').orderBy('punchedAt').execute();
    expect(raw.map((x) => x.direction)).toEqual(['break_out', 'break_in']);
    const s = await h.request('GET', `${base()}/me/time-away/status`, { token: f.employeeUser });
    expect(s.body.data).toMatchObject({ onSite: true, away: null, canComeBack: false });
  });

  it('a meeting-room reader entry is room access: not one of today\'s punches, and it never turns the employee in or out', async () => {
    const reader = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'ROOM-1' });
    await h.admin.updateTable('devices').set({ punchRole: 'ACCESS' } as never).where('id', '=', reader).execute();
    const before = await h.request('GET', `${base()}/me/punch/status?channel=web`, { token: f.employeeUser });
    expect(before.status).toBe(200);
    await h.admin.insertInto('attendanceRawTransactions').values({ organizationId: f.orgId, deviceId: reader, branchId: f.branchA, providerKey: 'mock', deviceEmployeeId: f.deviceUserIds.e1, employeeId: f.e1, punchedAt: new Date(Date.now() - 60_000), direction: 'in', source: 'DEVICE_PUSH', dedupeHash: `room-${Math.random()}`, processingStatus: 'normalized', deviceGeneration: 1 } as never).execute();
    const after = await h.request('GET', `${base()}/me/punch/status?channel=web`, { token: f.employeeUser });
    expect(after.body.data.punches.map((p: { id: string }) => p.id)).toEqual(before.body.data.punches.map((p: { id: string }) => p.id));
    expect(after.body.data.lastDirection).toBe(before.body.data.lastDirection);
    const ta = await h.request('GET', `${base()}/me/time-away/status`, { token: f.employeeUser });
    expect(ta.body.data).toMatchObject({ onSite: true });
  });
});

describe('HR and manager lists', () => {
  it('HR lists the windows (branch scope) and the month\'s totals from the daily records; an employee cannot', async () => {
    await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId: f.e1, attendanceDate: sql<Date>`${today()}::date`, branchId: f.branchA, timezone: TZ, engineVersion: 'test', status: 'PRESENT', flags: ['TIME_AWAY', 'UNAPPROVED_AWAY'], workedMinutes: 300, awayMinutes: 90, officialDutyMinutes: 60, unapprovedAwayMinutes: 30, trace: JSON.stringify({ punches: [] }) } as never).onConflict((oc) => oc.doNothing()).execute();
    const list = await h.request('GET', `${base()}/time-away?from=${today()}&to=${today()}`, { token: f.hrAdmin });
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(list.body.data[0]).toMatchObject({ employeeId: f.e1, employeeNumber: expect.any(String) });
    const sum = await h.request('GET', `${base()}/time-away/summary?month=${today().slice(0, 7)}`, { token: f.hrAdmin });
    expect(sum.status).toBe(200);
    expect(sum.body.data.find((x: { employeeId: string }) => x.employeeId === f.e1)).toMatchObject({ awayMinutes: 90, officialDutyMinutes: 60, unapprovedAwayMinutes: 30, unapprovedDays: 1 });
    expect((await h.request('GET', `${base()}/time-away?from=${today()}&to=${today()}`, { token: f.employeeUser })).status).toBe(403);
    // a branch-B manager sees nothing of branch A
    const b = await h.request('GET', `${base()}/time-away?from=${today()}&to=${today()}`, { token: f.branchManagerB });
    expect(b.status === 403 || b.body.data.length === 0).toBe(true);
  });
});
