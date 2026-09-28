import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, seedOrg, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

/**
 * The monthly shift roster (HR portal Prompt 6b, Finance ATT-105): the engine's resolution per employee and day (assignment,
 * rotation pattern with its off days), weekly offs, the branch's holidays; branch scope; shift.view.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture; let dayShift: string;
beforeAll(async () => {
  h = await createApiHarness(`flowza_api_roster_${process.pid}`);
  f = await seedOrg(h.admin, 'roster');
  const base = `/api/v1/orgs/${f.orgId}`;
  await h.admin.updateTable('organizations').set({ weeklyOffDays: [5] }).where('id', '=', f.orgId).execute();
  dayShift = (await h.request('POST', `${base}/shifts`, { token: f.hrAdmin, body: { code: 'DAY', name: 'Day shift', type: 'FIXED', startTime: '08:00', endTime: '17:00', color: '#0ea5e9' } })).body.data.id;
  expect((await h.request('POST', `${base}/shift-assignments`, { token: f.hrAdmin, body: { targetType: 'EMPLOYEE', targetId: f.e1, shiftId: dayShift, effectiveFrom: '2026-02-01' } })).status).toBe(201);
  const pattern = await h.request('POST', `${base}/shift-patterns`, { token: f.hrAdmin, body: { code: 'ROT', name: '2 on 1 off', cycleLengthDays: 3, anchorDate: '2026-01-05', sequence: [{ day: 0, shiftId: dayShift }, { day: 1, shiftId: dayShift }, { day: 2, off: true }] } });
  expect((await h.request('POST', `${base}/shift-assignments`, { token: f.hrAdmin, body: { targetType: 'EMPLOYEE', targetId: f.e3, shiftPatternId: pattern.body.data.id, effectiveFrom: '2026-01-05' } })).status).toBe(201);
  const cal = await h.admin.insertInto('holidayCalendars').values({ organizationId: f.orgId, name: 'Oman', isDefault: true }).returning('id').executeTakeFirstOrThrow();
  await h.admin.insertInto('holidays').values([
    { organizationId: f.orgId, calendarId: cal.id, name: 'Founders Day', date: '2026-02-15' as never },
    { organizationId: f.orgId, calendarId: cal.id, name: 'Branch B only', date: '2026-02-16' as never, branchIds: [f.branchB] },
  ]).execute();
});
afterAll(async () => { await h?.close(); });
const roster = (token: string, qs: string) => h.request('GET', `/api/v1/orgs/${f.orgId}/shift-roster?${qs}`, { token });

describe('GET /shift-roster', () => {
  it('resolves every day of the month the way the engine does', async () => {
    const r = await roster(f.hrAdmin, 'month=2026-02');
    expect(r.status).toBe(200);
    expect(r.body.meta).toMatchObject({ total: 3, page: 1 });
    expect(r.body.data.dates).toHaveLength(28);
    expect(r.body.data.shifts.map((s: { code: string }) => s.code)).toEqual(['DAY']);
    const row = (id: string) => r.body.data.rows.find((x: { employeeId: string }) => x.employeeId === id);
    // assignment: every day, Fridays off (organisation weekly off), the default calendar's holiday
    expect(row(f.e1).days['2026-02-10']).toEqual({ shiftId: dayShift, source: 'ASSIGNMENT', isOff: false, holidayName: null, onLeave: false });
    expect(row(f.e1).days['2026-02-13'].isOff).toBe(true);
    expect(row(f.e1).days['2026-02-15'].holidayName).toBe('Founders Day');
    // a branch-scoped holiday applies to its branch only
    expect(row(f.e1).days['2026-02-16'].holidayName).toBeNull();
    expect(row(f.e2).days['2026-02-16'].holidayName).toBe('Branch B only');
    // rotation: 2026-02-03 is day 2 of the 3-day cycle anchored on 2026-01-05 → pattern off
    expect(row(f.e3).days['2026-02-01']).toMatchObject({ shiftId: dayShift, source: 'PATTERN', isOff: false });
    expect(row(f.e3).days['2026-02-03']).toMatchObject({ shiftId: null, source: 'PATTERN', isOff: true });
    // nothing assigned: no shift, no organisation default
    expect(row(f.e2).days['2026-02-10']).toMatchObject({ shiftId: null, source: 'NONE' });
  });

  it('keeps a branch-scoped member to their branches and paginates by employee', async () => {
    const b = await roster(f.branchManagerB, 'month=2026-02');
    expect(b.status).toBe(200);
    expect(b.body.data.rows.map((x: { employeeId: string }) => x.employeeId)).toEqual([f.e2]);
    expect((await roster(f.branchManagerB, `month=2026-02&branchId=${f.branchA}`)).status).toBe(403);
    const p = await roster(f.hrAdmin, 'month=2026-02&pageSize=2&page=2');
    expect(p.body.meta).toMatchObject({ total: 3, totalPages: 2 });
    expect(p.body.data.rows).toHaveLength(1);
    const s = await roster(f.hrAdmin, `month=2026-02&search=${encodeURIComponent('Employee 3')}`);
    expect(s.body.data.rows.map((x: { employeeId: string }) => x.employeeId)).toEqual([f.e3]);
  });

  it('needs shift.view and a valid month', async () => {
    expect((await roster(f.employeeUser, 'month=2026-02')).status).toBe(403);
    expect((await roster(f.outsider, 'month=2026-02')).status).toBe(403);
    expect((await roster(f.hrAdmin, 'month=2026-13')).status).toBe(400);
  });
});
