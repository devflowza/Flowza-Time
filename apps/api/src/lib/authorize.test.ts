import { describe, expect, it } from 'vitest';
import type { MembershipGrant, Principal } from '@flowza/domain';
import { AppError } from '@flowza/shared';
import { isTeamMember, requireTeamOrPermission } from './authorize.js';

const ORG = '0a000000-0000-0000-0000-000000000000';
const OTHER_ORG = '0b000000-0000-0000-0000-000000000000';
const REPORT = '0a000000-0000-0000-0000-0000000000e1';
const STRANGER = '0a000000-0000-0000-0000-0000000000e2';

function principal(m: Partial<MembershipGrant>): Principal {
  const membership: MembershipGrant = {
    membershipId: 'm1', organizationId: ORG, roleId: 'r1', roleKey: 'manager', permissions: [], allBranches: true, branchIds: [], employeeId: '0a000000-0000-0000-0000-0000000000e4', teamEmployeeIds: [], ...m,
  };
  return { userId: 'u1', email: 'u1@test.local', isPlatformAdmin: false, memberships: [membership] };
}
const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof AppError ? e.code : 'other'; } };

describe('requireTeamOrPermission', () => {
  it('lets an organisation-wide permission holder through regardless of the team', () => {
    const p = principal({ permissions: ['attendance.view'], teamEmployeeIds: [] });
    expect(requireTeamOrPermission(p, ORG, STRANGER, 'attendance.view').roleKey).toBe('manager');
  });
  it('lets a line manager through for a direct report only', () => {
    const p = principal({ permissions: ['attendance.view_team'], teamEmployeeIds: [REPORT] });
    expect(requireTeamOrPermission(p, ORG, REPORT, 'attendance.view').membershipId).toBe('m1');
    expect(code(() => requireTeamOrPermission(p, ORG, STRANGER, 'attendance.view'))).toBe('FORBIDDEN');
  });
  it('requires every listed permission for the organisation-wide branch (a partial set falls back to the team test)', () => {
    const p = principal({ permissions: ['attendance.view'], teamEmployeeIds: [REPORT] });
    expect(code(() => requireTeamOrPermission(p, ORG, STRANGER, 'attendance.view', 'attendance.correct'))).toBe('FORBIDDEN');
    expect(requireTeamOrPermission(p, ORG, REPORT, 'attendance.view', 'attendance.correct').membershipId).toBe('m1');
  });
  it('rejects a non-member before looking at the team, and an empty team with no permission', () => {
    const p = principal({ permissions: [], teamEmployeeIds: [REPORT] });
    expect(code(() => requireTeamOrPermission(p, OTHER_ORG, REPORT, 'attendance.view'))).toBe('FORBIDDEN');
    expect(code(() => requireTeamOrPermission(principal({ permissions: [], teamEmployeeIds: [] }), ORG, REPORT, 'attendance.view'))).toBe('FORBIDDEN');
  });
  it('isTeamMember reads the snapshot list only (never employees.user_id or the caller\'s own record)', () => {
    const own = '0a000000-0000-0000-0000-0000000000e4';
    const m = principal({ teamEmployeeIds: [REPORT] }).memberships[0]!;
    expect(isTeamMember(m, REPORT)).toBe(true);
    expect(isTeamMember(m, own)).toBe(false);
  });
});
