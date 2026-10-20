import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { toast } from 'sonner';
import { ApiError } from './api-client';
import { toastError } from './toast';

describe('toastError', () => {
  beforeEach(() => { vi.mocked(toast.error).mockReset(); vi.mocked(toast.info).mockReset(); });

  it('says "permission denied" for an action the role does not carry, without the API\'s key names or a request id', () => {
    toastError(new ApiError(403, 'FORBIDDEN', 'Missing permission: employee.update.', 'req_1'));
    expect(toast.error).toHaveBeenCalledWith('Permission denied', { description: 'You do not have permission to do this.' });
  });

  it('keeps the API\'s sentence when it explains the refusal, under the same "permission denied" title', () => {
    toastError(new ApiError(403, 'FORBIDDEN', 'You cannot approve or reject your own request; cancel it instead.', 'req_5'));
    expect(toast.error).toHaveBeenCalledWith('Permission denied', { description: 'You cannot approve or reject your own request; cancel it instead.' });
    toastError(new ApiError(403, 'FORBIDDEN', 'No organisation-wide permission — and the employee is not one of your direct reports.', 'req_6'));
    expect(toast.error).toHaveBeenLastCalledWith('Permission denied', { description: 'You do not have permission to do this.' });
  });

  it('names the module the organisation does not have', () => {
    toastError(new ApiError(403, 'FEATURE_DISABLED', 'Module off.', 'req_2', { reason: 'MODULE_DISABLED', module: 'leave' }));
    expect(toast.error).toHaveBeenCalledWith('Leave management is not part of your subscription', expect.objectContaining({ description: expect.stringContaining('switched off') }));
  });

  it('keeps policy refusals (MFA step-up, regularisation switched off) and every other failure as the API worded them', () => {
    toastError(new ApiError(409, 'CONFLICT', 'The code is already in use.', 'req_3'));
    expect(toast.error).toHaveBeenLastCalledWith('The code is already in use.', { description: 'Request req_3' });
    toastError(new ApiError(403, 'FORBIDDEN', 'Verify with your authenticator.', 'req_4', { reason: 'MFA_REQUIRED' }));
    expect(toast.error).toHaveBeenLastCalledWith('Verify with your authenticator.', { description: 'Request req_4' });
    toastError(new ApiError(403, 'FORBIDDEN', 'Regularisation requests are turned off for this organisation.', 'req_7', { reason: 'REGULARISATION_DISABLED' }));
    expect(toast.error).toHaveBeenLastCalledWith('Regularisation requests are turned off for this organisation.', { description: 'Request req_7' });
  });
});
