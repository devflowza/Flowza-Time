import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { HOLIDAY_ROLLOVER_JOB_TYPE } from '@flowza/database';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { HOLIDAY_ROLLOVER_LOCAL_HOUR, holidayRolloverDue, holidayRolloverHandler, holidayTasks, runHolidayRollover } from './index.js';

/*
 * The yearly holiday rollover: from 1 December (organisation time), next year's occurrence of every recurring holiday of an
 * auto-rollover calendar — once per holiday (`rolled_over_at`), never a date next year already has, never for a calendar with
 * the switch off, and never a moon-sighted (non-recurring) holiday.
 */
const ORG = '0e000000-0000-4000-a000-000000000001';
const OFF_ORG = '0e000000-0000-4000-a000-000000000002';
const CAL = '0e000000-0000-4000-a000-0000000000c1';
const CAL_OFF = '0e000000-0000-4000-a000-0000000000c2';
const B1 = '0e000000-0000-4000-a000-0000000000b1';
// 04:30 in Muscat on 2026-12-01 — the rollover hour
let now = new Date('2026-12-01T00:30:00Z');
let h: TestHarness;
const holidaysOf = (calendarId: string, year: number) => h.tdb.adminDb.selectFrom('holidays').selectAll().where('calendarId', '=', calendarId)
  .where('date', '>=', new Date(`${year}-01-01T00:00:00`)).where('date', '<=', new Date(`${year}-12-31T00:00:00`)).orderBy('date').execute();
const day = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : DateTime.fromJSDate(d).toISODate());

beforeAll(async () => {
  h = await createHarness(`flowza_worker_holroll_${process.pid}`, defaultRegistry(), () => now);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values([
    { id: ORG, companyCode: 'HOL', legalName: 'Hol', displayName: 'Hol', timezone: 'Asia/Muscat', status: 'active' },
    { id: OFF_ORG, companyCode: 'HOL2', legalName: 'Hol2', displayName: 'Hol2', timezone: 'America/New_York', status: 'active' },
  ]).execute();
  await a.insertInto('branches').values({ id: B1, organizationId: ORG, code: 'B1', name: 'B1', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('holidayCalendars').values([
    { id: CAL, organizationId: ORG, name: 'Oman', isDefault: true },
    { id: CAL_OFF, organizationId: ORG, name: 'Manual', autoRollover: false },
  ]).execute();
  const hol = (calendarId: string, name: string, date: string, over: Record<string, unknown> = {}) => ({ organizationId: ORG, calendarId, name, date, recursYearly: true, ...over });
  await a.insertInto('holidays').values([
    hol(CAL, 'New Year', '2026-01-01'),
    hol(CAL, 'National Day', '2026-11-18', { endDate: '2026-11-19' }),
    hol(CAL, 'Eid al-Fitr', '2026-03-20', { recursYearly: false, type: 'RELIGIOUS' }),
    hol(CAL, 'Branch day', '2026-06-01', { branchIds: [B1] }),
    hol(CAL, 'Renaissance Day', '2026-07-23'),
    // next year already has its Renaissance Day (entered by hand)
    hol(CAL, 'Renaissance Day (2027)', '2027-07-23'),
    hol(CAL_OFF, 'Manual holiday', '2026-05-01'),
  ]).execute();
});
afterAll(async () => { await h?.close(); });

describe('holiday rollover', () => {
  it('is due every December day at the local hour, for the next year', () => {
    expect(holidayRolloverDue(DateTime.fromISO('2026-12-01T04:10', { zone: 'Asia/Muscat' }))).toEqual({ due: true, toYear: 2027 });
    expect(holidayRolloverDue(DateTime.fromISO('2026-12-31T04:59', { zone: 'Asia/Muscat' })).due).toBe(true);
    expect(holidayRolloverDue(DateTime.fromISO('2026-11-30T04:10', { zone: 'Asia/Muscat' })).due).toBe(false);
    expect(holidayRolloverDue(DateTime.fromISO('2026-12-01T05:00', { zone: 'Asia/Muscat' })).due).toBe(false);
    expect(HOLIDAY_ROLLOVER_LOCAL_HOUR).toBe(4);
  });

  it('the hourly tick enqueues one job per organisation whose local clock is due (deduplicated while pending)', async () => {
    const first = await holidayTasks[0]!.run(h.deps);
    await holidayTasks[0]!.run(h.deps);
    expect(first).toMatchObject({ enqueued: 1 }); // New York is still on 30 November at 19:30
    const jobs = await h.tdb.adminDb.selectFrom('jobs.queue').select(['organizationId', 'dedupeKey', 'payload']).where('jobType', '=', HOLIDAY_ROLLOVER_JOB_TYPE).execute();
    expect(jobs).toEqual([{ organizationId: ORG, dedupeKey: `holiday-rollover:${ORG}:2026-12-01`, payload: { organizationId: ORG, toYear: 2027, asOf: '2026-12-01' } }]);
  });

  it('creates next year\'s recurring holidays once, skips dates already there, leaves non-recurring and switched-off calendars alone', async () => {
    const res = await holidayRolloverHandler({ job: fakeJob(HOLIDAY_ROLLOVER_JOB_TYPE, { organizationId: ORG, toYear: 2027 }, ORG), deps: h.deps, log: h.deps.log, signal: new AbortController().signal } as never);
    expect(res).toEqual({ organizationId: ORG, toYear: 2027, calendars: 1, created: 3, alreadyThere: 1 });
    const next = await holidaysOf(CAL, 2027);
    expect(next.map((x) => [x.name, day(x.date), x.endDate ? day(x.endDate) : null, x.recursYearly, x.branchIds])).toEqual([
      ['New Year', '2027-01-01', null, true, null],
      ['Branch day', '2027-06-01', null, true, [B1]],
      ['Renaissance Day (2027)', '2027-07-23', null, true, null],
      ['National Day', '2027-11-18', '2027-11-19', true, null],
    ]);
    expect(await holidaysOf(CAL_OFF, 2027)).toEqual([]);
    const audit = await h.tdb.adminDb.selectFrom('audit.logs').selectAll().where('action', '=', 'holiday_calendar.rolled_over').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ organizationId: ORG, entityId: CAL, actorType: 'SYSTEM', jobId: '1' });

    // HR deletes next year's New Year: the next day's run does not bring it back, and creates nothing twice
    await h.tdb.adminDb.deleteFrom('holidays').where('calendarId', '=', CAL).where('name', '=', 'New Year').where('date', '=', new Date('2027-01-01T00:00:00')).execute();
    now = new Date('2026-12-02T00:30:00Z');
    expect(await runHolidayRollover(h.deps, ORG, 2027)).toMatchObject({ created: 0 });
    expect((await holidaysOf(CAL, 2027)).map((x) => x.name)).toEqual(['Branch day', 'Renaissance Day (2027)', 'National Day']);

    // a recurring holiday added later in December is rolled over by the next run
    await h.tdb.adminDb.insertInto('holidays').values({ organizationId: ORG, calendarId: CAL, name: 'Company day', date: '2026-12-20', recursYearly: true }).execute();
    expect(await runHolidayRollover(h.deps, ORG, 2027)).toMatchObject({ created: 1 });
    expect((await holidaysOf(CAL, 2027)).map((x) => x.name)).toContain('Company day');
  });
});
