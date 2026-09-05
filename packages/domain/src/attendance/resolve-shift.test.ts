import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTENDANCE_RULES } from '@flowza/contracts';
import { isEffectiveOn, patternCycleDay, resolveRuleSet, resolveShift, type EmployeeScope, type EngineRuleSet } from './resolve-shift.js';
import type { EngineShiftAssignment, EngineShiftPattern } from './types.js';

const scope: EmployeeScope = { employeeId: 'emp-1', teamIds: ['team-a', 'team-b'], departmentId: 'dept-1', branchId: 'branch-1', organizationId: 'org-1' };

function assignment(overrides: Partial<EngineShiftAssignment> & Pick<EngineShiftAssignment, 'id' | 'targetType' | 'targetId'>): EngineShiftAssignment {
  return { shiftId: `shift-${overrides.targetType.toLowerCase()}`, shiftPatternId: null, effectiveFrom: '2026-01-01', effectiveTo: null, ...overrides };
}

const org = assignment({ id: 'a-org', targetType: 'ORGANIZATION', targetId: 'org-1' });
const branch = assignment({ id: 'a-branch', targetType: 'BRANCH', targetId: 'branch-1' });
const dept = assignment({ id: 'a-dept', targetType: 'DEPARTMENT', targetId: 'dept-1' });
const team = assignment({ id: 'a-team', targetType: 'TEAM', targetId: 'team-b' });
const employee = assignment({ id: 'a-emp', targetType: 'EMPLOYEE', targetId: 'emp-1' });

describe('resolveShift', () => {
  it('prefers EMPLOYEE > TEAM > DEPARTMENT > BRANCH > ORGANIZATION', () => {
    expect(resolveShift([org, branch, dept, team, employee], [], scope, '2026-03-10').shiftId).toBe('shift-employee');
    expect(resolveShift([org, branch, dept, team], [], scope, '2026-03-10').shiftId).toBe('shift-team');
    expect(resolveShift([org, branch, dept], [], scope, '2026-03-10').shiftId).toBe('shift-department');
    expect(resolveShift([org, branch], [], scope, '2026-03-10').shiftId).toBe('shift-branch');
    expect(resolveShift([org], [], scope, '2026-03-10')).toMatchObject({ shiftId: 'shift-organization', source: 'ASSIGNMENT' });
  });

  it('ignores assignments that do not target the employee scope', () => {
    const otherTeam = assignment({ id: 'a-other', targetType: 'TEAM', targetId: 'team-z' });
    const otherBranch = assignment({ id: 'a-ob', targetType: 'BRANCH', targetId: 'branch-9' });
    expect(resolveShift([otherTeam, otherBranch, org], [], scope, '2026-03-10').shiftId).toBe('shift-organization');
    expect(resolveShift([otherTeam], [], scope, '2026-03-10')).toEqual({ assignment: null, shiftId: null, isPatternOff: false, source: 'NONE', patternDay: null });
  });

  it('applies half-open effective dating [from, to)', () => {
    const dated = assignment({ id: 'a-dated', targetType: 'EMPLOYEE', targetId: 'emp-1', effectiveFrom: '2026-03-01', effectiveTo: '2026-03-15' });
    expect(resolveShift([org, dated], [], scope, '2026-02-28').shiftId).toBe('shift-organization');
    expect(resolveShift([org, dated], [], scope, '2026-03-01').shiftId).toBe('shift-employee');
    expect(resolveShift([org, dated], [], scope, '2026-03-14').shiftId).toBe('shift-employee');
    expect(resolveShift([org, dated], [], scope, '2026-03-15').shiftId).toBe('shift-organization');
    expect(isEffectiveOn({ effectiveFrom: '2026-03-01', effectiveTo: null }, '2030-01-01')).toBe(true);
  });

  it('picks the most recently effective among equally specific assignments', () => {
    const older = assignment({ id: 'a-old', targetType: 'TEAM', targetId: 'team-a', shiftId: 'shift-old', effectiveFrom: '2025-01-01' });
    const newer = assignment({ id: 'a-new', targetType: 'TEAM', targetId: 'team-b', shiftId: 'shift-new', effectiveFrom: '2026-02-01' });
    expect(resolveShift([older, newer], [], scope, '2026-03-10').shiftId).toBe('shift-new');
  });

  describe('rotational patterns', () => {
    const pattern: EngineShiftPattern = {
      id: 'pat-1',
      cycleLengthDays: 4,
      anchorDate: '2026-03-01',
      sequence: [{ day: 0, shiftId: 'shift-morning' }, { day: 1, shiftId: 'shift-morning' }, { day: 2, shiftId: 'shift-night' }, { day: 3, off: true }],
    };
    const patternAssignment = assignment({ id: 'a-pat', targetType: 'EMPLOYEE', targetId: 'emp-1', shiftId: null, shiftPatternId: 'pat-1' });

    it('computes the cycle day from the anchor date', () => {
      expect(patternCycleDay(pattern, '2026-03-01')).toBe(0);
      expect(patternCycleDay(pattern, '2026-03-03')).toBe(2);
      expect(patternCycleDay(pattern, '2026-03-05')).toBe(0);
      expect(patternCycleDay(pattern, '2026-02-28')).toBe(3); // before the anchor wraps backwards
    });

    it('returns the shift for the cycle day and marks off days', () => {
      expect(resolveShift([patternAssignment, org], [pattern], scope, '2026-03-01')).toMatchObject({ shiftId: 'shift-morning', isPatternOff: false, patternDay: 0, source: 'PATTERN' });
      expect(resolveShift([patternAssignment, org], [pattern], scope, '2026-03-07')).toMatchObject({ shiftId: 'shift-night', patternDay: 2 });
      expect(resolveShift([patternAssignment, org], [pattern], scope, '2026-03-04')).toMatchObject({ shiftId: null, isPatternOff: true, patternDay: 3 });
    });

    it('treats a day the sequence does not define as off', () => {
      const sparse: EngineShiftPattern = { ...pattern, sequence: [{ day: 0, shiftId: 'shift-morning' }] };
      expect(resolveShift([patternAssignment], [sparse], scope, '2026-03-02')).toMatchObject({ shiftId: null, isPatternOff: true, patternDay: 1 });
    });

    it('yields no shift when the pattern is unknown', () => {
      expect(resolveShift([patternAssignment], [], scope, '2026-03-02')).toMatchObject({ assignment: patternAssignment, shiftId: null, isPatternOff: false, source: 'PATTERN' });
    });
  });
});

describe('resolveRuleSet', () => {
  const rs = (id: string, branchId: string | null, effectiveFrom: string, effectiveTo: string | null = null): EngineRuleSet => ({ id, branchId, effectiveFrom, effectiveTo, rules: DEFAULT_ATTENDANCE_RULES });
  const orgDefault = rs('rs-org', null, '2025-01-01');
  const branchSet = rs('rs-branch', 'branch-1', '2026-01-01', '2026-06-01');

  it('prefers the branch-specific rule set over the organisation default', () => {
    expect(resolveRuleSet([orgDefault, branchSet], '2026-03-10', 'branch-1')?.id).toBe('rs-branch');
    expect(resolveRuleSet([orgDefault, branchSet], '2026-03-10', 'branch-2')?.id).toBe('rs-org');
    expect(resolveRuleSet([orgDefault, branchSet], '2026-03-10', null)?.id).toBe('rs-org');
  });

  it('honours effective dating (effectiveTo exclusive)', () => {
    expect(resolveRuleSet([orgDefault, branchSet], '2025-12-31', 'branch-1')?.id).toBe('rs-org');
    expect(resolveRuleSet([orgDefault, branchSet], '2026-05-31', 'branch-1')?.id).toBe('rs-branch');
    expect(resolveRuleSet([orgDefault, branchSet], '2026-06-01', 'branch-1')?.id).toBe('rs-org');
    expect(resolveRuleSet([branchSet], '2024-01-01', 'branch-1')).toBeNull();
  });

  it('picks the latest effectiveFrom when several org defaults overlap', () => {
    const newer = rs('rs-org-2', null, '2026-03-01');
    expect(resolveRuleSet([orgDefault, newer], '2026-03-10', null)?.id).toBe('rs-org-2');
    expect(resolveRuleSet([orgDefault, newer], '2026-02-10', null)?.id).toBe('rs-org');
  });
});
