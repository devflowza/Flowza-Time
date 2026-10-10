/*
 * What still uses a location when the server refuses to archive it (409 CONFLICT, docs/locations.md §1: "archiving refuses
 * while it has active children or is used by an active device, employee or geofence"). The API reports the counts in the
 * error's `details` — `{ children: 2, devices: 1 }`, possibly nested under `inUse`; the names below are the ones it uses and
 * their obvious variants, so the screen can say it in the reader's language instead of quoting the server's English. Pure.
 */

export const IN_USE_KINDS = ['children', 'employees', 'devices', 'geofences', 'coverage', 'policies'] as const;
export type InUseKind = (typeof IN_USE_KINDS)[number];

const ALIASES = new Map<string, InUseKind>([
  ['children', 'children'], ['activeChildren', 'children'], ['childLocations', 'children'], ['childCount', 'children'],
  ['employees', 'employees'], ['activeEmployees', 'employees'], ['employeeCount', 'employees'],
  ['devices', 'devices'], ['activeDevices', 'devices'], ['deviceCount', 'devices'],
  ['geofences', 'geofences'], ['fences', 'geofences'], ['activeGeofences', 'geofences'], ['geofenceCount', 'geofences'],
  ['coverage', 'coverage'], ['coverageTargets', 'coverage'], ['coverageRequirements', 'coverage'],
  ['policies', 'policies'], ['ruleSets', 'policies'], ['attendancePolicies', 'policies'],
]);

/** The non-zero counts of what still uses the location, in a fixed order; empty when the details carry none. */
export function inUseCounts(details: Record<string, unknown> | null | undefined): Array<{ kind: InUseKind; count: number }> {
  if (!details) return [];
  const nested = details['inUse'];
  const source = nested && typeof nested === 'object' && !Array.isArray(nested) ? { ...details, ...(nested as Record<string, unknown>) } : details;
  const totals = new Map<InUseKind, number>();
  for (const [key, value] of Object.entries(source)) {
    const kind = ALIASES.get(key);
    const count = typeof value === 'number' ? value : Array.isArray(value) ? value.length : Number.NaN;
    if (kind && Number.isFinite(count) && count > 0) totals.set(kind, Math.max(totals.get(kind) ?? 0, count));
  }
  return IN_USE_KINDS.filter((k) => totals.has(k)).map((kind) => ({ kind, count: totals.get(kind)! }));
}
