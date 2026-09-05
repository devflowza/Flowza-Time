import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);

import { apiMock, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { GlobalSearchDialog } from './global-search';

describe('GlobalSearchDialog', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('opens with Ctrl+K, shows grouped results and navigates on Enter', async () => {
    mockGet({ '/orgs/org-1/search': (q) => ({ data: { q: String(q?.['q']), employees: [{ type: 'employee', id: 'e1', title: 'Ali Said', subtitle: '1001', branchId: 'b1', status: 'active' }], devices: [{ type: 'device', id: 'd1', title: 'Gate 1', subtitle: 'GATE1 · SN123', branchId: 'b1', status: 'online' }], branches: [], departments: [] } }) });
    renderWithProviders(<GlobalSearchDialog />, { route: '/' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog');
    const input = screen.getByPlaceholderText(/Search by name/);
    fireEvent.change(input, { target: { value: 'ali' } });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/search', { q: 'ali' }));
    expect(await screen.findByText('Ali Said')).toBeInTheDocument();
    expect(screen.getByText('Gate 1')).toBeInTheDocument();
    expect(screen.getByText('Employees')).toBeInTheDocument();
    expect(screen.getByText('Devices')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/employees/e1'));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it('shows an empty state when nothing matches', async () => {
    mockGet({ '/orgs/org-1/search': { data: { q: 'zzz', employees: [], devices: [], branches: [], departments: [] } } });
    renderWithProviders(<GlobalSearchDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Search by name/), { target: { value: 'zzz' } });
    expect(await screen.findByText(/Nothing found for/)).toBeInTheDocument();
  });
});
