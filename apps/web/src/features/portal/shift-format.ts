import type { TFunction } from 'i18next';
import type { SelfShiftDayDto, SelfShiftSummaryDto } from '@flowza/contracts';
import { fmtMinutes } from '@/lib/format';

/** "Office 08:00–17:00" for a fixed shift, "Flexi · 8h 00m" for a flexible one (times are the shift's local times). */
export function shiftLabel(shift: Pick<SelfShiftSummaryDto, 'name' | 'type' | 'startTime' | 'endTime' | 'requiredMinutes'>): string {
  if (shift.type === 'FIXED' && shift.startTime && shift.endTime) return `${shift.name} ${shift.startTime.slice(0, 5)}–${shift.endTime.slice(0, 5)}`;
  return shift.requiredMinutes ? `${shift.name} · ${fmtMinutes(shift.requiredMinutes)}` : shift.name;
}

/** What one day of the schedule holds: leave, a holiday, a day off, the shift, or no shift (the shift tab and the check-in page). `t` is the portal-attendance namespace. */
export function dayShiftText(d: Pick<SelfShiftDayDto, 'shift' | 'isOff' | 'holidayName' | 'onLeave'>, t: TFunction): string {
  if (d.onLeave) return t('shift.onLeave');
  if (d.holidayName) return t('shift.holiday', { name: d.holidayName });
  if (d.isOff) return t('shift.off');
  return d.shift ? shiftLabel(d.shift) : t('shift.noShift');
}

/** Days a swap can be asked for: working days with a shift, not on leave or a holiday, not already covered by a swap. */
export const swappableDays = (days: readonly SelfShiftDayDto[]): SelfShiftDayDto[] => days.filter((d) => d.shift && !d.isOff && !d.onLeave && !d.holidayName && !d.swap);
