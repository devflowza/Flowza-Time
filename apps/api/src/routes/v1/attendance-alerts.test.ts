/**
 * Attendance alerts, API side (customer requirements "automatic handling of absence" and "weekly thank-you messages"):
 *  - the excuse deadline (`attendance.unexcused.excuseDeadlineDays`): the portal refuses a NEW reason for a day past its
 *    deadline with a clear error, accepts one up to and on the deadline, and HR can still excuse the day;
 *  - the notifications group stores the alert settings whole and a one-field save leaves every other choice alone;
 *  - "Send now for last week" queues the worker's appreciation job (202 + queue job id), notification.manage only, refused
 *    while the appreciation is switched off.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ATTENDANCE_APPRECIATION_JOB_TYPE } from '@flowza/database';
import { auditRows, createApiHarness, isoTodayIn, queueJobs, seedOrg, type ApiHarness, type OrgFixture } from '../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
const base = () => `/api/v1/orgs/${f.orgId}`;
const day = (offset: number) => isoTodayIn('Asia/Muscat', offset);
const note = (date: string, token = f.employeeUser) => h.request('POST', `${base()}/me/attendance/notes`, { token, body: { date, category: 'absence_reason', note: 'I was at the clinic with my son' } });

async function putGroup(group: 'attendance' | 'notifications', change: (current: Record<string, any>) => Record<string, unknown>, token = f.owner) {
  const current = (await h.request('GET', `${base()}/settings/${group}`, { token })).body.data as Record<string, any>;
  return h.request('PUT', `${base()}/settings/${group}`, { token, body: change(current) });
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_attendance_alerts_${process.pid}`);
  f = await seedOrg(h.admin, 'alerts');
});
afterAll(async () => { await h?.close(); });

describe('the excuse deadline', () => {
  it('without a deadline (the default) a reason can be given for an old day', async () => {
    const res = await note(day(-12));
    expect(res.status).toBe(201);
  });

  it('with a deadline, a new reason for a day past it is refused with the date it ended; up to and on the deadline it is accepted', async () => {
    const saved = await putGroup('attendance', (c) => ({ ...c, unexcused: { ...c.unexcused, excuseDeadlineDays: 3 } }));
    expect(saved.status).toBe(200);
    expect(saved.body.data.unexcused.excuseDeadlineDays).toBe(3);
    const late = await note(day(-5));
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('UNPROCESSABLE');
    expect(late.body.message).toBe(`The deadline to give a reason for ${day(-5)} was ${day(-2)}. Ask HR to record it.`);
    expect(await h.admin.selectFrom('attendanceNotes').select('id').where('organizationId', '=', f.orgId).where('employeeId', '=', f.e1).where('attendanceDate', '=', day(-5) as never).execute()).toEqual([]);
    expect((await note(day(-3))).status).toBe(201); // the deadline is today: still in time
    expect((await note(day(-1))).status).toBe(201);
  });

  it('HR can still record the day past the deadline', async () => {
    const res = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e1, attendanceDate: day(-5), kind: 'EXCUSED', reason: 'Medical certificate handed to HR' } });
    expect(res.status).toBe(201);
  });

  it('the deadline is 1–60 days or none', async () => {
    expect((await putGroup('attendance', (c) => ({ ...c, unexcused: { ...c.unexcused, excuseDeadlineDays: 0 } }))).status).toBe(400);
    expect((await putGroup('attendance', (c) => ({ ...c, unexcused: { ...c.unexcused, excuseDeadlineDays: 61 } }))).status).toBe(400);
    const off = await putGroup('attendance', (c) => ({ ...c, unexcused: { ...c.unexcused, excuseDeadlineDays: null } }));
    expect(off.status).toBe(200);
    expect(off.body.data.unexcused.excuseDeadlineDays).toBeNull();
    expect((await note(day(-6))).status).toBe(201);
  });
});

describe('alert settings and "Send now"', () => {
  it('a one-field save of the notifications group keeps every other alert choice', async () => {
    const first = await putGroup('notifications', (c) => ({ ...c, lateArrivalAlert: { ...c.lateArrivalAlert, notifyManager: false, minMinutes: 10 }, missingCheckInReminder: true, appreciation: { ...c.appreciation, weekday: 0, hour: 9 } }));
    expect(first.status).toBe(200);
    const second = await putGroup('notifications', (c) => ({ ...c, earlyDepartureAlert: { ...c.earlyDepartureAlert, minMinutes: 20 } }));
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({
      lateArrivalAlert: { enabled: true, notifyEmployee: true, notifyManager: false, minMinutes: 10 },
      earlyDepartureAlert: { enabled: true, notifyEmployee: true, notifyManager: true, minMinutes: 20 },
      missingCheckInReminder: true, missingCheckInReminderMinutes: 30,
      appreciation: { enabled: false, weekday: 0, hour: 9, minWorkedDays: 5 },
    });
    expect((await putGroup('notifications', (c) => ({ ...c, missingCheckInReminderMinutes: 5 }))).status).toBe(400);
  });

  it('only notification.manage may send, and only once the appreciation is switched on; then the worker job is queued (202)', async () => {
    const path = `${base()}/notifications/appreciation/send`;
    expect((await h.request('POST', path, { token: f.employeeUser })).status).toBe(403);
    const off = await h.request('POST', path, { token: f.owner });
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('INVALID_STATE');
    expect(await queueJobs(h.admin, ATTENDANCE_APPRECIATION_JOB_TYPE)).toEqual([]);
    expect((await putGroup('notifications', (c) => ({ ...c, appreciation: { ...c.appreciation, enabled: true } }))).status).toBe(200);
    const res = await h.request('POST', path, { token: f.owner });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ jobId: expect.any(String), status: 'QUEUED' });
    const jobs = await queueJobs(h.admin, ATTENDANCE_APPRECIATION_JOB_TYPE);
    expect(jobs).toEqual([expect.objectContaining({ id: res.body.data.jobId, queueName: 'notifications', organizationId: f.orgId, payload: { organizationId: f.orgId, force: true, requestedBy: f.owner }, dedupeKey: `appreciation-now:${f.orgId}` })]);
    expect((await auditRows(h.admin, 'notification.appreciation_requested'))[0]).toMatchObject({ organizationId: f.orgId, actorUserId: f.owner });
  });
});
