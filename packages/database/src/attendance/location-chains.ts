import type { Trx } from '../context.js';
import { uuidArray } from './policy.js';

/*
 * The employees' location chains for policy resolution (docs/locations.md §3) — `loadPolicyScope`'s rule for a whole page or
 * roster of employees, one query per table whatever their number: the path of the employee's work location when that place
 * belongs to the branch they work in on the date (the placement the caller resolved — a deployment, or a past date in another
 * branch, falls back to that branch), else the path of the branch's node. Runs under whatever context the caller established.
 */

const CHUNK = 1000;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/**
 * Employee id → the location chain (root first) for the given placements. An employee whose branch has no node in the tree
 * (never once the location migration ran: a trigger creates one per branch) is absent — no location policy matches them.
 */
export async function loadLocationChains(trx: Trx, organizationId: string, placements: ReadonlyArray<{ employeeId: string; branchId: string }>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (placements.length === 0) return out;
  const employeeIds = [...new Set(placements.map((p) => p.employeeId))];
  const branchIds = [...new Set(placements.map((p) => p.branchId))];
  const work = new Map<string, { branchId: string | null; path: string[] }>();
  for (const batch of chunks(employeeIds)) {
    const rows = await trx.selectFrom('employees as e')
      .innerJoin('locations as wl', (j) => j.onRef('wl.id', '=', 'e.workLocationId').onRef('wl.organizationId', '=', 'e.organizationId'))
      .select(['e.id', 'wl.branchId', 'wl.path'])
      .where('e.organizationId', '=', organizationId).where('e.id', 'in', batch)
      .execute();
    for (const r of rows) {
      const path = uuidArray(r.path);
      if (path) work.set(r.id, { branchId: r.branchId, path });
    }
  }
  const nodes = new Map<string, string[]>();
  for (const batch of chunks(branchIds)) {
    const rows = await trx.selectFrom('locations').select(['branchId', 'path'])
      .where('organizationId', '=', organizationId).where('role', '=', 'branch').where('branchId', 'in', batch)
      .execute();
    for (const r of rows) {
      const path = uuidArray(r.path);
      if (r.branchId && path) nodes.set(r.branchId, path);
    }
  }
  for (const p of placements) {
    const own = work.get(p.employeeId);
    const chain = own && own.branchId === p.branchId ? own.path : nodes.get(p.branchId);
    if (chain) out.set(p.employeeId, chain);
  }
  return out;
}
