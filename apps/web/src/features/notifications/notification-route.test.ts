import { describe, expect, it } from 'vitest';
import { resolveNotificationRoute, selfRouteFor, type NotificationViewer } from './notification-route';

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
