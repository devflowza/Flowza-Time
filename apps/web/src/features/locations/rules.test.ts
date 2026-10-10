import { describe, expect, it } from 'vitest';
import { LOCATION_LEVELS_MAX, LOCATION_TEMPLATES, locationTemplate, type LocationDto, type LocationLevelIcon, type LocationLevelRole } from '@flowza/contracts';
import { inUseCounts } from './conflicts';
import {
  canAddLevel, canBeParentOf, childLevelsFor, hasStructureLocations, isCurrentTemplate, levelDeleteBlock, levelInsertionPoints, relevelOptions, roleForNewLevel,
  searchKey, searchTree, subtreeOf,
} from './rules';
import { indexLocations } from './tree';

const T = '2026-10-10T00:00:00Z';
const level = (id: string, position: number, role: LocationLevelRole, name: string, icon: LocationLevelIcon = 'other', locationCount = 0) =>
  ({ id, organizationId: 'org-1', position, role, name, nameAr: null, icon, locationCount, createdAt: T, updatedAt: T });
const node = (id: string, parentId: string | null, levelId: string, role: LocationLevelRole, name: string, extra: Record<string, unknown> = {}) => ({
  id, organizationId: 'org-1', levelId, role, parentId, branchId: null as string | null, code: name.toUpperCase().replace(/\W+/g, '-'), name, nameAr: null as string | null,
  latitude: null, longitude: null, path: [] as string[], depth: 1, status: 'active' as const, employeeCount: 0, deviceCount: 0, childCount: 0, createdAt: T, updatedAt: T, ...extra,
});

// Headquarters → Region → Branch → Site → Floor → Zone
const LEVELS = [
  level('l-hq', 1, 'group', 'Headquarters', 'headquarters', 1), level('l-rg', 2, 'group', 'Region', 'region', 1), level('l-br', 3, 'branch', 'Branch', 'branch', 2),
  level('l-site', 4, 'place', 'Site', 'site', 2), level('l-floor', 5, 'place', 'Floor', 'floor', 1), level('l-zone', 6, 'place', 'Zone', 'zone', 0),
];
const NODES = [
  node('n-hq', null, 'l-hq', 'group', 'Muscat HQ'),
  node('n-north', 'n-hq', 'l-rg', 'group', 'Northern Region'),
  node('n-b1', 'n-north', 'l-br', 'branch', 'Branch 1', { branchId: 'b1' }),
  node('n-b2', 'n-hq', 'l-br', 'branch', 'Branch 2', { branchId: 'b2' }),
  node('n-sa', 'n-b1', 'l-site', 'place', 'Site A', { branchId: 'b1', nameAr: 'الموقع أ' }),
  node('n-f2', 'n-sa', 'l-floor', 'place', 'Floor 2', { branchId: 'b1' }),
  node('n-sx', 'n-b2', 'l-site', 'place', 'Site X', { branchId: 'b2' }),
  node('n-old', 'n-b2', 'l-site', 'place', 'Old Site', { branchId: 'b2', status: 'archived' }),
];
const index = indexLocations(NODES, LEVELS);
const byId = (id: string) => index.byId.get(id)!;
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe('level rules', () => {
  it('gives a new level the role of where it lands: at or above the branch level a group, below it a place', () => {
    expect(roleForNewLevel(LEVELS, 1)).toBe('group');
    expect(roleForNewLevel(LEVELS, 3)).toBe('group'); // above the branch level, which moves down
    expect(roleForNewLevel(LEVELS, 4)).toBe('place');
    expect(roleForNewLevel(LEVELS, 7)).toBe('place');
  });

  it('lists every insertion point with its neighbours', () => {
    const points = levelInsertionPoints([level('b', 2, 'branch', 'Branch'), level('h', 1, 'group', 'Headquarters')]); // unordered input
    expect(points.map((p) => [p.position, p.role, p.above?.name ?? null, p.below?.name ?? null])).toEqual([
      [1, 'group', null, 'Headquarters'], [2, 'group', 'Headquarters', 'Branch'], [3, 'place', 'Branch', null],
    ]);
  });

  it('caps the levels and keeps the branch level and used levels', () => {
    expect(canAddLevel(LEVELS)).toBe(true);
    expect(canAddLevel(Array.from({ length: LOCATION_LEVELS_MAX }, (_, i) => level(`l${i}`, i + 1, i === 0 ? 'branch' : 'place', `L${i}`)))).toBe(false);
    expect(levelDeleteBlock(LEVELS[2]!)).toBe('BRANCH_LEVEL');
    expect(levelDeleteBlock(LEVELS[3]!)).toBe('IN_USE');
    expect(levelDeleteBlock(LEVELS[5]!)).toBeNull();
  });
});

describe('templates', () => {
  it('matches the current template by kinds and icons, whatever the names became', () => {
    const corporate = locationTemplate('CORPORATE');
    const renamed = corporate.levels.map((l, i) => ({ ...level(`x${i}`, i + 1, l.role, `Renamed ${i}`, l.icon) }));
    expect(isCurrentTemplate(renamed, corporate)).toBe(true);
    expect(isCurrentTemplate(renamed, locationTemplate('REGIONAL'))).toBe(false);
    expect(LOCATION_TEMPLATES.filter((tpl) => isCurrentTemplate([level('b', 1, 'branch', 'Branch', 'branch')], tpl)).map((tpl) => tpl.key)).toEqual(['SIMPLE']);
  });

  it('is blocked by any group or place location, archived ones included (the level counts carry them)', () => {
    expect(hasStructureLocations(index)).toBe(true);
    const flat = indexLocations([node('n-b1', null, 'l-b', 'branch', 'Branch 1', { branchId: 'b1' })], [level('l-b', 1, 'branch', 'Branch', 'branch', 1)]);
    expect(hasStructureLocations(flat)).toBe(false);
    // nothing loaded but an archived site on a place level
    expect(hasStructureLocations({ nodes: flat.nodes, levels: [level('l-b', 1, 'branch', 'Branch', 'branch', 1), level('l-s', 2, 'place', 'Site', 'site', 1)] })).toBe(true);
  });
});

describe('placement rules', () => {
  it('offers a child only the deeper levels of its kind', () => {
    expect(ids(childLevelsFor(index, null))).toEqual(['l-hq', 'l-rg']);
    expect(ids(childLevelsFor(index, byId('n-hq')))).toEqual(['l-rg']);
    expect(ids(childLevelsFor(index, byId('n-north')))).toEqual([]); // branches come with the branches
    expect(ids(childLevelsFor(index, byId('n-b1')))).toEqual(['l-site', 'l-floor', 'l-zone']);
    expect(ids(childLevelsFor(index, byId('n-sa')))).toEqual(['l-floor', 'l-zone']);
    expect(ids(childLevelsFor(index, byId('n-old')))).toEqual([]); // nothing new under an archived node
  });

  it('re-levels a node between its parent and its children only', () => {
    expect(ids(relevelOptions(index, byId('n-sa')))).toEqual(['l-site']); // its floor below it
    expect(ids(relevelOptions(index, byId('n-f2')))).toEqual(['l-floor', 'l-zone']);
    expect(ids(relevelOptions(index, byId('n-sx')))).toEqual(['l-site', 'l-floor', 'l-zone']);
    expect(ids(relevelOptions(index, byId('n-hq')))).toEqual(['l-hq']);
    expect(ids(relevelOptions(index, byId('n-b1')))).toEqual(['l-br']);
  });

  it('moves a node only under an active node of a higher level of the fitting kind, never into its own subtree', () => {
    const targets = (id: string) => NODES.filter((c) => canBeParentOf(index, byId(id), byId(c.id))).map((c) => c.id);
    expect([...subtreeOf(index, 'n-b1')].sort()).toEqual(['n-b1', 'n-f2', 'n-sa']);
    expect(targets('n-f2')).toEqual(['n-b1', 'n-b2', 'n-sa', 'n-sx']); // another branch is offered (the server decides)
    expect(targets('n-sa')).toEqual(['n-b1', 'n-b2']);
    expect(targets('n-b1')).toEqual(['n-hq', 'n-north']);
    expect(targets('n-north')).toEqual(['n-hq']);
    expect(targets('n-hq')).toEqual([]);
  });
});

describe('search', () => {
  it('keeps the matches and their ancestors, in English, Arabic and codes, ignoring accents and diacritics', () => {
    const text = (n: LocationDto) => [n.name, n.nameAr, n.code];
    expect(searchTree(index, '  ', text)).toBeNull();
    const floor = searchTree(index, 'floor', text)!;
    expect([...floor.matches]).toEqual(['n-f2']);
    expect([...floor.visible].sort()).toEqual(['n-b1', 'n-f2', 'n-hq', 'n-north', 'n-sa']);
    expect([...searchTree(index, 'الموقع', text)!.matches]).toEqual(['n-sa']);
    expect([...searchTree(index, 'SITE-X', text)!.matches]).toEqual(['n-sx']);
    expect(searchKey('Zóne')).toBe('zone');
    expect(searchKey('مَوْقِع')).toBe('موقع');
  });
});

describe('inUseCounts', () => {
  it('reads the counts the server reports, under their usual names, in a fixed order', () => {
    expect(inUseCounts({ devices: 2, children: 1, employees: 3, unrelated: 9 })).toEqual([
      { kind: 'children', count: 1 }, { kind: 'employees', count: 3 }, { kind: 'devices', count: 2 },
    ]);
    expect(inUseCounts({ inUse: { fences: ['g1', 'g2'], activeChildren: 0, coverageTargets: 1, ruleSets: 4 } })).toEqual([
      { kind: 'geofences', count: 2 }, { kind: 'coverage', count: 1 }, { kind: 'policies', count: 4 },
    ]);
    expect(inUseCounts(undefined)).toEqual([]);
    expect(inUseCounts({ constructor: 3, toString: 1 })).toEqual([]);
  });
});
