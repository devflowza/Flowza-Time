import type { AttendanceRuleSetInput, ComplianceWarningDto, CountryRulePack } from '@flowza/contracts';

/**
 * A policy draft against a country rule pack (Enterprise, docs/enterprise/plan.md §5). Warnings, never errors: a company may
 * be stricter than the law, sector rules differ, and HR decides — the editor shows each warning next to its field. Only the
 * fields the pack has an opinion on are checked. Pure.
 */
export type CompliancePolicyDraft = Pick<AttendanceRuleSetInput, 'minFullDayMinutes' | 'overtimeMaxMinutesPerDay' | 'overtimeEnabled' | 'ramadanMode' | 'policy'>;

export function checkPolicyCompliance(draft: CompliancePolicyDraft, pack: CountryRulePack, context: { shiftScheduledMinutes?: readonly number[] } = {}): ComplianceWarningDto[] {
  const out: ComplianceWarningDto[] = [];
  const warn = (code: ComplianceWarningDto['code'], field: string, params: ComplianceWarningDto['params'], severity: ComplianceWarningDto['severity'] = 'warning') => out.push({ code, severity, field, params });

  if (draft.minFullDayMinutes > pack.dailyMinutes) warn('FULL_DAY_ABOVE_STATUTORY_DAY', 'minFullDayMinutes', { value: draft.minFullDayMinutes, law: pack.dailyMinutes });

  const lawOtCap = pack.maxDailyOvertimeMinutes ?? (pack.maxDailyWorkMinutes !== null ? pack.maxDailyWorkMinutes - pack.dailyMinutes : null);
  if (draft.overtimeEnabled && lawOtCap !== null) {
    const cap = draft.overtimeMaxMinutesPerDay ?? null;
    if (cap === null) warn('OVERTIME_CAP_MISSING', 'overtimeMaxMinutesPerDay', { law: lawOtCap }, 'info');
    else if (cap > lawOtCap) warn('OVERTIME_CAP_ABOVE_LAW', 'overtimeMaxMinutesPerDay', { value: cap, law: lawOtCap });
  }

  const ot = draft.policy.overtime;
  if (pack.maxDailyWorkMinutes !== null) {
    if (ot.maxDailyWorkMinutes === null) warn('MAX_DAILY_WORK_MISSING', 'policy.overtime.maxDailyWorkMinutes', { law: pack.maxDailyWorkMinutes }, 'info');
    else if (ot.maxDailyWorkMinutes > pack.maxDailyWorkMinutes) warn('MAX_DAILY_WORK_ABOVE_LAW', 'policy.overtime.maxDailyWorkMinutes', { value: ot.maxDailyWorkMinutes, law: pack.maxDailyWorkMinutes });
  }
  if (ot.weeklyThresholdMinutes === null) warn('WEEKLY_THRESHOLD_MISSING', 'policy.overtime.weeklyThresholdMinutes', { law: pack.weeklyMinutes }, 'info');
  else if (ot.weeklyThresholdMinutes > pack.weeklyMinutes) warn('WEEKLY_THRESHOLD_ABOVE_LAW', 'policy.overtime.weeklyThresholdMinutes', { value: ot.weeklyThresholdMinutes, law: pack.weeklyMinutes });

  for (const key of ['regular', 'weekly', 'weeklyOff', 'holiday'] as const) {
    if (ot.rates[key] < pack.overtimeRates[key]) warn('OVERTIME_RATE_BELOW_LAW', `policy.overtime.rates.${key}`, { rate: key, value: ot.rates[key], law: pack.overtimeRates[key] });
  }

  if (pack.ramadan) {
    const r = draft.ramadanMode;
    if (r.scheduledMinutes === undefined) warn('RAMADAN_NOT_CONFIGURED', 'ramadanMode.scheduledMinutes', { law: pack.ramadan.dailyMinutes, appliesTo: pack.ramadan.appliesTo }, 'info');
    else if (r.scheduledMinutes > pack.ramadan.dailyMinutes) warn('RAMADAN_HOURS_ABOVE_LAW', 'ramadanMode.scheduledMinutes', { value: r.scheduledMinutes, law: pack.ramadan.dailyMinutes });
  }

  const longest = Math.max(0, ...(context.shiftScheduledMinutes ?? []));
  if (longest > pack.dailyMinutes) warn('SHIFT_LONGER_THAN_STATUTORY_DAY', 'shiftId', { value: longest, law: pack.dailyMinutes });
  return out;
}
