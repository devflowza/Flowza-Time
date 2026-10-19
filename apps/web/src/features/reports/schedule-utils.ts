import { DAILY_SCHEDULE_RUN_DAY, MONTH_PARAMETER_REPORT_TYPES, PERIOD_RULES_BY_CADENCE, WEEK_PARAMETER_REPORT_TYPES, type ReportPeriodRule, type ReportScheduleCadence, type ReportScheduleDto, type ReportType } from '@flowza/contracts';
import { fmtDate } from '@/lib/format';

/** Pure helpers of report sharing and schedules (HR portal Prompt 6a). */
type T = (k: string, o?: Record<string, unknown>) => string;

/** The run day a cadence starts with: the first day of the week, the 1st of the month, none (0) for a daily schedule. */
export function defaultRunDay(cadence: ReportScheduleCadence, firstDayOfWeek: number): number {
  return cadence === 'weekly' ? firstDayOfWeek : cadence === 'daily' ? DAILY_SCHEDULE_RUN_DAY : 1;
}

/** Period rules a (cadence, report type) pair may use — the same constraints the contract refinement enforces. */
export function allowedPeriodRules(cadence: ReportScheduleCadence, reportType: ReportType | undefined): ReportPeriodRule[] {
  let rules = [...PERIOD_RULES_BY_CADENCE[cadence]];
  if (reportType && MONTH_PARAMETER_REPORT_TYPES.includes(reportType)) rules = rules.filter((r) => r === 'previous_month' || r === 'month_to_date');
  if (reportType && WEEK_PARAMETER_REPORT_TYPES.includes(reportType)) rules = rules.filter((r) => r === 'previous_week');
  return rules;
}

/** "Monthly on day 1 at 07:00 · previous month" / "Weekly on Sunday at 07:00 · previous week" / "Every day at 07:30 · yesterday". */
export function cadenceSummary(t: T, s: Pick<ReportScheduleDto, 'cadence' | 'runDay' | 'runTime' | 'periodRule' | 'customFromDay' | 'customToDay'>): string {
  const when = s.cadence === 'weekly'
    ? t('cadence.weeklyOn', { day: fmtDate(`2024-01-${String(7 + s.runDay).padStart(2, '0')}`, 'cccc'), time: s.runTime.slice(0, 5) })
    : s.cadence === 'daily'
      ? t('cadence.dailyOn', { time: s.runTime.slice(0, 5) })
      : t('cadence.monthlyOn', { day: s.runDay, time: s.runTime.slice(0, 5) });
  const period = s.periodRule === 'custom' ? t('period.customRange', { from: s.customFromDay ?? '', to: s.customToDay ?? '' }) : t(`period.${s.periodRule}`);
  return `${when} · ${period}`;
}

/** Why a recipient was skipped: `missing_permission:report.export` → "Lacks report.export". */
export function skipReasonLabel(t: T, reason: string | null): string {
  if (!reason) return '';
  // an employee (no report access) can only ever receive the report about themselves
  if (reason === 'outside_scope:self') return t('skip.outside_self');
  const [code, detail] = reason.split(':');
  return t(`skip.${code}`, { defaultValue: reason, detail: detail ?? '' });
}
