import type { AttendanceSettings } from '@flowza/contracts';

export type PayEffect = 0 | 0.5 | 1;
type UnexcusedDefaults = Pick<AttendanceSettings['unexcused'], 'payEffectAbsent' | 'payEffectLate' | 'payEffectMissingPunch'>;
const FALLBACK: UnexcusedDefaults = { payEffectAbsent: 1, payEffectLate: 0.5, payEffectMissingPunch: 0.5 };

/**
 * The pay effect a rejection proposes by default: the organisation's unexcused-day defaults for the kind of day (absent → a
 * full day, late / missing punch → half by default), nothing for a day the engine found in order. The reviewer can change it.
 */
export function defaultPayEffect(dayStatus: string | null, dayFlags: readonly string[], settings?: Partial<UnexcusedDefaults> | null): PayEffect {
  const s = { ...FALLBACK, ...(settings ?? {}) };
  if (dayStatus === 'ABSENT') return s.payEffectAbsent;
  if (dayStatus === 'MISSING_PUNCH' || dayFlags.includes('MISSING_IN') || dayFlags.includes('MISSING_OUT')) return s.payEffectMissingPunch;
  if (dayFlags.includes('LATE') || dayStatus === 'HALF_DAY') return s.payEffectLate;
  return 0;
}

export const PAY_EFFECTS: readonly PayEffect[] = [0, 0.5, 1];
export const payEffectKey = (p: PayEffect): 'none' | 'half' | 'full' => (p === 0 ? 'none' : p === 0.5 ? 'half' : 'full');
