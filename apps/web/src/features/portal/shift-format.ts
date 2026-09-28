import type { SelfShiftSummaryDto } from '@flowza/contracts';
import { fmtMinutes } from '@/lib/format';

/** "Office 08:00–17:00" for a fixed shift, "Flexi · 8h 00m" for a flexible one (times are the shift's local times). */
export function shiftLabel(shift: Pick<SelfShiftSummaryDto, 'name' | 'type' | 'startTime' | 'endTime' | 'requiredMinutes'>): string {
  if (shift.type === 'FIXED' && shift.startTime && shift.endTime) return `${shift.name} ${shift.startTime.slice(0, 5)}–${shift.endTime.slice(0, 5)}`;
  return shift.requiredMinutes ? `${shift.name} · ${fmtMinutes(shift.requiredMinutes)}` : shift.name;
}
