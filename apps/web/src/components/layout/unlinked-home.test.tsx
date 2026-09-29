import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);

import { renderWithProviders } from '@/features/employees/test-utils';
import { apiMock } from '@/features/employees/test-mocks';
import { UnlinkedHome } from './unlinked-home';

describe('UnlinkedHome', () => {
  it('explains the missing employee link instead of calling the dashboard the member cannot see', () => {
    renderWithProviders(<UnlinkedHome />);
    expect(screen.getByText('Welcome to Acme')).toBeInTheDocument();
    expect(screen.getByText(/not linked to your employee record yet/)).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});
