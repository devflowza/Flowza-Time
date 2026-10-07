import { HandlerRegistry } from './types.js';
import { registerMaintenanceHandlers } from './maintenance/index.js';
import { registerNotificationHandlers } from './notifications/outbox.js';
import { registerAttendanceHandlers } from './attendance/index.js';
import { registerSyncHandlers } from './sync/index.js';
import { registerReportHandlers } from './reports/index.js';
import { registerApprovalHandlers } from './approvals/index.js';
import { registerLeaveHandlers } from './leave/index.js';
import { registerMemberHandlers } from './members/index.js';
import { registerSchedulingHandlers } from './scheduling/index.js';

/**
 * Registers every job handler. Handler modules live in ./<area>/ and export `register<Area>Handlers(registry)`:
 *   maintenance (ENSURE_PARTITIONS, REAP_STALE, PRUNE_QUEUE_ARCHIVE, RETENTION, USAGE_METERING)
 *   notifications (RELAY_OUTBOX, DELIVER_NOTIFICATIONS, MISSING_PUNCH_REMINDERS, NOTIFICATION_RETENTION)
 *   sync (PULL_ATTENDANCE, PUSH_EMPLOYEE(S), PULL_EMPLOYEES, DEVICE_HEALTH_CHECK, RECONCILIATION, TEST_CONNECTION, DELETE_EMPLOYEE, WEBHOOK_EVENT)
 *   attendance (NORMALIZE_RAW, RECOMPUTE_DAILY, RECALCULATE_RANGE, BUILD_PERIOD_SUMMARY)
 *   reports (GENERATE_REPORT, EXPORT_EMPLOYEES) — see ./reports and docs/reports.md
 *   approvals (APPROVAL_REMINDERS: escalation, 24-hour reminders, the daily digest)
 *   leave (LEAVE_YEAR_CLOSE: carry-forward into next year's allocations; LEAVE_COMP_OFF_EXPIRY: the daily comp-off expiry)
 *   members (SEND_INVITATION_EMAIL: e-mails an invitation with a token minted at send time, hash only)
 *   scheduling (BRANCH_DEPLOYMENT_CLEANUP: takes an employee off a host branch's terminals once a temporary deployment is over)
 */
export function buildHandlerRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerMaintenanceHandlers(registry);
  registerNotificationHandlers(registry);
  registerAttendanceHandlers(registry);
  registerSyncHandlers(registry);
  registerReportHandlers(registry);
  registerApprovalHandlers(registry);
  registerLeaveHandlers(registry);
  registerMemberHandlers(registry);
  registerSchedulingHandlers(registry);
  return registry;
}
