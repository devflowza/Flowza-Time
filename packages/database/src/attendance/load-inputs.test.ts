import { describe, expect, it } from 'vitest';
import { punchPayloadOf } from './load-inputs.js';

/** HR portal Prompt 4 review, P2-7: the engine gets the B-36 tri-state and the verdict's reason, never anything else of a raw payload. */
describe('punchPayloadOf', () => {
  it('4-P2-7 passes the geofence tri-state (an explicit null included) and the verdict reason to the engine', () => {
    expect(punchPayloadOf({ channel: 'mobile', verdict: 'flagged', verdictReason: 'location_missing', withinGeofence: null })).toEqual({ channel: 'mobile', geofenceVerdict: 'flagged', geofenceReason: 'location_missing', withinGeofence: null });
    expect(punchPayloadOf({ channel: 'web', verdict: 'flagged', verdictReason: 'outside', withinGeofence: false, isMock: false })).toEqual({ channel: 'web', geofenceVerdict: 'flagged', geofenceReason: 'outside', withinGeofence: false });
    expect(punchPayloadOf({ channel: 'web', verdict: 'allowed', verdictReason: 'inside', withinGeofence: true })).toMatchObject({ withinGeofence: true });
    // a payload written before the fix: no tri-state key at all (the engine falls back to verdict + reason)
    expect(punchPayloadOf({ channel: 'web', verdict: 'no_fence', verdictReason: 'no_fences_assigned', isMock: true })).toEqual({ channel: 'web', geofenceVerdict: 'no_fence', geofenceReason: 'no_fences_assigned', isMock: true });
    // anything that is not a boolean / null is ignored, and so are over-long strings
    expect(punchPayloadOf({ withinGeofence: 'yes', verdictReason: 'x'.repeat(41) })).toBeNull();
  });
});
