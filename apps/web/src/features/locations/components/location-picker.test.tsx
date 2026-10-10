import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { LocationLevelRole } from '@flowza/contracts';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import { indexLocations, pathLabel, placesOfBranch } from '../tree';
import { LocationPicker } from './location-picker';

const T = '2026-10-10T00:00:00Z';
const level = (id: string, position: number, role: LocationLevelRole, name: string, nameAr: string) => ({ id, organizationId: 'org-1', position, role, name, nameAr, icon: 'other' as const, locationCount: 0, createdAt: T, updatedAt: T });
const LEVELS = [level('l-hq', 1, 'group', 'Headquarters', 'المقر الرئيسي'), level('l-br', 2, 'branch', 'Branch', 'فرع'), level('l-site', 3, 'place', 'Site', 'موقع'), level('l-floor', 4, 'place', 'Floor', 'طابق')];
const node = (id: string, parentId: string | null, levelId: string, role: LocationLevelRole, name: string, extra: Record<string, unknown> = {}) => ({
  id, organizationId: 'org-1', levelId, role, parentId, branchId: null, code: name.toUpperCase().replace(/\W+/g, '-'), name, nameAr: null, latitude: null, longitude: null,
  path: [], depth: 1, status: 'active' as const, employeeCount: 0, deviceCount: 0, childCount: 0, createdAt: T, updatedAt: T, ...extra,
});
const NODES = [
  node('n-hq', null, 'l-hq', 'group', 'Muscat HQ'),
  node('n-b1', 'n-hq', 'l-br', 'branch', 'Branch 1', { branchId: 'b1' }),
  node('n-b2', 'n-hq', 'l-br', 'branch', 'Branch 2', { branchId: 'b2' }),
  node('n-sa', 'n-b1', 'l-site', 'place', 'Site A', { branchId: 'b1', nameAr: 'الموقع أ' }),
  node('n-f2', 'n-sa', 'l-floor', 'place', 'Floor 2', { branchId: 'b1' }),
  node('n-sx', 'n-b2', 'l-site', 'place', 'Site X', { branchId: 'b2' }),
];

const onChange = vi.fn();
function Harness(props: { roles?: LocationLevelRole[]; branchId?: string | null; initial?: string | null }) {
  const [value, setValue] = useState<string | null>(props.initial ?? null);
  return <LocationPicker value={value} roles={props.roles} branchId={props.branchId} onChange={(v, n) => { onChange(v, n); setValue(v); }} />;
}
const open = () => fireEvent.click(screen.getByRole('combobox'));
const items = () => [...document.querySelectorAll('[cmdk-item]')].map((el) => el.textContent ?? '');

describe('location tree helpers', () => {
  it('indexes, walks a branch and labels a path', () => {
    const index = indexLocations(NODES, LEVELS);
    expect(index.hasGroupLevels && index.hasPlaceLevels).toBe(true);
    expect(index.branchLevel?.id).toBe('l-br');
    expect(placesOfBranch(index, 'b1').map((r) => [r.node.id, r.depth])).toEqual([['n-sa', 0], ['n-f2', 1]]);
    expect(pathLabel(index, 'n-f2', (n) => n.name)).toBe('Muscat HQ › Branch 1 › Site A › Floor 2');
    expect(pathLabel(index, 'n-f2', (n) => n.name, { fromBranch: true })).toBe('Site A › Floor 2');
    expect(pathLabel(index, 'missing', (n) => n.name)).toBe('');
  });
});

describe('LocationPicker', () => {
  beforeEach(() => {
    resetApiMock(); grantAll(); onChange.mockReset();
    mockGet({ '/orgs/org-1/location-levels': { data: LEVELS }, '/orgs/org-1/locations': { data: NODES } });
  });

  it('offers only the places of the given branch, indented, with their level', async () => {
    renderWithProviders(<Harness roles={['place']} branchId="b1" />);
    open();
    await screen.findByText('Site A');
    expect(items()).toEqual(['Site ASite', 'Floor 2Floor']);
    fireEvent.click(screen.getByText('Floor 2').closest('[cmdk-item]')!);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('n-f2', expect.objectContaining({ role: 'place', branchId: 'b1' })));
  });

  it('asks for the branch first when places are wanted without one', async () => {
    renderWithProviders(<Harness roles={['place']} branchId={null} />);
    open();
    expect(await screen.findByText('Choose the branch first.')).toBeInTheDocument();
  });

  it('lists the whole tree for a filter, and keeps an out-of-list value readable', async () => {
    renderWithProviders(<Harness initial="n-sx" roles={['group', 'branch']} />);
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Site X'));
    open();
    await screen.findByText('Muscat HQ');
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('Branch 1')).toBeInTheDocument();
    expect(within(listbox).queryByText('Site A')).not.toBeInTheDocument();
  });
});
