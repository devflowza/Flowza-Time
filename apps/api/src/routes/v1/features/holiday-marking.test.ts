import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditRows, createApiHarness, queueJobs, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

/**
 * Marking a holiday in one step (2026-09-29): a holiday posted without a calendar goes into the organisation's DEFAULT calendar —
 * created on the spot when there is none — and the organisation's first calendar is always its default. Before, a calendar created
 * with the default switch off (its initial state) applied to no branch, so every holiday marked in it changed no attendance day.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture; let g: OrgFixture;
const base = (o: OrgFixture) => `/api/v1/orgs/${o.orgId}`;
beforeAll(async () => { h = await createApiHarness(`flowza_api_holmark_${process.pid}`); f = await seedOrg(h.admin, 'hm1'); g = await seedOrg(h.admin, 'hm2'); });
afterAll(async () => { await h?.close(); });

describe('marking a holiday', () => {
  it('without a calendar: the default calendar is created (once) and the holiday applies; a past day is recalculated', async () => {
    const recalcBefore = (await queueJobs(h.admin, 'RECALCULATE_RANGE')).length;
    const first = await h.request('POST', `${base(f)}/holidays`, { token: f.hrAdmin, body: { name: 'Rain day', date: '2026-08-20' } });
    expect(first.status).toBe(201);
    const cals = await h.request('GET', `${base(f)}/holiday-calendars`, { token: f.hrAdmin });
    expect(cals.body.data).toEqual([expect.objectContaining({ id: first.body.data.calendarId, name: 'Public holidays', isDefault: true, holidayCount: 1, branchCount: 0 })]);
    expect((await auditRows(h.admin, 'holiday_calendar.created')).some((a) => a.entityId === first.body.data.calendarId)).toBe(true);
    expect((await queueJobs(h.admin, 'RECALCULATE_RANGE')).length).toBeGreaterThan(recalcBefore);
    const second = await h.request('POST', `${base(f)}/holidays`, { token: f.hrAdmin, body: { name: 'National Day', date: '2030-11-18' } });
    expect(second.body.data.calendarId).toBe(first.body.data.calendarId);
    expect((await h.request('GET', `${base(f)}/holiday-calendars`, { token: f.hrAdmin })).body.data).toHaveLength(1);
  });

  it('a calendar the organisation adds later is not silently made the default; its branch use is reported', async () => {
    const extra = await h.request('POST', `${base(f)}/holiday-calendars`, { token: f.hrAdmin, body: { name: 'Sohar' } });
    expect(extra.body.data.isDefault).toBe(false);
    await h.admin.updateTable('branches').set({ holidayCalendarId: extra.body.data.id }).where('id', '=', f.branchB).execute();
    const cals = (await h.request('GET', `${base(f)}/holiday-calendars`, { token: f.hrAdmin })).body.data as Array<{ id: string; branchCount: number; isDefault: boolean }>;
    expect(cals.find((c) => c.id === extra.body.data.id)).toMatchObject({ isDefault: false, branchCount: 1 });
  });

  it('the organisation\'s first calendar is its default even when created with the switch off', async () => {
    const cal = await h.request('POST', `${base(g)}/holiday-calendars`, { token: g.hrAdmin, body: { name: 'Oman', countryCode: 'OM', isDefault: false } });
    expect(cal.status).toBe(201);
    expect(cal.body.data.isDefault).toBe(true);
  });

  it('still needs holiday.manage, and a branch-scoped holder may not declare an organisation-wide day off', async () => {
    expect((await h.request('POST', `${base(f)}/holidays`, { token: f.hrUser, body: { name: 'x', date: '2030-01-02' } })).status).toBe(403);
    expect((await h.request('POST', `${base(f)}/holidays`, { token: f.employeeUser, body: { name: 'x', date: '2030-01-02' } })).status).toBe(403);
  });
});
