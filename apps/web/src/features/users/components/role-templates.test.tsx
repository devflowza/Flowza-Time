import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { PERMISSIONS, ROLE_TEMPLATES, type Permission, type PermissionDto } from '@flowza/contracts';
import i18n from '@/lib/i18n';
import { apiMock, grant, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import RoleEditorPage from '../pages/role-editor-page';
import { templatePermissions } from '../role-template-permissions';

/** Employee Relations permissions (customer requirement) — role templates pre-fill the matrix of a NEW custom role. */
const catalogue: PermissionDto[] = PERMISSIONS.map((key, i) => ({ key, category: key.split('.')[0]!, description: key, sortOrder: i }));

describe('role templates', () => {
  beforeEach(async () => { resetApiMock(); await i18n.changeLanguage('en'); });

  it('every template names catalogue keys only, and Employee Relations holds the review / approval keys', () => {
    for (const tpl of Object.values(ROLE_TEMPLATES)) for (const p of tpl.permissions) expect([tpl.key, (PERMISSIONS as readonly string[]).includes(p)]).toEqual([tpl.key, true]);
    expect(ROLE_TEMPLATES.employee_relations.permissions).toEqual(expect.arrayContaining(['employee.view', 'attendance.view', 'attendance.review_notes', 'attendance.correct', 'attendance.approve', 'attendance.request_correction', 'leave.view', 'leave.approve', 'report.view', 'report.export', 'approval.delegate', 'holiday.view', 'shift.view', 'dashboard.view']));
    // never anything that changes people, structure, roles or settings
    expect(ROLE_TEMPLATES.employee_relations.permissions.filter((p) => /\.(manage|create|delete|update)$/.test(p))).toEqual([]);
    expect(ROLE_TEMPLATES.hr_viewer.permissions.filter((p) => !/\.view$/.test(p))).toEqual([]);
    expect(ROLE_TEMPLATES.line_manager.permissions).toEqual(expect.arrayContaining(['employee.view_team', 'attendance.view_team', 'leave.view_team']));
    expect(ROLE_TEMPLATES.line_manager.permissions).not.toContain('employee.view');
  });

  it('keeps only the keys the creator holds', () => {
    const held = new Set<string>(['employee.view', 'attendance.view']);
    const out = templatePermissions('employee_relations', held, new Set(PERMISSIONS));
    expect(out.permissions).toEqual(['employee.view', 'attendance.view']);
    expect(out.skipped).toBe(ROLE_TEMPLATES.employee_relations.permissions.length - 2);
  });

  it('pre-fills the new role (name, key, matrix) from the template, leaving out keys the creator does not hold', async () => {
    // the creator holds everything but report.export
    const held = PERMISSIONS.filter((p) => p !== 'report.export') as Permission[];
    grant(...held);
    mockGet({ '/orgs/org-1/roles': { data: [] }, '/permissions': { data: catalogue } });
    apiMock.post.mockResolvedValue({ data: { id: 'role-9', name: 'Employee Relations' } });
    renderWithProviders(<RoleEditorPage />, { route: '/users/roles/new', path: '/users/roles/:id' });
    fireEvent.click(await screen.findByRole('radio', { name: /^Employee Relations/ }));
    expect(screen.getByRole('radio', { name: /^Employee Relations/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Employee Relations');
    expect(screen.getByLabelText(/^Key/)).toHaveValue('employee_relations');
    expect(screen.getByRole('checkbox', { name: 'attendance.review_notes' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'leave.approve' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'employee.update' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^report\.export/ })).not.toBeChecked();
    expect(screen.getByText('1 permissions of the template are not in your own role and were left out.')).toBeInTheDocument();
    // the creator can still adjust the matrix before saving
    fireEvent.click(screen.getByRole('checkbox', { name: 'employee.view_team' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0]! as [string, { key: string; name: string; permissions: string[] }];
    expect(path).toBe('/orgs/org-1/roles');
    expect(body.key).toBe('employee_relations');
    expect([...body.permissions].sort()).toEqual([...ROLE_TEMPLATES.employee_relations.permissions.filter((p) => p !== 'report.export'), 'employee.view_team'].sort());
  });

  it('switching back to Blank clears the matrix; a typed name is kept', async () => {
    grant(...(PERMISSIONS as readonly Permission[]));
    mockGet({ '/orgs/org-1/roles': { data: [] }, '/permissions': { data: catalogue } });
    renderWithProviders(<RoleEditorPage />, { route: '/users/roles/new', path: '/users/roles/:id' });
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'ER desk' } });
    fireEvent.click(screen.getByRole('radio', { name: /^HR viewer/ }));
    expect(screen.getByLabelText(/^Name/)).toHaveValue('ER desk');
    expect(screen.getByRole('checkbox', { name: 'organization.view' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Blank' }));
    expect(screen.getByRole('checkbox', { name: 'organization.view' })).not.toBeChecked();
  });

  it('names the templates in Arabic', async () => {
    grant(...(PERMISSIONS as readonly Permission[]));
    mockGet({ '/orgs/org-1/roles': { data: [] }, '/permissions': { data: catalogue } });
    await i18n.changeLanguage('ar');
    renderWithProviders(<RoleEditorPage />, { route: '/users/roles/new', path: '/users/roles/:id' });
    expect(await screen.findByRole('radio', { name: /^علاقات الموظفين/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^المدير المباشر/ })).toBeInTheDocument();
    await i18n.changeLanguage('en');
  });
});
