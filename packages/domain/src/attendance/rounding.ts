import type { DateTime } from 'luxon';
import type { RoundingMode } from '@flowza/contracts';

/**
 * Round `value` (minutes) to a multiple of `interval` (§G.5). `interval <= 0` or mode `NONE` returns
 * the value unchanged. Negative values round symmetrically (`-7` UP at 5 → `-5`, DOWN → `-10`).
 */
export function roundMinutes(value: number, interval: number, mode: RoundingMode): number {
  if (mode === 'NONE' || interval <= 0 || !Number.isFinite(value)) return value;
  const ratio = value / interval;
  switch (mode) {
    case 'NEAREST':
      return Math.round(ratio) * interval;
    case 'UP':
      return Math.ceil(ratio) * interval;
    case 'DOWN':
      return Math.floor(ratio) * interval;
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/**
 * Round an instant to `interval` minutes measured from local midnight in the DateTime's own zone, so
 * zones with non-hour offsets (e.g. +05:45) still round to wall-clock boundaries. Seconds are folded
 * into the fractional minute before rounding (10:07:30 NEAREST 15 → 10:15; DOWN → 10:00).
 */
export function roundInstant(instant: DateTime, interval: number, mode: RoundingMode): DateTime {
  if (mode === 'NONE' || interval <= 0) return instant;
  const midnight = instant.startOf('day');
  const minutes = instant.diff(midnight, 'minutes').minutes;
  const rounded = roundMinutes(minutes, interval, mode);
  return midnight.plus({ minutes: rounded });
}

export interface RoundedPunches {
  firstIn: DateTime | null;
  lastOut: DateTime | null;
  changed: boolean;
}

/**
 * Apply the configured punch rounding to the IN and OUT instants. The same mode is applied literally to
 * both timestamps (UP moves both later, DOWN both earlier); raw values must be kept by the caller's trace.
 */
export function roundPunches(firstIn: DateTime | null, lastOut: DateTime | null, interval: number, mode: RoundingMode): RoundedPunches {
  const rIn = firstIn ? roundInstant(firstIn, interval, mode) : null;
  const rOut = lastOut ? roundInstant(lastOut, interval, mode) : null;
  const changed = (firstIn !== null && rIn !== null && !rIn.equals(firstIn)) || (lastOut !== null && rOut !== null && !rOut.equals(lastOut));
  return { firstIn: rIn, lastOut: rOut, changed };
}
