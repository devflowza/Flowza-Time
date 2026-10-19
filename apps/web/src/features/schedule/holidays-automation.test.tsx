import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grant, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import './routes';
import HolidaysPage from './pages/holidays-page';

/**
 * Holidays automation ("Official holidays"): a holiday on a fixed date is marked recurring, a calendar creates next year's
 * recurring holidays from 1 December unless switched off, "Copy to <next year>" copies a year (members with every branch).
 */
const CAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const calendar = (over: Record<string, unknown> = {}) => ({ id: CAL, name: 'Oman', countryCode: 'OM', isDefault: true, autoRollover: true, holidayCount: 2, branchCount: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over });
const holiday = (over: Record<string, unknown>) => ({ id: 'h1', calendarId: CAL, name: 'National Day', nameAr: null, date: '2026-11-18', endDate: null, isHalfDay: false, type: 'PUBLIC', branchIds: null, isTentative: false, recursYearly: true, createdAt: '2026-01-01T00:00:00Z', ...over });
const routes = () => mockGet({ '/orgs/org-1/holiday-calendars': { data: [calendar()] }, '/orgs/org-1/holidays': { data: [holiday({}), holiday({ id: 'h2', name: 'Eid al-Adha', date: '2026-05-27', type: 'RELIGIOUS', recursYearly: false })] }, '/orgs/org-1/branches': page([]) });

beforeEach(() => { resetApiMock(); testState.orgId = 'org-1'; testState.timezone = 'Asia/Muscat'; grant('holiday.view', 'holiday.manage'); });
afterEach(() => { testState.allBranches = true; });

describe('holidays automation', () => {
  it('marks recurring holidays and copies the year on screen to the next one', async () => {
    routes();
    apiMock.post.mockResolvedValue({ data: { calendarId: CAL, fromYear: 2026, toYear: 2027, created: [holiday({ id: 'h3', date: '2027-11-18' })], skipped: [], recalculationJobId: null } });
    renderWithProviders(<HolidaysPage />, { route: '/holidays?year=2026' });
    expect(await screen.findByText('Yearly')).toBeInTheDocument(); // only the recurring National Day
    expect(screen.getAllByText('Yearly')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Copy to 2027/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Copy 2026 holidays to 2027')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('switch', { name: /Also copy the other holidays/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy to 2027' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/orgs/org-1/holiday-calendars/${CAL}/copy-year`, { fromYear: 2026, toYear: 2027, includeNonRecurring: true }));
  });

  it('a member scoped to some branches is not offered the copy (it concerns every branch of the calendar)', async () => {
    testState.allBranches = false;
    routes();
    renderWithProviders(<HolidaysPage />, { route: '/holidays?year=2026' });
    await screen.findByText('National Day');
    expect(screen.queryByRole('button', { name: /Copy to 2027/ })).not.toBeInTheDocument();
  });

  it('a new holiday can repeat every year', async () => {
    routes();
    apiMock.post.mockResolvedValue({ data: { ...holiday({ id: 'h9', name: 'Renaissance Day', date: '2026-07-23' }), recalculationJobId: 'job-1' } });
    renderWithProviders(<HolidaysPage />, { route: '/holidays?year=2026' });
    await screen.findByText('National Day');
    fireEvent.click(screen.getAllByRole('button', { name: /Add holiday/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Name/, { selector: '#hd-name' }), { target: { value: 'Renaissance Day' } });
    fireEvent.change(within(dialog).getByLabelText(/Date/, { selector: '#hd-date' }), { target: { value: '2026-07-23' } });
    const recurring = within(dialog).getByRole('switch', { name: 'Every year' });
    expect(recurring).not.toBeChecked();
    fireEvent.click(recurring);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/holidays', expect.objectContaining({ name: 'Renaissance Day', date: '2026-07-23', recursYearly: true })));
  });

  it('a calendar creates next year\'s recurring holidays unless switched off', async () => {
    routes();
    apiMock.post.mockResolvedValue({ data: { ...calendar({ id: 'c2', name: 'Manual', isDefault: false, autoRollover: false }), recalculationJobId: null } });
    renderWithProviders(<HolidaysPage />, { route: '/holidays?year=2026' });
    await screen.findByText('National Day');
    fireEvent.click(screen.getByRole('button', { name: /Add calendar/ }));
    const create = await screen.findByRole('dialog');
    fireEvent.change(within(create).getByLabelText(/Name/, { selector: '#cal-name' }), { target: { value: 'Manual' } });
    const rollover = within(create).getByRole('switch', { name: /next year's recurring holidays/ });
    expect(rollover).toBeChecked();
    fireEvent.click(rollover);
    fireEvent.click(within(create).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/holiday-calendars', expect.objectContaining({ name: 'Manual', autoRollover: false })));
  });
});
