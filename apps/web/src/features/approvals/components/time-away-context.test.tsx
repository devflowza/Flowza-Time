import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { ApprovalContextDto } from '@flowza/contracts';
import { grantAll, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import enAtt from '@/locales/en/attendance.json';
import arAtt from '@/locales/ar/attendance.json';
import en from '@/locales/en/approvals.json';
import ar from '@/locales/ar/approvals.json';
import { ApprovalContext, EntityIcon } from './parts';

registerNamespace('attendance', enAtt, arAtt);
registerNamespace('approvals', en, ar);

type TimeAway = Extract<ApprovalContextDto, { kind: 'TIME_AWAY' }>['timeAway'];
const context = (over: Partial<TimeAway> = {}): ApprovalContextDto => ({
  kind: 'TIME_AWAY', summary: 'Personal permission · 2026-10-15 10:00–11:30',
  timeAway: {
    id: 'ta1', attendanceDate: '2026-10-15', kind: 'PERSONAL', source: 'step_out', startsAt: '2026-10-15T06:00:00Z', endsAt: '2026-10-15T07:30:00Z', returnedAt: '2026-10-15T07:20:00Z',
    minutes: 90, reason: 'Bank appointment', destination: 'Bank Muscat, Ruwi', status: 'pending', timezone: 'Asia/Muscat', personalUsedMinutes: 150, personalMonthlyQuotaMinutes: 240, ...over,
  },
});

describe('ApprovalContext — time away (docs/time-away.md)', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('shows the kind, the day, the window in the employee\'s zone, the length, the step-out return, the quota, reason and destination', () => {
    renderWithProviders(<ApprovalContext context={context()} timezone="UTC" />);
    const box = screen.getByTestId('context-time-away');
    expect(box).toHaveTextContent('15 Oct 2026');
    expect(box).toHaveTextContent('Personal permission');
    expect(box).toHaveTextContent('10:00 – 11:30'); // the request's zone (Asia/Muscat), not the page's
    expect(box).toHaveTextContent('1h 30m');
    expect(box).toHaveTextContent('Stepped out');
    expect(box).toHaveTextContent('Back at 11:20');
    expect(screen.getByTestId('context-time-away-quota')).toHaveTextContent('2h 30m of 4h 00m personal permission used this month, this request included');
    expect(box).toHaveTextContent('Reason: Bank appointment');
    expect(box).toHaveTextContent('Destination: Bank Muscat, Ruwi');
  });

  it('a planned official window: no return line, no quota', () => {
    renderWithProviders(<ApprovalContext context={context({ kind: 'OFFICIAL', source: 'request', returnedAt: null, personalUsedMinutes: null, personalMonthlyQuotaMinutes: null, destination: null })} timezone="Asia/Muscat" compact />);
    const box = screen.getByTestId('context-time-away');
    expect(box).toHaveTextContent('Official duty');
    expect(box).toHaveTextContent('Planned');
    expect(box).not.toHaveTextContent('Back at');
    expect(box).not.toHaveTextContent('Not back yet');
    expect(screen.queryByTestId('context-time-away-quota')).toBeNull();
  });

  it('a step-out still open says so; a personal permission without a monthly limit says that too', () => {
    renderWithProviders(<ApprovalContext context={context({ returnedAt: null, personalMonthlyQuotaMinutes: null, personalUsedMinutes: 45 })} timezone="Asia/Muscat" />);
    expect(screen.getByTestId('context-time-away')).toHaveTextContent('Not back yet');
    expect(screen.getByTestId('context-time-away-quota')).toHaveTextContent('45m of personal permission used this month, this request included (no monthly limit)');
  });

  it('a rejected or withdrawn request is not in the month\'s figure (pending + approved only): the plain wording, no "this request included"', () => {
    const { unmount } = renderWithProviders(<ApprovalContext context={context({ status: 'rejected', personalUsedMinutes: 60 })} timezone="Asia/Muscat" />);
    expect(screen.getByTestId('context-time-away-quota')).toHaveTextContent(/^1h 00m of 4h 00m used this month$/);
    unmount();
    renderWithProviders(<ApprovalContext context={context({ status: 'cancelled', personalUsedMinutes: 45, personalMonthlyQuotaMinutes: null })} timezone="Asia/Muscat" />);
    expect(screen.getByTestId('context-time-away-quota')).toHaveTextContent(/^45m of personal permission used this month \(no monthly limit\)$/);
  });

  it('an approved request is in the month\'s figure', () => {
    renderWithProviders(<ApprovalContext context={context({ status: 'approved' })} timezone="Asia/Muscat" />);
    expect(screen.getByTestId('context-time-away-quota')).toHaveTextContent('2h 30m of 4h 00m personal permission used this month, this request included');
  });

  it('has its own icon and entity label', () => {
    const { container } = renderWithProviders(<EntityIcon entityType="TIME_AWAY" />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(en.entity.TIME_AWAY).toBe('Time away');
    expect(ar.entity.TIME_AWAY).toBeTruthy();
  });
});
