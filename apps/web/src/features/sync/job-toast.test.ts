import { beforeEach, describe, expect, it, vi } from 'vitest';

// hoisted so the vi.mock factory can reference it
const toastMock = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock, toastQueued: vi.fn(), toastError: vi.fn() }));

import '@/lib/i18n';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/sync.json';
import ar from '@/locales/ar/sync.json';
import { toastJobAccepted } from './job-toast';

registerNamespace('sync', en, ar);

const accepted = { jobId: 'job-1', status: 'QUEUED' as const, message: 'queued', itemsTotal: 3, itemsQueued: 2, itemsSkipped: 1, deviceCount: 3 };

describe('toastJobAccepted', () => {
  beforeEach(() => { toastMock.success.mockReset(); toastMock.info.mockReset(); });

  it('announces a queued job with a link to /sync/:jobId and mentions skipped items', () => {
    const navigate = vi.fn();
    toastJobAccepted(accepted, navigate, 'Queued 3 items on 3 devices');
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.success.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }];
    expect(title).toBe('Queued successfully');
    expect(opts.description).toBe('Queued 3 items on 3 devices · 1 already in flight');
    opts.action.onClick();
    expect(navigate).toHaveBeenCalledWith('/sync/job-1');
  });

  it('does not claim a new job was queued when everything was already in flight (status SUCCESS, nothing queued)', () => {
    toastJobAccepted({ ...accepted, status: 'SUCCESS', itemsQueued: 0, itemsSkipped: 3 }, vi.fn());
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.info).toHaveBeenCalledWith('Nothing new was queued', expect.objectContaining({ action: expect.objectContaining({ label: 'View job' }) }));
  });
});
