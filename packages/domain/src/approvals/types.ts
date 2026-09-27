/**
 * Approval engine v2 — pure resolution rules (no IO). The API builds a `ResolutionContext` from the database and the
 * engine turns each workflow level into the people who may decide it; `evaluateLevel` says when a level is done.
 */
export type ApprovalStepModeSpec = 'ANY' | 'ALL' | 'QUORUM';
export type ApprovalEscalationSpec = 'NEXT_STEP' | 'HR_ADMIN' | 'OWNER';
export type ApproverTypeSpec = 'MANAGER' | 'SECONDARY_MANAGER' | 'MANAGER_CHAIN' | 'HR_ADMIN' | 'DEPARTMENT_HEAD' | 'BRANCH_MANAGER' | 'ROLE' | 'USER';

/** One configured level (mirrors `approvalWorkflowStepSchema` in @flowza/contracts). */
export interface ApprovalStepSpec {
  order: number;
  approverType: ApproverTypeSpec;
  roleId?: string | undefined;
  userId?: string | undefined;
  permission?: string | undefined;
  chainLevel?: number | undefined;
  mode: ApprovalStepModeSpec;
  requiredCount?: number | undefined;
  escalateAfterHours?: number | undefined;
  escalateTo?: ApprovalEscalationSpec | undefined;
}

/** A person in the reporting line considered as an approver. `absent` = on approved leave today (membership is checked separately). */
export interface ApproverCandidate { employeeId: string | null; userId: string | null; absent: boolean; absentReason: string | null }
/** Rung k of the subject's chain: the primary manager at that level and the secondary manager of the same employee record (the substitute). */
export interface ChainRung { primary: ApproverCandidate | null; secondary: ApproverCandidate | null }

export interface ResolutionContext {
  /** The employee the request is about (null for requests without a subject). */
  subjectEmployeeId: string | null;
  /** The login linked to that employee (never an approver, segregation of duties). */
  subjectUserId: string | null;
  /** Who filed the request (excluded unless nobody else can decide and the request has a subject). */
  requestedBy: string | null;
  /** chain[0] = the subject's own managers, chain[1] = the managers of chain[0].primary's employee record, … (primary links only). */
  chain: readonly ChainRung[];
  departmentHead: ApproverCandidate | null;
  branchManagerUserIds: readonly string[];
  hrAdminUserIds: readonly string[];
  ownerUserIds: readonly string[];
  /** Active members of the organisation: anybody outside this set cannot hold a seat. */
  activeUserIds: ReadonlySet<string>;
  roleMemberUserIds: (roleId: string) => readonly string[];
  permissionHolderUserIds: (permission: string) => readonly string[];
  /** The colleague an approver delegates to today (entity type already applied), or null. */
  delegateOf: (userId: string) => string | null;
  /** Workflow flag: the subject may decide their own request (off by default). */
  allowSelfApproval?: boolean;
}

export interface ResolvedActor { userId: string; viaDelegationOf: string | null }
export type ResolutionPath = 'primary' | 'secondary' | 'hr_admin' | 'owner' | 'department_head' | 'branch_manager' | 'role' | 'permission' | 'user' | `chain_step_${number}` | 'chain_top' | 'unresolved';
export interface StepResolution {
  actors: ResolvedActor[];
  path: ResolutionPath;
  reason: string | null;
  /** Distinct seats (a delegate shares the seat of the approver they act for). */
  seatCount: number;
  /** ANY → 1, QUORUM → the configured count, ALL → null (every seat). */
  requiredCount: number | null;
  /** True when even the owner ladder produced nobody: the caller refuses the submission. */
  unresolved: boolean;
}

export type SeatDecision = 'APPROVED' | 'REJECTED' | 'PENDING';
export type LevelOutcome = 'satisfied' | 'rejected' | 'open';
