import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { renderWithProviders } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/attendance.json';
import ar from '@/locales/ar/attendance.json';
import { TraceView } from './trace-view';
import type { CalculationTrace } from '../types';

registerNamespace('attendance', en, ar);

describe('TraceView', () => {
  it('renders an empty state for a missing or empty trace (manual status / legacy engine)', () => {
    const { rerender } = renderWithProviders(<TraceView trace={null} timezone="Asia/Muscat" />);
    expect(screen.getByText('No calculation trace')).toBeInTheDocument();
    rerender(<TraceView trace={{}} timezone="Asia/Muscat" />);
    expect(screen.getByText('No calculation trace')).toBeInTheDocument();
  });

  it('tolerates partially filled traces: steps without values, punches without roles, no inputs', () => {
    const trace: CalculationTrace = { punches: [{ eventId: 'e1', punchedAt: '2024-03-01T04:02:00.000Z' }, { punchedAt: '2024-03-01T13:00:00.000Z', role: 'OUT', note: 'last punch' }], steps: [{ step: 'resolve_shift' }, { step: 'late', detail: 'Late by 2 min', values: { lateMinutes: 2, grace: 10, capped: false } }] };
    renderWithProviders(<TraceView trace={trace} timezone="Asia/Muscat" />);
    expect(screen.getByText('No inputs recorded.')).toBeInTheDocument();
    expect(screen.getByText('Punch timeline (2)')).toBeInTheDocument();
    expect(screen.getByText('Calculation steps (2)')).toBeInTheDocument();
    // punch without a role falls back to IGNORED; times are rendered in the branch timezone (UTC+4)
    expect(screen.getByText('Ignored')).toBeInTheDocument();
    expect(screen.getByText('OUT')).toBeInTheDocument();
    expect(screen.getByText(/01 Mar 08:02:00/)).toBeInTheDocument();
    expect(screen.getByText('last punch')).toBeInTheDocument();
    // step values render as key=value chips; a step without detail/values shows dashes
    expect(screen.getByText('lateMinutes=2')).toBeInTheDocument();
    expect(screen.getByText('capped=✗')).toBeInTheDocument();
    expect(screen.getByText('resolve_shift')).toBeInTheDocument();
  });

  it('renders the inputs block with window, holiday and weekly-off flags', () => {
    const trace: CalculationTrace = { engineVersion: 'attendance-engine/1.0.0', inputs: { shiftId: 'abcdef12-0000-0000-0000-000000000000', shiftType: 'FIXED', ruleSetId: null, timezone: 'Asia/Dubai', window: { start: '2024-03-01T00:00:00.000Z', end: '2024-03-01T20:00:00.000Z' }, holiday: null, leave: null, weeklyOff: true }, punches: [], steps: [] };
    renderWithProviders(<TraceView trace={trace} timezone="Asia/Muscat" />);
    expect(screen.getByText('Engine attendance-engine/1.0.0')).toBeInTheDocument();
    expect(screen.getByText('Asia/Dubai')).toBeInTheDocument();
    expect(screen.getByText('Default rules')).toBeInTheDocument();
    expect(screen.getByText('FIXED abcdef12…')).toBeInTheDocument();
    expect(screen.getByText('01 Mar 04:00 → 02 Mar 00:00')).toBeInTheDocument();
    expect(screen.getByText('No punches inside the window.')).toBeInTheDocument();
  });
});
