import { z } from 'zod';
import { APPROVAL_DECISIONS, APPROVAL_ENTITIES, APPROVAL_ESCALATION_TARGETS, APPROVAL_INBOX_SCOPES, APPROVAL_REQUEST_STATUSES, APPROVAL_STEP_MODES, APPROVER_TYPES, RECORD_STATUSES, type ApprovalEntity, type ApprovalEscalationTarget, type ApprovalRequestStatus, type ApprovalStatus, type ApprovalStepMode, type ApproverType } from '../enums.js';
import { PERMISSIONS } from '../permissions.js';
import { booleanQuerySchema, isoDateSchema, paginationQuerySchema, uuidSchema } from '../common.js';
import { updateSchemaOf } from './devices.js';

// ----- workflows ---------------------------------------------------------------------------------------------------------

/**
 * One level of an approval workflow (source of truth; `app.approval_steps_valid` in the database mirrors the structural
 * minimum). Approver types resolve at submission time against the request's subject employee:
 *   MANAGER            primary manager → secondary → HR admins → owner when absent
 *   SECONDARY_MANAGER  secondary manager → HR admins → owner
 *   MANAGER_CHAIN      `chainLevel` rungs up the primary reporting line (absent rungs substituted by the secondary manager;
 *                      a shorter chain resolves to the most senior reachable manager)
 *   HR_ADMIN           every hr_admin member; DEPARTMENT_HEAD the subject's department manager; BRANCH_MANAGER branch
 *                      managers scoped to the subject's branch
 *   ROLE               holders of `permission` in the organisation, or members of the role `roleId`
 *   USER               one named member
 * `mode` decides how many of the resolved approvers must approve; `escalateAfterHours`/`escalateTo` add approvers when
 * the level is overdue (the original approvers keep their seat).
 */
/**
 * Approver types that resolve to ONE seat — one person (their delegate acts in the same seat): the manager, the secondary
 * manager, the manager N levels up, the department head and a named user. A quorum above 1 (or ALL with a count above 1)
 * can never be reached on them, so the workflow is refused when it is saved rather than every request failing later.
 */
export const SINGLE_SEAT_APPROVER_TYPES = ['MANAGER', 'SECONDARY_MANAGER', 'MANAGER_CHAIN', 'DEPARTMENT_HEAD', 'USER'] as const satisfies readonly ApproverType[];
export function isSingleSeatApproverType(type: ApproverType): boolean {
  return (SINGLE_SEAT_APPROVER_TYPES as readonly string[]).includes(type);
}
export const SINGLE_SEAT_QUORUM_MESSAGE = 'This approver type resolves to one approver: it cannot require more than 1 approval';

export const approvalWorkflowStepSchema = z.object({
  order: z.number().int().min(1).max(5),
  approverType: z.enum(APPROVER_TYPES),
  roleId: uuidSchema.optional(),
  userId: uuidSchema.optional(),
  permission: z.enum(PERMISSIONS).optional(),
  chainLevel: z.number().int().min(1).max(10).optional(),
  mode: z.enum(APPROVAL_STEP_MODES).default('ANY'),
  requiredCount: z.number().int().min(1).max(50).optional(),
  escalateAfterHours: z.number().int().min(1).max(24 * 30).optional(),
  escalateTo: z.enum(APPROVAL_ESCALATION_TARGETS).optional(),
}).superRefine((v, ctx) => {
  if (v.approverType === 'ROLE' && !v.roleId && !v.permission) ctx.addIssue({ code: 'custom', path: ['roleId'], message: 'A ROLE step names a role or a permission' });
  if (v.approverType === 'USER' && !v.userId) ctx.addIssue({ code: 'custom', path: ['userId'], message: 'Required for USER steps' });
  if (v.mode === 'QUORUM' && !v.requiredCount) ctx.addIssue({ code: 'custom', path: ['requiredCount'], message: 'A quorum needs the number of approvals required' });
  // a single-seat approver can never give 2 approvals: saving it would make every submission fail (review P2-7)
  if (isSingleSeatApproverType(v.approverType) && (v.mode === 'QUORUM' || v.mode === 'ALL') && (v.requiredCount ?? 1) > 1) ctx.addIssue({ code: 'custom', path: ['requiredCount'], message: SINGLE_SEAT_QUORUM_MESSAGE });
  if ((v.escalateAfterHours === undefined) !== (v.escalateTo === undefined)) ctx.addIssue({ code: 'custom', path: ['escalateTo'], message: 'Escalation needs both a delay and a target' });
});
export type ApprovalWorkflowStep = z.infer<typeof approvalWorkflowStepSchema>;
export type ApprovalWorkflowStepInput = z.input<typeof approvalWorkflowStepSchema>;

export const approvalAppliesToSchema = z.object({
  branchIds: z.array(uuidSchema).max(200).optional(),
  departmentIds: z.array(uuidSchema).max(200).optional(),
});
export type ApprovalAppliesTo = z.infer<typeof approvalAppliesToSchema>;

export const approvalWorkflowInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  entityType: z.enum(APPROVAL_ENTITIES).default('ATTENDANCE_CORRECTION'),
  branchId: uuidSchema.nullable().optional(),
  isDefault: z.boolean().default(true),
  status: z.enum(RECORD_STATUSES).default('active'),
  steps: z.array(approvalWorkflowStepSchema).min(1).max(5),
  /** Optional narrowing inside the branch scope: only requests of these branches / departments use the workflow. */
  appliesTo: approvalAppliesToSchema.default({}),
  /** Tier threshold in the entity's units (leave days, overtime minutes): the workflow applies from this size up; the highest applicable minimum wins. */
  minUnits: z.number().min(0).max(1_000_000).nullable().optional(),
  // No self-approval switch (review P0-3): segregation of duties is not configurable. The only exception is the
  // organisation owner deciding their own request, which the engine logs as `sod_owner_bypass`.
});
export type ApprovalWorkflowInput = z.infer<typeof approvalWorkflowInputSchema>;
/** PATCH body: no defaults, so a rename never flips isDefault/status/entityType (AGENTS.md Zod 4 pitfall). */
export const approvalWorkflowUpdateSchema = updateSchemaOf<ApprovalWorkflowInput>(approvalWorkflowInputSchema.shape);

export interface ApprovalWorkflowDto {
  id: string; organizationId: string; entityType: ApprovalEntity; name: string; branchId: string | null; steps: ApprovalWorkflowStep[];
  appliesTo: ApprovalAppliesTo; minUnits: number | null;
  /** Always false: self-approval is not configurable (review P0-3); kept so existing clients keep parsing the shape. */
  allowSelfApproval: boolean;
  isDefault: boolean; status: string; createdAt: string; updatedAt: string;
}

// ----- queries and commands -----------------------------------------------------------------------------------------------

export const APPROVAL_INBOX_VIEWS = ['pending', 'history'] as const;
export type ApprovalInboxView = (typeof APPROVAL_INBOX_VIEWS)[number];

/** GET /orgs/:orgId/approvals — pending queue or history, scoped to mine | team | all. */
export const approvalInboxQuerySchema = paginationQuerySchema.extend({
  scope: z.enum(APPROVAL_INBOX_SCOPES).default('mine'),
  view: z.enum(APPROVAL_INBOX_VIEWS).default('pending'),
  status: z.enum(APPROVAL_REQUEST_STATUSES).optional(),
  entityType: z.enum(APPROVAL_ENTITIES).optional(),
  employeeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  /** The employee's name or number (matched in the organisation's scope; the rows stay the caller's RLS view). */
  search: z.string().trim().max(100).optional(),
});
export type ApprovalInboxQuery = z.infer<typeof approvalInboxQuerySchema>;
/** GET /orgs/:orgId/approvals/history/export — the History view as CSV (report.export), at most this many rows. */
export const APPROVAL_HISTORY_EXPORT_MAX_ROWS = 5000;

/** GET /orgs/:orgId/approvals/mine — requests I filed or that are about me. */
export const myApprovalsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(APPROVAL_REQUEST_STATUSES).optional(),
  entityType: z.enum(APPROVAL_ENTITIES).optional(),
});
export type MyApprovalsQuery = z.infer<typeof myApprovalsQuerySchema>;

/**
 * The refusal an override (or an escalated approver) gets on an ALL / QUORUM level with several seats still waiting when it
 * does not say whose seat it fills (issue path `onBehalfOfUserId`). Shared so every client can recognise it.
 */
export const APPROVAL_SEAT_CHOICE_MESSAGE = 'Choose which approver you are deciding for';

/**
 * POST /orgs/:orgId/approvals/:id/decide. `stepNo` is REQUIRED and must be the level the caller saw (review P1-2): a
 * level that is no longer current is refused (409), never re-targeted to the next one; an actor repeating their own
 * decision is a no-op. `onBehalfOfUserId` names the pending seat an organisation-wide approver's override (or an escalated
 * approver's decision) fills — one seat per call (review P0-1). It is REQUIRED when the level is ALL or QUORUM and more
 * than one seat is waiting (`abilities.mustChooseSeat`; 400 `APPROVAL_SEAT_CHOICE_MESSAGE` otherwise); on an ANY level or
 * a single waiting seat it defaults to the first seat of `pendingSeats`.
 */
export const approvalDecideSchema = z.object({
  stepNo: z.number().int().min(1).max(5),
  decision: z.enum(APPROVAL_DECISIONS),
  comment: z.string().trim().max(1000).optional(),
  onBehalfOfUserId: uuidSchema.optional(),
  /** ATTENDANCE_NOTE rejections only: the pay effect of the day (0 = none, the default; 0.5 / 1 = half / full day charged). */
  payEffectDays: z.union([z.literal(0), z.literal(0.5), z.literal(1)]).optional(),
});
export type ApprovalDecideInput = z.infer<typeof approvalDecideSchema>;
/** POST /orgs/:orgId/approvals/bulk-decide — the same decision on several requests' current levels (Finance ATT-95: through the engine, one request at a time, never client-side). */
export const APPROVAL_BULK_DECIDE_MAX = 100;
/**
 * One line of a bulk decision: the request and the level the caller saw (review P1-2 — never re-targeted to a later level),
 * plus the seat an override fills when the level needs one named (a line that needs it and lacks it fails on its own).
 */
export const approvalBulkDecideItemSchema = z.object({ requestId: uuidSchema, stepNo: z.number().int().min(1).max(5), onBehalfOfUserId: uuidSchema.optional() });
export const approvalBulkDecideSchema = z.object({
  items: z.array(approvalBulkDecideItemSchema).min(1).max(APPROVAL_BULK_DECIDE_MAX),
  decision: z.enum(APPROVAL_DECISIONS),
  comment: z.string().trim().max(1000).optional(),
}).refine((v) => v.decision !== 'REJECT' || !!v.comment, { message: 'A comment is required when rejecting.', path: ['comment'] })
  .refine((v) => new Set(v.items.map((i) => i.requestId)).size === v.items.length, { message: 'Each request can appear once.', path: ['items'] });
export type ApprovalBulkDecideInput = z.infer<typeof approvalBulkDecideSchema>;
/** POST /orgs/:orgId/approvals/:id/cancel — withdrawing a request always says why (Finance B-98). */
export const approvalCancelSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const approvalReassignSchema = z.object({
  stepNo: z.number().int().min(1).max(5).optional(),
  userId: uuidSchema,
  reason: z.string().trim().min(3).max(500),
});
export type ApprovalReassignInput = z.infer<typeof approvalReassignSchema>;
export const approvalInfoSchema = z.object({ comment: z.string().trim().min(1).max(1000) });
/** POST /orgs/:orgId/approvals/:id/bypass — approval.manage approves a pending request as an exception (Finance B-99); the reason is mandatory. */
export const approvalBypassSchema = z.object({ reason: z.string().trim().min(3).max(1000) });
export type ApprovalBypassInput = z.infer<typeof approvalBypassSchema>;
/** POST /orgs/:orgId/approvals/email-action — the one-click token from an "awaiting your approval" e-mail. Never acts on GET. */
export const approvalEmailActionSchema = z.object({
  token: z.string().min(16).max(256),
  action: z.enum(APPROVAL_DECISIONS),
  comment: z.string().trim().max(1000).optional(),
});
export type ApprovalEmailActionInput = z.infer<typeof approvalEmailActionSchema>;

export const approvalDelegationInputSchema = z.object({
  delegateUserId: uuidSchema,
  /** approval.manage only: create the delegation on somebody else's behalf. */
  delegatorUserId: uuidSchema.optional(),
  /** null / omitted = every entity type. */
  entityTypes: z.array(z.enum(APPROVAL_ENTITIES)).min(1).max(20).nullable().optional(),
  startsOn: isoDateSchema,
  endsOn: isoDateSchema,
  reason: z.string().trim().max(500).optional(),
}).refine((v) => v.endsOn >= v.startsOn, { message: 'endsOn must be on/after startsOn', path: ['endsOn'] });
export type ApprovalDelegationInput = z.infer<typeof approvalDelegationInputSchema>;
export const approvalDelegationListQuerySchema = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  activeOnly: booleanQuerySchema.default(false),
});

// ----- DTOs ----------------------------------------------------------------------------------------------------------------

export interface ApprovalActorDto {
  userId: string; userName: string | null; viaDelegationOf: string | null; viaDelegationOfName: string | null;
  /**
   * The seat an override or an escalated approver decided for (they fill exactly one pending seat of the level). Always
   * sent by the API (null when the row is the person's own seat); optional in the type so older fixtures keep compiling.
   */
  onBehalfOfUserId?: string | null; onBehalfOfName?: string | null;
  resolutionPath: string | null; decision: ApprovalStatus; decidedAt: string | null; comment: string | null;
}
/** A seat of a level: the approver whose decision it is (a delegate or an override decides IN a seat). */
export interface ApprovalSeatDto { userId: string; userName: string | null }
export interface ApprovalStepDto {
  id: string; requestId: string; stepNo: number; approverType: ApproverType; approverRoleId: string | null; approverUserId: string | null; permissionKey: string | null;
  mode: ApprovalStepMode; requiredCount: number | null; status: ApprovalStatus; resolutionPath: string | null; resolutionReason: string | null;
  activatedAt: string | null; dueAt: string | null; escalateTo: ApprovalEscalationTarget | null; escalatedAt: string | null; remindedAt: string | null;
  actedBy: string | null; actedByName: string | null; actedAt: string | null; comment: string | null;
  /** Actor rows in a deterministic order: when each was written, then the person's user id. */
  actors: ApprovalActorDto[];
  /**
   * The seats still waiting, in SEAT ORDER (when the seat's first row was written, then the approver's user id): the order
   * an override's seat is chosen from, the first being the default target where no choice is required. Always sent by the
   * API; optional in the type so older fixtures keep compiling.
   */
  pendingSeats?: ApprovalSeatDto[];
}
export interface ApprovalTimelineEventDto { id: string; at: string; actorUserId: string | null; actorName: string | null; kind: string; detail: Record<string, unknown> }

/** What the inbox shows next to a request, per entity type. Types added by later prompts fall back to GENERIC. */
export type ApprovalContextDto =
  | { kind: 'ATTENDANCE_CORRECTION'; correction: { id: string; attendanceDate: string; type: string; originalPunchedAt: string | null; proposedPunchedAt: string | null; proposedEventType: string | null; proposedStatus: string | null; reason: string; status: string; requestedBy: string | null; rejectionReason: string | null } }
  | { kind: 'LEAVE'; leave: { id: string; leaveTypeId: string; leaveTypeName: string; startDate: string; endDate: string; isHalfDay: boolean; halfDayPart: string | null; days: number | null; reason: string | null; status: string; balanceRemainingDays: number | null; allowanceDays: number | null } }
  // HR portal Prompt 4 — every new kind carries `summary` too, so an inbox that predates it falls back to the text
  | { kind: 'ATTENDANCE_NOTE'; summary: string | null; note: { id: string; attendanceDate: string; category: string; note: string; status: string; dayStatus: string | null; dayFlags: string[]; excusedCountYear: number; payEffectDays: number | null; lossOfPay: boolean; infoRequestMessage: string | null } }
  | { kind: 'REGULARISATION'; summary: string | null; regularisation: { id: string; attendanceDate: string; type: string; proposedInAt: string | null; proposedOutAt: string | null; reason: string; status: string; timezone: string | null } }
  | { kind: 'SHIFT_SWAP'; summary: string | null; swap: { id: string; swapDate: string; requesterName: string | null; targetName: string | null; requesterShiftName: string | null; targetShiftName: string | null; reason: string; status: string } }
  | { kind: 'GENERIC'; entityType: ApprovalEntity; summary: string | null }
  // leave v2 (Prompt 7): a comp-off credit request — the worked day, its type, the minutes and the days it earns
  | { kind: 'COMP_OFF'; compOff: { id: string; workedOn: string; workedOnType: string; workedMinutes: number; recordedMinutes: number | null; daysEarned: number; location: string; summary: string; status: string } };

/**
 * How the caller would decide the current level: in their own seat (`actor`), in the seat of somebody who delegates to them
 * (`delegate`), as an approver added by escalation (`escalated`), or as an organisation-wide approver / the owner
 * (`override`). `escalated` and `override` fill ONE pending seat of the level: the one the call names — which it must do
 * when `mustChooseSeat` is true — else the first of the step's `pendingSeats`.
 */
export type ApprovalDecideVia = 'actor' | 'delegate' | 'escalated' | 'override';
/**
 * What the caller may do with the request right now (the API enforces every one of these again). `mustChooseSeat`: the
 * caller's decision is an override / escalated one on an ALL or QUORUM level with several seats waiting, so it must name
 * the seat it fills (`onBehalfOfUserId`, one of the current step's `pendingSeats`).
 */
export interface ApprovalAbilitiesDto { canDecide: boolean; canCancel: boolean; canReassign: boolean; canBypass: boolean; canRequestInfo: boolean; canAnswerInfo: boolean; actingAsDelegateOf: string | null; decideVia?: ApprovalDecideVia | null; mustChooseSeat?: boolean }

export interface ApprovalRequestDto {
  id: string; organizationId: string; workflowId: string | null; workflowName: string | null; entityType: ApprovalEntity; entityId: string;
  branchId: string | null; departmentId: string | null; employeeId: string | null; employeeName: string | null; employeeNumber: string | null; units: number | null;
  currentStep: number; stepCount: number; status: ApprovalRequestStatus; requestedBy: string | null; requestedByName: string | null; subjectUserId: string | null;
  infoRequestedAt: string | null; completedAt: string | null; decidedBy: string | null; decidedByName: string | null; cancelReason: string | null; invalidationReason: string | null;
  createdAt: string; updatedAt: string;
  steps: ApprovalStepDto[];
  context: ApprovalContextDto;
  abilities: ApprovalAbilitiesDto;
  /** Present on GET /approvals/:id (the timeline); omitted from lists. */
  events?: ApprovalTimelineEventDto[];
}

export interface ApprovalDelegationDto {
  id: string; organizationId: string; delegatorUserId: string; delegatorName: string | null; delegateUserId: string; delegateName: string | null;
  entityTypes: ApprovalEntity[] | null; startsOn: string; endsOn: string; isActive: boolean; reason: string | null; createdAt: string; revokedAt: string | null;
}

export interface ApprovalDecideResultDto extends ApprovalRequestDto {
  /** True when the call changed nothing (already decided by this actor, step already satisfied). */
  noop: boolean;
  /** For a rejection under ANY/QUORUM: false while the level can still be satisfied by the remaining approvers. */
  terminal: boolean;
}

/** One line per request of a bulk decision: decided (or a harmless no-op), or refused with the API's own error code and message. */
export interface ApprovalBulkDecideItemDto { requestId: string; ok: boolean; status: ApprovalRequestStatus | null; noop: boolean; code: string | null; message: string | null }
export interface ApprovalBulkDecideResultDto { results: ApprovalBulkDecideItemDto[]; succeeded: number; failed: number }

/**
 * Legacy aliases /approve and /reject: v1 decision body ({ comment }) plus an optional `stepNo`. Without it the caller may
 * decide only a seat they hold on the current level — never an organisation-wide override (review P1-2).
 */
export const approvalLegacyDecisionSchema = z.object({ comment: z.string().max(1000).optional(), stepNo: z.number().int().min(1).max(5).optional() });
