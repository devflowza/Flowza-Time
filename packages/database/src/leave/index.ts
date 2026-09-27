/** Leave v2 primitives shared by the API and the worker (HR portal Prompt 7): type policies, calendars, balances, comp-off. */
export * from './balances.js';
export * from './comp-off.js';

/** Worker job: close a leave year — carry forward into next year's allocation rows (payload `{ organizationId, fromYear }`). */
export const LEAVE_YEAR_CLOSE_JOB_TYPE = 'LEAVE_YEAR_CLOSE';
/** Worker job: expire comp-off credits past their expiry date (payload `{ organizationId, asOf? }`). */
export const LEAVE_COMP_OFF_EXPIRY_JOB_TYPE = 'LEAVE_COMP_OFF_EXPIRY';
/** One pending year close per organisation and year (the queue dedupes pending jobs by key). */
export const leaveYearCloseDedupeKey = (organizationId: string, fromYear: number): string => `leave-year-close:${organizationId}:${fromYear}`;
export const leaveCompOffExpiryDedupeKey = (organizationId: string, asOf: string): string => `leave-comp-off-expiry:${organizationId}:${asOf}`;
