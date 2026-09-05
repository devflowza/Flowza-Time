import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/schedule.json';
import ar from '@/locales/ar/schedule.json';
import { ShiftDialog } from './shift-dialog';

registerNamespace('schedule', en, ar);

describe('ShiftDialog', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({}); });

  it('switches FIXED ↔ FLEXIBLE fields, validates with shiftInputSchema and posts the right shape', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 's1' } });
    const onOpenChange = vi.fn();
    renderWithProviders(<ShiftDialog open onOpenChange={onOpenChange} shift={null} />);

    // FIXED by default: start/end visible, required minutes hidden
    expect(screen.getByLabelText(/Start time/)).toHaveValue('09:00');
    expect(screen.queryByLabelText(/Required minutes/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'MORN' } });
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Morning' } });
    fireEvent.change(screen.getByLabelText(/Start time/), { target: { value: '' } }); // fixed shift without a start time
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('Fixed shifts need start and end time');
    expect(apiMock.post).not.toHaveBeenCalled();

    // switch to FLEXIBLE: required minutes + core hours appear, start/end disappear
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Type/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Flexible' }));
    expect(screen.queryByLabelText(/Start time/)).not.toBeInTheDocument();
    const required = await screen.findByLabelText(/Required minutes/);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('Flexible shifts need required minutes');

    fireEvent.change(required, { target: { value: '480' } });
    fireEvent.change(screen.getByLabelText(/Core hours from/), { target: { value: '10:00' } });
    fireEvent.change(screen.getByLabelText(/Core hours to/), { target: { value: '14:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add break' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/shifts');
    expect(body).toMatchObject({ code: 'MORN', name: 'Morning', type: 'FLEXIBLE', requiredMinutes: 480, coreStart: '10:00', coreEnd: '14:00', dayBoundary: '04:00', punchInWindowBeforeMinutes: 240, punchOutWindowAfterMinutes: 360, graceInMinutes: null, breaks: [{ start: '12:00', end: '13:00', paid: false }], status: 'active' });
    expect(body['startTime']).toBeUndefined(); // FIXED-only fields are cleared for FLEXIBLE
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('edits an existing shift with PATCH and a disabled code field', async () => {
    apiMock.patch.mockResolvedValue({ data: { id: 's1' } });
    const shift = { id: 's1', code: 'NIGHT', name: 'Night', nameAr: null, type: 'FIXED', startTime: '22:00', endTime: '06:00', requiredMinutes: null, coreStart: null, coreEnd: null, dayBoundary: '12:00', breaks: [{ minutes: 30, paid: true }], punchInWindowBeforeMinutes: 120, punchOutWindowAfterMinutes: 180, graceInMinutes: 5, graceOutMinutes: null, color: '#175cd3', status: 'active', crossesMidnight: true, createdAt: '', updatedAt: '' };
    renderWithProviders(<ShiftDialog open onOpenChange={() => {}} shift={shift} />);
    expect(screen.getByLabelText(/^Code/)).toBeDisabled();
    expect(screen.getByLabelText(/End time/)).toHaveValue('06:00');
    expect(screen.getByLabelText(/Minutes/)).toHaveValue(30); // duration break
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Night shift' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/shifts/s1', expect.objectContaining({ name: 'Night shift', type: 'FIXED', startTime: '22:00', endTime: '06:00', graceInMinutes: 5, breaks: [{ minutes: 30, paid: true }] })));
  });
});
