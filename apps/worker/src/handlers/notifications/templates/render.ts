import { DateTime } from 'luxon';
import {
  NOTIFICATION_LOCALES, notificationEntry, readVar, resolveNotification,
  type NotificationAudience, type NotificationLocale, type ResolvedNotification,
} from '@flowza/contracts';
import { isValidTimezone } from '@flowza/shared';
import { en } from './en.js';
import { ar } from './ar.js';
import type { LocaleTemplates, NotificationTemplate, PluralForms } from './types.js';

export const NOTIFICATION_TEMPLATES: Readonly<Record<NotificationLocale, LocaleTemplates>> = { en, ar };

/** The recipient's language: their profile locale, else the organisation's, else English (unsupported values are skipped). */
export function pickLocale(profileLocale: string | null | undefined, orgLocale: string | null | undefined): NotificationLocale {
  for (const l of [profileLocale, orgLocale]) if (typeof l === 'string' && (NOTIFICATION_LOCALES as readonly string[]).includes(l)) return l as NotificationLocale;
  return 'en';
}

export interface RenderInput {
  type: string;
  /** `notifications.data` (whitelisted variables + routing facts) or, in the relay, the event payload with its aggregate. */
  data: Record<string, unknown>;
  locale: NotificationLocale;
  timezone: string;
  orgName: string;
  audience: NotificationAudience;
  /** The clock of the run (relative texts such as "pending for 26 hours"). */
  now: Date;
}
export interface RenderedNotification {
  title: string;
  body: string;
  subject: string;
  cta: string;
  /** Canonical web path (relative). */
  link: string;
  templateKey: string;
  resolved: ResolvedNotification | null;
}

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*(?:\|([^}]*))?\}\}/g;
/** One line of plain text: whitespace (incl. line breaks a comment may carry) collapsed, nothing that could break a header. */
const oneLine = (s: string) => s.replace(/[\s\p{Cc}]+/gu, ' ').trim();

/**
 * Replace `{{name}}` / `{{name|fallback}}`. Values are inserted once (a value that itself contains `{{…}}` is never
 * re-expanded). `strict`: a variable with no value and no fallback voids the whole string (null) — used for body parts.
 */
export function interpolate(template: string, vars: Readonly<Record<string, string>>, strict: boolean): string | null {
  let missing = false;
  const out = template.replace(VAR_RE, (_m, name: string, fallback: string | undefined) => {
    const v = vars[name];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (fallback !== undefined) return fallback;
    missing = true;
    return '';
  });
  if (strict && missing) return null;
  if (!missing) return oneLine(out);
  // non-strict: tidy what a missing variable leaves behind ("( )", doubled spaces, a dangling colon or separator)
  return oneLine(out.replace(/\(\s*\)/g, '')).replace(/\s*[:،,·]$/, '');
}

function plural(L: LocaleTemplates, forms: PluralForms, n: number): string {
  const rule = new Intl.PluralRules(L.locale).select(n);
  const tpl = forms[rule] ?? forms.other;
  return tpl.replace('{{n}}', fmtNumber(L, n));
}
function fmtNumber(L: LocaleTemplates, n: number): string {
  return new Intl.NumberFormat(L.locale, { useGrouping: false, maximumFractionDigits: 2 }).format(n);
}
function fmtDate(L: LocaleTemplates, isoDate: string): string {
  const d = DateTime.fromISO(isoDate.slice(0, 10), { zone: 'utc' });
  return d.isValid ? d.setLocale(L.locale).toFormat(L.formats.date) : isoDate;
}
function fmtInstant(L: LocaleTemplates, iso: string, zone: string, format: string): string {
  const d = DateTime.fromISO(iso, { zone: 'utc' });
  return d.isValid ? d.setZone(zone).setLocale(L.locale).toFormat(format) : iso;
}
function range(L: LocaleTemplates, from: string | null, to: string | null): string | null {
  if (!from) return to ? fmtDate(L, to) : null;
  if (!to || to === from) return fmtDate(L, from);
  return `${fmtDate(L, from)}${L.separators.range}${fmtDate(L, to)}`;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The template variables of one notification in one language: every catalogued variable formatted by its kind (dates in
 * the recipient's language, instants in the organisation's timezone), plus the composite phrases the templates use
 * (entity labels, date ranges, plurals, localised codes). A variable without a value is simply absent.
 */
export function templateVars(type: string, data: Readonly<Record<string, unknown>>, L: LocaleTemplates, timezone: string, orgName: string, now: Date): Record<string, string> {
  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  const vars: Record<string, string> = {};
  if (orgName.trim()) vars['org'] = oneLine(orgName);
  const entry = notificationEntry(type);
  const read = new Map<string, unknown>();
  for (const [key, kind] of Object.entries(entry?.vars ?? {})) {
    const v = readVar(kind, data[key]);
    if (v === null || v === undefined) continue;
    read.set(key, v);
    if (kind === 'text' || kind === 'code') vars[key] = oneLine(String(v));
    else if (kind === 'date') vars[key] = fmtDate(L, String(v));
    else if (kind === 'datetime') vars[key] = fmtInstant(L, String(v), zone, L.formats.dateTime);
    else if (kind === 'number') vars[key] = fmtNumber(L, v as number);
  }
  const get = (k: string) => read.get(k);

  // leave types: both names travel with the notice and the recipient's language picks one — an Arabic notice prints the Arabic
  // name when the type has one, never the English name or the code where a localised name exists (review 8-P2-2)
  const leaveTypeName = (L.locale === 'ar' ? str(get('leaveTypeNameAr')) : null) ?? str(get('leaveTypeName'));
  delete vars['leaveTypeNameAr'];
  if (leaveTypeName) vars['leaveTypeName'] = oneLine(leaveTypeName);
  else delete vars['leaveTypeName'];
  const leaveTypeLabel = leaveTypeName ?? str(get('leaveTypeCode'));
  if (leaveTypeLabel) vars['leaveTypeLabel'] = oneLine(leaveTypeLabel);

  // approvals: "Leave request — Ali Said", the leave type and dates (or the day), the level, how long it has waited
  const entityType = str(get('entityType'));
  if (entityType) {
    const label = (L.entities as Record<string, string>)[entityType] ?? entityType.replaceAll('_', ' ').toLowerCase();
    vars['entity'] = label;
    vars['item'] = vars['employeeName'] ? `${label} — ${vars['employeeName']}` : label;
  }
  const dateRange = range(L, str(get('date')), str(get('endDate')));
  const details = leaveTypeName && dateRange ? `${leaveTypeName}${L.separators.parts}${dateRange}` : dateRange ?? (L.locale === 'en' ? str(get('summary')) : null);
  if (details) vars['details'] = oneLine(details);
  const stepNo = num(get('stepNo'));
  if (stepNo !== null) vars['level'] = L.common.level.replace('{{stepNo}}', fmtNumber(L, stepNo));
  const waitingSince = str(get('waitingSince'));
  if (waitingSince) {
    const hours = Math.max(0, Math.floor((now.getTime() - Date.parse(waitingSince)) / 3_600_000));
    vars['waitingFor'] = hours < 48 ? plural(L, L.plurals.hours, Math.max(1, hours)) : plural(L, L.plurals.days, Math.floor(hours / 24));
  }
  const total = num(get('total'));
  if (total !== null) vars['approvalsCount'] = plural(L, L.plurals.approvals, total);
  const counts = get('counts');
  if (Array.isArray(counts) && counts.length > 0) {
    vars['countsList'] = (counts as Array<{ entityType: string; count: number }>).map((c) => `${(L.entities as Record<string, string>)[c.entityType] ?? c.entityType}: ${fmtNumber(L, c.count)}`).join(L.separators.parts);
  }

  // attendance
  const dates = get('dates');
  if (Array.isArray(dates) && dates.length > 0) {
    const list = (dates as string[]).slice(0, 5).map((d) => fmtDate(L, d)).join(L.separators.list);
    vars['dateList'] = dates.length > 5 ? `${list}${L.separators.list}…` : list;
  }
  const count = num(get('count')) ?? (Array.isArray(dates) ? dates.length : null);
  if (count !== null) vars['daysCount'] = plural(L, L.plurals.attendanceDays, count);
  if (get('autoDeduct') === true) vars['autoDeductNote'] = L.common.autoDeductNote;
  const payEffectDays = num(get('payEffectDays'));
  if (payEffectDays !== null && payEffectDays > 0) vars['payEffect'] = payEffectDays === 0.5 ? L.common.payEffect.half : payEffectDays === 1 ? L.common.payEffect.one : L.common.payEffect.other.replace('{{n}}', fmtNumber(L, payEffectDays));
  const direction = str(get('direction'));
  if (type === 'attendance.selfie_submitted' || type === 'attendance.selfie_decided' || type === 'attendance.punch_flagged') {
    const d = direction === 'out' ? 'out' : 'in';
    vars['selfieKind'] = L.common.selfieKind[d];
    vars['punchKind'] = L.common.punchKind[d];
  }
  const reason = str(get('reason'));
  if (reason && type === 'attendance.punch_flagged') vars['reasonText'] = L.geofenceReasons[reason] ?? reason.replaceAll('_', ' ');
  const distanceM = num(get('distanceM'));
  if (distanceM !== null) vars['distance'] = new Intl.NumberFormat(L.locale, { style: 'unit', unit: 'meter', unitDisplay: 'short', maximumFractionDigits: 0, useGrouping: false }).format(Math.round(distanceM));
  const regType = str(get('type'));
  if (regType && type === 'attendance.regularisation_decided') vars['regularisationType'] = L.regularisationTypes[regType] ?? regType.replaceAll('_', ' ');
  const firstInAt = str(get('firstInAt'));
  if (firstInAt) vars['firstInTime'] = fmtInstant(L, firstInAt, zone, L.formats.time);
  const expectedEndAt = str(get('expectedEndAt'));
  if (expectedEndAt) vars['endTime'] = fmtInstant(L, expectedEndAt, zone, L.formats.time);

  // leave
  const leaveRange = range(L, str(get('startDate')), str(get('endDate')));
  if (leaveRange) vars['range'] = leaveRange;
  const carried = num(get('carried'));
  if (carried !== null) vars['balancesCarried'] = plural(L, L.plurals.balances, carried);
  const totalDays = num(get('totalDays'));
  if (totalDays !== null) vars['totalDaysPhrase'] = plural(L, L.plurals.days, totalDays);
  const days = num(get('days'));
  if (days !== null) vars['compOffDays'] = plural(L, L.plurals.days, days);

  // reports
  const reportType = str(get('reportType'));
  const reportName = (reportType ? (L.reportTypes as Record<string, string>)[reportType] : undefined) ?? str(get('reportTitle'));
  if (reportName) vars['reportName'] = oneLine(reportName);
  const period = range(L, str(get('periodFrom')), str(get('periodTo')));
  if (period) vars['period'] = period;

  // devices, sync, system
  const jobType = str(get('jobType'));
  if (jobType) vars['jobTypeText'] = (L.syncJobTypes as Record<string, string>)[jobType] ?? jobType.replaceAll('_', ' ').toLowerCase();
  if (type === 'sync.finance.failed') vars['financeDirection'] = direction === 'pull' ? L.common.financeDirection.pull : direction === 'push' ? L.common.financeDirection.push : L.common.financeDirection.sync;
  // a connector failure code by its localised name (Settings → Integrations uses the same names); an unknown code as it is
  const code = str(get('code'));
  if (code && type === 'sync.finance.failed') vars['codeText'] = L.financeErrors[code] ?? code;
  const punches = num(get('punches'));
  if (punches !== null) vars['punchesPhrase'] = plural(L, L.plurals.punches, punches);
  const metric = str(get('metric'));
  if (metric) vars['metricText'] = L.metrics[metric] ?? metric.replaceAll('_', ' ');
  return vars;
}

/** The template of a key in a locale: the type's base template with the variant's overrides. */
export function templateFor(L: LocaleTemplates, type: string, templateKey: string): NotificationTemplate | null {
  const base = L.templates[type] as NotificationTemplate | undefined;
  if (!base || typeof base.title !== 'string' || !Array.isArray(base.body) || typeof base.cta !== 'string') return null;
  const override = templateKey === type ? {} : L.templates[templateKey] ?? {};
  return { ...base, ...override } as NotificationTemplate;
}

/**
 * Title, body, e-mail subject and call to action of one notification for one recipient, in their language, with the
 * catalogue's canonical link. A type without a catalogue entry or template (never expected — tests pin completeness)
 * falls back to the notification's own stored title / body, so nothing ever renders as "undefined".
 */
export function renderNotification(input: RenderInput, fallback?: { title: string; body: string | null; link: string | null }): RenderedNotification {
  const L = NOTIFICATION_TEMPLATES[input.locale] ?? en;
  const resolved = resolveNotification(input.type, input.data, { audience: input.audience, timezone: input.timezone });
  const tpl = resolved ? templateFor(L, input.type, resolved.templateKey) : null;
  if (!resolved || !tpl) {
    const title = oneLine(fallback?.title ?? input.type) || input.type;
    return { title, body: oneLine(fallback?.body ?? ''), subject: title, cta: L.common.brand, link: fallback?.link ?? '/notifications', templateKey: input.type, resolved };
  }
  const vars = templateVars(input.type, input.data, L, input.timezone, input.orgName, input.now);
  const title = interpolate(tpl.title, vars, false) || fallback?.title || input.type;
  const parts = tpl.body.map((p) => interpolate(p, vars, true)).filter((p): p is string => p !== null && p.trim() !== '');
  const body = parts.length > 0 ? parts.map(oneLine).join(L.separators.parts) : interpolate(tpl.bodyFallback ?? '', vars, false) ?? '';
  const subject = interpolate(tpl.subject ?? tpl.title, vars, false) || title;
  const cta = interpolate(tpl.cta, vars, false) || L.common.brand;
  return { title, body, subject, cta, link: resolved.link, templateKey: resolved.templateKey, resolved };
}

// ----- e-mail ----------------------------------------------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export interface EmailInput {
  rendered: Pick<RenderedNotification, 'title' | 'body' | 'subject' | 'cta'>;
  locale: NotificationLocale;
  orgName: string;
  /** Absolute URL of the call to action (web base + canonical link). */
  url: string;
  /** Absolute URL of the recipient's notification settings. */
  preferencesUrl: string;
  /** The notice ignores preferences (system / subscription): the footer says it cannot be switched off. */
  locked: boolean;
  /** One-click decision links (approval e-mails while the recipient's seat is pending); always with their security note. */
  oneClick?: { approve: string; reject: string } | null;
}
export interface RenderedEmail { subject: string; html: string; text: string }

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Tahoma,Helvetica,Arial,sans-serif";
/**
 * The branded e-mail: plain HTML (tables + inline styles, max 560 px, one call-to-action button), `lang` / `dir` for the
 * recipient's language, the organisation's name, and a plain-text alternative carrying the same content. Every dynamic
 * string is HTML-escaped here and only here.
 */
export function renderEmail(input: EmailInput): RenderedEmail {
  const L = NOTIFICATION_TEMPLATES[input.locale] ?? en;
  const e = escapeHtml;
  const start = L.dir === 'rtl' ? 'right' : 'left';
  const org = oneLine(input.orgName) || L.common.brand;
  const subject = oneLine(`[${org}] ${input.rendered.subject}`).slice(0, 250);
  const footer = interpolate(L.common.footer, { org }, false) ?? '';
  const oneClickHtml = input.oneClick ? `
<p style="margin:24px 0 8px;font-size:13px;line-height:1.5;color:#344054;">${e(L.common.oneClickHeading)}</p>
<p style="margin:0;font-size:14px;line-height:1.5;"><a href="${e(input.oneClick.approve)}" style="color:#047857;font-weight:600;text-decoration:underline;">${e(L.common.approve)}</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;<a href="${e(input.oneClick.reject)}" style="color:#b42318;font-weight:600;text-decoration:underline;">${e(L.common.reject)}</a></p>
<p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:#667085;">${e(L.common.oneClickNote)}</p>` : '';
  const footerTail = input.locked ? e(L.common.footerLocked) : `${e(L.common.footerPreferences)} <a href="${e(input.preferencesUrl)}" style="color:#047857;">${e(L.common.preferencesLink)}</a>`;
  const html = `<!doctype html>
<html lang="${L.locale}" dir="${L.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${e(input.rendered.body || input.rendered.title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
<tr><td dir="${L.dir}" style="padding:16px 24px;border-bottom:1px solid #e5e7eb;font-family:${FONT};font-size:13px;line-height:1.4;color:#475467;text-align:${start};"><strong style="color:#047857;">${e(L.common.brand)}</strong>&nbsp;&middot;&nbsp;${e(org)}</td></tr>
<tr><td dir="${L.dir}" style="padding:24px;font-family:${FONT};text-align:${start};">
<h1 style="margin:0 0 12px;font-size:18px;line-height:1.4;font-weight:600;color:#101828;">${e(input.rendered.title)}</h1>
${input.rendered.body ? `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#344054;">${e(input.rendered.body)}</p>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:6px;background-color:#047857;"><a href="${e(input.url)}" style="display:inline-block;padding:10px 20px;font-family:${FONT};font-size:14px;font-weight:600;line-height:1.4;color:#ffffff;text-decoration:none;border-radius:6px;">${e(input.rendered.cta)}</a></td></tr></table>${oneClickHtml}
<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#667085;">${e(L.common.linkFallback)}<br><a href="${e(input.url)}" style="color:#047857;word-break:break-all;">${e(input.url)}</a></p>
</td></tr>
<tr><td dir="${L.dir}" style="padding:16px 24px;border-top:1px solid #e5e7eb;font-family:${FONT};font-size:12px;line-height:1.5;color:#667085;text-align:${start};">${e(footer)} ${footerTail}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  const lines = [`${org} · ${L.common.brand}`, '', input.rendered.title];
  if (input.rendered.body) lines.push('', input.rendered.body);
  lines.push('', `${input.rendered.cta}: ${input.url}`);
  if (input.oneClick) lines.push('', L.common.oneClickHeading, `${L.common.approve}: ${input.oneClick.approve}`, `${L.common.reject}: ${input.oneClick.reject}`, L.common.oneClickNote);
  lines.push('', '—', footer, input.locked ? L.common.footerLocked : `${L.common.footerPreferences} ${input.preferencesUrl}`);
  return { subject, html, text: lines.join('\n') };
}
