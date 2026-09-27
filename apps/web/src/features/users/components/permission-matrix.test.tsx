import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { PermissionDto } from '@flowza/contracts';
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
  it('unchecks a single permission and is inert when read-only', () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(<PermissionMatrix permissions={perms} value={['employee.view', 'audit.view']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'audit.view' }));
    expect(onChange).toHaveBeenLastCalledWith(['employee.view']);
    rerender(<PermissionMatrix permissions={perms} value={['employee.view']} onChange={onChange} readOnly />);
    expect(screen.getByRole('checkbox', { name: 'employee.view' })).toBeDisabled();
  });
});
