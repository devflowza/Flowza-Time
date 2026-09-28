import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/approvals.json';
import ar from '@/locales/ar/approvals.json';
import { WorkflowDialog } from './workflow-dialog';
import type { WorkflowDto } from '../api';

registerNamespace('approvals', en, ar);

const pick = async (trigger: HTMLElement, option: string) => {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
};

describe('WorkflowDialog v2', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    mockGet({ '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/roles': { data: [] }, '/orgs/org-1/members': page([]) });
    apiMock.post.mockImplementation(async (_path: string, body: unknown) => ({ data: { id: 'w1', ...(body as object) } }));
  });

  it('builds a manager-chain level with a quorum level escalating to HR, and posts the v2 step shape', async () => {
    renderWithProviders(<WorkflowDialog open onOpenChange={() => {}} workflow={null} />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Name/), { target: { value: 'Leave: chain then HR' } });
    await pick(within(dialog).getByLabelText('Request type'), 'Leave');
    fireEvent.change(within(dialog).getByLabelText(/From \(units\)/), { target: { value: '3' } });
    // level 1: manager chain, 2 levels up
    await pick(within(within(dialog).getByTestId('wf-step-0')).getByLabelText('Approver'), 'Manager chain');
    fireEvent.change(within(dialog).getByLabelText('Levels up'), { target: { value: '2' } });
    // level 2: HR admins, 2 of them must approve, escalate to the owner after 24 h
    fireEvent.click(within(dialog).getByRole('button', { name: /Add level/ }));
    const second = within(dialog).getByTestId('wf-step-1');
    await pick(within(second).getByLabelText('Decision'), 'A number of them');
    fireEvent.change(within(second).getByLabelText('Approvals needed'), { target: { value: '2' } });
    await pick(within(second).getByLabelText('Escalate'), 'The owner');
    fireEvent.change(within(second).getByLabelText('After (hours)'), { target: { value: '24' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    const [path, body] = apiMock.post.mock.calls[0]! as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/approval-workflows');
    expect(body).toMatchObject({ name: 'Leave: chain then HR', entityType: 'LEAVE', minUnits: 3, isDefault: true, appliesTo: {} });
    expect(body).not.toHaveProperty('allowSelfApproval');
    expect(body['steps']).toEqual([
      { order: 1, approverType: 'MANAGER_CHAIN', chainLevel: 2, mode: 'ANY' },
      { order: 2, approverType: 'HR_ADMIN', mode: 'QUORUM', requiredCount: 2, escalateTo: 'OWNER', escalateAfterHours: 24 },
    ]);
  });

  it('P0-3 a ROLE level resolves by permission by default, and the editor offers no self-approval switch', async () => {
    const existing: WorkflowDto = { id: 'w9', organizationId: 'org-1', entityType: 'ATTENDANCE_CORRECTION', name: 'Approvers', branchId: null, steps: [{ order: 1, approverType: 'ROLE', permission: 'attendance.approve', mode: 'ANY' }], appliesTo: {}, minUnits: null, allowSelfApproval: false, isDefault: true, status: 'active', createdAt: '', updatedAt: '' };
    apiMock.patch.mockImplementation(async (_path: string, body: unknown) => ({ data: { ...existing, ...(body as object) } }));
    renderWithProviders(<WorkflowDialog open onOpenChange={() => {}} workflow={existing} />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Permission' })).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByText('attendance.approve')).toBeInTheDocument();
    expect(within(dialog).queryByRole('switch', { name: /self-approval/i })).toBeNull();
    expect(within(dialog).getAllByRole('switch')).toHaveLength(1); // the active-routing switch only
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/approval-workflows/w9', expect.objectContaining({ steps: [{ order: 1, approverType: 'ROLE', permission: 'attendance.approve', mode: 'ANY' }] })));
    expect(apiMock.patch.mock.calls[0]![1]).not.toHaveProperty('allowSelfApproval');
  });

  it('P2-7 refuses a quorum above one on a single-seat approver type, with the reason under the field', async () => {
    renderWithProviders(<WorkflowDialog open onOpenChange={() => {}} workflow={null} />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Name/), { target: { value: 'Manager quorum' } });
    const first = within(dialog).getByTestId('wf-step-0'); // the manager (one person)
    await pick(within(first).getByLabelText('Decision'), 'A number of them');
    fireEvent.change(within(first).getByLabelText('Approvals needed'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(first).findByText('This approver type is one person: it cannot require more than 1 approval.')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
    // one approval is fine
    fireEvent.change(within(first).getByLabelText('Approvals needed'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    expect((apiMock.post.mock.calls[0]! as [string, { steps: unknown[] }])[1].steps).toEqual([{ order: 1, approverType: 'MANAGER', mode: 'QUORUM', requiredCount: 1 }]);
  });
});
