import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_SECTIONS } from '@flowza/contracts';
import { calculateDailyRecord } from './calculate.js';
import { composeDoubleShift } from './double-shift.js';
import { explainPolicyResolution, policySpecificity, resolvePolicy, type PolicyScope, type ScopedPolicy } from './resolve-policy.js';
import { resolveRuleSet } from './resolve-shift.js';
import { DATE, fixedShift, input, nightShift, punch, rules } from './testing.js';

const scope = (over: Partial<PolicyScope> = {}): PolicyScope => ({ countryCode: 'OM', branchId: 'muscat', departmentId: 'sales', employeeGroupId: 'office', shiftId: 'day', ...over });
const pol = (id: string, over: Partial<ScopedPolicy> = {}): ScopedPolicy => ({ id, effectiveFrom: '2026-01-01', effectiveTo: null, branchId: null, ...over });

describe('resolvePolicy (Country → Company → Location → Department → Employee group → Shift)', () => {
  const org = pol('org');
  const oman = pol('oman', { countryCode: 'OM' });
  const muscat = pol('muscat', { countryCode: 'OM', branchId: 'muscat' });
  const salesMuscat = pol('sales-muscat', { branchId: 'muscat', departmentId: 'sales' });
  const office = pol('office', { employeeGroupId: 'office' });
  const night = pol('night', { shiftId: 'night' });

  it('the most specific matching policy wins; a more specific dimension beats any combination of broader ones', () => {
    const all = [org, oman, muscat, salesMuscat, office, night];
    expect(resolvePolicy(all, DATE, scope())?.id).toBe('office'); // group 16 > branch+department 12 > country+branch 6
    expect(resolvePolicy(all, DATE, scope({ employeeGroupId: null }))?.id).toBe('sales-muscat');
    expect(resolvePolicy(all, DATE, scope({ employeeGroupId: null, departmentId: 'ops' }))?.id).toBe('muscat');
    expect(resolvePolicy(all, DATE, scope({ employeeGroupId: null, departmentId: 'ops', branchId: 'salalah' }))?.id).toBe('oman');
    expect(resolvePolicy(all, DATE, scope({ employeeGroupId: null, countryCode: 'AE', branchId: 'dubai' }))?.id).toBe('org');
    expect(resolvePolicy(all, DATE, scope({ shiftId: 'night' }))?.id).toBe('night');
    expect(policySpecificity(night)).toBeGreaterThan(policySpecificity(pol('x', { countryCode: 'OM', branchId: 'b', departmentId: 'd', employeeGroupId: 'g' })));
  });

  it('every named dimension must match; dates are half-open; ties go to the latest start, then the id', () => {
    expect(resolvePolicy([oman], DATE, scope({ countryCode: 'SA' }))).toBeNull();
    const old = pol('old', { effectiveTo: DATE });
    expect(resolvePolicy([old], DATE, scope())).toBeNull();
    const a = pol('a', { countryCode: 'OM', effectiveFrom: '2026-02-01' });
    const b = pol('b', { countryCode: 'OM', effectiveFrom: '2026-03-01' });
    expect(resolvePolicy([a, b], DATE, scope())?.id).toBe('b');
    expect(resolvePolicy([pol('z', { countryCode: 'OM' }), pol('y', { countryCode: 'OM' })], DATE, scope())?.id).toBe('y');
  });

  it('explains why each candidate does not apply', () => {
    const { winner, candidates } = explainPolicyResolution([org, night, oman, pol('expired', { effectiveTo: '2026-02-01' })], DATE, scope());
    expect(winner?.id).toBe('oman');
    expect(candidates.map((c) => [c.policy.id, c.mismatch])).toEqual([['oman', null], ['org', null], ['night', 'SHIFT'], ['expired', 'DATES']]);
  });

  it('resolveRuleSet keeps its branch-or-organisation meaning and ignores policies scoped by another dimension', () => {
    const rs = (p: ScopedPolicy) => ({ ...p, rules: rules() });
    const sets = [rs(org), rs(pol('branch', { branchId: 'muscat' })), rs(oman)];
    expect(resolveRuleSet(sets, DATE, 'muscat')?.id).toBe('branch');
    expect(resolveRuleSet(sets, DATE, 'salalah')?.id).toBe('org');
  });
});

describe('composeDoubleShift', () => {
  const morning = fixedShift({ id: 'm', code: 'M', name: 'Morning', startTime: '06:00', endTime: '14:00', breaks: [{ minutes: 30, paid: false }] });
  const evening = fixedShift({ id: 'e', code: 'E', name: 'Evening', startTime: '18:00', endTime: '22:00' });

  it('one day from the first start to the last end, the gap an unpaid break, grace and windows from the outer shifts', () => {
    const r = composeDoubleShift(evening, { ...morning, graceInMinutes: 5, punchInWindowBeforeMinutes: 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shift).toMatchObject({ id: 'e', code: 'M+E', startTime: '06:00', endTime: '22:00', graceInMinutes: 5, punchInWindowBeforeMinutes: 60, type: 'FIXED' });
    expect(r.shift.breaks).toEqual([{ minutes: 30, paid: false }, { start: '14:00', end: '18:00', paid: false }]);
    expect(r.shift.segments?.map((s) => s.shiftId)).toEqual(['m', 'e']);
  });

  it('an evening followed by a night shift crosses midnight', () => {
    const r = composeDoubleShift(fixedShift({ id: 'ev', code: 'EV', startTime: '14:00', endTime: '22:00' }), nightShift());
    expect(r.ok && [r.shift.startTime, r.shift.endTime, r.shift.breaks.length]).toEqual(['14:00', '06:00', 0]);
  });

  it('refuses overlapping, flexible, identical and 24-hour combinations', () => {
    expect(composeDoubleShift(morning, fixedShift({ id: 'x', startTime: '13:00', endTime: '20:00' }))).toEqual({ ok: false, reason: 'OVERLAP' });
    expect(composeDoubleShift(morning, fixedShift({ id: 'f', type: 'FLEXIBLE', startTime: null, endTime: null, requiredMinutes: 480 }))).toEqual({ ok: false, reason: 'NOT_FIXED' });
    expect(composeDoubleShift(morning, morning)).toEqual({ ok: false, reason: 'SAME_SHIFT' });
    expect(composeDoubleShift(fixedShift({ id: 'a', startTime: '06:00', endTime: '18:00' }), fixedShift({ id: 'b', startTime: '18:00', endTime: '06:00' }))).toEqual({ ok: false, reason: 'TOO_LONG' });
  });

  it('the engine calculates the composite day: late against the first start, the gap unpaid, overtime after the last end, DOUBLE_SHIFT', () => {
    const r = composeDoubleShift(fixedShift({ id: 'm', code: 'M', startTime: '06:00', endTime: '14:00' }), fixedShift({ id: 'e', code: 'E', startTime: '18:00', endTime: '22:00' }));
    if (!r.ok) throw new Error('compose failed');
    const rec = calculateDailyRecord(input({
      shift: r.shift,
      rules: rules({ punchInterpretation: 'PAIRED', graceInMinutes: 0 }),
      events: [punch(DATE, '06:20', 'PUNCH_IN'), punch(DATE, '14:00', 'PUNCH_OUT'), punch(DATE, '18:00', 'PUNCH_IN'), punch(DATE, '22:30', 'PUNCH_OUT')],
    }));
    expect(rec.flags).toEqual(expect.arrayContaining(['DOUBLE_SHIFT', 'LATE', 'OVERTIME']));
    expect(rec.scheduledMinutes).toBe(12 * 60);
    expect(rec.lateMinutes).toBe(20);
    expect(rec.workedMinutes).toBe(7 * 60 + 40 + 4 * 60 + 30);
    expect(rec.overtimeMinutes).toBe(30);
    expect(rec.shiftId).toBe('m');
    expect(rec.trace.inputs.segments?.map((s) => s.code)).toEqual(['M', 'E']);
  });
});

describe('VERY_LATE (engine 1.4.0)', () => {
  const policy = { ...DEFAULT_POLICY_SECTIONS, late: { veryLateAfterMinutes: 60, repeatedLate: null } };
  const day = (time: string, over: Partial<typeof policy> = {}) => calculateDailyRecord(input({
    shift: fixedShift({ startTime: '08:00', endTime: '17:00' }),
    rules: rules({ graceInMinutes: 10, policy: { ...policy, ...over } }),
    events: [punch(DATE, time), punch(DATE, '17:00')],
  }));

  it('flags an arrival more than the threshold after the scheduled start (not after the grace)', () => {
    expect(day('08:10').flags).not.toContain('LATE');
    expect(day('08:30').flags).toEqual(expect.arrayContaining(['LATE']));
    expect(day('08:30').flags).not.toContain('VERY_LATE');
    expect(day('09:00').flags).not.toContain('VERY_LATE');
    expect(day('09:01').flags).toEqual(expect.arrayContaining(['LATE', 'VERY_LATE']));
  });

  it('is off without a threshold, and on a plain rule set', () => {
    expect(day('10:00', { late: { veryLateAfterMinutes: null, repeatedLate: null } }).flags).not.toContain('VERY_LATE');
    expect(calculateDailyRecord(input({ events: [punch(DATE, '11:00'), punch(DATE, '17:00')] })).flags).not.toContain('VERY_LATE');
  });
});
