import type { ScheduledTask } from '../scheduler.js';
import { maintenanceTasks } from './maintenance.js';
import { attendanceTasks } from '../handlers/attendance/tasks.js';
import { syncTasks } from './sync.js';
import { financeTasks } from './finance.js';

/** Scheduler tasks (enqueue-only). Sync/attendance/integration tasks are added by their modules. */
export function scheduledTasks(): ScheduledTask[] {
  return [...maintenanceTasks, ...attendanceTasks, ...syncTasks, ...financeTasks];
}
