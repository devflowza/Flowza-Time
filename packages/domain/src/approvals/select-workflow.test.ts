import { describe, expect, it } from 'vitest';
import { selectWorkflow, type WorkflowCandidate } from './select-workflow.js';

const wf = (id: string, over: Partial<WorkflowCandidate> = {}): WorkflowCandidate => ({ id, name: id, branchId: null, appliesTo: {}, minUnits: null, isDefault: true, status: 'active', ...over });
const B1 = 'branch-1'; const D1 = 'dept-1';

describe('selectWorkflow', () => {
  it('prefers the branch-specific default over the organisation-wide one, and ignores inactive / non-default rows', () => {
    const list = [wf('org'), wf('branch', { branchId: B1 }), wf('inactive', { branchId: B1, status: 'inactive' }), wf('alt', { branchId: B1, isDefault: false })];
    expect(selectWorkflow(list, { branchId: B1, departmentId: null, units: null })?.id).toBe('branch');
    expect(selectWorkflow(list, { branchId: 'branch-2', departmentId: null, units: null })?.id).toBe('org');
    expect(selectWorkflow([wf('other', { branchId: 'branch-2' })], { branchId: B1, departmentId: null, units: null })).toBeNull();
  });
  it('applies tiers: the highest minimum the units reach wins; a tier needs known units; a tier-less workflow is the floor', () => {
    const list = [wf('base'), wf('t3', { minUnits: 3 }), wf('t10', { minUnits: 10 })];
    expect(selectWorkflow(list, { branchId: null, departmentId: null, units: 1 })?.id).toBe('base');
    expect(selectWorkflow(list, { branchId: null, departmentId: null, units: 3 })?.id).toBe('t3');
    expect(selectWorkflow(list, { branchId: null, departmentId: null, units: 12 })?.id).toBe('t10');
    expect(selectWorkflow(list, { branchId: null, departmentId: null, units: null })?.id).toBe('base');
    expect(selectWorkflow([wf('t3', { minUnits: 3 })], { branchId: null, departmentId: null, units: 2 })).toBeNull();
  });
  it('honours appliesTo (branches / departments) and ranks the more specific narrowing first', () => {
    const list = [wf('any'), wf('dept', { appliesTo: { departmentIds: [D1] } }), wf('branch-narrow', { appliesTo: { branchIds: [B1] } })];
    expect(selectWorkflow(list, { branchId: B1, departmentId: D1, units: null })?.id).toBe('dept');
    expect(selectWorkflow(list, { branchId: B1, departmentId: 'dept-9', units: null })?.id).toBe('branch-narrow');
    expect(selectWorkflow(list, { branchId: 'branch-9', departmentId: null, units: null })?.id).toBe('any');
    // the branch scope column still beats a narrowed organisation-wide workflow
    expect(selectWorkflow([...list, wf('scoped', { branchId: B1 })], { branchId: B1, departmentId: D1, units: null })?.id).toBe('scoped');
  });
  it('breaks remaining ties deterministically by name then id', () => {
    expect(selectWorkflow([wf('b'), wf('a')], { branchId: null, departmentId: null, units: null })?.id).toBe('a');
  });
});
