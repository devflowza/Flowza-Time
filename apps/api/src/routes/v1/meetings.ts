import type { Hono } from 'hono';
import { accessLogQuerySchema, meetingInputSchema, meetingRoomInputSchema, meetingRoomUpdateSchema, meetingsQuerySchema, myMeetingsQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { created, ok, paginated } from '../../lib/http.js';
import { body, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as meetings from '../../services/meetings/meetings.service.js';

/**
 * Meeting rooms & access (Enterprise module meeting_rooms — the module gate closes these paths when it is off; docs/time-away.md
 * §4): rooms (meeting.view / meeting.rooms), meetings with their attendance (meeting.view / meeting.manage), the room access log
 * (meeting.rooms) and the caller's own invitations (`/me/meetings`).
 */
export function registerMeetingRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/orgs/:orgId/meeting-rooms', async (c) => ok(c, await meetings.listRooms(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/meeting-rooms', async (c) => created(c, await meetings.createRoom(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, meetingRoomInputSchema))));
  v1.patch('/orgs/:orgId/meeting-rooms/:id', async (c) => ok(c, await meetings.updateRoom(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, meetingRoomUpdateSchema))));
  v1.get('/orgs/:orgId/meetings', async (c) => ok(c, await meetings.listMeetings(deps, actorOf(c, deps), param(c, 'orgId'), query(c, meetingsQuerySchema))));
  v1.post('/orgs/:orgId/meetings', async (c) => created(c, await meetings.createMeeting(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, meetingInputSchema))));
  v1.get('/orgs/:orgId/meetings/:id', async (c) => ok(c, await meetings.getMeeting(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.post('/orgs/:orgId/meetings/:id/cancel', async (c) => ok(c, await meetings.cancelMeeting(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.get('/orgs/:orgId/access-events', async (c) => { const q = query(c, accessLogQuerySchema); const r = await meetings.listAccessEvents(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/me/meetings', async (c) => ok(c, await meetings.listMyMeetings(deps, actorOf(c, deps), param(c, 'orgId'), query(c, myMeetingsQuerySchema))));
}
