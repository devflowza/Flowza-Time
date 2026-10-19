import { describe, expect, it } from 'vitest';
import { DOMAIN_EVENT_TYPES } from '../sync.js';
import { APPRECIATION_DEFAULT_MESSAGE_AR, APPRECIATION_DEFAULT_MESSAGE_EN, DEFAULT_NOTIFICATION_SETTINGS, excuseDeadlineOf, notificationSettingsSchema, organizationSettingsSchema, resolveNotificationSettings } from '../organizations.js';
import { updateNotificationPreferencesSchema } from '../dto/notifications.js';
import {
  approvalContextFacts, decideNotificationChannels, isConfigurablePreference, localDateOf, NON_NOTIFYING_EVENT_TYPES, NOTIFICATION_ALERT_SWITCHES, NOTIFICATION_CATALOGUE, NOTIFICATION_ORG_SWITCHES, NOTIFICATION_ROUTE_KEYS, NOTIFICATION_TYPES, notificationData,
  notificationDataKeys, notificationPreferenceCells, notificationSwitchOn, notificationTemplateKeys, resolveNotification, type NotificationContext,
} from './catalogue.js';

const OTHER: NotificationContext = { audience: 'other', timezone: 'Asia/Muscat' };
const SELF: NotificationContext = { audience: 'subject', timezone: 'Asia/Muscat' };
const REQ = '11111111-1111-4111-8111-111111111111';
const EMP = '22222222-2222-4222-8222-222222222222';
/** The attendance alert keys of the notifications group: their defaults, and a document with every one of them changed. */
const ALERT_DEFAULTS = {
  lateArrivalAlert: { enabled: true, notifyEmployee: true, notifyManager: true, minMinutes: 1 },
  earlyDepartureAlert: { enabled: true, notifyEmployee: true, notifyManager: true, minMinutes: 1 },
  absenceAlert: { enabled: true, notifyEmployee: true, notifyManager: true },
  absenceReminder: true, missingCheckInReminder: false, missingCheckInReminderMinutes: 30, missingCheckInNotifyManager: false,
  appreciation: {
    enabled: false, weekday: 4, hour: 14, minWorkedDays: 5, messageEn: APPRECIATION_DEFAULT_MESSAGE_EN, messageAr: APPRECIATION_DEFAULT_MESSAGE_AR,
    criteria: { noLate: true, noEarlyDeparture: true, noAbsence: true, noMissingPunch: true, noUnexcused: true },
  },
};
const ALERT_FULL = {
  lateArrivalAlert: { enabled: false, notifyEmployee: false, notifyManager: true, minMinutes: 10 },
  earlyDepartureAlert: { enabled: true, notifyEmployee: true, notifyManager: false, minMinutes: 15 },
  absenceAlert: { enabled: true, notifyEmployee: false, notifyManager: true },
  absenceReminder: false, missingCheckInReminder: true, missingCheckInReminderMinutes: 45, missingCheckInNotifyManager: true,
  appreciation: {
    enabled: true, weekday: 0, hour: 9, minWorkedDays: 4, messageEn: 'Well done!', messageAr: 'أحسنت!',
    criteria: { noLate: false, noEarlyDeparture: true, noAbsence: false, noMissingPunch: true, noUnexcused: false },
  },
};

describe('notification catalogue — completeness', () => {
  it('catalogues every domain event type that is not deliberately silent (a new event type forces a decision)', () => {
    const silent = new Set<string>(NON_NOTIFYING_EVENT_TYPES);
    const missing = DOMAIN_EVENT_TYPES.filter((t) => !NOTIFICATION_CATALOGUE[t] && !silent.has(t));
    expect(missing).toEqual([]);
    // never both
    expect(NOTIFICATION_TYPES.filter((t) => silent.has(t))).toEqual([]);
  });

  it('catalogues only real domain event types, each once', () => {
    const known = new Set<string>(DOMAIN_EVENT_TYPES);
    expect(NOTIFICATION_TYPES.filter((t) => !known.has(t))).toEqual([]);
    expect(new Set(NOTIFICATION_TYPES).size).toBe(NOTIFICATION_TYPES.length);
  });

  it('covers the types every prompt added (2, 3, 4, 6a, 7, 8, 9)', () => {
    for (const t of ['approval.pending', 'approval.reminder', 'approval.escalated', 'approval.decided', 'approval.info_requested', 'approval.info_answered', 'approval.reassigned', 'approval.bypassed',
      'attendance.unexcused_marked', 'attendance.note_submitted', 'attendance.note_decided', 'attendance.note_info_requested', 'attendance.selfie_submitted', 'attendance.selfie_decided', 'attendance.punch_flagged',
      'attendance.regularisation_decided', 'shift.swap_requested', 'shift.swap_decided', 'report.scheduled_delivery', 'leave.comment_added', 'leave.year_closed', 'leave.comp_off_expired',
      'leave.info_requested', 'punch.missing_out', 'sync.finance.failed',
      'attendance.late_arrival', 'attendance.early_departure', 'attendance.absence_recorded', 'attendance.absence_reminder', 'punch.missing_in', 'attendance.appreciation']) expect(NOTIFICATION_CATALOGUE[t], t).toBeTruthy();
  });

  it('every entry is well-formed: channels, org switch, variants, relative deep links', () => {
    for (const e of Object.values(NOTIFICATION_CATALOGUE)) {
      expect(e.defaultChannels.length, e.type).toBeGreaterThan(0);
      const switches: readonly string[] = [...NOTIFICATION_ORG_SWITCHES, ...NOTIFICATION_ALERT_SWITCHES];
      if (e.orgSetting) expect(switches, e.type).toContain(e.orgSetting);
      for (const v of Object.values(e.variants)) if (v.orgSetting) expect(switches, e.type).toContain(v.orgSetting);
      for (const ctx of [OTHER, SELF]) {
        const link = e.deepLink({}, ctx);
        expect(link.startsWith('/'), `${e.type} ${link}`).toBe(true);
        expect(link, e.type).not.toMatch(/undefined|null|\/\/|[<>"]/);
      }
      expect(notificationTemplateKeys(e)[0]).toBe(e.type);
      expect(Object.keys(e.vars).length, e.type).toBeGreaterThan(0);
    }
  });

  it('security, system and subscription notices are never suppressible by a preference', () => {
    expect(NOTIFICATION_CATALOGUE['subscription.limit_reached']!.userConfigurable).toBe(false);
    expect(NOTIFICATION_CATALOGUE['employee.imported']!.userConfigurable).toBe(false);
    for (const e of Object.values(NOTIFICATION_CATALOGUE)) if (e.category === 'SYSTEM' || e.category === 'SUBSCRIPTION') expect(e.userConfigurable, e.type).toBe(false);
  });
});

describe('deep links', () => {
  it('report notices open the report in the viewer; an employee\'s own copy opens in the portal', () => {
    expect(resolveNotification('report.ready', { reportId: REQ }, OTHER)!.link).toBe(`/reports?view=${REQ}`);
    expect(resolveNotification('report.scheduled_delivery', { reportId: REQ, mode: 'send_now' }, OTHER)!.link).toBe(`/reports?view=${REQ}`);
    expect(resolveNotification('report.scheduled_delivery', { reportId: REQ, mode: 'send_now', selfScope: true }, SELF)!.link).toBe(`/my/reports?view=${REQ}`);
    expect(resolveNotification('report.scheduled_delivery', { reportId: REQ, mode: 'send_now', selfScope: 'true' }, OTHER)!.link).toBe(`/reports?view=${REQ}`); // only a real flag
  });
  it('approval notices open the request in the inbox; the digest opens the inbox', () => {
    expect(resolveNotification('approval.pending', { requestId: REQ }, OTHER)!.link).toBe(`/approvals?request=${REQ}`);
    expect(resolveNotification('approval.decided', { aggregateType: 'approval_request', aggregateId: REQ, decision: 'APPROVED' }, OTHER)!.link).toBe(`/approvals?request=${REQ}`);
    expect(resolveNotification('approval.reminder', { kind: 'digest', total: 2 }, OTHER)!.link).toBe('/approvals');
  });
  it('decided / info requested notices open the matching /my page with the date or id', () => {
    expect(resolveNotification('attendance.note_decided', { attendanceDate: '2026-09-21', decision: 'approved' }, SELF)!.link).toBe('/my/requests?tab=reasons&date=2026-09-21');
    expect(resolveNotification('attendance.regularisation_decided', { attendanceDate: '2026-09-21', decision: 'approved' }, SELF)!.link).toBe('/my/requests?tab=regularisations&date=2026-09-21');
    expect(resolveNotification('attendance.selfie_decided', { at: '2026-09-20T21:30:00Z', decision: 'approved' }, SELF)!.link).toBe('/my/requests?tab=selfies&date=2026-09-21');
    expect(resolveNotification('leave.approved', { aggregateId: REQ }, SELF)!.link).toBe(`/my/leave?request=${REQ}`);
    expect(resolveNotification('leave.info_requested', { leaveRecordId: REQ }, SELF)!.link).toBe(`/my/leave?request=${REQ}`);
  });
  it('8-P2-4 the missing check-out notice opens /my (its check-in card — a page of the live bundle too); 8-P2-5 an import opens /employees/import?importId=', () => {
    expect(resolveNotification('punch.missing_out', { attendanceDate: '2026-09-21' }, SELF)!.link).toBe('/my');
    expect(resolveNotification('employee.imported', { importId: REQ, phase: 'queued' }, OTHER)!.link).toBe(`/employees/import?importId=${REQ}`);
    expect(resolveNotification('employee.imported', { aggregateType: 'employee_import', aggregateId: REQ }, OTHER)!.link).toBe(`/employees/import?importId=${REQ}`);
    expect(resolveNotification('employee.imported', { importId: '../../admin' }, OTHER)!.link).toBe('/employees/import');
  });
  it('the same event leads the employee to the portal and a manager to the register', () => {
    const p = { employeeId: EMP, dates: ['2026-09-14', '2026-09-15'], count: 2 };
    expect(resolveNotification('attendance.unexcused_marked', p, SELF)!.link).toBe('/my/attendance?month=2026-09');
    expect(resolveNotification('attendance.unexcused_marked', p, OTHER)!.link).toBe(`/attendance?employeeId=${EMP}`);
    expect(resolveNotification('attendance.unexcused_marked', p, SELF)!.templateKey).toBe('attendance.unexcused_marked#self');
  });
  it('never puts a malformed id into a link', () => {
    expect(resolveNotification('approval.pending', { requestId: '../../admin' }, OTHER)!.link).toBe('/approvals');
    expect(resolveNotification('device.offline', { deviceId: 'x"><script>' }, OTHER)!.link).toBe('/devices');
  });
});

describe('review fixes (docs/hr-portal/reviews/08-notifications-review.md)', () => {
  it('8-P0-4 a correction\'s decision is not a notice of its own: approval.decided tells the requester and the person concerned', () => {
    for (const t of ['attendance.correction_approved', 'attendance.correction_rejected']) {
      expect(NOTIFICATION_CATALOGUE[t], t).toBeUndefined();
      expect(NON_NOTIFYING_EVENT_TYPES as readonly string[], t).toContain(t);
    }
    expect(NOTIFICATION_CATALOGUE['approval.decided']!.recipients).toMatch(/requester/);
  });
  it('8-P0-5 the data whitelist of a type is the aggregate, the routing facts and the type\'s own variables; an unknown type keeps the first two only', () => {
    expect(notificationDataKeys('attendance.note_info_requested')).toEqual(['aggregateType', 'aggregateId', ...NOTIFICATION_ROUTE_KEYS, 'attendanceDate', 'question']);
    expect(notificationDataKeys('no.such_type')).toEqual(['aggregateType', 'aggregateId', ...NOTIFICATION_ROUTE_KEYS]);
    const e = NOTIFICATION_CATALOGUE['approval.pending']!;
    const payload = { requestId: REQ, entityType: 'LEAVE', employeeName: 'Ali', stepNo: 1, userIds: [EMP], leaveTypeNameAr: 'إجازة', comment: 'x' };
    const data = notificationData(e, payload, resolveNotification('approval.pending', payload, OTHER)!.route, { type: 'approval_request', id: REQ });
    for (const k of Object.keys(data)) expect(notificationDataKeys('approval.pending'), k).toContain(k);
  });
  it('8-P2-2 every notice naming a leave type carries its Arabic name too (the recipient\'s language picks one)', () => {
    for (const e of Object.values(NOTIFICATION_CATALOGUE)) {
      if (e.vars['leaveTypeName']) expect(e.vars, e.type).toHaveProperty('leaveTypeNameAr');
    }
  });
});

describe('routing facts and data minimisation', () => {
  it('copies entityType / entityId / requestId / date / employeeId so a client can re-route', () => {
    const r = resolveNotification('attendance.note_submitted', { noteId: REQ, approvalRequestId: REQ, employeeId: EMP, attendanceDate: '2026-09-21', employeeName: 'Ali' }, OTHER)!;
    expect(r.route).toEqual({ entityType: 'ATTENDANCE_NOTE', entityId: REQ, requestId: REQ, date: '2026-09-21', employeeId: EMP });
  });
  it('whitelists the template variables: no recipient lists, no other people\'s ids, bounded text', () => {
    const e = NOTIFICATION_CATALOGUE['approval.pending']!;
    const payload = { requestId: REQ, entityType: 'LEAVE', employeeName: 'Ali', stepNo: 1, userIds: [EMP], requestedBy: EMP, secret: 'x', summary: 'y'.repeat(900) };
    const r = resolveNotification('approval.pending', payload, OTHER)!;
    const data = notificationData(e, payload, r.route, { type: 'approval_request', id: REQ });
    expect(data).not.toHaveProperty('userIds');
    expect(data).not.toHaveProperty('requestedBy');
    expect(data).not.toHaveProperty('secret');
    expect(String(data['summary'])).toHaveLength(500);
    expect(data).toMatchObject({ aggregateType: 'approval_request', aggregateId: REQ, requestId: REQ, entityType: 'LEAVE', employeeName: 'Ali', stepNo: 1 });
  });
  it('dates of instants are the organisation\'s local dates', () => {
    expect(localDateOf('2026-09-27T21:30:00Z', 'Asia/Muscat')).toBe('2026-09-28');
    expect(localDateOf('2026-09-28T10:30:00Z', 'Pacific/Pago_Pago')).toBe('2026-09-27');
    expect(localDateOf('not a date', 'Asia/Muscat')).toBeNull();
  });
});

describe('channel decision (organisation switch × user preference × configurability)', () => {
  const settings = DEFAULT_NOTIFICATION_SETTINGS;
  const decide = (type: string, payload: Record<string, unknown>, prefs: { IN_APP?: boolean; EMAIL?: boolean }, org: Partial<typeof settings> = {}, requested?: { inApp: boolean; email: boolean }) =>
    decideNotificationChannels({ resolved: resolveNotification(type, payload, OTHER)!, orgSettings: { ...settings, ...org }, preferences: prefs, ...(requested ? { requested } : {}) });
  it.each([
    // [type, payload, prefs, org, expected in-app, expected e-mail]
    ['leave.approved', {}, {}, {}, true, true],
    ['leave.approved', {}, { EMAIL: false }, {}, true, false],
    ['leave.approved', {}, { IN_APP: false }, {}, false, true],
    ['leave.approved', {}, {}, { leaveUpdates: false }, true, false],
    ['approval.pending', {}, { IN_APP: false, EMAIL: false }, {}, true, false], // an item to act on stays in the inbox
    ['approval.pending', {}, {}, { approvalPending: false }, true, false],
    ['approval.reminder', { kind: 'digest' }, {}, {}, true, false], // dailyDigest defaults off
    ['approval.reminder', { kind: 'digest' }, {}, { dailyDigest: true }, true, true],
    ['approval.reminder', { kind: 'digest' }, { IN_APP: false }, { dailyDigest: true }, false, true],
    ['approval.decided', { entityType: 'LEAVE' }, {}, { leaveUpdates: false }, true, false],
    ['approval.decided', { entityType: 'ATTENDANCE_NOTE' }, {}, { leaveUpdates: false }, true, true],
    ['approval.decided', { entityType: 'ATTENDANCE_NOTE' }, {}, { attendanceNotes: false }, true, false],
    ['subscription.limit_reached', {}, { IN_APP: false, EMAIL: false }, {}, true, true], // not suppressible
    ['employee.imported', {}, { IN_APP: false, EMAIL: false }, {}, true, true],
    ['punch.missing_out', {}, {}, { missingPunchReminder: false }, true, false],
  ] as const)('%s %o prefs %o org %o → in-app %s, e-mail %s', (type, payload, prefs, org, inApp, email) => {
    const d = decide(type, { ...payload }, { ...prefs }, { ...org });
    expect({ inApp: d.inApp, email: d.email }).toEqual({ inApp, email });
  });
  it('an event that asks for one channel gets that channel only (report deliveries)', () => {
    expect(decide('report.scheduled_delivery', {}, {}, {}, { inApp: false, email: true })).toMatchObject({ inApp: false, email: true, reasons: { inApp: 'not_requested' } });
    expect(decide('report.scheduled_delivery', {}, {}, { reportScheduledDelivery: false }, { inApp: true, email: true })).toMatchObject({ inApp: true, email: false, reasons: { email: 'org_switch' } });
  });
});

describe('preference matrix', () => {
  it('system and subscription cells are locked; the others can be switched', () => {
    const cells = notificationPreferenceCells();
    expect(cells).toHaveLength(14);
    expect(cells.filter((c) => !c.configurable).map((c) => `${c.category}:${c.channel}`).sort()).toEqual(['SUBSCRIPTION:EMAIL', 'SUBSCRIPTION:IN_APP', 'SYSTEM:EMAIL', 'SYSTEM:IN_APP']);
    expect(isConfigurablePreference('LEAVE', 'EMAIL')).toBe(true);
    expect(isConfigurablePreference('SYSTEM', 'EMAIL')).toBe(false);
    const approvalInApp = cells.find((c) => c.category === 'APPROVAL' && c.channel === 'IN_APP')!;
    expect(approvalInApp.alwaysOn).toContain('approval.pending');
    expect(approvalInApp.alwaysOn).not.toContain('approval.decided');
  });
  it('the PUT body refuses duplicates, unknown channels and extra keys', () => {
    expect(updateNotificationPreferencesSchema.safeParse({ preferences: [{ category: 'LEAVE', channel: 'EMAIL', enabled: false }] }).success).toBe(true);
    expect(updateNotificationPreferencesSchema.safeParse({ preferences: [{ category: 'LEAVE', channel: 'EMAIL', enabled: false }, { category: 'LEAVE', channel: 'EMAIL', enabled: true }] }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ preferences: [{ category: 'LEAVE', channel: 'SMS', enabled: false }] }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ preferences: [{ category: 'LEAVE', channel: 'EMAIL', enabled: false, userId: EMP }] }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ preferences: [] }).success).toBe(false);
  });
});

describe('organisation notification switches', () => {
  it('defaults: new families on, the reminder after 2 hours, the digest e-mail off', () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual({
      deviceOffline: true, syncFailed: true, approvalPending: true, reportReady: true, dailyDigest: false,
      leaveUpdates: true, attendanceNotes: true, punchFlagged: true, missingPunchReminder: true, missingPunchReminderHours: 2, reportScheduledDelivery: true,
      ...ALERT_DEFAULTS,
    });
    expect(organizationSettingsSchema.shape.notifications.parse({})).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });
  it('a row saved before the new keys existed resolves to the defaults; a malformed key falls back alone', () => {
    expect(resolveNotificationSettings({ deviceOffline: false })).toEqual({ ...DEFAULT_NOTIFICATION_SETTINGS, deviceOffline: false });
    expect(resolveNotificationSettings({ missingPunchReminderHours: 99, leaveUpdates: false })).toEqual({ ...DEFAULT_NOTIFICATION_SETTINGS, leaveUpdates: false });
    expect(resolveNotificationSettings(null)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });
  it('round-trips a full non-default document (no default re-applied)', () => {
    const full = { deviceOffline: false, syncFailed: false, approvalPending: false, reportReady: false, dailyDigest: true, leaveUpdates: false, attendanceNotes: false, punchFlagged: false, missingPunchReminder: false, missingPunchReminderHours: 5, reportScheduledDelivery: false, ...ALERT_FULL };
    expect(notificationSettingsSchema.parse(full)).toEqual(full);
    expect(organizationSettingsSchema.shape.notifications.parse(full)).toEqual(full);
  });
  it('the reminder delay is 1–12 hours', () => {
    expect(notificationSettingsSchema.safeParse({ missingPunchReminderHours: 0 }).success).toBe(false);
    expect(notificationSettingsSchema.safeParse({ missingPunchReminderHours: 13 }).success).toBe(false);
  });
});

describe('attendance alert settings (lateness, absence, missing check-in, weekly appreciation)', () => {
  const group = organizationSettingsSchema.shape.notifications;
  it('a row saved before the alert groups existed resolves every group to its full defaults', () => {
    const legacy = { deviceOffline: false, missingPunchReminderHours: 4 };
    const parsed = group.parse(legacy);
    expect(parsed).toEqual({ ...DEFAULT_NOTIFICATION_SETTINGS, ...legacy });
    expect(parsed).toMatchObject(ALERT_DEFAULTS);
    expect(resolveNotificationSettings(legacy)).toEqual({ ...DEFAULT_NOTIFICATION_SETTINGS, ...legacy });
  });
  it('one nested key on its own keeps its siblings at the defaults and never touches the other groups (the partial / PATCH trap)', () => {
    const one = group.parse({ lateArrivalAlert: { notifyManager: false } });
    expect(one.lateArrivalAlert).toEqual({ ...ALERT_DEFAULTS.lateArrivalAlert, notifyManager: false });
    expect(one.earlyDepartureAlert).toEqual(ALERT_DEFAULTS.earlyDepartureAlert);
    expect(one.appreciation).toEqual(ALERT_DEFAULTS.appreciation);
    const criteria = group.parse({ appreciation: { enabled: true, criteria: { noLate: false } } });
    expect(criteria.appreciation).toEqual({ ...ALERT_DEFAULTS.appreciation, enabled: true, criteria: { ...ALERT_DEFAULTS.appreciation.criteria, noLate: false } });
    // a whole stored document parses back to itself: nothing a tenant chose is reset by a save of another field
    const stored = group.parse({ ...DEFAULT_NOTIFICATION_SETTINGS, ...ALERT_FULL });
    expect(stored).toEqual({ ...DEFAULT_NOTIFICATION_SETTINGS, ...ALERT_FULL });
    expect(group.parse({ ...stored, missingCheckInReminderMinutes: 60 })).toEqual({ ...stored, missingCheckInReminderMinutes: 60 });
  });
  it('rejects out-of-range values instead of clamping them', () => {
    for (const bad of [
      { lateArrivalAlert: { minMinutes: 0 } }, { earlyDepartureAlert: { minMinutes: 601 } }, { missingCheckInReminderMinutes: 14 }, { missingCheckInReminderMinutes: 241 },
      { appreciation: { weekday: 7 } }, { appreciation: { hour: 24 } }, { appreciation: { minWorkedDays: 0 } }, { appreciation: { minWorkedDays: 8 } },
      { appreciation: { messageEn: 'x'.repeat(501) } }, { appreciation: { messageAr: '   ' } },
    ]) expect(group.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
  });
  it('a malformed group falls back to its own defaults and keeps the valid keys', () => {
    const salvaged = resolveNotificationSettings({ appreciation: { weekday: 'thursday', enabled: true }, lateArrivalAlert: { enabled: false }, leaveUpdates: false });
    expect(salvaged.appreciation).toEqual(ALERT_DEFAULTS.appreciation);
    expect(salvaged.lateArrivalAlert.enabled).toBe(false);
    expect(salvaged.leaveUpdates).toBe(false);
  });
  it('a group switch off suppresses the e-mail of its type (the in-app notice stays); a boolean switch the same way', () => {
    const settings = resolveNotificationSettings({ lateArrivalAlert: { enabled: false }, missingCheckInReminder: false });
    const late = decideNotificationChannels({ resolved: resolveNotification('attendance.late_arrival', { employeeId: EMP }, SELF)!, orgSettings: settings, preferences: {} });
    expect(late).toEqual({ inApp: true, email: false, reasons: { email: 'org_switch' } });
    const missing = decideNotificationChannels({ resolved: resolveNotification('punch.missing_in', { employeeId: EMP }, SELF)!, orgSettings: settings, preferences: {} });
    expect(missing.email).toBe(false);
    const early = decideNotificationChannels({ resolved: resolveNotification('attendance.early_departure', { employeeId: EMP }, SELF)!, orgSettings: settings, preferences: { EMAIL: false } });
    expect(early).toEqual({ inApp: true, email: false, reasons: { email: 'preference' } });
    expect(notificationSwitchOn(settings, 'lateArrivalAlert')).toBe(false);
    expect(notificationSwitchOn(settings, 'earlyDepartureAlert')).toBe(true);
    expect(notificationSwitchOn(settings, 'appreciation')).toBe(false); // off by default
  });
  it('the alerts follow the recipient: the employee\'s own day in the portal, the register for their manager', () => {
    const p = { employeeId: EMP, attendanceDate: '2026-10-18' };
    for (const type of ['attendance.late_arrival', 'attendance.early_departure', 'attendance.absence_recorded']) {
      expect(resolveNotification(type, p, SELF)!.templateKey).toBe(`${type}#self`);
      expect(resolveNotification(type, p, SELF)!.link).toBe('/my/attendance?date=2026-10-18');
      expect(resolveNotification(type, p, OTHER)!.templateKey).toBe(`${type}#manager`);
      expect(resolveNotification(type, p, OTHER)!.link).toBe(`/attendance?employeeId=${EMP}&date=2026-10-18`);
    }
    expect(resolveNotification('punch.missing_in', p, SELF)!.link).toBe('/my');
    expect(resolveNotification('punch.missing_in', p, OTHER)!.link).toBe(`/attendance?employeeId=${EMP}&date=2026-10-18`);
    expect(resolveNotification('attendance.absence_reminder', p, SELF)!.link).toBe('/my/attendance?date=2026-10-18');
    expect(resolveNotification('attendance.appreciation', { employeeId: EMP, periodEnd: '2026-10-14' }, SELF)!.link).toBe('/my/attendance');
    // the template variables the notice keeps are the catalogue's, nothing else of the payload
    expect(notificationData(NOTIFICATION_CATALOGUE['attendance.appreciation']!, { message: 'Thanks', messageAr: 'شكرًا', workedDays: 5, userIds: [EMP], secret: 1 }, resolveNotification('attendance.appreciation', {}, SELF)!.route, { type: 'employee', id: EMP }))
      .toEqual({ aggregateType: 'employee', aggregateId: EMP, entityType: 'EMPLOYEE', message: 'Thanks', messageAr: 'شكرًا', workedDays: 5 });
  });
  it('the excuse deadline is the attendance date plus the configured days (none without a setting)', () => {
    expect(excuseDeadlineOf('2026-10-18', 3)).toBe('2026-10-21');
    expect(excuseDeadlineOf('2026-12-30', 5)).toBe('2027-01-04');
    expect(excuseDeadlineOf('2026-10-18', null)).toBeNull();
    expect(excuseDeadlineOf('not-a-date', 3)).toBeNull();
  });
});

describe('approval notification facts', () => {
  it('derive the day (or a leave\'s dates and type) from the inbox context of every entity kind', () => {
    expect(approvalContextFacts({ kind: 'LEAVE', leave: { id: REQ, leaveTypeId: REQ, leaveTypeName: 'Annual', startDate: '2026-10-01', endDate: '2026-10-03', isHalfDay: false, halfDayPart: null, days: 3, reason: null, status: 'PENDING', balanceRemainingDays: null, allowanceDays: null } }))
      .toEqual({ date: '2026-10-01', endDate: '2026-10-03', leaveTypeName: 'Annual' });
    expect(approvalContextFacts({ kind: 'ATTENDANCE_CORRECTION', correction: { id: REQ, attendanceDate: '2026-09-12', type: 'ADD_PUNCH', originalPunchedAt: null, proposedPunchedAt: null, proposedEventType: null, proposedStatus: null, reason: 'x', status: 'PENDING', requestedBy: null, rejectionReason: null } }))
      .toEqual({ date: '2026-09-12', endDate: null, leaveTypeName: null });
    expect(approvalContextFacts({ kind: 'SHIFT_SWAP', summary: null, swap: { id: REQ, swapDate: '2026-09-20', requesterName: null, targetName: null, requesterShiftName: null, targetShiftName: null, reason: 'x', status: 'pending' } }).date).toBe('2026-09-20');
    expect(approvalContextFacts({ kind: 'SHIFT_CHANGE', summary: null, change: { id: REQ, kind: 'CHANGE', fromDate: '2026-10-12', toDate: '2026-10-14', employeeName: null, requestedShiftName: null, currentShiftName: null, reason: 'x', status: 'pending' } }))
      .toEqual({ date: '2026-10-12', endDate: '2026-10-14', leaveTypeName: null });
    expect(approvalContextFacts({ kind: 'COMP_OFF', compOff: { id: REQ, workedOn: '2026-09-05', workedOnType: 'weekly_off', workedMinutes: 480, recordedMinutes: null, daysEarned: 1, location: 'HQ', summary: 'x', status: 'pending_approval' } }).date).toBe('2026-09-05');
    expect(approvalContextFacts({ kind: 'GENERIC', entityType: 'OVERTIME_CLAIM', summary: 'x' })).toEqual({ date: null, endDate: null, leaveTypeName: null });
    expect(approvalContextFacts(null)).toEqual({ date: null, endDate: null, leaveTypeName: null });
  });
});
