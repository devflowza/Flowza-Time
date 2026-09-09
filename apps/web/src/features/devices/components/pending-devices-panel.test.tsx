import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { PendingDeviceDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/devices.json';
import ar from '@/locales/ar/devices.json';
import enSync from '@/locales/en/sync.json';
import arSync from '@/locales/ar/sync.json';
import { PendingDevicesPanel } from './pending-devices-panel';

registerNamespace('devices', en, ar);
registerNamespace('sync', enSync, arSync);

const pending: PendingDeviceDto = {
  id: 'p1', organizationId: 'org-1', serialNumber: 'ZK-99887766', providerKey: 'zkteco', claimCode: '482913',
  deviceInfo: { model: 'K40' }, remoteIp: '10.0.0.5', firstSeenAt: '2026-09-01T06:00:00Z', lastSeenAt: '2026-09-01T07:00:00Z', claimedDeviceId: null,
};

describe('PendingDevicesPanel', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  /** A zero-touch terminal is often the first thing a new customer connects — before any branch exists. */
  it('offers to create a branch from the claim dialog when the organisation has none', async () => {
    mockGet({ '/orgs/org-1/devices/pending': { data: [pending] }, '/orgs/org-1/branches': page([]) });
    renderWithProviders(<PendingDevicesPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Claim' }));
    expect(await screen.findByRole('heading', { name: /Claim/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox', { name: /Branch/ }));
    expect(await screen.findByText('No branches yet')).toBeInTheDocument();
    // The branch dialog opens on top of the claim dialog, so the claim in progress is not lost. Radix hides the
    // dialog underneath from the accessibility tree while the one above is open, hence the DOM query.
    fireEvent.click(screen.getByRole('button', { name: /Add branch/ }));
    const dialog = await screen.findByRole('dialog', { name: /Add branch/ });
    expect(within(dialog).getByLabelText(/^Code/)).toBeInTheDocument();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  });
});
