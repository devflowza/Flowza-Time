/**
 * Attendance policy resolution (Enterprise, docs/enterprise/plan.md §4, docs/locations.md §3): Country → Company → Location →
 * Department → Employee group → Shift. A policy names any subset of the dimensions; every dimension it names must match where
 * the employee sits on the date, and the most specific matching policy wins — like a CSS selector: shift > employee group >
 * department > location > country (a policy naming nothing is the organisation default). The location is a branch
 * (`branchId`) or a node of the location tree (`locationId`: a group node such as a region, or a place such as a site or a
 * floor); it matches when it lies on the employee's location chain, and between two location policies the DEEPER one wins
 * (Zone > Floor > Site > Branch > Region > Headquarters). Among equally specific policies the latest `effectiveFrom` wins,
 * then the id (deterministic). Pure.
 *
 * `policySpecificity` is the published display number (shift 32, group 16, department 8, location / branch 4, country 2): it
 * orders every pair of policies the same way the resolver does except two location policies of different depth, which it
 * shows as equal.
 */
export interface PolicyScope {
  /** Country of the branch the employee belongs to on the date. */
  countryCode: string | null;
  branchId: string | null;
  departmentId: string | null;
  employeeGroupId: string | null;
  /** The (primary) shift the employee works on the date. */
  shiftId: string | null;
  /**
   * The employee's location chain on the date, root first: the path of their work location when it belongs to the branch they
   * work in on the date, else the path of that branch's node. Absent = no location policy matches.
   */
  locationIds?: readonly string[];
}

export interface ScopedPolicy {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  branchId: string | null;
  countryCode?: string | null;
  departmentId?: string | null;
  employeeGroupId?: string | null;
  shiftId?: string | null;
  /** A group location or a place (with `branchId` = the place's branch). */
  locationId?: string | null;
  /** Depth of `locationId` in the tree (root = 1); missing = 1. */
  locationDepth?: number | null;
  /** Depth of the branch's node in the tree (root = 1); missing = 1. */
  branchDepth?: number | null;
}

export type PolicyDimension = 'COUNTRY' | 'BRANCH' | 'LOCATION' | 'DEPARTMENT' | 'EMPLOYEE_GROUP' | 'SHIFT';
export type PolicyMismatch = 'DATES' | PolicyDimension;

/** The exact-match dimensions with their display weight; the order in which mismatches are reported is broadest first. */
export const POLICY_DIMENSIONS: ReadonlyArray<{ dimension: Exclude<PolicyDimension, 'LOCATION'>; key: Exclude<keyof PolicyScope, 'locationIds'>; weight: number }> = [
  { dimension: 'COUNTRY', key: 'countryCode', weight: 2 },
  { dimension: 'BRANCH', key: 'branchId', weight: 4 },
  { dimension: 'DEPARTMENT', key: 'departmentId', weight: 8 },
  { dimension: 'EMPLOYEE_GROUP', key: 'employeeGroupId', weight: 16 },
  { dimension: 'SHIFT', key: 'shiftId', weight: 32 },
];
/** Display weight of the location dimension (shared with the branch: a place policy names both and counts once). */
export const LOCATION_WEIGHT = 4;

/** Half-open `[effectiveFrom, effectiveTo)`, like every effective-dated table (same rule as resolve-shift's isEffectiveOn). */
const effectiveOn = (row: { effectiveFrom: string; effectiveTo: string | null }, date: string): boolean => row.effectiveFrom <= date && (row.effectiveTo === null || date < row.effectiveTo);
const valueOf = (policy: ScopedPolicy, key: Exclude<keyof PolicyScope, 'locationIds'>): string | null => policy[key] ?? null;
const named = (v: string | null | undefined): boolean => v !== null && v !== undefined;

/** The display number: sum of the weights of the dimensions the policy names (0 = organisation default). */
export function policySpecificity(policy: ScopedPolicy): number {
  let score = 0;
  for (const d of POLICY_DIMENSIONS) if (d.dimension !== 'BRANCH' && valueOf(policy, d.key) !== null) score += d.weight;
  if (named(policy.branchId) || named(policy.locationId)) score += LOCATION_WEIGHT;
  return score;
}

/** How deep the policy's location sits (0 = it names none): its location node, else its branch's node. */
export function policyLocationDepth(policy: ScopedPolicy): number {
  if (named(policy.locationId)) return Math.max(1, policy.locationDepth ?? 1);
  if (named(policy.branchId)) return Math.max(1, policy.branchDepth ?? 1);
  return 0;
}

/** Why a policy does not apply to the scope on the date (null = it applies). */
export function policyMismatch(policy: ScopedPolicy, scope: PolicyScope, date: string): PolicyMismatch | null {
  if (!effectiveOn(policy, date)) return 'DATES';
  for (const d of POLICY_DIMENSIONS) {
    const wanted = valueOf(policy, d.key);
    if (wanted !== null && wanted !== scope[d.key]) return d.dimension;
    if (d.dimension === 'BRANCH' && named(policy.locationId) && !(scope.locationIds ?? []).includes(policy.locationId!)) return 'LOCATION';
  }
  return null;
}

/** Most specific first: shift, employee group, department, location depth, country — then the latest start, then the id. */
function compare(a: ScopedPolicy, b: ScopedPolicy): number {
  const bit = (p: ScopedPolicy, k: 'shiftId' | 'employeeGroupId' | 'departmentId' | 'countryCode') => (named(p[k]) ? 1 : 0);
  for (const k of ['shiftId', 'employeeGroupId', 'departmentId'] as const) {
    const d = bit(b, k) - bit(a, k);
    if (d !== 0) return d;
  }
  const depth = policyLocationDepth(b) - policyLocationDepth(a);
  if (depth !== 0) return depth;
  const country = bit(b, 'countryCode') - bit(a, 'countryCode');
  if (country !== 0) return country;
  if (a.effectiveFrom !== b.effectiveFrom) return b.effectiveFrom.localeCompare(a.effectiveFrom);
  return a.id.localeCompare(b.id);
}

/** The policy that applies to `scope` on `date` (null = none: the contract defaults apply). */
export function resolvePolicy<T extends ScopedPolicy>(policies: readonly T[], date: string, scope: PolicyScope): T | null {
  return policies.filter((p) => policyMismatch(p, scope, date) === null).sort(compare)[0] ?? null;
}

/** Every policy with its specificity and the reason it does (not) apply, winner first — the "which policy applies" card. */
export function explainPolicyResolution<T extends ScopedPolicy>(policies: readonly T[], date: string, scope: PolicyScope): { winner: T | null; candidates: Array<{ policy: T; specificity: number; mismatch: PolicyMismatch | null }> } {
  const candidates = policies.map((policy) => ({ policy, specificity: policySpecificity(policy), mismatch: policyMismatch(policy, scope, date) }));
  candidates.sort((a, b) => (a.mismatch === null) !== (b.mismatch === null) ? (a.mismatch === null ? -1 : 1) : compare(a.policy, b.policy));
  const winner = candidates[0] && candidates[0].mismatch === null ? candidates[0].policy : null;
  return { winner, candidates };
}

/** A scope that names only a branch — what the classic organisation / branch rule sets were resolved against. */
export function branchOnlyScope(branchId: string | null): PolicyScope {
  return { countryCode: null, branchId, departmentId: null, employeeGroupId: null, shiftId: null };
}
