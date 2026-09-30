import { APPROVAL_ENTITIES, NOTIFICATION_CATEGORIES, NOTIFICATION_DELIVERY_CHANNELS, type ApprovalEntity, type NotificationCategory, type NotificationDeliveryChannel } from '../enums.js';
import type { Permission } from '../permissions.js';
import type { NotificationSettings } from '../organizations.js';
import type { DomainEventType } from '../sync.js';
import type { ApprovalContextDto } from '../dto-features/approvals.js';

/**
 * The notification catalogue (HR portal Prompt 8): one entry per notification `type` the outbox relay can write — the
 * domain event type is the notification type. For each type it says how the notification is COMPOSED (template key and
 * variant, the template variables the payload may carry), where it LEADS (the canonical web path, plus the routing facts
 * `entityType` / `entityId` / `requestId` / `date` / `employeeId` copied into `notifications.data` so a client can re-route),
 * and on which CHANNELS it goes out (category, default channels, whether the recipient's preferences apply, which
 * organisation switch governs its e-mail).
 *
 * Who RECEIVES a type stays the worker's ROUTING table (apps/worker/src/handlers/notifications/outbox.ts); a worker test
 * fails when a ROUTING type has no entry here (and the reverse), and a contracts test fails when a DOMAIN_EVENT_TYPES entry
 * is neither catalogued nor listed in NON_NOTIFYING_EVENT_TYPES. Templates (en + ar) live next to the relay.
 */

export type NotificationPayload = Readonly<Record<string, unknown>>;
/**
 * Audience of one recipient relative to the event: `subject` — the recipient's own membership is linked to the employee the
 * event is about (`payload.employeeId`); `other` — everybody else (managers, HR, approvers, colleagues).
 */
export type NotificationAudience = 'subject' | 'other';
export interface NotificationContext {
  audience: NotificationAudience;
  /** The organisation's IANA timezone (dates of instants are the organisation's local dates). */
  timezone: string;
}

/** Boolean switches of `organization_settings.notifications`. */
export type NotificationOrgSwitch = { [K in keyof NotificationSettings]: NotificationSettings[K] extends boolean ? K : never }[keyof NotificationSettings];
/** Settings → Notifications lists the switches in this order. */
export const NOTIFICATION_ORG_SWITCHES = [
  'approvalPending', 'dailyDigest', 'leaveUpdates', 'attendanceNotes', 'punchFlagged', 'missingPunchReminder', 'deviceOffline', 'syncFailed', 'reportReady', 'reportScheduledDelivery',
] as const satisfies readonly NotificationOrgSwitch[];

/**
 * How a template variable is read from the payload (and whitelisted into `notifications.data`):
 * text (trimmed, ≤ 500 characters), date (YYYY-MM-DD), datetime (ISO instant), number, dates (≤ 31 dates), code (an
 * identifier: entity type, decision, reason code…), flag (boolean), counts (the digest's [{ entityType, count }]).
 */
export type NotificationVarKind = 'text' | 'date' | 'datetime' | 'number' | 'dates' | 'code' | 'flag' | 'counts';

export interface NotificationRoute {
  entityType: string | null;
  entityId: string | null;
  requestId: string | null;
  date: string | null;
  employeeId: string | null;
}

/** What a variant changes besides its template (outcome-specific texts). */
export interface NotificationVariantSpec {
  readonly orgSetting?: NotificationOrgSwitch | null;
  readonly inAppAlways?: boolean;
  readonly oneClick?: boolean;
}

export interface NotificationCatalogueEntry {
  readonly type: DomainEventType;
  readonly category: NotificationCategory;
  /** Who receives it — documentation of the worker's ROUTING entry (the executable truth). */
  readonly recipients: string;
  readonly defaultChannels: readonly NotificationDeliveryChannel[];
  /** The recipient's preferences apply. False for system and subscription notices (never suppressible). */
  readonly userConfigurable: boolean;
  /** An item the recipient must act on: the in-app notice is written even when they switched the category's in-app off. */
  readonly inAppAlways: boolean;
  /** The organisation switch that governs the e-mail of this type (null = none). */
  readonly orgSetting: NotificationOrgSwitch | null;
  /** The e-mail carries one-click Approve / Reject links (minted per recipient at send time, only while their seat is pending). */
  readonly oneClick: boolean;
  /** Template variables read from the payload. */
  readonly vars: Readonly<Record<string, NotificationVarKind>>;
  /** Outcome-specific variants: the template key is `type#variant`. */
  readonly variants: Readonly<Record<string, NotificationVariantSpec>>;
  readonly variant: (p: NotificationPayload, ctx: NotificationContext) => string | null;
  /** The organisation switch when it depends on the payload (e.g. an approval decision on leave vs attendance). */
  readonly orgSettingOf?: (p: NotificationPayload) => NotificationOrgSwitch | null;
  readonly route: (p: NotificationPayload, ctx: NotificationContext) => NotificationRoute;
  readonly deepLink: (p: NotificationPayload, ctx: NotificationContext) => string;
}

// ----- payload readers (defensive: a payload is data from the outbox, never trusted for shape) -------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const notificationReaders = {
  id: (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null),
  date: (v: unknown): string | null => (typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v.slice(0, 10))) ? v.slice(0, 10) : null),
  code: (v: unknown): string | null => (typeof v === 'string' && CODE_RE.test(v) ? v : null),
  text: (v: unknown): string | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length > 0 ? t.slice(0, 500) : null;
  },
  number: (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  },
  instant: (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : null),
};
const R = notificationReaders;

/** The organisation's local date of an instant (Intl; contracts carry no date library). */
export function localDateOf(instant: unknown, timezone: string): string | null {
  const iso = R.instant(instant);
  if (!iso) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return iso.slice(0, 10);
  }
}

/** A path with a query string; empty / null parameters are left out, values are URI-encoded. */
function path(base: string, params: Record<string, string | null | undefined> = {}): string {
  const q = Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return q.length ? `${base}?${q.join('&')}` : base;
}
const route = (r: Partial<NotificationRoute>): NotificationRoute => ({ entityType: r.entityType ?? null, entityId: r.entityId ?? null, requestId: r.requestId ?? null, date: r.date ?? null, employeeId: r.employeeId ?? null });
const approvalRequestId = (p: NotificationPayload) => R.id(p['requestId']) ?? (p['aggregateType'] === 'approval_request' ? R.id(p['aggregateId']) : null);
const approvalEntity = (p: NotificationPayload): ApprovalEntity | null => {
  const e = R.code(p['entityType']);
  return e && (APPROVAL_ENTITIES as readonly string[]).includes(e) ? (e as ApprovalEntity) : null;
};
/** Leave-shaped approval entities (their decisions and questions follow the organisation's leave switch). */
const LEAVE_ENTITIES: readonly ApprovalEntity[] = ['LEAVE', 'COMP_OFF'];
const byEntity = (p: NotificationPayload): NotificationOrgSwitch => (LEAVE_ENTITIES.includes(approvalEntity(p) ?? 'ATTENDANCE_CORRECTION') ? 'leaveUpdates' : 'attendanceNotes');
const month = (d: string | null): string | null => (d ? d.slice(0, 7) : null);

const BOTH: readonly NotificationDeliveryChannel[] = ['IN_APP', 'EMAIL'];
/**
 * Approval facts. `leaveTypeName` / `leaveTypeNameAr`: both names of a leave type travel with the notice and the recipient's
 * language picks one (review 8-P2-2: an Arabic notice never prints the English name or the code when an Arabic name exists).
 */
const APPROVAL_VARS = { entityType: 'code', employeeName: 'text', stepNo: 'number', date: 'date', endDate: 'date', leaveTypeName: 'text', leaveTypeNameAr: 'text', summary: 'text' } as const satisfies Record<string, NotificationVarKind>;

interface EntrySpec extends Omit<NotificationCatalogueEntry, 'variants' | 'variant' | 'userConfigurable' | 'inAppAlways' | 'oneClick' | 'defaultChannels' | 'orgSetting'> {
  variants?: NotificationCatalogueEntry['variants'];
  variant?: NotificationCatalogueEntry['variant'];
  userConfigurable?: boolean;
  inAppAlways?: boolean;
  oneClick?: boolean;
  defaultChannels?: readonly NotificationDeliveryChannel[];
  orgSetting?: NotificationOrgSwitch | null;
}
const entry = (s: EntrySpec): NotificationCatalogueEntry => ({
  variants: {}, variant: () => null, userConfigurable: true, inAppAlways: false, oneClick: false, defaultChannels: BOTH, orgSetting: null, ...s,
});
const approvalRoute = (p: NotificationPayload): NotificationRoute => route({ entityType: approvalEntity(p), entityId: R.id(p['entityId']), requestId: approvalRequestId(p), date: R.date(p['date']), employeeId: R.id(p['employeeId']) });
const approvalLink = (p: NotificationPayload) => path('/approvals', { request: approvalRequestId(p) });
const decisionOf = (p: NotificationPayload, allowed: readonly string[]): string | null => { const d = R.code(p['decision']); return d && allowed.includes(d) ? d : null; };

const ENTRIES: readonly NotificationCatalogueEntry[] = [
  // ----- approval engine v2 (Prompt 2): targeted at the resolved people of a request ---------------------------------------------
  entry({
    type: 'approval.pending', category: 'APPROVAL', recipients: 'payload.userIds — the pending approvers of the level that became current (or the reassignee)',
    inAppAlways: true, orgSetting: 'approvalPending', oneClick: true,
    vars: { ...APPROVAL_VARS, reassigned: 'flag' }, variants: { reassigned: {} }, variant: (p) => (p['reassigned'] === true ? 'reassigned' : null),
    route: approvalRoute, deepLink: approvalLink,
  }),
  entry({
    type: 'approval.reminder', category: 'APPROVAL', recipients: 'payload.userIds — the pending approvers of a level waiting 24 h (reminder) / each approver with pending items at 08:00 local (digest)',
    inAppAlways: true, orgSetting: 'approvalPending', oneClick: true,
    vars: { ...APPROVAL_VARS, kind: 'code', waitingSince: 'datetime', total: 'number', counts: 'counts', digestDate: 'date' },
    variants: { reminder: {}, digest: { orgSetting: 'dailyDigest', inAppAlways: false, oneClick: false } },
    variant: (p) => (p['kind'] === 'digest' ? 'digest' : 'reminder'),
    route: (p) => (p['kind'] === 'digest' ? route({ date: R.date(p['digestDate']) }) : approvalRoute(p)),
    deepLink: (p) => (p['kind'] === 'digest' ? '/approvals' : approvalLink(p)),
  }),
  entry({
    type: 'approval.escalated', category: 'APPROVAL', recipients: 'payload.userIds — the escalation target added to an overdue level (next level, HR admins or owners)',
    inAppAlways: true, orgSetting: 'approvalPending', oneClick: true,
    vars: { ...APPROVAL_VARS, dueAt: 'datetime' }, route: approvalRoute, deepLink: approvalLink,
  }),
  entry({
    type: 'approval.decided', category: 'APPROVAL', recipients: 'payload.userIds — the requester and the person concerned (not the decider; not the subject when the entity hook tells them itself)',
    orgSetting: 'attendanceNotes', orgSettingOf: byEntity,
    vars: { ...APPROVAL_VARS, decision: 'code', comment: 'text', exception: 'flag' },
    variants: { APPROVED: {}, REJECTED: {}, CANCELLED: {}, INVALIDATED: {} }, variant: (p) => decisionOf(p, ['APPROVED', 'REJECTED', 'CANCELLED', 'INVALIDATED']),
    route: approvalRoute, deepLink: approvalLink,
  }),
  entry({
    type: 'approval.info_requested', category: 'APPROVAL', recipients: 'payload.userIds — the requester and the person concerned (not the one asking; not the subject when the entity hook tells them itself)',
    inAppAlways: true, orgSetting: 'attendanceNotes', orgSettingOf: byEntity,
    vars: { ...APPROVAL_VARS, comment: 'text' }, route: approvalRoute, deepLink: approvalLink,
  }),
  entry({
    type: 'approval.info_answered', category: 'APPROVAL', recipients: 'payload.userIds — the pending approvers of the current level',
    inAppAlways: true, orgSetting: 'approvalPending',
    vars: { ...APPROVAL_VARS, comment: 'text' }, route: approvalRoute, deepLink: approvalLink,
  }),
  entry({
    type: 'approval.reassigned', category: 'APPROVAL', recipients: 'payload.userIds — the approvers whose seats were handed to somebody else',
    orgSetting: 'approvalPending', vars: { ...APPROVAL_VARS, reason: 'text' }, route: approvalRoute, deepLink: approvalLink,
  }),
  entry({
    type: 'approval.bypassed', category: 'APPROVAL', recipients: 'payload.userIds — the approvers who were still waiting when the request was approved as an exception',
    orgSetting: 'approvalPending', vars: { ...APPROVAL_VARS, reason: 'text' }, route: approvalRoute, deepLink: approvalLink,
  }),

  // ----- attendance ---------------------------------------------------------------------------------------------------------------
  entry({
    type: 'attendance.unexcused_marked', category: 'ATTENDANCE', recipients: 'payload.userIds — the employee and their line managers holding attendance.approve (else the approvers who can open the employee)',
    orgSetting: 'attendanceNotes', vars: { employeeName: 'text', dates: 'dates', count: 'number', autoDeduct: 'flag' },
    variants: { self: {}, manager: {} }, variant: (_p, ctx) => (ctx.audience === 'subject' ? 'self' : 'manager'),
    route: (p) => route({ entityType: 'EMPLOYEE', entityId: R.id(p['employeeId']), employeeId: R.id(p['employeeId']), date: Array.isArray(p['dates']) ? R.date(p['dates'][0]) : null }),
    deepLink: (p, ctx) => (ctx.audience === 'subject' ? path('/my/attendance', { month: month(Array.isArray(p['dates']) ? R.date(p['dates'][0]) : null) }) : path('/attendance', { employeeId: R.id(p['employeeId']) })),
  }),
  entry({
    type: 'attendance.note_submitted', category: 'ATTENDANCE', recipients: 'payload.userIds — the line managers who are not seated on the note\'s request (the seated ones get approval.pending)',
    orgSetting: 'attendanceNotes', vars: { employeeName: 'text', attendanceDate: 'date' },
    route: (p) => route({ entityType: 'ATTENDANCE_NOTE', entityId: R.id(p['noteId']) ?? R.id(p['aggregateId']), requestId: R.id(p['approvalRequestId']), date: R.date(p['attendanceDate']), employeeId: R.id(p['employeeId']) }),
    deepLink: (p) => (R.id(p['approvalRequestId']) ? path('/approvals', { request: R.id(p['approvalRequestId']) }) : '/attendance/notes'),
  }),
  entry({
    type: 'attendance.note_decided', category: 'ATTENDANCE', recipients: 'payload.userIds — the employee',
    orgSetting: 'attendanceNotes', vars: { attendanceDate: 'date', decision: 'code', reason: 'text', payEffectDays: 'number', chargeOutcome: 'code', leaveTypeCode: 'code', leaveTypeName: 'text', leaveTypeNameAr: 'text', lossOfPay: 'flag' },
    variants: { approved: {}, excused: {}, rejected: {}, rejected_leave: {}, rejected_lop: {} },
    variant: (p) => {
      const d = decisionOf(p, ['approved', 'excused', 'rejected']);
      if (d !== 'rejected') return d;
      if ((R.number(p['payEffectDays']) ?? 0) > 0 && (p['chargeOutcome'] === 'lop' || p['lossOfPay'] === true)) return 'rejected_lop';
      if ((R.number(p['payEffectDays']) ?? 0) > 0 && p['chargeOutcome'] === 'charged_leave') return 'rejected_leave';
      return 'rejected';
    },
    route: (p) => route({ entityType: 'ATTENDANCE_NOTE', entityId: R.id(p['noteId']) ?? R.id(p['aggregateId']), date: R.date(p['attendanceDate']), employeeId: R.id(p['employeeId']) }),
    deepLink: (p) => path('/my/requests', { tab: 'reasons', date: R.date(p['attendanceDate']) }),
  }),
  entry({
    type: 'attendance.note_info_requested', category: 'ATTENDANCE', recipients: 'payload.userIds — the employee',
    inAppAlways: true, orgSetting: 'attendanceNotes', vars: { attendanceDate: 'date', question: 'text' },
    route: (p) => route({ entityType: 'ATTENDANCE_NOTE', entityId: R.id(p['noteId']) ?? R.id(p['aggregateId']), date: R.date(p['attendanceDate']), employeeId: R.id(p['employeeId']) }),
    deepLink: (p) => path('/my/requests', { tab: 'reasons', date: R.date(p['attendanceDate']) }),
  }),
  entry({
    type: 'attendance.selfie_submitted', category: 'APPROVAL', recipients: 'payload.userIds — the line managers (else attendance.approve holders who can open the employee)',
    inAppAlways: true, orgSetting: 'attendanceNotes', vars: { employeeName: 'text', direction: 'code', at: 'datetime' },
    variants: { in: {}, out: {} }, variant: (p) => (p['direction'] === 'out' ? 'out' : 'in'),
    route: (p, ctx) => route({ entityType: 'SELFIE_CHECKIN', entityId: R.id(p['selfieId']) ?? R.id(p['aggregateId']), date: localDateOf(p['at'], ctx.timezone), employeeId: R.id(p['employeeId']) }),
    deepLink: () => path('/attendance/notes', { tab: 'selfies' }),
  }),
  entry({
    type: 'attendance.selfie_decided', category: 'ATTENDANCE', recipients: 'payload.userIds — the employee',
    orgSetting: 'attendanceNotes', vars: { decision: 'code', reason: 'text', at: 'datetime', direction: 'code' },
    variants: { approved: {}, rejected: {} }, variant: (p) => (p['decision'] === 'approved' ? 'approved' : 'rejected'),
    route: (p, ctx) => route({ entityType: 'SELFIE_CHECKIN', entityId: R.id(p['selfieId']) ?? R.id(p['aggregateId']), date: localDateOf(p['at'], ctx.timezone), employeeId: R.id(p['employeeId']) }),
    deepLink: (p, ctx) => path('/my/requests', { tab: 'selfies', date: localDateOf(p['at'], ctx.timezone) }),
  }),
  entry({
    type: 'attendance.punch_flagged', category: 'ATTENDANCE', recipients: 'payload.userIds — the line managers (else attendance.approve holders who can open the employee)',
    orgSetting: 'punchFlagged', vars: { employeeName: 'text', outcome: 'code', reason: 'code', geofenceName: 'text', distanceM: 'number', direction: 'code', at: 'datetime' },
    variants: { denied: {}, flagged: {} }, variant: (p) => (p['outcome'] === 'denied' ? 'denied' : 'flagged'),
    route: (p, ctx) => route({ entityType: 'EMPLOYEE', entityId: R.id(p['employeeId']), date: localDateOf(p['at'], ctx.timezone), employeeId: R.id(p['employeeId']) }),
    deepLink: (p, ctx) => path('/attendance', { employeeId: R.id(p['employeeId']), date: localDateOf(p['at'], ctx.timezone) }),
  }),
  entry({
    type: 'attendance.regularisation_decided', category: 'ATTENDANCE', recipients: 'payload.userIds — the employee',
    orgSetting: 'attendanceNotes', vars: { attendanceDate: 'date', type: 'code', decision: 'code', comment: 'text' },
    variants: { approved: {}, rejected: {} }, variant: (p) => (p['decision'] === 'approved' ? 'approved' : 'rejected'),
    route: (p) => route({ entityType: 'REGULARISATION', entityId: R.id(p['regularisationId']) ?? R.id(p['aggregateId']), date: R.date(p['attendanceDate']), employeeId: R.id(p['employeeId']) }),
    deepLink: (p) => path('/my/requests', { tab: 'regularisations', date: R.date(p['attendanceDate']) }),
  }),
  entry({
    type: 'punch.missing_out', category: 'ATTENDANCE', recipients: 'payload.userIds — the employee (worker task attendance.missing-punch-reminder, once per employee-day)',
    orgSetting: 'missingPunchReminder', vars: { attendanceDate: 'date', firstInAt: 'datetime', expectedEndAt: 'datetime', endSource: 'code', hours: 'number' },
    variants: { shift: {}, default: {} }, variant: (p) => (p['endSource'] === 'shift' ? 'shift' : 'default'),
    route: (p) => route({ entityType: 'EMPLOYEE', entityId: R.id(p['employeeId']), date: R.date(p['attendanceDate']), employeeId: R.id(p['employeeId']) }),
    // review 8-P2-4: /my exists in the live bundle and in this one (its check-in card carries the Check out button); /my/checkin
    // is new, and this notice is generated by the worker for every device user as soon as it deploys
    deepLink: () => '/my',
  }),
  entry({
    type: 'shift.swap_requested', category: 'ATTENDANCE', recipients: 'payload.userIds — the colleague named in the swap',
    orgSetting: 'attendanceNotes', vars: { requesterName: 'text', swapDate: 'date', requesterShiftName: 'text', targetShiftName: 'text' },
    route: (p) => route({ entityType: 'SHIFT_SWAP', entityId: R.id(p['swapId']) ?? R.id(p['aggregateId']), requestId: R.id(p['approvalRequestId']), date: R.date(p['swapDate']) }),
    deepLink: (p) => path('/my/shift', { date: R.date(p['swapDate']) }),
  }),
  entry({
    type: 'shift.swap_decided', category: 'ATTENDANCE', recipients: 'payload.userIds — the requester and the colleague',
    orgSetting: 'attendanceNotes', vars: { swapDate: 'date', decision: 'code', comment: 'text' },
    variants: { approved: {}, rejected: {} }, variant: (p) => (p['decision'] === 'approved' ? 'approved' : 'rejected'),
    route: (p) => route({ entityType: 'SHIFT_SWAP', entityId: R.id(p['swapId']) ?? R.id(p['aggregateId']), date: R.date(p['swapDate']) }),
    deepLink: (p) => path('/my/shift', { date: R.date(p['swapDate']) }),
  }),

  // ----- leave ------------------------------------------------------------------------------------------------------------------
  entry({
    type: 'leave.requested', category: 'APPROVAL', recipients: 'leave.manage holders — only for leave the approval engine did not route (older rows)',
    inAppAlways: true, orgSetting: 'approvalPending', vars: { employeeName: 'text', leaveTypeName: 'text', leaveTypeNameAr: 'text', startDate: 'date', endDate: 'date' },
    route: (p) => route({ entityType: 'LEAVE', entityId: R.id(p['aggregateId']), requestId: R.id(p['approvalRequestId']), date: R.date(p['startDate']), employeeId: R.id(p['employeeId']) }),
    deepLink: () => path('/leave', { status: 'PENDING' }),
  }),
  entry({
    type: 'leave.approved', category: 'LEAVE', recipients: 'payload.userId — the employee',
    orgSetting: 'leaveUpdates', vars: { leaveTypeName: 'text', leaveTypeNameAr: 'text', startDate: 'date', endDate: 'date', decisionNote: 'text' },
    route: (p) => route({ entityType: 'LEAVE', entityId: R.id(p['aggregateId']), date: R.date(p['startDate']), employeeId: R.id(p['employeeId']) }),
    deepLink: (p) => path('/my/leave', { request: R.id(p['aggregateId']) }),
  }),
  entry({
    type: 'leave.rejected', category: 'LEAVE', recipients: 'payload.userId — the employee',
    orgSetting: 'leaveUpdates', vars: { leaveTypeName: 'text', leaveTypeNameAr: 'text', startDate: 'date', endDate: 'date', decisionNote: 'text' },
    route: (p) => route({ entityType: 'LEAVE', entityId: R.id(p['aggregateId']), date: R.date(p['startDate']), employeeId: R.id(p['employeeId']) }),
    deepLink: (p) => path('/my/leave', { request: R.id(p['aggregateId']) }),
  }),
  entry({
    type: 'leave.info_requested', category: 'LEAVE', recipients: 'payload.userIds — the employee the leave is for',
    inAppAlways: true, orgSetting: 'leaveUpdates', vars: { leaveTypeName: 'text', leaveTypeNameAr: 'text', startDate: 'date', endDate: 'date', question: 'text' },
    route: (p) => route({ entityType: 'LEAVE', entityId: R.id(p['leaveRecordId']) ?? R.id(p['aggregateId']), requestId: R.id(p['approvalRequestId']), date: R.date(p['startDate']), employeeId: R.id(p['employeeId']) }),
    deepLink: (p) => path('/my/leave', { request: R.id(p['leaveRecordId']) ?? R.id(p['aggregateId']) }),
  }),
  entry({
    type: 'leave.comment_added', category: 'LEAVE', recipients: 'payload.userIds — the other side of the thread (the employee, or the approvers and HR)',
    orgSetting: 'leaveUpdates', vars: { employeeName: 'text', leaveTypeName: 'text', leaveTypeNameAr: 'text', excerpt: 'text', audience: 'code' },
    variants: { employee: {}, approvers: {} }, variant: (p) => (p['audience'] === 'employee' ? 'employee' : 'approvers'),
    route: (p) => route({ entityType: 'LEAVE', entityId: R.id(p['leaveRecordId']) ?? R.id(p['aggregateId']), requestId: R.id(p['approvalRequestId']), employeeId: R.id(p['employeeId']) }),
    deepLink: (p) => (p['audience'] === 'employee' ? path('/my/leave', { request: R.id(p['leaveRecordId']) ?? R.id(p['aggregateId']) }) : R.id(p['approvalRequestId']) ? path('/approvals', { request: R.id(p['approvalRequestId']) }) : '/leave'),
  }),
  entry({
    type: 'leave.year_closed', category: 'LEAVE', recipients: 'leave.manage holders + payload.userId (the HR user who queued it)',
    orgSetting: 'leaveUpdates', vars: { fromYear: 'number', toYear: 'number', carried: 'number', totalDays: 'number' },
    route: () => route({ entityType: 'LEAVE_YEAR' }), deepLink: () => path('/leave', { tab: 'allocations' }),
  }),
  entry({
    type: 'leave.comp_off_expired', category: 'LEAVE', recipients: 'payload.userId — the employee',
    orgSetting: 'leaveUpdates', vars: { days: 'number', credits: 'number', expiredOn: 'date' },
    route: (p) => route({ entityType: 'COMP_OFF', date: R.date(p['expiredOn']), employeeId: R.id(p['employeeId']) }), deepLink: () => '/my/leave',
  }),

  // ----- reports ----------------------------------------------------------------------------------------------------------------
  entry({
    type: 'report.ready', category: 'REPORTS', recipients: 'payload.userId — who requested the report',
    orgSetting: 'reportReady', vars: { reportTitle: 'text', reportType: 'code', format: 'code' },
    route: (p) => route({ entityType: 'REPORT', entityId: R.id(p['reportId']) ?? R.id(p['aggregateId']) }),
    // opens the report straight in the viewer (the file is fetched through the reader's own session, never a mailed bearer link)
    deepLink: (p) => path('/reports', { view: R.id(p['reportId']) ?? R.id(p['aggregateId']) }),
  }),
  entry({
    type: 'report.failed', category: 'REPORTS', recipients: 'payload.userId — who requested (or shared / scheduled) the report',
    orgSetting: 'reportReady', vars: { reportTitle: 'text', reportType: 'code', error: 'text' },
    route: (p) => route({ entityType: 'REPORT', entityId: R.id(p['reportId']) ?? R.id(p['aggregateId']) }), deepLink: () => '/reports',
  }),
  entry({
    type: 'report.scheduled_delivery', category: 'REPORTS', recipients: 'payload.userIds — the recipient of the delivered copy (channels chosen by the sender / schedule)',
    orgSetting: 'reportScheduledDelivery', vars: { reportTitle: 'text', reportType: 'code', mode: 'code', periodFrom: 'date', periodTo: 'date', scheduleName: 'text', selfScope: 'flag' },
    variants: { send_now: {}, scheduled: {} }, variant: (p) => (p['mode'] === 'send_now' ? 'send_now' : 'scheduled'),
    route: (p) => route({ entityType: 'REPORT', entityId: R.id(p['reportId']) ?? R.id(p['aggregateId']), date: R.date(p['periodTo']) }),
    // a copy about the recipient themselves (an employee without report access) opens in the employee portal; the others open the
    // report viewer on the Reports page — both through the reader's own session
    deepLink: (p) => path(p['selfScope'] === true ? '/my/reports' : '/reports', { view: R.id(p['reportId']) ?? R.id(p['aggregateId']) }),
  }),

  // ----- devices, sync, system --------------------------------------------------------------------------------------------------
  entry({
    type: 'device.offline', category: 'DEVICE', recipients: 'device.view holders (deduplicated per device within 15 minutes)',
    orgSetting: 'deviceOffline', vars: { deviceName: 'text', lastSeenAt: 'datetime' },
    route: (p) => route({ entityType: 'DEVICE', entityId: R.id(p['deviceId']) ?? R.id(p['aggregateId']) }), deepLink: (p) => `/devices/${R.id(p['deviceId']) ?? R.id(p['aggregateId']) ?? ''}`.replace(/\/$/, ''),
  }),
  entry({
    type: 'device.online', category: 'DEVICE', recipients: 'device.view holders (deduplicated per device within 15 minutes)',
    orgSetting: 'deviceOffline', vars: { deviceName: 'text', lastSeenAt: 'datetime' },
    route: (p) => route({ entityType: 'DEVICE', entityId: R.id(p['deviceId']) ?? R.id(p['aggregateId']) }), deepLink: (p) => `/devices/${R.id(p['deviceId']) ?? R.id(p['aggregateId']) ?? ''}`.replace(/\/$/, ''),
  }),
  entry({
    type: 'sync.failed', category: 'DEVICE', recipients: 'device.sync holders',
    orgSetting: 'syncFailed', vars: { jobType: 'code', error: 'text' },
    route: (p) => route({ entityType: 'SYNC_JOB', entityId: R.id(p['syncJobId']) ?? R.id(p['aggregateId']) }), deepLink: (p) => `/sync/${R.id(p['syncJobId']) ?? R.id(p['aggregateId']) ?? ''}`.replace(/\/$/, ''),
  }),
  entry({
    type: 'sync.completed', category: 'DEVICE', recipients: 'device.sync holders — manual syncs only (never the scheduler\'s polls and health checks)',
    vars: { jobType: 'code', itemsSuccess: 'number', itemsFailed: 'number' },
    route: (p) => route({ entityType: 'SYNC_JOB', entityId: R.id(p['syncJobId']) ?? R.id(p['aggregateId']) }), deepLink: (p) => `/sync/${R.id(p['syncJobId']) ?? R.id(p['aggregateId']) ?? ''}`.replace(/\/$/, ''),
  }),
  entry({
    type: 'sync.finance.failed', category: 'DEVICE', recipients: 'integration.manage holders (who can act on Settings → Integrations)',
    orgSetting: 'syncFailed', vars: { direction: 'code', consecutiveFailures: 'number', code: 'code', error: 'text', reason: 'code', punches: 'number' },
    variants: { streak: {}, batch_skipped: {} }, variant: (p) => (p['reason'] === 'batch_skipped' ? 'batch_skipped' : 'streak'),
    route: (p) => route({ entityType: 'DEVICE', entityId: R.id(p['deviceId']) ?? R.id(p['aggregateId']) }), deepLink: () => '/settings/integrations',
  }),
  entry({
    type: 'employee.imported', category: 'SYSTEM', recipients: 'employee.import holders',
    userConfigurable: false, vars: { phase: 'code', validRows: 'number', imported: 'number' },
    variants: { queued: {}, finished: {} }, variant: (p) => (p['phase'] === 'queued' ? 'queued' : 'finished'),
    route: (p) => route({ entityType: 'IMPORT', entityId: R.id(p['importId']) ?? R.id(p['aggregateId']) }),
    // review 8-P2-5: the import page is /employees/import and reads the import from ?importId=
    deepLink: (p) => path('/employees/import', { importId: R.id(p['importId']) ?? R.id(p['aggregateId']) }),
  }),
  entry({
    type: 'subscription.limit_reached', category: 'SUBSCRIPTION', recipients: 'organization.manage holders',
    userConfigurable: false, vars: { metric: 'code', limit: 'number' },
    route: () => route({ entityType: 'SUBSCRIPTION' }), deepLink: () => '/settings/subscription',
  }),
];

export const NOTIFICATION_CATALOGUE: Readonly<Record<string, NotificationCatalogueEntry>> = Object.freeze(Object.fromEntries(ENTRIES.map((e) => [e.type, e])));
export const NOTIFICATION_TYPES: readonly DomainEventType[] = ENTRIES.map((e) => e.type);

/**
 * Domain events that are published (realtime invalidation, webhooks) but never become a notification. A new
 * DOMAIN_EVENT_TYPES entry must be catalogued or listed here (a contracts test enforces it) — nothing is silent by accident.
 */
export const NON_NOTIFYING_EVENT_TYPES = [
  'employee.created', 'employee.updated', 'employee.deleted',
  'device.created', 'device.updated', 'device.credentials_changed',
  'sync.queued', 'sync.item_failed',
  'attendance.created', 'attendance.updated', 'attendance.correction_submitted',
  // review 8-P0-4: a correction's outcome reaches the requester and the person concerned through approval.decided (one notice
  // each, never the decider) and its approvers through approval.pending; these two stay published for realtime only
  'attendance.correction_approved', 'attendance.correction_rejected',
] as const satisfies readonly DomainEventType[];

export function notificationEntry(type: string): NotificationCatalogueEntry | null {
  return NOTIFICATION_CATALOGUE[type] ?? null;
}
/** Every template key a type can render: the base key and one per variant (`type#variant`). */
export function notificationTemplateKeys(entry: NotificationCatalogueEntry): string[] {
  return [entry.type, ...Object.keys(entry.variants).map((v) => `${entry.type}#${v}`)];
}

export interface ResolvedNotification {
  entry: NotificationCatalogueEntry;
  variant: string | null;
  templateKey: string;
  orgSetting: NotificationOrgSwitch | null;
  inAppAlways: boolean;
  oneClick: boolean;
  link: string;
  route: NotificationRoute;
}
/** The catalogue's answer for one recipient of one event (null for a type that is not catalogued). */
export function resolveNotification(type: string, payload: NotificationPayload, ctx: NotificationContext): ResolvedNotification | null {
  const entry = notificationEntry(type);
  if (!entry) return null;
  const v = entry.variant(payload, ctx);
  const variant = v !== null && Object.hasOwn(entry.variants, v) ? v : null;
  const spec: NotificationVariantSpec = variant ? entry.variants[variant] ?? {} : {};
  return {
    entry, variant, templateKey: variant ? `${entry.type}#${variant}` : entry.type,
    orgSetting: spec.orgSetting !== undefined ? spec.orgSetting : (entry.orgSettingOf?.(payload) ?? entry.orgSetting),
    inAppAlways: spec.inAppAlways ?? entry.inAppAlways,
    oneClick: spec.oneClick ?? entry.oneClick,
    link: entry.deepLink(payload, ctx),
    route: entry.route(payload, ctx),
  };
}

export interface NotificationChannelDecision {
  inApp: boolean;
  email: boolean;
  /** Why a channel was left out (for logs and tests): not requested, org switch off, user preference off. */
  reasons: { inApp?: 'not_requested' | 'preference'; email?: 'not_requested' | 'org_switch' | 'preference' };
}
/**
 * Channels for one recipient × one notification:
 *  - the event may ask for a subset (`payload.channels`, report deliveries); the type's default channels bound it;
 *  - IN_APP: the user's (category, IN_APP) preference applies to configurable types, never to items they must act on
 *    (`inAppAlways`) — the inbox is part of the product;
 *  - EMAIL: off when the organisation switch that governs the type is off, else the user's (category, EMAIL) preference
 *    for configurable types; non-configurable types (system, subscription) ignore user preferences.
 * Absent preference = on (defaults).
 */
export function decideNotificationChannels(input: {
  resolved: Pick<ResolvedNotification, 'entry' | 'orgSetting' | 'inAppAlways'>;
  orgSettings: Pick<NotificationSettings, NotificationOrgSwitch>;
  preferences: Partial<Record<NotificationDeliveryChannel, boolean>>;
  requested?: { inApp: boolean; email: boolean };
}): NotificationChannelDecision {
  const { resolved, orgSettings, preferences } = input;
  const requested = input.requested ?? { inApp: true, email: true };
  const reasons: NotificationChannelDecision['reasons'] = {};
  let inApp = requested.inApp && resolved.entry.defaultChannels.includes('IN_APP');
  if (!inApp) reasons.inApp = 'not_requested';
  else if (resolved.entry.userConfigurable && !resolved.inAppAlways && preferences.IN_APP === false) { inApp = false; reasons.inApp = 'preference'; }
  let email = requested.email && resolved.entry.defaultChannels.includes('EMAIL');
  if (!email) reasons.email = 'not_requested';
  else if (resolved.orgSetting && orgSettings[resolved.orgSetting] === false) { email = false; reasons.email = 'org_switch'; }
  else if (resolved.entry.userConfigurable && preferences.EMAIL === false) { email = false; reasons.email = 'preference'; }
  return { inApp, email, reasons };
}

/** The routing facts every notice may carry in `notifications.data` (Prompt 5's client routing reads them). */
export const NOTIFICATION_ROUTE_KEYS = ['entityType', 'entityId', 'requestId', 'date', 'employeeId'] as const satisfies readonly (keyof NotificationRoute)[];
/**
 * The keys `notifications.data` may hold for a type: the aggregate, the routing facts and the catalogue's template variables of
 * the type; a type the catalogue does not know keeps the aggregate and the routing facts only (review 8-P0-5 — the one-time
 * scrub of the rows the pre-Prompt-8 relay wrote with the whole event payload keeps exactly these).
 */
export function notificationDataKeys(type: string): string[] {
  const entry = notificationEntry(type);
  return [...new Set(['aggregateType', 'aggregateId', ...NOTIFICATION_ROUTE_KEYS, ...Object.keys(entry?.vars ?? {})])];
}

/**
 * What `notifications.data` carries: the aggregate, the routing facts and the template variables the catalogue declares for
 * the type — validated per kind, strings bounded. Nothing else of the payload (no recipient lists, no other people's ids,
 * no free-form fields the template does not need).
 */
export function notificationData(entry: NotificationCatalogueEntry, payload: NotificationPayload, resolvedRoute: NotificationRoute, aggregate: { type: string; id: string | null }): Record<string, unknown> {
  const out: Record<string, unknown> = { aggregateType: aggregate.type, aggregateId: aggregate.id };
  for (const [k, v] of Object.entries(resolvedRoute)) if (v !== null) out[k] = v;
  for (const [key, kind] of Object.entries(entry.vars)) {
    const v = readVar(kind, payload[key]);
    if (v !== null) out[key] = v;
  }
  return out;
}

/** A payload value read as the declared kind (null when absent or malformed). */
export function readVar(kind: NotificationVarKind, v: unknown): unknown {
  switch (kind) {
    case 'text': return R.text(v);
    case 'date': return R.date(v);
    case 'datetime': return R.instant(v);
    case 'number': return R.number(v);
    case 'code': return R.code(v);
    case 'flag': return typeof v === 'boolean' ? v : null;
    case 'dates': return Array.isArray(v) ? v.map(R.date).filter((d): d is string => d !== null).slice(0, 31) : null;
    case 'counts': return Array.isArray(v)
      ? v.flatMap((c) => {
        const o = c !== null && typeof c === 'object' ? (c as Record<string, unknown>) : {};
        const entityType = R.code(o['entityType']); const count = R.number(o['count']);
        return entityType && count !== null ? [{ entityType, count }] : [];
      }).slice(0, 20)
      : null;
  }
}

/**
 * The structured facts an approval notification carries besides the entity type and the person (template variables `date`,
 * `endDate`, `leaveTypeName`): the day the request is about, or a leave's dates and type. The API derives them from the
 * inbox context it already loads; the worker's reminders read the same columns (apps/worker approvals/facts.ts).
 */
export interface ApprovalNotificationFacts {
  date: string | null; endDate: string | null; leaveTypeName: string | null;
  /** The leave type's Arabic name (`leave_types.name_ar`) when it has one — an Arabic notice prints it (review 8-P2-2). */
  leaveTypeNameAr?: string | null;
}
export function approvalContextFacts(context: ApprovalContextDto | null | undefined): ApprovalNotificationFacts {
  const none: ApprovalNotificationFacts = { date: null, endDate: null, leaveTypeName: null };
  if (!context) return none;
  switch (context.kind) {
    case 'LEAVE': return { date: R.date(context.leave.startDate), endDate: R.date(context.leave.endDate), leaveTypeName: R.text(context.leave.leaveTypeName) };
    case 'ATTENDANCE_CORRECTION': return { ...none, date: R.date(context.correction.attendanceDate) };
    case 'ATTENDANCE_NOTE': return { ...none, date: R.date(context.note.attendanceDate) };
    case 'REGULARISATION': return { ...none, date: R.date(context.regularisation.attendanceDate) };
    case 'SHIFT_SWAP': return { ...none, date: R.date(context.swap.swapDate) };
    case 'COMP_OFF': return { ...none, date: R.date(context.compOff.workedOn) };
    default: return none;
  }
}

// ----- the preference matrix ---------------------------------------------------------------------------------------------------

/** Settings / profile order of the categories. */
export const NOTIFICATION_CATEGORY_ORDER = ['APPROVAL', 'ATTENDANCE', 'LEAVE', 'REPORTS', 'DEVICE', 'SYSTEM', 'SUBSCRIPTION'] as const satisfies readonly NotificationCategory[];
/**
 * Whom a category concerns (the profile shows the relevant rows only; the API still accepts any configurable cell):
 * null = everybody, else a member holding at least one of the permissions.
 */
export const NOTIFICATION_CATEGORY_AUDIENCE: Readonly<Record<NotificationCategory, readonly Permission[] | null>> = {
  APPROVAL: null, ATTENDANCE: null, LEAVE: null, SYSTEM: null,
  REPORTS: ['report.view', 'report.export', 'report.manage', 'report.schedule'],
  DEVICE: ['device.view', 'device.sync', 'integration.manage'],
  SUBSCRIPTION: ['organization.manage'],
};

export interface NotificationPreferenceCell {
  category: NotificationCategory;
  channel: NotificationDeliveryChannel;
  /** The user may switch this cell (at least one configurable type of the category is delivered on the channel). */
  configurable: boolean;
  /** Types of the category delivered on this channel whatever the switch says (items to act on, system notices). */
  alwaysOn: string[];
}
/** The (category × channel) cells of the preference matrix, derived from the catalogue. */
export function notificationPreferenceCells(): NotificationPreferenceCell[] {
  const out: NotificationPreferenceCell[] = [];
  for (const category of NOTIFICATION_CATEGORY_ORDER) {
    const entries = ENTRIES.filter((e) => e.category === category);
    for (const channel of NOTIFICATION_DELIVERY_CHANNELS) {
      const onChannel = entries.filter((e) => e.defaultChannels.includes(channel));
      const configurable = onChannel.some((e) => e.userConfigurable && (channel === 'EMAIL' || !e.inAppAlways || Object.values(e.variants).some((v) => v.inAppAlways === false)));
      const alwaysOn = onChannel.filter((e) => !e.userConfigurable || (channel === 'IN_APP' && e.inAppAlways)).map((e) => e.type);
      out.push({ category, channel, configurable, alwaysOn });
    }
  }
  return out;
}
export function isConfigurablePreference(category: NotificationCategory, channel: NotificationDeliveryChannel): boolean {
  return notificationPreferenceCells().some((c) => c.category === category && c.channel === channel && c.configurable);
}

// guard: the catalogue never names a category or channel the enums do not know
for (const e of ENTRIES) {
  if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(e.category)) throw new Error(`notification catalogue: unknown category ${e.category}`);
}
