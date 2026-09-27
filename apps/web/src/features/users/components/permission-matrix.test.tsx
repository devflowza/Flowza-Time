import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { PermissionDto } from '@flowza/contracts';
import i18n from '@/lib/i18n';
import { renderWithProviders } from '@/features/employees/test-utils';
import { PermissionMatrix } from './permission-matrix';

const perms: PermissionDto[] = [
  { key: 'employee.view', category: 'employees', description: 'View employees', sortOrder: 1 },
  { key: 'employee.update', category: 'employees', description: 'Update employees', sortOrder: 2 },
  { key: 'employee.delete', category: 'employees', description: 'Delete employees', sortOrder: 3 },
  { key: 'audit.view', category: 'audit', description: 'View audit log', sortOrder: 9 },
];

describe('PermissionMatrix', () => {
  it('groups by category and toggles a whole group, skipping permissions the actor does not hold', () => {
    const onChange = vi.fn();
    renderWithProviders(<PermissionMatrix permissions={perms} value={['employee.view']} onChange={onChange} grantable={new Set(['employee.view', 'employee.update', 'audit.view'])} />);
    expect(screen.getByRole('group', { name: 'Employees' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Audit' })).toBeInTheDocument();
    const del = screen.getByRole('checkbox', { name: /^employee\.delete/ });
    expect(del).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle all employees permissions' }));
    expect(onChange).toHaveBeenCalledWith(['employee.view', 'employee.update']);
  });
  it('groups the HR-portal keys under their categories, including the new Approvals and Integrations groups', () => {
    const portalPerms: PermissionDto[] = [
      { key: 'integration.manage', category: 'integrations', description: 'Manage integrations and connectors', sortOrder: 25 },
      { key: 'leave.approve', category: 'leave', description: 'Approve or reject leave requests', sortOrder: 78 },
      { key: 'leave.view_team', category: 'leave', description: 'View leave of direct reports', sortOrder: 79 },
      { key: 'attendance.view', category: 'attendance', description: 'View processed attendance', sortOrder: 80 },
      { key: 'attendance.view_team', category: 'attendance', description: 'View attendance of direct reports', sortOrder: 89 },
      { key: 'attendance.checkin', category: 'attendance', description: 'Check in and out from the web or mobile app', sortOrder: 90 },
      { key: 'report.schedule', category: 'reports', description: 'Share reports and manage report schedules', sortOrder: 103 },
      { key: 'approval.manage', category: 'approval', description: 'Configure approval workflows', sortOrder: 105 },
      { key: 'approval.delegate', category: 'approval', description: 'Delegate own approvals to a colleague', sortOrder: 106 },
    ];
    renderWithProviders(<PermissionMatrix permissions={[...perms, ...portalPerms]} value={['approval.manage', 'attendance.view_team', 'leave.approve']} readOnly />);
    // one fieldset per category, ordered by the sort order of the category's first key
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label') ?? g.querySelector('legend')?.textContent)).toEqual(['Employees', 'Audit', 'Integrations', 'Leave', 'Attendance', 'Reports', 'Approvals']);
    expect(screen.getByRole('group', { name: 'Approvals' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Integrations' })).toBeInTheDocument();
    // the keys sit in their own groups with their descriptions, and the counters reflect the selection
    const attendance = screen.getByRole('group', { name: 'Attendance' });
    expect(attendance).toHaveTextContent('attendance.view_team');
    expect(attendance).toHaveTextContent('View attendance of direct reports');
    expect(attendance).toHaveTextContent('1/3');
    expect(screen.getByRole('group', { name: 'Approvals' })).toHaveTextContent('1/2');
    expect(screen.getByRole('checkbox', { name: 'approval.manage' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'leave.view_team' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Toggle all approval permissions' })).toBeDisabled();
  });
  it('lists employee.view_team (line-manager directory scope) in the Employees group, grantable on its own, in en and ar', async () => {
    const withTeam: PermissionDto[] = [
      { key: 'employee.view', category: 'employees', description: 'View employees', sortOrder: 50 },
      { key: 'employee.update', category: 'employees', description: 'Update employees and employment history', sortOrder: 53 },
      { key: 'employee.view_team', category: 'employees', description: 'View the employee records of direct reports (line manager scope)', sortOrder: 57 },
      { key: 'audit.view', category: 'audit', description: 'View audit log', sortOrder: 110 },
    ];
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(<PermissionMatrix permissions={withTeam} value={[]} onChange={onChange} grantable={new Set(['employee.view_team', 'audit.view'])} />);
    const group = screen.getByRole('group', { name: 'Employees' });
    // ordered by sort order inside the category, with the description the database carries
    expect(within(group).getAllByRole('checkbox').map((c) => c.id)).toEqual(['grp-employees', 'perm-employee.view', 'perm-employee.update', 'perm-employee.view_team']);
    expect(group).toHaveTextContent('View the employee records of direct reports');
    expect(group).toHaveTextContent('0/3');
    // an actor may hand out the team scope without holding the organisation-wide employee.view
    expect(screen.getByRole('checkbox', { name: /^employee\.view\b/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'employee.view_team' }));
    expect(onChange).toHaveBeenCalledWith(['employee.view_team']);
    await i18n.changeLanguage('ar');
    try {
      rerender(<PermissionMatrix permissions={withTeam} value={['employee.view_team']} readOnly />);
      const ar = screen.getByRole('group', { name: 'الموظفون' });
      expect(ar).toHaveTextContent('employee.view_team');
      expect(ar).toHaveTextContent('1/3');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
  it('unchecks a single permission and is inert when read-only', () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(<PermissionMatrix permissions={perms} value={['employee.view', 'audit.view']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'audit.view' }));
    expect(onChange).toHaveBeenLastCalledWith(['employee.view']);
    rerender(<PermissionMatrix permissions={perms} value={['employee.view']} onChange={onChange} readOnly />);
    expect(screen.getByRole('checkbox', { name: 'employee.view' })).toBeDisabled();
  });
});
