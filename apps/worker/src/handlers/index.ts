import { HandlerRegistry } from './types.js';
import { registerMaintenanceHandlers } from './maintenance/index.js';
import { registerNotificationHandlers } from './notifications/outbox.js';
import { registerAttendanceHandlers } from './attendance/index.js';
import { registerSyncHandlers } from './sync/index.js';
import { registerReportHandlers } from './reports/index.js';
import { registerStatementHandlers } from './statements/index.js';

/**
 * Registers every job handler. Handler modules live in ./<area>/ and export `register<Area>Handlers(registry)`:
 *   maintenance (ENSURE_PARTITIONS, REAP_STALE, PRUNE_QUEUE_ARCHIVE, RETENTION, USAGE_METERING)
 *   notifications (RELAY_OUTBOX, DELIVER_NOTIFICATIONS)
 *   sync (PULL_ATTENDANCE, PUSH_EMPLOYEE(S), PULL_EMPLOYEES, DEVICE_HEALTH_CHECK, RECONCILIATION, TEST_CONNECTION, DELETE_EMPLOYEE, WEBHOOK_EVENT)
 *   attendance (NORMALIZE_RAW, RECOMPUTE_DAILY, RECALCULATE_RANGE, BUILD_PERIOD_SUMMARY)
 *   reports (GENERATE_REPORT, EXPORT_EMPLOYEES) — see ./reports and docs/reports.md
 *   statements (ISSUE_MONTHLY_STATEMENTS, SEND_STATEMENT_EMAIL) — see ./statements and docs/statements.md
 */
export function buildHandlerRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerMaintenanceHandlers(registry);
  registerNotificationHandlers(registry);
  registerAttendanceHandlers(registry);
  registerSyncHandlers(registry);
  registerReportHandlers(registry);
  registerStatementHandlers(registry);
  return registry;
}
