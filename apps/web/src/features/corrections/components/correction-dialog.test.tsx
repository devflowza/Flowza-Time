import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import enAtt from '@/locales/en/attendance.json';
import arAtt from '@/locales/ar/attendance.json';
import en from '@/locales/en/corrections.json';
import ar from '@/locales/ar/corrections.json';
import { CorrectionDialog } from './correction-dialog';
import { localToUtcIso } from '../time';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('corrections', en, ar);

const EMP = '11111111-1111-4111-8111-111111111111';
const branch = { id: 'b1', organizationId: 'org-1', code: 'DXB', name: 'Dubai', nameAr: null, countryCode: 'AE', city: null, address: {}, timezone: 'Asia/Dubai', latitude: null, longitude: null, geofenceRadiusM: null, contact: {}, weeklyOffDays: null, holidayCalendarId: null, status: 'active', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' };

describe('localToUtcIso', () => {
  it('converts a branch-local wall-clock time to UTC with Luxon (no hand-computed offsets)', () => {
    expect(localToUtcIso('2024-03-01', '08:30', 'Asia/Muscat')).toBe('2024-03-01T04:30:00.000Z');
    expect(localToUtcIso('2024-03-01', '00:15', 'Asia/Riyadh')).toBe('2024-02-29T21:15:00.000Z');
    expect(localToUtcIso('2024-03-01', '', 'Asia/Muscat')).toBeNull();
    expect(localToUtcIso('bad', '08:30', 'Asia/Muscat')).toBeNull();
  });
});

describe('CorrectionDialog', () => {
  beforeEach(() => {
    resetApiMock(); grantAll();
    mockGet({ '/orgs/org-1/employees': page([]), [`/orgs/org-1/employees/${EMP}`]: { data: { id: EMP, branchId: 'b1', displayName: 'Ali', employeeNumber: '1001' } }, '/orgs/org-1/branches': page([branch]), '/orgs/org-1/attendance/events': { data: [] } });
  });

  it('validates with createCorrectionSchema (reason ≥ 3, punch time required) and converts the branch-local punch time to UTC', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'c1', approval: 'PENDING', approvalRequestId: 'ar1' } });
    const onOpenChange = vi.fn();
    renderWithProviders(<CorrectionDialog open onOpenChange={onOpenChange} preset={{ employeeId: EMP, employeeName: 'Ali', attendanceDate: '2024-03-01' }} />);

    // the employee's branch timezone is resolved and shown next to the time input
    await screen.findByLabelText(/Punch time \(Asia\/Dubai\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(2)); // proposedPunchedAt + reason
    expect(apiMock.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Punch time/), { target: { value: '08:30' } });
    expect(screen.getByTestId('utc-preview')).toHaveTextContent('2024-03-01T04:30:00.000Z');
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'ok' } }); // too short
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(1));
    expect(apiMock.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Forgot to badge in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body, opts] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/attendance/corrections');
    expect(body).toMatchObject({ employeeId: EMP, attendanceDate: '2024-03-01', type: 'ADD_PUNCH', proposedPunchedAt: '2024-03-01T04:30:00.000Z', proposedEventType: 'PUNCH', reason: 'Forgot to badge in' });
    expect(body).not.toHaveProperty('originalEventId');
    expect(opts).toMatchObject({ idempotencyKey: expect.any(String) });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('switches fields with the correction type: SET_STATUS needs a status, REMOVE_PUNCH an existing event', async () => {
    renderWithProviders(<CorrectionDialog open onOpenChange={() => {}} preset={{ employeeId: EMP, attendanceDate: '2024-03-01', timezone: 'Asia/Muscat' }} />);
    const typeTrigger = await screen.findByRole('combobox', { name: /Correction type/ });
    fireEvent.keyDown(typeTrigger, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Set status' }));
    expect(screen.queryByLabelText(/Punch time/)).not.toBeInTheDocument();
    expect(screen.getByText('New status')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Training day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await screen.findByText('Required for SET_STATUS');
    expect(apiMock.post).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('combobox', { name: /Correction type/ }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Remove punch' }));
    expect(screen.getByText('Original event')).toBeInTheDocument();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/orgs/org-1/attendance/events', { employeeId: EMP, from: '2024-02-29', to: '2024-03-02' }));
  });
});
