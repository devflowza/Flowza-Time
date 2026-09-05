import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { BranchDialog } from './branch-dialog';

describe('BranchDialog', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({}); });

  it('validates with branchInputSchema and posts numeric coordinates + inherited weekly-off days', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'b1' } });
    const onOpenChange = vi.fn();
    renderWithProviders(<BranchDialog open onOpenChange={onOpenChange} branch={null} orgTimezone="Asia/Muscat" />);

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2)); // code + name required
    expect(apiMock.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'MCT' } });
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Muscat HQ' } });
    fireEvent.change(screen.getByLabelText(/Latitude/), { target: { value: '23.588' } });
    fireEvent.change(screen.getByLabelText(/Longitude/), { target: { value: '58.3829' } });
    fireEvent.change(screen.getByLabelText(/Geofence/), { target: { value: '5' } }); // below the 10 m minimum
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText(/>=10/);
    expect(apiMock.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Geofence/), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/branches');
    expect(body).toMatchObject({ code: 'MCT', name: 'Muscat HQ', timezone: 'Asia/Muscat', countryCode: 'OM', latitude: 23.588, longitude: 58.3829, geofenceRadiusM: 150, weeklyOffDays: null, status: 'active' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('lets a branch override the weekly off days', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'b1' } });
    renderWithProviders(<BranchDialog open onOpenChange={() => {}} branch={null} orgTimezone="Asia/Dubai" />);
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'DXB' } });
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Dubai' } });
    fireEvent.click(screen.getByRole('switch', { name: /Use organisation weekly off days/ }));
    const group = await screen.findByRole('group', { name: 'Weekly off days' });
    expect(group).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sun' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fri' })); // untoggle default Fri
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    expect((apiMock.post.mock.calls[0] as [string, { weeklyOffDays: number[]; timezone: string }])[1]).toMatchObject({ weeklyOffDays: [0, 6], timezone: 'Asia/Dubai' });
  });
});
