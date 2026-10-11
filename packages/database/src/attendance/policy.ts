import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { attendanceRuleSetInputSchema, DEFAULT_ATTENDANCE_RULES, policySectionsOf, type AttendanceRules } from '@flowza/contracts';
import { errors } from '@flowza/shared';
import { explainPolicyResolution, resolvePolicy, type EngineRuleSet, type PolicyScope } from '@flowza/domain';
import type { Trx } from '../context.js';

/*
 * Attendance POLICY resolution against the database (Enterprise, docs/enterprise/plan.md §4): every policy row of the
 * organisation effective on the date, the employee's scope on that date (country of the branch, branch, department,
 * employee group, primary shift) and `@flowza/domain` resolvePolicy. ONE implementation for the engine input
 * (load-inputs.ts), the API's "which policy applies" card, the check-in method restriction, the regularisation limits and
 * the points / overtime reports. Runs under whatever context the caller established.
 */

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') { try { return asObject(JSON.parse(v)); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return DateTime.fromJSDate(v).toISODate() ?? v.toISOString().slice(0, 10);
}
const asDate = (date: string) => sql<Date>`${date}::date`;

/** `ramadan_mode` jsonb tolerates the snake_case keys documented in the migration. */
export function normaliseRamadanMode(raw: unknown): Record<string, unknown> {
  const o = asObject(raw);
  const appliesTo = o['appliesTo'] ?? o['applies_to'];
  const out: Record<string, unknown> = { enabled: o['enabled'] === true, appliesTo: appliesTo === undefined || appliesTo === 'all' ? 'all' : 'flagged_employees' };
  const scheduled = o['scheduledMinutes'] ?? o['scheduled_minutes'];
  if (typeof scheduled === 'number') out['scheduledMinutes'] = scheduled;
  if (typeof o['from'] === 'string') out['from'] = o['from'].slice(0, 10);
  if (typeof o['to'] === 'string') out['to'] = o['to'].slice(0, 10);
  return out;
}

export type RuleSetRow = Awaited<ReturnType<typeof loadPolicyRows>>[number];

/**
 * Every policy row of the organisation, or only those effective on `date` — with the depth of its location and of its branch's
 * node in the location tree (docs/locations.md §3: between two location policies the deeper one wins).
 */
export async function loadPolicyRows(trx: Trx, organizationId: string, date?: string) {
  let q = trx.selectFrom('attendanceRuleSets as rs')
    .leftJoin('locations as pl', (j) => j.onRef('pl.id', '=', 'rs.locationId').onRef('pl.organizationId', '=', 'rs.organizationId'))
    .leftJoin('locations as bn', (j) => j.onRef('bn.branchId', '=', 'rs.branchId').onRef('bn.organizationId', '=', 'rs.organizationId').on('bn.role', '=', 'branch'))
    .selectAll('rs').select(['pl.depth as locationDepth', 'bn.depth as branchDepth'])
    .where('rs.organizationId', '=', organizationId);
  if (date) q = q.where('rs.effectiveFrom', '<=', asDate(date)).where((eb) => eb.or([eb('rs.effectiveTo', 'is', null), eb('rs.effectiveTo', '>', asDate(date))]));
  return q.execute();
}

/** Map a policy row onto `AttendanceRules`, validating through the shared contract schema (the DB constraints mirror it). */
export function toAttendanceRules(row: RuleSetRow): AttendanceRules {
  const parsed = attendanceRuleSetInputSchema.safeParse({
    name: row.name, description: row.description, effectiveFrom: isoDate(row.effectiveFrom), effectiveTo: row.effectiveTo === null ? null : isoDate(row.effectiveTo),
    branchId: row.branchId, countryCode: row.countryCode, departmentId: row.departmentId, employeeGroupId: row.employeeGroupId, shiftId: row.shiftId, locationId: row.locationId,
    graceInMinutes: row.graceInMinutes, graceOutMinutes: row.graceOutMinutes, lateThresholdMinutes: row.lateThresholdMinutes, earlyDepartureThresholdMinutes: row.earlyDepartureThresholdMinutes,
    minFullDayMinutes: row.minFullDayMinutes, halfDayThresholdMinutes: row.halfDayThresholdMinutes, overtimeEnabled: row.overtimeEnabled, overtimeStartAfterMinutes: row.overtimeStartAfterMinutes,
    overtimeMinBlockMinutes: row.overtimeMinBlockMinutes, overtimeRoundingMinutes: row.overtimeRoundingMinutes, overtimeMaxMinutesPerDay: row.overtimeMaxMinutesPerDay, countEarlyInAsOvertime: row.countEarlyInAsOvertime,
    overtimeRequiresScheduledHours: row.overtimeRequiresScheduledHours,
    punchRoundingMinutes: row.punchRoundingMinutes, punchRoundingMode: row.punchRoundingMode, workedRoundingMinutes: row.workedRoundingMinutes, workedRoundingMode: row.workedRoundingMode,
    punchInterpretation: row.punchInterpretation, duplicatePunchWindowSeconds: row.duplicatePunchWindowSeconds, missingPunchBehavior: row.missingPunchBehavior, autoAbsentWithoutPunches: row.autoAbsentWithoutPunches,
    weeklyOffWorkCountsAsOvertime: row.weeklyOffWorkCountsAsOvertime, holidayWorkCountsAsOvertime: row.holidayWorkCountsAsOvertime, ramadanMode: normaliseRamadanMode(row.ramadanMode),
    // a stored section that no longer validates (a rule tightened after it was saved) falls back section by section to the
    // defaults instead of failing every recompute, check-in and regularisation of the employees on the policy
    policy: policySectionsOf(row.policy),
  });
  if (!parsed.success) throw errors.validation('Attendance rule set is invalid.', { ruleSetId: row.id, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const { name: _n, description: _d, branchId: _b, countryCode: _c, departmentId: _dep, employeeGroupId: _g, shiftId: _s, locationId: _l, effectiveFrom: _f, effectiveTo: _t, ...rules } = parsed.data;
  return rules;
}

export type PolicyCandidate = EngineRuleSet & { row: RuleSetRow };
/** A row as the domain resolver sees it (rules are filled in lazily by the caller that needs them). */
export function toPolicyCandidate(row: RuleSetRow): PolicyCandidate {
  return {
    id: row.id, branchId: row.branchId, countryCode: row.countryCode, departmentId: row.departmentId, employeeGroupId: row.employeeGroupId, shiftId: row.shiftId,
    locationId: row.locationId, locationDepth: row.locationDepth, branchDepth: row.branchDepth,
    effectiveFrom: isoDate(row.effectiveFrom), effectiveTo: row.effectiveTo === null ? null : isoDate(row.effectiveTo), rules: DEFAULT_ATTENDANCE_RULES, row,
  };
}

/** The employee group an employee belongs to on `date` (null = none). */
export async function employeeGroupIdOn(trx: Trx, organizationId: string, employeeId: string, date: string): Promise<string | null> {
  const row = await trx.selectFrom('employeeGroupMemberships').select('employeeGroupId')
    .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId)
    .where('effectiveFrom', '<=', asDate(date)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', asDate(date))]))
    .orderBy('effectiveFrom', 'desc').limit(1).executeTakeFirst();
  return row?.employeeGroupId ?? null;
}

/**
 * Where the employee sits on the date: the placement the caller resolved (branch / department / primary shift) + country,
 * group and location chain — the path of the employee's work location when it belongs to the placement's branch (a
 * deployment or a past date in another branch falls back to that branch), else the path of the branch's node.
 */
export async function loadPolicyScope(trx: Trx, organizationId: string, employeeId: string, date: string, placement: { branchId: string; departmentId: string | null; shiftId: string | null }): Promise<PolicyScope> {
  const [branch, employeeGroupId] = await Promise.all([
    trx.selectFrom('branches as b')
      .select((eb) => [
        'b.countryCode',
        eb.selectFrom('locations as bn').select('bn.path').whereRef('bn.branchId', '=', 'b.id').where('bn.role', '=', 'branch').limit(1).as('branchPath'),
        eb.selectFrom('employees as e').innerJoin('locations as wl', (j) => j.onRef('wl.id', '=', 'e.workLocationId').onRef('wl.organizationId', '=', 'e.organizationId'))
          .select('wl.path').where('e.id', '=', employeeId).whereRef('e.organizationId', '=', 'b.organizationId').whereRef('wl.branchId', '=', 'b.id').limit(1).as('workPath'),
      ])
      .where('b.organizationId', '=', organizationId).where('b.id', '=', placement.branchId).executeTakeFirst(),
    employeeGroupIdOn(trx, organizationId, employeeId, date),
  ]);
  const chain = uuidArray(branch?.workPath) ?? uuidArray(branch?.branchPath);
  return {
    countryCode: branch?.countryCode?.trim() || null, branchId: placement.branchId, departmentId: placement.departmentId, employeeGroupId, shiftId: placement.shiftId,
    ...(chain ? { locationIds: chain } : {}),
  };
}

/** A uuid[] column as node-postgres returns it (an array, or the text form `{a,b}` when no array parser is registered). */
export function uuidArray(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) return v.length > 2 ? v.slice(1, -1).split(',').map((x) => x.trim()) : [];
  return null;
}

export interface ResolvedPolicy {
  scope: PolicyScope;
  /** The winning row (null = no policy: the contract defaults apply). */
  row: RuleSetRow | null;
  rules: AttendanceRules;
}

/** The policy of an employee on a date, for an already resolved placement. */
export async function resolvePolicyFor(trx: Trx, organizationId: string, employeeId: string, date: string, placement: { branchId: string; departmentId: string | null; shiftId: string | null }): Promise<ResolvedPolicy> {
  const [scope, rows] = await Promise.all([loadPolicyScope(trx, organizationId, employeeId, date, placement), loadPolicyRows(trx, organizationId, date)]);
  const winner = resolvePolicy(rows.map(toPolicyCandidate), date, scope);
  return { scope, row: winner?.row ?? null, rules: winner ? toAttendanceRules(winner.row) : DEFAULT_ATTENDANCE_RULES };
}

/** Every policy of the organisation with the reason it does (not) apply to the scope on the date — the API's resolve card. */
export async function explainPolicyFor(trx: Trx, organizationId: string, employeeId: string, date: string, placement: { branchId: string; departmentId: string | null; shiftId: string | null }) {
  const [scope, rows] = await Promise.all([loadPolicyScope(trx, organizationId, employeeId, date, placement), loadPolicyRows(trx, organizationId)]);
  return { scope, ...explainPolicyResolution(rows.map(toPolicyCandidate), date, scope) };
}

/** Additional (double) shift assignments of an employee covering any date of [from, to] (inclusive). */
export async function loadAdditionalShiftAssignments(trx: Trx, organizationId: string, employeeIds: readonly string[], from: string, to: string) {
  if (employeeIds.length === 0) return [];
  const rows = await trx.selectFrom('additionalShiftAssignments').select(['id', 'employeeId', 'shiftId', 'effectiveFrom', 'effectiveTo'])
    .where('organizationId', '=', organizationId).where('employeeId', 'in', [...new Set(employeeIds)])
    .where('effectiveFrom', '<=', asDate(to)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', asDate(from))])).execute();
  return rows.map((r) => ({ id: r.id, employeeId: r.employeeId, shiftId: r.shiftId, effectiveFrom: isoDate(r.effectiveFrom), effectiveTo: r.effectiveTo === null ? null : isoDate(r.effectiveTo) }));
}

/** The additional shift effective on `date` among pre-loaded rows (rows of one employee never overlap). */
export function additionalShiftOn<T extends { effectiveFrom: string; effectiveTo: string | null }>(rows: readonly T[], date: string): T | undefined {
  return rows.find((r) => r.effectiveFrom <= date && (r.effectiveTo === null || date < r.effectiveTo));
}
