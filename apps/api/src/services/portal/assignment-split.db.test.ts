import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withContext } from '@flowza/database';
import { isoDate, isoDateOrNull } from '../../lib/mappers.js';
import { createApiHarness, seedOrg, type ApiHarness, type OrgFixture } from '../../test/features-harness.js';
import { placeAdditionalShiftRange, placeEmployeeShiftRange } from './assignment-split.js';

/*
 * The range placement of shift change requests against the real schema (no-overlap exclusion constraints, RLS of the
 * organisation's system context — the approval hook's step): rows of the employee are trimmed / split around the range,
 * other employees' and other targets' rows are untouched.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
let MORN: string; let DAY: string; let EVE: string; let PATTERN: string;

const inSystem = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext(h.deps.db, { kind: 'system', organizationId: f.orgId }, fn);
const span = (r: { effectiveFrom: Date | string; effectiveTo: Date | string | null }) => `${isoDate(r.effectiveFrom)}→${isoDateOrNull(r.effectiveTo) ?? '∞'}`;
async function employeeRows(employeeId: string) {
  const rows = await h.admin.selectFrom('shiftAssignments').selectAll().where('organizationId', '=', f.orgId).where('targetType', '=', 'EMPLOYEE').where('targetId', '=', employeeId).orderBy('effectiveFrom').execute();
  const name = (r: { shiftId: string | null; shiftPatternId: string | null }) => (r.shiftPatternId ? 'PATTERN' : r.shiftId === MORN ? 'MORN' : r.shiftId === DAY ? 'DAY' : r.shiftId === EVE ? 'EVE' : '?');
  return rows.map((r) => `${span(r)}:${name(r)}`);
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_assignment_split_${process.pid}`);
  f = await seedOrg(h.admin, 'split');
  const shifts = await h.admin.insertInto('shifts').values([
    { organizationId: f.orgId, code: 'MORN', name: 'Morning', type: 'FIXED', startTime: '06:00', endTime: '14:00' },
    { organizationId: f.orgId, code: 'DAY', name: 'Day', type: 'FIXED', startTime: '08:00', endTime: '16:00' },
    { organizationId: f.orgId, code: 'EVE', name: 'Evening', type: 'FIXED', startTime: '18:00', endTime: '22:00' },
  ]).returning(['id', 'code']).execute();
  const id = (code: string) => shifts.find((s) => s.code === code)!.id;
  MORN = id('MORN'); DAY = id('DAY'); EVE = id('EVE');
  PATTERN = (await h.admin.insertInto('shiftPatterns').values({ organizationId: f.orgId, code: 'ROT', name: 'Rotation', cycleLengthDays: 2, anchorDate: '2026-01-01', sequence: JSON.stringify([{ day: 1, shiftId: MORN }, { day: 2, shiftId: null }]) }).returning('id').executeTakeFirstOrThrow()).id;
  await h.admin.insertInto('shiftAssignments').values([
    { organizationId: f.orgId, targetType: 'EMPLOYEE', targetId: f.e1, branchId: f.branchA, shiftId: MORN, effectiveFrom: '2026-01-01' },
    { organizationId: f.orgId, targetType: 'BRANCH', targetId: f.branchA, branchId: f.branchA, shiftId: EVE, effectiveFrom: '2026-01-01' },
    { organizationId: f.orgId, targetType: 'EMPLOYEE', targetId: f.e3, branchId: f.branchA, shiftId: null, shiftPatternId: PATTERN, effectiveFrom: '2026-01-01' },
  ]).execute();
});
afterAll(async () => { await h?.close(); });

describe('placeEmployeeShiftRange', () => {
  it('splits the open-ended assignment around the range; the branch assignment and colleagues are untouched', async () => {
    const out = await inSystem((t) => placeEmployeeShiftRange(t, f.orgId, { employeeId: f.e1, branchId: f.branchA, shiftId: DAY, from: '2026-10-10', toExclusive: '2026-10-15', actorUserId: f.hrAdmin }));
    expect(await employeeRows(f.e1)).toEqual(['2026-01-01→2026-10-10:MORN', '2026-10-10→2026-10-15:DAY', '2026-10-15→∞:MORN']);
    expect(out.touched.map((x) => x.action)).toEqual(['ends_before_change', 'continues_after_change']);
    const created = await h.admin.selectFrom('shiftAssignments').select(['id', 'shiftId', 'createdBy']).where('id', '=', out.id).executeTakeFirstOrThrow();
    expect(created).toMatchObject({ shiftId: DAY, createdBy: f.hrAdmin });
    const branch = await h.admin.selectFrom('shiftAssignments').selectAll().where('targetType', '=', 'BRANCH').where('targetId', '=', f.branchA).execute();
    expect(branch.map(span)).toEqual(['2026-01-01→∞']);
  });

  it('a second, overlapping range trims what it overlaps (head of one, tail of another)', async () => {
    const out = await inSystem((t) => placeEmployeeShiftRange(t, f.orgId, { employeeId: f.e1, branchId: f.branchA, shiftId: EVE, from: '2026-10-13', toExclusive: '2026-10-20', actorUserId: f.hrAdmin }));
    expect(await employeeRows(f.e1)).toEqual(['2026-01-01→2026-10-10:MORN', '2026-10-10→2026-10-13:DAY', '2026-10-13→2026-10-20:EVE', '2026-10-20→∞:MORN']);
    expect(out.touched.map((x) => x.action).sort()).toEqual(['ends_before_change', 'starts_after_change']);
  });

  it('replaces a row with the same bounds', async () => {
    const out = await inSystem((t) => placeEmployeeShiftRange(t, f.orgId, { employeeId: f.e1, branchId: f.branchA, shiftId: MORN, from: '2026-10-13', toExclusive: '2026-10-20', actorUserId: f.hrAdmin }));
    expect(out.touched).toEqual([expect.objectContaining({ action: 'replaced', from: '2026-10-13', to: '2026-10-20' })]);
    expect(await employeeRows(f.e1)).toEqual(['2026-01-01→2026-10-10:MORN', '2026-10-10→2026-10-13:DAY', '2026-10-13→2026-10-20:MORN', '2026-10-20→∞:MORN']);
  });

  it('a split rotation keeps its pattern on both sides', async () => {
    await inSystem((t) => placeEmployeeShiftRange(t, f.orgId, { employeeId: f.e3, branchId: f.branchA, shiftId: DAY, from: '2026-10-10', toExclusive: '2026-10-11', actorUserId: f.hrAdmin }));
    expect(await employeeRows(f.e3)).toEqual(['2026-01-01→2026-10-10:PATTERN', '2026-10-10→2026-10-11:DAY', '2026-10-11→∞:PATTERN']);
  });
});

describe('placeAdditionalShiftRange', () => {
  it('splits an additional assignment around the range and keeps its request link on the tail', async () => {
    const before = await h.admin.insertInto('additionalShiftAssignments').values({ organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, shiftId: EVE, effectiveFrom: '2026-11-01', effectiveTo: '2026-12-01' }).returning('id').executeTakeFirstOrThrow();
    const out = await inSystem((t) => placeAdditionalShiftRange(t, f.orgId, { employeeId: f.e1, branchId: f.branchA, shiftId: EVE, from: '2026-11-10', toExclusive: '2026-11-12', actorUserId: f.hrAdmin, shiftChangeRequestId: null }));
    const rows = await h.admin.selectFrom('additionalShiftAssignments').selectAll().where('employeeId', '=', f.e1).orderBy('effectiveFrom').execute();
    expect(rows.map(span)).toEqual(['2026-11-01→2026-11-10', '2026-11-10→2026-11-12', '2026-11-12→2026-12-01']);
    expect(rows[0]!.id).toBe(before.id);
    expect(rows[1]!.id).toBe(out.id);
    expect(out.touched.map((x) => x.action)).toEqual(['ends_before_change', 'continues_after_change']);
  });

  it('the exclusion constraint still guards the table (a direct overlapping insert is refused)', async () => {
    await expect(h.admin.insertInto('additionalShiftAssignments').values({ organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, shiftId: EVE, effectiveFrom: '2026-11-11', effectiveTo: '2026-11-13' }).execute()).rejects.toMatchObject({ code: '23P01' });
  });
});
