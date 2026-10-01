import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import i18n from '@/lib/i18n';
import { renderWithProviders } from '@/features/employees/test-utils';
import { LiveIndicator } from './live-indicator';

describe('LiveIndicator', () => {
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('en'); }); });

  it('says Live while realtime signals arrive and Auto-refresh while the register polls', () => {
    const { unmount } = renderWithProviders(<LiveIndicator mode="live" />);
    const badge = screen.getByTestId('attendance-live');
    expect(badge).toHaveTextContent('Live');
    expect(badge).toHaveAttribute('data-mode', 'live');
    expect(badge).toHaveAttribute('role', 'status');
    unmount();
    renderWithProviders(<LiveIndicator mode="polling" />);
    expect(screen.getByTestId('attendance-live')).toHaveTextContent('Auto-refresh');
  });

  it('is translated', async () => {
    await act(async () => { await i18n.changeLanguage('ar'); });
    renderWithProviders(<LiveIndicator mode="live" />);
    expect(screen.getByTestId('attendance-live')).toHaveTextContent('مباشر');
  });
});
