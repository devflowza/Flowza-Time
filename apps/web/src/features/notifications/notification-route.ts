import type { NotificationDto } from './use-notifications';

/**
 * Where a notification takes its reader (HR portal Prompt 5, Finance B-66). The worker's `link` is written for the
 * recipient it expected; the page the reader can actually work on depends on who they are, which only the client knows
 * cheaply (their keys and team from /me). The worker is not changed: the route is derived from `type` + `data` here, and
 * `link` is the fallback for every type this table does not know.
 *
 * - the subject employee of an approval → the matching self-service page (/my/leave, /my/requests?tab=…, /my/shift, …);
 * - a line manager WITHOUT attendance.approve / leave.approve → their team queue (/team?tab=approvals);
 * - an approver (or a delegate / named approver) → the request panel in the inbox (/approvals?request=<id>);
 * - an attendance notice about one employee's day (a flagged punch, an unexcused day, a decided correction — any link to the
 *   HR register `/attendance?employeeId=…`, review P1-6): the employee it is about → their own page (/my/attendance?date=…);
 *   a line manager WITHOUT attendance.view (the register would send them to their OWN attendance) → the team workspace for
 *   that report and day (/team?tab=attendance&employeeId=…&date=…); anybody holding attendance.view → the register.
 */
export interface NotificationViewer {
  /** The reader's own employee record in the organisation (null when not linked). */
  employeeId: string | null;
  /** attendance.approve or leave.approve. */
  approver: boolean;
  /** The reader's employee record has direct reports (/me: isManager). */
  hasReports: boolean;
  /** attendance.view — the organisation's register (/attendance). Absent = assumed held (the register link is followed). */
  attendanceView?: boolean;
}

/** Approval notifications that ask the reader to act. */
const ACTION_TYPES = new Set(['approval.pending', 'approval.reminder', 'approval.escalated', 'approval.reassigned', 'approval.info_answered']);
/** Every approval notification (the others report an outcome). */
const APPROVAL_TYPES = new Set([...ACTION_TYPES, 'approval.decided', 'approval.info_requested', 'approval.bypassed']);
/** Employee-facing types with their self-service page, used when a stored notification carries no link. */
const SELF_PAGES: Record<string, string> = {
  'attendance.note_decided': '/my/requests?tab=reasons',
  'attendance.note_info_requested': '/my/requests?tab=reasons',
  'attendance.selfie_decided': '/my/requests?tab=selfies',
  'attendance.regularisation_decided': '/my/requests?tab=regularisations',
  'leave.approved': '/my/leave',
  'leave.rejected': '/my/leave',
  'leave.comp_off_expired': '/my/leave',
  'shift.swap_requested': '/my/shift',
  'shift.swap_decided': '/my/shift',
};

/** Attendance notices about one employee's day: their stored link points at the HR register. */
const ATTENDANCE_DAY_TYPES = new Set(['attendance.punch_flagged', 'attendance.unexcused_marked', 'attendance.correction_approved', 'attendance.correction_rejected']);

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDate = (v: unknown): string | null => { const s = text(v); return s && ISO_DATE.test(s) ? s : null; };

/** The subject employee's own page for a request of this entity type. */
export function selfRouteFor(entityType: string | null): string {
  switch (entityType) {
    case 'LEAVE':
    case 'COMP_OFF': return '/my/leave';
    case 'ATTENDANCE_NOTE': return '/my/requests?tab=reasons';
    case 'REGULARISATION':
    case 'MISSING_PUNCH': return '/my/requests?tab=regularisations';
    case 'SHIFT_SWAP': return '/my/shift';
    case 'ATTENDANCE_CORRECTION': return '/my/attendance?tab=corrections';
    default: return '/my';
  }
}

/** The base every link is resolved against: a link is followed only when it stays on it (same origin). */
const LINK_BASE = 'https://x.invalid';

/**
 * Only in-app paths are followed (review P2-5); anything else falls back to the default page of the reader's role. A link must
 * be a path that the WHATWG URL parser — the browser's — resolves to the SAME origin: `//host`, `/\host`, `/\/host` and
 * `/<TAB>/host` all resolve to another host, so backslashes and control characters (tab, CR, LF, …) are refused outright.
 */
export function safeLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(link)) return null;
  try {
    return new URL(link, LINK_BASE).origin === LINK_BASE ? link : null;
  } catch {
    return null;
  }
}

/** The employee (and day) of an attendance notice: from its register link, else — for the known types — from its data. */
function attendanceTarget(type: string, link: string | null, data: Record<string, unknown>): { employeeId: string; date: string | null } | null {
  if (link) {
    const u = new URL(link, LINK_BASE);
    const employeeId = u.pathname === '/attendance' ? u.searchParams.get('employeeId') : null;
    if (employeeId && ID.test(employeeId)) return { employeeId, date: isoDate(u.searchParams.get('date')) };
  }
  if (!ATTENDANCE_DAY_TYPES.has(type)) return null;
  const employeeId = text(data['employeeId']);
  if (!employeeId || !ID.test(employeeId)) return null;
  const dates = Array.isArray(data['dates']) ? data['dates'] : [];
  return { employeeId, date: isoDate(data['attendanceDate']) ?? isoDate(data['date']) ?? isoDate(dates[0]) };
}

export function resolveNotificationRoute(n: Pick<NotificationDto, 'type' | 'data' | 'link'>, viewer: NotificationViewer): string | null {
  const data = n.data ?? {};
  const link = safeLink(n.link);
  const requestId = text(data['requestId']) ?? (text(data['aggregateType']) === 'approval_request' ? text(data['aggregateId']) : null);
  const subject = text(data['employeeId']);
  const isSubject = !!viewer.employeeId && subject === viewer.employeeId;
  const lineManagerOnly = viewer.hasReports && !viewer.approver;
  const queue = lineManagerOnly ? '/team?tab=approvals' : '/approvals';
  const panel = requestId ? `/approvals?request=${encodeURIComponent(requestId)}` : null;

  if (APPROVAL_TYPES.has(n.type)) {
    if (isSubject) return selfRouteFor(text(data['entityType']));
    if (n.type === 'approval.reminder' && data['kind'] === 'digest') return queue;
    if (ACTION_TYPES.has(n.type)) return lineManagerOnly ? queue : panel ?? queue;
    // an outcome (decided, question, exception): the request panel shows what happened
    return panel ?? link ?? '/approvals';
  }
  // a reason waiting for review: the line manager reviews it on their team queue; HR on the review page
  if (n.type === 'attendance.note_submitted') return lineManagerOnly ? queue : link ?? '/attendance/notes';
  // an attendance notice about one employee's day (review P1-6)
  const target = attendanceTarget(n.type, link, data);
  if (target) {
    if (viewer.employeeId && target.employeeId === viewer.employeeId) return target.date ? `/my/attendance?date=${target.date}` : '/my/attendance';
    if (viewer.attendanceView === false && viewer.hasReports) {
      return `/team?tab=attendance&employeeId=${encodeURIComponent(target.employeeId)}${target.date ? `&date=${target.date}` : ''}`;
    }
    return link ?? `/attendance?employeeId=${encodeURIComponent(target.employeeId)}${target.date ? `&date=${target.date}` : ''}`;
  }
  return link ?? SELF_PAGES[n.type] ?? null;
}
