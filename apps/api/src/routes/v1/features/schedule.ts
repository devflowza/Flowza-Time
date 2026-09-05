import type { Hono } from 'hono';
import { attendanceRuleSetInputSchema, holidayCalendarInputSchema, holidayInputSchema, leaveRecordInputSchema, leaveTypeInputSchema, shiftAssignmentInputSchema, shiftInputSchema, shiftPatternInputSchema } from '@flowza/contracts';
import { z } from 'zod';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { created, noContent, ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as s from '../../../services/features/schedule.service.js';
import { holidayListQuerySchema, leaveRecordListQuerySchema, ruleSetListQuerySchema, shiftAssignmentListQuerySchema, shiftAssignmentUpdateSchema, shiftListQuerySchema, shiftResolveQuerySchema, updateLeaveRecordSchema } from './dto.js';

// Zod v4: `.partial()` is not available on refined schemas, so the update shapes are declared from the inner objects.
const shiftUpdateSchema = z.object({ ...shiftInputSchema.shape }).partial();
const holidayUpdateSchema = holidayInputSchema.partial();
const ruleSetUpdateSchema = attendanceRuleSetInputSchema.partial();
const leaveTypeUpdateSchema = leaveTypeInputSchema.partial().extend({ status: z.enum(['active', 'inactive', 'archived']).optional() });

export function registerScheduleRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  // shifts
  v1.get('/orgs/:orgId/shifts', async (c) => { const q = query(c, shiftListQuerySchema); const r = await s.listShifts(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/shifts/resolve', async (c) => { const q = query(c, shiftResolveQuerySchema); return ok(c, await s.resolveEmployeeShift(deps, actorOf(c, deps), param(c, 'orgId'), q.employeeId, q.date)); });
  v1.post('/orgs/:orgId/shifts', async (c) => created(c, await s.createShift(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, shiftInputSchema))));
  v1.get('/orgs/:orgId/shifts/:id', async (c) => ok(c, await s.getShift(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/shifts/:id', async (c) => ok(c, await s.updateShift(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, shiftUpdateSchema))));
  v1.delete('/orgs/:orgId/shifts/:id', async (c) => { await s.deleteShift(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
  // patterns
  v1.get('/orgs/:orgId/shift-patterns', async (c) => ok(c, await s.listPatterns(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/shift-patterns', async (c) => created(c, await s.createPattern(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, shiftPatternInputSchema))));
  v1.patch('/orgs/:orgId/shift-patterns/:id', async (c) => ok(c, await s.updatePattern(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, shiftPatternInputSchema.partial()))));
  v1.delete('/orgs/:orgId/shift-patterns/:id', async (c) => { await s.deletePattern(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
  // assignments
  v1.get('/orgs/:orgId/shift-assignments', async (c) => { const q = query(c, shiftAssignmentListQuerySchema); const r = await s.listAssignments(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/shift-assignments', async (c) => created(c, await s.createAssignment(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, shiftAssignmentInputSchema))));
  v1.patch('/orgs/:orgId/shift-assignments/:id', async (c) => ok(c, await s.updateAssignment(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, shiftAssignmentUpdateSchema))));
  v1.delete('/orgs/:orgId/shift-assignments/:id', async (c) => ok(c, await s.deleteAssignment(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  // holidays
  v1.get('/orgs/:orgId/holiday-calendars', async (c) => ok(c, await s.listCalendars(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/holiday-calendars', async (c) => created(c, await s.createCalendar(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, holidayCalendarInputSchema))));
  v1.patch('/orgs/:orgId/holiday-calendars/:id', async (c) => ok(c, await s.updateCalendar(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, holidayCalendarInputSchema.partial()))));
  v1.delete('/orgs/:orgId/holiday-calendars/:id', async (c) => { await s.deleteCalendar(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
  v1.get('/orgs/:orgId/holidays', async (c) => ok(c, await s.listHolidays(deps, actorOf(c, deps), param(c, 'orgId'), query(c, holidayListQuerySchema))));
  v1.post('/orgs/:orgId/holidays', async (c) => created(c, await s.createHoliday(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, holidayInputSchema))));
  v1.patch('/orgs/:orgId/holidays/:id', async (c) => ok(c, await s.updateHoliday(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, holidayUpdateSchema))));
  v1.delete('/orgs/:orgId/holidays/:id', async (c) => { await s.deleteHoliday(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
  // leave
  v1.get('/orgs/:orgId/leave-types', async (c) => ok(c, await s.listLeaveTypes(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/leave-types', async (c) => created(c, await s.createLeaveType(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, leaveTypeInputSchema))));
  v1.patch('/orgs/:orgId/leave-types/:id', async (c) => ok(c, await s.updateLeaveType(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, leaveTypeUpdateSchema))));
  v1.delete('/orgs/:orgId/leave-types/:id', async (c) => { await s.deleteLeaveType(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
  v1.get('/orgs/:orgId/leave-records', async (c) => { const q = query(c, leaveRecordListQuerySchema); const r = await s.listLeaveRecords(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/leave-records', async (c) => created(c, await s.createLeaveRecord(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, leaveRecordInputSchema))));
  v1.patch('/orgs/:orgId/leave-records/:id', async (c) => ok(c, await s.updateLeaveRecord(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, updateLeaveRecordSchema))));
  v1.delete('/orgs/:orgId/leave-records/:id', async (c) => ok(c, await s.deleteLeaveRecord(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  // rule sets
  v1.get('/orgs/:orgId/attendance-rule-sets', async (c) => ok(c, await s.listRuleSets(deps, actorOf(c, deps), param(c, 'orgId'), query(c, ruleSetListQuerySchema))));
  v1.post('/orgs/:orgId/attendance-rule-sets', async (c) => created(c, await s.createRuleSet(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, attendanceRuleSetInputSchema))));
  v1.patch('/orgs/:orgId/attendance-rule-sets/:id', async (c) => ok(c, await s.updateRuleSet(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, ruleSetUpdateSchema))));
  v1.delete('/orgs/:orgId/attendance-rule-sets/:id', async (c) => ok(c, await s.deleteRuleSet(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
}
