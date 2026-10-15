import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import enAtt from '@/locales/en/attendance.json';
import arAtt from '@/locales/ar/attendance.json';
import enLeave from '@/locales/en/leave.json';
import arLeave from '@/locales/ar/leave.json';
import { teamMember } from '../test-fixtures';
import { MemberCard } from './today-tab';
import { MembersDirectory } from './members-directory';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('leave', enLeave, arLeave);

/** Organisation team scope `hierarchy` (migration 20261015000300): reports further down the line are `indirect`. */
describe('team relation badges', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.employeeId = 'e4'; });

  it('names an indirect report "via" their own manager, and keeps the secondary badge', () => {
    const noop = vi.fn();
    const { unmount } = renderWithProviders(<MemberCard m={teamMember({ relation: 'indirect', managerName: 'Huda Al Lawati' })} canOpenProfile onOpenRecord={noop} onPending={noop} />);
    expect(screen.getByTestId('relation-indirect')).toHaveTextContent('Indirect · via Huda Al Lawati');
    unmount();

    renderWithProviders(<MemberCard m={teamMember({ relation: 'indirect', managerName: null })} canOpenProfile onOpenRecord={noop} onPending={noop} />);
    expect(screen.getByTestId('relation-indirect')).toHaveTextContent('Indirect report');
  });

  it('shows the time-away flags of a report\'s day', () => {
    const noop = vi.fn();
    renderWithProviders(<MemberCard m={teamMember({ flags: ['TIME_AWAY', 'UNAPPROVED_AWAY'] })} canOpenProfile onOpenRecord={noop} onPending={noop} />);
    const card = screen.getByTestId('team-member-card');
    expect(within(card).getByText('Time away')).toBeInTheDocument();
    expect(within(card).getByText('Unapproved time away')).toBeInTheDocument();
  });

  it('the directory: manager, secondary manager, or indirect through the report\'s manager', async () => {
    const base = { branchId: 'b1', branchName: 'Muscat', departmentName: 'IT', designationName: 'Engineer', employmentStatus: 'active' };
    // GET /employees?teamOf=<own employee> answers with the team under the organisation's scope (API team-hierarchy.test.ts):
    // the reporting line under 'hierarchy', each row with its own manager's name from the list itself
    mockGet({ '/orgs/org-1/employees': page([
      { ...base, id: 'e5', displayName: 'Salma', employeeNumber: 'E005', managerEmployeeId: 'e4', secondaryManagerEmployeeId: null, managerName: 'Me', secondaryManagerName: null },
      { ...base, id: 'e6', displayName: 'Yousuf', employeeNumber: 'E006', managerEmployeeId: 'e9', secondaryManagerEmployeeId: 'e4', managerName: 'Huda', secondaryManagerName: 'Me' },
      { ...base, id: 'e7', displayName: 'Aisha', employeeNumber: 'E007', managerEmployeeId: 'e5', secondaryManagerEmployeeId: null, managerName: 'Salma', secondaryManagerName: null },
      // no primary manager: the reporting line walks through the secondary one, who is named
      { ...base, id: 'e8', displayName: 'Badr', employeeNumber: 'E008', managerEmployeeId: null, secondaryManagerEmployeeId: 'e5', managerName: null, secondaryManagerName: 'Salma' },
    ]) });
    renderWithProviders(<MembersDirectory />);
    const rowOf = async (name: string) => (await screen.findByRole('link', { name })).closest('tr')!;
    expect(await rowOf('Salma')).toHaveTextContent('Manager');
    expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/employees', expect.objectContaining({ teamOf: 'e4' }));
    expect(await rowOf('Yousuf')).toHaveTextContent('Secondary manager');
    expect(await rowOf('Aisha')).toHaveTextContent('Indirect · via Salma');
    expect(await rowOf('Badr')).toHaveTextContent('Indirect · via Salma');
  });
});
