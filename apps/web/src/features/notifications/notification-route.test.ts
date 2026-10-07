import { describe, expect, it } from 'vitest';
import { resolveNotificationRoute, safeLink, selfRouteFor, type NotificationViewer } from './notification-route';

/**
 * The bell routing matrix (HR portal Prompt 5, Finance B-66): the same notification takes a line manager without an approve
 * key to their team queue, an approver to the request panel, and the employee it is about to their own page.
 */
const LINE_MANAGER: NotificationViewer = { employeeId: 'e4', approver: false, hasReports: true };
const APPROVER: NotificationViewer = { employeeId: 'e9', approver: true, hasReports: false };
const MANAGER_APPROVER: NotificationViewer = { employeeId: 'e4', approver: true, hasReports: true };
const DELEGATE: NotificationViewer = { employeeId: null, approver: false, hasReports: false };
const EMPLOYEE: NotificationViewer = { employeeId: 'e5', approver: false, hasReports: false };

const approval = (type: string, data: Record<string, unknown> = {}, link: string | null = '/approvals/requests/req-1') => ({ type, link, data: { aggregateType: 'approval_request', aggregateId: 'req-1', requestId: 'req-1', entityType: 'LEAVE', entityId: 'l1', employeeId: 'e5', ...data } });

describe('resolveNotificationRoute', () => {
  it.each([
    ['approval.pending', LINE_MANAGER, '/team?tab=approvals'],
    ['approval.pending', APPROVER, '/approvals?request=req-1'],
    ['approval.pending', MANAGER_APPROVER, '/approvals?request=req-1'],
    ['approval.pending', DELEGATE, '/approvals?request=req-1'],
    ['approval.escalated', LINE_MANAGER, '/team?tab=approvals'],
    ['approval.reassigned', APPROVER, '/approvals?request=req-1'],
    ['approval.info_answered', LINE_MANAGER, '/team?tab=approvals'],
    ['approval.reminder', LINE_MANAGER, '/team?tab=approvals'],
  ])('%s → the reader\'s queue (%#)', (type, viewer, route) => {
    expect(resolveNotificationRoute(approval(type), viewer)).toBe(route);
  });

  it('takes the employee the request is about to their own page, per entity type', () => {
    expect(resolveNotificationRoute(approval('approval.decided'), EMPLOYEE)).toBe('/my/leave');
    expect(resolveNotificationRoute(approval('approval.info_requested', { entityType: 'ATTENDANCE_NOTE' }), EMPLOYEE)).toBe('/my/requests?tab=reasons');
    expect(resolveNotificationRoute(approval('approval.decided', { entityType: 'REGULARISATION' }), EMPLOYEE)).toBe('/my/requests?tab=regularisations');
    expect(resolveNotificationRoute(approval('approval.decided', { entityType: 'SHIFT_SWAP' }), EMPLOYEE)).toBe('/my/shift');
    expect(resolveNotificationRoute(approval('approval.decided', { entityType: 'SHIFT_CHANGE' }), EMPLOYEE)).toBe('/my/shift');
    expect(resolveNotificationRoute(approval('approval.decided', { entityType: 'ATTENDANCE_CORRECTION' }), EMPLOYEE)).toBe('/my/attendance?tab=corrections');
    expect(selfRouteFor(null)).toBe('/my');
  });

  it('shows an outcome in the request panel to anybody else (a requester filing for a report, a skipped approver)', () => {
    expect(resolveNotificationRoute(approval('approval.decided', { employeeId: 'e7' }), LINE_MANAGER)).toBe('/approvals?request=req-1');
    expect(resolveNotificationRoute(approval('approval.bypassed'), APPROVER)).toBe('/approvals?request=req-1');
  });

  it('sends a digest reminder to the queue, not to one request', () => {
    const digest = { type: 'approval.reminder', link: '/approvals', data: { kind: 'digest', total: 4 } };
    expect(resolveNotificationRoute(digest, APPROVER)).toBe('/approvals');
    expect(resolveNotificationRoute(digest, LINE_MANAGER)).toBe('/team?tab=approvals');
  });

  it('derives the route from type + data when the stored link is missing, and falls back to the link for other types', () => {
    expect(resolveNotificationRoute(approval('approval.pending', {}, null), APPROVER)).toBe('/approvals?request=req-1');
    expect(resolveNotificationRoute({ type: 'attendance.note_decided', link: null, data: {} }, EMPLOYEE)).toBe('/my/requests?tab=reasons');
    expect(resolveNotificationRoute({ type: 'leave.rejected', link: null, data: {} }, EMPLOYEE)).toBe('/my/leave');
    expect(resolveNotificationRoute({ type: 'device.offline', link: '/devices/d1', data: {} }, APPROVER)).toBe('/devices/d1');
    expect(resolveNotificationRoute({ type: 'something.new', link: null, data: {} }, APPROVER)).toBeNull();
  });

  it('routes a reason waiting for review to the line manager\'s team queue, HR to the review page', () => {
    const note = { type: 'attendance.note_submitted', link: '/attendance/notes', data: { employeeId: 'e5' } };
    expect(resolveNotificationRoute(note, LINE_MANAGER)).toBe('/team?tab=approvals');
    expect(resolveNotificationRoute(note, APPROVER)).toBe('/attendance/notes');
  });

  it('never follows a link outside the app', () => {
    expect(resolveNotificationRoute({ type: 'device.offline', link: 'https://evil.example/x', data: {} }, APPROVER)).toBeNull();
    expect(resolveNotificationRoute({ type: 'device.offline', link: '//evil.example/x', data: {} }, APPROVER)).toBeNull();
    expect(resolveNotificationRoute(approval('approval.decided', { requestId: null, aggregateId: null }, 'javascript:alert(1)'), APPROVER)).toBe('/approvals');
  });
});

describe('review 5-P1-6 — attendance notices about a report', () => {
  const REPORT = 'e0000000-0000-4000-8000-000000000005';
  const SELF = 'e0000000-0000-4000-8000-000000000004';
  // the live system Line Manager role: attendance.approve / correct / view_team, NOT attendance.view
  const MANAGER: NotificationViewer = { employeeId: SELF, approver: true, hasReports: true, attendanceView: false };
  const HR: NotificationViewer = { employeeId: 'e9', approver: true, hasReports: false, attendanceView: true };
  const SUBJECT: NotificationViewer = { employeeId: REPORT, approver: false, hasReports: false, attendanceView: false };
  const notices = [
    { type: 'attendance.punch_flagged', link: `/attendance?employeeId=${REPORT}&date=2026-09-20`, data: { employeeId: REPORT, at: '2026-09-20T05:10:00Z' } },
    { type: 'attendance.unexcused_marked', link: `/attendance?employeeId=${REPORT}`, data: { employeeId: REPORT, dates: ['2026-09-20', '2026-09-21'] } },
    { type: 'attendance.correction_approved', link: `/attendance?employeeId=${REPORT}&date=2026-09-20`, data: { employeeId: REPORT, attendanceDate: '2026-09-20' } },
    { type: 'attendance.correction_rejected', link: `/attendance?employeeId=${REPORT}&date=2026-09-20`, data: { employeeId: REPORT, attendanceDate: '2026-09-20' } },
  ];

  it('5-P1-6 a line manager without attendance.view goes to the team page for that report and day — not to their own attendance', () => {
    expect(notices.map((n) => resolveNotificationRoute(n, MANAGER))).toEqual([
      `/team?tab=attendance&employeeId=${REPORT}&date=2026-09-20`,
      `/team?tab=attendance&employeeId=${REPORT}`,
      `/team?tab=attendance&employeeId=${REPORT}&date=2026-09-20`,
      `/team?tab=attendance&employeeId=${REPORT}&date=2026-09-20`,
    ]);
  });

  it('5-P1-6 the employee the notice is about goes to their own page on that day; an HR reader follows the register link', () => {
    expect(resolveNotificationRoute(notices[2]!, SUBJECT)).toBe('/my/attendance?date=2026-09-20');
    // the worker's subject link (a month) — the data still names the day
    expect(resolveNotificationRoute({ type: 'attendance.unexcused_marked', link: '/my/attendance?month=2026-09', data: { employeeId: REPORT, dates: ['2026-09-20'] } }, SUBJECT)).toBe('/my/attendance?date=2026-09-20');
    expect(notices.map((n) => resolveNotificationRoute(n, HR))).toEqual(notices.map((n) => n.link));
  });

  it('5-P1-6 any other register link about an employee is treated the same; a notice without a link is routed from its data', () => {
    expect(resolveNotificationRoute({ type: 'attendance.something_new', link: `/attendance?employeeId=${REPORT}&date=2026-09-19`, data: {} }, MANAGER)).toBe(`/team?tab=attendance&employeeId=${REPORT}&date=2026-09-19`);
    expect(resolveNotificationRoute({ type: 'attendance.correction_approved', link: null, data: { employeeId: REPORT, attendanceDate: '2026-09-18' } }, MANAGER)).toBe(`/team?tab=attendance&employeeId=${REPORT}&date=2026-09-18`);
    expect(resolveNotificationRoute({ type: 'attendance.correction_approved', link: null, data: { employeeId: REPORT, attendanceDate: '2026-09-18' } }, HR)).toBe(`/attendance?employeeId=${REPORT}&date=2026-09-18`);
    // an older caller that does not say whether the reader holds attendance.view keeps following the link
    expect(resolveNotificationRoute(notices[0]!, { employeeId: SELF, approver: true, hasReports: true })).toBe(notices[0]!.link);
    // the register itself, or a register link without an employee, is not rerouted
    expect(resolveNotificationRoute({ type: 'attendance.sync_done', link: '/attendance?date=2026-09-20', data: {} }, MANAGER)).toBe('/attendance?date=2026-09-20');
  });
});

describe('review 5-P2-5 — only same-origin links are followed', () => {
  it.each([
    ['/\\evil.com'], ['/\\/evil.com'], ['/\t/evil.com'], ['/\n/evil.com'], ['/\r//evil.com'], ['/x\\y'], ['/\u0000/evil.com'],
    ['//evil.com'], ['https://evil.com'], ['javascript:alert(1)'], ['JavaScript:alert(1)'], [' /x'], ['\t//evil.com'], [''],
  ])('5-P2-5 refuses %j', (link) => {
    expect(safeLink(link)).toBeNull();
    expect(resolveNotificationRoute({ type: 'device.offline', link, data: {} }, APPROVER)).toBeNull();
  });

  it('5-P2-5 keeps in-app paths, query and fragment included — encoded characters stay a same-origin path', () => {
    for (const link of ['/devices/d1', '/approvals?request=req-1', '/my/attendance?date=2026-09-20#day', '/%2F%2Fevil.com', '/%5Cevil.com', '/%09/evil.com']) expect(safeLink(link)).toBe(link);
    expect(safeLink(null)).toBeNull();
    expect(safeLink(undefined)).toBeNull();
  });

  it('5-P2-5 every path the WHATWG parser keeps on our origin is followed, and nothing else', () => {
    const origin = 'https://time.flowza.ai';
    for (const link of ['/\\evil.com', '/\\/evil.com', '/\t/evil.com']) expect(new URL(link, `${origin}/notifications`).origin).not.toBe(origin);
  });
});
