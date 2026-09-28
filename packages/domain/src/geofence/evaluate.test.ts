import { describe, expect, it } from 'vitest';
import { effectiveEnforcement, evaluateGeofence, fenceDistance, haversineM, inactiveReason, isFlagVerdict, isRefusalVerdict, pointInPolygon, withinGeofenceOf } from './evaluate.js';
import type { GeofenceFence, GeofencePoint, GeofenceWhen } from './types.js';

// Muscat-ish office; 0.001° of latitude ≈ 111 m.
const OFFICE: GeofencePoint = { lat: 23.5880, lng: 58.3829 };
const north = (m: number): GeofencePoint => ({ lat: OFFICE.lat + m / 111_195, lng: OFFICE.lng });
const WHEN: GeofenceWhen = { date: '2026-09-28', minuteOfDay: 9 * 60, isoWeekday: 1 }; // Monday 09:00

let n = 0;
function fence(over: Partial<GeofenceFence> = {}): GeofenceFence {
  n += 1;
  return {
    id: `f-${String(n).padStart(3, '0')}`, name: `Fence ${n}`, center: OFFICE, radiusM: 100, polygon: null, enforcement: 'soft_warn',
    accuracyThresholdM: 100, graceM: 0, activeFrom: null, activeTo: null, timeWindows: null, isActive: true, scope: 'org', priority: 100,
    requireOnCheckIn: true, requireOnCheckOut: true, ...over,
  };
}
const opts = (over: Partial<Parameters<typeof evaluateGeofence>[3]> = {}) => ({ isMock: false, policy: 'block' as const, direction: 'in' as const, when: WHEN, ...over });

describe('geometry', () => {
  it('haversine is symmetric and ≈ 111 m per 0.001° of latitude', () => {
    const d = haversineM(OFFICE, north(111.195));
    expect(d).toBeGreaterThan(110.5);
    expect(d).toBeLessThan(111.9);
    expect(haversineM(north(111.195), OFFICE)).toBeCloseTo(d, 6);
  });

  it('circle distance is measured from the edge and the grace radius widens "inside"', () => {
    const f = fence({ radiusM: 100, graceM: 0 });
    expect(fenceDistance(north(50), f)).toEqual({ distanceM: 0, inside: true });
    const out = fenceDistance(north(130), f);
    expect(out.inside).toBe(false);
    expect(out.distanceM).toBeGreaterThan(29);
    expect(out.distanceM).toBeLessThan(31);
    expect(fenceDistance(north(130), fence({ radiusM: 100, graceM: 40 })).inside).toBe(true);
  });

  it('polygons: inside, outside, on the edge, grace from the nearest edge', () => {
    const square: GeofencePoint[] = [north(-100), { lat: north(-100).lat, lng: OFFICE.lng + 0.002 }, { lat: north(100).lat, lng: OFFICE.lng + 0.002 }, north(100)];
    expect(pointInPolygon({ lat: OFFICE.lat, lng: OFFICE.lng + 0.001 }, square)).toBe(true);
    expect(pointInPolygon({ lat: OFFICE.lat, lng: OFFICE.lng - 0.001 }, square)).toBe(false);
    expect(pointInPolygon(OFFICE, square)).toBe(true); // on the west edge
    const f = fence({ polygon: square, graceM: 0 });
    const outside = fenceDistance({ lat: OFFICE.lat, lng: OFFICE.lng - 0.0003 }, f); // ≈ 30.6 m west of the edge
    expect(outside.inside).toBe(false);
    expect(outside.distanceM).toBeGreaterThan(29);
    expect(outside.distanceM).toBeLessThan(32);
    expect(fenceDistance({ lat: OFFICE.lat, lng: OFFICE.lng - 0.0003 }, { ...f, graceM: 35 }).inside).toBe(true);
    expect(pointInPolygon(OFFICE, square.slice(0, 2))).toBe(false); // degenerate
  });
});

describe('applicability', () => {
  it('inactive, date range, direction switches and local weekly windows', () => {
    expect(inactiveReason(fence({ isActive: false }), WHEN, 'in')).toBe('inactive');
    expect(inactiveReason(fence({ activeFrom: '2026-09-29' }), WHEN, 'in')).toBe('not_yet_active');
    expect(inactiveReason(fence({ activeTo: '2026-09-27' }), WHEN, 'in')).toBe('expired');
    expect(inactiveReason(fence({ activeFrom: '2026-09-28', activeTo: '2026-09-28' }), WHEN, 'in')).toBeNull();
    expect(inactiveReason(fence({ requireOnCheckIn: false }), WHEN, 'in')).toBe('not_on_check_in');
    expect(inactiveReason(fence({ requireOnCheckOut: false }), WHEN, 'out')).toBe('not_on_check_out');
    expect(inactiveReason(fence({ timeWindows: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }] }), WHEN, 'in')).toBeNull();
    expect(inactiveReason(fence({ timeWindows: [{ days: [6, 7], start: '08:00', end: '18:00' }] }), WHEN, 'in')).toBe('outside_time_window');
    expect(inactiveReason(fence({ timeWindows: [{ days: [1], start: '10:00', end: '18:00' }] }), WHEN, 'in')).toBe('outside_time_window');
    // a whole-day window (start = end)
    expect(inactiveReason(fence({ timeWindows: [{ days: [1], start: '00:00', end: '00:00' }] }), WHEN, 'in')).toBeNull();
  });

  it('a window that wraps midnight belongs to the day it starts on', () => {
    const night = fence({ timeWindows: [{ days: [7], start: '22:00', end: '06:00' }] }); // Sunday night shift
    expect(inactiveReason(night, { date: '2026-09-27', minuteOfDay: 23 * 60, isoWeekday: 7 }, 'in')).toBeNull();
    expect(inactiveReason(night, { date: '2026-09-28', minuteOfDay: 5 * 60, isoWeekday: 1 }, 'out')).toBeNull();
    expect(inactiveReason(night, { date: '2026-09-28', minuteOfDay: 23 * 60, isoWeekday: 1 }, 'in')).toBe('outside_time_window');
    expect(inactiveReason(night, { date: '2026-09-27', minuteOfDay: 5 * 60, isoWeekday: 7 }, 'in')).toBe('outside_time_window');
  });
});

describe('evaluateGeofence', () => {
  it('no applicable fence → no_fence (no_fences_assigned); the org policy "off" → no_fence (geofence_off) with the nearest zone', () => {
    expect(evaluateGeofence(OFFICE, 10, [], opts())).toMatchObject({ verdict: 'no_fence', reason: 'no_fences_assigned', geofenceId: null });
    const expired = fence({ activeTo: '2026-01-01' });
    expect(evaluateGeofence(OFFICE, 10, [expired], opts())).toMatchObject({ verdict: 'no_fence', reason: 'no_fences_assigned' });
    const f = fence({ enforcement: 'hard_block' });
    const off = evaluateGeofence(north(500), 10, [f], opts({ policy: 'off' }));
    expect(off).toMatchObject({ verdict: 'no_fence', reason: 'geofence_off', geofenceId: f.id });
    expect(off.distanceM).toBeGreaterThan(390);
  });

  it('inside → allowed; outside → the enforcement decides (block, warn, log)', () => {
    expect(evaluateGeofence(north(20), 10, [fence({ enforcement: 'hard_block' })], opts())).toMatchObject({ verdict: 'allowed', reason: 'inside' });
    expect(evaluateGeofence(north(300), 10, [fence({ enforcement: 'hard_block' })], opts())).toMatchObject({ verdict: 'denied_outside', reason: 'outside' });
    expect(evaluateGeofence(north(300), 10, [fence({ enforcement: 'soft_warn' })], opts())).toMatchObject({ verdict: 'flagged', reason: 'outside' });
    expect(evaluateGeofence(north(300), 10, [fence({ enforcement: 'advisory_log' })], opts())).toMatchObject({ verdict: 'logged', reason: 'outside' });
  });

  it('a GPS fix worse than the accuracy threshold does not prove presence; a missing location neither', () => {
    const f = fence({ enforcement: 'hard_block', accuracyThresholdM: 50 });
    expect(evaluateGeofence(north(10), 80, [f], opts())).toMatchObject({ verdict: 'denied_outside', reason: 'gps_accuracy_too_low' });
    expect(evaluateGeofence(north(10), 50, [f], opts())).toMatchObject({ verdict: 'allowed' });
    expect(evaluateGeofence(north(10), null, [f], opts())).toMatchObject({ verdict: 'allowed' });
    expect(evaluateGeofence(null, null, [f], opts())).toMatchObject({ verdict: 'denied_outside', reason: 'location_missing' });
    expect(evaluateGeofence(null, null, [fence({ enforcement: 'soft_warn' })], opts())).toMatchObject({ verdict: 'flagged', reason: 'location_missing' });
  });

  it('a mock location is never inside: hard_block → denied_mock, soft_warn → flagged, advisory → logged', () => {
    expect(evaluateGeofence(OFFICE, 5, [fence({ enforcement: 'hard_block' })], opts({ isMock: true }))).toMatchObject({ verdict: 'denied_mock', reason: 'mock_location' });
    expect(evaluateGeofence(OFFICE, 5, [fence({ enforcement: 'soft_warn' })], opts({ isMock: true }))).toMatchObject({ verdict: 'flagged', reason: 'mock_location' });
    expect(evaluateGeofence(OFFICE, 5, [fence({ enforcement: 'advisory_log' })], opts({ isMock: true }))).toMatchObject({ verdict: 'logged' });
  });

  it('the org policy caps enforcement: "flag" never refuses', () => {
    expect(effectiveEnforcement('hard_block', 'flag')).toBe('soft_warn');
    expect(effectiveEnforcement('advisory_log', 'flag')).toBe('advisory_log');
    expect(effectiveEnforcement('hard_block', 'block')).toBe('hard_block');
    expect(effectiveEnforcement('hard_block', 'off')).toBe('advisory_log');
    expect(evaluateGeofence(north(300), 10, [fence({ enforcement: 'hard_block' })], opts({ policy: 'flag' }))).toMatchObject({ verdict: 'flagged', enforcement: 'soft_warn' });
    expect(evaluateGeofence(OFFICE, 10, [fence({ enforcement: 'hard_block' })], opts({ policy: 'flag', isMock: true }))).toMatchObject({ verdict: 'flagged' });
  });

  it('scope precedence: the most specific scope with an applicable fence is the only one judged', () => {
    const orgFence = fence({ scope: 'org', enforcement: 'hard_block', center: north(5000) });
    const branchFence = fence({ scope: 'branch', enforcement: 'hard_block', center: north(3000) });
    const employeeFence = fence({ scope: 'employee', enforcement: 'hard_block', center: OFFICE });
    const r = evaluateGeofence(OFFICE, 10, [orgFence, branchFence, employeeFence], opts());
    expect(r).toMatchObject({ verdict: 'allowed', winningScope: 'employee', geofenceId: employeeFence.id });
    expect(r.outcomes.filter((o) => o.considered).map((o) => o.fence.id)).toEqual([employeeFence.id]);
    // the employee fence is outside its time window → the branch fence decides
    const closed = { ...employeeFence, timeWindows: [{ days: [6], start: '08:00', end: '18:00' }] };
    expect(evaluateGeofence(OFFICE, 10, [orgFence, branchFence, closed], opts())).toMatchObject({ verdict: 'denied_outside', winningScope: 'branch', geofenceId: branchFence.id });
    const team = fence({ scope: 'team', center: north(5000), enforcement: 'soft_warn' });
    const dept = fence({ scope: 'department', center: OFFICE, enforcement: 'hard_block' });
    expect(evaluateGeofence(OFFICE, 10, [dept, team], opts())).toMatchObject({ verdict: 'flagged', winningScope: 'team' });
  });

  it('worst verdict of the winning scope wins; ties by priority, then distance, then id', () => {
    const near = fence({ scope: 'branch', enforcement: 'hard_block', center: OFFICE });
    const far = fence({ scope: 'branch', enforcement: 'soft_warn', center: north(2000) });
    expect(evaluateGeofence(OFFICE, 10, [near, far], opts())).toMatchObject({ verdict: 'flagged', geofenceId: far.id });
    const allowedA = fence({ scope: 'branch', center: OFFICE, priority: 50 });
    const allowedB = fence({ scope: 'branch', center: OFFICE, priority: 10 });
    expect(evaluateGeofence(OFFICE, 10, [allowedA, allowedB], opts())).toMatchObject({ verdict: 'allowed', geofenceId: allowedB.id });
    const flagNear = fence({ scope: 'org', center: north(400), enforcement: 'soft_warn' });
    const flagFar = fence({ scope: 'org', center: north(900), enforcement: 'soft_warn' });
    expect(evaluateGeofence(OFFICE, 10, [flagFar, flagNear], opts())).toMatchObject({ verdict: 'flagged', geofenceId: flagNear.id });
  });

  it('4-ATT-63/64 the pack\'s decision, kept and documented: the most specific scope decides alone, the worst verdict within it (probe P8)', () => {
    const orgHard = fence({ scope: 'org', enforcement: 'hard_block', center: north(3000) });
    const employeeSoft = fence({ scope: 'employee', enforcement: 'soft_warn', center: OFFICE });
    // far from both: the employee's own (soft) fence decides; the organisation's hard fence is not judged
    expect(evaluateGeofence(north(9000), 10, [orgHard, employeeSoft], opts())).toMatchObject({ verdict: 'flagged', winningScope: 'employee' });
    // inside the employee's fence, outside the organisation's hard one: allowed
    expect(evaluateGeofence(OFFICE, 10, [orgHard, employeeSoft], opts())).toMatchObject({ verdict: 'allowed', winningScope: 'employee' });
    // within the winning scope the worst result decides: one failing fence fails the punch
    const employeeHard = fence({ scope: 'employee', enforcement: 'hard_block', center: north(3000) });
    expect(evaluateGeofence(OFFICE, 10, [employeeSoft, employeeHard], opts())).toMatchObject({ verdict: 'denied_outside', winningScope: 'employee', geofenceId: employeeHard.id });
  });

  it('direction switches: a fence required only on check-in does not judge a check-out', () => {
    const f = fence({ enforcement: 'hard_block', requireOnCheckOut: false });
    expect(evaluateGeofence(north(900), 10, [f], opts({ direction: 'in' }))).toMatchObject({ verdict: 'denied_outside' });
    expect(evaluateGeofence(north(900), 10, [f], opts({ direction: 'out' }))).toMatchObject({ verdict: 'no_fence', reason: 'no_fences_assigned' });
  });

  it('refusal and flag helpers', () => {
    expect(isRefusalVerdict('denied_outside')).toBe(true);
    expect(isRefusalVerdict('denied_mock')).toBe(true);
    expect(isRefusalVerdict('flagged')).toBe(false);
    expect(isFlagVerdict('flagged')).toBe(true);
    expect(isFlagVerdict('logged')).toBe(false);
  });
});

describe('withinGeofenceOf — the B-36 truth table (4-P2-7)', () => {
  it('4-P2-7 true inside, false only when a real fence failed, null otherwise', () => {
    const f = fence({ enforcement: 'soft_warn', accuracyThresholdM: 50 });
    const of = (point: GeofencePoint | null, accuracy: number | null, fences: GeofenceFence[], over: Partial<Parameters<typeof evaluateGeofence>[3]> = {}) => withinGeofenceOf(evaluateGeofence(point, accuracy, fences, opts(over)));
    expect(of(north(10), 10, [f])).toBe(true); // inside
    expect(of(north(300), 10, [f])).toBe(false); // a real fence was evaluated with a location and failed
    expect(of(OFFICE, 5, [f], { isMock: true })).toBe(false); // a mocked location inside a fence check fails it
    expect(of(null, null, [f])).toBeNull(); // no location: cannot say
    expect(of(north(10), 80, [f])).toBeNull(); // fix too imprecise to judge: cannot say
    expect(of(north(300), 10, [])).toBeNull(); // no fence assigned
    expect(of(north(300), 10, [f], { policy: 'off' })).toBeNull(); // geofencing off
    expect(of(OFFICE, 5, [], { isMock: true })).toBeNull(); // mock, but no fence judged it
    // a stored verdict without its reason (older rows): only an outright refusal counts as failed
    expect(withinGeofenceOf({ verdict: 'denied_outside', reason: null })).toBe(false);
    expect(withinGeofenceOf({ verdict: 'flagged', reason: null })).toBeNull();
    expect(withinGeofenceOf({ verdict: null, reason: null })).toBeNull();
  });
});
