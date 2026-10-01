import { describe, expect, it } from 'vitest';
import { DAILY_REPORT_MAX_DAYS, dailyReportRangeTooLong, inclusiveDayCount, REPORT_TYPE_DEFINITIONS } from './dto-features/reports.js';
import { unmatchedAssignBlockedReason } from './dto-features/hr-workspace.js';
import { reportScheduleFiltersSchema } from './dto-features/report-schedules.js';
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
