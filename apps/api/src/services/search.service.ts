import { sql } from 'kysely';
import type { SearchResult, SearchResultItem, SearchResultType } from '@flowza/contracts';
import type { ApiDeps } from '../deps.js';
import { branchFilter, hasPermission, requireMembership } from '../lib/authorize.js';
import { type Actor, runUser } from '../lib/service.js';
import { likeContains, prefixTsQuery } from '../lib/pagination.js';

const PER_TYPE = 8;

export async function search(deps: ApiDeps, actor: Actor, orgId: string, q: string, types?: string): Promise<SearchResult> {
  const grant = requireMembership(actor.principal, orgId);
  const wanted = new Set<SearchResultType>((types ? types.split(',') : ['employee', 'device', 'branch', 'department']).filter((t): t is SearchResultType => ['employee', 'device', 'branch', 'department'].includes(t)));
  const scope = branchFilter(grant);
  const like = likeContains(q);
  const tsq = prefixTsQuery(q);
  return runUser(deps.db, actor, async (trx) => {
    const out: SearchResult = { q, employees: [], devices: [], branches: [], departments: [] };
    if (wanted.has('employee') && hasPermission(grant, 'employee.view')) {
      let base = trx.selectFrom('employees as e').where('e.organizationId', '=', orgId).where('e.deletedAt', 'is', null);
      if (scope) base = base.where('e.branchId', 'in', scope);
      const rows = await base.select(['e.id', 'e.displayName', 'e.employeeNumber', 'e.branchId', 'e.employmentStatus'])
        .where((eb) => eb.or([...(tsq ? [sql<boolean>`e.search @@ to_tsquery('simple', ${tsq})`] : []), eb('e.displayName', 'ilike', like), eb(sql`e.employee_number::text`, 'ilike', like), eb('e.deviceUserId', 'ilike', like), eb(sql`e.email::text`, 'ilike', like)]))
        .orderBy('e.displayName').limit(PER_TYPE).execute();
      out.employees = rows.map((r): SearchResultItem => ({ type: 'employee', id: r.id, title: r.displayName, subtitle: String(r.employeeNumber), branchId: r.branchId, status: r.employmentStatus }));
    }
    if (wanted.has('device') && hasPermission(grant, 'device.view')) {
      let base = trx.selectFrom('devices as d').where('d.organizationId', '=', orgId);
      if (scope) base = base.where('d.branchId', 'in', scope);
      const rows = await base.select(['d.id', 'd.name', 'd.code', 'd.serialNumber', 'd.branchId', 'd.connectionStatus'])
        .where((eb) => eb.or([eb('d.name', 'ilike', like), eb(sql`d.code::text`, 'ilike', like), eb('d.serialNumber', 'ilike', like)]))
        .orderBy('d.name').limit(PER_TYPE).execute();
      out.devices = rows.map((r): SearchResultItem => ({ type: 'device', id: r.id, title: r.name, subtitle: [String(r.code), r.serialNumber].filter(Boolean).join(' · '), branchId: r.branchId, status: r.connectionStatus }));
    }
    if (wanted.has('branch') && hasPermission(grant, 'branch.view')) {
      let base = trx.selectFrom('branches as b').where('b.organizationId', '=', orgId);
      if (scope) base = base.where('b.id', 'in', scope);
      const rows = await base.select(['b.id', 'b.name', 'b.code', 'b.city', 'b.status']).where((eb) => eb.or([eb('b.name', 'ilike', like), eb(sql`b.code::text`, 'ilike', like), eb('b.city', 'ilike', like)])).orderBy('b.name').limit(PER_TYPE).execute();
      out.branches = rows.map((r): SearchResultItem => ({ type: 'branch', id: r.id, title: r.name, subtitle: [String(r.code), r.city].filter(Boolean).join(' · '), branchId: r.id, status: r.status }));
    }
    if (wanted.has('department') && hasPermission(grant, 'department.view')) {
      let base = trx.selectFrom('departments as d').where('d.organizationId', '=', orgId);
      if (scope) base = base.where((eb) => eb.or([eb('d.branchId', 'is', null), eb('d.branchId', 'in', scope)]));
      const rows = await base.select(['d.id', 'd.name', 'd.code', 'd.branchId', 'd.status']).where((eb) => eb.or([eb('d.name', 'ilike', like), eb(sql`d.code::text`, 'ilike', like)])).orderBy('d.name').limit(PER_TYPE).execute();
      out.departments = rows.map((r): SearchResultItem => ({ type: 'department', id: r.id, title: r.name, subtitle: String(r.code), branchId: r.branchId, status: r.status }));
    }
    return out;
  });
}
