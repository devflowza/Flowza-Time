import { useActiveMembership, useCan } from '@/features/me/use-me';
import { resolveNotificationRoute, type NotificationViewer } from './notification-route';
import type { NotificationDto } from './use-notifications';

/** The reader's routing facts from /me (keys, team, employee link) bound to the pure resolver. */
export function useNotificationRoute(): (n: Pick<NotificationDto, 'type' | 'data' | 'link'>) => string | null {
  const m = useActiveMembership();
  const can = useCan();
  const viewer: NotificationViewer = { employeeId: m?.employeeId ?? null, approver: can('attendance.approve') || can('leave.approve'), hasReports: m?.isManager ?? false, attendanceView: can('attendance.view') };
  return (n) => resolveNotificationRoute(n, viewer);
}
