import type { ApprovalRequestDto, ApprovalStepDto } from '@flowza/contracts';

/** Test data for the approvals feature (no application imports: safe to use next to vi.mock). */
export function approvalStep(over: Partial<ApprovalStepDto> = {}): ApprovalStepDto {
  return {
    id: 'step-1', requestId: 'req-1', stepNo: 1, approverType: 'MANAGER', approverRoleId: null, approverUserId: 'u1', permissionKey: null, mode: 'ANY', requiredCount: 1, status: 'PENDING',
    resolutionPath: 'primary', resolutionReason: null, activatedAt: '2024-03-02T08:00:00Z', dueAt: null, escalateTo: null, escalatedAt: null, remindedAt: null, actedBy: null, actedByName: null, actedAt: null, comment: null,
    actors: [{ userId: 'u1', userName: 'Dev', viaDelegationOf: null, viaDelegationOfName: null, onBehalfOfUserId: null, onBehalfOfName: null, resolutionPath: 'primary', decision: 'PENDING', decidedAt: null, comment: null }],
    ...over,
  };
}

export function approvalRequest(over: Partial<ApprovalRequestDto> = {}): ApprovalRequestDto {
  const id = over.id ?? 'req-1';
  return {
    id, organizationId: 'org-1', workflowId: null, workflowName: null, entityType: 'ATTENDANCE_CORRECTION', entityId: `ent-${id}`, branchId: 'b1', departmentId: null, employeeId: 'e1', employeeName: 'Ali', employeeNumber: '1001', units: null,
    currentStep: 1, stepCount: 1, status: 'PENDING', requestedBy: 'u2', requestedByName: 'Sara', subjectUserId: 'u3', infoRequestedAt: null, completedAt: null, decidedBy: null, decidedByName: null, cancelReason: null, invalidationReason: null,
    createdAt: '2024-03-02T08:00:00Z', updatedAt: '2024-03-02T08:00:00Z',
    steps: [approvalStep({ requestId: id })],
    context: { kind: 'ATTENDANCE_CORRECTION', correction: { id: `ent-${id}`, attendanceDate: '2024-03-01', type: 'ADD_PUNCH', originalPunchedAt: null, proposedPunchedAt: '2024-03-01T04:30:00Z', proposedEventType: 'PUNCH', proposedStatus: null, reason: 'Forgot badge', status: 'PENDING', requestedBy: 'u2', rejectionReason: null } },
    abilities: { canDecide: true, canCancel: false, canReassign: false, canBypass: false, canRequestInfo: true, canAnswerInfo: false, actingAsDelegateOf: null },
    ...over,
  };
}

export const leaveContext = (over: Partial<Extract<ApprovalRequestDto['context'], { kind: 'LEAVE' }>['leave']> = {}): ApprovalRequestDto['context'] => ({
  kind: 'LEAVE', leave: { id: 'l1', leaveTypeId: 'lt1', leaveTypeName: 'Annual Leave', startDate: '2024-03-10', endDate: '2024-03-12', isHalfDay: false, halfDayPart: null, days: 3, reason: 'Family visit', status: 'PENDING', balanceRemainingDays: 20, allowanceDays: 30, ...over },
});
