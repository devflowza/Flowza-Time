import { describe, expect, it } from 'vitest';
import { explainPolicyResolution, policyLocationDepth, policySpecificity, resolvePolicy, type PolicyScope, type ScopedPolicy } from './resolve-policy.js';

/*
 * Locations in policy resolution (docs/locations.md §3): Muscat HQ (group) → Branch 1 → Site A → Floor 2. A location policy
 * matches when its location is on the employee's chain; between two location policies the deeper one wins; every ordering
 * between the earlier dimensions is unchanged.
 */
const base = { effectiveFrom: '2026-01-01', effectiveTo: null } as const;
const P = (id: string, extra: Partial<ScopedPolicy>): ScopedPolicy => ({ id, branchId: null, ...base, ...extra });
const org = P('org', {});
const oman = P('oman', { countryCode: 'OM' });
const hq = P('hq', { locationId: 'L-HQ', locationDepth: 1 });
const branch1 = P('branch1', { branchId: 'B1', branchDepth: 2 });
const siteA = P('siteA', { branchId: 'B1', locationId: 'L-SA', locationDepth: 3 });
const floor2 = P('floor2', { branchId: 'B1', locationId: 'L-F2', locationDepth: 4 });
const finance = P('finance', { departmentId: 'D-FIN' });
const branch1Oman = P('branch1Oman', { branchId: 'B1', branchDepth: 2, countryCode: 'OM' });

const onFloor2: PolicyScope = { countryCode: 'OM', branchId: 'B1', departmentId: 'D-OPS', employeeGroupId: null, shiftId: null, locationIds: ['L-HQ', 'L-B1', 'L-SA', 'L-F2'] };
const inBranch1: PolicyScope = { ...onFloor2, locationIds: ['L-HQ', 'L-B1'] };
const date = '2026-10-10';

describe('policy resolution with locations', () => {
  it('picks the deepest location policy on the employee chain', () => {
    expect(resolvePolicy([org, oman, hq, branch1, siteA, floor2], date, onFloor2)?.id).toBe('floor2');
    expect(resolvePolicy([org, oman, hq, branch1, siteA], date, onFloor2)?.id).toBe('siteA');
    expect(resolvePolicy([org, oman, hq, branch1], date, onFloor2)?.id).toBe('branch1');
    expect(resolvePolicy([org, oman, hq], date, onFloor2)?.id).toBe('hq');
  });

  it('does not apply a place policy to the rest of the branch', () => {
    expect(resolvePolicy([org, branch1, siteA, floor2], date, inBranch1)?.id).toBe('branch1');
    const explained = explainPolicyResolution([siteA], date, inBranch1);
    expect(explained.winner).toBeNull();
    expect(explained.candidates[0]?.mismatch).toBe('LOCATION');
    // without a chain (the classic branch-only resolution) no location policy matches
    expect(resolvePolicy([branch1, siteA], date, { ...inBranch1, locationIds: undefined })?.id).toBe('branch1');
  });

  it('lets a deeper location beat a branch that also names the country', () => {
    // under the published weights both show 4 (+2): the location depth decides before the country does
    expect(resolvePolicy([branch1Oman, siteA], date, onFloor2)?.id).toBe('siteA');
    expect(resolvePolicy([branch1Oman, branch1], date, onFloor2)?.id).toBe('branch1Oman');
  });

  it('keeps department, group and shift above any location', () => {
    expect(resolvePolicy([floor2, { ...finance, departmentId: 'D-OPS' }], date, onFloor2)?.id).toBe('finance');
    expect(resolvePolicy([floor2, P('group', { employeeGroupId: 'G' })], date, { ...onFloor2, employeeGroupId: 'G' })?.id).toBe('group');
  });

  it('shows the published weights, a location counting once with its branch', () => {
    expect(policySpecificity(org)).toBe(0);
    expect(policySpecificity(oman)).toBe(2);
    expect(policySpecificity(hq)).toBe(4);
    expect(policySpecificity(branch1)).toBe(4);
    expect(policySpecificity(siteA)).toBe(4);
    expect(policySpecificity(branch1Oman)).toBe(6);
    expect(policySpecificity(P('x', { branchId: 'B1', locationId: 'L-SA', departmentId: 'D', countryCode: 'OM' }))).toBe(14);
    expect(policyLocationDepth(org)).toBe(0);
    expect(policyLocationDepth(siteA)).toBe(3);
    expect(policyLocationDepth(P('nodepth', { branchId: 'B1' }))).toBe(1);
  });

  it('reports mismatches broadest first', () => {
    const other = P('other', { branchId: 'B2', locationId: 'L-X' });
    expect(explainPolicyResolution([other], date, onFloor2).candidates[0]?.mismatch).toBe('BRANCH');
    expect(explainPolicyResolution([P('old', { locationId: 'L-HQ', effectiveTo: '2026-01-02' })], date, onFloor2).candidates[0]?.mismatch).toBe('DATES');
  });
});
