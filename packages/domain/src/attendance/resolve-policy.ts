/**
 * Attendance policy resolution (Enterprise, docs/enterprise/plan.md §4): Country → Company → Location → Department → Employee
 * group → Shift. A policy names any subset of the dimensions; every dimension it names must match where the employee sits on
 * the date, and the most specific matching policy wins — like a CSS selector: the weights are powers of two so a policy that
 * names a more specific dimension always beats any combination of broader ones (shift 32 > group 16 > department 8 >
 * branch 4 > country 2; a policy naming nothing is the organisation default, 0). Among equally specific policies the latest
 * `effectiveFrom` wins, then the id (deterministic). Pure.
 */
export interface PolicyScope {
  /** Country of the branch the employee belongs to on the date. */
  countryCode: string | null;
  branchId: string | null;
  departmentId: string | null;
  employeeGroupId: string | null;
  /** The (primary) shift the employee works on the date. */
  shiftId: string | null;
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
}

export type PolicyDimension = 'COUNTRY' | 'BRANCH' | 'DEPARTMENT' | 'EMPLOYEE_GROUP' | 'SHIFT';
export type PolicyMismatch = 'DATES' | PolicyDimension;

/** Weight of each dimension; the order in which mismatches are reported is from the broadest to the narrowest. */
export const POLICY_DIMENSIONS: ReadonlyArray<{ dimension: PolicyDimension; key: keyof PolicyScope; weight: number }> = [
  { dimension: 'COUNTRY', key: 'countryCode', weight: 2 },
  { dimension: 'BRANCH', key: 'branchId', weight: 4 },
  { dimension: 'DEPARTMENT', key: 'departmentId', weight: 8 },
  { dimension: 'EMPLOYEE_GROUP', key: 'employeeGroupId', weight: 16 },
  { dimension: 'SHIFT', key: 'shiftId', weight: 32 },
];

/** Half-open `[effectiveFrom, effectiveTo)`, like every effective-dated table (same rule as resolve-shift's isEffectiveOn). */
const effectiveOn = (row: { effectiveFrom: string; effectiveTo: string | null }, date: string): boolean => row.effectiveFrom <= date && (row.effectiveTo === null || date < row.effectiveTo);
const valueOf = (policy: ScopedPolicy, key: keyof PolicyScope): string | null => policy[key] ?? null;

/** Sum of the weights of the dimensions the policy names (0 = organisation default). */
export function policySpecificity(policy: ScopedPolicy): number {
  let score = 0;
  for (const d of POLICY_DIMENSIONS) if (valueOf(policy, d.key) !== null) score += d.weight;
  return score;
}

/** Why a policy does not apply to the scope on the date (null = it applies). */
export function policyMismatch(policy: ScopedPolicy, scope: PolicyScope, date: string): PolicyMismatch | null {
  if (!effectiveOn(policy, date)) return 'DATES';
  for (const d of POLICY_DIMENSIONS) {
    const wanted = valueOf(policy, d.key);
    if (wanted !== null && wanted !== scope[d.key]) return d.dimension;
  }
  return null;
}

function compare(a: ScopedPolicy, b: ScopedPolicy): number {
  const specificity = policySpecificity(b) - policySpecificity(a);
  if (specificity !== 0) return specificity;
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
