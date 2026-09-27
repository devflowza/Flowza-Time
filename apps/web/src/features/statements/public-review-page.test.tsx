import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { PublicStatementDto, StatementSnapshot } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('./api', () => ({ viewStatementByToken: vi.fn(), submitStatementByToken: vi.fn() }));

import { renderWithProviders } from '@/features/employees/test-utils';
import { submitStatementByToken, viewStatementByToken } from './api';
import PublicStatementReviewPage from './public-review-page';

const TOKEN = '11111111-1111-1111-1111-111111111111.secret-value-long-enough';
const at = (token?: string) => ({ route: token ? `/statements/review?token=${encodeURIComponent(token)}` : '/statements/review', path: '/statements/review' });

const day = (date: string, extra: Partial<StatementSnapshot['days'][number]> = {}): StatementSnapshot['days'][number] => ({
  date, dateLabel: date, weekdayLabel: 'Mon', status: 'PRESENT', code: 'PR', leave: null,
  firstInAt: `${date}T04:00:00.000Z`, lastOutAt: `${date}T13:00:00.000Z`, signIn: '08:00', signOut: '17:00',
  workedMinutes: 540, scheduledMinutes: 540, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0,
  workedLabel: '9.00', flags: [], commentable: true, ...extra,
});

const snapshot: StatementSnapshot = {
  version: 1,
  organization: { name: 'Acme LLC', timezone: 'Asia/Muscat', locale: 'en', hoursNotation: 'h.mm', timeFormat: '24h' },
  period: { start: '2026-08-01', end: '2026-08-03', label: 'August 2026' },
  employee: { id: '22222222-2222-2222-2222-222222222222', name: 'Aisha', employeeNumber: '2041', branchName: 'HQ', departmentName: 'Finance', designationName: null },
  days: [day('2026-08-01'), day('2026-08-02', { lateMinutes: 24 }), day('2026-08-03', { status: 'WEEKLY_OFF', code: 'OF', signIn: '-', signOut: '-', workedLabel: '-', workedMinutes: 0, scheduledMinutes: 0 })],
  totals: {
    requiredMinutes: 1080, workedMinutes: 1080, differenceMinutes: 0, delayMinutes: 24, lateDays: 1,
    earlyDepartureMinutes: 0, overtimeMinutes: 0, workingDays: 2, presentDays: 3, absentDays: 0, halfDays: 0,
    holidayDays: 0, weeklyOffDays: 1, missingPunchDays: 0, leaveDays: 0,
    leaveByType: [{ code: 'SL', name: 'Sick Leave', nameAr: null, isPaid: true, days: 1 }],
    requiredLabel: '18.00', workedLabel: '18.00', differenceLabel: '0.00', delayLabel: '0.24', overtimeLabel: '0.00',
  },
  generatedAt: '2026-09-03T05:00:00.000Z',
};

const issued: PublicStatementDto = {
  status: 'ISSUED', periodStart: '2026-08-01', periodEnd: '2026-08-03', snapshot, comments: [],
  submittedAt: null, signedName: null, approvedAt: null, approvalNote: null, finalizedAt: null, finalizedReason: null,
  tokenExpiresAt: '2099-01-01T00:00:00.000Z',
};

const viewMock = vi.mocked(viewStatementByToken);
const submitMock = vi.mocked(submitStatementByToken);

describe('PublicStatementReviewPage', () => {
  beforeEach(() => { viewMock.mockReset(); submitMock.mockReset(); });

  it('refuses a link with no token', () => {
    renderWithProviders(<PublicStatementReviewPage />, at());
    expect(screen.getByText('This link is not valid')).toBeInTheDocument();
    expect(viewMock).not.toHaveBeenCalled();
  });

  it('renders the statement document with the summary block the employee signs off on', async () => {
    viewMock.mockResolvedValue(issued);
    renderWithProviders(<PublicStatementReviewPage />, at(TOKEN));
    expect(await screen.findByText('Attendance statement — August 2026')).toBeInTheDocument();
    expect(screen.getByText('Required working hours')).toBeInTheDocument();
    expect(screen.getAllByText('18.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Total delay')).toBeInTheDocument();
    expect(screen.getByText('Sick Leave')).toBeInTheDocument();
    expect(screen.getByText('Type your full name to sign')).toBeInTheDocument();
  });

  it('signs with a comment: the comment reaches the API and the pending-approval state comes back', async () => {
    viewMock.mockResolvedValueOnce(issued);
    submitMock.mockResolvedValue({ ...issued, status: 'PENDING_APPROVAL', signedName: 'Aisha A.', submittedAt: '2026-09-04T05:00:00.000Z', comments: [{ id: 'c1', attendanceDate: '2026-08-02', comment: 'I left at 18:00.', createdAt: '2026-09-04T05:00:00.000Z' }] });
    viewMock.mockResolvedValue({ ...issued, status: 'PENDING_APPROVAL', signedName: 'Aisha A.' });
    renderWithProviders(<PublicStatementReviewPage />, at(TOKEN));
    await screen.findByText('Attendance statement — August 2026');

    fireEvent.click(screen.getAllByText('Add comment')[1]!); // the late day
    fireEvent.change(screen.getByPlaceholderText("What is wrong with this day's sign-in or sign-out?"), { target: { value: 'I left at 18:00.' } });
    fireEvent.click(screen.getByText('Done'));

    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Aisha A.' } });
    fireEvent.click(screen.getByLabelText('Confirmation'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign & submit' }));

    await waitFor(() => expect(submitMock).toHaveBeenCalled());
    expect(submitMock.mock.calls[0]![0]).toEqual({ token: TOKEN, signedName: 'Aisha A.', comments: [{ date: '2026-08-02', comment: 'I left at 18:00.' }] });
    expect(await screen.findByText("Signed — waiting for your reporting manager's approval")).toBeInTheDocument();
  });

  it('a finalised statement is read-only with its status', async () => {
    viewMock.mockResolvedValue({ ...issued, status: 'FINALIZED', finalizedReason: 'EMPLOYEE_CONFIRMED', signedName: 'Aisha A.', finalizedAt: '2026-09-04T05:00:00.000Z', submittedAt: '2026-09-04T05:00:00.000Z' });
    renderWithProviders(<PublicStatementReviewPage />, at(TOKEN));
    expect(await screen.findByText('Final — confirmed and signed')).toBeInTheDocument();
    expect(screen.queryByText('Sign & submit')).not.toBeInTheDocument();
    expect(screen.queryByText('Add comment')).not.toBeInTheDocument();
  });
});
