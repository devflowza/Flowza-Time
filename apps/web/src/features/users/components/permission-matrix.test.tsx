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
  it('unchecks a single permission and is inert when read-only', () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(<PermissionMatrix permissions={perms} value={['employee.view', 'audit.view']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'audit.view' }));
    expect(onChange).toHaveBeenLastCalledWith(['employee.view']);
    rerender(<PermissionMatrix permissions={perms} value={['employee.view']} onChange={onChange} readOnly />);
    expect(screen.getByRole('checkbox', { name: 'employee.view' })).toBeDisabled();
  });
});
