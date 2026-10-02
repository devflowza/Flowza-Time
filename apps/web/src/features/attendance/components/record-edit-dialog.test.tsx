import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { ApiError } from '@/lib/api-client';
import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import type { AttendanceEngineOutcomeDto, AttendancePreviewDto } from '@flowza/contracts';
import { RecordEditDialog } from './record-edit-dialog';

const EMP = '11111111-1111-4111-8111-111111111111';
const outcome = (over: Partial<AttendanceEngineOutcomeDto> = {}): AttendanceEngineOutcomeDto => ({
  status: 'PRESENT', flags: ['LATE'], firstInAt: '2026-09-01T04:05:00Z', lastOutAt: '2026-09-01T13:10:00Z', workedMinutes: 545, breakMinutes: 0, lateMinutes: 5,
  earlyDepartureMinutes: 0, overtimeMinutes: 10, scheduledMinutes: 540, punchCount: 2, lopDays: 0, ...over,
});
const previewOf = (over: Partial<AttendancePreviewDto> = {}): AttendancePreviewDto => ({
  employeeId: EMP, employeeNumber: '1001', employeeName: 'Ali Hassan', date: '2026-09-01', timezone: 'Asia/Muscat', recordId: 'rec-1',
  shift: { id: 's1', code: 'DAY', name: 'Day shift', expectedStartAt: '2026-09-01T04:00:00Z', expectedEndAt: '2026-09-01T13:00:00Z', scheduledMinutes: 540 },
  current: outcome(), preview: outcome(), statusSource: 'AUTO', manualStatus: null,
  punches: { in: { eventId: 'ev-in', punchedAt: '2026-09-01T04:05:12Z' }, out: { eventId: 'ev-out', punchedAt: '2026-09-01T13:10:40Z' } },
  plan: [], pendingCorrections: 0, locked: false, ...over,
});

function mockPreview(base: AttendancePreviewDto) {
  apiMock.post.mockImplementation((path: string, body: Record<string, unknown>) => {
    if (path === '/orgs/org-1/attendance/preview') {
      if (!body['outAt'] && !body['inAt']) return Promise.resolve({ data: base });
      const outAt = body['outAt'] as string | undefined;
      return Promise.resolve({ data: { ...base, preview: outcome({ lastOutAt: outAt ?? base.current.lastOutAt, overtimeMinutes: 90, flags: ['LATE', 'OVERTIME'] }), plan: outAt ? [{ type: 'EDIT_PUNCH', originalEventId: 'ev-out', originalPunchedAt: '2026-09-01T13:10:40Z', proposedPunchedAt: outAt, proposedEventType: 'PUNCH_OUT', proposedStatus: null }] : [] } });
    }
    if (path === '/orgs/org-1/attendance/record-edits') return Promise.resolve({ data: { corrections: [{ id: 'c1', type: 'EDIT_PUNCH', status: 'APPLIED', approval: 'AUTO_APPROVED' }], applied: true, failed: null, unchanged: 0 } });
    return Promise.reject(new Error(`unexpected POST ${path}`));
  });
}
const editCalls = () => apiMock.post.mock.calls.filter(([p]) => p === '/orgs/org-1/attendance/record-edits');
const proposalCalls = () => apiMock.post.mock.calls.filter(([p, b]) => p === '/orgs/org-1/attendance/preview' && ((b as Record<string, unknown>)['inAt'] || (b as Record<string, unknown>)['outAt']));

// today's night shift (17:00 – 04:00 Asia/Muscat) with two punches this morning, opened at 12:00 the same day
const nightShiftToday = () => previewOf({
  shift: { id: 's2', code: 'NIGHT', name: 'Night shift', expectedStartAt: '2026-09-01T13:00:00Z', expectedEndAt: '2026-09-02T00:00:00Z', scheduledMinutes: 660 },
  current: outcome({ status: 'HALF_DAY', flags: ['EARLY_DEPARTURE'], firstInAt: '2026-09-01T07:03:00Z', lastOutAt: '2026-09-01T07:45:00Z', workedMinutes: 42, lateMinutes: 0, earlyDepartureMinutes: 975, overtimeMinutes: 0 }),
  preview: outcome({ status: 'HALF_DAY', flags: ['EARLY_DEPARTURE'], firstInAt: '2026-09-01T07:03:00Z', lastOutAt: '2026-09-01T07:45:00Z', workedMinutes: 42, lateMinutes: 0, earlyDepartureMinutes: 975, overtimeMinutes: 0 }),
  punches: { in: { eventId: 'ev-in', punchedAt: '2026-09-01T07:03:00Z' }, out: { eventId: 'ev-out', punchedAt: '2026-09-01T07:45:00Z' } },
});

describe('RecordEditDialog', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat'; mockGet({ '/orgs/org-1/employees': page([]) }); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the expected shift, previews the policy outcome, refuses check-out before check-in and requires a reason', async () => {
    mockPreview(previewOf());
    renderWithProviders(<RecordEditDialog open onOpenChange={() => {}} preset={{ employeeId: EMP, employeeName: 'Ali Hassan', date: '2026-09-01' }} />);
    const shift = await screen.findByTestId('expected-shift');
    expect(shift).toHaveTextContent('Day shift');
    expect(shift).toHaveTextContent('08:00 – 17:00');
    const checkIn = screen.getByLabelText('Check-in') as HTMLInputElement;
    const checkOut = screen.getByLabelText('Check-out') as HTMLInputElement;
    await waitFor(() => expect(checkIn.value).toBe('08:05'));
    expect(checkOut.value).toBe('17:10');
    expect(within(screen.getByTestId('outcome-now')).getByText('Present')).toBeInTheDocument();

    // out before in: refused client-side, nothing previewed or filed
    fireEvent.change(checkOut, { target: { value: '07:00' } });
    expect(await screen.findByText('Check-out must be after check-in.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
    expect(editCalls()).toHaveLength(0);

    // a later check-out: the engine preview shows the overtime, and the plan moves the OUT punch only
    fireEvent.change(checkOut, { target: { value: '18:30' } });
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/attendance/preview', { employeeId: EMP, date: '2026-09-01', outAt: '2026-09-01T14:30:00Z' }));
    const plan = await screen.findByTestId('edit-plan');
    expect(plan).toHaveTextContent('Move punch');
    expect(plan).toHaveTextContent('18:30');
    expect(within(screen.getByTestId('outcome-after')).getByText('1h 30m')).toBeInTheDocument();

    // reason required
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
    expect(await screen.findByText('Give a reason (at least 3 characters).')).toBeInTheDocument();
    expect(editCalls()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Stayed for stock count' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    const [, body, opts] = editCalls()[0] as [string, Record<string, unknown>, Record<string, unknown>];
    // only the changed time is sent — the untouched check-in stays as recorded (no EDIT_PUNCH for it)
    expect(body).toEqual({ employeeId: EMP, date: '2026-09-01', reason: 'Stayed for stock count', outAt: '2026-09-01T14:30:00Z' });
    expect(opts).toMatchObject({ idempotencyKey: expect.any(String) });
  });

  it('files a manual status on its own, and says what it will do', async () => {
    mockPreview(previewOf());
    renderWithProviders(<RecordEditDialog open onOpenChange={() => {}} preset={{ employeeId: EMP, employeeName: 'Ali Hassan', date: '2026-09-01' }} />);
    await screen.findByTestId('expected-shift');
    expect(screen.getByTestId('status-source-AUTO')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
    expect(await screen.findByText('Change the check-in, the check-out or the status first.')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Status' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Absent' }));
    expect(await screen.findByTestId('edit-plan')).toHaveTextContent('Set status · Absent');
    expect(screen.getByTestId('status-source-MANUAL')).toBeInTheDocument();
    // the day after the change carries the picked status; the rules' own outcome stays on the "now" side
    expect(within(screen.getByTestId('outcome-after')).getByText('Absent')).toBeInTheDocument();
    expect(within(screen.getByTestId('outcome-now')).getByText('Present')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Unauthorised absence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    expect(editCalls()[0]![1]).toEqual({ employeeId: EMP, date: '2026-09-01', reason: 'Unauthorised absence', status: 'ABSENT' });
  });

  it('says which time has not happened yet, previews nothing for it, and saves once the times are past', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T08:00:00Z')); // 12:00 in Muscat
    mockPreview(nightShiftToday());
    renderWithProviders(<RecordEditDialog open onOpenChange={() => {}} preset={{ employeeId: EMP, employeeName: 'Ali Hassan', date: '2026-09-01' }} />);
    expect(await screen.findByTestId('expected-shift')).toHaveTextContent('17:00 – 04:00');
    const checkIn = screen.getByLabelText('Check-in') as HTMLInputElement;
    const checkOut = screen.getByLabelText('Check-out') as HTMLInputElement;
    await waitFor(() => expect(checkIn.value).toBe('11:03'));

    // the shift's own times: both still to come — each field says so, and "after" does not repeat the day as it is now
    fireEvent.change(checkIn, { target: { value: '16:46' } });
    fireEvent.change(checkOut, { target: { value: '03:50' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Check-out on the next day' }));
    expect(await screen.findByText('Tue 01 Sep 16:46 has not happened yet.')).toBeInTheDocument();
    expect(screen.getByText('Wed 02 Sep 03:50 has not happened yet.')).toBeInTheDocument();
    expect(checkIn).toHaveAttribute('aria-invalid', 'true');
    expect(checkOut).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('future-hint')).toHaveTextContent('It is Tue 01 Sep 12:00 now (Asia/Muscat).');
    const after = screen.getByTestId('outcome-after');
    expect(after).toHaveTextContent('No outcome for these times');
    expect(within(after).queryByText('Half day')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Night shift punches' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
    await new Promise((r) => setTimeout(r, 400)); // past the preview debounce
    expect(proposalCalls()).toHaveLength(0);
    expect(editCalls()).toHaveLength(0);

    // times up to now: previewed and saved
    fireEvent.click(screen.getByRole('checkbox', { name: 'Check-out on the next day' }));
    fireEvent.change(checkIn, { target: { value: '07:00' } });
    fireEvent.change(checkOut, { target: { value: '11:58' } });
    expect(screen.queryByText(/has not happened yet/)).not.toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByTestId('outcome-after')).getByText('11:58')).toBeInTheDocument());
    expect(proposalCalls().at(-1)?.[1]).toEqual({ employeeId: EMP, date: '2026-09-01', inAt: '2026-09-01T03:00:00Z', outAt: '2026-09-01T07:58:00Z' });
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    expect(editCalls()[0]![1]).toEqual({ employeeId: EMP, date: '2026-09-01', reason: 'Night shift punches', inAt: '2026-09-01T03:00:00Z', outAt: '2026-09-01T07:58:00Z' });
  });

  it('puts an API refusal on the field it names and shows no outcome for the refused times', async () => {
    const base = previewOf();
    apiMock.post.mockImplementation((path: string, body: Record<string, unknown>) => {
      if (path !== '/orgs/org-1/attendance/preview') return Promise.reject(new Error(`unexpected POST ${path}`));
      if (!body['outAt'] && !body['inAt']) return Promise.resolve({ data: base });
      return Promise.reject(new ApiError(400, 'VALIDATION_ERROR', 'The time must fall within the attendance day (from the day before to the day after).', 'req-1', { issues: [{ path: 'outAt', message: 'Outside the attendance day' }] }));
    });
    renderWithProviders(<RecordEditDialog open onOpenChange={() => {}} preset={{ employeeId: EMP, employeeName: 'Ali Hassan', date: '2026-09-01' }} />);
    const checkOut = await screen.findByLabelText('Check-out') as HTMLInputElement;
    await waitFor(() => expect(checkOut.value).toBe('17:10'));
    fireEvent.change(checkOut, { target: { value: '18:30' } });
    expect(await screen.findByText(/must fall within the attendance day/)).toBeInTheDocument();
    expect(checkOut).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('outcome-after')).toHaveTextContent('No outcome for these times');
  });

  it('clearing a recorded time removes that punch (field report: clearing did nothing, only "Request correction" could)', async () => {
    const base = previewOf();
    apiMock.post.mockImplementation((path: string, body: Record<string, unknown>) => {
      if (path === '/orgs/org-1/attendance/preview') {
        if (!body['removeOut']) return Promise.resolve({ data: base });
        return Promise.resolve({ data: { ...base, preview: outcome({ status: 'MISSING_PUNCH', flags: ['LATE', 'MISSING_OUT'], lastOutAt: null, workedMinutes: 0, overtimeMinutes: 0 }), plan: [{ type: 'REMOVE_PUNCH', originalEventId: 'ev-out', originalPunchedAt: '2026-09-01T13:10:40Z', proposedPunchedAt: null, proposedEventType: null, proposedStatus: null }] } });
      }
      if (path === '/orgs/org-1/attendance/record-edits') return Promise.resolve({ data: { corrections: [{ id: 'c1', type: 'REMOVE_PUNCH', status: 'APPROVED', approval: 'AUTO_APPROVED' }], applied: true, failed: null, unchanged: 0, filedAt: '2026-09-02T06:00:00Z' } });
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });
    renderWithProviders(<RecordEditDialog open onOpenChange={() => {}} preset={{ employeeId: EMP, employeeName: 'Ali Hassan', date: '2026-09-01' }} />);
    const checkOut = await screen.findByLabelText('Check-out') as HTMLInputElement;
    await waitFor(() => expect(checkOut.value).toBe('17:10'));
    fireEvent.change(checkOut, { target: { value: '' } });
    expect(await screen.findByText('The recorded check-out (17:10) will be removed.')).toBeInTheDocument();
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/attendance/preview', { employeeId: EMP, date: '2026-09-01', removeOut: true }));
    expect(await screen.findByTestId('edit-plan')).toHaveTextContent('Remove punch');
    expect(within(screen.getByTestId('outcome-after')).getByText('Missing punch')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Badge of another employee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    expect(editCalls()[0]![1]).toEqual({ employeeId: EMP, date: '2026-09-01', reason: 'Badge of another employee', removeOut: true });
  });

  it('opens Add record on the day the register shows, and keeps the time fields (and what was typed) while a new day loads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-10T08:00:00Z'));
    let releaseSecondDay: (() => void) | null = null;
    apiMock.post.mockImplementation((path: string, body: Record<string, unknown>) => {
      if (path !== '/orgs/org-1/attendance/preview') return Promise.reject(new Error(`unexpected POST ${path}`));
      const date = body['date'] as string;
      const day = previewOf({ date, current: outcome({ firstInAt: `${date}T04:05:00Z`, lastOutAt: `${date}T13:10:00Z` }) });
      if (date === '2026-09-03' && !body['inAt']) return new Promise((resolve) => { releaseSecondDay = () => resolve({ data: day }); });
      return Promise.resolve({ data: day });
    });
    renderWithProviders(<RecordEditDialog open onOpenChange={() => {}} preset={{ employeeId: EMP, employeeName: 'Ali Hassan' }} defaultDate="2026-09-02" />);
    const dateInput = screen.getByLabelText(/^Date/) as HTMLInputElement;
    expect(dateInput.value).toBe('2026-09-02');
    expect(dateInput).not.toBeDisabled();
    const checkIn = screen.getByLabelText('Check-in') as HTMLInputElement;
    await waitFor(() => expect(checkIn.value).toBe('08:05'));
    // another day: while it loads the fields stay on screen; a time typed now survives the day's punches arriving
    fireEvent.change(dateInput, { target: { value: '2026-09-03' } });
    expect(screen.getByLabelText('Check-in')).toBeInTheDocument();
    expect(screen.getByTestId('expected-shift-loading')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Check-in'), { target: { value: '07:30' } });
    releaseSecondDay!();
    await screen.findByTestId('expected-shift');
    expect((screen.getByLabelText('Check-in') as HTMLInputElement).value).toBe('07:30');
    expect((screen.getByLabelText('Check-out') as HTMLInputElement).value).toBe('17:10');
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/attendance/preview', { employeeId: EMP, date: '2026-09-03', inAt: '2026-09-03T03:30:00Z' }));
  });

  it('refuses to edit a day in a locked period', async () => {
    mockPreview(previewOf({ locked: true }));
    renderWithProviders(<RecordEditDialog open onOpenChange={() => {}} preset={{ employeeId: EMP, employeeName: 'Ali Hassan', date: '2026-09-01' }} />);
    expect(await screen.findByText(/locked period/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save record' })).toBeDisabled();
  });
});
