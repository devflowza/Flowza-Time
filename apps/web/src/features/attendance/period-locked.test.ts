import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() }, toastError: vi.fn(), toastQueued: vi.fn() }));

import { ApiError } from '@/lib/api-client';
import { toast, toastError } from '@/lib/toast';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/attendance.json';
import ar from '@/locales/ar/attendance.json';
import { isPeriodLockedError, toastMutationError } from './period-locked';

registerNamespace('attendance', en, ar);

describe('toastMutationError', () => {
  beforeEach(() => { vi.mocked(toast.error).mockReset(); vi.mocked(toastError).mockReset(); });

  it('explains a PERIOD_LOCKED rejection and links to the period locks tab', () => {
    const navigate = vi.fn();
    const err = new ApiError(409, 'PERIOD_LOCKED', 'The attendance period is locked.', 'req-9');
    expect(isPeriodLockedError(err)).toBe(true);
    toastMutationError(err, navigate);
    expect(toastError).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [title, opts] = vi.mocked(toast.error).mock.calls[0] as [string, { description: string; action?: { label: string; onClick: () => void } }];
    expect(title).toBe('Period is locked');
    expect(opts.description).toContain('Unlock the period under Attendance → Period locks');
    expect(opts.description).toContain('req-9');
    expect(opts.action?.label).toBe('View period locks');
    opts.action?.onClick();
    expect(navigate).toHaveBeenCalledWith('/attendance?tab=periods');
  });

  it('falls back to the generic error toast for every other failure', () => {
    const err = new ApiError(400, 'VALIDATION_ERROR', 'Bad input');
    expect(isPeriodLockedError(err)).toBe(false);
    toastMutationError(err);
    expect(toastError).toHaveBeenCalledWith(err);
    expect(toast.error).not.toHaveBeenCalled();
    toastMutationError(new Error('boom'));
    expect(toastError).toHaveBeenCalledTimes(2);
  });
});
