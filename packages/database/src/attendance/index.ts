/** Attendance write primitives shared by the API and the worker (HR portal Prompt 3): recompute queueing, day marks, the pay-effect charger. */
export * from './recompute-queue.js';
export * from './day-marks.js';
export * from './pay-effect.js';
// The engine's daily input loader, shared by the worker's recompute and the API's record preview (HR portal Prompt 6a).
export * from './load-inputs.js';
// Attendance policy resolution (Enterprise: scoped policies, employee groups) and the additional (double) shift loader.
export * from './policy.js';
// The policy scope's location chain of many employees at once (docs/locations.md §3; the batched form of loadPolicyScope's).
export * from './location-chains.js';
// THE per-date working calendar, shared by the loader above, leave day counting, balances and the comp-off preview (leave v2 review P1-1 / P1-2).
export { historyRowOn, loadEmployeeWorkingCalendars, type CalendarBranch, type DayPlacement, type EmployeeWorkingCalendar, type WorkingCalendarContext, type WorkingDay } from './working-calendar.js';
export * from './self-service-device.js';
// The monthly summary figures, shared by the API's summary page / month strip and the worker's monthly_summary report (Prompt 6a review).
export * from './summary.js';
