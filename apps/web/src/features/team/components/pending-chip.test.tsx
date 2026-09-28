import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import i18n from '@/lib/i18n';
import { apiMock, grant, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import { PendingChip } from './pending-chip';

describe('PendingChip (the second count next to the bell, Finance B-63)', () => {
  beforeEach(() => { resetApiMock(); testState.employeeId = 'e4'; testState.teamSize = 0; testState.approvals = { actionable: 0, delegatedToMe: false }; });

  it('shows a line manager team/pending-counts.total, split in its label, and takes them to their team queue (B-66)', async () => {
    testState.teamSize = 2;
    grant('dashboard.view', 'employee.view_team', 'attendance.view_team');
    mockGet({ '/orgs/org-1/team/pending-counts': { data: { approvals: 2, notes: 3, total: 5 } } });
    renderWithProviders(<PendingChip />);
    const chip = await screen.findByTestId('pending-chip');
    expect(chip).toHaveTextContent('5');
    expect(chip).toHaveAttribute('href', '/team?tab=approvals');
    expect(chip).toHaveAccessibleName('5 items waiting for you · 2 approval requests · 3 attendance reasons');
  });

  it('takes an approver to the inbox, and refetches when the window regains focus', async () => {
    grant('dashboard.view', 'leave.approve');
    mockGet({ '/orgs/org-1/team/pending-counts': { data: { approvals: 1, notes: 0, total: 1 } } });
    renderWithProviders(<PendingChip />);
    expect(await screen.findByTestId('pending-chip')).toHaveAttribute('href', '/approvals');
    const calls = () => apiMock.get.mock.calls.filter((c) => c[0] === '/orgs/org-1/team/pending-counts').length;
    const before = calls();
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await waitFor(() => expect(calls()).toBeGreaterThan(before));
    focusManager.setFocused(undefined);
  });

  it('shows nothing while nothing waits, and never asks for a member who neither manages nor approves', async () => {
    grant('dashboard.view', 'leave.approve');
    mockGet({ '/orgs/org-1/team/pending-counts': { data: { approvals: 0, notes: 0, total: 0 } } });
    const r = renderWithProviders(<PendingChip />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(screen.queryByTestId('pending-chip')).not.toBeInTheDocument();
    r.unmount();
    resetApiMock();
    grant('dashboard.view');
    renderWithProviders(<PendingChip />);
    expect(screen.queryByTestId('pending-chip')).not.toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it('5-P2-6 the breakdown is pluralised in English and Arabic, and a half that is zero is left out', async () => {
    grant('dashboard.view', 'leave.approve');
    mockGet({ '/orgs/org-1/team/pending-counts': { data: { approvals: 1, notes: 0, total: 1 } } });
    const one = renderWithProviders(<PendingChip />);
    expect(await screen.findByTestId('pending-chip')).toHaveAccessibleName('1 item waiting for you · 1 approval request');
    one.unmount();
    mockGet({ '/orgs/org-1/team/pending-counts': { data: { approvals: 0, notes: 1, total: 1 } } });
    const note = renderWithProviders(<PendingChip />);
    expect(await screen.findByTestId('pending-chip')).toHaveAccessibleName('1 item waiting for you · 1 attendance reason');
    note.unmount();
    await i18n.changeLanguage('ar');
    try {
      mockGet({ '/orgs/org-1/team/pending-counts': { data: { approvals: 2, notes: 0, total: 2 } } });
      const two = renderWithProviders(<PendingChip />);
      expect(await screen.findByTestId('pending-chip')).toHaveAccessibleName('عنصران بانتظارك · طلبا موافقة');
      two.unmount();
      mockGet({ '/orgs/org-1/team/pending-counts': { data: { approvals: 1, notes: 3, total: 4 } } });
      renderWithProviders(<PendingChip />);
      expect(await screen.findByTestId('pending-chip')).toHaveAccessibleName('4 عناصر بانتظارك · طلب موافقة واحد · 3 مبررات حضور');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
