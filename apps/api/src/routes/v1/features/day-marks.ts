import type { Hono } from 'hono';
import { createDayMarkSchema, dayMarksQuerySchema, revokeDayMarkSchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { created, ok } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as marks from '../../../services/attendance/day-marks.js';

/**
 * Attendance day marks (HR portal Prompt 3): the reviewed verdicts on employee-days.
 *   GET  /orgs/:orgId/attendance/day-marks?employeeId&from&to[&includeRevoked&kind]   attendance.view | own | team
 *   POST /orgs/:orgId/attendance/day-marks                                           attendance.approve (EXCUSED / UNEXCUSED / PAY_EFFECT + reason)
 *   POST /orgs/:orgId/attendance/day-marks/:id/revoke                                attendance.approve
 */
export function registerDayMarkRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.get('/orgs/:orgId/attendance/day-marks', async (c) => ok(c, await marks.listDayMarks(deps, actorOf(c, deps), param(c, 'orgId'), query(c, dayMarksQuerySchema))));
  v1.post('/orgs/:orgId/attendance/day-marks', idem, async (c) => created(c, await marks.createDayMark(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, createDayMarkSchema))));
  v1.post('/orgs/:orgId/attendance/day-marks/:id/revoke', async (c) => ok(c, await marks.revokeDayMark(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, revokeDayMarkSchema)).reason)));
}
