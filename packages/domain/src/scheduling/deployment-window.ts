import { DateTime } from 'luxon';
import { addDays, isValidTimezone } from '@flowza/shared';

/*
 * The time window of a temporary branch deployment (Enterprise, `employee_branch_deployments`, docs/enterprise/plan.md §4.7),
 * always judged in the HOST branch's timezone — the place the employee works at:
 *
 *   before          host date < fromDate: nothing yet (no host fences, no host terminals: the enrolment waits for the first day);
 *   active          fromDate ≤ host date ≤ toDate: host fences accepted, terminals enrolled;
 *   checkout_grace  host date = toDate + 1 before 12:00 host time: the host fences are still accepted — a night shift that
 *                   starts on the last day (22:00 → 06:00) checks out the next morning;
 *   after           anything later. The host terminals are taken away by the daily sweep once the host date is ≥ toDate + 2
 *                   (`deploymentAccessExpired`): the whole morning-after stays covered, whatever hour the sweep runs at.
 *
 * Pure (no IO): the API's punch service and the shared clean-up (packages/database) both decide with these functions.
 */

/** Host local hour (exclusive) until which the day after the last day still accepts the host fences. */
export const DEPLOYMENT_CHECKOUT_GRACE_UNTIL_HOUR = 12;

export type DeploymentCoverage = 'before' | 'active' | 'checkout_grace' | 'after';

export interface DeploymentRange { fromDate: string; toDate: string }
export interface HostLocalTime { date: string; minuteOfDay: number }

/** The host branch's local date and minute of the day at an instant (UTC for an unknown zone). */
export function hostLocalTime(at: Date, zone: string | null | undefined): HostLocalTime {
  const dt = DateTime.fromJSDate(at, { zone: 'utc' }).setZone(zone && isValidTimezone(zone) ? zone : 'UTC');
  return { date: dt.toISODate() ?? at.toISOString().slice(0, 10), minuteOfDay: dt.hour * 60 + dt.minute };
}

/** Where `hostLocal` falls in the deployment's window (see the module comment). */
export function deploymentCoverageAt(range: DeploymentRange, hostLocal: HostLocalTime): DeploymentCoverage {
  if (hostLocal.date < range.fromDate) return 'before';
  if (hostLocal.date <= range.toDate) return 'active';
  if (hostLocal.date === addDays(range.toDate, 1) && hostLocal.minuteOfDay < DEPLOYMENT_CHECKOUT_GRACE_UNTIL_HOUR * 60) return 'checkout_grace';
  return 'after';
}

/** The host fences judge a punch at this time (active, or the morning after the last day). */
export const deploymentAcceptsHostFences = (range: DeploymentRange, hostLocal: HostLocalTime): boolean => {
  const c = deploymentCoverageAt(range, hostLocal);
  return c === 'active' || c === 'checkout_grace';
};

/** The deployment's days have begun at the host and not ended: the enrolment on the host terminals may run. */
export const deploymentStarted = (range: DeploymentRange, hostToday: string): boolean => range.fromDate <= hostToday && hostToday <= range.toDate;

/**
 * The host terminals must go: the host's local date is at least toDate + 2 (`toDate + 1 < hostToday`). Until then the
 * deployment still owns them (the morning-after check-out of a night shift on the last day).
 */
export const deploymentAccessExpired = (toDate: string, hostToday: string): boolean => addDays(toDate, 1) < hostToday;
