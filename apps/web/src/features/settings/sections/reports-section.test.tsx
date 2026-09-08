import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import ReportsSection from './reports-section';

const current = { hoursNotation: 'h.mm', codeOverrides: {}, defaultFormat: 'pdf', showLegend: true };

describe('ReportsSection', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({ '/orgs/org-1/settings/reports': { data: current } }); });

  it('shows the defaults as placeholders and PUTs only the overrides that were filled in', async () => {
    apiMock.put.mockResolvedValue({ data: { ...current, showLegend: false, codeOverrides: { PRESENT: 'P' } } });
    renderWithProviders(<ReportsSection />);
    const present = await screen.findByLabelText(/^Present/);
    expect(present).toHaveAttribute('placeholder', 'PR');
    expect(screen.getByRole('combobox', { name: /Hours notation/ })).toHaveTextContent('9.45');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    fireEvent.change(present, { target: { value: 'P' } });
    fireEvent.change(screen.getByLabelText(/^Absent/), { target: { value: '' } }); // blank = keep the default, must not be sent
    fireEvent.click(screen.getByRole('switch', { name: /legend/ }));
    fireEvent.click(save);
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/reports', { hoursNotation: 'h.mm', defaultFormat: 'pdf', showLegend: false, codeOverrides: { PRESENT: 'P' } });
  });

  it('is read-only without organization.manage', async () => {
    grant('organization.view');
    renderWithProviders(<ReportsSection />);
    expect(await screen.findByLabelText(/^Present/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
