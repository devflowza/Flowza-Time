import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/approvals.json';
import ar from '@/locales/ar/approvals.json';
import settingsEn from '@/locales/en/settings.json';
import settingsAr from '@/locales/ar/settings.json';
import ApprovalsSection from './approvals-section';

registerNamespace('approvals', en, ar);
registerNamespace('settings', settingsEn, settingsAr);

const MEMBERS = { data: [{ userId: 'd0000000-0000-4000-8000-000000000001', fullName: 'Director General', email: 'dg@test.local' }], total: 1, page: 1, pageSize: 50 };

async function pick(label: RegExp, option: string) {
  fireEvent.keyDown(await screen.findByLabelText(label), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

describe('Settings → Approvals', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('shows the defaults: line manager, secondary manager as backup, next manager up, HR admins for the top', async () => {
    mockGet({ '/orgs/org-1/settings/approvals': { data: {} }, '/orgs/org-1/members': MEMBERS });
    renderWithProviders(<ApprovalsSection />);
    expect(await screen.findByLabelText(/without a workflow go to/)).toHaveTextContent("The requester's line manager");
    expect(screen.getByLabelText(/^Secondary manager/)).toHaveTextContent('Backup only');
    expect(screen.getByLabelText(/When neither manager can act/)).toHaveTextContent('The next manager up the reporting line');
    expect(screen.getByLabelText(/Requests from the top of the organisation/)).toHaveTextContent('HR admins');
    expect(screen.queryByLabelText(/^Approver/)).not.toBeInTheDocument();
  });

  it('saves a named top-level approver, and refuses the choice without one', async () => {
    mockGet({ '/orgs/org-1/settings/approvals': { data: {} }, '/orgs/org-1/members': MEMBERS });
    apiMock.put.mockResolvedValue({ data: {} });
    renderWithProviders(<ApprovalsSection />);
    await pick(/Requests from the top of the organisation/, 'A named approver');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose the approver.')).toBeInTheDocument();
    expect(apiMock.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/^Approver/));
    fireEvent.click((await screen.findByText('Director General')).closest('[cmdk-item]') ?? screen.getByText('Director General'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/approvals', { defaultRouting: 'line_manager', secondaryManager: 'backup', managerUnavailable: 'next_level_manager', topLevel: 'named_user', topLevelUserId: 'd0000000-0000-4000-8000-000000000001' }));
  });

  it('keeps HR routing and the secondary manager alongside when chosen; drops a stale named approver', async () => {
    mockGet({ '/orgs/org-1/settings/approvals': { data: { topLevel: 'hr_admins', topLevelUserId: 'd0000000-0000-4000-8000-000000000001' } }, '/orgs/org-1/members': MEMBERS });
    apiMock.put.mockResolvedValue({ data: {} });
    renderWithProviders(<ApprovalsSection />);
    await pick(/without a workflow go to/, 'Everybody who holds the approve permission (HR)');
    await pick(/^Secondary manager/, 'Decides alongside the line manager on every request');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/approvals', { defaultRouting: 'permission_holders', secondaryManager: 'alongside', managerUnavailable: 'next_level_manager', topLevel: 'hr_admins', topLevelUserId: null }));
  });

  it('is read-only without organization.manage', async () => {
    grant('organization.view');
    mockGet({ '/orgs/org-1/settings/approvals': { data: {} }, '/orgs/org-1/members': MEMBERS });
    renderWithProviders(<ApprovalsSection />);
    expect(await screen.findByLabelText(/without a workflow go to/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
