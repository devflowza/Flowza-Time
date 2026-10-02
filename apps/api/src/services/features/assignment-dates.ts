import { addDays } from '@flowza/shared';
import { isoDateOrNull } from '../../lib/mappers.js';

/*
 * Shift assignments end on an inclusive LAST DAY wherever a person reads or types the date — the API, the list ("01 Sep → 02 Sep"),
 * the form and "End assignment" (2026-10-02 field report: an assignment 1 Sep → 2 Sep left the 2nd with "No shift", and every
 * assignment "→ 01 Oct" left 1 Oct without one). The table keeps the half-open range `[effective_from, effective_to)` that the
 * engine (`isEffectiveOn`), the exclusion constraint and every query use, so the stored bound is the day AFTER the last day.
 * These two conversions are the only place the two meet.
 */

/** API last day (inclusive) → the stored exclusive bound; null / undefined = open-ended. */
export function assignmentEndToStored(lastDay: string | null | undefined): string | null {
  return lastDay ? addDays(lastDay, 1) : null;
}

/** Stored exclusive bound → the API last day (inclusive); null = open-ended. */
export function assignmentEndFromStored(stored: Date | string | null): string | null {
  const bound = isoDateOrNull(stored);
  return bound ? addDays(bound, -1) : null;
}
