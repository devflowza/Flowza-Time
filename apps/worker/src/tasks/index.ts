import type { ScheduledTask } from '../scheduler.js';
import { maintenanceTasks } from './maintenance.js';

/** Scheduler tasks (enqueue-only). Sync/attendance tasks are added by their modules. */
export function scheduledTasks(): ScheduledTask[] {
  return [...maintenanceTasks];
}
