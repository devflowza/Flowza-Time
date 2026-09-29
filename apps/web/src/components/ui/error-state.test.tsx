import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@/lib/i18n';
import { ApiError, FEATURE_UNAVAILABLE, NETWORK_ERROR_STATUS } from '@/lib/api-client';
import { ErrorState } from './error-state';

vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

describe('ErrorState', () => {
  it('shows an endpoint the API does not serve yet as "not available yet", not as an error', () => {
    const onRetry = vi.fn();
    render(<ErrorState error={new ApiError(404, FEATURE_UNAVAILABLE, 'Not available yet', 'req_uZ')} onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent('Not available yet');
    expect(screen.queryByRole('alert')).toBeNull();
    // no router wording, and no request id to send to support: there is nothing to report
    expect(document.body).not.toHaveTextContent(/route not found/i);
    expect(document.body).not.toHaveTextContent('req_uZ');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps real failures as an alert with the request id', () => {
    render(<ErrorState error={new ApiError(500, 'INTERNAL', 'Something broke.', 'req_9')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke.');
    expect(screen.getByRole('alert')).toHaveTextContent('req_9');
  });

  it('does not ask for a request id when the API could not be reached', () => {
    render(<ErrorState error={new ApiError(NETWORK_ERROR_STATUS, 'NETWORK_ERROR', 'Could not reach the API')} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('request id');
  });
});
