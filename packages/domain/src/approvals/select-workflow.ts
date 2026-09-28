/** The columns of `approval_workflows` the selection needs. */
export interface WorkflowCandidate {
  id: string;
  name?: string;
  branchId: string | null;
  appliesTo: { branchIds?: readonly string[] | undefined; departmentIds?: readonly string[] | undefined } | null | undefined;
  minUnits: number | null;
  isDefault: boolean;
  status: string;
}
export interface WorkflowSelector { branchId: string | null; departmentId: string | null; units: number | null }

function appliesTo(w: WorkflowCandidate, sel: WorkflowSelector): { ok: boolean; specificity: number } {
  const a = w.appliesTo ?? {};
  let specificity = 0;
  if (a.branchIds && a.branchIds.length > 0) { if (!sel.branchId || !a.branchIds.includes(sel.branchId)) return { ok: false, specificity: 0 }; specificity += 1; }
  if (a.departmentIds && a.departmentIds.length > 0) { if (!sel.departmentId || !a.departmentIds.includes(sel.departmentId)) return { ok: false, specificity: 0 }; specificity += 2; }
  return { ok: true, specificity };
}

/**
 * Pick the workflow for a request among the entity type's ACTIVE DEFAULT workflows: the branch-specific one beats the
 * organisation-wide one; `appliesTo` must match (a workflow narrowed to other branches/departments never applies); a tier
 * (`minUnits`) applies only when the request's units are known and reach it, and when several tiers apply the highest
 * minimum wins (Finance's amount tiers, B-103). Ties break on the more specific `appliesTo`, then name, then id, so the
 * outcome never depends on row order. Returns null when no workflow applies.
 */
export function selectWorkflow<T extends WorkflowCandidate>(workflows: readonly T[], sel: WorkflowSelector): T | null {
  const ranked = workflows
    .filter((w) => w.status === 'active' && w.isDefault)
    .filter((w) => w.branchId === null || w.branchId === sel.branchId)
    .filter((w) => w.minUnits === null || (sel.units !== null && sel.units >= w.minUnits))
    .map((w) => ({ w, a: appliesTo(w, sel) }))
    .filter((x) => x.a.ok)
    .sort((x, y) =>
      Number(y.w.branchId !== null) - Number(x.w.branchId !== null)
      || (y.w.minUnits ?? -1) - (x.w.minUnits ?? -1)
      || y.a.specificity - x.a.specificity
      || (x.w.name ?? '').localeCompare(y.w.name ?? '')
      || x.w.id.localeCompare(y.w.id));
  return ranked[0]?.w ?? null;
}
