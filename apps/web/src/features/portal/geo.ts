import type { SelfGeofenceDto } from '@flowza/contracts';

/** One location fix from the browser (the server evaluates the geofences; this only feeds it and previews the nearest zone). */
export interface GeoFix { lat: number; lng: number; accuracy: number; at: number }
export type GeoFailureKind = 'denied' | 'unavailable' | 'timeout' | 'unsupported';
export class GeoFailure extends Error {
  constructor(readonly kind: GeoFailureKind) { super(`geolocation ${kind}`); this.name = 'GeoFailure'; }
}

/** High-accuracy fix with a timeout; rejects with a GeoFailure whose kind names the reason (denied / unavailable / timeout). */
export function getCurrentFix(timeoutMs = 15_000): Promise<GeoFix> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.reject(new GeoFailure('unsupported'));
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.max(1, Math.round(pos.coords.accuracy)), at: pos.timestamp }),
      (err) => reject(new GeoFailure(err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable')),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10_000 },
    );
  });
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;
/** Great-circle distance in metres (the same haversine the server's domain evaluator uses). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The closest fence to a fix and how far its edge is (0 inside the circle). Circle only: the server judges polygons. */
export function nearestFence(fix: { lat: number; lng: number }, fences: readonly SelfGeofenceDto[]): { fence: SelfGeofenceDto; edgeDistanceM: number } | null {
  let best: { fence: SelfGeofenceDto; edgeDistanceM: number } | null = null;
  for (const fence of fences) {
    const edge = Math.max(0, distanceMeters(fix, { lat: fence.latitude, lng: fence.longitude }) - fence.radiusM);
    if (!best || edge < best.edgeDistanceM) best = { fence, edgeDistanceM: edge };
  }
  return best;
}

/** "85 m" / "1.2 km" */
export function fmtDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}
