import { sql } from 'kysely';
import { shiftInputSchema, shiftPatternInputSchema, type Permission, type RoundTheClockInput, type RoundTheClockPlanDto, type RoundTheClockResultDto } from '@flowza/contracts';
import { buildRoundTheClockPlan, crewSequenceWithShiftIds } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { dv } from '../features/sql-helpers.js';
import { recalcPastDays } from './common.js';

/*
 * Round-the-clock (24/7) rotation templates (Enterprise, module `advanced_scheduling`, docs/enterprise/plan.md §8).
 *
 *   POST /round-the-clock/preview   the plan of a template (shifts, one rotation pattern per crew, the 24/7 coverage proof)
 *   POST /round-the-clock           creates it in ONE transaction: the shifts, a pattern per crew (all anchored on
 *                                   `anchorDate`, the crew offset folded into each crew's sequence — domain
 *                                   buildRoundTheClockPlan), TEAM assignments of the crews' teams from the anchor date, the
 *                                   coverage targets; audited; recalculates the teams' members when the anchor is not in the
 *                                   future.
 *
 * Permissions: `shift.manage` (shifts, patterns, coverage targets), plus `shift.assign` when crews are put on teams (and
 * access to each team's branch, as for any team assignment), plus access to the coverage branch. RLS enforces every insert
 * again (shifts / patterns / assignments / coverage rows are written as the caller).
 */

export async function previewRoundTheClock(_deps: ApiDeps, actor: Actor, orgId: string, input: RoundTheClockInput): Promise<RoundTheClockPlanDto> {
  requirePermission(actor.principal, orgId, 'shift.manage');
  return buildRoundTheClockPlan(input);
}

export async function applyRoundTheClock(deps: ApiDeps, actor: Actor, orgId: string, input: RoundTheClockInput): Promise<RoundTheClockResultDto & { recalculationJobId: string | null }> {
  const needed: Permission[] = ['shift.manage', ...(input.crewTeams.length > 0 ? ['shift.assign' as const] : [])];
  const grant = requirePermission(actor.principal, orgId, ...needed);
  if (input.coverage) requireBranchAccess(grant, input.coverage.branchId);
  const plan = buildRoundTheClockPlan(input);
  if (!plan.coverageCheck.covered) throw errors.internal('The template does not cover every shift.');
  const reason = `Round-the-clock ${plan.template} (${input.codePrefix})`;

  return runUser(deps.db, actor, async (trx) => {
    // 1. nothing of the plan may exist yet (codes are unique per organisation, case-insensitively)
    const shiftCodes = plan.shifts.map((s) => s.code);
    const patternCodes = plan.crews.map((c) => c.code);
    // citext columns: compared lower-cased explicitly (the citext operators live outside the connection's search path)
    const lowered = (codes: string[]) => sql<boolean>`lower(code::text) = any(${sql.val(codes.map((c) => c.toLowerCase()))}::text[])`;
    const takenShifts = await trx.selectFrom('shifts').select('code').where('organizationId', '=', orgId).where(lowered(shiftCodes)).execute();
    const takenPatterns = await trx.selectFrom('shiftPatterns').select('code').where('organizationId', '=', orgId).where(lowered(patternCodes)).execute();
    if (takenShifts.length > 0 || takenPatterns.length > 0) {
      throw errors.conflict('A shift or rotation pattern with one of these codes already exists. Choose another code prefix.', { shiftCodes: takenShifts.map((s) => String(s.code)), patternCodes: takenPatterns.map((p) => String(p.code)) });
    }
    // 2. the coverage branch and the crews' teams exist and are in the caller's scope
    if (input.coverage) {
      const branch = await trx.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', '=', input.coverage.branchId).executeTakeFirst();
      if (!branch) throw errors.validation('Branch not found.', { issues: [{ path: 'coverage.branchId', message: 'Unknown branch' }] });
    }
    const teamIds = input.crewTeams.map((c) => c.teamId);
    const teams = teamIds.length ? await trx.selectFrom('teams').select(['id', 'branchId', 'name']).where('organizationId', '=', orgId).where('id', 'in', teamIds).execute() : [];
    const teamById = new Map(teams.map((t) => [t.id, t]));
    for (const [i, c] of input.crewTeams.entries()) {
      const team = teamById.get(c.teamId);
      if (!team) throw errors.validation('Team not found.', { issues: [{ path: `crewTeams.${i}.teamId`, message: 'Unknown team' }] });
      if (team.branchId) requireBranchAccess(grant, team.branchId);
      else if (!grant.allBranches) throw errors.forbidden('Branch-scoped users can only assign shifts to teams of their branches.');
    }
    if (teamIds.length) {
      // a team already on a shift from the anchor date on would be assigned twice (the exclusion constraint is the backstop)
      const overlapping = await trx.selectFrom('shiftAssignments').select('targetId').where('organizationId', '=', orgId).where('targetType', '=', 'TEAM').where('targetId', 'in', teamIds)
        .where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(input.anchorDate))])).execute();
      if (overlapping.length) throw errors.conflict('A team already has a shift assignment from the anchor date on: end it first.', { teamIds: [...new Set(overlapping.map((o) => o.targetId))] });
    }

    // 3. shifts
    const shiftIdByKey = new Map<string, string>();
    const shiftIds: string[] = [];
    for (const s of plan.shifts) {
      const v = shiftInputSchema.parse({ code: s.code, name: s.name, type: 'FIXED', startTime: s.startTime, endTime: s.endTime, breaks: s.breakMinutes > 0 ? [{ minutes: s.breakMinutes, paid: false }] : [], color: s.color });
      const row = await trx.insertInto('shifts').values({
        organizationId: orgId, code: v.code, name: v.name, type: v.type, startTime: v.startTime ?? null, endTime: v.endTime ?? null, dayBoundary: v.dayBoundary, breaks: JSON.stringify(v.breaks),
        punchInWindowBeforeMinutes: v.punchInWindowBeforeMinutes, punchOutWindowAfterMinutes: v.punchOutWindowAfterMinutes, color: v.color ?? null, status: v.status,
      }).returning('id').executeTakeFirstOrThrow();
      shiftIdByKey.set(s.key, row.id);
      shiftIds.push(row.id);
      await audit(trx, actor, orgId, 'shift.created', 'shift', { entityId: row.id, newValue: v, reason });
    }
    // 4. one rotation pattern per crew, all anchored on the anchor date (the crew's offset is in its sequence)
    const patternIdByCrew = new Map<string, string>();
    const patternIds: string[] = [];
    for (const c of plan.crews) {
      const p = shiftPatternInputSchema.parse({ code: c.code, name: c.name, cycleLengthDays: c.cycleLengthDays, sequence: crewSequenceWithShiftIds(c.sequence, shiftIdByKey), anchorDate: input.anchorDate });
      const row = await trx.insertInto('shiftPatterns').values({ organizationId: orgId, code: p.code, name: p.name, cycleLengthDays: p.cycleLengthDays, sequence: JSON.stringify(p.sequence), anchorDate: p.anchorDate }).returning('id').executeTakeFirstOrThrow();
      patternIdByCrew.set(c.crew, row.id);
      patternIds.push(row.id);
      await audit(trx, actor, orgId, 'shift_pattern.created', 'shift_pattern', { entityId: row.id, newValue: p, reason });
    }
    // 5. the crews' teams on their patterns from the anchor date (open-ended)
    const assignmentIds: string[] = [];
    for (const c of input.crewTeams) {
      const team = teamById.get(c.teamId)!;
      const row = await trx.insertInto('shiftAssignments').values({ organizationId: orgId, targetType: 'TEAM', targetId: team.id, branchId: team.branchId, shiftId: null, shiftPatternId: patternIdByCrew.get(c.crew)!, effectiveFrom: input.anchorDate, effectiveTo: null, createdBy: actor.userId })
        .returning('id').executeTakeFirstOrThrow();
      assignmentIds.push(row.id);
      await audit(trx, actor, orgId, 'shift.assigned', 'shift_assignment', { entityId: row.id, branchId: team.branchId, newValue: { targetType: 'TEAM', targetId: team.id, shiftPatternId: patternIdByCrew.get(c.crew), effectiveFrom: input.anchorDate, effectiveTo: null, crew: c.crew }, reason });
    }
    // 6. coverage targets on the branch (every weekday)
    const coverageIds: string[] = [];
    if (input.coverage) {
      for (const shiftId of shiftIds) {
        const row = await trx.insertInto('shiftCoverageRequirements').values({ organizationId: orgId, branchId: input.coverage.branchId, shiftId, weekdays: [0, 1, 2, 3, 4, 5, 6], minHeadcount: input.coverage.minHeadcount, createdBy: actor.userId })
          .returning('id').executeTakeFirstOrThrow();
        coverageIds.push(row.id);
        await audit(trx, actor, orgId, 'shift.coverage_created', 'shift_coverage_requirement', { entityId: row.id, branchId: input.coverage.branchId, newValue: { shiftId, weekdays: [0, 1, 2, 3, 4, 5, 6], minHeadcount: input.coverage.minHeadcount }, reason });
      }
    }
    await audit(trx, actor, orgId, 'shift.round_the_clock_applied', 'shift_pattern', {
      entityId: null, branchId: input.coverage?.branchId ?? null, reason,
      newValue: { template: plan.template, codePrefix: input.codePrefix, namePrefix: input.namePrefix, firstShiftStart: input.firstShiftStart, anchorDate: input.anchorDate, breakMinutes: input.breakMinutes, crewTeams: input.crewTeams, coverage: input.coverage, shiftIds, patternIds, assignmentIds, coverageIds },
    });
    // 7. the teams' members whose past days now follow the rotation (team membership is not branch-scoped data the caller
    //    reads back: the ids only scope the recalculation)
    let recalculationJobId: string | null = null;
    if (teamIds.length) {
      const members = await withSystemScope(trx, orgId, (t) => t.selectFrom('teamMembers').select('employeeId').where('organizationId', '=', orgId).where('teamId', 'in', teamIds).execute());
      recalculationJobId = await recalcPastDays(deps, trx, actor, orgId, input.anchorDate, null, { employeeIds: [...new Set(members.map((m) => m.employeeId))], reason });
    }
    return { plan, shiftIds, patternIds, assignmentIds, coverageIds, recalculationJobId };
  });
}
