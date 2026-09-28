import type { AttendanceNoteDto } from '@flowza/contracts';

/** Day statuses / flags that ask the employee for a reason (the "needs a reason" nudge; any day may still carry one). */
const ASKING_STATUSES: ReadonlySet<string> = new Set(['ABSENT', 'HALF_DAY', 'MISSING_PUNCH']);
const ASKING_FLAGS: ReadonlySet<string> = new Set(['LATE', 'EARLY_DEPARTURE', 'MISSING_IN', 'MISSING_OUT', 'UNDER_HOURS', 'UNEXCUSED', 'OUTSIDE_GEOFENCE', 'OUT_OF_WINDOW']);
export function needsReason(status: string, flags: readonly string[] | null | undefined): boolean {
  return ASKING_STATUSES.has(status) || (flags ?? []).some((f) => ASKING_FLAGS.has(f));
}

/**
 * The note that speaks for each day: the active one (anything but rejected — the API keeps one active note per day), else
 * the most recent rejected one so the decision stays visible.
 */
export function activeNotesByDate(notes: readonly AttendanceNoteDto[]): Map<string, AttendanceNoteDto> {
  const out = new Map<string, AttendanceNoteDto>();
  for (const n of notes) {
    const current = out.get(n.attendanceDate);
    if (!current) { out.set(n.attendanceDate, n); continue; }
    const currentActive = current.status !== 'rejected';
    const active = n.status !== 'rejected';
    if (active && !currentActive) out.set(n.attendanceDate, n);
    else if (active === currentActive && n.submittedAt > current.submittedAt) out.set(n.attendanceDate, n);
  }
  return out;
}
