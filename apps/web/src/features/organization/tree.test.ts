import { describe, expect, it } from 'vitest';
import { orderAsTree } from './tree';

describe('orderAsTree', () => {
  it('places children directly after their parent with increasing depth', () => {
    const rows = [
      { id: 'c', parentId: 'a', name: 'Child' },
      { id: 'a', parentId: null, name: 'Root A' },
      { id: 'b', parentId: null, name: 'Root B' },
      { id: 'd', parentId: 'c', name: 'Grandchild' },
    ];
    const out = orderAsTree(rows).map((n) => `${n.row.id}:${n.depth}`);
    expect(out).toEqual(['a:0', 'c:1', 'd:2', 'b:0']);
  });
  it('treats rows whose parent is not on the page as roots', () => {
    const out = orderAsTree([{ id: 'x', parentId: 'missing' }]);
    expect(out).toEqual([{ row: { id: 'x', parentId: 'missing' }, depth: 0 }]);
  });
  it('never loops on cyclic data', () => {
    const out = orderAsTree([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }]);
    expect(out).toHaveLength(2);
  });
});
