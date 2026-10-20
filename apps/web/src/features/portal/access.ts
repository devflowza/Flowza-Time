import type { Permission } from '@flowza/contracts';
import { useCan, useModuleEnabled } from '@/features/me/use-me';

/**
 * What the caller may open about their own employee record in the self-service portal: the keys each /orgs/:orgId/me/…
 * endpoint admits (apps/api services/self-service, services/portal/*, services/leave/self-leave, reports.listMyReports).
 * The menu, the routes and the tabs offer only what the API will answer, so a role without a key sees no entry — and a
 * "permission denied" page when it follows a link — instead of a screen that fails on a 403. The API stays the authority.
 */
export interface PortalAccess {
  /** Own daily records, calendar, statistics (attendance.view_own or attendance.view). */
  attendance: boolean;
  /** Own attendance reasons (attendance.note or attendance.view_own). */
  notes: boolean;
  /** Give or edit a reason (attendance.note). */
  addNote: boolean;
  /** Own regularisation requests (attendance.note, attendance.request_correction or attendance.view_own). */
  regularisations: boolean;
  /** File a regularisation (attendance.note or attendance.request_correction). */
  requestRegularisation: boolean;
  /** Web check-in and own selfie check-ins (attendance.checkin). */
  checkin: boolean;
  /** Own shift, upcoming days and swaps (attendance.view_own, attendance.view or shift.request_swap). */
  shift: boolean;
  /** Ask a colleague for a swap (shift.request_swap). */
  requestSwap: boolean;
  /** Own shift change requests (shift.request_change or attendance.view_own). */
  shiftChanges: boolean;
  /** Ask for another or an additional shift (shift.request_change). */
  requestShiftChange: boolean;
  /** Own leave and balances (leave.request or leave.view). */
  leave: boolean;
  /** Apply for leave (leave.request). */
  requestLeave: boolean;
  /** Reports about oneself that HR or a manager shared (attendance.view_own: only that key gets self-scoped copies). */
  reports: boolean;
  /** My requests: at least one of its tabs. */
  requests: boolean;
}

export function usePortalAccess(): PortalAccess {
  const can = useCan();
  const any = (...keys: Permission[]) => keys.some((k) => can(k));
  const swapsOn = useModuleEnabled('shift_requests');
  const notes = any('attendance.note', 'attendance.view_own');
  const regularisations = any('attendance.note', 'attendance.request_correction', 'attendance.view_own');
  const checkin = can('attendance.checkin');
  const shift = any('attendance.view_own', 'attendance.view', 'shift.request_swap');
  return {
    attendance: any('attendance.view_own', 'attendance.view'),
    notes,
    addNote: can('attendance.note'),
    regularisations,
    requestRegularisation: any('attendance.note', 'attendance.request_correction'),
    checkin,
    shift,
    requestSwap: can('shift.request_swap'),
    shiftChanges: any('shift.request_change', 'attendance.view_own'),
    requestShiftChange: can('shift.request_change'),
    leave: any('leave.request', 'leave.view'),
    requestLeave: can('leave.request'),
    reports: can('attendance.view_own'),
    requests: notes || regularisations || checkin || (swapsOn && shift),
  };
}

/** The portal pages a route or a menu entry stands for, by the access flag that opens them. */
export type PortalPage = 'attendance' | 'leave' | 'checkin' | 'requests' | 'shift' | 'reports';
