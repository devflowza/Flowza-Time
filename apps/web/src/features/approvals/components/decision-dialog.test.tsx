import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import enAtt from '@/locales/en/attendance.json';
import arAtt from '@/locales/ar/attendance.json';
import en from '@/locales/en/approvals.json';
import ar from '@/locales/ar/approvals.json';
import { DecisionDialog } from './decision-dialog';
import type { InboxItem } from '../api';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('approvals', en, ar);

const item: InboxItem = {
  stepId: 's1', stepNo: 1, approverType: 'MANAGER', requestId: 'req-1', entityType: 'ATTENDANCE_CORRECTION', entityId: 'c1', branchId: 'b1', employeeId: 'e1', currentStep: 1, requestedBy: 'u2', requestedByName: 'Sara', createdAt: '2024-03-02T08:00:00Z',
  correction: { id: 'c1', employeeId: 'e1', branchId: 'b1', attendanceDate: '2024-03-01', type: 'ADD_PUNCH', originalEventId: null, originalPunchedAt: null, proposedPunchedAt: '2024-03-01T04:30:00Z', proposedEventType: 'PUNCH', proposedStatus: null, reason: 'Forgot badge', status: 'PENDING', requestedBy: 'u2', approvalRequestId: 'req-1', appliedEventId: null, appliedAt: null, rejectionReason: null, createdAt: '2024-03-02T08:00:00Z', updatedAt: '2024-03-02T08:00:00Z', employeeName: 'Ali', employeeNumber: '1001' },
};

describe('DecisionDialog', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({}); });

  it('requires a comment to reject and posts it to /approvals/:requestId/reject', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'req-1', status: 'REJECTED', steps: [], correction: null } });
    const onClose = vi.fn();
    renderWithProviders(<DecisionDialog item={item} decision="reject" timezone="Asia/Muscat" onClose={onClose} />);
    expect(screen.getByText('Reject correction')).toBeInTheDocument();
    expect(screen.getAllByText('Ali').length).toBeGreaterThan(0);
    expect(screen.getByText(/new punch → 01 Mar 08:30/)).toBeInTheDocument(); // proposed vs original in the branch timezone
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Comment/), { target: { value: 'No evidence' } });
    expect(reject).toBeEnabled();
    fireEvent.click(reject);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/approvals/req-1/reject', { comment: 'No evidence' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('approves without a comment', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'req-1', status: 'APPROVED', steps: [], correction: null } });
    renderWithProviders(<DecisionDialog item={item} decision="approve" timezone="Asia/Muscat" onClose={() => {}} />);
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/approvals/req-1/approve', { comment: undefined }));
  });
});
