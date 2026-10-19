import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { useUiStore } from '@/stores/ui-store';
import DashboardSection from './dashboard-section';

const saved = { theme: 'emerald', layout: 'overview', trendDays: 14, showGreeting: true, showQuote: true, showHighlight: true };

describe('DashboardSection', () => {
  beforeEach(() => { resetApiMock(); grantAll(); useUiStore.getState().setPreviewDashboardTheme(null); mockGet({ '/orgs/org-1/settings/dashboard': { data: saved } }); });

  it('offers every style and layout, previews the highlighted style live and PUTs the whole group on save', async () => {
    apiMock.put.mockResolvedValue({ data: { ...saved, theme: 'midnight', layout: 'executive' } });
    const { unmount } = renderWithProviders(<DashboardSection />);
    const green = await screen.findByRole('radio', { name: /FlowZa Green/ });
    expect(green).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(7 + 3);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    // the saved style is on preview as soon as the form opens, so leaving the page never flashes a different look
    expect(useUiStore.getState().previewDashboardTheme).toBe('emerald');

    fireEvent.click(screen.getByRole('radio', { name: /Midnight Indigo/ }));
    expect(screen.getByRole('radio', { name: /Midnight Indigo/ })).toBeChecked();
    expect(useUiStore.getState().previewDashboardTheme).toBe('midnight');
    expect(screen.getByText(/Previewing “Midnight Indigo”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Executive/ }));
    fireEvent.click(save);
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/dashboard', { theme: 'midnight', layout: 'executive', trendDays: 14, showGreeting: true, showQuote: true, showHighlight: true, showDepartmentBreakdown: true, showMonthToDate: true });

    unmount();
    expect(useUiStore.getState().previewDashboardTheme).toBeNull();
  });

  it('is one tab stop: the arrow keys move the selection through the gallery, and reset returns to the saved style', async () => {
    renderWithProviders(<DashboardSection />);
    const green = await screen.findByRole('radio', { name: /FlowZa Green/ });
    expect(green).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: /Midnight Indigo/ })).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(green, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: /Midnight Indigo/ })).toBeChecked();
    fireEvent.keyDown(screen.getByRole('radio', { name: /Midnight Indigo/ }), { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: /FlowZa Green/ })).toBeChecked();
    fireEvent.keyDown(screen.getByRole('radio', { name: /FlowZa Green/ }), { key: 'ArrowUp' });
    expect(screen.getByRole('radio', { name: /Crimson/ })).toBeChecked(); // wraps around
    fireEvent.click(screen.getByRole('button', { name: /Reset preview/ }));
    expect(screen.getByRole('radio', { name: /FlowZa Green/ })).toBeChecked();
    expect(screen.queryByText(/Previewing/)).not.toBeInTheDocument();
  });

  it('is read-only without organization.manage and never previews', async () => {
    grant('organization.view');
    renderWithProviders(<DashboardSection />);
    const midnight = await screen.findByRole('radio', { name: /Midnight Indigo/ });
    expect(midnight).toBeDisabled();
    fireEvent.click(midnight);
    expect(midnight).not.toBeChecked();
    expect(useUiStore.getState().previewDashboardTheme).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only administrators/)).toBeInTheDocument();
  });
});

describe('DashboardSection — statistics widgets (2026-10-19)', () => {
  beforeEach(() => { resetApiMock(); grantAll(); useUiStore.getState().setPreviewDashboardTheme(null); });

  it('shows both widgets for a group saved before they existed, and saves them off with the rest of the group', async () => {
    mockGet({ '/orgs/org-1/settings/dashboard': { data: saved } });
    apiMock.put.mockResolvedValue({ data: { ...saved, showDepartmentBreakdown: false, showMonthToDate: true } });
    renderWithProviders(<DashboardSection />);
    const departments = await screen.findByRole('switch', { name: 'Attendance by department' });
    const mtd = screen.getByRole('switch', { name: 'Month-to-date indicators' });
    expect(departments).toBeChecked();
    expect(mtd).toBeChecked();
    fireEvent.click(departments);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/dashboard', { ...saved, showDepartmentBreakdown: false, showMonthToDate: true });
  });

  it('keeps a stored choice', async () => {
    mockGet({ '/orgs/org-1/settings/dashboard': { data: { ...saved, showMonthToDate: false } } });
    renderWithProviders(<DashboardSection />);
    expect(await screen.findByRole('switch', { name: 'Month-to-date indicators' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Attendance by department' })).toBeChecked();
  });
});
