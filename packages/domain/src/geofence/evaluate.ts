/**
 * Geofence evaluation (HR portal Prompt 4; Finance `evaluate_geofence`, corrected). Pure: the API loads the fences that are
 * assigned to the employee and the evaluation instant in the branch's local time; this decides the verdict.
 *
 *   1. Only fences that apply now are considered: active, inside their active dates, inside one of their weekly time windows
 *      (LOCAL time — Finance evaluated them in UTC), and required for the punch direction (check-in / check-out).
 *   2. Scope precedence employee > team > department > branch > org: only the fences of the most specific scope that has an
 *      applicable fence are judged (an employee-specific fence overrides the branch's, it is not added to it).
 *   3. Each fence of that scope gives a verdict: inside (within radius + grace, or inside the polygon or within grace of its
 *      edge) with a fix at least as precise as the fence's accuracy threshold → `allowed`; otherwise its EFFECTIVE
 *      enforcement decides — hard_block → `denied_outside`, soft_warn → `flagged`, advisory_log → `logged` (reasons:
 *      `outside`, `gps_accuracy_too_low`, `location_missing`). A mock location proves nothing: every fence treats it as
 *      outside, and a refusal reads `denied_mock`.
 *   4. The worst verdict of the scope wins (denied > flagged > logged > allowed). Ties go to the higher-priority fence
 *      (lower number), then the nearer one, then the id.
 *   5. The organisation policy `attendance.selfService.requireGeofence` caps the enforcement: `off` = geofencing is not
 *      evaluated at all (`no_fence`, reason `geofence_off`); `flag` = nothing is refused (hard_block fences flag instead);
 *      `block` = fences act as configured.
 *   6. No applicable fence → `no_fence` (reason `no_fences_assigned`): the punch is not judged by location.
 */
import type { GeofenceEnforcementSpec, GeofenceEvaluation, GeofenceFence, GeofencePoint, GeofenceScopeSpec, GeofenceVerdictSpec, GeofenceWhen, FenceOutcome } from './types.js';

export const SCOPE_RANK: Record<GeofenceScopeSpec, number> = { employee: 5, team: 4, department: 3, branch: 2, org: 1 };
const VERDICT_RANK: Record<GeofenceVerdictSpec, number> = { denied_mock: 5, denied_outside: 5, flagged: 3, logged: 2, allowed: 1, no_fence: 0 };
const ENFORCEMENT_RANK: Record<GeofenceEnforcementSpec, number> = { advisory_log: 1, soft_warn: 2, hard_block: 3 };
const EARTH_RADIUS_M = 6_371_008.8;

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres (haversine). */
export function haversineM(a: GeofencePoint, b: GeofencePoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Local equirectangular projection around `origin` (metres) — accurate to well under a metre at fence scale (≤ a few km). */
function project(p: GeofencePoint, origin: GeofencePoint): { x: number; y: number } {
  return { x: rad(p.lng - origin.lng) * Math.cos(rad(origin.lat)) * EARTH_RADIUS_M, y: rad(p.lat - origin.lat) * EARTH_RADIUS_M };
}

/** Ray casting on the projected plane: true when the point is inside the polygon (edges count as inside). */
export function pointInPolygon(point: GeofencePoint, polygon: ReadonlyArray<GeofencePoint>): boolean {
  if (polygon.length < 3) return false;
  const pts = polygon.map((p) => project(p, point));
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const a = pts[i]!; const b = pts[j]!;
    // on the edge: distance 0 → inside
    if (segmentDistance({ x: 0, y: 0 }, a, b) < 1e-6) return true;
    const crosses = (a.y > 0) !== (b.y > 0) && 0 < ((b.x - a.x) * (0 - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function segmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const cx = a.x + t * dx; const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Distance in metres from the point to the polygon's boundary (0 when inside). */
export function distanceToPolygonM(point: GeofencePoint, polygon: ReadonlyArray<GeofencePoint>): number {
  if (pointInPolygon(point, polygon)) return 0;
  const pts = polygon.map((p) => project(p, point));
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) best = Math.min(best, segmentDistance({ x: 0, y: 0 }, pts[i]!, pts[j]!));
  return best;
}

/** Distance from the fence's edge in metres (0 inside) and whether the point counts as inside (grace radius included). */
export function fenceDistance(point: GeofencePoint, fence: Pick<GeofenceFence, 'center' | 'radiusM' | 'polygon' | 'graceM'>): { distanceM: number; inside: boolean } {
  if (fence.polygon && fence.polygon.length >= 3) {
    const d = distanceToPolygonM(point, fence.polygon);
    return { distanceM: round1(d), inside: d <= fence.graceM };
  }
  const d = Math.max(0, haversineM(point, fence.center) - fence.radiusM);
  return { distanceM: round1(d), inside: d <= fence.graceM };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const minutesOf = (hhmm: string): number => { const [h, m] = hhmm.split(':'); return Number(h) * 60 + Number(m); };

/** Why a fence does not apply at `when` (null = it applies). */
export function inactiveReason(fence: GeofenceFence, when: GeofenceWhen, direction: 'in' | 'out'): string | null {
  if (!fence.isActive) return 'inactive';
  if (fence.activeFrom && when.date < fence.activeFrom) return 'not_yet_active';
  if (fence.activeTo && when.date > fence.activeTo) return 'expired';
  if (direction === 'in' && !fence.requireOnCheckIn) return 'not_on_check_in';
  if (direction === 'out' && !fence.requireOnCheckOut) return 'not_on_check_out';
  const windows = fence.timeWindows ?? [];
  if (windows.length > 0 && !windows.some((w) => inWindow(w, when))) return 'outside_time_window';
  return null;
}

/** A window of the given ISO weekday(s); a window that wraps midnight belongs to the day it starts on. */
function inWindow(w: { days: readonly number[]; start: string; end: string }, when: GeofenceWhen): boolean {
  const start = minutesOf(w.start); const end = minutesOf(w.end);
  if (start === end) return w.days.includes(when.isoWeekday); // a whole day
  if (start < end) return w.days.includes(when.isoWeekday) && when.minuteOfDay >= start && when.minuteOfDay < end;
  // wraps midnight: [start, 24:00) on the listed day, [00:00, end) on the following day
  const previousDay = when.isoWeekday === 1 ? 7 : when.isoWeekday - 1;
  return (w.days.includes(when.isoWeekday) && when.minuteOfDay >= start) || (w.days.includes(previousDay) && when.minuteOfDay < end);
}

/** The enforcement the organisation policy allows the fence to apply. */
export function effectiveEnforcement(fence: GeofenceEnforcementSpec, policy: 'off' | 'flag' | 'block'): GeofenceEnforcementSpec {
  if (policy === 'block') return fence;
  if (policy === 'flag') return ENFORCEMENT_RANK[fence] > ENFORCEMENT_RANK.soft_warn ? 'soft_warn' : fence;
  return 'advisory_log';
}

function outsideVerdict(enforcement: GeofenceEnforcementSpec, mock: boolean): GeofenceVerdictSpec {
  if (enforcement === 'hard_block') return mock ? 'denied_mock' : 'denied_outside';
  return enforcement === 'soft_warn' ? 'flagged' : 'logged';
}

export interface EvaluateGeofenceOptions {
  /** The device reported a mock / simulated location. */
  isMock: boolean;
  /** `attendance.selfService.requireGeofence`. */
  policy: 'off' | 'flag' | 'block';
  direction: 'in' | 'out';
  /** The evaluation instant in the branch's local time. */
  when: GeofenceWhen;
}

/**
 * Evaluate a punch location against the employee's fences (see the module comment for the rules). `fences` are the
 * (fence, assignment) pairs that target the employee — the caller resolves the employee's branch / department / teams.
 */
export function evaluateGeofence(point: GeofencePoint | null, accuracyM: number | null, fences: readonly GeofenceFence[], opts: EvaluateGeofenceOptions): GeofenceEvaluation {
  const outcomes: FenceOutcome[] = fences.map((f) => {
    const reason = inactiveReason(f, opts.when, opts.direction);
    const distance = point ? fenceDistance(point, f).distanceM : null;
    return { fence: f, applicable: reason === null, inactiveReason: reason, considered: false, distanceM: distance, verdict: null, reason: null };
  });
  const none = (reason: string, nearest: FenceOutcome | null = null): GeofenceEvaluation => ({
    verdict: 'no_fence', reason, geofenceId: nearest?.fence.id ?? null, geofenceName: nearest?.fence.name ?? null, distanceM: nearest?.distanceM ?? null,
    scope: null, enforcement: null, winningScope: null, outcomes,
  });
  if (opts.policy === 'off') return none('geofence_off', nearestOf(outcomes.filter((o) => o.applicable)));
  const applicable = outcomes.filter((o) => o.applicable);
  if (applicable.length === 0) return none('no_fences_assigned');

  const winningScope = applicable.reduce<GeofenceScopeSpec>((best, o) => (SCOPE_RANK[o.fence.scope] > SCOPE_RANK[best] ? o.fence.scope : best), applicable[0]!.fence.scope);
  const judged = applicable.filter((o) => o.fence.scope === winningScope);
  for (const o of judged) {
    o.considered = true;
    const enforcement = effectiveEnforcement(o.fence.enforcement, opts.policy);
    if (opts.isMock) { o.verdict = outsideVerdict(enforcement, true); o.reason = 'mock_location'; continue; }
    if (!point) { o.verdict = outsideVerdict(enforcement, false); o.reason = 'location_missing'; continue; }
    const { inside } = fenceDistance(point, o.fence);
    if (accuracyM !== null && accuracyM > o.fence.accuracyThresholdM) { o.verdict = outsideVerdict(enforcement, false); o.reason = 'gps_accuracy_too_low'; continue; }
    if (inside) { o.verdict = 'allowed'; o.reason = 'inside'; continue; }
    o.verdict = outsideVerdict(enforcement, false); o.reason = 'outside';
  }
  const worst = [...judged].sort((a, b) =>
    VERDICT_RANK[b.verdict!] - VERDICT_RANK[a.verdict!]
    || a.fence.priority - b.fence.priority
    || (a.distanceM ?? Number.POSITIVE_INFINITY) - (b.distanceM ?? Number.POSITIVE_INFINITY)
    || a.fence.id.localeCompare(b.fence.id))[0]!;
  // when every fence passed, report the one the employee is in with the best priority (the "zone" they punched in)
  return {
    verdict: worst.verdict!, reason: worst.reason!, geofenceId: worst.fence.id, geofenceName: worst.fence.name, distanceM: worst.distanceM, scope: winningScope,
    enforcement: effectiveEnforcement(worst.fence.enforcement, opts.policy), winningScope, outcomes,
  };
}

function nearestOf(list: readonly FenceOutcome[]): FenceOutcome | null {
  return [...list].filter((o) => o.distanceM !== null).sort((a, b) => a.distanceM! - b.distanceM! || a.fence.id.localeCompare(b.fence.id))[0] ?? null;
}

/**
 * The B-36 truth table of a punch's location (HR portal Prompt 4 review, P2-7; Finance `_attendance_geofence_pass`):
 *   true  — a fence judged the punch and it was inside (`allowed`);
 *   false — a REAL fence was evaluated with a location and the punch failed it (reason `outside`, or a mocked location,
 *           which every fence treats as outside);
 *   null  — nobody can say: no fence applies (`no_fence`: none assigned, or geofencing off), no location was sent, or the fix
 *           was too imprecise for the fence to judge.
 * The attendance engine raises OUTSIDE_GEOFENCE only for `false`. A stored verdict without its reason (rows written before
 * the reason was kept) is read conservatively: only an outright refusal counts as failed.
 */
export function withinGeofenceOf(e: { verdict: string | null | undefined; reason: string | null | undefined }): boolean | null {
  if (!e.verdict || e.verdict === 'no_fence') return null;
  if (e.verdict === 'allowed') return true;
  if (e.reason === 'outside' || e.reason === 'mock_location') return false;
  if (!e.reason && (e.verdict === 'denied_outside' || e.verdict === 'denied_mock')) return false;
  return null;
}

/** True when the verdict means the punch is refused (not recorded). */
export const isRefusalVerdict = (v: GeofenceVerdictSpec): boolean => v === 'denied_outside' || v === 'denied_mock';
/** True when the verdict flags the punch (recorded, but a manager should look). */
export const isFlagVerdict = (v: GeofenceVerdictSpec): boolean => v === 'flagged';
