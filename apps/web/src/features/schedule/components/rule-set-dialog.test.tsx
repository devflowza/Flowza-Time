import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

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

describe('RuleSetDialog — overtime', () => {
  beforeEach(() => { resetApiMock(); grantAll(); mockGet({}); });

  it('starts from "every minute after the shift end" and offers the stricter "beyond the scheduled hours" policy', async () => {
    apiMock.post.mockResolvedValue({ data: { id: 'rs1', recalculationJobId: null } });
    renderWithProviders(<RuleSetDialog open onOpenChange={vi.fn()} ruleSet={null} />);
    expect(screen.getByLabelText('OT starts after (min)')).toHaveValue(0);
    expect(screen.getByLabelText('Minimum OT block (min)')).toHaveValue(0);
    const strict = screen.getByRole('switch', { name: 'OT only beyond the scheduled hours' });
    expect(strict).not.toBeChecked();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Policy 2026' } });
    fireEvent.click(strict);
    fireEvent.click(screen.getByRole('button', { name: /Create|Save/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/attendance-rule-sets');
    expect(body).toMatchObject({ name: 'Policy 2026', overtimeRequiresScheduledHours: true, overtimeStartAfterMinutes: 0, overtimeMinBlockMinutes: 0, overtimeRoundingMinutes: 0 });
  });
});
