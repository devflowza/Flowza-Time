/**
 * Country rule packs (Enterprise, attendance_policies — docs/enterprise/plan.md §5): the statutory working-time figures of
 * each country FlowZa Time sells into, kept OUT of the attendance engine. A pack is a starting point for a policy
 * (`policyDefaultsFromPack`) and the yardstick of the compliance check (`@flowza/domain` checkPolicyCompliance) — it never
 * changes a stored policy by itself. Figures are the general private-sector rules; sector, contract and collective rules
 * vary, so every pack says when it was last checked and against what, and the UI asks HR to confirm with counsel.
 */
import type { AttendanceRuleSetInput } from './attendance.js';

export const COUNTRY_PACK_CODES = ['OM', 'AE', 'SA', 'QA', 'KW', 'BH', 'IN'] as const;
export type CountryPackCode = (typeof COUNTRY_PACK_CODES)[number];

export interface CountryRulePack {
  code: CountryPackCode;
  /** Bumped whenever a figure changes; stored on a policy created from the pack (policy.countryPack.version). */
  version: string;
  name: string;
  nameAr: string;
  /** The statute the figures come from. */
  law: string;
  /** Where the figures were checked. */
  sources: readonly string[];
  verifiedOn: string;
  /** Usual weekly rest days (0 = Sunday … 6 = Saturday) — common practice, set on the organisation / branch, not the policy. */
  weeklyOffDays: readonly number[];
  /** Normal working time. */
  dailyMinutes: number;
  weeklyMinutes: number;
  /** Ceiling of regular + overtime work per day (null = the law sets none). */
  maxDailyWorkMinutes: number | null;
  /** Ceiling of overtime per day (null = none beyond maxDailyWorkMinutes). */
  maxDailyOvertimeMinutes: number | null;
  /** Reduced Ramadan hours; `flagged_employees` when the law reduces them for Muslim employees only. */
  ramadan: { dailyMinutes: number; weeklyMinutes: number | null; appliesTo: 'all' | 'flagged_employees' } | null;
  /** Minimum pay multipliers for overtime hours. */
  overtimeRates: { regular: number; weekly: number; weeklyOff: number; holiday: number };
  /** Night window with its minimum multiplier (informational until night overtime is computed — plan phase E4). */
  night: { start: string; end: string; rate: number } | null;
  notes: readonly string[];
}

const VERIFIED_ON = '2026-10-07';

export const COUNTRY_RULE_PACKS: Readonly<Record<CountryPackCode, CountryRulePack>> = {
  OM: {
    code: 'OM', version: '2026.10', name: 'Oman', nameAr: 'عُمان', law: 'Labour Law, Royal Decree 53/2023 (arts. 70–72)',
    sources: ['https://www.pwc.com/m1/en/services/tax/me-tax-legal-news/2023/sultanate-of-oman-key-changes-to-the-new-oman-labour-law.html', 'https://www.migrant-rights.org/wp-content/uploads/2023/09/Know-Your-Rights_Oman_-Labour-Law-as-of-Oct-9.pdf'],
    verifiedOn: VERIFIED_ON, weeklyOffDays: [5, 6], dailyMinutes: 480, weeklyMinutes: 2400, maxDailyWorkMinutes: 720, maxDailyOvertimeMinutes: 240,
    ramadan: { dailyMinutes: 360, weeklyMinutes: 1800, appliesTo: 'flagged_employees' },
    overtimeRates: { regular: 1.25, weekly: 1.25, weeklyOff: 2, holiday: 2 }, night: { start: '21:00', end: '05:00', rate: 1.5 },
    notes: ['Weekly rest of two consecutive days.', 'Continuous work may not exceed 6 hours without a break.', 'Rest-day / holiday work: 100% extra or a day off in lieu.'],
  },
  AE: {
    code: 'AE', version: '2026.10', name: 'United Arab Emirates', nameAr: 'الإمارات العربية المتحدة', law: 'Federal Decree-Law 33 of 2021 (arts. 17–19, 21, 28)',
    sources: ['https://u.ae/en/information-and-services/jobs/working-in-uae-private-sector/working-hours', 'https://www.zoho.com/en-ae/payroll/academy/compliance/working-hours-overtime-and-ramadan-rules-in-uae.html'],
    verifiedOn: VERIFIED_ON, weeklyOffDays: [0, 6], dailyMinutes: 480, weeklyMinutes: 2880, maxDailyWorkMinutes: 600, maxDailyOvertimeMinutes: 120,
    ramadan: { dailyMinutes: 360, weeklyMinutes: null, appliesTo: 'all' },
    overtimeRates: { regular: 1.25, weekly: 1.25, weeklyOff: 1.5, holiday: 1.5 }, night: { start: '22:00', end: '04:00', rate: 1.5 },
    notes: ['Ramadan: two hours less per day for every employee.', 'Rest-day / holiday work: a substitute day or 50% extra.'],
  },
  SA: {
    code: 'SA', version: '2026.10', name: 'Saudi Arabia', nameAr: 'المملكة العربية السعودية', law: 'Labor Law, Royal Decree M/51 (arts. 98–107)',
    sources: ['https://blog.zenhr.com/en/overtime-calculation-in-saudi-arabia-a-complete-guide-2025-update', 'https://ksaexpats.com/working-hours-saudi-arabia-expats/'],
    verifiedOn: VERIFIED_ON, weeklyOffDays: [5, 6], dailyMinutes: 480, weeklyMinutes: 2880, maxDailyWorkMinutes: 660, maxDailyOvertimeMinutes: null,
    ramadan: { dailyMinutes: 360, weeklyMinutes: 2160, appliesTo: 'flagged_employees' },
    overtimeRates: { regular: 1.5, weekly: 1.5, weeklyOff: 1.5, holiday: 1.5 }, night: null,
    notes: ['Overtime is paid at least 150% of the hourly wage, including rest days and public holidays.'],
  },
  QA: {
    code: 'QA', version: '2026.10', name: 'Qatar', nameAr: 'قطر', law: 'Labour Law 14 of 2004 (arts. 73–76)',
    sources: ['https://www.cercli.com/resources/overtime-calculation-in-qatar', 'https://www.cercli.com/resources/qatar-labour-law-working-hours'],
    verifiedOn: VERIFIED_ON, weeklyOffDays: [5], dailyMinutes: 480, weeklyMinutes: 2880, maxDailyWorkMinutes: 600, maxDailyOvertimeMinutes: 120,
    ramadan: { dailyMinutes: 360, weeklyMinutes: 2160, appliesTo: 'flagged_employees' },
    overtimeRates: { regular: 1.25, weekly: 1.25, weeklyOff: 1.5, holiday: 1.5 }, night: { start: '21:00', end: '06:00', rate: 1.5 },
    notes: ['Friday is the statutory weekly rest day.', 'No more than five consecutive hours without a break.'],
  },
  KW: {
    code: 'KW', version: '2026.10', name: 'Kuwait', nameAr: 'الكويت', law: 'Private Sector Labour Law 6 of 2010 (arts. 64–68)',
    sources: ['https://www.rivermate.com/guides/kuwait/working-hours', 'https://www.mondaq.com/employment-and-hr/117616/labour-law-in-kuwait'],
    verifiedOn: VERIFIED_ON, weeklyOffDays: [5], dailyMinutes: 480, weeklyMinutes: 2880, maxDailyWorkMinutes: 600, maxDailyOvertimeMinutes: 120,
    ramadan: { dailyMinutes: 360, weeklyMinutes: 2160, appliesTo: 'all' },
    overtimeRates: { regular: 1.25, weekly: 1.25, weeklyOff: 1.5, holiday: 2 }, night: null,
    notes: ['Overtime at most 2 hours a day, 6 hours a week and 180 hours a year.'],
  },
  BH: {
    code: 'BH', version: '2026.10', name: 'Bahrain', nameAr: 'البحرين', law: 'Labour Law for the Private Sector 36 of 2012 (arts. 51–55)',
    sources: ['https://www.playroll.com/working-hours/bahrain', 'https://rivermate.com/guides/bahrain/working-hours'],
    verifiedOn: VERIFIED_ON, weeklyOffDays: [5], dailyMinutes: 480, weeklyMinutes: 2880, maxDailyWorkMinutes: 600, maxDailyOvertimeMinutes: null,
    ramadan: { dailyMinutes: 360, weeklyMinutes: 2160, appliesTo: 'flagged_employees' },
    overtimeRates: { regular: 1.25, weekly: 1.25, weeklyOff: 1.5, holiday: 1.5 }, night: { start: '19:00', end: '07:00', rate: 1.5 },
    notes: ['A meal break of at least 30 minutes after six consecutive hours.'],
  },
  IN: {
    code: 'IN', version: '2026.10', name: 'India', nameAr: 'الهند', law: 'Factories Act 1948 (ss. 51, 54, 59) — state Shops & Establishments Acts may differ',
    sources: ['https://labour.gov.in/sites/default/files/factories_act_1948.pdf'],
    verifiedOn: VERIFIED_ON, weeklyOffDays: [0], dailyMinutes: 540, weeklyMinutes: 2880, maxDailyWorkMinutes: 600, maxDailyOvertimeMinutes: null,
    ramadan: null,
    overtimeRates: { regular: 2, weekly: 2, weeklyOff: 2, holiday: 2 }, night: null,
    notes: ['Overtime is paid at twice the ordinary rate.', 'Shops & Establishments rules are set per state.'],
  },
};

export function countryRulePack(code: string | null | undefined): CountryRulePack | null {
  return code && (COUNTRY_PACK_CODES as readonly string[]).includes(code) ? COUNTRY_RULE_PACKS[code as CountryPackCode] : null;
}

/**
 * The fields of a new policy that a country pack fills in (the editor merges them into its form; HR reviews every one).
 * Ramadan mode is prepared with the pack's hours but left OFF: its dates move every year and HR switches it on with them.
 */
export function policyDefaultsFromPack(pack: CountryRulePack): Pick<AttendanceRuleSetInput, 'countryCode' | 'minFullDayMinutes' | 'halfDayThresholdMinutes' | 'overtimeMaxMinutesPerDay' | 'ramadanMode'> & {
  policy: { countryPack: { code: string; version: string }; overtime: { weeklyThresholdMinutes: number; maxDailyWorkMinutes: number | null; rates: CountryRulePack['overtimeRates'] } };
} {
  const otCap = pack.maxDailyOvertimeMinutes ?? (pack.maxDailyWorkMinutes !== null ? Math.max(0, pack.maxDailyWorkMinutes - pack.dailyMinutes) : null);
  return {
    countryCode: pack.code,
    minFullDayMinutes: pack.dailyMinutes,
    halfDayThresholdMinutes: Math.round(pack.dailyMinutes / 2),
    overtimeMaxMinutesPerDay: otCap,
    ramadanMode: pack.ramadan
      ? { enabled: false, scheduledMinutes: pack.ramadan.dailyMinutes, appliesTo: pack.ramadan.appliesTo }
      : { enabled: false, appliesTo: 'all' },
    policy: { countryPack: { code: pack.code, version: pack.version }, overtime: { weeklyThresholdMinutes: pack.weeklyMinutes, maxDailyWorkMinutes: pack.maxDailyWorkMinutes, rates: { ...pack.overtimeRates } } },
  };
}
