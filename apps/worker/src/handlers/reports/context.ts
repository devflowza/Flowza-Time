import { DateTime } from 'luxon';
import { organizationSettingsSchema, reportParametersSchema, SETTINGS_GROUPS, type OrganizationSettings, type ReportFormat, type ReportParameters } from '@flowza/contracts';
import { errors } from '@flowza/shared';
import type { Trx } from '@flowza/database';
import { formatClock, formatGeneratedAt, formatHoursCell, formatIsoDate, legendItems, luxonDatePattern, reportLabel, resolveAttendanceCode, type AttendanceCode, type CodeInput, type CodeOverrides, type HoursNotation, type LegendItem, type ReportLabelKey, type TimeFormat } from '@flowza/domain';
import { asObject } from '../attendance/common.js';
import type { LegendEntry } from './model.js';

export interface ReportScope {
  /** Branches the report may include; null = the whole organisation. Intersected with the requester's injected scope. */
  branchIds: string[] | null;
  departmentId: string | null;
  employeeIds: string[] | null;
}

export interface LeaveTypeInfo { id: string; code: string; name: string; nameAr: string | null; isPaid: boolean; treatAsPresent: boolean }

/**
 * Everything a report definition needs about the tenant it renders for: identity, zone, locale, the settings that
 * decide notation and codes, the leave-type vocabulary, and the parameter scope — resolved once per report.
 */
export interface ReportContext {
  organizationId: string;
  company: string;
  timezone: string;
  locale: 'en' | 'ar';
  dir: 'ltr' | 'rtl';
  settings: OrganizationSettings;
  notation: HoursNotation;
  timeFormat: TimeFormat;
  datePattern: string;
  firstDayOfWeek: number;
  codeOverrides: CodeOverrides;
  leaveTypes: LeaveTypeInfo[];
  departments: Map<string, string>;
  params: ReportParameters & Record<string, unknown>;
  format: ReportFormat;
  scope: ReportScope;
  now: Date;
  /** Today's date in the organisation zone. */
  today: string;
  t(key: ReportLabelKey | string, vars?: Record<string, string | number>): string;
  code(input: CodeInput): AttendanceCode;
  /** Hours cell text in the tenant's notation; null/zero → dash. */
  hours(minutes: number | null | undefined, opts?: { zeroAsValue?: boolean }): string;
  clock(instant: string | Date | null | undefined, zone?: string): string;
  /** `YYYY-MM-DD` in the tenant's date format (or an explicit Luxon pattern). */
  date(isoDate: string, pattern?: string): string;
  /** `dd-MMM-yyyy`, the period wording the samples use in headers. */
  headerDate(isoDate: string): string;
  legend(): LegendEntry[] | null;
  generatedLabel(): string;
  pageLabel(page: string, total: string): string;
  notes(): string[];
}

function parseSettings(row: Record<string, unknown> | undefined): OrganizationSettings {
  const input: Record<string, unknown> = {};
  for (const g of SETTINGS_GROUPS) input[g] = asObject(row?.[g]);
  const parsed = organizationSettingsSchema.safeParse(input);
  return parsed.success ? parsed.data : organizationSettingsSchema.parse({});
}

const uuidList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);

/**
 * Branch scope = the explicit `branchId`, else the `branchIds`/`branchScope` the API injects for a branch-restricted
 * requester, else everything. When both are present the explicit choice must sit inside the injected scope — the API
 * already refuses anything else, so this is defence in depth, not the primary check.
 */
export function resolveScope(params: Record<string, unknown>): ReportScope {
  const branchId = typeof params['branchId'] === 'string' ? params['branchId'] : null;
  const injected = uuidList(params['branchScope']) ?? uuidList(params['branchIds']);
  let branchIds: string[] | null = branchId ? [branchId] : injected;
  if (branchId && injected && !injected.includes(branchId)) branchIds = injected;
  return { branchIds, departmentId: typeof params['departmentId'] === 'string' ? params['departmentId'] : null, employeeIds: uuidList(params['employeeIds']) };
}

export async function loadReportContext(trx: Trx, organizationId: string, request: { parameters: unknown; format: ReportFormat }, now: Date): Promise<ReportContext> {
  const org = await trx.selectFrom('organizations').select(['displayName', 'timezone', 'locale']).where('id', '=', organizationId).executeTakeFirst();
  if (!org) throw errors.notFound('Organization', organizationId);
  const settingsRow = await trx.selectFrom('organizationSettings').select(['general', 'attendance', 'sync', 'notifications', 'security', 'integrations', 'reports']).where('organizationId', '=', organizationId).executeTakeFirst();
  const settings = parseSettings(settingsRow as Record<string, unknown> | undefined);
  const rawParams = asObject(request.parameters);
  const parsed = reportParametersSchema.safeParse(rawParams);
  if (!parsed.success) throw errors.validation('Invalid report parameters.', { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const params = { ...rawParams, ...parsed.data } as ReportParameters & Record<string, unknown>;
  const locale: 'en' | 'ar' = params.locale ?? (org.locale === 'ar' ? 'ar' : 'en');
  const timezone = org.timezone || 'UTC';
  const leaveRows = await trx.selectFrom('leaveTypes').select(['id', 'code', 'name', 'nameAr', 'isPaid', 'treatAsPresent', 'createdAt']).where('organizationId', '=', organizationId).where('status', '=', 'active').orderBy('createdAt', 'asc').orderBy('code', 'asc').execute();
  const leaveTypes: LeaveTypeInfo[] = leaveRows.map((l) => ({ id: l.id, code: String(l.code), name: l.name, nameAr: l.nameAr, isPaid: l.isPaid, treatAsPresent: l.treatAsPresent }));
  const departmentRows = await trx.selectFrom('departments').select(['id', 'name', 'nameAr']).where('organizationId', '=', organizationId).execute();
  const departments = new Map(departmentRows.map((d) => [d.id, (locale === 'ar' && d.nameAr) || d.name]));

  const reports = settings.reports ?? {};
  const general = settings.general ?? {};
  const notation: HoursNotation = reports.hoursNotation ?? 'h.mm';
  const timeFormat: TimeFormat = general.timeFormat ?? '24h';
  const datePattern = luxonDatePattern(general.dateFormat ?? 'DD/MM/YYYY');
  const codeOverrides = (reports.codeOverrides ?? {}) as CodeOverrides;
  const t = (key: string, vars: Record<string, string | number> = {}) => reportLabel(locale, key, vars);
  const today = DateTime.fromJSDate(now).setZone(timezone).toISODate() ?? now.toISOString().slice(0, 10);

  return {
    organizationId, company: org.displayName, timezone, locale, dir: locale === 'ar' ? 'rtl' : 'ltr', settings, notation, timeFormat, datePattern,
    firstDayOfWeek: general.firstDayOfWeek ?? 0, codeOverrides, leaveTypes, departments, params, format: request.format, scope: resolveScope(rawParams), now, today,
    t,
    code: (input) => resolveAttendanceCode(input, codeOverrides),
    hours: (minutes, opts) => formatHoursCell(minutes, notation, opts),
    clock: (instant, zone) => formatClock(instant, zone ?? timezone, timeFormat, locale),
    date: (isoDate, pattern) => formatIsoDate(isoDate, pattern ?? datePattern, locale),
    headerDate: (isoDate) => formatIsoDate(isoDate, 'dd-MMM-yyyy', locale),
    legend: () => {
      if (reports.showLegend === false) return null;
      return legendItems(leaveTypes, locale, codeOverrides).map((i: LegendItem) => ({ code: i.code, label: i.label ?? (i.labelKey ? t(i.labelKey) : '') }));
    },
    generatedLabel: () => `${t('footer.generated')} ${formatGeneratedAt(now, timezone, timeFormat, locale)}`,
    pageLabel: (page, total) => t('footer.page', { page, total }),
    notes: () => [t('footer.rules', { notation: t(`notation.${notation}`) })],
  };
}
