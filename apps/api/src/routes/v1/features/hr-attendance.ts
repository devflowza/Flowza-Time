import type { Hono } from 'hono';
import {
  attendanceCalendarQuerySchema, attendancePreviewInputSchema, attendanceRecordEditSchema, attendanceSummaryExportQuerySchema, attendanceSummaryQuerySchema,
  attendanceTimelineQuerySchema, bulkAttendanceStatusSchema, manualStatusesQuerySchema, unmatchedAssignSchema, unmatchedIgnoreSchema, unmatchedPunchesQuerySchema,
  unmatchedRestoreSchema,
} from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { created, ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as hr from '../../../services/attendance/hr-workspace.service.js';

/**
 * HR attendance workspace (HR portal Prompt 6a): record preview / edit, bulk status, the Auto/Manual source, calendar, monthly
 * summary (+ CSV), punch timeline and the unmatched-punch triage. Every path is new; nothing here changes an existing route.
 */
export function registerHrAttendanceRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.post('/orgs/:orgId/attendance/preview', async (c) => ok(c, await hr.previewRecord(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, attendancePreviewInputSchema))));
  v1.post('/orgs/:orgId/attendance/record-edits', idem, async (c) => created(c, await hr.editRecord(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, attendanceRecordEditSchema))));
  v1.post('/orgs/:orgId/attendance/bulk-status', idem, async (c) => ok(c, await hr.bulkStatus(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, bulkAttendanceStatusSchema))));
  v1.get('/orgs/:orgId/attendance/manual-statuses', async (c) => ok(c, await hr.listManualStatuses(deps, actorOf(c, deps), param(c, 'orgId'), query(c, manualStatusesQuerySchema))));
  v1.get('/orgs/:orgId/attendance/calendar', async (c) => {
    const q = query(c, attendanceCalendarQuerySchema);
    const r = await hr.calendar(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return c.json({ data: r.data, meta: { page: q.page, pageSize: q.pageSize, total: r.total, totalPages: Math.max(1, Math.ceil(r.total / q.pageSize)), ...r.meta } });
  });
  v1.get('/orgs/:orgId/attendance/summary', async (c) => {
    const q = query(c, attendanceSummaryQuerySchema);
    const r = await hr.summary(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return c.json({ data: r.data, meta: { page: q.page, pageSize: q.pageSize, total: r.total, totalPages: Math.max(1, Math.ceil(r.total / q.pageSize)), ...r.meta } });
  });
  v1.get('/orgs/:orgId/attendance/summary/export', async (c) => ok(c, await hr.exportSummary(deps, actorOf(c, deps), param(c, 'orgId'), query(c, attendanceSummaryExportQuerySchema))));
  v1.get('/orgs/:orgId/attendance/timeline', async (c) => ok(c, await hr.timeline(deps, actorOf(c, deps), param(c, 'orgId'), query(c, attendanceTimelineQuerySchema))));
  v1.get('/orgs/:orgId/attendance/unmatched', async (c) => {
    const q = query(c, unmatchedPunchesQuerySchema);
    const r = await hr.listUnmatched(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return paginated(c, r.data, q.page, q.pageSize, r.total);
  });
  v1.post('/orgs/:orgId/attendance/unmatched/assign', async (c) => ok(c, await hr.assignUnmatched(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, unmatchedAssignSchema))));
  v1.post('/orgs/:orgId/attendance/unmatched/ignore', async (c) => ok(c, await hr.ignoreUnmatched(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, unmatchedIgnoreSchema))));
  v1.post('/orgs/:orgId/attendance/unmatched/restore', async (c) => ok(c, await hr.restoreUnmatched(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, unmatchedRestoreSchema))));
}
