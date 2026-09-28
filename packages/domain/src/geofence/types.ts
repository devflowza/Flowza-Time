/** Geofence evaluation types (mirror the enums of @flowza/contracts; the domain package stays free of IO). */
export type GeofenceScopeSpec = 'org' | 'branch' | 'department' | 'team' | 'employee';
export type GeofenceEnforcementSpec = 'hard_block' | 'soft_warn' | 'advisory_log';
export type GeofenceVerdictSpec = 'no_fence' | 'allowed' | 'flagged' | 'logged' | 'denied_outside' | 'denied_mock';

export interface GeofencePoint { lat: number; lng: number }

/** One (fence, assignment) pair that targets the employee: the fence geometry and rules plus the assignment's scope and switches. */
export interface GeofenceFence {
  id: string;
  name: string;
  center: GeofencePoint;
  radiusM: number;
  /** Optional polygon; when present it is the shape (the circle remains the nearest-zone anchor). */
  polygon: GeofencePoint[] | null;
  enforcement: GeofenceEnforcementSpec;
  accuracyThresholdM: number;
  graceM: number;
  /** Local dates (inclusive), null = open. */
  activeFrom: string | null;
  activeTo: string | null;
  /** Weekly windows (ISO weekdays 1 = Monday … 7 = Sunday, local HH:mm); empty / null = always. */
  timeWindows: Array<{ days: number[]; start: string; end: string }> | null;
  isActive: boolean;
  scope: GeofenceScopeSpec;
  /** Lower = higher priority (ties inside the winning scope). */
  priority: number;
  requireOnCheckIn: boolean;
  requireOnCheckOut: boolean;
}

/** The evaluation instant in the employee's branch timezone. */
export interface GeofenceWhen { date: string; minuteOfDay: number; isoWeekday: number }

export interface FenceOutcome {
  fence: GeofenceFence;
  applicable: boolean;
  inactiveReason: string | null;
  /** Belongs to the winning scope and was judged. */
  considered: boolean;
  distanceM: number | null;
  verdict: GeofenceVerdictSpec | null;
  reason: string | null;
}

export interface GeofenceEvaluation {
  verdict: GeofenceVerdictSpec;
  reason: string;
  geofenceId: string | null;
  geofenceName: string | null;
  distanceM: number | null;
  scope: GeofenceScopeSpec | null;
  enforcement: GeofenceEnforcementSpec | null;
  winningScope: GeofenceScopeSpec | null;
  outcomes: FenceOutcome[];
}
