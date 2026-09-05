import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import SyncSection from './sync-section';

const current = { defaultIntervalMinutes: 5, adaptivePolling: true, offlineThresholdMinutes: 15, autoPushNewEmployees: true, reconciliationIntervalHours: 24, maxIntervalMinutes: 60, maxClockSkewMinutes: 60 };

describe('SyncSection', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({ '/orgs/org-1/settings/sync': { data: current } }); });

  it('validates against organizationSettingsSchema.shape.sync and PUTs the whole group with numbers', async () => {
    apiMock.put.mockResolvedValue({ data: { ...current, defaultIntervalMinutes: 10 } });
    renderWithProviders(<SyncSection />);
    const interval = await screen.findByLabelText(/Default poll interval/);
    expect(interval).toHaveValue(5);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled(); // nothing dirty yet

    fireEvent.change(interval, { target: { value: '0' } });
    fireEvent.click(save);
    await screen.findByText(/>=1/);
    expect(apiMock.put).not.toHaveBeenCalled();

    fireEvent.change(interval, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('switch', { name: /Adaptive polling/ }));
    fireEvent.click(save);
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/settings/sync', { ...current, defaultIntervalMinutes: 10, adaptivePolling: false });
  });

  it('is read-only without organization.manage', async () => {
    grant('organization.view');
    renderWithProviders(<SyncSection />);
    expect(await screen.findByLabelText(/Default poll interval/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
