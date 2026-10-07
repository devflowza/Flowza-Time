import type { ScheduledTask } from '../scheduler.js';
import { maintenanceTasks } from './maintenance.js';
import { attendanceTasks } from '../handlers/attendance/tasks.js';
import { syncTasks } from './sync.js';
import { approvalTasks } from '../handlers/approvals/index.js';
import { financeTasks } from './finance.js';
import { reportTasks } from './reports.js';
import { leaveTasks } from '../handlers/leave/index.js';
import { notificationTasks } from '../handlers/notifications/tasks.js';
import { schedulingTasks } from '../handlers/scheduling/index.js';

/** Scheduler tasks (enqueue-only). Sync/attendance/integration tasks are added by their modules. */
export function scheduledTasks(): ScheduledTask[] {
  return [...maintenanceTasks, ...attendanceTasks, ...syncTasks, ...approvalTasks, ...financeTasks, ...reportTasks, ...leaveTasks, ...notificationTasks, ...schedulingTasks];
}
