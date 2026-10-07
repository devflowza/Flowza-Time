import type { AttendancePolicySections } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { AppError, addDays } from '@flowza/shared';
import { withSystemScope } from '../../lib/service.js';
import { policiesOn, type EmployeePolicy } from './placement.js';

/*
 * The self-service consumers of the attendance policy sections (Enterprise, attendance_policies — @flowza/contracts
 * attendancePolicySectionsSchema): `methods` (web / mobile / selfie check-in and the geofence requirement) for the check-in
 * endpoints, `regularisation` (monthly limit, how far back) for the self-service regularisation endpoint.
 *
 * Those endpoints call these helpers AFTER their own organisation-switch checks: a policy only ever NARROWS what the
 * organisation allows (a method the organisation switched off stays off whatever the policy says). Stored policies keep
 * applying when the module is switched off (docs/enterprise/plan.md §11.3: a downgrade never silently changes the rules).
 * The policy is resolved exactly as the engine resolves it, in the organisation's system scope — the caller is the employee,
 * who cannot read the rule sets.
 */

export type CheckInMethod = 'web' | 'mobile' | 'selfie';
export type GeofenceRequirement = 'off' | 'flag' | 'block';
/** `details.reason` of a check-in refused by the policy. */
export const CHECKIN_METHOD_NOT_ALLOWED = 'CHECKIN_METHOD_NOT_ALLOWED';
/** `details.reason` of a regularisation refused by the policy's limits. */
export const REGULARISATION_MONTHLY_LIMIT = 'REGULARISATION_MONTHLY_LIMIT';
export const REGULARISATION_TOO_OLD = 'REGULARISATION_TOO_OLD';

/** The policy that governs the employee on `date` (null = the employee has no placement on the date: the defaults apply). */
export async function employeePolicyOn(trx: Trx, orgId: string, employeeId: string, date: string): Promise<EmployeePolicy | null> {
  return withSystemScope(trx, orgId, async (t) => (await policiesOn(t, orgId, [employeeId], date)).get(employeeId) ?? null);
}

/** null = the policy allows the method; otherwise the 403 to throw. */
export function checkInMethodRefusal(sections: Pick<AttendancePolicySections, 'methods'>, method: CheckInMethod): AppError | null {
  if (sections.methods[method]) return null;
  return new AppError('FORBIDDEN', `Your attendance policy does not allow ${method} check-in.`, { details: { reason: CHECKIN_METHOD_NOT_ALLOWED, method } });
}

/** The geofence requirement of a self-service check-in: the policy's override, or the organisation setting for `inherit`. */
export function effectiveGeofenceRequirement(sections: Pick<AttendancePolicySections, 'methods'>, organisation: GeofenceRequirement): GeofenceRequirement {
  const own = sections.methods.requireGeofence;
  return own === 'inherit' ? organisation : own;
}

/**
 * null = the policy's limits allow a regularisation of `date` filed on `today`; otherwise the 400 to throw.
 * `requestsInMonth` = the employee's regularisation requests (pending or approved) for days of the calendar month of `date`.
 */
export function regularisationRefusal(sections: Pick<AttendancePolicySections, 'regularisation'>, request: { date: string; today: string; requestsInMonth: number }): AppError | null {
  const limits = sections.regularisation;
  if (limits.backdateDays !== null && request.date < addDays(request.today, -limits.backdateDays)) {
    return new AppError('VALIDATION_ERROR', `Your attendance policy allows regularising the last ${limits.backdateDays} days only.`, { details: { reason: REGULARISATION_TOO_OLD, backdateDays: limits.backdateDays } });
  }
  if (limits.maxPerMonth !== null && request.requestsInMonth >= limits.maxPerMonth) {
    return new AppError('VALIDATION_ERROR', `Your attendance policy allows ${limits.maxPerMonth} regularisation requests a month.`, { details: { reason: REGULARISATION_MONTHLY_LIMIT, maxPerMonth: limits.maxPerMonth } });
  }
  return null;
}
