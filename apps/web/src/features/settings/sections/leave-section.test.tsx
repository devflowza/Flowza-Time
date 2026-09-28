import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/leave.json';
import ar from '@/locales/ar/leave.json';
import LeaveSection from './leave-section';

registerNamespace('leave', en, ar);

describe('Settings → Leave', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('shows the default comp-off expiry (90 days) and saves a new one', async () => {
    mockGet({ '/orgs/org-1/settings/leave': { data: {} } });
    apiMock.put.mockResolvedValue({ data: { compOffExpiryDays: 45 } });
    renderWithProviders(<LeaveSection />);
    const input = await screen.findByLabelText(/Comp-off credits expire after/);
    expect(input).toHaveValue(90);
    fireEvent.change(input, { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/leave', { compOffExpiryDays: 45 }));
  });

  it('refuses a value outside 1–365', async () => {
    mockGet({ '/orgs/org-1/settings/leave': { data: { compOffExpiryDays: 60 } } });
    renderWithProviders(<LeaveSection />);
    const input = await screen.findByLabelText(/Comp-off credits expire after/);
    expect(input).toHaveValue(60);
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'));
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('is read-only without organization.manage', async () => {
    grant('organization.view');
    mockGet({ '/orgs/org-1/settings/leave': { data: { compOffExpiryDays: 60 } } });
    renderWithProviders(<LeaveSection />);
    expect(await screen.findByLabelText(/Comp-off credits expire after/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
