import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { renderWithProviders } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/attendance.json';
import ar from '@/locales/ar/attendance.json';
import { MonthlyGrid } from './monthly-grid';
import type { MonthlyRow } from '../types';

registerNamespace('attendance', en, ar);

const days = ['2024-03-01', '2024-03-02', '2024-03-03', '2024-03-04'];
const cell = (status: string, recordId: string, extra: Partial<MonthlyRow['days'][string] & object> = {}) => ({ status, workedMinutes: 480, lateMinutes: 0, overtimeMinutes: 0, flags: [] as string[], recordId, ...extra });
const row = (id: string, name: string, d: MonthlyRow['days']): MonthlyRow => ({ employeeId: id, employeeNumber: `10${id}`, employeeName: name, branchId: 'b1', days: d, totals: { present: 2, absent: 1, leave: 0, holiday: 0, weeklyOff: 1, halfDay: 0, late: 1, missingPunch: 0, workedMinutes: 960, overtimeMinutes: 30, lateMinutes: 12 } });

describe('MonthlyGrid', () => {
  it('colours cells by status, marks late/missing/OT with indicators and opens the record on click', () => {
    const onOpen = vi.fn();
    const rows = [
      row('1', 'Ali', { '2024-03-01': cell('PRESENT', 'r1', { lateMinutes: 12, flags: ['LATE'] }), '2024-03-02': cell('ABSENT', 'r2', { workedMinutes: 0 }), '2024-03-03': cell('WEEKLY_OFF', 'r3', { workedMinutes: 0 }), '2024-03-04': null }),
      row('2', 'Sara', { '2024-03-01': cell('LEAVE', 'r4', { workedMinutes: 0 }), '2024-03-02': cell('HALF_DAY', 'r5', { workedMinutes: 240 }), '2024-03-03': cell('MISSING_PUNCH', 'r6', { flags: ['MISSING_OUT'], overtimeMinutes: 30 }), '2024-03-04': null }),
    ];
    renderWithProviders(<MonthlyGrid rows={rows} days={days} weeklyOffDays={[5, 6]} onOpenRecord={onOpen} />);
    const grid = screen.getByTestId('monthly-grid');
    const byStatus = (s: string) => grid.querySelectorAll(`[data-status="${s}"]`);
    expect(byStatus('PRESENT')).toHaveLength(1);
    expect(byStatus('PRESENT')[0]!.className).toMatch(/bg-emerald-500/);
    expect(byStatus('ABSENT')[0]!.className).toMatch(/bg-red-500/);
    expect(byStatus('LEAVE')[0]!.className).toMatch(/bg-blue-500/);
    expect(byStatus('HALF_DAY')[0]!.className).toMatch(/bg-amber-400/);
    expect(byStatus('MISSING_PUNCH')[0]!.className).toMatch(/bg-orange-400/);
    expect(byStatus('WEEKLY_OFF')[0]!.className).toMatch(/bg-slate-200/);
    expect(byStatus('none')).toHaveLength(2); // no record → transparent, not clickable
    expect(byStatus('none')[0]!.className).toMatch(/bg-transparent/);
    // letters
    expect(byStatus('PRESENT')[0]).toHaveTextContent('P');
    expect(byStatus('HALF_DAY')[0]).toHaveTextContent('½');
    // late indicator on the present cell only
    expect(byStatus('PRESENT')[0]!.querySelector('.bg-amber-400')).not.toBeNull();
    expect(byStatus('ABSENT')[0]!.querySelector('.bg-amber-400')).toBeNull();
    // tooltip text (native title) includes status + figures
    const lateBtn = screen.getByRole('button', { name: /01 Mar: Present · Worked 8h 00m · Late 12m/ });
    fireEvent.click(lateBtn);
    expect(onOpen).toHaveBeenCalledWith('r1');
    // totals row sums the page
    const foot = grid.querySelector('tfoot')!;
    expect(within(foot).getByText('Page totals (2)')).toBeInTheDocument();
    expect(within(foot).getByText('4')).toBeInTheDocument(); // present 2 + 2
    expect(within(foot).getByText('32h 00m')).toBeInTheDocument(); // worked 960 + 960
  });

  it('renders 100 employees × 31 days quickly (memoised cells, no per-cell queries)', () => {
    const month = Array.from({ length: 31 }, (_, i) => `2024-03-${String(i + 1).padStart(2, '0')}`);
    const statuses = ['PRESENT', 'ABSENT', 'LEAVE', 'WEEKLY_OFF', 'HALF_DAY'];
    const rows: MonthlyRow[] = Array.from({ length: 100 }, (_, e) => row(String(e), `Emp ${e}`, Object.fromEntries(month.map((d, i) => [d, cell(statuses[(e + i) % statuses.length]!, `${e}-${i}`)]))));
    const started = performance.now();
    renderWithProviders(<MonthlyGrid rows={rows} days={month} onOpenRecord={() => {}} />);
    const elapsed = performance.now() - started;
    expect(screen.getByTestId('monthly-grid').querySelectorAll('[data-status]')).toHaveLength(3100);
    expect(elapsed).toBeLessThan(4000);
  });
});
