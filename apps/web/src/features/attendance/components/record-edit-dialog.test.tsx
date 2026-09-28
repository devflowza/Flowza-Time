import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

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

describe('RecordEditDialog', () => {
  beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat'; mockGet({ '/orgs/org-1/employees': page([]) }); });

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
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Unauthorised absence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
    await waitFor(() => expect(editCalls()).toHaveLength(1));
    expect(editCalls()[0]![1]).toEqual({ employeeId: EMP, date: '2026-09-01', reason: 'Unauthorised absence', status: 'ABSENT' });
  });

  it('refuses to edit a day in a locked period', async () => {
    mockPreview(previewOf({ locked: true }));
    renderWithProviders(<RecordEditDialog open onOpenChange={() => {}} preset={{ employeeId: EMP, employeeName: 'Ali Hassan', date: '2026-09-01' }} />);
    expect(await screen.findByText(/locked period/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save record' })).toBeDisabled();
  });
});
