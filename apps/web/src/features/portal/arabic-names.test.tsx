import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { SelfAttendanceMonthDto, SelfLeaveDto, SelfOverviewDto } from '@flowza/contracts';
import i18n from '@/lib/i18n';
import { localName } from '@/lib/local-name';
import { grantAll, mockGet, renderWithProviders, resetApiMock, testState } from '@/features/employees/test-utils';
import './routes';
import MyLeavePage from './pages/leave-page';
import PortalHomePage from './pages/home-page';
import { MonthCalendar } from './components/month-calendar';

const EMP = '11111111-1111-4111-8111-111111111111';
const AL = '22222222-2222-4222-8222-222222222222';

const record = (over: Partial<SelfLeaveDto['records'][number]> = {}): SelfLeaveDto['records'][number] => ({
  id: 'l1', leaveTypeId: AL, leaveTypeCode: 'AL', leaveTypeName: 'Annual Leave', leaveTypeNameAr: 'إجازة سنوية', color: '#175cd3', isPaid: true, startDate: '2026-10-04', endDate: '2026-10-08', isHalfDay: false, halfDayPart: null, days: 5,
  reason: 'Family visit', status: 'PENDING', decisionNote: null, approvedByName: null, approvedAt: null, createdAt: '2026-09-20T06:00:00Z', updatedAt: '2026-09-20T06:00:00Z',
  approvalRequestId: null, approvalStatus: null, approvalCurrentStep: null, approvalStepCount: null, ...over,
});
const leaveData = (records: SelfLeaveDto['records']): SelfLeaveDto => ({
  year: 2026,
  types: [{ id: AL, code: 'AL', name: 'Annual Leave', nameAr: 'إجازة سنوية', isPaid: true, color: '#175cd3', annualAllowanceDays: 30 }],
  balances: [{ leaveTypeId: AL, allowanceDays: 30, usedDays: 7, pendingDays: 5, remainingDays: 18 }],
  records,
  calendar: { weeklyOffDays: [5, 6], holidays: [] },
});
const overview: SelfOverviewDto = {
  date: '2026-09-27', timezone: 'Asia/Muscat', today: null,
  month: { month: '2026-09', totals: { present: 17, absent: 0, leave: 0, holiday: 0, weeklyOff: 8, halfDay: 0, late: 2, missingPunch: 1, workedMinutes: 8400, overtimeMinutes: 95, lateMinutes: 23, earlyDepartureMinutes: 0, workingDays: 18, attendanceRate: 1 } },
  recent: [], balances: [{ leaveTypeId: AL, allowanceDays: 30, usedDays: 7, pendingDays: 5, remainingDays: 18, name: 'Annual Leave', nameAr: 'إجازة سنوية', code: 'AL', color: '#175cd3' }],
  upcomingLeave: [record()], pendingLeave: 1, pendingCorrections: 0,
  upcomingHolidays: [{ date: '2026-11-18', endDate: '2026-11-19', name: 'National Day', nameAr: 'العيد الوطني' }, { date: '2026-12-01', endDate: null, name: 'Company Day', nameAr: null }],
};

async function inLanguage(lng: 'en' | 'ar') { await act(async () => { await i18n.changeLanguage(lng); }); }
beforeEach(() => { resetApiMock(); grantAll(); testState.orgId = 'org-1'; testState.employeeId = EMP; });
afterEach(async () => { await inLanguage('en'); });

describe('localName', () => {
  it("prefers the organisation's Arabic name in Arabic, and only when one was given", () => {
    expect(localName('ar', 'Annual Leave', 'إجازة سنوية')).toBe('إجازة سنوية');
    expect(localName('ar-OM', 'Annual Leave', 'إجازة سنوية')).toBe('إجازة سنوية');
    expect(localName('ar', 'Annual Leave', null)).toBe('Annual Leave');
    expect(localName('ar', 'Annual Leave', '   ')).toBe('Annual Leave');
    expect(localName('ar', 'Annual Leave')).toBe('Annual Leave');
    expect(localName('en', 'Annual Leave', 'إجازة سنوية')).toBe('Annual Leave');
    expect(localName(undefined, 'Annual Leave', 'إجازة سنوية')).toBe('Annual Leave');
  });
});

// Regression (Prompt 11 UI walk): the portal showed "Annual Leave" and "National Day" in Latin script between Arabic labels,
// although the organisation had given both an Arabic name (the dashboard's holidays card already used it).
describe('employee portal — master-data names in Arabic', () => {
  it('home: balances, upcoming leave and holidays use the Arabic names where given', async () => {
    await inLanguage('ar');
    mockGet({ '/orgs/org-1/me/overview': { data: overview }, '/orgs/org-1/me/profile': { data: { displayName: 'Priya Sharma', designation: null, department: null, branch: null } }, '/orgs/org-1/me/leave': { data: leaveData([record()]) } });
    renderWithProviders(<PortalHomePage />);
    expect(await screen.findByText('العيد الوطني')).toBeInTheDocument();
    expect(screen.getByText('Company Day')).toBeInTheDocument(); // no Arabic name given: the name
    expect(screen.queryByText('National Day')).toBeNull();
    expect(screen.getAllByText('إجازة سنوية').length).toBeGreaterThanOrEqual(2); // the balance row and the upcoming request
    expect(screen.queryByText('Annual Leave')).toBeNull();
  });

  it('home: English stays English', async () => {
    mockGet({ '/orgs/org-1/me/overview': { data: overview }, '/orgs/org-1/me/profile': { data: { displayName: 'Priya Sharma', designation: null, department: null, branch: null } }, '/orgs/org-1/me/leave': { data: leaveData([record()]) } });
    renderWithProviders(<PortalHomePage />);
    expect(await screen.findByText('National Day')).toBeInTheDocument();
    expect(screen.queryByText('العيد الوطني')).toBeNull();
    expect(screen.queryByText('إجازة سنوية')).toBeNull();
  });

  it('my leave: the balance card and the requests use the Arabic type name (from the type list for an older API build)', async () => {
    await inLanguage('ar');
    // the second record comes from an API build that sends no Arabic name on the record
    const older = record({ id: 'l2', status: 'APPROVED', startDate: '2026-08-23', endDate: '2026-08-27', leaveTypeNameAr: undefined });
    mockGet({ '/orgs/org-1/me/leave': { data: leaveData([record(), older]) } });
    renderWithProviders(<MyLeavePage />);
    expect((await screen.findAllByText('إجازة سنوية')).length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText('Annual Leave')).toBeNull();
  });

  it('month calendar: leave and holidays on days without a record are named in Arabic', async () => {
    await inLanguage('ar');
    const data: SelfAttendanceMonthDto = {
      month: '2026-11', days: [], totals: overview.month.totals,
      leaveByDate: { '2026-11-03': { leaveTypeName: 'Annual Leave', leaveTypeNameAr: 'إجازة سنوية', color: '#175cd3', isHalfDay: false } },
      holidaysByDate: { '2026-11-18': 'National Day', '2026-11-25': 'Company Day' }, holidaysByDateAr: { '2026-11-18': 'العيد الوطني' },
    };
    render(<MonthCalendar data={data} firstDayOfWeek={0} today="2026-11-01" onSelect={() => {}} />);
    expect(screen.getByText('إجازة سنوية')).toBeInTheDocument();
    expect(screen.getByText('العيد الوطني')).toBeInTheDocument();
    expect(screen.getByText('Company Day')).toBeInTheDocument();
    expect(screen.queryByText('National Day')).toBeNull();
  });
});
