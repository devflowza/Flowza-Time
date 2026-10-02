import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { apiMock, grantAll, mockGet, page, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { useAssignmentMutations, useAssignments } from './api';

const EMP = '11111111-1111-4111-8111-111111111111';
const SHIFT = '22222222-2222-4222-8222-222222222222';
const row = (id: string, effectiveFrom: string, effectiveTo: string | null) => ({ id, targetType: 'EMPLOYEE', targetId: EMP, targetName: 'Ahmed Hassan', branchId: 'b1', shiftId: SHIFT, shiftName: 'Flexible 8h', shiftPatternId: null, patternName: null, effectiveFrom, effectiveTo, createdBy: null, createdAt: '2026-10-02T10:00:00Z' });

function Probe() {
  const list = useAssignments({ page: 1, pageSize: 25 });
  const { create } = useAssignmentMutations();
  return (
    <div>
      <ul>{(list.data?.data ?? []).map((a) => <li key={a.id}>{a.effectiveFrom} → {a.effectiveTo}</li>)}</ul>
      <button type="button" onClick={() => create.mutate({ targetType: 'EMPLOYEE', targetId: EMP, shiftId: SHIFT, effectiveFrom: '2026-09-03', effectiveTo: '2026-10-01' })}>Assign</button>
    </div>
  );
}

describe('shift assignments list', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('refreshes after Assign (field report: the new assignment did not appear)', async () => {
    let rows = [row('a1', '2026-09-01', '2026-09-02')];
    mockGet({ '/orgs/org-1/shift-assignments': () => page(rows) });
    apiMock.post.mockImplementation(async () => { rows = [row('a2', '2026-09-03', '2026-10-01'), ...rows]; return { data: { ...rows[0], recalculationJobId: null } }; });
    renderWithProviders(<Probe />);
    expect(await screen.findByText('2026-09-01 → 2026-09-02')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(await screen.findByText('2026-09-03 → 2026-10-01')).toBeInTheDocument();
    await waitFor(() => expect(apiMock.get.mock.calls.filter(([p]) => p === '/orgs/org-1/shift-assignments').length).toBeGreaterThanOrEqual(2));
  });
});
