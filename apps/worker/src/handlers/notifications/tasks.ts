import type { ScheduledTask } from '../../scheduler.js';
import { MISSING_PUNCH_REMINDER_JOB_TYPE } from './missing-punch.js';
import { NOTIFICATION_RETENTION_JOB_TYPE } from './retention.js';

/**
 * Notification scheduler ticks (enqueue-only, HR portal Prompt 8):
 *  - attendance.missing-punch-reminder: every 15 minutes, ONE deduped MISSING_PUNCH_REMINDERS job that walks the active
 *    organisations (each in its own system context) — one small indexed query per organisation instead of a queue row per
 *    organisation per quarter hour. Each organisation's local "today" is resolved inside the job.
 *  - notifications.retention: daily, one deduped NOTIFICATION_RETENTION job (platform context, batched deletes).
 */
export const notificationTasks: ScheduledTask[] = [
  {
    name: 'attendance.missing-punch-reminder',
    everyMs: 15 * 60_000,
    run: (d) => d.queue.enqueue({ queue: 'notifications', jobType: MISSING_PUNCH_REMINDER_JOB_TYPE, organizationId: null, payload: {}, priority: 4, dedupeKey: 'missing-punch-reminders', lockTimeoutSeconds: 600, maxAttempts: 1 }),
  },
  {
    name: 'notifications.retention',
    everyMs: 24 * 3_600_000,
    run: (d) => d.queue.enqueue({ queue: 'maintenance', jobType: NOTIFICATION_RETENTION_JOB_TYPE, organizationId: null, payload: {}, priority: 1, dedupeKey: 'notification-retention', lockTimeoutSeconds: 1_800, maxAttempts: 2 }),
  },
];
