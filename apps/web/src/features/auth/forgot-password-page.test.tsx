import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { renderWithProviders } from '@/features/employees/test-utils';
import { supabaseMock } from '@/features/employees/test-mocks';
import { ForgotPasswordPage } from './forgot-password-page';

const request = (email: string) => {
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
};

describe('ForgotPasswordPage', () => {
  beforeEach(() => { supabaseMock.auth.resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null }); });

  it('asks for a link that opens the reset page on this origin', async () => {
    renderWithProviders(<ForgotPasswordPage />, { route: '/auth/forgot' });
    request('rakshitha@example.com');
    expect(await screen.findByText('If an account exists for rakshitha@example.com, a reset link has been sent.')).toBeInTheDocument();
    expect(supabaseMock.auth.resetPasswordForEmail).toHaveBeenCalledWith('rakshitha@example.com', { redirectTo: `${window.location.origin}/auth/reset` });
  });

  it('says the same whether or not the account exists', async () => {
    supabaseMock.auth.resetPasswordForEmail.mockResolvedValue({ data: null, error: { message: 'User not found', status: 400 } });
    renderWithProviders(<ForgotPasswordPage />, { route: '/auth/forgot' });
    request('nobody@example.com');
    expect(await screen.findByText('If an account exists for nobody@example.com, a reset link has been sent.')).toBeInTheDocument();
  });

  it('says when the request itself was refused for sending too many', async () => {
    supabaseMock.auth.resetPasswordForEmail.mockResolvedValue({ data: null, error: { message: 'For security purposes, you can only request this after 42 seconds.', code: 'over_email_send_rate_limit', status: 429 } });
    renderWithProviders(<ForgotPasswordPage />, { route: '/auth/forgot' });
    request('rakshitha@example.com');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Too many reset e-mails were requested. Wait a minute, then try again.'));
    expect(screen.queryByText(/a reset link has been sent/)).not.toBeInTheDocument();
  });
});
