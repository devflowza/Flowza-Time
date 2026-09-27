import { PERMISSIONS, type ApprovalAppliesTo, type ApprovalWorkflowDto, type ApprovalWorkflowInput, type Permission } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { hasPermission, requireBranchAccess, requireMembership } from '../../lib/authorize.js';
import { isoDateTime, jsonObject, numberOrNull } from '../../lib/mappers.js';
import { type Actor, audit, runUser } from '../../lib/service.js';
import { parseWorkflowSteps } from './engine.js';

type WorkflowRow = { id: string; organizationId: string; entityType: ApprovalWorkflowDto['entityType']; name: string; branchId: string | null; steps: unknown; appliesTo: unknown; minUnits: string | number | null; allowSelfApproval: boolean; isDefault: boolean; status: string; createdAt: Date; updatedAt: Date };

export function toWorkflowDto(w: WorkflowRow): ApprovalWorkflowDto {
  const a = jsonObject(w.appliesTo);
  const ids = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length ? v.map(String) : undefined);
  const appliesTo: ApprovalAppliesTo = { ...(ids(a['branchIds']) ? { branchIds: ids(a['branchIds']) } : {}), ...(ids(a['departmentIds']) ? { departmentIds: ids(a['departmentIds']) } : {}) };
  return { id: w.id, organizationId: w.organizationId, entityType: w.entityType, name: w.name, branchId: w.branchId, steps: parseWorkflowSteps(w.steps).map((s) => ({ ...s, permission: s.permission && (PERMISSIONS as readonly string[]).includes(s.permission) ? (s.permission as Permission) : undefined })), appliesTo, minUnits: numberOrNull(w.minUnits), allowSelfApproval: w.allowSelfApproval, isDefault: w.isDefault, status: w.status, createdAt: isoDateTime(w.createdAt), updatedAt: isoDateTime(w.updatedAt) };
}

/** Configuring workflows: approval.manage (the HR admin) or organization.manage (as before). */
function requireConfigure(actor: Actor, orgId: string) {
  const grant = requireMembership(actor.principal, orgId);
  if (!hasPermission(grant, 'approval.manage') && !hasPermission(grant, 'organization.manage')) throw errors.forbidden('Missing permission: approval.manage.');
  return grant;
}

async function validateSteps(trx: Trx, orgId: string, steps: ApprovalWorkflowInput['steps']): Promise<void> {
  for (const s of steps) {
    if (s.roleId) { const r = await trx.selectFrom('roles').select('id').where('id', '=', s.roleId).where((eb) => eb.or([eb('isSystem', '=', true), eb('organizationId', '=', orgId)])).executeTakeFirst(); if (!r) throw errors.validation('Unknown role in workflow step.', { roleId: s.roleId }); }
    if (s.userId) { const m = await trx.selectFrom('orgMemberships').select('id').where('organizationId', '=', orgId).where('userId', '=', s.userId).where('status', '=', 'active').executeTakeFirst(); if (!m) throw errors.validation('Workflow step user is not an active member.', { userId: s.userId }); }
  }
}
async function validateAppliesTo(trx: Trx, orgId: string, appliesTo: ApprovalAppliesTo | undefined): Promise<void> {
  if (!appliesTo) return;
  if (appliesTo.branchIds?.length) {
    const n = (await trx.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', 'in', appliesTo.branchIds).execute()).length;
    if (n !== new Set(appliesTo.branchIds).size) throw errors.validation('appliesTo.branchIds contains an unknown branch.');
  }
  if (appliesTo.departmentIds?.length) {
    const n = (await trx.selectFrom('departments').select('id').where('organizationId', '=', orgId).where('id', 'in', appliesTo.departmentIds).execute()).length;
    if (n !== new Set(appliesTo.departmentIds).size) throw errors.validation('appliesTo.departmentIds contains an unknown department.');
  }
}
const stepsJson = (steps: ApprovalWorkflowInput['steps']) => JSON.stringify(steps.map((s, i) => ({ ...s, order: i + 1 })));

export async function listWorkflows(deps: ApiDeps, actor: Actor, orgId: string): Promise<ApprovalWorkflowDto[]> {
  const grant = requireMembership(actor.principal, orgId);
  if (!['attendance.view', 'leave.view', 'approval.manage', 'organization.manage'].some((p) => hasPermission(grant, p as never))) throw errors.forbidden('Missing permission: approval.manage.');
  return runUser(deps.db, actor, async (trx) => (await trx.selectFrom('approvalWorkflows').selectAll().where('organizationId', '=', orgId).orderBy('entityType').orderBy('name').execute()).map((w) => toWorkflowDto(w as WorkflowRow)));
}

export async function createWorkflow(deps: ApiDeps, actor: Actor, orgId: string, input: ApprovalWorkflowInput): Promise<ApprovalWorkflowDto> {
  const grant = requireConfigure(actor, orgId);
  requireBranchAccess(grant, input.branchId);
  return runUser(deps.db, actor, async (trx) => {
    await validateSteps(trx, orgId, input.steps);
    await validateAppliesTo(trx, orgId, input.appliesTo);
    const row = await trx.insertInto('approvalWorkflows').values({ organizationId: orgId, entityType: input.entityType, name: input.name, branchId: input.branchId ?? null, steps: stepsJson(input.steps), appliesTo: JSON.stringify(input.appliesTo ?? {}), minUnits: input.minUnits ?? null, allowSelfApproval: input.allowSelfApproval, isDefault: input.isDefault, status: input.status }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'approval_workflow.created', 'approval_workflow', { entityId: row.id, branchId: input.branchId ?? null, newValue: input });
    return toWorkflowDto(row as WorkflowRow);
  });
}

export async function updateWorkflow(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: Partial<ApprovalWorkflowInput>): Promise<ApprovalWorkflowDto> {
  const grant = requireConfigure(actor, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const before = await trx.selectFrom('approvalWorkflows').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!before) throw errors.notFound('Approval workflow', id);
    requireBranchAccess(grant, before.branchId);
    if (input.branchId !== undefined) requireBranchAccess(grant, input.branchId);
    if (input.steps) await validateSteps(trx, orgId, input.steps);
    if (input.appliesTo) await validateAppliesTo(trx, orgId, input.appliesTo);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      patch[k] = k === 'steps' ? stepsJson(v as ApprovalWorkflowInput['steps']) : k === 'appliesTo' ? JSON.stringify(v) : v;
    }
    if (Object.keys(patch).length) await trx.updateTable('approvalWorkflows').set(patch as never).where('id', '=', id).execute();
    const after = await trx.selectFrom('approvalWorkflows').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'approval_workflow.updated', 'approval_workflow', { entityId: id, branchId: after.branchId, oldValue: toWorkflowDto(before as WorkflowRow), newValue: toWorkflowDto(after as WorkflowRow) });
    return toWorkflowDto(after as WorkflowRow);
  });
}

export async function deleteWorkflow(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  const grant = requireConfigure(actor, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const w = await trx.selectFrom('approvalWorkflows').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!w) throw errors.notFound('Approval workflow', id);
    requireBranchAccess(grant, w.branchId);
    await trx.deleteFrom('approvalWorkflows').where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'approval_workflow.deleted', 'approval_workflow', { entityId: id, branchId: w.branchId, oldValue: toWorkflowDto(w as WorkflowRow) });
  });
}
