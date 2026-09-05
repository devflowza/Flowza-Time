export interface TreeRow { id: string; parentId: string | null }
export interface TreeNode<T> { row: T; depth: number }

/**
 * Orders a flat page of departments depth-first (parent, then its children) and annotates each row with its depth.
 * Rows whose parent is not on this page are treated as roots (paginated lists cannot guarantee the parent is present).
 */
export function orderAsTree<T extends TreeRow>(rows: T[]): TreeNode<T>[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string | null, T[]>();
  for (const r of rows) {
    const key = r.parentId && ids.has(r.parentId) ? r.parentId : null;
    const list = children.get(key) ?? [];
    list.push(r);
    children.set(key, list);
  }
  const out: TreeNode<T>[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const r of children.get(parent) ?? []) {
      if (visited.has(r.id)) continue; // defensive: cycles are rejected by the API, but never loop forever
      visited.add(r.id);
      out.push({ row: r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const r of rows) if (!visited.has(r.id)) out.push({ row: r, depth: 0 });
  return out;
}
