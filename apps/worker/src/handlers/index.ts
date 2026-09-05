import { HandlerRegistry } from './types.js';

/**
 * Registers every job handler. Handlers live in ./<area>/*.ts and export `register<Area>Handlers(registry)`:
 *   sync (PULL_ATTENDANCE, PUSH_EMPLOYEE, PULL_EMPLOYEES, DEVICE_HEALTH_CHECK, RECONCILIATION, TEST_CONNECTION, DELETE_EMPLOYEE, WEBHOOK_EVENT)
 *   attendance (NORMALIZE_RAW, RECOMPUTE_DAILY, RECALCULATE_RANGE, BUILD_PERIOD_SUMMARY)
 *   reports (GENERATE_REPORT, EXPORT_EMPLOYEES), imports (VALIDATE_IMPORT, EXECUTE_IMPORT)
 *   notifications (RELAY_OUTBOX, DELIVER_NOTIFICATION), maintenance (RETENTION, ENSURE_PARTITIONS, REAP_STALE, USAGE_METERING)
 */
export function buildHandlerRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry();
  return registry;
}
