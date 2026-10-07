import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { withContext } from '@flowza/database';
import { calculateDailyRecord } from '@flowza/domain';
import { DEFAULT_POLICY_SECTIONS } from '@flowza/contracts';
import { createHarness, type TestHarness } from '../../test/harness.js';
import { loadDailyInputs } from './load-inputs.js';

/*
 * Enterprise engine input (migration 20261007000100, docs/enterprise/plan.md §4 / §9): the policy of a day is the most specific
 * scoped policy (country → branch → department → employee group → shift), the employee group is the membership ON the date,
 * and an additional shift assignment is combined with the day's shift into one double-shift day.
 */
const ORG = '0e000000-0000-4000-a000-000000000001';
const BRANCH = '0e000000-0000-4000-a000-00000000000a'; // country OM (default)
const BRANCH_AE = '0e000000-0000-4000-a000-00000000000b';
const E1 = '0e000000-0000-4000-a000-0000000000e1'; // office group until 2026-03-15
const E2 = '0e000000-0000-4000-a000-0000000000e2'; // no group
const E3 = '0e000000-0000-4000-a000-0000000000e3'; // in the AE branch
const GROUP = '0e000000-0000-4000-a000-0000000000a9';
const MORNING = '0e000000-0000-4000-a000-0000000000a1';
const EVENING = '0e000000-0000-4000-a000-0000000000a2';
const P_ORG = '0e000000-0000-4000-a000-0000000000f1';
const P_OM = '0e000000-0000-4000-a000-0000000000f2';
const P_GROUP = '0e000000-0000-4000-a000-0000000000f3';
const MUSCAT = 'Asia/Muscat';
const NOW = new Date('2026-03-20T06:00:00Z');
const at = (date: string, time: string) => DateTime.fromISO(`${date}T${time}`, { zone: MUSCAT }).toJSDate();

let h: TestHarness;
const load = (employeeId: string, date: string) => withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => loadDailyInputs(trx, ORG, employeeId, date, NOW));

beforeAll(async () => {
  h = await createHarness(`flowza_worker_ent_${process.pid}`, defaultRegistry(), () => NOW);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'ENT', legalName: 'Ent', displayName: 'Ent', timezone: MUSCAT, weeklyOffDays: [5, 6] }).execute();
  await a.insertInto('branches').values([
    { id: BRANCH, organizationId: ORG, code: 'MCT', name: 'Muscat', timezone: MUSCAT },
    { id: BRANCH_AE, organizationId: ORG, code: 'DXB', name: 'Dubai', timezone: 'Asia/Dubai', countryCode: 'AE' },
  ]).execute();
  await a.insertInto('shifts').values([
    { id: MORNING, organizationId: ORG, code: 'M', name: 'Morning', type: 'FIXED', startTime: '06:00', endTime: '14:00', breaks: JSON.stringify([]) },
    { id: EVENING, organizationId: ORG, code: 'E', name: 'Evening', type: 'FIXED', startTime: '18:00', endTime: '22:00', breaks: JSON.stringify([]) },
  ]).execute();
  await a.insertInto('shiftAssignments').values({ organizationId: ORG, targetType: 'ORGANIZATION', targetId: ORG, shiftId: MORNING, effectiveFrom: '2026-01-01' }).execute();
  const emp = (id: string, n: string, branchId = BRANCH) => ({ id, organizationId: ORG, employeeNumber: n, firstName: 'F', lastName: n, displayName: `F ${n}`, joiningDate: '2025-01-01', branchId, deviceUserId: n, customFields: JSON.stringify({}) });
  await a.insertInto('employees').values([emp(E1, '1'), emp(E2, '2'), emp(E3, '3', BRANCH_AE)]).execute();
  await a.insertInto('employeeGroups').values({ id: GROUP, organizationId: ORG, code: 'OFFICE', name: 'Office staff' }).execute();
  await a.insertInto('employeeGroupMemberships').values({ organizationId: ORG, employeeGroupId: GROUP, employeeId: E1, effectiveFrom: '2026-01-01', effectiveTo: '2026-03-16' }).execute();
  const policy = { ...DEFAULT_POLICY_SECTIONS, late: { veryLateAfterMinutes: 30, repeatedLate: null } };
  await a.insertInto('attendanceRuleSets').values([
    { id: P_ORG, organizationId: ORG, name: 'Company default', effectiveFrom: '2026-01-01', graceInMinutes: 15, ramadanMode: JSON.stringify({}) },
    { id: P_OM, organizationId: ORG, name: 'Oman', countryCode: 'OM', effectiveFrom: '2026-01-01', graceInMinutes: 10, ramadanMode: JSON.stringify({}) },
    { id: P_GROUP, organizationId: ORG, name: 'Oman – Office staff', countryCode: 'OM', employeeGroupId: GROUP, effectiveFrom: '2026-01-01', graceInMinutes: 0, punchInterpretation: 'PAIRED', ramadanMode: JSON.stringify({}), policy: JSON.stringify(policy) },
  ]).execute();
  await a.insertInto('additionalShiftAssignments').values({ organizationId: ORG, employeeId: E1, branchId: BRANCH, shiftId: EVENING, effectiveFrom: '2026-03-10', effectiveTo: '2026-03-11' }).execute();
  await a.insertInto('attendanceEvents').values([
    ...['06:40', '14:00', '18:00', '22:00'].map((t, i) => ({ organizationId: ORG, employeeId: E1, branchId: BRANCH, punchedAt: at('2026-03-10', t), eventType: (i % 2 === 0 ? 'PUNCH_IN' : 'PUNCH_OUT') as 'PUNCH_IN' | 'PUNCH_OUT', source: 'DEVICE' as const, verificationMethod: 'fingerprint' as const })),
  ]).execute();
});
afterAll(async () => { await h?.close(); });

describe('Enterprise engine input', () => {
  it('the most specific scoped policy applies: group on the date, else the country, else the company default', async () => {
    expect((await load(E1, '2026-03-12'))!.input.ruleSetId).toBe(P_GROUP);
    expect((await load(E1, '2026-03-12'))!.policyScope).toEqual({ countryCode: 'OM', branchId: BRANCH, departmentId: null, employeeGroupId: GROUP, shiftId: MORNING });
    // the membership ended on 2026-03-15 (stored exclusive end 03-16)
    expect((await load(E1, '2026-03-16'))!.input.ruleSetId).toBe(P_OM);
    expect((await load(E2, '2026-03-12'))!.input.ruleSetId).toBe(P_OM);
    expect((await load(E3, '2026-03-12'))!.input.ruleSetId).toBe(P_ORG);
    expect((await load(E1, '2026-03-12'))!.input.rules.policy.late.veryLateAfterMinutes).toBe(30);
  });

  it('an additional shift makes a double-shift day; the engine flags it and VERY_LATE from the group policy', async () => {
    const loaded = (await load(E1, '2026-03-10'))!;
    expect(loaded.additionalShiftId).toBe(EVENING);
    expect(loaded.input.shift).toMatchObject({ id: MORNING, startTime: '06:00', endTime: '22:00' });
    expect(loaded.input.shift?.segments?.map((s) => s.shiftId)).toEqual([MORNING, EVENING]);
    // the next day has no additional shift: the neighbour window is the plain morning shift
    expect(loaded.input.adjacentShifts?.next?.segments).toBeUndefined();
    const rec = calculateDailyRecord(loaded.input);
    expect(rec.flags).toEqual(expect.arrayContaining(['DOUBLE_SHIFT', 'LATE', 'VERY_LATE']));
    expect(rec).toMatchObject({ shiftId: MORNING, ruleSetId: P_GROUP, scheduledMinutes: 12 * 60, lateMinutes: 40, workedMinutes: 7 * 60 + 20 + 4 * 60 });
    expect((await load(E1, '2026-03-11'))!.additionalShiftId).toBeNull();
  });
});
