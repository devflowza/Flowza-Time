import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { renderWithProviders, supabaseMock } from '@/features/employees/test-utils';
import { MfaRequiredGate } from './mfa-required-gate';

const mfa = supabaseMock.auth.mfa;
const factor = (status: 'verified' | 'unverified') => ({ id: 'factor-1', status, friendly_name: 'FlowZa', factor_type: 'totp' });
const enrolment = { id: 'factor-1', totp: { qr_code: 'data:image/svg+xml;base64,QQ==', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' } };

describe('MfaRequiredGate', () => {
  beforeEach(() => {
    for (const fn of Object.values(mfa)) fn.mockReset();
    supabaseMock.auth.signOut.mockClear();
    mfa.listFactors.mockResolvedValue({ data: { totp: [], all: [] }, error: null });
    mfa.enroll.mockResolvedValue({ data: enrolment, error: null });
    mfa.challenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null });
    mfa.verify.mockResolvedValue({ data: {}, error: null });
  });

  it('enrols a first factor and reports back so the shell can retry /me', async () => {
    const onVerified = vi.fn();
    renderWithProviders(<MfaRequiredGate onVerified={onVerified} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Set up authenticator' }));
    // the secret is offered for manual entry when the QR cannot be scanned
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByAltText('QR code for the authenticator app')).toHaveAttribute('src', enrolment.totp.qr_code);

    const verify = screen.getByRole('button', { name: 'Verify' });
    expect(verify).toBeDisabled(); // no code typed yet
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(verify);

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(mfa.challenge).toHaveBeenCalledWith({ factorId: 'factor-1' });
    expect(mfa.verify).toHaveBeenCalledWith({ factorId: 'factor-1', challengeId: 'challenge-1', code: '123456' });
  });

  it('challenges an already verified factor instead of enrolling a second one', async () => {
    mfa.listFactors.mockResolvedValue({ data: { totp: [factor('verified')], all: [factor('verified')] }, error: null });
    const onVerified = vi.fn();
    renderWithProviders(<MfaRequiredGate onVerified={onVerified} />);

    expect(await screen.findByText('Enter the code from your authenticator app to continue.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up authenticator' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  it('ignores an unverified leftover factor and enrols a fresh one', async () => {
    mfa.listFactors.mockResolvedValue({ data: { totp: [factor('unverified')], all: [factor('unverified')] }, error: null });
    renderWithProviders(<MfaRequiredGate onVerified={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Set up authenticator' })).toBeInTheDocument();
  });

  it('keeps the user on the screen when verification fails', async () => {
    mfa.verify.mockResolvedValue({ data: null, error: { message: 'Invalid TOTP code entered' } });
    mfa.listFactors.mockResolvedValue({ data: { totp: [factor('verified')], all: [factor('verified')] }, error: null });
    const onVerified = vi.fn();
    renderWithProviders(<MfaRequiredGate onVerified={onVerified} />);

    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('Invalid TOTP code entered')).toBeInTheDocument();
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('surfaces a factor-lookup failure and always offers a way out', async () => {
    mfa.listFactors.mockResolvedValue({ data: null, error: { message: 'boom' } });
    renderWithProviders(<MfaRequiredGate onVerified={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check your authenticators. Try signing in again.');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(supabaseMock.auth.signOut).toHaveBeenCalled();
  });
});
