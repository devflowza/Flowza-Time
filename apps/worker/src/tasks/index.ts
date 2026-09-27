import type { ScheduledTask } from '../scheduler.js';
import { maintenanceTasks } from './maintenance.js';
import { attendanceTasks } from '../handlers/attendance/tasks.js';
import { syncTasks } from './sync.js';
import { statementTasks } from '../handlers/statements/index.js';

/** Scheduler tasks (enqueue-only). Sync/attendance tasks are added by their modules. */
export function scheduledTasks(): ScheduledTask[] {
  return [...maintenanceTasks, ...attendanceTasks, ...syncTasks, ...statementTasks];
}
