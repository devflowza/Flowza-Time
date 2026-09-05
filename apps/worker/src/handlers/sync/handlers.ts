import type { HandlerRegistry } from '../types.js';
import { pullAttendance } from './attendance.js';
import { deviceHealthCheck, testConnection, webhookEvent } from './device.js';
import { deleteEmployee, pullEmployees, pushEmployee, pushEmployees, reconciliation } from './employees.js';

export { pullAttendance, deviceHealthCheck, testConnection, webhookEvent, deleteEmployee, pullEmployees, pushEmployee, pushEmployees, reconciliation };

/**
 * Sync job handlers (docs/sync-engine.md). Every per-item handler runs through `runItem()` (handlers/sync/items.ts): one
 * `sync_job_items` row per queue job, `sync_attempts` per run, atomic parent counters and exactly one sync.completed/failed
 * event per job. Timeouts are generous for pulls (many pages) and tight for health checks.
 */
export function registerSyncHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'PULL_ATTENDANCE', handler: pullAttendance, timeoutMs: 15 * 60_000 });
  registry.register({ jobType: 'PUSH_EMPLOYEE', handler: pushEmployee, timeoutMs: 5 * 60_000 });
  registry.register({ jobType: 'PUSH_EMPLOYEES', handler: pushEmployees, timeoutMs: 5 * 60_000 });
  registry.register({ jobType: 'DELETE_EMPLOYEE', handler: deleteEmployee, timeoutMs: 5 * 60_000 });
  registry.register({ jobType: 'PULL_EMPLOYEES', handler: pullEmployees, timeoutMs: 10 * 60_000 });
  registry.register({ jobType: 'DEVICE_HEALTH_CHECK', handler: deviceHealthCheck, timeoutMs: 2 * 60_000 });
  registry.register({ jobType: 'TEST_CONNECTION', handler: testConnection, timeoutMs: 2 * 60_000 });
  registry.register({ jobType: 'RECONCILIATION', handler: reconciliation, timeoutMs: 5 * 60_000 });
  registry.register({ jobType: 'WEBHOOK_EVENT', handler: webhookEvent, timeoutMs: 2 * 60_000 });
}
