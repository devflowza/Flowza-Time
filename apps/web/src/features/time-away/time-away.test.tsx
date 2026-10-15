import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { TimeAwayRequestDto, TimeAwaySummaryRowDto } from '@flowza/contracts';
import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import './i18n';
import TimeAwayPage from './pages/time-away-page';
import { awayBreakdown, monthRange } from './model';

const E1 = 'e1000000-0000-4000-8000-000000000001';
const E2 = 'e2000000-0000-4000-8000-000000000002';
const row = (employeeId: string, over: Partial<TimeAwaySummaryRowDto>): TimeAwaySummaryRowDto => ({
  employeeId, employeeNumber: 'E-001', employeeName: 'Employee', departmentName: 'Finance', days: 0, awayMinutes: 0, officialDutyMinutes: 0, permissionMinutes: 0, unapprovedAwayMinutes: 0, unapprovedDays: 0, pendingRequests: 0, ...over,
});
const SUMMARY = [
  row(E1, { employeeName: 'Aisha Al Balushi', employeeNumber: 'E-001', days: 4, awayMinutes: 300, officialDutyMinutes: 120, permissionMinutes: 60, unapprovedAwayMinutes: 95, unapprovedDays: 2, pendingRequests: 1 }),
  row(E2, { employeeName: 'Badr Al Said', employeeNumber: 'E-002', departmentName: 'Sales', days: 1, awayMinutes: 45, officialDutyMinutes: 45 }),
];
const request = (id: string, over: Partial<TimeAwayRequestDto>): TimeAwayRequestDto => ({
  id, employeeId: E1, employeeName: 'Aisha Al Balushi', employeeNumber: 'E-001', branchId: null, attendanceDate: '2026-09-14', kind: 'OFFICIAL', source: 'request', startsAt: '2026-09-14T06:00:00Z', endsAt: '2026-09-14T08:00:00Z',
  returnedAt: null, minutes: 120, reason: 'Ministry of Labour visit', destination: 'Ministry of Labour', status: 'approved', approvalRequestId: null, approvalStatus: null, decidedByName: 'Salim', decidedAt: '2026-09-13T10:00:00Z', decisionNote: null, createdAt: '2026-09-12T10:00:00Z', ...over,
});
const REQUESTS = [request('r1', {}), request('r2', { kind: 'PERSONAL', status: 'pending', reason: 'Bank appointment', destination: null, decidedByName: null, decidedAt: null, minutes: 60 })];

const listCalls = () => apiMock.get.mock.calls.filter(([p]) => p === '/orgs/org-1/time-away') as Array<[string, Record<string, unknown>]>;
const summaryCalls = () => apiMock.get.mock.calls.filter(([p]) => p === '/orgs/org-1/time-away/summary') as Array<[string, Record<string, unknown>]>;

describe('time away — the HR report (docs/time-away.md)', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    testState.timezone = 'Asia/Muscat';
    mockGet({
      '/orgs/org-1/time-away/summary': { data: SUMMARY },
      '/orgs/org-1/time-away': page(REQUESTS),
      '/orgs/org-1/branches': page([]),
      '/orgs/org-1/departments': page([]),
    });
  });

  it('shows the month\'s totals per employee with the unapproved time in red, and the month\'s requests', async () => {
    renderWithProviders(<TimeAwayPage />, { route: '/attendance/time-away?month=2026-09' });
    const unapproved = await screen.findByTestId(`unapproved-${E1}`);
    expect(unapproved).toHaveTextContent('1h 35m');
    expect(unapproved.className).toContain('text-red-700');
    expect(screen.getByTestId(`unapproved-${E2}`).className).not.toContain('text-red-700');
    // totals across the month: 5h 45m away, 1h 35m unapproved, one employee flagged, one pending request
    const totals = screen.getByTestId('time-away-totals');
    expect(totals).toHaveTextContent('5h 45m');
    expect(totals).toHaveTextContent('1h 35m');
    expect(summaryCalls()[0]?.[1]).toMatchObject({ month: '2026-09' });
    expect(listCalls()[0]?.[1]).toMatchObject({ from: '2026-09-01', to: '2026-09-30', page: 1 });
    // the breakdown bar of the first row: official, permission, unapproved and the rest
    const bar = screen.getAllByRole('img', { name: /Official duty 2h 00m, permission 1h 00m, unapproved 1h 35m, other 25m/ })[0]!;
    expect(bar.querySelectorAll('[data-segment]')).toHaveLength(4);
    // the requests with their type and status
    expect((await screen.findAllByText('Bank appointment')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Personal permission').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0);
    expect(screen.getAllByText('To: Ministry of Labour').length).toBeGreaterThan(0);
  });

  it('a row narrows the requests to that employee, and the chip shows everyone again', async () => {
    renderWithProviders(<TimeAwayPage />, { route: '/attendance/time-away?month=2026-09' });
    const cells = await screen.findAllByText('Badr Al Said');
    fireEvent.click(cells[cells.length - 1]!.closest('tr')!);
    await waitFor(() => expect(listCalls().at(-1)?.[1]).toMatchObject({ employeeId: E2, from: '2026-09-01' }));
    const chip = await screen.findByTestId('time-away-employee-filter');
    expect(chip).toHaveTextContent('Requests of Badr Al Said');
    fireEvent.click(within(chip).getByRole('button', { name: 'Show everyone' }));
    await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('employeeId'));
  });

  it('filters the requests by status and moves to the previous month', async () => {
    renderWithProviders(<TimeAwayPage />, { route: '/attendance/time-away?month=2026-09' });
    await screen.findByTestId(`unapproved-${E1}`);
    const status = screen.getByRole('combobox', { name: 'Status' });
    fireEvent.keyDown(status, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Rejected' }));
    await waitFor(() => expect(listCalls().at(-1)?.[1]).toMatchObject({ status: 'rejected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await waitFor(() => expect(summaryCalls().at(-1)?.[1]).toMatchObject({ month: '2026-08' }));
    expect(listCalls().at(-1)?.[1]).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('counts every pending request of the month — also those of employees with no away time yet (no totals row)', async () => {
    // the summary knows one pending request (Aisha); two windows planned ahead by employees with no away time have no row
    mockGet({
      '/orgs/org-1/time-away/summary': { data: SUMMARY },
      '/orgs/org-1/time-away': (q: Record<string, unknown> | undefined) => (q?.['status'] === 'pending' && q['pageSize'] === 1 ? page(REQUESTS.slice(1), 3) : page(REQUESTS)),
      '/orgs/org-1/branches': page([]),
      '/orgs/org-1/departments': page([]),
    });
    renderWithProviders(<TimeAwayPage />, { route: '/attendance/time-away?month=2026-09' });
    await screen.findByTestId(`unapproved-${E1}`);
    const card = within(screen.getByTestId('time-away-totals')).getByText('Pending requests');
    await waitFor(() => expect(card.nextElementSibling).toHaveTextContent('3'));
    expect(listCalls().find(([, q]) => q['status'] === 'pending' && q['pageSize'] === 1)?.[1]).toMatchObject({ from: '2026-09-01', to: '2026-09-30', page: 1 });
  });

  it('the department filter narrows the requests and their pending count as it narrows the totals', async () => {
    const D1 = 'd1000000-0000-4000-8000-000000000001';
    renderWithProviders(<TimeAwayPage />, { route: `/attendance/time-away?month=2026-09&departmentId=${D1}` });
    await screen.findByTestId(`unapproved-${E1}`);
    expect(summaryCalls()[0]?.[1]).toMatchObject({ month: '2026-09', departmentId: D1 });
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(2));
    // the requests table and the pending card's count both carry the department
    for (const [, q] of listCalls()) expect(q).toMatchObject({ departmentId: D1, from: '2026-09-01' });
    expect(listCalls().some(([, q]) => q['status'] === undefined)).toBe(true);
  });

  it('says so when nobody was away', async () => {
    mockGet({ '/orgs/org-1/time-away/summary': { data: [] }, '/orgs/org-1/time-away': page([]), '/orgs/org-1/branches': page([]), '/orgs/org-1/departments': page([]) });
    renderWithProviders(<TimeAwayPage />, { route: '/attendance/time-away?month=2026-09' });
    expect(await screen.findByText('No time away this month')).toBeInTheDocument();
    expect(await screen.findByText('No requests')).toBeInTheDocument();
  });
});

describe('time away model', () => {
  it('splits a month so the parts add up to the total', () => {
    expect(awayBreakdown({ awayMinutes: 300, officialDutyMinutes: 120, permissionMinutes: 60, unapprovedAwayMinutes: 95 })).toEqual({ official: 120, permission: 60, unapproved: 95, other: 25, total: 300 });
    expect(awayBreakdown({ awayMinutes: 10, officialDutyMinutes: 20, permissionMinutes: 0, unapprovedAwayMinutes: 0 })).toMatchObject({ other: 0, total: 20 });
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
});
