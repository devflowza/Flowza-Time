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

  it('shows a permission the role does not carry as "permission denied", without the API\'s wording, a retry or a request id', () => {
    const onRetry = vi.fn();
    render(<ErrorState error={new ApiError(403, 'FORBIDDEN', 'Missing permission: attendance.view_own.', 'req_DVG')} onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent('Permission denied');
    expect(screen.getByRole('status')).toHaveTextContent('You do not have permission to view this information.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body).not.toHaveTextContent('Missing permission');
    expect(document.body).not.toHaveTextContent('req_DVG');
    expect(document.body).not.toHaveTextContent(/contact support/i);
    // the answer will not change on a retry
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows a module the organisation does not have as the module state, not as an error', () => {
    render(<ErrorState error={new ApiError(403, 'FEATURE_DISABLED', 'Module off.', 'req_M', { reason: 'MODULE_DISABLED', module: 'leave' })} onRetry={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Leave management is not part of your subscription');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body).not.toHaveTextContent('req_M');
  });

  it('shows a record that is gone or outside the member\'s scope as "not found", without a retry or a request id', () => {
    render(<ErrorState error={new ApiError(404, 'NOT_FOUND', 'Device not found.', 'req_404')} onRetry={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Not found');
    expect(screen.getByRole('status')).toHaveTextContent('outside what you have access to');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body).not.toHaveTextContent('req_404');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
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

  it('does not blame the reader\'s connection when something in front of the API answered', () => {
    render(<ErrorState error={new ApiError(NETWORK_ERROR_STATUS, 'NETWORK_ERROR', 'The API did not answer normally', undefined, { reason: 'BLOCKED' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('this is not your connection');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Check the internet connection');
  });

  it('points at this device\'s network when the API host did not answer at all', () => {
    render(<ErrorState error={new ApiError(NETWORK_ERROR_STATUS, 'NETWORK_ERROR', 'Could not reach the API', undefined, { reason: 'UNREACHABLE' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Check the internet connection');
  });
});
