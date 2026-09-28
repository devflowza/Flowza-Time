import type { AttendanceStatus, SelfOverviewDto, SelfStatsDto } from '@flowza/contracts';
import { computeSelfStats, punctualityWindows, selfStatsRange, type SelfStatsDay } from '@flowza/domain';
import { addDays } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { hasPermission, requireMembership } from '../../lib/authorize.js';
import { type Actor, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateTimeOrNull } from '../../lib/mappers.js';
import { toCount } from '../../lib/pagination.js';
import { dv } from '../features/sql-helpers.js';
import { attendancePolicy, loadEmployeeCtx, localInstant, portalSelf } from './common.js';

/**
 * The employee's own statistics (HR portal Prompt 4, `computeSelfStats` in packages/domain): attendance % against the
 * organisation's target, average hours, late / absent / missing-check-out counts with improvement hints, and punctuality
 * over the last 7 days, this month and last month — from the engine's daily records, read under the caller's own RLS.
 */
export async function getMyStats(deps: ApiDeps, actor: Actor, orgId: string, q: { range: '30d' | 'month' | 'year' }): Promise<SelfStatsDto> {
  const self = portalSelf(actor, orgId, 'attendance.view_own', 'attendance.view');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const today = localInstant(new Date(), emp.timezone).date;
    const range = selfStatsRange(q.range, today);
    const windows = punctualityWindows(today);
    const readFrom = [range.from, windows.lastMonth[0], addDays(today, -6)].sort()[0]!;
    const rows = await trx.selectFrom('attendanceDailyRecords').select(['attendanceDate', 'status', 'flags', 'workedMinutes', 'lateMinutes', 'firstInAt', 'expectedStartAt'])
      .where('organizationId', '=', orgId).where('employeeId', '=', self.employeeId).where('attendanceDate', '>=', dv(readFrom)).where('attendanceDate', '<=', dv(today))
      .orderBy('attendanceDate', 'asc').execute();
    const days: SelfStatsDay[] = rows.map((r) => ({ date: isoDate(r.attendanceDate), status: r.status as AttendanceStatus, flags: (r.flags ?? []) as string[], workedMinutes: Number(r.workedMinutes ?? 0), lateMinutes: Number(r.lateMinutes ?? 0), firstInAt: isoDateTimeOrNull(r.firstInAt), expectedStartAt: isoDateTimeOrNull(r.expectedStartAt) }));
    const targets = (await attendancePolicy(trx, orgId)).stats;
    const s = computeSelfStats(days, { attendanceTargetPct: targets.attendanceTargetPct, fullDayHours: targets.fullDayHours }, { from: range.from, to: range.to, today });
    return { range: q.range, ...s };
  });
}

/**
 * What the portal home adds to the overview (HR portal Prompt 4): today's punch state and the caller's open items (reasons
 * waiting for review or for an answer, regularisations, swaps). Optional fields of `SelfOverviewDto`, merged by the route.
 */
export async function portalOverviewExtras(deps: ApiDeps, actor: Actor, orgId: string): Promise<Pick<SelfOverviewDto, 'punch' | 'pendingNotes' | 'infoRequestedNotes' | 'pendingRegularisations' | 'pendingSwaps'>> {
  const grant = requireMembership(actor.principal, orgId);
  const employeeId = grant.employeeId;
  if (!employeeId) return {};
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeCtx(trx, orgId, employeeId);
    return withSystemScope(trx, orgId, async (t) => {
      const count = async (q: { execute(): Promise<Array<{ n: string | number | bigint }>> }) => toCount((await q.execute())[0]?.n);
      const notes = await t.selectFrom('attendanceNotes').select(['status', (eb) => eb.fn.countAll<string>().as('n')]).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('status', 'in', ['pending', 'info_requested']).groupBy('status').execute();
      const pendingRegularisations = await count(t.selectFrom('attendanceRegularisationRequests').select((eb) => eb.fn.countAll<string>().as('n')).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('status', '=', 'pending'));
      const pendingSwaps = await count(t.selectFrom('shiftSwapRequests').select((eb) => eb.fn.countAll<string>().as('n')).where('organizationId', '=', orgId).where('status', '=', 'pending')
        .where((eb) => eb.or([eb('requesterEmployeeId', '=', employeeId), eb('targetEmployeeId', '=', employeeId)])));
      const out: Pick<SelfOverviewDto, 'punch' | 'pendingNotes' | 'infoRequestedNotes' | 'pendingRegularisations' | 'pendingSwaps'> = {
        pendingNotes: Number(notes.find((n) => n.status === 'pending')?.n ?? 0), infoRequestedNotes: Number(notes.find((n) => n.status === 'info_requested')?.n ?? 0), pendingRegularisations, pendingSwaps,
      };
      if (hasPermission(grant, 'attendance.checkin')) {
        const now = new Date();
        const policy = (await attendancePolicy(t, orgId)).selfService;
        const since = new Date(now.getTime() - 20 * 3_600_000);
        const punches = await t.selectFrom('attendanceRawTransactions').select(['punchedAt', 'direction']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('punchedAt', '>=', since)
          .orderBy('punchedAt', 'desc').limit(50).execute();
        const today = localInstant(now, emp.timezone).date;
        const last = punches[0];
        const lastDirection = last && (last.direction === 'in' || last.direction === 'out') ? last.direction : null;
        const enabled = policy.webCheckIn || policy.mobileCheckIn;
        out.punch = {
          lastDirection, lastPunchAt: last ? last.punchedAt.toISOString() : null, punchesToday: punches.filter((p) => localInstant(p.punchedAt, emp.timezone).date === today).length,
          canCheckIn: enabled && lastDirection !== 'in', canCheckOut: enabled && lastDirection !== 'out', checkInEnabled: enabled,
        };
      }
      return out;
    });
  });
}
