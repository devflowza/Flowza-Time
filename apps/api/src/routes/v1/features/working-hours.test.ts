import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadDailyInputs, withContext } from '@flowza/database';
import { calculateDailyRecord } from '@flowza/domain';
import { auditRows, createApiHarness, isoTodayIn, seedDevice, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

/**
 * Working-hours policies (customer requirements "Flexible working hours", "Grace margin", "Approved working hours",
 * "Official holidays"; engine 1.5.0): the shift's flexible start band, the rule set's grace mode and approved working-hours
 * periods end to end (API → database → the engine's loaded inputs), PATCH bodies that keep what they do not name, recurring
 * holidays and "Copy to year", and the recalculation of past days when WHICH calendar applies changes.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture; let device: string;
const base = () => `/api/v1/orgs/${f.orgId}`;
const DAY = '2026-08-04'; // a Tuesday
const requests = (branchId: string | null, reason: string) => h.admin.selectFrom('attendanceRecalculationRequests').selectAll()
  .where('organizationId', '=', f.orgId).where('reason', 'like', `%${reason}%`).where((eb) => (branchId === null ? eb('branchId', 'is', null) : eb('branchId', '=', branchId))).orderBy('fromDate').execute();
const iso = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_workhours_${process.pid}`);
  f = await seedOrg(h.admin, 'wh');
  device = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'WH-1' });
});
afterAll(async () => { await h?.close(); });

describe('flexible start band on a fixed shift', () => {
  let shiftId: string;
  it('is saved, kept by a one-field PATCH, cleared on a flexible shift and bounded to 240 minutes', async () => {
    const r = await h.request('POST', `${base()}/shifts`, { token: f.hrAdmin, body: { code: 'EARLY', name: 'Early 07–14', type: 'FIXED', startTime: '07:00', endTime: '14:00', flexStartMinutes: 120 } });
    expect(r.status).toBe(201);
    shiftId = r.body.data.id;
    expect(r.body.data.flexStartMinutes).toBe(120);
    const renamed = await h.request('PATCH', `${base()}/shifts/${shiftId}`, { token: f.hrAdmin, body: { name: 'Early shift' } });
    expect(renamed.body.data).toMatchObject({ name: 'Early shift', flexStartMinutes: 120, startTime: '07:00' });
    expect((await h.request('POST', `${base()}/shifts`, { token: f.hrAdmin, body: { code: 'BAD', name: 'Bad', type: 'FIXED', startTime: '07:00', endTime: '14:00', flexStartMinutes: 300 } })).status).toBe(400);
    const flex = await h.request('POST', `${base()}/shifts`, { token: f.hrAdmin, body: { code: 'FLX', name: 'Flex', type: 'FLEXIBLE', requiredMinutes: 480, flexStartMinutes: 60 } });
    expect(flex.status).toBe(201);
    expect(flex.body.data.flexStartMinutes).toBe(0);
    const toFlex = await h.request('PATCH', `${base()}/shifts/${flex.body.data.id}`, { token: f.hrAdmin, body: { flexStartMinutes: 30 } });
    expect(toFlex.body.data.flexStartMinutes).toBe(0);
  });

  it('a rule set with tolerance grace and an approved period, loaded from the database, drives the engine', async () => {
    const policy = await h.request('POST', `${base()}/attendance-rule-sets`, {
      token: f.hrAdmin,
      body: { name: 'Branch A 2026', branchId: f.branchA, effectiveFrom: '2026-01-01', graceInMinutes: 10, graceMode: 'tolerance', specialPeriods: [{ name: 'Summer hours', reference: 'Circular 7/2026', from: '2026-08-10', to: '2026-08-20', startTime: '08:00', endTime: '13:00' }] },
    });
    expect(policy.status).toBe(201);
    expect(policy.body.data).toMatchObject({ graceMode: 'tolerance', specialPeriods: [{ name: 'Summer hours', reference: 'Circular 7/2026', from: '2026-08-10', to: '2026-08-20', startTime: '08:00', endTime: '13:00', appliesTo: 'all' }] });
    // Zod 4 pitfall: a one-field PATCH keeps the grace mode and the periods
    const patched = await h.request('PATCH', `${base()}/attendance-rule-sets/${policy.body.data.id}`, { token: f.hrAdmin, body: { graceInMinutes: 15 } });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ graceInMinutes: 15, graceMode: 'tolerance', specialPeriods: [expect.objectContaining({ name: 'Summer hours' })] });
    const overlap = await h.request('PATCH', `${base()}/attendance-rule-sets/${policy.body.data.id}`, { token: f.hrAdmin, body: { specialPeriods: [{ name: 'A', from: '2026-07-01', to: '2026-07-31', scheduledMinutes: 300 }, { name: 'B', from: '2026-07-31', to: '2026-08-05', scheduledMinutes: 300 }] } });
    expect(overlap.status).toBe(400);

    expect((await h.request('POST', `${base()}/shift-assignments`, { token: f.hrAdmin, body: { targetType: 'EMPLOYEE', targetId: f.e1, shiftId, effectiveFrom: '2026-08-01' } })).status).toBe(201);
    const punch = (at: string) => ({ organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, punchedAt: new Date(at), eventType: 'PUNCH' as const, source: 'DEVICE' as const, deviceId: device });
    // 08:30 → 15:30 Muscat on a normal day; 08:15 → 13:00 inside the summer period
    await h.admin.insertInto('attendanceEvents').values([punch(`${DAY}T04:30:00Z`), punch(`${DAY}T11:30:00Z`), punch('2026-08-11T04:15:00Z'), punch('2026-08-11T09:00:00Z')]).execute();
    const run = (date: string) => withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, async (trx) => {
      const loaded = await loadDailyInputs(trx, f.orgId, f.e1, date, new Date('2026-09-01T00:00:00Z'));
      return { loaded: loaded!, result: calculateDailyRecord(loaded!.input) };
    });
    const normal = await run(DAY);
    expect(normal.loaded.input.shift?.flexStartMinutes).toBe(120);
    expect(normal.loaded.input.rules).toMatchObject({ graceMode: 'tolerance', graceInMinutes: 15 });
    expect(normal.result).toMatchObject({ status: 'PRESENT', expectedStartAt: `${DAY}T04:30:00Z`, expectedEndAt: `${DAY}T11:30:00Z`, lateMinutes: 0, earlyDepartureMinutes: 0, workedMinutes: 420 });
    const summer = await run('2026-08-11');
    expect(summer.result).toMatchObject({ expectedStartAt: '2026-08-11T04:15:00Z', expectedEndAt: '2026-08-11T09:15:00Z', scheduledMinutes: 300, lateMinutes: 0 });
    expect(summer.result.flags).toContain('SPECIAL_HOURS');
    expect(summer.result.earlyDepartureMinutes).toBe(15); // the band moved the end to 13:15; tolerance grace-out 0 → every minute counts
  });
});

describe('holidays: recurring, copy to year, recalculation of past days', () => {
  let calendarId: string;
  it('a recurring holiday is saved as such; copy-to-year copies recurring ones, skips duplicates and stamps the rollover ledger', async () => {
    const nd = await h.request('POST', `${base()}/holidays`, { token: f.hrAdmin, body: { name: 'National Day', date: '2026-11-18', endDate: '2026-11-19', recursYearly: true } });
    expect(nd.status).toBe(201);
    calendarId = nd.body.data.calendarId;
    expect(nd.body.data).toMatchObject({ recursYearly: true, recalculationJobId: null }); // in the future → nothing to recompute
    const eid = await h.request('POST', `${base()}/holidays`, { token: f.hrAdmin, body: { calendarId, name: 'Eid al-Adha', date: '2026-05-27', type: 'RELIGIOUS' } });
    expect(eid.body.data.recursYearly).toBe(false);
    expect(eid.body.data.recalculationJobId).toBeTypeOf('string'); // in the past → recomputed

    const copy = await h.request('POST', `${base()}/holiday-calendars/${calendarId}/copy-year`, { token: f.hrAdmin, body: { fromYear: 2026 } });
    expect(copy.status).toBe(200);
    expect(copy.body.data).toMatchObject({ fromYear: 2026, toYear: 2027, created: [expect.objectContaining({ name: 'National Day', date: '2027-11-18', endDate: '2027-11-19', recursYearly: true, isTentative: false })], skipped: [{ name: 'Eid al-Adha', reason: 'NOT_RECURRING' }] });
    expect((await h.admin.selectFrom('holidays').select('rolledOverAt').where('id', '=', nd.body.data.id).executeTakeFirstOrThrow()).rolledOverAt).not.toBeNull();
    expect((await auditRows(h.admin, 'holiday_calendar.year_copied')).some((a) => a.entityId === calendarId)).toBe(true);

    const again = await h.request('POST', `${base()}/holiday-calendars/${calendarId}/copy-year`, { token: f.hrAdmin, body: { fromYear: 2026, includeNonRecurring: true } });
    expect(again.body.data.created).toEqual([expect.objectContaining({ name: 'Eid al-Adha', date: '2027-05-27', isTentative: true, recursYearly: false })]);
    expect(again.body.data.skipped).toEqual([expect.objectContaining({ name: 'National Day', reason: 'ALREADY_THERE' })]);
    // a branch-scoped holder cannot copy a whole calendar year; nobody without holiday.manage can
    expect((await h.request('POST', `${base()}/holiday-calendars/${calendarId}/copy-year`, { token: f.branchManagerB, body: { fromYear: 2026 } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/holiday-calendars/${calendarId}/copy-year`, { token: f.employeeUser, body: { fromYear: 2026 } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/holiday-calendars/${calendarId}/copy-year`, { token: f.hrAdmin, body: { fromYear: 2026, toYear: 2026 } })).status).toBe(400);
  });

  it('editing or deleting a past holiday answers with the recalculation it queued', async () => {
    const past = await h.request('POST', `${base()}/holidays`, { token: f.hrAdmin, body: { calendarId, name: 'Rain day', date: '2026-02-10' } });
    const edited = await h.request('PATCH', `${base()}/holidays/${past.body.data.id}`, { token: f.hrAdmin, body: { date: '2026-02-11' } });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ date: '2026-02-11', recalculationJobId: expect.any(String) });
    const removed = await h.request('DELETE', `${base()}/holidays/${past.body.data.id}`, { token: f.hrAdmin });
    expect(removed.status).toBe(200);
    expect(removed.body.data.recalculationJobId).toBeTypeOf('string');
    const future = await h.request('POST', `${base()}/holidays`, { token: f.hrAdmin, body: { calendarId, name: 'Later', date: '2099-01-02' } });
    expect((await h.request('DELETE', `${base()}/holidays/${future.body.data.id}`, { token: f.hrAdmin })).body.data.recalculationJobId).toBeNull();
  });

  it('a branch that picks another calendar recomputes the past holidays of both calendars for that branch only', async () => {
    const sohar = await h.request('POST', `${base()}/holiday-calendars`, { token: f.hrAdmin, body: { name: 'Sohar', countryCode: 'OM' } });
    expect(sohar.body.data).toMatchObject({ isDefault: false, autoRollover: true, recalculationJobId: null });
    await h.request('POST', `${base()}/holidays`, { token: f.hrAdmin, body: { calendarId: sohar.body.data.id, name: 'Sohar festival', date: '2026-03-03' } });
    const moved = await h.request('PATCH', `${base()}/branches/${f.branchB}`, { token: f.owner, body: { holidayCalendarId: sohar.body.data.id } });
    expect(moved.status).toBe(200);
    const reqs = await requests(f.branchB, 'holiday calendar changed');
    // the default calendar's past Eid (27 May) and Sohar's festival (3 Mar), each its own range, branch B only; nothing in the future
    expect(reqs.map((r) => [iso(r.fromDate), iso(r.toDate)])).toEqual([['2026-03-03', '2026-03-03'], ['2026-05-27', '2026-05-27']]);
    expect(await requests(f.branchA, 'holiday calendar changed')).toEqual([]);
    // the same calendar again changes nothing
    const before = (await requests(f.branchB, 'holiday calendar changed')).length;
    await h.request('PATCH', `${base()}/branches/${f.branchB}`, { token: f.owner, body: { holidayCalendarId: sohar.body.data.id, name: 'Branch B (Sohar)' } });
    expect((await requests(f.branchB, 'holiday calendar changed')).length).toBe(before);
  });

  it('switching or deleting the default calendar recomputes the branches that follow it', async () => {
    const other = await h.request('POST', `${base()}/holiday-calendars`, { token: f.hrAdmin, body: { name: 'Muscat' } });
    await h.request('POST', `${base()}/holidays`, { token: f.hrAdmin, body: { calendarId: other.body.data.id, name: 'Muscat day', date: '2026-04-14' } });
    const made = await h.request('PATCH', `${base()}/holiday-calendars/${other.body.data.id}`, { token: f.hrAdmin, body: { isDefault: true } });
    expect(made.status).toBe(200);
    expect(made.body.data).toMatchObject({ isDefault: true, recalculationJobId: expect.any(String) });
    // branch B has its own calendar: only branch A follows the default
    const reqs = await requests(f.branchA, 'default holiday calendar changed');
    expect(reqs.map((r) => iso(r.fromDate))).toEqual(['2026-04-14', '2026-05-27']);
    expect(await requests(f.branchB, 'default holiday calendar changed')).toEqual([]);
    // the auto-rollover switch is a plain PATCH that keeps everything else
    const off = await h.request('PATCH', `${base()}/holiday-calendars/${other.body.data.id}`, { token: f.hrAdmin, body: { autoRollover: false } });
    expect(off.body.data).toMatchObject({ autoRollover: false, isDefault: true, name: 'Muscat', recalculationJobId: null });
    const deleted = await h.request('DELETE', `${base()}/holiday-calendars/${other.body.data.id}`, { token: f.hrAdmin });
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.recalculationJobId).toBeTypeOf('string');
    expect((await requests(f.branchA, 'default holiday calendar Muscat deleted')).map((r) => iso(r.fromDate))).toEqual(['2026-04-14']);
    // an unused, non-default calendar applies to nobody: deleting it recomputes nothing
    const unused = await h.request('POST', `${base()}/holiday-calendars`, { token: f.hrAdmin, body: { name: 'Unused' } });
    expect((await h.request('DELETE', `${base()}/holiday-calendars/${unused.body.data.id}`, { token: f.hrAdmin })).body.data.recalculationJobId).toBeNull();
  });

  it('the recalculation never reaches past today', async () => {
    const today = isoTodayIn('Asia/Muscat');
    const all = await h.admin.selectFrom('attendanceRecalculationRequests').select('toDate').where('organizationId', '=', f.orgId).execute();
    for (const r of all) expect(iso(r.toDate) <= today).toBe(true);
  });
});
