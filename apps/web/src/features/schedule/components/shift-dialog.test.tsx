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

    // FIXED by default: start/end visible; required time and the day boundary (FLEXIBLE only) hidden
    expect(screen.getByLabelText(/Start time/)).toHaveValue('09:00');
    expect(screen.queryByRole('spinbutton', { name: 'Required time – hours' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Day boundary/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'MORN' } });
    fireEvent.change(screen.getByLabelText(/^Name\*?$/), { target: { value: 'Morning' } });
    fireEvent.change(screen.getByLabelText(/Start time/), { target: { value: '' } }); // fixed shift without a start time
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('Fixed shifts need start and end time');
    expect(apiMock.post).not.toHaveBeenCalled();

    // switch to FLEXIBLE: required time + day boundary appear, start/end disappear; core hours stay off until switched on
    fireEvent.keyDown(screen.getByRole('combobox', { name: /Type/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Flexible' }));
    expect(screen.queryByLabelText(/Start time/)).not.toBeInTheDocument();
    const hours = await screen.findByRole('spinbutton', { name: 'Required time – hours' });
    expect(screen.queryByLabelText(/Core hours from/)).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Core hours' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('Flexible shifts need required minutes');

    fireEvent.change(hours, { target: { value: '8' } }); // 8 h → 480 required minutes
    fireEvent.click(screen.getByRole('switch', { name: 'Core hours' }));
    fireEvent.change(screen.getByLabelText(/Core hours from/), { target: { value: '10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('Enter both core times, or turn core hours off.'); // switched on = both times needed
    expect(apiMock.post).not.toHaveBeenCalled();
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

  it('explains the day boundary with a worked example that follows the chosen time', async () => {
    const shift = { id: 's2', code: 'FLEX', name: 'Flexible', nameAr: null, type: 'FLEXIBLE', startTime: null, endTime: null, requiredMinutes: 480, coreStart: null, coreEnd: null, dayBoundary: '04:00', breaks: [], punchInWindowBeforeMinutes: 240, punchOutWindowAfterMinutes: 360, graceInMinutes: null, graceOutMinutes: null, color: null, status: 'active', crossesMidnight: null, createdAt: '', updatedAt: '' };
    renderWithProviders(<ShiftDialog open onOpenChange={() => {}} shift={shift} />);
    const guide = screen.getByTestId('boundary-guide');
    expect(guide).toHaveTextContent("With 04:00, Monday's attendance day runs from Monday 04:00 to Tuesday 03:59.");
    expect(guide).toHaveTextContent('check in Monday 20:00, check out Tuesday 03:00 → both punches count for Monday');
    fireEvent.change(screen.getByLabelText(/Day boundary/), { target: { value: '00:00' } });
    await waitFor(() => expect(screen.getByTestId('boundary-guide')).toHaveTextContent('check out Tuesday 03:00 → counts for Tuesday. The night is split across two days.'));
  });

  it('clears saved core hours when they are switched off (PATCH sends null, not an omitted field)', async () => {
    apiMock.patch.mockResolvedValue({ data: { id: 's3' } });
    const shift = { id: 's3', code: 'EVE', name: 'Evening', nameAr: null, type: 'FLEXIBLE', startTime: null, endTime: null, requiredMinutes: 450, coreStart: '17:00', coreEnd: '04:00', dayBoundary: '04:00', breaks: [], punchInWindowBeforeMinutes: 240, punchOutWindowAfterMinutes: 360, graceInMinutes: null, graceOutMinutes: null, color: null, status: 'active', crossesMidnight: null, createdAt: '', updatedAt: '' };
    renderWithProviders(<ShiftDialog open onOpenChange={() => {}} shift={shift} />);
    expect(screen.getByRole('spinbutton', { name: 'Required time – hours' })).toHaveValue(7);
    expect(screen.getByRole('spinbutton', { name: 'Required time – minutes' })).toHaveValue(30);
    expect(screen.getByRole('switch', { name: 'Core hours' })).toBeChecked();
    expect(screen.getByLabelText(/Core hours from/)).toHaveValue('17:00');
    expect(screen.getByRole('status')).toHaveTextContent('The core hours (11h 00m) are longer than the required 7h 30m');

    fireEvent.click(screen.getByRole('switch', { name: 'Core hours' }));
    expect(screen.queryByLabelText(/Core hours from/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/shifts/s3', expect.objectContaining({ type: 'FLEXIBLE', requiredMinutes: 450, coreStart: null, coreEnd: null })));
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
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/orgs/org-1/shifts/s1', expect.objectContaining({ name: 'Night shift', type: 'FIXED', startTime: '22:00', endTime: '06:00', dayBoundary: '12:00', coreStart: null, coreEnd: null, graceInMinutes: 5, breaks: [{ minutes: 30, paid: true }] })));
  });
});
