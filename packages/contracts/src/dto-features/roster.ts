import { z } from 'zod';
import type { SelfShiftSummaryDto } from '../dto/portal-attendance.js';
import { paginationQuerySchema, uuidSchema } from '../common.js';

/**
 * The monthly shift roster (HR portal Prompt 6b, Finance ATT-105): every employee in the caller's branch scope over one month,
 * a cell per day with the shift the ENGINE resolves (most specific assignment, rotation pattern, else the organisation's default
 * shift), "Off" on weekly off / pattern off days, the holiday and approved leave. Read-only; shift.view.
 */
export const shiftRosterQuerySchema = paginationQuerySchema.extend({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ShiftRosterQuery = z.infer<typeof shiftRosterQuerySchema>;

export type RosterDaySource = 'ASSIGNMENT' | 'PATTERN' | 'DEFAULT' | 'NONE';
export interface RosterDayDto {
  /** The shift of the day (null on a pattern off day or when nothing resolves). */
  shiftId: string | null;
  source: RosterDaySource;
  /** Weekly off (employee → branch → organisation) or a rotation pattern off day. */
  isOff: boolean;
  holidayName: string | null;
  onLeave: boolean;
}
export interface RosterRowDto {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  branchId: string;
  branchName: string | null;
  departmentName: string | null;
  /** Keyed by ISO date; days outside the employment (before joining, after exit) are absent. */
  days: Record<string, RosterDayDto>;
}
export interface ShiftRosterDto {
  month: string;
  from: string;
  to: string;
  dates: string[];
  /** The shifts the page uses (the legend): code, name, colour, times. */
  shifts: SelfShiftSummaryDto[];
  rows: RosterRowDto[];
}
