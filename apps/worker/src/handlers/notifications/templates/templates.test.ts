import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_CATALOGUE, NOTIFICATION_LOCALES, notificationTemplateKeys, resolveNotification,
  type NotificationAudience, type NotificationCatalogueEntry, type NotificationLocale, type NotificationVarKind,
} from '@flowza/contracts';
import { ROUTING } from '../outbox.js';
import { NOTIFICATION_TEMPLATES, escapeHtml, interpolate, pickLocale, renderEmail, renderNotification, templateFor } from './render.js';

/**
 * Every notification the relay can write renders in English and Arabic: per catalogue entry and per outcome variant, the
 * title / body / subject / call to action are non-empty, carry no placeholder or "undefined", the deep link is the
 * canonical path, and the e-mail escapes every value. Snapshot-free: the assertions are properties, plus a table of links.
 */
const ID = {
  request: 'aaaaaaaa-0000-4000-8000-000000000001', entity: 'aaaaaaaa-0000-4000-8000-000000000002', employee: 'aaaaaaaa-0000-4000-8000-000000000003',
  aggregate: 'aaaaaaaa-0000-4000-8000-000000000004', leave: 'aaaaaaaa-0000-4000-8000-000000000005', device: 'aaaaaaaa-0000-4000-8000-000000000006',
  syncJob: 'aaaaaaaa-0000-4000-8000-000000000007', report: 'aaaaaaaa-0000-4000-8000-000000000008', import: 'aaaaaaaa-0000-4000-8000-000000000009',
  approvalRequest: 'aaaaaaaa-0000-4000-8000-00000000000a',
};
const XSS = 'Ali <b>&</b> "Q"';
const XSS_ESCAPED = escapeHtml(XSS);
const TZ = 'Asia/Muscat';
const NOW = new Date('2026-09-16T08:00:00Z');

const BY_KIND: Record<NotificationVarKind, unknown> = {
  text: XSS, date: '2026-09-15', datetime: '2026-09-15T05:30:00Z', number: 2, dates: ['2026-09-10', '2026-09-11'], code: 'X', flag: true,
  counts: [{ entityType: 'LEAVE', count: 2 }, { entityType: 'ATTENDANCE_CORRECTION', count: 1 }],
};
const BY_KEY: Record<string, unknown> = {
  entityType: 'LEAVE', kind: 'reminder', decision: 'APPROVED', direction: 'in', outcome: 'flagged', type: 'missed_punch', chargeOutcome: 'lop', leaveTypeCode: 'AL',
  endSource: 'shift', jobType: 'PULL_ATTENDANCE', code: 'HTTP_500', metric: 'employees', mode: 'scheduled', phase: 'finished', reportType: 'monthly_attendance', format: 'pdf',
  audience: 'employee', stepNo: 2, payEffectDays: 0.5, distanceM: 120.4, hours: 2, fromYear: 2025, toYear: 2026, carried: 4, totalDays: 12.5, days: 1, credits: 1,
  itemsSuccess: 10, itemsFailed: 0, consecutiveFailures: 3, punches: 7, limit: 50, validRows: 20, imported: 18, total: 3, count: 2,
  waitingSince: '2026-09-15T02:00:00Z', firstInAt: '2026-09-15T04:10:00Z', expectedEndAt: '2026-09-15T13:00:00Z', at: '2026-09-15T05:30:00Z',
};
/** Per-type code values that differ from the shared defaults. */
const TYPE_KEY: Record<string, Record<string, unknown>> = {
  'attendance.punch_flagged': { reason: 'outside' },
  'sync.finance.failed': { reason: 'streak', direction: 'pull' },
};

function samplePayload(entry: NotificationCatalogueEntry): Record<string, unknown> {
  const p: Record<string, unknown> = {
    requestId: ID.request, entityId: ID.entity, employeeId: ID.employee, leaveRecordId: ID.leave, approvalRequestId: ID.approvalRequest,
    deviceId: ID.device, syncJobId: ID.syncJob, reportId: ID.report, importId: ID.import, aggregateType: 'test', aggregateId: ID.aggregate,
  };
  for (const [key, kind] of Object.entries(entry.vars)) p[key] = TYPE_KEY[entry.type]?.[key] ?? (key in BY_KEY && kind !== 'text' ? BY_KEY[key] : BY_KIND[kind]);
  return p;
}

/** What selects each outcome variant (payload overrides and / or the recipient's audience). */
const VARIANT_INPUT: Record<string, { payload?: Record<string, unknown>; audience?: NotificationAudience }> = {
  'approval.pending#reassigned': { payload: { reassigned: true } },
  'approval.reminder#reminder': { payload: { kind: 'reminder' } },
  'approval.reminder#digest': { payload: { kind: 'digest' } },
  'approval.decided#APPROVED': { payload: { decision: 'APPROVED' } },
  'approval.decided#REJECTED': { payload: { decision: 'REJECTED' } },
  'approval.decided#CANCELLED': { payload: { decision: 'CANCELLED' } },
  'approval.decided#INVALIDATED': { payload: { decision: 'INVALIDATED' } },
  'attendance.unexcused_marked#self': { audience: 'subject' },
  'attendance.unexcused_marked#manager': { audience: 'other' },
  'attendance.note_decided#approved': { payload: { decision: 'approved' } },
  'attendance.note_decided#excused': { payload: { decision: 'excused' } },
  'attendance.note_decided#rejected': { payload: { decision: 'rejected', payEffectDays: 0, chargeOutcome: 'none', lossOfPay: false } },
  'attendance.note_decided#rejected_leave': { payload: { decision: 'rejected', payEffectDays: 0.5, chargeOutcome: 'charged_leave', lossOfPay: false } },
  'attendance.note_decided#rejected_lop': { payload: { decision: 'rejected', payEffectDays: 1, chargeOutcome: 'lop', lossOfPay: true } },
  'attendance.selfie_submitted#in': { payload: { direction: 'in' } },
  'attendance.selfie_submitted#out': { payload: { direction: 'out' } },
  'attendance.selfie_decided#approved': { payload: { decision: 'approved' } },
  'attendance.selfie_decided#rejected': { payload: { decision: 'rejected' } },
  'attendance.punch_flagged#denied': { payload: { outcome: 'denied' } },
  'attendance.punch_flagged#flagged': { payload: { outcome: 'flagged' } },
  'attendance.regularisation_decided#approved': { payload: { decision: 'approved' } },
  'attendance.regularisation_decided#rejected': { payload: { decision: 'rejected' } },
  'punch.missing_out#shift': { payload: { endSource: 'shift' } },
  'punch.missing_out#default': { payload: { endSource: 'default' } },
  'shift.swap_decided#approved': { payload: { decision: 'approved' } },
  'shift.swap_decided#rejected': { payload: { decision: 'rejected' } },
  'leave.comment_added#employee': { payload: { audience: 'employee' } },
  'leave.comment_added#approvers': { payload: { audience: 'approvers' } },
  'report.scheduled_delivery#send_now': { payload: { mode: 'send_now' } },
  'report.scheduled_delivery#scheduled': { payload: { mode: 'schedule' } },
  'sync.finance.failed#streak': { payload: { reason: 'streak' } },
  'sync.finance.failed#batch_skipped': { payload: { reason: 'batch_skipped' } },
  'employee.imported#queued': { payload: { phase: 'queued' } },
  'employee.imported#finished': { payload: { phase: 'finished' } },
};

/** The canonical web path of each template key for the sample payload. */
function expectedLink(key: string): string {
  const [type] = key.split('#') as [string];
  if (key === 'approval.reminder#digest') return '/approvals';
  if (type.startsWith('approval.')) return `/approvals?request=${ID.request}`;
  const table: Record<string, string> = {
    'attendance.unexcused_marked#self': '/my/attendance?month=2026-09',
    'attendance.unexcused_marked#manager': `/attendance?employeeId=${ID.employee}`,
    'attendance.note_submitted': `/approvals?request=${ID.approvalRequest}`,
    'attendance.note_info_requested': '/my/requests?tab=reasons&date=2026-09-15',
    'shift.swap_requested': '/my/shift?date=2026-09-15',
    'leave.requested': '/leave?status=PENDING',
    'leave.approved': `/my/leave?request=${ID.aggregate}`,
    'leave.rejected': `/my/leave?request=${ID.aggregate}`,
    'leave.info_requested': `/my/leave?request=${ID.leave}`,
    'leave.comment_added#employee': `/my/leave?request=${ID.leave}`,
    'leave.comment_added#approvers': `/approvals?request=${ID.approvalRequest}`,
    'leave.year_closed': '/leave?tab=allocations',
    'leave.comp_off_expired': '/my/leave',
    'report.ready': '/reports',
    'report.failed': '/reports',
    'device.offline': `/devices/${ID.device}`,
    'device.online': `/devices/${ID.device}`,
    'sync.failed': `/sync/${ID.syncJob}`,
    'sync.completed': `/sync/${ID.syncJob}`,
    'subscription.limit_reached': '/settings/subscription',
  };
  if (table[key]) return table[key]!;
  const byType: Record<string, string> = {
    'attendance.note_decided': '/my/requests?tab=reasons&date=2026-09-15',
    'attendance.selfie_submitted': '/attendance/notes?tab=selfies',
    'attendance.selfie_decided': '/my/requests?tab=selfies&date=2026-09-15',
    'attendance.punch_flagged': `/attendance?employeeId=${ID.employee}&date=2026-09-15`,
    'attendance.regularisation_decided': '/my/requests?tab=regularisations&date=2026-09-15',
    'punch.missing_out': '/my',
    'shift.swap_decided': '/my/shift?date=2026-09-15',
    'report.scheduled_delivery': `/reports?download=${ID.report}`,
    'sync.finance.failed': '/settings/integrations',
    'employee.imported': `/employees/import?importId=${ID.aggregate}`,
  };
  if (byType[type]) return byType[type]!;
  throw new Error(`no expected link for ${key}`);
}

/** Every (template key, payload, audience) combination the catalogue can render. */
function cases(): Array<{ key: string; type: string; payload: Record<string, unknown>; audience: NotificationAudience }> {
  const out: Array<{ key: string; type: string; payload: Record<string, unknown>; audience: NotificationAudience }> = [];
  for (const entry of Object.values(NOTIFICATION_CATALOGUE)) {
    const base = samplePayload(entry);
    if (entry.type === 'employee.imported') base['importId'] = undefined; // imports link by their aggregate id
    const variantKeys = Object.keys(entry.variants).map((v) => `${entry.type}#${v}`);
    if (variantKeys.length === 0) out.push({ key: entry.type, type: entry.type, payload: base, audience: 'other' });
    for (const key of variantKeys) {
      const input = VARIANT_INPUT[key];
      if (!input) throw new Error(`no variant input for ${key}`);
      out.push({ key, type: entry.type, payload: { ...base, ...(input.payload ?? {}) }, audience: input.audience ?? 'other' });
    }
  }
  return out;
}

const BAD = [/\{\{/, /\}\}/, /undefined/, /\bnull\b/, /NaN/, /\[object/];
const clean = (s: string) => BAD.every((re) => !re.test(s));

describe('notification templates', () => {
  it('both languages carry exactly the catalogue\'s template keys, each with a title and a call to action', () => {
    const expected = Object.values(NOTIFICATION_CATALOGUE).flatMap(notificationTemplateKeys).sort();
    for (const locale of NOTIFICATION_LOCALES) {
      const L = NOTIFICATION_TEMPLATES[locale];
      expect(Object.keys(L.templates).sort()).toEqual(expected);
      for (const entry of Object.values(NOTIFICATION_CATALOGUE)) {
        const base = L.templates[entry.type]!;
        expect(base.title, `${locale} ${entry.type} title`).toBeTruthy();
        expect(base.cta, `${locale} ${entry.type} cta`).toBeTruthy();
        expect(Array.isArray(base.body), `${locale} ${entry.type} body`).toBe(true);
      }
    }
  });

  it('every ROUTING type has a catalogue entry and every catalogue entry is routed', () => {
    expect(Object.keys(ROUTING).sort()).toEqual(Object.keys(NOTIFICATION_CATALOGUE).sort());
  });

  it('every outcome variant is reachable from a payload', () => {
    for (const c of cases()) {
      const resolved = resolveNotification(c.type, c.payload, { audience: c.audience, timezone: TZ });
      expect(resolved?.templateKey, c.key).toBe(c.key);
    }
  });

  for (const locale of NOTIFICATION_LOCALES) {
    it(`renders every catalogue entry and variant in ${locale}: texts complete, link canonical, e-mail escaped`, () => {
      for (const c of cases()) {
        const r = renderNotification({ type: c.type, data: c.payload, locale, timezone: TZ, orgName: 'Acme & <Co>', audience: c.audience, now: NOW });
        const where = `${locale} ${c.key}`;
        expect(r.templateKey, where).toBe(c.key);
        for (const [field, value] of Object.entries({ title: r.title, body: r.body, subject: r.subject, cta: r.cta })) {
          expect(value.trim().length, `${where} ${field} empty`).toBeGreaterThan(0);
          expect(clean(value), `${where} ${field}: ${value}`).toBe(true);
        }
        expect(r.link, where).toBe(expectedLink(c.key));
        const mail = renderEmail({ rendered: r, locale, orgName: 'Acme & <Co>', url: `https://app.example${r.link}`, preferencesUrl: 'https://app.example/my/profile', locked: !r.resolved!.entry.userConfigurable, oneClick: null });
        expect(mail.html, where).toContain(`lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`);
        expect(mail.html, where).not.toContain('<b>&</b>');
        expect(mail.html, where).not.toContain('Acme & <Co>');
        expect(mail.html, where).toContain('Acme &amp; &lt;Co&gt;');
        if (`${r.title} ${r.body}`.includes(XSS)) expect(mail.html, where).toContain(XSS_ESCAPED);
        expect(mail.html, where).toContain(`href="https://app.example${escapeHtml(r.link)}"`);
        expect(mail.text, where).toContain(`https://app.example${r.link}`);
        expect(clean(mail.subject) && clean(mail.text), where).toBe(true);
        expect((mail.html.match(/background-color:#047857;"><a /g) ?? []).length, `${where} one CTA button`).toBe(1);
      }
    });
  }

  it('Arabic texts are Arabic (every template key differs from English)', () => {
    for (const c of cases()) {
      const en = renderNotification({ type: c.type, data: c.payload, locale: 'en', timezone: TZ, orgName: 'Acme', audience: c.audience, now: NOW });
      const ar = renderNotification({ type: c.type, data: c.payload, locale: 'ar', timezone: TZ, orgName: 'Acme', audience: c.audience, now: NOW });
      expect(ar.title, c.key).not.toBe(en.title);
      expect(/[؀-ۿ]/.test(ar.title), `${c.key}: ${ar.title}`).toBe(true);
      expect(/[؀-ۿ]/.test(ar.cta), `${c.key}: ${ar.cta}`).toBe(true);
    }
  });

  it('missing variables fall back safely: an empty payload still renders a clean title, subject and call to action', () => {
    for (const entry of Object.values(NOTIFICATION_CATALOGUE)) {
      for (const locale of NOTIFICATION_LOCALES) {
        const r = renderNotification({ type: entry.type, data: {}, locale, timezone: TZ, orgName: '', audience: 'other', now: NOW });
        for (const v of [r.title, r.body, r.subject, r.cta]) expect(clean(v), `${locale} ${entry.type}: ${v}`).toBe(true);
        expect(r.title.trim().length, `${locale} ${entry.type}`).toBeGreaterThan(0);
        expect(r.link.startsWith('/'), `${locale} ${entry.type}`).toBe(true);
        expect(r.link, `${locale} ${entry.type}`).not.toMatch(/undefined|null|=&|=$/);
      }
    }
  });

  it('dates and times follow the organisation timezone and the recipient language', () => {
    // 20:30 UTC on 15 Sept is 00:30 on 16 Sept in Muscat
    const en = renderNotification({ type: 'attendance.selfie_submitted', data: { employeeName: 'Sara', direction: 'out', at: '2026-09-15T20:30:00Z', employeeId: ID.employee }, locale: 'en', timezone: TZ, orgName: 'Acme', audience: 'other', now: NOW });
    expect(en.title).toBe('Selfie check-out from Sara');
    expect(en.body).toBe('16 Sep 2026, 00:30');
    const ar = renderNotification({ type: 'attendance.selfie_submitted', data: { employeeName: 'Sara', direction: 'out', at: '2026-09-15T20:30:00Z' }, locale: 'ar', timezone: TZ, orgName: 'Acme', audience: 'other', now: NOW });
    expect(ar.body).toContain('سبتمبر');
    // the same instant in a timezone behind UTC stays on the 15th
    const ny = renderNotification({ type: 'attendance.selfie_submitted', data: { employeeName: 'Sara', at: '2026-09-15T20:30:00Z' }, locale: 'en', timezone: 'America/New_York', orgName: 'Acme', audience: 'other', now: NOW });
    expect(ny.body).toBe('15 Sep 2026, 16:30');
  });

  it('outcome-specific texts: a rejected reason says what it cost; a question carries the question; an escalation and a reminder say so', () => {
    const r = (type: string, data: Record<string, unknown>, audience: NotificationAudience = 'other') => renderNotification({ type, data, locale: 'en', timezone: TZ, orgName: 'Acme', audience, now: NOW });
    expect(r('attendance.note_decided', { decision: 'rejected', attendanceDate: '2026-09-15', payEffectDays: 0.5, chargeOutcome: 'charged_leave', leaveTypeCode: 'AL', reason: 'No proof' }).body).toBe('Half a day deducted from your AL balance · Reason: No proof');
    expect(r('attendance.note_decided', { decision: 'rejected', attendanceDate: '2026-09-15', payEffectDays: 1, chargeOutcome: 'lop', lossOfPay: true }).body).toBe('One day recorded as loss of pay');
    expect(r('attendance.note_decided', { decision: 'rejected', attendanceDate: '2026-09-15', payEffectDays: 0 }).body).toBe('No pay effect was applied.');
    expect(r('leave.info_requested', { question: 'Which city?', leaveTypeName: 'Annual', startDate: '2026-10-01', endDate: '2026-10-03' }).body).toBe('Which city? · Annual · 1 Oct 2026 → 3 Oct 2026');
    expect(r('approval.escalated', { entityType: 'OVERTIME_CLAIM', employeeName: 'Omar', stepNo: 1, date: '2026-09-14' }).title).toBe('Escalated to you: Overtime claim — Omar');
    const reminder = r('approval.reminder', { kind: 'reminder', entityType: 'REGULARISATION', employeeName: 'Omar', waitingSince: '2026-09-15T08:00:00Z', date: '2026-09-14' });
    expect(reminder.title).toBe('Reminder: Regularisation — Omar is waiting for your approval');
    expect(reminder.body).toBe('Pending for 24 hours · 14 Sep 2026');
    expect(r('attendance.unexcused_marked', { dates: ['2026-09-10'], count: 1, autoDeduct: true, employeeName: 'Omar' }, 'subject').title).toBe('Your attendance: 1 attendance day marked unexcused');
    expect(r('attendance.unexcused_marked', { dates: ['2026-09-10'], count: 1, employeeName: 'Omar' }, 'other').title).toBe('Omar: 1 attendance day marked unexcused');
  });

  it('interpolation: values are inserted once (never re-expanded), a missing strict part is dropped, fallbacks apply', () => {
    expect(interpolate('Hi {{name}}', { name: '{{secret}}' }, false)).toBe('Hi {{secret}}');
    expect(interpolate('Reason: {{reason}}', {}, true)).toBeNull();
    expect(interpolate('Leave: {{kind|your leave}}', {}, false)).toBe('Leave: your leave');
    expect(interpolate('Report ready: {{name}}', {}, false)).toBe('Report ready');
    expect(interpolate('A · {{b}}', { b: 'x\r\nBcc: evil@example.com' }, false)).toBe('A · x Bcc: evil@example.com');
  });

  it('picks the recipient language: profile, else organisation, else English', () => {
    expect(pickLocale('ar', 'en')).toBe<NotificationLocale>('ar');
    expect(pickLocale('fr', 'ar')).toBe('ar');
    expect(pickLocale(null, 'de')).toBe('en');
  });

  it('the e-mail layout: one-click block with its security copy, locked footer for system notices, plain-text alternative', () => {
    const rendered = { title: 'T', body: 'B', subject: 'S', cta: 'Open' };
    const mail = renderEmail({ rendered, locale: 'en', orgName: 'Acme', url: 'https://app.example/approvals?request=1', preferencesUrl: 'https://app.example/my/profile', locked: false, oneClick: { approve: 'https://app.example/approvals/email-action?org=o&action=APPROVE&token=a', reject: 'https://app.example/approvals/email-action?org=o&action=REJECT&token=b' } });
    expect(mail.subject).toBe('[Acme] S');
    expect(mail.html).toContain('action=APPROVE&amp;token=a');
    expect(mail.html).toContain(NOTIFICATION_TEMPLATES.en.common.oneClickNote);
    expect(mail.text).toContain('Approve: https://app.example/approvals/email-action?org=o&action=APPROVE&token=a');
    expect(mail.text).toContain(NOTIFICATION_TEMPLATES.en.common.oneClickNote);
    expect(mail.html).toContain('https://app.example/my/profile');
    const locked = renderEmail({ rendered, locale: 'ar', orgName: 'Acme', url: 'https://app.example/settings/subscription', preferencesUrl: 'https://app.example/settings/notifications', locked: true, oneClick: null });
    expect(locked.html).toContain(NOTIFICATION_TEMPLATES.ar.common.footerLocked);
    expect(locked.html).not.toContain('https://app.example/settings/notifications');
    expect(locked.html).toContain('dir="rtl"');
    expect(templateFor(NOTIFICATION_TEMPLATES.en, 'approval.decided', 'approval.decided#REJECTED')?.cta).toBe('View the request');
  });

  it('8-P2-2 an Arabic notice names the leave type in Arabic and prints no Latin code where a localised name exists', () => {
    const render = (locale: NotificationLocale, type: string, data: Record<string, unknown>, audience: NotificationAudience = 'other') =>
      renderNotification({ type, data, locale, timezone: TZ, orgName: 'Acme', audience, now: NOW });
    const names = { leaveTypeName: 'Casual Leave', leaveTypeNameAr: 'إجازة عارضة' };
    // the approval notice of a leave request: Arabic name for an Arabic reader, English name for an English one
    const pendingAr = render('ar', 'approval.pending', { entityType: 'LEAVE', employeeName: 'سارة', date: '2026-10-01', endDate: '2026-10-02', ...names });
    expect(pendingAr.body).toContain('إجازة عارضة');
    expect(pendingAr.body).not.toContain('Casual Leave');
    expect(render('en', 'approval.pending', { entityType: 'LEAVE', employeeName: 'Sara', date: '2026-10-01', endDate: '2026-10-02', ...names }).body).toContain('Casual Leave');
    // the leave decision to the employee
    for (const type of ['leave.approved', 'leave.rejected', 'leave.info_requested', 'leave.requested', 'leave.comment_added']) {
      const ar = render('ar', type, { startDate: '2026-10-01', endDate: '2026-10-02', employeeName: 'سارة', question: 'لماذا؟', excerpt: 'تعليق', ...names });
      expect(`${ar.title} ${ar.body}`, type).not.toContain('Casual Leave');
    }
    expect(render('ar', 'leave.approved', { startDate: '2026-10-01', endDate: '2026-10-02', ...names }).title).toContain('إجازة عارضة');
    // a type without an Arabic name falls back to its name (never blank)
    expect(render('ar', 'leave.approved', { startDate: '2026-10-01', endDate: '2026-10-02', leaveTypeName: 'Casual Leave' }).title).toContain('Casual Leave');
    // a reason rejected against a leave balance: the type's Arabic name, not the code "AL"
    const charged = { decision: 'rejected', attendanceDate: '2026-09-15', payEffectDays: 0.5, chargeOutcome: 'charged_leave', leaveTypeCode: 'AL', leaveTypeName: 'Annual Leave', leaveTypeNameAr: 'إجازة سنوية' };
    const chargedAr = render('ar', 'attendance.note_decided', charged, 'subject');
    expect(chargedAr.body).toContain('إجازة سنوية');
    expect(chargedAr.body).not.toMatch(/\bAL\b/);
    expect(render('en', 'attendance.note_decided', charged, 'subject').body).toBe('Half a day deducted from your Annual Leave balance');
    // only the code known (the type was deleted meanwhile): the code, as the last resort
    expect(render('en', 'attendance.note_decided', { ...charged, leaveTypeName: undefined, leaveTypeNameAr: undefined }, 'subject').body).toBe('Half a day deducted from your AL balance');
    // a Flowza Finance failure code by its localised name
    const finance = { direction: 'pull', consecutiveFailures: 3, code: 'AUTH_FAILED', error: 'HTTP 401', reason: 'streak' };
    const financeAr = render('ar', 'sync.finance.failed', finance);
    expect(financeAr.body).toContain(NOTIFICATION_TEMPLATES.ar.financeErrors['AUTH_FAILED']!);
    expect(financeAr.body).not.toContain('AUTH_FAILED');
    expect(render('en', 'sync.finance.failed', finance).body).toContain('Credential rejected: HTTP 401');
    // the Arabic and English failure-code tables name the same codes
    expect(Object.keys(NOTIFICATION_TEMPLATES.ar.financeErrors).sort()).toEqual(Object.keys(NOTIFICATION_TEMPLATES.en.financeErrors).sort());
  });

  it('8-P2-4 the missing check-out notice links to /my (a page of the live bundle too) and 8-P2-5 an import to /employees/import?importId=', () => {
    const missing = resolveNotification('punch.missing_out', { employeeId: ID.employee, attendanceDate: '2026-09-15', endSource: 'shift' }, { audience: 'subject', timezone: TZ });
    expect(missing?.link).toBe('/my');
    const imported = resolveNotification('employee.imported', { aggregateType: 'employee_import', aggregateId: ID.import, phase: 'finished', imported: 3 }, { audience: 'other', timezone: TZ });
    expect(imported?.link).toBe(`/employees/import?importId=${ID.import}`);
    expect(resolveNotification('employee.imported', { importId: ID.import, aggregateId: ID.aggregate, phase: 'queued' }, { audience: 'other', timezone: TZ })?.link).toBe(`/employees/import?importId=${ID.import}`);
  });
});
