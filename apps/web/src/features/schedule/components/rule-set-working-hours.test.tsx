import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/schedule.json';
import ar from '@/locales/ar/schedule.json';
import { RuleSetDialog } from './rule-set-dialog';

registerNamespace('schedule', en, ar);
// the policy editor re-renders as a whole on every keystroke: a dozen field changes take ~10 s alone, more in a loaded full run
vi.setConfig({ testTimeout: 60_000 });

/** The rule set's grace mode and approved working-hours periods (engine 1.5.0) in the policy editor. */
describe('RuleSetDialog — grace mode and approved working hours', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({}); apiMock.post.mockResolvedValue({ data: { id: 'rs1', recalculationJobId: null } }); });

  it('deducts the grace by default and sends the tolerance mode when chosen', async () => {
    renderWithProviders(<RuleSetDialog open onOpenChange={vi.fn()} ruleSet={null} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Tolerant' } });
    const mode = screen.getByRole('combobox', { name: /Grace margin/ });
    expect(mode).toHaveTextContent('Deduct the grace');
    fireEvent.keyDown(mode, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /Tolerance/ }));
    fireEvent.click(screen.getByRole('button', { name: /Create|Save/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post.mock.calls[0]![1]).toMatchObject({ name: 'Tolerant', graceMode: 'tolerance', specialPeriods: [] });
  });

  it('adds and removes periods, refuses overlapping ones in the reader\'s language and sends them', async () => {
    renderWithProviders(<RuleSetDialog open onOpenChange={vi.fn()} ruleSet={null} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Summer 2026' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Approved hours' }));
    expect(screen.getByText('No approved periods: the shift hours apply every day.')).toBeInTheDocument();
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Add period' }));
    expect(screen.getAllByTestId('special-period')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Remove period 3' }));
    const [summer, event] = screen.getAllByTestId('special-period') as [HTMLElement, HTMLElement];
    const set = (el: HTMLElement, label: RegExp, value: string) => fireEvent.change(within(el).getByLabelText(label), { target: { value } });
    set(summer, /^Name/, 'Summer hours'); set(summer, /Circular/, 'Circular 7/2026'); set(summer, /First day/, '2026-07-01'); set(summer, /Last day/, '2026-08-31');
    set(summer, /Start time/, '07:30'); set(summer, /End time/, '13:30');
    set(event, /^Name/, 'National event'); set(event, /First day/, '2026-08-15'); set(event, /Last day/, '2026-08-20'); set(event, /Scheduled minutes/, '300');

    fireEvent.click(screen.getByRole('button', { name: /Create|Save/ }));
    expect(await within(event).findByText('This period overlaps another one.')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();

    set(event, /First day/, '2026-09-01'); set(event, /Last day/, '2026-09-05');
    fireEvent.click(screen.getByRole('button', { name: /Create|Save/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect((apiMock.post.mock.calls[0]![1] as Record<string, unknown>)['specialPeriods']).toEqual([
      { name: 'Summer hours', reference: 'Circular 7/2026', from: '2026-07-01', to: '2026-08-31', startTime: '07:30', endTime: '13:30', appliesTo: 'all' },
      { name: 'National event', from: '2026-09-01', to: '2026-09-05', scheduledMinutes: 300, appliesTo: 'all' },
    ]);
  });

  it('a period needs hours or minutes, said in the reader\'s language', async () => {
    renderWithProviders(<RuleSetDialog open onOpenChange={vi.fn()} ruleSet={null} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Approved hours' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add period' }));
    const period = screen.getByTestId('special-period');
    fireEvent.change(within(period).getByLabelText(/^Name/), { target: { value: 'Event' } });
    fireEvent.click(screen.getByRole('button', { name: /Create|Save/ }));
    expect(await within(period).findByText('Set the start or end time, the scheduled minutes, or both.')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('opens a saved rule set with its mode and periods', () => {
    const saved = { id: 'rs2', version: 1, createdAt: '', updatedAt: '', name: 'Saved', description: '', branchId: null, effectiveFrom: '2026-01-01', effectiveTo: null, graceMode: 'tolerance', specialPeriods: [{ name: 'Summer hours', from: '2026-07-01', to: '2026-08-31', scheduledMinutes: 360, appliesTo: 'flagged_employees' }] } as never;
    renderWithProviders(<RuleSetDialog open onOpenChange={vi.fn()} ruleSet={saved} />);
    expect(screen.getByRole('combobox', { name: /Grace margin/ })).toHaveTextContent('Tolerance');
    const period = screen.getByTestId('special-period');
    expect(within(period).getByLabelText(/^Name/)).toHaveValue('Summer hours');
    expect(within(period).getByLabelText(/Scheduled minutes/)).toHaveValue(360);
    expect(within(period).getByRole('combobox', { name: /Applies to/ })).toHaveTextContent('Flagged employees only');
  });
});
