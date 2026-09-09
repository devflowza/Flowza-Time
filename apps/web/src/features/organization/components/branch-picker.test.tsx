import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { BranchPicker } from './branch-picker';

const MUSCAT = { id: 'b1', organizationId: 'org-1', code: 'MCT', name: 'Muscat HQ', countryCode: 'OM', timezone: 'Asia/Muscat', status: 'active' };
const onChange = vi.fn();

function Harness() {
  const [value, setValue] = useState<string | null>(null);
  return <BranchPicker value={value} onChange={(v, b) => { onChange(v, b); setValue(v); }} />;
}

const open = () => fireEvent.click(screen.getByRole('combobox'));

describe('BranchPicker', () => {
  beforeEach(() => { resetApiMock(); grantAll(); onChange.mockReset(); });

  /** A tenant on its first day has no branches, and both "new employee" and "new device" require one. */
  it('creates the first branch from inside the picker and selects it', async () => {
    mockGet({ '/orgs/org-1/branches': page([]) });
    apiMock.post.mockResolvedValue({ data: { ...MUSCAT } });
    renderWithProviders(<Harness />);

    open();
    expect(await screen.findByText('No branches yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Add branch/ }));
    expect(await screen.findByRole('heading', { name: 'Add branch' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'MCT' } });
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Muscat HQ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/branches', expect.objectContaining({ code: 'MCT', name: 'Muscat HQ' })));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('b1', expect.objectContaining({ id: 'b1', timezone: 'Asia/Muscat' })));
    // Selected straight away: the list refetch is still in flight, so the new branch is held locally until it lands.
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Muscat HQ'));
  });

  it('still offers the create row when branches exist, and hands the chosen branch to the caller', async () => {
    mockGet({ '/orgs/org-1/branches': page([MUSCAT]) });
    renderWithProviders(<Harness />);

    open();
    fireEvent.click((await screen.findByText('Muscat HQ')).closest('[cmdk-item]') ?? screen.getByText('Muscat HQ'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('b1', expect.objectContaining({ code: 'MCT' })));

    open();
    expect(await screen.findByRole('button', { name: /Add branch/ })).toBeInTheDocument();
  });

  /** Creating a branch in a hurry means typos; leaving the form to fix one costs everything typed so far. */
  it('edits the selected branch in place, and only offers that once one is chosen', async () => {
    mockGet({ '/orgs/org-1/branches': page([MUSCAT]) });
    apiMock.patch.mockResolvedValue({ data: { ...MUSCAT, name: 'Muscat head office' } });
    renderWithProviders(<Harness />);

    open();
    // Nothing is selected yet, so there is nothing to edit.
    expect(await screen.findByRole('button', { name: /Add branch/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit Muscat HQ/ })).toBeNull();

    fireEvent.click((await screen.findByText('Muscat HQ')).closest('[cmdk-item]') ?? screen.getByText('Muscat HQ'));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Edit Muscat HQ/ }));

    expect(await screen.findByRole('heading', { name: 'Edit branch' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Code/)).toHaveValue('MCT'); // opens on the branch, not a blank form
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Muscat head office' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/branches/b1', expect.objectContaining({ name: 'Muscat head office' })));
  });

  it('tells a member who cannot manage branches where they come from, without offering the dialog', async () => {
    grant('branch.view');
    mockGet({ '/orgs/org-1/branches': page([]) });
    renderWithProviders(<Harness />);

    open();
    expect(await screen.findByText(/Ask an administrator/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add branch/ })).toBeNull();
  });
});
