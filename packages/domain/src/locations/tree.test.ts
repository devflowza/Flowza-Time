import { describe, expect, it } from 'vitest';
import { LOCATION_TEMPLATES, locationTemplate } from '@flowza/contracts';
import {
  ancestorsOf, childLevelsFor, deriveLocationCode, levelListProblems, placeLabel, placementProblem, positionsAfterDelete, positionsAfterInsert,
  roleForNewLevel, rollUp, subtreeIds, templateLevelPlan, type TreeLevel,
} from './tree.js';

const corporate: TreeLevel[] = [
  { id: 'hq', position: 1, role: 'group' },
  { id: 'br', position: 2, role: 'branch' },
  { id: 'site', position: 3, role: 'place' },
  { id: 'floor', position: 4, role: 'place' },
  { id: 'zone', position: 5, role: 'place' },
];

describe('levels', () => {
  it('accepts a well-formed list and names every problem of a broken one', () => {
    expect(levelListProblems(corporate)).toEqual([]);
    expect(levelListProblems([])).toEqual(['EMPTY']);
    expect(levelListProblems([{ id: 'a', position: 1, role: 'place' }])).toEqual(['NO_BRANCH_LEVEL']);
    expect(levelListProblems([{ id: 'a', position: 1, role: 'branch' }, { id: 'b', position: 3, role: 'place' }])).toEqual(['GAPS']);
    expect(levelListProblems([{ id: 'a', position: 1, role: 'branch' }, { id: 'b', position: 2, role: 'group' }])).toEqual(['GROUP_BELOW_BRANCH']);
    expect(levelListProblems([{ id: 'a', position: 1, role: 'place' }, { id: 'b', position: 2, role: 'branch' }])).toEqual(['PLACE_ABOVE_BRANCH']);
    expect(levelListProblems([{ id: 'a', position: 1, role: 'branch' }, { id: 'b', position: 2, role: 'branch' }])).toEqual(['MANY_BRANCH_LEVELS']);
    expect(levelListProblems(Array.from({ length: 9 }, (_, i) => ({ id: `l${i}`, position: i + 1, role: i === 0 ? 'branch' as const : 'place' as const })))).toContain('TOO_MANY');
  });

  it('gives an inserted level its role from where it lands, and shifts the levels below', () => {
    expect(roleForNewLevel(corporate, 1)).toBe('group');
    expect(roleForNewLevel(corporate, 2)).toBe('group'); // above the branch level, which moves to 3
    expect(roleForNewLevel(corporate, 3)).toBe('place');
    expect(roleForNewLevel(corporate, 6)).toBe('place');
    expect(positionsAfterInsert(corporate, 4)).toEqual([{ id: 'floor', position: 5 }, { id: 'zone', position: 6 }]);
    expect(positionsAfterDelete(corporate, 'site')).toEqual([{ id: 'floor', position: 3 }, { id: 'zone', position: 4 }]);
    expect(positionsAfterDelete(corporate, 'nope')).toEqual([]);
  });

  it('turns any level list into a template, keeping the branch level (its branches point at it)', () => {
    const plan = templateLevelPlan(corporate, locationTemplate('FACILITIES'));
    expect(plan.branch).toEqual({ id: 'br', position: 1, name: 'Site', nameAr: 'موقع', icon: 'site' });
    expect(plan.deleteIds.sort()).toEqual(['floor', 'hq', 'site', 'zone']);
    expect(plan.insert.map((l) => [l.position, l.role, l.name])).toEqual([[2, 'place', 'Building'], [3, 'place', 'Floor'], [4, 'place', 'Zone']]);
    const regional = templateLevelPlan([{ id: 'br', position: 1, role: 'branch' }], locationTemplate('REGIONAL'));
    expect(regional.branch.position).toBe(3);
    expect(regional.insert.map((l) => `${l.position}:${l.role}`)).toEqual(['1:group', '2:group', '4:place', '5:place', '6:place']);
  });

  it('ships templates that are well-formed level lists with Arabic names', () => {
    for (const t of LOCATION_TEMPLATES) {
      const levels = t.levels.map((l, i) => ({ id: `${t.key}-${i}`, position: i + 1, role: l.role }));
      expect(levelListProblems(levels), t.key).toEqual([]);
      for (const l of t.levels) expect(l.nameAr.length, `${t.key} ${l.name}`).toBeGreaterThan(0);
    }
    expect(locationTemplate('CORPORATE').levels.map((l) => l.name)).toEqual(['Headquarters', 'Branch', 'Site', 'Floor', 'Zone']);
  });
});

describe('placement', () => {
  const hq = { id: 'n-hq', role: 'group' as const, levelPosition: 1, path: ['n-hq'] };
  const branch = { id: 'n-b1', role: 'branch' as const, levelPosition: 2, path: ['n-hq', 'n-b1'] };
  const site = { id: 'n-sa', role: 'place' as const, levelPosition: 3, path: ['n-hq', 'n-b1', 'n-sa'] };

  it('allows the shapes of the standard hierarchy, skipping levels included', () => {
    expect(placementProblem({ role: 'group', levelPosition: 1, parent: null })).toBeNull();
    expect(placementProblem({ role: 'branch', levelPosition: 2, parent: hq })).toBeNull();
    expect(placementProblem({ role: 'branch', levelPosition: 2, parent: null })).toBeNull();
    expect(placementProblem({ role: 'place', levelPosition: 3, parent: branch })).toBeNull();
    expect(placementProblem({ role: 'place', levelPosition: 5, parent: branch })).toBeNull(); // a zone straight under the branch
    expect(placementProblem({ role: 'place', levelPosition: 4, parent: site })).toBeNull();
  });

  it('refuses the shapes the database refuses', () => {
    expect(placementProblem({ role: 'place', levelPosition: 3, parent: null })).toBe('PLACE_AT_TOP');
    expect(placementProblem({ role: 'place', levelPosition: 3, parent: hq })).toBe('PLACE_UNDER_GROUP');
    expect(placementProblem({ role: 'group', levelPosition: 1, parent: branch })).toBe('GROUP_UNDER_NON_GROUP');
    expect(placementProblem({ role: 'branch', levelPosition: 2, parent: site })).toBe('BRANCH_UNDER_NON_GROUP');
    expect(placementProblem({ role: 'place', levelPosition: 3, parent: site })).toBe('NOT_DEEPER');
    expect(placementProblem({ role: 'place', levelPosition: 4, parent: site, selfId: 'n-b1' })).toBe('CYCLE');
    expect(placementProblem({ role: 'place', levelPosition: 4, parent: { ...site, status: 'archived' } })).toBe('PARENT_ARCHIVED');
  });

  it('offers the levels a child may use', () => {
    expect(childLevelsFor(corporate, null).map((l) => l.id)).toEqual(['hq']);
    expect(childLevelsFor(corporate, { role: 'group', levelPosition: 1 }).map((l) => l.id)).toEqual([]); // branches come with the branches
    expect(childLevelsFor(corporate, { role: 'branch', levelPosition: 2 }).map((l) => l.id)).toEqual(['site', 'floor', 'zone']);
    expect(childLevelsFor(corporate, { role: 'place', levelPosition: 4 }).map((l) => l.id)).toEqual(['zone']);
  });
});

describe('tree walks', () => {
  const nodes = [
    { id: 'hq', parentId: null, role: 'group' as const, name: 'Muscat HQ' },
    { id: 'b1', parentId: 'hq', role: 'branch' as const, name: 'Branch 1' },
    { id: 'b2', parentId: 'hq', role: 'branch' as const, name: 'Branch 2' },
    { id: 'sa', parentId: 'b1', role: 'place' as const, name: 'Site A' },
    { id: 'f2', parentId: 'sa', role: 'place' as const, name: 'Floor 2' },
    { id: 'zc', parentId: 'f2', role: 'place' as const, name: 'Zone C' },
  ];

  it('walks subtrees and ancestors', () => {
    expect(subtreeIds(nodes, 'b1').sort()).toEqual(['b1', 'f2', 'sa', 'zc']);
    expect(subtreeIds(nodes, 'zc')).toEqual(['zc']);
    expect(ancestorsOf(nodes, 'zc').map((n) => n.id)).toEqual(['hq', 'b1', 'sa', 'f2']);
    expect(ancestorsOf(nodes, 'hq')).toEqual([]);
  });

  it('rolls counts up the tree', () => {
    const totals = rollUp(nodes, new Map([['zc', 3], ['f2', 1], ['b2', 10]]));
    expect(totals.get('zc')).toBe(3);
    expect(totals.get('sa')).toBe(4);
    expect(totals.get('b1')).toBe(4);
    expect(totals.get('hq')).toBe(14);
  });

  it('labels a place by its path below the branch', () => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(placeLabel(byId, 'zc')).toBe('Site A › Floor 2 › Zone C');
    expect(placeLabel(byId, 'sa')).toBe('Site A');
    expect(placeLabel(byId, 'hq')).toBe('Muscat HQ');
    expect(placeLabel(byId, 'missing')).toBeNull();
  });
});

describe('codes', () => {
  it('derives a code from the name, unique among the siblings', () => {
    expect(deriveLocationCode('Floor 2', [])).toBe('FLOOR-2');
    expect(deriveLocationCode('Floor 2', ['floor-2'])).toBe('FLOOR-2-2');
    expect(deriveLocationCode('Floor 2', ['FLOOR-2', 'FLOOR-2-2'])).toBe('FLOOR-2-3');
    expect(deriveLocationCode('Café Zone', [])).toBe('CAFE-ZONE');
    expect(deriveLocationCode('الطابق الثاني', [])).toBe('LOC');
    expect(deriveLocationCode('A very long location name that goes on and on', []).length).toBeLessThanOrEqual(32);
    expect(deriveLocationCode('A very long location name that goes on and on', [])).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
  });
});
