import { describe, expect, it } from 'vitest';
import { DAILY_REPORT_MAX_DAYS, dailyReportRangeTooLong, inclusiveDayCount, REPORT_TYPE_DEFINITIONS } from './dto-features/reports.js';
import { unmatchedAssignBlockedReason } from './dto-features/hr-workspace.js';
import { createReportScheduleSchema, PERIOD_RULES_BY_CADENCE, reportRecipientsSchema, reportScheduleFiltersSchema, SCHEDULABLE_REPORT_TYPES } from './dto-features/report-schedules.js';
import { dailyRegisterExportSchema } from './dto-features/attendance.js';
import { createReportRequestSchema } from './reports.js';

/**
 * Report-catalogue rules shared by the API, the worker and the web form (HR portal Prompt 6a review). One definition each, so
 * the three layers cannot disagree about what they accept.
 */
describe('6a-ATT21 the Daily Report range', () => {
  it('counts both ends and refuses more than 62 days', () => {
    expect(DAILY_REPORT_MAX_DAYS).toBe(62);
    expect(inclusiveDayCount('2026-08-01', '2026-08-01')).toBe(1);
    expect(inclusiveDayCount('2026-08-01', '2026-08-31')).toBe(31);
    expect(inclusiveDayCount('2026-02-01', '2026-03-31')).toBe(59);
    expect(inclusiveDayCount('2026-08-02', '2026-08-01')).toBe(0);
    expect(inclusiveDayCount('2026-08-01', null)).toBe(0);
    expect(dailyReportRangeTooLong({ from: '2026-06-02', to: '2026-08-02' })).toBe(false); // 62 days
    expect(dailyReportRangeTooLong({ from: '2026-06-01', to: '2026-08-02' })).toBe(true); // 63 days
    expect(dailyReportRangeTooLong({ from: '2026-06-01' })).toBe(false); // one day
    // across a DST change in a zone that has one, counted on dates (UTC midnight), never on local hours
    expect(inclusiveDayCount('2026-03-01', '2026-04-30')).toBe(61);
  });

  it('the Daily Report takes an optional `to`; the summary report is a whole-month type', () => {
    const daily = REPORT_TYPE_DEFINITIONS.find((d) => d.key === 'daily_attendance')!;
    expect(daily.requiredParameters).toEqual(['from']);
    expect(daily.optionalParameters).toContain('to');
    const summary = REPORT_TYPE_DEFINITIONS.find((d) => d.key === 'monthly_summary')!;
    expect(summary).toMatchObject({ status: 'available', requiredParameters: ['month'], permissions: ['report.view', 'attendance.view'] });
  });
});

describe('the Monthly Attendance Report layout', () => {
  it('is offered on the monthly report only, summary by default (absent), detailed on request', () => {
    const monthly = REPORT_TYPE_DEFINITIONS.find((d) => d.key === 'monthly_attendance')!;
    expect(monthly.optionalParameters).toContain('layout');
    expect(REPORT_TYPE_DEFINITIONS.filter((d) => d.optionalParameters.includes('layout')).map((d) => d.key)).toEqual(['monthly_attendance']);
    const parse = (layout?: string) => createReportRequestSchema.safeParse({ reportType: 'monthly_attendance', parameters: { month: '2026-10', ...(layout ? { layout } : {}) } });
    expect(parse().success && parse().data?.parameters.layout).toBeUndefined();
    expect(parse('detailed').data?.parameters.layout).toBe('detailed');
    expect(parse('summary').data?.parameters.layout).toBe('summary');
    expect(parse('codes').success).toBe(false);
  });
  it('travels in a schedule\'s filters (a strict schema), and nothing else new does', () => {
    expect(reportScheduleFiltersSchema.safeParse({ layout: 'detailed' }).success).toBe(true);
    expect(reportScheduleFiltersSchema.safeParse({ layout: 'grid' }).success).toBe(false);
    expect(reportScheduleFiltersSchema.safeParse({ layout: 'detailed', bogus: 1 }).success).toBe(false);
  });
});

describe('6a-D4 Assign on devices whose punches never use the device mapping', () => {
  it('names why Assign is refused for the Finance connector and the self-service device, and nothing for others', () => {
    expect(unmatchedAssignBlockedReason('flowza_finance')).toBe('CONNECTOR_RESOLVES_BY_EMPLOYEE_NUMBER');
    expect(unmatchedAssignBlockedReason('self_service')).toBe('SELF_SERVICE_RESOLVES_BY_MEMBERSHIP');
    expect(unmatchedAssignBlockedReason('mock')).toBeNull();
    expect(unmatchedAssignBlockedReason('zkteco_push')).toBeNull();
    expect(unmatchedAssignBlockedReason('')).toBeNull();
  });
});

describe('daily schedules, line-manager recipients and the irregular cases report (migration 20261019000500)', () => {
  const base = { name: 'Morning irregular cases', reportType: 'irregularities_report', format: 'xlsx', cadence: 'daily', runDay: 0, runTime: '07:30', periodRule: 'previous_day', recipients: { lineManagers: true } };
  it('a daily schedule covers yesterday (or month to date) and has no run day', () => {
    const ok = createReportScheduleSchema.safeParse(base);
    expect(ok.success).toBe(true);
    expect(ok.data?.recipients).toEqual({ userIds: [], roleKeys: [], lineManagers: true });
    expect(createReportScheduleSchema.safeParse({ ...base, periodRule: 'month_to_date' }).success).toBe(true);
    expect(createReportScheduleSchema.safeParse({ ...base, periodRule: 'previous_month' }).success).toBe(false);
    expect(createReportScheduleSchema.safeParse({ ...base, runDay: 3 }).success).toBe(false);
    // previous_day belongs to the daily cadence only
    expect(createReportScheduleSchema.safeParse({ ...base, cadence: 'monthly', runDay: 1 }).success).toBe(false);
    expect(PERIOD_RULES_BY_CADENCE.daily).toEqual(['previous_day', 'month_to_date']);
  });
  it('the Daily Report, the late / absence / missed punch reports and the irregular cases report can be scheduled', () => {
    for (const t of ['daily_attendance', 'late_report', 'absence_report', 'missing_punch_report', 'irregularities_report'] as const) expect(SCHEDULABLE_REPORT_TYPES).toContain(t);
    expect(createReportScheduleSchema.safeParse({ ...base, reportType: 'daily_attendance' }).success).toBe(true);
    // a whole-month type cannot run on yesterday
    expect(createReportScheduleSchema.safeParse({ ...base, reportType: 'monthly_summary' }).success).toBe(false);
    const irregular = REPORT_TYPE_DEFINITIONS.find((d) => d.key === 'irregularities_report')!;
    expect(irregular).toMatchObject({ status: 'available', requiredParameters: ['from', 'to'], optionalParameters: ['branchId', 'departmentId', 'employeeIds', 'status'], permissions: ['report.view', 'attendance.view'] });
    // the reports that honour the status search offer it in the form
    expect(REPORT_TYPE_DEFINITIONS.filter((d) => d.optionalParameters.includes('status')).map((d) => d.key).sort()).toEqual(['absence_report', 'daily_attendance', 'employee_attendance', 'irregularities_report', 'late_report']);
  });
  it('line managers alone are a recipient list; nothing at all is not', () => {
    expect(reportRecipientsSchema.safeParse({ lineManagers: true }).success).toBe(true);
    expect(reportRecipientsSchema.safeParse({ lineManagers: false }).success).toBe(false);
    expect(reportRecipientsSchema.safeParse({}).success).toBe(false);
  });
  it('the server-written scope markers never come from a client: the parameters schema strips them', () => {
    const parsed = createReportRequestSchema.parse({ reportType: 'late_report', parameters: { from: '2026-10-01', to: '2026-10-18', teamManagerEmployeeId: 'x', selfEmployeeId: 'y', status: 'ABSENT', flag: 'LATE' } });
    expect(parsed.parameters).toEqual({ from: '2026-10-01', to: '2026-10-18', status: 'ABSENT', flag: 'LATE' });
    expect(createReportRequestSchema.safeParse({ reportType: 'daily_attendance', parameters: { from: '2026-10-01', flag: 'NOPE' } }).success).toBe(false);
  });
  it('the register export takes the register filters and a spreadsheet format only', () => {
    expect(dailyRegisterExportSchema.parse({ date: '2026-10-18' })).toEqual({ date: '2026-10-18', format: 'xlsx' });
    expect(dailyRegisterExportSchema.safeParse({ date: '2026-10-18', format: 'pdf' }).success).toBe(false);
    expect(dailyRegisterExportSchema.safeParse({ date: '2026-10-18', status: 'MISSING_PUNCH', flag: 'LATE', search: 'ali', format: 'csv' }).success).toBe(true);
  });
});
