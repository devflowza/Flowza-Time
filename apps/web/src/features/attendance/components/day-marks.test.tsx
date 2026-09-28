import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { DayMarkDto } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { renderWithProviders } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/attendance.json';
import ar from '@/locales/ar/attendance.json';
import { DayMarks } from './day-marks';
import { FlagChips } from './badges';

registerNamespace('attendance', en, ar);

const base = { employeeId: 'e1', attendanceDate: '2026-03-03', branchId: 'b1', sourceId: null, createdBy: null, revokedAt: null, revokedBy: null, revokeReason: null } as const;
const marks: DayMarkDto[] = [
  { ...base, id: 'm1', kind: 'UNEXCUSED', payEffectDays: 1, source: 'SWEEP', reason: 'Day close: absent on 2026-03-03 left unexplained after 3 day(s)', createdAt: '2026-03-06T20:00:00.000Z' },
  { ...base, id: 'm2', kind: 'PAY_EFFECT', payEffectDays: 1, source: 'SWEEP', reason: 'Unexcused day — auto-charged to AL', createdAt: '2026-03-06T20:00:00.000Z', revokedAt: '2026-03-07T05:00:00.000Z', revokeReason: 'Medical certificate provided' },
  { ...base, id: 'm3', kind: 'LOP', payEffectDays: 0.5, source: 'HR', reason: 'No balance', createdAt: '2026-03-07T06:00:00.000Z' },
];

describe('DayMarks', () => {
  it('renders one badge per mark with its source, time, reason and revocation in the accessible description, plus the loss-of-pay badge', () => {
    renderWithProviders(<DayMarks marks={marks} lopDays={0.5} timezone="Asia/Muscat" />);
    expect(screen.getByRole('group', { name: 'Day marks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Loss of pay 0\.5 day — Counted as loss of pay/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Unexcused — Day close · 07 Mar 2026, 00:00 — Day close: absent on 2026-03-03/ })).toBeInTheDocument();
    // a revoked mark stays visible, struck through, with who revoked it why
    expect(screen.getByRole('button', { name: /^Charged to leave · 1 day \(revoked\) — .*Revoked 07 Mar 2026, 09:00: Medical certificate provided$/ })).toBeInTheDocument();
    expect(screen.getByText('Charged to leave · 1 day (revoked)')).toHaveClass('line-through');
    expect(screen.getByRole('button', { name: /^Loss of pay · 0\.5 day — HR · 07 Mar 2026, 10:00 — No balance$/ })).toBeInTheDocument();
  });

  it('renders nothing for a day without marks or loss of pay (and tolerates an API without marks)', () => {
    const { container } = renderWithProviders(<DayMarks marks={undefined} lopDays={undefined} timezone="Asia/Muscat" />);
    expect(container.querySelector('[role="group"]')).toBeNull();
  });

  it('labels the policy-parity flags', () => {
    renderWithProviders(<FlagChips flags={['UNEXCUSED', 'LOP', 'PAY_EFFECT_FULL', 'EXCUSED', 'OUTSIDE_GEOFENCE', 'SELF_SERVICE_PUNCH', 'NON_WORKING_DAY_WORK']} max={7} />);
    for (const label of ['Unexcused', 'Loss of pay', 'Pay effect 1 day', 'Excused', 'Outside geofence', 'Self-service punch', 'Worked on a non-working day']) expect(screen.getByText(label)).toBeInTheDocument();
  });
});
