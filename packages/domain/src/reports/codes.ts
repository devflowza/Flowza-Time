import type { AttendanceStatus } from '@flowza/contracts';

/**
 * How a day is classified for the totals the samples print. `present` feeds T/PR, `leave` feeds T/OL, `absent`
 * feeds T/AB; `off` and `holiday` are shown but counted with present days (a paid day), `none` is not a working day
 * of this employee (not joined, exited, still pending).
 */
export type CodeGroup = 'present' | 'off' | 'holiday' | 'leave' | 'absent' | 'none';

export interface AttendanceCode { code: string; group: CodeGroup }

export interface CodeInput {
  status: AttendanceStatus | string;
  flags: readonly string[];
  /** `leave_types.code` of the approved leave covering the day (LEAVE and half-day-leave records). */
  leaveTypeCode?: string | null;
  /** `leave_types.treat_as_present`: site duty and similar count as a paid present day. */
  leaveTreatAsPresent?: boolean | null;
  /** `leave_types.is_paid`: unpaid leave (no-pay) counts with absences in the samples' totals. */
  leaveIsPaid?: boolean | null;
}

/**
 * Codes for statuses that are not leave. Leave takes the tenant's own leave-type code (AL, SL, CL …), which is why the
 * LEAVE entry here is only the fallback for a record whose leave row can no longer be found. Overridable per tenant
 * through `settings.reports.codeOverrides` (keys are these status names plus HALF_DAY_LEAVE).
 */
export const DEFAULT_STATUS_CODES: Readonly<Record<AttendanceStatus, string>> = {
  PRESENT: 'PR', ABSENT: 'AB', LEAVE: 'LV', HOLIDAY: 'HL', WEEKLY_OFF: 'OF', HALF_DAY: 'HDP', MISSING_PUNCH: 'PR', NOT_JOINED: '', EXITED: '', PENDING: '',
};
export const DEFAULT_HALF_DAY_LEAVE_CODE = 'HDL';

const GROUP_OF_STATUS: Readonly<Record<AttendanceStatus, CodeGroup>> = {
  PRESENT: 'present', ABSENT: 'absent', LEAVE: 'leave', HOLIDAY: 'holiday', WEEKLY_OFF: 'off', HALF_DAY: 'present', MISSING_PUNCH: 'present', NOT_JOINED: 'none', EXITED: 'none', PENDING: 'none',
};

export type CodeOverrides = Readonly<Partial<Record<AttendanceStatus | 'HALF_DAY_LEAVE', string>>>;

/** The two-letter code and totals group for one daily record. */
export function resolveAttendanceCode(input: CodeInput, overrides: CodeOverrides = {}): AttendanceCode {
  const status = input.status as AttendanceStatus;
  const pick = (key: AttendanceStatus | 'HALF_DAY_LEAVE', fallback: string): string => {
    const o = overrides[key];
    return typeof o === 'string' && o.trim() ? o.trim() : fallback;
  };
  if (status === 'LEAVE') {
    const code = input.leaveTypeCode?.trim() || pick('LEAVE', DEFAULT_STATUS_CODES.LEAVE);
    const group: CodeGroup = input.leaveTreatAsPresent ? 'present' : input.leaveIsPaid === false ? 'absent' : 'leave';
    return { code, group };
  }
  if (input.flags.includes('HALF_DAY_LEAVE') && (status === 'HALF_DAY' || status === 'PRESENT' || status === 'MISSING_PUNCH')) {
    return { code: pick('HALF_DAY_LEAVE', DEFAULT_HALF_DAY_LEAVE_CODE), group: 'leave' };
  }
  const code = pick(status, DEFAULT_STATUS_CODES[status] ?? '');
  return { code, group: GROUP_OF_STATUS[status] ?? 'none' };
}

export interface LeaveTypeLike { code: string; name: string; nameAr?: string | null; isPaid: boolean; treatAsPresent?: boolean | null }

export interface LegendItem { code: string; labelKey: string | null; label: string | null }

/**
 * The legend printed under every attendance report, in the samples' order: presence codes, then the tenant's leave
 * types, then the half-day codes. Status labels are resolved by the caller (they are localised); leave types carry
 * their own names.
 */
export function legendItems(leaveTypes: readonly LeaveTypeLike[], locale: 'en' | 'ar', overrides: CodeOverrides = {}): LegendItem[] {
  const status = (key: AttendanceStatus, labelKey: string): LegendItem => ({ code: resolveAttendanceCode({ status: key, flags: [] }, overrides).code, labelKey, label: null });
  const items: LegendItem[] = [status('PRESENT', 'code.PRESENT'), status('ABSENT', 'code.ABSENT'), status('WEEKLY_OFF', 'code.WEEKLY_OFF'), status('HOLIDAY', 'code.HOLIDAY')];
  for (const lt of leaveTypes) items.push({ code: lt.code, labelKey: null, label: (locale === 'ar' && lt.nameAr) || lt.name });
  items.push(status('HALF_DAY', 'code.HALF_DAY'));
  items.push({ code: resolveAttendanceCode({ status: 'HALF_DAY', flags: ['HALF_DAY_LEAVE'] }, overrides).code, labelKey: 'code.HALF_DAY_LEAVE', label: null });
  // a tenant may leave a status without a code; those have nothing to explain
  return items.filter((i) => i.code !== '');
}
