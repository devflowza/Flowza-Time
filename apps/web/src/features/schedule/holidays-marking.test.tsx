import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import './routes';
import '@/features/attendance/routes';
import HolidaysPage from './pages/holidays-page';
import { DailyView } from '@/features/attendance/components/daily-view';

const CAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const calendar = (over: Record<string, unknown> = {}) => ({ id: CAL, name: 'Oman', countryCode: 'OM', isDefault: true, holidayCount: 0, branchCount: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over });
const created = (calendarId: string, date: string) => ({ data: { id: 'h1', calendarId, name: 'National Day', nameAr: null, date, endDate: null, isHalfDay: false, type: 'PUBLIC', branchIds: null, isTentative: false, createdAt: '2026-09-29T00:00:00Z' } });

beforeEach(() => { resetApiMock(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat'; });

describe('marking a holiday — one step, and it always applies', () => {
  it('with no calendar yet, "Mark a holiday" saves straight away: the API adds it to a default calendar it creates', async () => {
    grant('holiday.view', 'holiday.manage');
    mockGet({ '/orgs/org-1/holiday-calendars': { data: [] }, '/orgs/org-1/branches': page([]) });
    apiMock.post.mockResolvedValue(created(CAL, '2026-11-18'));
    renderWithProviders(<HolidaysPage />, { route: '/holidays' });
    fireEvent.click((await screen.findAllByRole('button', { name: /Mark a holiday/ }))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('new-default-calendar')).toHaveTextContent('a default calendar will be created');
    fireEvent.change(within(dialog).getByLabelText(/Name/, { selector: '#hd-name' }), { target: { value: 'National Day' } });
    fireEvent.change(within(dialog).getByLabelText(/Date/, { selector: '#hd-date' }), { target: { value: '2026-11-18' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/holidays', expect.objectContaining({ name: 'National Day', date: '2026-11-18' })));
    expect((apiMock.post.mock.calls[0]![1] as Record<string, unknown>)['calendarId']).toBeUndefined();
  });

  it('warns about a calendar that applies to nobody and makes it the default in one click', async () => {
    grant('holiday.view', 'holiday.manage');
    mockGet({ '/orgs/org-1/holiday-calendars': { data: [calendar({ isDefault: false, branchCount: 0 })] }, '/orgs/org-1/holidays': { data: [] }, '/orgs/org-1/branches': page([]) });
    apiMock.patch.mockResolvedValue({ data: calendar() });
    renderWithProviders(<HolidaysPage />, { route: '/holidays' });
    const warning = await screen.findByTestId('calendar-unused');
    expect(warning).toHaveTextContent('applies to nobody');
    fireEvent.click(within(warning).getByRole('button', { name: /Make default/ }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith(`/orgs/org-1/holiday-calendars/${CAL}`, { isDefault: true }));
  });

  it('no warning for the default calendar or one a branch uses', async () => {
    grant('holiday.view', 'holiday.manage');
    mockGet({ '/orgs/org-1/holiday-calendars': { data: [calendar({ isDefault: false, branchCount: 2 })] }, '/orgs/org-1/holidays': { data: [] }, '/orgs/org-1/branches': page([]) });
    renderWithProviders(<HolidaysPage />, { route: '/holidays' });
    expect(await screen.findByText(/2 branch/)).toBeInTheDocument();
    expect(screen.queryByTestId('calendar-unused')).not.toBeInTheDocument();
  });

  it('the day view marks the day on screen as a holiday, into the default calendar', async () => {
    grantAll();
    mockGet({
      '/orgs/org-1/attendance/daily': { data: [], meta: { page: 1, pageSize: 25, total: 0, totalPages: 0, byStatus: {}, missingPunch: 0 } }, '/orgs/org-1/attendance/manual-statuses': { data: [] },
      '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/shifts': page([]), '/orgs/org-1/employees': page([]),
      '/orgs/org-1/holiday-calendars': { data: [calendar(), calendar({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Sohar', isDefault: false, branchCount: 1 })] },
    });
    apiMock.post.mockResolvedValue(created(CAL, '2026-09-10'));
    renderWithProviders(<DailyView />, { route: '/attendance?tab=daily&date=2026-09-10' });
    fireEvent.click(await screen.findByTestId('mark-holiday'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Date/, { selector: '#hd-date' })).toHaveValue('2026-09-10');
    await within(dialog).findByText(/applies to every branch without a calendar/);
    fireEvent.change(within(dialog).getByLabelText(/Name/, { selector: '#hd-name' }), { target: { value: 'Rain day' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/holidays', expect.objectContaining({ name: 'Rain day', date: '2026-09-10', calendarId: CAL })));
  });

  it('the day view offers no "Mark as holiday" without holiday.manage', async () => {
    grant('attendance.view', 'holiday.view');
    mockGet({
      '/orgs/org-1/attendance/daily': { data: [], meta: { page: 1, pageSize: 25, total: 0, totalPages: 0, byStatus: {}, missingPunch: 0 } }, '/orgs/org-1/attendance/manual-statuses': { data: [] },
      '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]), '/orgs/org-1/shifts': page([]),
    });
    renderWithProviders(<DailyView />, { route: '/attendance?tab=daily&date=2026-09-10' });
    await screen.findByRole('button', { name: /Today/ });
    expect(screen.queryByTestId('mark-holiday')).not.toBeInTheDocument();
  });
});
