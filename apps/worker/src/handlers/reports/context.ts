import { DateTime } from 'luxon';
import { organizationSettingsSchema, reportParametersSchema, SETTINGS_GROUPS, type OrganizationSettings, type ReportFormat, type ReportParameters } from '@flowza/contracts';
import { AppError, errors } from '@flowza/shared';
import { resolveLocationFilter, type LocationFilter, type Trx } from '@flowza/database';
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

/** `a ∩ b`, where a null `b` means "no restriction" (then `a`, deduplicated). */
function intersect(a: readonly string[], b: readonly string[] | null): string[] {
  const unique = [...new Set(a)];
  if (b === null) return unique;
  const allowed = new Set(b);
  return unique.filter((x) => allowed.has(x));
}

/**
 * A `locationId` parameter (docs/locations.md §2) can only NARROW the scope `resolveScope` built from the explicit and injected
 * parameters: a group / branch location → branchIds = its branches ∩ the scope's branches; a place → branchIds = [its branch] ∩
 * the scope's branches, employeeIds = the employees working in it or below (`placeEmployeeIds`) ∩ any explicit / injected
 * employees. An empty intersection stays empty (an empty list selects nobody — never everyone).
 */
export function narrowScopeToLocation(scope: ReportScope, filter: LocationFilter, placeEmployeeIds: readonly string[]): ReportScope {
  if (filter.kind === 'branches') return { ...scope, branchIds: intersect(filter.branchIds, scope.branchIds) };
  return { ...scope, branchIds: intersect([filter.branchId], scope.branchIds), employeeIds: intersect(placeEmployeeIds, scope.employeeIds) };
}

/**
 * Resolves the `locationId` parameter in the organisation's system context (the API checked that the requester could see it)
 * and narrows `scope` with it. A location that does not exist (any more) fails the report rather than widening it.
 */
export async function applyLocationScope(trx: Trx, organizationId: string, locationId: string | null | undefined, scope: ReportScope): Promise<ReportScope> {
  if (!locationId) return scope;
  let filter: LocationFilter;
  try {
    filter = await resolveLocationFilter(trx, organizationId, locationId);
  } catch (err) {
    if (AppError.is(err) && err.code === 'NOT_FOUND') throw errors.validation('The report location no longer exists.', { issues: [{ path: 'parameters.locationId', message: 'Unknown location' }] });
    throw err;
  }
  const placeEmployeeIds = filter.kind === 'places'
    ? (await trx.selectFrom('employees').select('id').where('organizationId', '=', organizationId).where('workLocationId', 'in', filter.placeIds).execute()).map((e) => e.id)
    : [];
  return narrowScopeToLocation(scope, filter, placeEmployeeIds);
}

export async function loadReportContext(trx: Trx, organizationId: string, request: { parameters: unknown; format: ReportFormat }, now: Date): Promise<ReportContext> {
  const org = await trx.selectFrom('organizations').select(['displayName', 'timezone', 'locale']).where('id', '=', organizationId).executeTakeFirst();
  if (!org) throw errors.notFound('Organization', organizationId);
  const settingsRow = await trx.selectFrom('organizationSettings').select(['general', 'attendance', 'sync', 'notifications', 'security', 'integrations', 'reports', 'dashboard']).where('organizationId', '=', organizationId).executeTakeFirst();
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
  const scope = await applyLocationScope(trx, organizationId, params.locationId, resolveScope(rawParams));

  return {
    organizationId, company: org.displayName, timezone, locale, dir: locale === 'ar' ? 'rtl' : 'ltr', settings, notation, timeFormat, datePattern,
    firstDayOfWeek: general.firstDayOfWeek ?? 0, codeOverrides, leaveTypes, departments, params, format: request.format, scope, now, today,
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
