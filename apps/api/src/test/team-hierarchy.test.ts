/**
 * Manager team scope (migration 20261015000300): with the organisation's `attendance.team.scope = 'hierarchy'` a manager's team is
 * the whole reporting line below them (depth ≤ 5) — the API (principal snapshot) and RLS (`app.team_employee_ids()`) agree;
 * with the default `direct` it stays the direct reports. Indirect reports are labelled with their own manager.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
// head (e20) → manager (e21) → report (e22) → report's report (e23); e24 left the company (never counted)
let e20: string; let e21: string; let e22: string; let e23: string; let e24: string;
const head = uuid('c');
const D = '2026-09-01';
const base = () => `/api/v1/orgs/${f.orgId}`;

async function setScope(scope: 'direct' | 'hierarchy') {
  await h.admin.updateTable('organizationSettings').set({ attendance: sql`coalesce(attendance, '{}'::jsonb) || jsonb_build_object('team', jsonb_build_object('scope', ${scope}::text))` }).where('organizationId', '=', f.orgId).execute();
}
const memberIds = async () => {
  const r = await h.request('GET', `${base()}/team/summary?date=${D}`, { token: head });
  expect(r.status).toBe(200);
  return r.body.data.members as Array<{ employeeId: string; relation: string; managerName?: string | null }>;
};

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_team_hierarchy_${process.pid}`);
  f = await seedOrg(h.admin, 'hierarchy', { modules: [] });
  e20 = await seedEmployee(h.admin, f.orgId, f.branchA, 20);
  e21 = await seedEmployee(h.admin, f.orgId, f.branchA, 21, { managerEmployeeId: e20 });
  e22 = await seedEmployee(h.admin, f.orgId, f.branchA, 22, { managerEmployeeId: e21 });
  e23 = await seedEmployee(h.admin, f.orgId, f.branchB, 23, { managerEmployeeId: e22 });
  e24 = await seedEmployee(h.admin, f.orgId, f.branchA, 24, { managerEmployeeId: e21, employmentStatus: 'terminated' });
  await seedUser(h.admin, head, 'head-hierarchy@test.local', 'Head');
  await seedMembership(h.admin, f.orgId, head, ROLE.manager, { employeeId: e20 });
});
afterAll(async () => { await h?.close(); });

describe('manager team scope', () => {
  it('direct (default): the team is the direct reports only', async () => {
    const members = await memberIds();
    expect(members.map((m) => m.employeeId)).toEqual([e21]);
    expect(members[0]).toMatchObject({ relation: 'primary' });
    const me = await h.request('GET', '/api/v1/me', { token: head });
    expect(me.body.data.memberships[0]).toMatchObject({ isManager: true, teamSize: 1 });
  });

  it('hierarchy: the whole reporting line, indirect reports labelled with their own manager; leavers never count', async () => {
    await setScope('hierarchy');
    const members = await memberIds();
    expect(members.map((m) => m.employeeId).sort()).toEqual([e21, e22, e23].sort());
    const by = new Map(members.map((m) => [m.employeeId, m]));
    expect(by.get(e21)).toMatchObject({ relation: 'primary', managerName: null });
    expect(by.get(e22)).toMatchObject({ relation: 'indirect', managerName: expect.stringContaining('21') });
    expect(by.get(e23)).toMatchObject({ relation: 'indirect' });
    expect(members.some((m) => m.employeeId === e24)).toBe(false);
  });

  it('hierarchy: GET /employees?teamOf=<self> lists the reporting line with each row\'s own manager; another employee keeps the direct-report rule', async () => {
    await setScope('hierarchy');
    const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
    const mine = await h.request('GET', `${base()}/employees?teamOf=${e20}&pageSize=100`, { token: head });
    expect(mine.status).toBe(200);
    expect(ids(mine.body.data)).toEqual([e21, e22, e23].sort()); // the leaver e24 never counts, as in teamSize
    const by = new Map((mine.body.data as Array<{ id: string; managerEmployeeId: string | null; managerName: string | null }>).map((r) => [r.id, r]));
    expect(by.get(e21)).toMatchObject({ managerEmployeeId: e20 });
    expect(by.get(e22)).toMatchObject({ managerEmployeeId: e21, managerName: expect.stringContaining('21') });
    expect(by.get(e23)).toMatchObject({ managerEmployeeId: e22, managerName: expect.stringContaining('22') });
    // teamOf a report: that employee's direct reports only (e23 is two levels below e21), within what the caller may read
    expect(ids((await h.request('GET', `${base()}/employees?teamOf=${e21}&pageSize=100`, { token: head })).body.data)).toEqual([e22]);
    await setScope('direct');
    expect(ids((await h.request('GET', `${base()}/employees?teamOf=${e20}&pageSize=100`, { token: head })).body.data)).toEqual([e21]);
    await setScope('hierarchy');
  });

  it('RLS agrees with the API: the team predicate reaches the indirect report\'s rows', async () => {
    await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId: e23, attendanceDate: sql<Date>`${D}::date`, branchId: f.branchB, timezone: 'Asia/Muscat', engineVersion: 'test', status: 'PRESENT', flags: [], workedMinutes: 480, trace: JSON.stringify({ punches: [] }) } as never).execute();
    const r = await h.request('GET', `${base()}/team/attendance?from=${D}&to=${D}`, { token: head });
    expect(r.status).toBe(200);
    expect(r.body.data.some((row: { employeeId: string; records: unknown[] }) => row.employeeId === e23 && row.records.length === 1)).toBe(true);
    await setScope('direct');
    const after = await h.request('GET', `${base()}/team/attendance?from=${D}&to=${D}`, { token: head });
    expect(after.body.data.some((row: { employeeId: string }) => row.employeeId === e23)).toBe(false);
  });
});
