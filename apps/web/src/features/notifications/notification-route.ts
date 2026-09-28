import type { NotificationDto } from './use-notifications';

/**
 * Where a notification takes its reader (HR portal Prompt 5, Finance B-66). The worker's `link` is written for the
 * recipient it expected; the page the reader can actually work on depends on who they are, which only the client knows
 * cheaply (their keys and team from /me). The worker is not changed: the route is derived from `type` + `data` here, and
 * `link` is the fallback for every type this table does not know.
 *
 * - the subject employee of an approval → the matching self-service page (/my/leave, /my/requests?tab=…, /my/shift, …);
 * - a line manager WITHOUT attendance.approve / leave.approve → their team queue (/team?tab=approvals);
 * - an approver (or a delegate / named approver) → the request panel in the inbox (/approvals?request=<id>).
 */
export interface NotificationViewer {
  /** The reader's own employee record in the organisation (null when not linked). */
  employeeId: string | null;
  /** attendance.approve or leave.approve. */
  approver: boolean;
  /** The reader's employee record has direct reports (/me: isManager). */
  hasReports: boolean;
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

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

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

/** Only in-app paths are followed; anything else falls back to the default page of the reader's role. */
const safeLink = (link: string | null | undefined): string | null => (link && link.startsWith('/') && !link.startsWith('//') ? link : null);

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
  return link ?? SELF_PAGES[n.type] ?? null;
}
