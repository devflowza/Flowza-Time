import type { Hono } from 'hono';
import {
  attendanceGrantsInputSchema, attendanceNotesQuerySchema, geofenceAssignmentsInputSchema, geofenceEvaluateSchema, geofenceInputSchema, geofenceListQuerySchema, geofenceUpdateSchema, noteReviewSchema,
  portalCancelSchema, selfieListQuerySchema, selfieReviewSchema, SELFIE_MAX_BYTES, selfNoteInputSchema, selfNotesQuerySchema, selfNoteUpdateSchema, selfPunchPreviewSchema, selfPunchSchema,
  selfPunchStatusQuerySchema, selfRegularisationInputSchema, selfRegularisationsQuerySchema, selfSelfieFormSchema, selfSelfieSchema, selfShiftSwapInputSchema, selfShiftSwapsQuerySchema,
  selfStatsQuerySchema, swapCandidatesQuerySchema,
} from '@flowza/contracts';
import { AppError, errors } from '@flowza/shared';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { created, noContent, ok, paginated } from '../../lib/http.js';
import { body, optionalBody, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as geofences from '../../services/portal/geofences.service.js';
import * as notes from '../../services/portal/notes.service.js';
import * as punch from '../../services/portal/punch.service.js';
import * as regularisations from '../../services/portal/regularisations.service.js';
import * as shift from '../../services/portal/shift.service.js';
import * as stats from '../../services/portal/stats.service.js';

/**
 * Employee-portal attendance (HR portal Prompt 4). `/orgs/:orgId/me/…` acts on the caller's own employee record (never an id
 * from the client): check-in / check-out with geofence verdicts, the selfie check-in, reasons for days, regularisations,
 * the shift tab + swaps, own statistics. The manager / HR side: the notes review list and decisions, selfie review, the
 * per-employee attendance grants and the geofences (+ assignments, dry-run evaluation).
 */
export function registerPortalAttendanceRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  // ----- check-in / check-out
  v1.get('/orgs/:orgId/me/punch/status', async (c) => ok(c, await punch.getPunchStatus(deps, actorOf(c, deps), param(c, 'orgId'), query(c, selfPunchStatusQuerySchema))));
  v1.post('/orgs/:orgId/me/punch/preview', async (c) => ok(c, await punch.previewPunch(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, selfPunchPreviewSchema))));
  v1.post('/orgs/:orgId/me/punch', async (c) => {
    const result = await punch.punch(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, selfPunchSchema));
    return result.replayed ? ok(c, result) : created(c, result);
  });

  // ----- selfie check-in: JSON (base64) or multipart (`photo` file + fields)
  v1.post('/orgs/:orgId/me/selfie-checkin', async (c) => {
    const actor = actorOf(c, deps); const orgId = param(c, 'orgId');
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (type.startsWith('multipart/form-data')) {
      const form = await c.req.parseBody().catch(() => { throw errors.validation('The form could not be read.'); });
      const photo = form['photo'];
      if (!(photo instanceof File)) throw errors.validation('Attach the photo as the "photo" field.', { issues: [{ path: 'photo', message: 'Required' }] });
      if (photo.size > SELFIE_MAX_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'The photo is larger than 2 MB.', { details: { maxBytes: SELFIE_MAX_BYTES } });
      const fields = selfSelfieFormSchema.parse({ direction: form['direction'], lat: form['lat'] || undefined, lng: form['lng'] || undefined, accuracy: form['accuracy'] || undefined, isMock: form['isMock'] || undefined });
      const image = punch.parseSelfieImage({ bytes: new Uint8Array(await photo.arrayBuffer()) });
      return created(c, await punch.submitSelfie(deps, actor, orgId, { ...fields, image }));
    }
    const input = await body(c, selfSelfieSchema);
    const image = punch.parseSelfieImage({ base64: input.imageBase64 });
    return created(c, await punch.submitSelfie(deps, actor, orgId, { direction: input.direction, lat: input.lat, lng: input.lng, accuracy: input.accuracy, isMock: input.isMock, image }));
  });
  v1.get('/orgs/:orgId/me/selfie-checkins', async (c) => ok(c, await punch.listMySelfies(deps, actorOf(c, deps), param(c, 'orgId'))));
  // the photo is only ever reached through a 60-second signed URL issued here (own check-ins) or on the reviewer route below
  v1.get('/orgs/:orgId/me/selfie-checkins/:id/photo', async (c) => ok(c, await punch.mySelfiePhotoUrl(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));

  // ----- reasons (attendance notes)
  v1.get('/orgs/:orgId/me/attendance/notes', async (c) => ok(c, await notes.listMyNotes(deps, actorOf(c, deps), param(c, 'orgId'), query(c, selfNotesQuerySchema))));
  v1.post('/orgs/:orgId/me/attendance/notes', async (c) => created(c, await notes.submitNote(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, selfNoteInputSchema))));
  v1.patch('/orgs/:orgId/me/attendance/notes/:id', async (c) => ok(c, await notes.updateMyNote(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, selfNoteUpdateSchema))));

  // ----- regularisations
  v1.get('/orgs/:orgId/me/regularisations', async (c) => ok(c, await regularisations.listMyRegularisations(deps, actorOf(c, deps), param(c, 'orgId'), query(c, selfRegularisationsQuerySchema))));
  v1.post('/orgs/:orgId/me/regularisations', async (c) => created(c, await regularisations.submitRegularisation(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, selfRegularisationInputSchema))));
  v1.post('/orgs/:orgId/me/regularisations/:id/cancel', async (c) => ok(c, await regularisations.cancelMyRegularisation(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await optionalBody(c, portalCancelSchema)).reason)));

  // ----- shift tab + swaps
  v1.get('/orgs/:orgId/me/shift', async (c) => ok(c, await shift.getMyShift(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.get('/orgs/:orgId/me/shift-swaps/candidates', async (c) => ok(c, await shift.listSwapCandidates(deps, actorOf(c, deps), param(c, 'orgId'), query(c, swapCandidatesQuerySchema))));
  v1.get('/orgs/:orgId/me/shift-swaps', async (c) => ok(c, await shift.listMySwaps(deps, actorOf(c, deps), param(c, 'orgId'), query(c, selfShiftSwapsQuerySchema))));
  v1.post('/orgs/:orgId/me/shift-swaps', async (c) => created(c, await shift.requestSwap(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, selfShiftSwapInputSchema))));
  v1.post('/orgs/:orgId/me/shift-swaps/:id/cancel', async (c) => ok(c, await shift.cancelMySwap(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await optionalBody(c, portalCancelSchema)).reason)));

  // ----- own statistics
  v1.get('/orgs/:orgId/me/stats', async (c) => ok(c, await stats.getMyStats(deps, actorOf(c, deps), param(c, 'orgId'), query(c, selfStatsQuerySchema))));

  // ----- manager / HR: reasons review
  v1.get('/orgs/:orgId/attendance/notes', async (c) => { const q = query(c, attendanceNotesQuerySchema); const r = await notes.listNotesForReview(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/attendance/notes/:id/review', async (c) => ok(c, await notes.reviewNote(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, noteReviewSchema))));

  // ----- manager / HR: selfie check-ins
  v1.get('/orgs/:orgId/attendance/selfie-checkins', async (c) => { const q = query(c, selfieListQuerySchema); const r = await punch.listSelfies(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/attendance/selfie-checkins/:id/photo', async (c) => ok(c, await punch.selfiePhotoUrl(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.post('/orgs/:orgId/attendance/selfie-checkins/:id/review', async (c) => ok(c, await punch.reviewSelfie(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, selfieReviewSchema))));

  // ----- manager / HR: per-employee attendance grants
  v1.get('/orgs/:orgId/employees/:id/attendance-grants', async (c) => ok(c, await punch.getAttendanceGrants(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.put('/orgs/:orgId/employees/:id/attendance-grants', async (c) => ok(c, await punch.putAttendanceGrants(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, attendanceGrantsInputSchema))));

  // ----- HR: geofences
  v1.post('/orgs/:orgId/geofences/evaluate', async (c) => ok(c, await geofences.evaluateGeofenceForEmployee(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, geofenceEvaluateSchema))));
  v1.get('/orgs/:orgId/geofences', async (c) => ok(c, await geofences.listGeofences(deps, actorOf(c, deps), param(c, 'orgId'), query(c, geofenceListQuerySchema))));
  v1.post('/orgs/:orgId/geofences', async (c) => created(c, await geofences.createGeofence(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, geofenceInputSchema))));
  v1.get('/orgs/:orgId/geofences/:id', async (c) => ok(c, await geofences.getGeofence(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/geofences/:id', async (c) => ok(c, await geofences.updateGeofence(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, geofenceUpdateSchema))));
  v1.put('/orgs/:orgId/geofences/:id/assignments', async (c) => ok(c, await geofences.replaceGeofenceAssignments(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, geofenceAssignmentsInputSchema)).assignments)));
  v1.delete('/orgs/:orgId/geofences/:id', async (c) => { await geofences.deleteGeofence(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
}
