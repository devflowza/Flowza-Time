import { createHash, randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import {
  GEOFENCE_VERDICTS, SELFIE_MAX_BYTES, SELF_SERVICE_PROVIDER_KEY,
  type AttendanceFlag, type AttendanceGrantsDto, type AttendanceGrantsInput, type AttendanceSettings, type AttendanceStatus, type GeofenceVerdict,
  type SelfieCheckinDto, type SelfieReviewInput, type SelfiePhotoDto, type SelfPunchChannel, type SelfPunchDirection, type SelfPunchDto, type SelfPunchPreviewDto,
  type SelfPunchRefusal, type SelfPunchResultDto, type SelfPunchStatusDto, type SelfieCheckinStatus,
} from '@flowza/contracts';
import { ensureSelfServiceDevice, type Trx } from '@flowza/database';
import type { GeofenceEvaluation, GeofenceFence, MembershipGrant } from '@flowza/domain';
import { AppError, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requireBranchAccess, requireMembership } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { isoDateTime, isoDateTimeOrNull, jsonObject } from '../../lib/mappers.js';
import { pageOf, toCount } from '../../lib/pagination.js';
import { systemStep } from '../features/context.js';
import { enqueueNormalize, ingestRawTransactions } from '../features/ingest.js';
import {
  type EmployeeCtx, attendancePolicy, emitToUsers, inLocalWindow, isPeriodLocked, isWorking, lineManagerUserIds, loadEmployeeCtx, localInstant, lockEmployee, portalSelf, reviewerRole, userIdsOfEmployees,
} from './common.js';
import { evaluateForEmployee, fencesForEmployee, selfFences, toVerdictDto } from './geofences.service.js';

/**
 * Self-service check-in / check-out (HR portal Prompt 4) and the selfie check-in for employees with an attendance grant.
 *
 * A punch is recorded the way a terminal's is: ONE raw transaction (immutable, source SELF_SERVICE) on the organisation's
 * virtual self-service device (`ensureSelfServiceDevice`), with the standard dedupe hash, normalised by the worker into an
 * event and a daily record. The punch time is ALWAYS the server's clock (a queued offline punch keeps its queue time in
 * the payload for information only). The raw payload carries what the engine turns into flags: channel
 * (SELF_SERVICE_PUNCH), the geofence verdict (OUTSIDE_GEOFENCE), `outOfWindow` (OUT_OF_WINDOW), `isMock`.
 *
 * Before anything is written the organisation's policy (Settings → Attendance → self-service) is enforced: the channel
 * switch (web / mobile), the IP allow-list, locked periods, the check-in / check-out windows (accept, flag or reject), the
 * duplicate guard, the in/out sequence, the selfie-only grant and the geofence (evaluated server-side; the client's
 * preview is advice). A refused punch is NOT stored — it is audited (and a geofence refusal notifies the line manager).
 */

const SELFIE_BUCKET = 'employee-photos';
/** A punch older than this no longer decides whether the next one is a check-in or a check-out (a forgotten check-out). */
const SEQUENCE_WINDOW_MS = 20 * 3_600_000;
/** Idempotency keys are looked up this far back (bounded partition scan; the offline queue replays within days). */
const REPLAY_WINDOW_MS = 14 * 86_400_000;

// ----- policy helpers ------------------------------------------------------------------------------------------------------------

/** IPv4 / IPv6 address or CIDR allow-list (Node's BlockList, no extra dependency). Empty list = any address; unknown address = refused. */
export function ipAllowed(ip: string | null, list: readonly string[]): boolean {
  if (list.length === 0) return true;
  if (!ip) return false;
  const addr = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(addr);
  if (family === 0) return false;
  const block = new BlockList();
  for (const entry of list) {
    const [base, prefix] = entry.split('/');
    const fam = isIP(base ?? '');
    if (!base || fam === 0) continue;
    const type = fam === 6 ? 'ipv6' : 'ipv4';
    if (prefix !== undefined) block.addSubnet(base, Number(prefix), type); else block.addAddress(base, type);
  }
  return block.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

interface Grants { openAttendance: boolean; selfieRequired: boolean; grantedBy: string | null; grantedAt: Date | null }
async function loadGrants(trx: Trx, orgId: string, employeeId: string): Promise<Grants> {
  const row = await withSystemScope(trx, orgId, (t) => t.selectFrom('employeeAttendanceGrants').select(['openAttendance', 'selfieRequired', 'grantedBy', 'grantedAt']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).executeTakeFirst());
  return row ? { openAttendance: row.openAttendance, selfieRequired: row.selfieRequired, grantedBy: row.grantedBy, grantedAt: row.grantedAt } : { openAttendance: false, selfieRequired: false, grantedBy: null, grantedAt: null };
}

type RawPunchRow = { id: string; punchedAt: Date; direction: string; source: string; rawPayload: unknown; processingStatus: string; deviceName: string | null; providerKey: string };

async function recentRawPunches(trx: Trx, orgId: string, employeeId: string, since: Date): Promise<RawPunchRow[]> {
  return withSystemScope(trx, orgId, async (t) => (await t.selectFrom('attendanceRawTransactions as rt').leftJoin('devices as d', 'd.id', 'rt.deviceId')
    .select(['rt.id', 'rt.punchedAt', 'rt.direction', 'rt.source', 'rt.rawPayload', 'rt.processingStatus', 'd.name as deviceName', 'rt.providerKey'])
    .where('rt.organizationId', '=', orgId).where('rt.employeeId', '=', employeeId).where('rt.punchedAt', '>=', since)
    .orderBy('rt.punchedAt', 'desc').orderBy('rt.id', 'desc').limit(60).execute()).map((r) => ({ ...r, id: String(r.id) })) as RawPunchRow[]);
}

const isVerdict = (v: unknown): v is GeofenceVerdict => typeof v === 'string' && (GEOFENCE_VERDICTS as readonly string[]).includes(v);
function toPunchDto(r: RawPunchRow): SelfPunchDto {
  const p = jsonObject(r.rawPayload);
  const channel = p['channel'] === 'web' || p['channel'] === 'mobile' ? (p['channel'] as SelfPunchChannel) : null;
  return { id: r.id, punchedAt: isoDateTime(r.punchedAt), direction: r.direction, source: r.source, channel, verdict: isVerdict(p['verdict']) ? p['verdict'] : null, deviceName: r.deviceName, processingStatus: r.processingStatus };
}

interface PunchContext { emp: EmployeeCtx; settings: AttendanceSettings; grants: Grants; fences: GeofenceFence[] }
async function loadPunchContext(trx: Trx, orgId: string, employeeId: string): Promise<PunchContext> {
  const emp = await loadEmployeeCtx(trx, orgId, employeeId);
  const [settings, grants, fences] = await Promise.all([attendancePolicy(trx, orgId), loadGrants(trx, orgId, employeeId), fencesForEmployee(trx, orgId, emp)]);
  return { emp, settings, grants, fences };
}

/** Refusals that hold whatever the direction or the location (the check-in page's blockers). */
async function standingRefusals(trx: Trx, orgId: string, ctx: PunchContext, channel: SelfPunchChannel, ip: string | null, at: Date): Promise<SelfPunchRefusal[]> {
  const out: SelfPunchRefusal[] = [];
  const today = localInstant(at, ctx.emp.timezone).date;
  if (!isWorking(ctx.emp, today) || today < ctx.emp.joiningDate) out.push('NOT_ACTIVE');
  if (channel === 'web' && !ctx.settings.selfService.webCheckIn) out.push('WEB_CHECKIN_DISABLED');
  if (channel === 'mobile' && !ctx.settings.selfService.mobileCheckIn) out.push('MOBILE_CHECKIN_DISABLED');
  if (ctx.grants.selfieRequired) out.push('SELFIE_REQUIRED');
  if (!ipAllowed(ip, ctx.settings.selfService.ipAllowList)) out.push('IP_NOT_ALLOWED');
  if (await isPeriodLocked(trx, orgId, ctx.emp.branchId, today)) out.push('PERIOD_LOCKED');
  return out;
}

interface Assessment {
  evaluation: GeofenceEvaluation;
  /** The verdict as stored (an open-attendance grant turns an outside refusal into a flag). */
  verdict: GeofenceVerdict;
  /** The punch falls outside its check-in / check-out window (a fact, whatever the action). */
  outOfWindow: boolean;
  /** Stored with the OUT_OF_WINDOW flag (window action `flag`). */
  flagOutOfWindow: boolean;
  refusals: SelfPunchRefusal[];
  flagged: boolean;
  lastDirection: SelfPunchDirection | null;
  lastPunch: RawPunchRow | null;
}

async function assess(trx: Trx, orgId: string, ctx: PunchContext, input: { channel: SelfPunchChannel; direction: SelfPunchDirection; lat?: number | undefined; lng?: number | undefined; accuracy?: number | undefined; isMock?: boolean | undefined }, ip: string | null, at: Date, opts: { sequence: boolean }): Promise<Assessment> {
  const refusals = await standingRefusals(trx, orgId, ctx, input.channel, ip, at);
  const recent = await recentRawPunches(trx, orgId, ctx.emp.id, new Date(at.getTime() - SEQUENCE_WINDOW_MS));
  const last = recent[0] ?? null;
  const lastDirection: SelfPunchDirection | null = last && (last.direction === 'in' || last.direction === 'out') ? last.direction : null;
  if (opts.sequence && lastDirection === input.direction) refusals.push(input.direction === 'in' ? 'ALREADY_CHECKED_IN' : 'NOT_CHECKED_IN');
  const dupSeconds = ctx.settings.selfService.duplicatePunchSeconds;
  const lastSelf = recent.find((r) => r.source === 'SELF_SERVICE');
  if (dupSeconds > 0 && lastSelf && at.getTime() - lastSelf.punchedAt.getTime() < dupSeconds * 1000) refusals.push('DUPLICATE_PUNCH');
  const local = localInstant(at, ctx.emp.timezone);
  const window = input.direction === 'in' ? ctx.settings.selfService.checkInWindow : ctx.settings.selfService.checkOutWindow;
  const outOfWindow = !inLocalWindow(window, local.minuteOfDay);
  const action = ctx.settings.selfService.outOfWindowAction;
  if (outOfWindow && action === 'reject') refusals.push('OUT_OF_WINDOW');
  const evaluation = evaluateForEmployee(ctx.emp, ctx.fences, input, ctx.settings.selfService.requireGeofence, at);
  let verdict: GeofenceVerdict = evaluation.verdict;
  if (verdict === 'denied_mock') refusals.push('MOCK_LOCATION');
  else if (verdict === 'denied_outside') {
    // open attendance (field staff): the punch is taken anywhere, but the manager sees it was outside the zone
    if (ctx.grants.openAttendance) verdict = 'flagged'; else refusals.push('OUTSIDE_GEOFENCE');
  }
  const flagOutOfWindow = outOfWindow && action === 'flag';
  return { evaluation, verdict, outOfWindow, flagOutOfWindow, refusals, flagged: verdict === 'flagged' || flagOutOfWindow, lastDirection, lastPunch: last };
}

const REFUSAL_TEXT: Record<SelfPunchRefusal, string> = {
  WEB_CHECKIN_DISABLED: 'Web check-in is turned off for this organisation.',
  MOBILE_CHECKIN_DISABLED: 'Mobile check-in is turned off for this organisation.',
  IP_NOT_ALLOWED: 'Check-in is not allowed from this network.',
  OUT_OF_WINDOW: 'This is outside the hours in which check-in / check-out is accepted.',
  OUTSIDE_GEOFENCE: 'You are outside your work location.',
  MOCK_LOCATION: 'A simulated location was reported; check in with your real location.',
  SELFIE_REQUIRED: 'Use the selfie check-in: your manager requires a photo with each check-in.',
  DUPLICATE_PUNCH: 'You just punched; wait a moment before punching again.',
  ALREADY_CHECKED_IN: 'You are already checked in.',
  NOT_CHECKED_IN: 'You have already checked out.',
  PERIOD_LOCKED: 'The attendance period is locked.',
  NOT_ACTIVE: 'Your employment is not active.',
};
/** The HTTP error of a refused punch: stable code + `details.reason` (and every other refusal that applied). */
export function refusalError(refusals: readonly SelfPunchRefusal[], extra: Record<string, unknown> = {}): AppError {
  const reason = refusals[0]!;
  const details = { reason, refusals: [...refusals], ...extra };
  const message = REFUSAL_TEXT[reason];
  if (reason === 'DUPLICATE_PUNCH') return new AppError('CONFLICT', message, { details });
  if (reason === 'ALREADY_CHECKED_IN' || reason === 'NOT_CHECKED_IN') return new AppError('INVALID_STATE', message, { details });
  if (reason === 'PERIOD_LOCKED') return new AppError('PERIOD_LOCKED', message, { details });
  return new AppError('FORBIDDEN', message, { details });
}

// ----- status / preview / punch -----------------------------------------------------------------------------------------------------

export async function getPunchStatus(deps: ApiDeps, actor: Actor, orgId: string, q: { channel: SelfPunchChannel }): Promise<SelfPunchStatusDto> {
  const self = portalSelf(actor, orgId, 'attendance.checkin');
  return runUser(deps.db, actor, async (trx) => {
    const ctx = await loadPunchContext(trx, orgId, self.employeeId);
    const now = new Date();
    const local = localInstant(now, ctx.emp.timezone);
    const blockers = await standingRefusals(trx, orgId, ctx, q.channel, actor.ip, now);
    const todayStart = startOfLocalDay(now, ctx.emp.timezone).getTime();
    const recent = await recentRawPunches(trx, orgId, self.employeeId, new Date(Math.min(now.getTime() - SEQUENCE_WINDOW_MS, todayStart)));
    const inWindow = recent.filter((r) => now.getTime() - r.punchedAt.getTime() <= SEQUENCE_WINDOW_MS);
    const last = inWindow[0];
    const lastDirection: SelfPunchDirection | null = last && (last.direction === 'in' || last.direction === 'out') ? last.direction : null;
    const record = await withSystemScope(trx, orgId, (t) => t.selectFrom('attendanceDailyRecords').select(['status', 'flags', 'firstInAt', 'lastOutAt', 'workedMinutes'])
      .where('organizationId', '=', orgId).where('employeeId', '=', self.employeeId).where('attendanceDate', '=', sql<Date>`${local.date}::date`).executeTakeFirst());
    const blocked = blockers.length > 0;
    return {
      date: local.date, timezone: ctx.emp.timezone, serverTime: now.toISOString(),
      punches: recent.filter((r) => r.punchedAt.getTime() >= todayStart).map(toPunchDto),
      today: record ? { status: record.status as AttendanceStatus, flags: (record.flags ?? []) as AttendanceFlag[], firstInAt: isoDateTimeOrNull(record.firstInAt), lastOutAt: isoDateTimeOrNull(record.lastOutAt), workedMinutes: Number(record.workedMinutes ?? 0) } : null,
      lastDirection, canCheckIn: !blocked && lastDirection !== 'in', canCheckOut: !blocked && lastDirection !== 'out', blockers,
      policy: {
        webCheckIn: ctx.settings.selfService.webCheckIn, mobileCheckIn: ctx.settings.selfService.mobileCheckIn, requireGeofence: ctx.settings.selfService.requireGeofence,
        allowSelfieCheckIn: ctx.settings.selfService.allowSelfieCheckIn, checkInWindow: ctx.settings.selfService.checkInWindow, checkOutWindow: ctx.settings.selfService.checkOutWindow,
        outOfWindowAction: ctx.settings.selfService.outOfWindowAction, duplicatePunchSeconds: ctx.settings.selfService.duplicatePunchSeconds, ipRestricted: ctx.settings.selfService.ipAllowList.length > 0,
      },
      grant: { openAttendance: ctx.grants.openAttendance, selfieRequired: ctx.grants.selfieRequired },
      selfieAvailable: ctx.settings.selfService.allowSelfieCheckIn && (ctx.grants.openAttendance || ctx.grants.selfieRequired),
      fences: selfFences(ctx.fences),
    };
  });
}

/** Local midnight of `at` in the zone, as an instant. */
function startOfLocalDay(at: Date, tz: string): Date {
  const dt = DateTime.fromJSDate(at).setZone(tz);
  return (dt.isValid ? dt : DateTime.fromJSDate(at).toUTC()).startOf('day').toJSDate();
}

export async function previewPunch(deps: ApiDeps, actor: Actor, orgId: string, input: { direction: SelfPunchDirection; channel: SelfPunchChannel; lat?: number | undefined; lng?: number | undefined; accuracy?: number | undefined; isMock?: boolean | undefined }): Promise<SelfPunchPreviewDto> {
  const self = portalSelf(actor, orgId, 'attendance.checkin');
  return runUser(deps.db, actor, async (trx) => {
    const ctx = await loadPunchContext(trx, orgId, self.employeeId);
    const a = await assess(trx, orgId, ctx, input, actor.ip, new Date(), { sequence: true });
    return { verdict: { ...toVerdictDto(a.evaluation), verdict: a.verdict }, outOfWindow: a.outOfWindow, refusals: a.refusals, wouldBeFlagged: a.flagged };
  });
}

type PunchOutcome = { kind: 'ok'; result: SelfPunchResultDto } | { kind: 'refused'; refusals: SelfPunchRefusal[]; verdict: GeofenceVerdict };

export async function punch(deps: ApiDeps, actor: Actor, orgId: string, input: { direction: SelfPunchDirection; channel: SelfPunchChannel; lat?: number | undefined; lng?: number | undefined; accuracy?: number | undefined; isMock?: boolean | undefined; clientQueuedAt?: string | undefined; idempotencyKey: string }): Promise<SelfPunchResultDto> {
  const self = portalSelf(actor, orgId, 'attendance.checkin');
  const outcome = await runUser(deps.db, actor, async (trx): Promise<PunchOutcome> => {
    // one self-service punch of an employee at a time: the sequence, duplicate and idempotency checks read what the previous one wrote
    await lockEmployee(trx, 'self-punch', self.employeeId);
    const now = new Date();
    const txId = `self:${self.employeeId}:${input.idempotencyKey}`;
    const replay = await withSystemScope(trx, orgId, (t) => t.selectFrom('attendanceRawTransactions as rt').leftJoin('devices as d', 'd.id', 'rt.deviceId')
      .select(['rt.id', 'rt.punchedAt', 'rt.direction', 'rt.source', 'rt.rawPayload', 'rt.processingStatus', 'd.name as deviceName', 'rt.providerKey'])
      .where('rt.organizationId', '=', orgId).where('rt.providerKey', '=', SELF_SERVICE_PROVIDER_KEY).where('rt.providerTransactionId', '=', txId)
      .where('rt.punchedAt', '>=', new Date(now.getTime() - REPLAY_WINDOW_MS)).executeTakeFirst());
    if (replay) {
      const dto = toPunchDto({ ...replay, id: String(replay.id) } as RawPunchRow);
      const p = jsonObject(replay.rawPayload);
      const verdict = isVerdict(p['verdict']) ? p['verdict'] : 'no_fence';
      return { kind: 'ok', result: { replayed: true, punch: dto, verdict: { verdict, reason: typeof p['verdictReason'] === 'string' ? p['verdictReason'] : 'replayed', geofenceId: typeof p['geofenceId'] === 'string' ? p['geofenceId'] : null, geofenceName: typeof p['geofenceName'] === 'string' ? p['geofenceName'] : null, distanceM: typeof p['distanceM'] === 'number' ? p['distanceM'] : null, scope: null, enforcement: null }, outOfWindow: p['outOfWindow'] === true, flagged: verdict === 'flagged' || p['outOfWindow'] === true } };
    }
    const ctx = await loadPunchContext(trx, orgId, self.employeeId);
    const a = await assess(trx, orgId, ctx, input, actor.ip, now, { sequence: true });
    const verdictDto = { ...toVerdictDto(a.evaluation), verdict: a.verdict };
    const location = { lat: input.lat ?? null, lng: input.lng ?? null, accuracy: input.accuracy ?? null, isMock: input.isMock === true };
    if (a.refusals.length > 0) {
      await audit(trx, actor, orgId, 'attendance.self_punch_refused', 'employee', { entityId: ctx.emp.id, branchId: ctx.emp.branchId, newValue: { direction: input.direction, channel: input.channel, refusals: a.refusals, verdict: verdictDto, outOfWindow: a.outOfWindow, ...location, ip: actor.ip } });
      if (a.refusals.includes('OUTSIDE_GEOFENCE') || a.refusals.includes('MOCK_LOCATION')) {
        await emitToUsers(trx, actor, orgId, 'attendance.punch_flagged', { type: 'employee', id: ctx.emp.id }, await lineManagerUserIds(trx, orgId, ctx.emp),
          { employeeId: ctx.emp.id, employeeName: ctx.emp.displayName, outcome: 'denied', verdict: a.evaluation.verdict, reason: a.evaluation.reason, geofenceName: a.evaluation.geofenceName, distanceM: a.evaluation.distanceM, direction: input.direction, at: now.toISOString() });
      }
      return { kind: 'refused', refusals: a.refusals, verdict: a.verdict };
    }
    const payload = {
      channel: input.channel, lat: location.lat, lng: location.lng, accuracy: location.accuracy, geofenceId: verdictDto.geofenceId, geofenceName: verdictDto.geofenceName, verdict: a.verdict, verdictReason: a.evaluation.reason,
      distanceM: verdictDto.distanceM, ip: actor.ip, userAgent: actor.userAgent, isMock: location.isMock, outOfWindow: a.flagOutOfWindow, clientQueuedAt: input.clientQueuedAt ?? null,
      ...(a.outOfWindow && !a.flagOutOfWindow ? { outOfWindowAccepted: true } : {}), ...(a.verdict !== a.evaluation.verdict ? { openAttendance: true } : {}),
    };
    const written = await systemStep(trx, orgId, async (t) => {
      const device = await ensureSelfServiceDevice(t, orgId);
      const res = await ingestRawTransactions(t, { id: device.id, organizationId: orgId, generation: device.generation, providerKey: device.providerKey, branchId: ctx.emp.branchId, timezone: ctx.emp.timezone },
        [{ providerTransactionId: txId, deviceEmployeeId: ctx.emp.id, punchedAt: now.toISOString(), deviceLocalTime: null, verificationMethod: 'mobile', direction: input.direction, rawPayload: payload }], { source: 'SELF_SERVICE', now });
      const rawId = res.ids[0];
      if (!rawId) throw errors.conflict('This punch was already recorded.', { reason: 'DUPLICATE_PUNCH' });
      await t.updateTable('attendanceRawTransactions').set({ employeeId: ctx.emp.id }).where('organizationId', '=', orgId).where('id', '=', rawId).where('punchedAt', '=', now).execute();
      await enqueueNormalize(deps, t, orgId, device.id, actor.requestId);
      return { rawId, device };
    });
    await audit(trx, actor, orgId, 'attendance.self_punch', 'attendance_raw_transaction', { entityId: written.rawId, branchId: ctx.emp.branchId, newValue: { direction: input.direction, channel: input.channel, verdict: verdictDto, outOfWindow: a.outOfWindow, flagged: a.flagged, ...location, deviceCreated: written.device.created } });
    if (a.flagged) {
      await emitToUsers(trx, actor, orgId, 'attendance.punch_flagged', { type: 'employee', id: ctx.emp.id }, await lineManagerUserIds(trx, orgId, ctx.emp),
        { employeeId: ctx.emp.id, employeeName: ctx.emp.displayName, outcome: 'flagged', verdict: a.verdict, reason: a.flagOutOfWindow && a.verdict !== 'flagged' ? 'out_of_window' : a.evaluation.reason, geofenceName: a.evaluation.geofenceName, distanceM: a.evaluation.distanceM, direction: input.direction, at: now.toISOString(), rawTransactionId: written.rawId });
    }
    return {
      kind: 'ok',
      result: { replayed: false, punch: { id: written.rawId, punchedAt: now.toISOString(), direction: input.direction, source: 'SELF_SERVICE', channel: input.channel, verdict: a.verdict, deviceName: 'FlowZa Self-Service', processingStatus: 'pending' }, verdict: verdictDto, outOfWindow: a.outOfWindow, flagged: a.flagged },
    };
  });
  if (outcome.kind === 'refused') throw refusalError(outcome.refusals, { verdict: outcome.verdict });
  return outcome.result;
}

// ----- selfie check-in -----------------------------------------------------------------------------------------------------------------

export interface SelfieImage { bytes: Buffer; contentType: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp'; sha256: string }

/** Decode + sniff the photo (JPEG / PNG / WebP by their magic bytes, never by the declared type); at most 2 MB. */
export function parseSelfieImage(input: { base64?: string | undefined; bytes?: Uint8Array | undefined }): SelfieImage {
  let bytes: Buffer;
  if (input.bytes) bytes = Buffer.from(input.bytes);
  else {
    const raw = (input.base64 ?? '').replace(/^data:[^;,]+;base64,/i, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(raw)) throw errors.validation('The photo is not valid base64.', { issues: [{ path: 'imageBase64', message: 'Invalid base64' }] });
    bytes = Buffer.from(raw, 'base64');
  }
  if (bytes.length > SELFIE_MAX_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'The photo is larger than 2 MB.', { details: { maxBytes: SELFIE_MAX_BYTES, bytes: bytes.length } });
  if (bytes.length < 16) throw errors.validation('The photo is empty.', { issues: [{ path: 'imageBase64', message: 'Empty image' }] });
  let kind: Pick<SelfieImage, 'contentType' | 'ext'> | null = null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) kind = { contentType: 'image/jpeg', ext: 'jpg' };
  else if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) kind = { contentType: 'image/png', ext: 'png' };
  else if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') kind = { contentType: 'image/webp', ext: 'webp' };
  if (!kind) throw errors.validation('The photo must be a JPEG, PNG or WebP image.', { issues: [{ path: 'imageBase64', message: 'Unsupported image format' }] });
  return { bytes, ...kind, sha256: createHash('sha256').update(bytes).digest('hex') };
}

type SelfieRow = { id: string; organizationId: string; employeeId: string; branchId: string | null; punchedAt: Date; direction: string; photoPath: string; latitude: number | null; longitude: number | null; accuracyM: number | null; verdict: string | null; status: SelfieCheckinStatus; reviewedBy: string | null; reviewedAt: Date | null; reviewReason: string | null; rawTransactionId: string | null; createdAt: Date };
const SELFIE_COLUMNS = ['id', 'organizationId', 'employeeId', 'branchId', 'punchedAt', 'direction', 'photoPath', 'latitude', 'longitude', 'accuracyM', 'verdict', 'status', 'reviewedBy', 'reviewedAt', 'reviewReason', 'rawTransactionId', 'createdAt'] as const;

async function selfieDtos(trx: Trx, orgId: string, grant: MembershipGrant | null, rows: SelfieRow[]): Promise<SelfieCheckinDto[]> {
  if (rows.length === 0) return [];
  const names = await withSystemScope(trx, orgId, async (t) => ({
    employees: await t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', 'in', [...new Set(rows.map((r) => r.employeeId))]).execute(),
    users: await (async () => { const ids = [...new Set(rows.map((r) => r.reviewedBy).filter((x): x is string => !!x))]; return ids.length ? t.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', ids).execute() : []; })(),
  }));
  const emp = new Map(names.employees.map((e) => [e.id, e])); const users = new Map(names.users.map((u) => [u.id, u.fullName || u.email]));
  return rows.map((r) => ({
    id: r.id, employeeId: r.employeeId, employeeName: emp.get(r.employeeId)?.displayName ?? null, employeeNumber: emp.get(r.employeeId)?.employeeNumber ?? null, punchedAt: isoDateTime(r.punchedAt),
    direction: r.direction as SelfPunchDirection, latitude: r.latitude === null ? null : Number(r.latitude), longitude: r.longitude === null ? null : Number(r.longitude), accuracyM: r.accuracyM === null ? null : Number(r.accuracyM),
    verdict: isVerdict(r.verdict) ? r.verdict : null, status: r.status, reviewedBy: r.reviewedBy, reviewedByName: r.reviewedBy ? users.get(r.reviewedBy) ?? null : null, reviewedAt: isoDateTimeOrNull(r.reviewedAt),
    reviewReason: r.reviewReason, rawTransactionId: r.rawTransactionId === null ? null : String(r.rawTransactionId), createdAt: isoDateTime(r.createdAt),
    ...(grant ? { viaManager: grant.teamEmployeeIds.includes(r.employeeId) } : {}),
  }));
}

export async function submitSelfie(deps: ApiDeps, actor: Actor, orgId: string, input: { direction: SelfPunchDirection; image: SelfieImage; lat?: number | undefined; lng?: number | undefined; accuracy?: number | undefined; isMock?: boolean | undefined }): Promise<SelfieCheckinDto> {
  const self = portalSelf(actor, orgId, 'attendance.checkin');
  if (!deps.storage.upload) throw errors.dependency('Photo storage');
  return runUser(deps.db, actor, async (trx) => {
    await lockEmployee(trx, 'self-punch', self.employeeId);
    const ctx = await loadPunchContext(trx, orgId, self.employeeId);
    if (!ctx.settings.selfService.allowSelfieCheckIn) throw new AppError('FORBIDDEN', 'Selfie check-in is turned off for this organisation.', { details: { reason: 'SELFIE_DISABLED' } });
    if (!ctx.grants.openAttendance && !ctx.grants.selfieRequired) throw new AppError('FORBIDDEN', 'Selfie check-in needs an attendance grant from your manager.', { details: { reason: 'SELFIE_NOT_GRANTED' } });
    const now = new Date();
    const today = localInstant(now, ctx.emp.timezone).date;
    if (!isWorking(ctx.emp, today)) throw refusalError(['NOT_ACTIVE']);
    if (await isPeriodLocked(trx, orgId, ctx.emp.branchId, today)) throw refusalError(['PERIOD_LOCKED']);
    // the same duplicate guard as a punch: a second selfie of the same direction within `duplicatePunchSeconds` is a double tap
    const dupSeconds = ctx.settings.selfService.duplicatePunchSeconds;
    if (dupSeconds > 0) {
      const recent = await withSystemScope(trx, orgId, (t) => t.selectFrom('selfieCheckins').select('id').where('organizationId', '=', orgId).where('employeeId', '=', ctx.emp.id)
        .where('direction', '=', input.direction).where('createdAt', '>', new Date(now.getTime() - dupSeconds * 1000)).executeTakeFirst());
      if (recent) throw refusalError(['DUPLICATE_PUNCH']);
    }
    const evaluation = evaluateForEmployee(ctx.emp, ctx.fences, { ...input }, ctx.settings.selfService.requireGeofence, now);
    const id = randomUUID();
    const photoPath = `checkins/${orgId}/${ctx.emp.id}/${id}.${input.image.ext}`;
    await systemStep(trx, orgId, (t) => t.insertInto('selfieCheckins').values({
      id, organizationId: orgId, employeeId: ctx.emp.id, branchId: ctx.emp.branchId, punchedAt: now, direction: input.direction, photoPath, photoSha256: input.image.sha256,
      latitude: input.lat ?? null, longitude: input.lng ?? null, accuracyM: input.accuracy ?? null, verdict: evaluation.verdict, status: 'pending', createdBy: actor.userId,
    }).execute());
    // the row commits only if the photo is stored (a failed upload rolls the check-in back)
    const stored = await deps.storage.upload!(SELFIE_BUCKET, photoPath, input.image.bytes, input.image.contentType);
    if (!stored) throw errors.dependency('Photo storage');
    await audit(trx, actor, orgId, 'attendance.selfie_submitted', 'selfie_checkin', { entityId: id, branchId: ctx.emp.branchId, newValue: { direction: input.direction, verdict: evaluation.verdict, lat: input.lat ?? null, lng: input.lng ?? null, accuracy: input.accuracy ?? null, photoSha256: input.image.sha256 } });
    await emitToUsers(trx, actor, orgId, 'attendance.selfie_submitted', { type: 'selfie_checkin', id }, await lineManagerUserIds(trx, orgId, ctx.emp),
      { selfieId: id, employeeId: ctx.emp.id, employeeName: ctx.emp.displayName, direction: input.direction, at: now.toISOString(), verdict: evaluation.verdict });
    const row = (await withSystemScope(trx, orgId, (t) => t.selectFrom('selfieCheckins').select(SELFIE_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow())) as SelfieRow;
    return (await selfieDtos(trx, orgId, null, [row]))[0]!;
  });
}

/** The caller's own selfie check-ins (newest first). */
export async function listMySelfies(deps: ApiDeps, actor: Actor, orgId: string): Promise<SelfieCheckinDto[]> {
  const self = portalSelf(actor, orgId, 'attendance.checkin');
  return runUser(deps.db, actor, async (trx) => {
    const rows = (await trx.selectFrom('selfieCheckins').select(SELFIE_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', self.employeeId).orderBy('createdAt', 'desc').limit(50).execute()) as SelfieRow[];
    return selfieDtos(trx, orgId, null, rows);
  });
}

/** Managers / HR: selfie check-ins they can see (RLS: organisation-wide attendance.view in branch scope, or team keys for direct reports). */
export async function listSelfies(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; status?: SelfieCheckinStatus | undefined; employeeId?: string | undefined }): Promise<{ data: SelfieCheckinDto[]; total: number }> {
  const grant = requireMembership(actor.principal, orgId);
  const org = grant.permissions.includes('attendance.view');
  if (!org && grant.teamEmployeeIds.length === 0) throw errors.forbidden('Missing permission: attendance.view.');
  return runUser(deps.db, actor, async (trx) => {
    // line managers read their direct reports' check-ins even without a team key (they are the reviewers)
    const read = async (t: Trx) => {
      let base = t.selectFrom('selfieCheckins').where('organizationId', '=', orgId).where('employeeId', '!=', grant.employeeId ?? '00000000-0000-0000-0000-000000000000');
      if (!org) base = base.where('employeeId', 'in', grant.teamEmployeeIds);
      else if (!grant.allBranches) base = base.where((eb) => eb.or([eb('branchId', 'in', grant.branchIds.length ? grant.branchIds : ['00000000-0000-0000-0000-000000000000']), eb('employeeId', 'in', grant.teamEmployeeIds.length ? grant.teamEmployeeIds : ['00000000-0000-0000-0000-000000000000'])]));
      if (q.status) base = base.where('status', '=', q.status);
      if (q.employeeId) base = base.where('employeeId', '=', q.employeeId);
      const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
      const page = pageOf(q);
      const rows = (await base.select(SELFIE_COLUMNS).orderBy('createdAt', q.status === 'pending' ? 'asc' : 'desc').orderBy('id').limit(page.pageSize).offset(page.offset).execute()) as SelfieRow[];
      return { rows, total };
    };
    const { rows, total } = org ? await read(trx) : await withSystemScope(trx, orgId, read);
    return { data: await selfieDtos(trx, orgId, grant, rows), total };
  });
}

async function loadSelfieForReview(trx: Trx, orgId: string, grant: MembershipGrant, id: string): Promise<{ row: SelfieRow; role: 'manager' | 'oversight' }> {
  const row = (await withSystemScope(trx, orgId, (t) => t.selectFrom('selfieCheckins').select(SELFIE_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst())) as SelfieRow | undefined;
  if (!row) throw errors.notFound('Selfie check-in', id);
  const role = reviewerRole(grant, { id: row.employeeId, branchId: row.branchId }, ['attendance.approve']);
  if (grant.employeeId && grant.employeeId === row.employeeId) throw errors.forbidden('You cannot review your own check-in.');
  if (!role) throw errors.notFound('Selfie check-in', id);
  return { row, role };
}

/** A 60-second signed URL of the photo for its reviewers (and nobody else); every issue is audited. */
export async function selfiePhotoUrl(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<SelfiePhotoDto> {
  const grant = requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const { row } = await loadSelfieForReview(trx, orgId, grant, id);
    const url = await deps.storage.signedUrl(SELFIE_BUCKET, row.photoPath, 60);
    if (!url) throw errors.dependency('Photo storage');
    await audit(trx, actor, orgId, 'attendance.selfie_photo_viewed', 'selfie_checkin', { entityId: id, branchId: row.branchId });
    return { url, expiresInSeconds: 60 };
  });
}

export async function reviewSelfie(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: SelfieReviewInput): Promise<SelfieCheckinDto> {
  const grant = requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const { row, role } = await loadSelfieForReview(trx, orgId, grant, id);
    if (row.status !== 'pending') throw errors.invalidState(`This check-in was already ${row.status}.`);
    const emp = await loadEmployeeCtx(trx, orgId, row.employeeId);
    const now = new Date();
    if (input.decision === 'approve') {
      const date = localInstant(row.punchedAt, emp.timezone).date;
      if (await isPeriodLocked(trx, orgId, emp.branchId, date)) throw errors.periodLocked('The attendance period of this check-in is locked; unlock it before approving.');
      const rawId = await systemStep(trx, orgId, async (t) => {
        const upd = await t.updateTable('selfieCheckins').set({ status: 'approved', reviewedBy: actor.userId, reviewedAt: now, reviewReason: input.reason ?? null }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
        if (Number(upd.numUpdatedRows) !== 1) throw errors.conflict('The check-in changed meanwhile. Please refresh.');
        const device = await ensureSelfServiceDevice(t, orgId);
        const res = await ingestRawTransactions(t, { id: device.id, organizationId: orgId, generation: device.generation, providerKey: device.providerKey, branchId: emp.branchId, timezone: emp.timezone }, [{
          providerTransactionId: `selfie:${id}`, deviceEmployeeId: emp.id, punchedAt: row.punchedAt.toISOString(), deviceLocalTime: null, verificationMethod: 'face', direction: row.direction === 'out' ? 'out' : 'in',
          rawPayload: { channel: 'mobile', selfieId: id, lat: row.latitude, lng: row.longitude, accuracy: row.accuracyM, verdict: row.verdict, isMock: false, outOfWindow: false, approvedBy: actor.userId, reviewVia: role },
        }], { source: 'SELF_SERVICE', now });
        const newId = res.ids[0] ?? null;
        if (newId) {
          await t.updateTable('attendanceRawTransactions').set({ employeeId: emp.id }).where('organizationId', '=', orgId).where('id', '=', newId).where('punchedAt', '=', row.punchedAt).execute();
          await t.updateTable('selfieCheckins').set({ rawTransactionId: newId }).where('id', '=', id).execute();
          await enqueueNormalize(deps, t, orgId, device.id, actor.requestId);
        }
        return newId;
      });
      await audit(trx, actor, orgId, 'attendance.selfie_approved', 'selfie_checkin', { entityId: id, branchId: row.branchId, newValue: { rawTransactionId: rawId, reviewVia: role, reason: input.reason ?? null } });
    } else {
      await systemStep(trx, orgId, async (t) => {
        const upd = await t.updateTable('selfieCheckins').set({ status: 'rejected', reviewedBy: actor.userId, reviewedAt: now, reviewReason: input.reason ?? null }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
        if (Number(upd.numUpdatedRows) !== 1) throw errors.conflict('The check-in changed meanwhile. Please refresh.');
      });
      await audit(trx, actor, orgId, 'attendance.selfie_rejected', 'selfie_checkin', { entityId: id, branchId: row.branchId, reason: input.reason ?? null, newValue: { reviewVia: role } });
    }
    await emitToUsers(trx, actor, orgId, 'attendance.selfie_decided', { type: 'selfie_checkin', id }, await userIdsOfEmployees(trx, orgId, [emp.id]),
      { selfieId: id, employeeId: emp.id, decision: input.decision === 'approve' ? 'approved' : 'rejected', reason: input.reason ?? null, at: row.punchedAt.toISOString(), direction: row.direction });
    const after = (await withSystemScope(trx, orgId, (t) => t.selectFrom('selfieCheckins').select(SELFIE_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow())) as SelfieRow;
    return (await selfieDtos(trx, orgId, grant, [after]))[0]!;
  });
}

// ----- attendance grants ----------------------------------------------------------------------------------------------------------------

async function grantAccess(trx: Trx, actor: Actor, orgId: string, employeeId: string): Promise<{ emp: EmployeeCtx; grant: MembershipGrant }> {
  const grant = requireMembership(actor.principal, orgId);
  if (grant.employeeId && grant.employeeId === employeeId) throw errors.forbidden('You cannot change your own attendance grants.');
  const emp = await loadEmployeeCtx(trx, orgId, employeeId);
  const role = reviewerRole(grant, { id: emp.id, branchId: emp.branchId }, ['attendance.approve']);
  if (!role) throw errors.forbidden('Only the employee\'s line manager or an attendance approver can manage these grants.');
  if (role === 'oversight') requireBranchAccess(grant, emp.branchId);
  return { emp, grant };
}

async function grantsDto(trx: Trx, orgId: string, employeeId: string): Promise<AttendanceGrantsDto> {
  const g = await loadGrants(trx, orgId, employeeId);
  const name = g.grantedBy ? (await withSystemScope(trx, orgId, (t) => t.selectFrom('userProfiles').select(['fullName', 'email']).where('id', '=', g.grantedBy!).executeTakeFirst())) : undefined;
  return { employeeId, openAttendance: g.openAttendance, selfieRequired: g.selfieRequired, grantedBy: g.grantedBy, grantedByName: name ? name.fullName || name.email : null, grantedAt: isoDateTimeOrNull(g.grantedAt) };
}

export async function getAttendanceGrants(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string): Promise<AttendanceGrantsDto> {
  return runUser(deps.db, actor, async (trx) => {
    await grantAccess(trx, actor, orgId, employeeId);
    return grantsDto(trx, orgId, employeeId);
  });
}

export async function putAttendanceGrants(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, input: AttendanceGrantsInput): Promise<AttendanceGrantsDto> {
  return runUser(deps.db, actor, async (trx) => {
    const { emp } = await grantAccess(trx, actor, orgId, employeeId);
    const before = await loadGrants(trx, orgId, employeeId);
    const now = new Date();
    await systemStep(trx, orgId, (t) => t.insertInto('employeeAttendanceGrants').values({ organizationId: orgId, employeeId, openAttendance: input.openAttendance, selfieRequired: input.selfieRequired, grantedBy: actor.userId, grantedAt: now })
      .onConflict((oc) => oc.column('employeeId').doUpdateSet({ openAttendance: input.openAttendance, selfieRequired: input.selfieRequired, grantedBy: actor.userId, grantedAt: now })).execute());
    await audit(trx, actor, orgId, 'attendance.grants_updated', 'employee', { entityId: employeeId, branchId: emp.branchId, oldValue: { openAttendance: before.openAttendance, selfieRequired: before.selfieRequired }, newValue: input });
    return grantsDto(trx, orgId, employeeId);
  });
}
