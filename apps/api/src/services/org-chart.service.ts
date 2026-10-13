import { sql, type RawBuilder } from 'kysely';
import { uuidSchema, type OrgChartFilter, type OrgChartNodeDto, type OrgChartPathDto, type OrgChartQuery } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { branchFilter, requirePermission } from '../lib/authorize.js';
import { type Actor, runUser } from '../lib/service.js';
import { likeContains, pageOf, toCount } from '../lib/pagination.js';
import { MAX_REPORTING_DEPTH } from './employees.service.js';
import { LEFT_EMPLOYMENT_STATUSES } from './offboarding.js';

/**
 * Org chart (GET /orgs/:orgId/org-chart, docs/api.md "Org chart & reporting lines"): the PRIMARY reporting line, one level at
 * a time, over "the chart's set" S = the organisation's employees who are not archived and have not left, in the caller's
 * branch scope and in the optional branch / department filter. `employee.view` only: the chart is the organisation's
 * directory drawn as a tree, a line manager (employee.view_team) has the team workspace. Everything is read as the caller
 * (RLS applies underneath; S is a subset of what it shows an `employee.view` holder in the same branches).
 */

interface ChartSet { orgId: string; branchIds: string[] | null; departmentId: string | null }

function chartSet(grant: MembershipGrant, orgId: string, filter: OrgChartFilter): ChartSet {
  // strict branch scope (no own-record / team rows beyond it, unlike the directory): a chart with holes is no chart
  return { orgId, branchIds: branchFilter(grant, filter.branchId), departmentId: filter.departmentId ?? null };
}

/**
 * "Row `alias` of public.employees is in S" — THE definition of the set, applied to every alias that reads employees (the
 * cards, the direct-report count, the "manager in S" test, the path walk), so the tree, the counts and the path never
 * disagree about who is on the chart. Raw SQL because the recursive path query needs it too.
 */
function inChart(alias: 'e' | 'm' | 'r', s: ChartSet): RawBuilder<boolean> {
  const col = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`(${col('organization_id')} = ${s.orgId}::uuid and ${col('deleted_at')} is null and ${col('employment_status')} not in (${sql.join([...LEFT_EMPLOYMENT_STATUSES])})${
    s.branchIds ? sql` and ${col('branch_id')} = any(${s.branchIds}::uuid[])` : sql``}${s.departmentId ? sql` and ${col('department_id')} = ${s.departmentId}::uuid` : sql``})`;
}

function chartQuery(trx: Trx, s: ChartSet) {
  return trx.selectFrom('employees as e')
    .leftJoin('branches as b', 'b.id', 'e.branchId')
    .leftJoin('departments as d', 'd.id', 'e.departmentId')
    .leftJoin('designations as g', 'g.id', 'e.designationId')
    // the dotted-line manager's name, when the caller can see them (RLS), wherever they sit
    .leftJoin('employees as mgr2', 'mgr2.id', 'e.secondaryManagerEmployeeId')
    .where(inChart('e', s));
}

const NODE_COLUMNS = [
  'e.id', 'e.employeeNumber', 'e.displayName', 'e.displayNameAr', 'g.name as designationName', 'd.name as departmentName', 'e.branchId', 'b.name as branchName',
  'e.employmentStatus', 'e.managerEmployeeId', 'e.secondaryManagerEmployeeId', 'mgr2.displayName as secondaryManagerName',
] as const;

type NodeRow = Omit<OrgChartNodeDto, 'photoUrl' | 'directReportCount'> & { directReportCount: unknown };
const toNodeDto = (r: NodeRow): OrgChartNodeDto => ({ ...r, photoUrl: null, directReportCount: toCount(r.directReportCount) });

/** GET /orgs/:orgId/org-chart — a manager's direct reports (`managerId`), the heads of the chart (`top`) or the unassigned. */
export async function listOrgChart(deps: ApiDeps, actor: Actor, orgId: string, q: OrgChartQuery): Promise<{ data: OrgChartNodeDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'employee.view');
  const s = chartSet(grant, orgId, q);
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = chartQuery(trx, s);
    if (q.managerId) {
      const managerId = q.managerId;
      // a manager outside the set has no branch of the chart to open (same answer as an unknown id)
      const manager = await trx.selectFrom('employees as e').select('e.id').where('e.id', '=', managerId).where(inChart('e', s)).executeTakeFirst();
      if (!manager) throw errors.notFound('Employee', managerId);
      base = base.where('e.managerEmployeeId', '=', managerId);
    } else {
      // no manager in the set: none at all, or one outside the branch / department filter or the caller's scope, or a leaver
      base = base.where(({ not, exists, selectFrom }) => not(exists(selectFrom('employees as m').select('m.id').whereRef('m.id', '=', 'e.managerEmployeeId').where(inChart('m', s)))));
      // a head leads somebody in the set; the unassigned lead nobody in it
      base = base.where((eb) => {
        const leads = eb.exists(eb.selectFrom('employees as r').select('r.id').whereRef('r.managerEmployeeId', '=', 'e.id').where(inChart('r', s)));
        return q.view === 'top' ? leads : eb.not(leads);
      });
      if (q.view === 'unassigned' && q.search) {
        // the name the list shows: the Arabic UI shows displayNameAr where it is set, so both names match
        const like = likeContains(q.search);
        base = base.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb('e.displayNameAr', 'ilike', like), eb(sql`e.employee_number::text`, 'ilike', like)]));
      }
    }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    let rows = base.select(NODE_COLUMNS)
      .select((eb) => eb.selectFrom('employees as r').select((x) => x.fn.countAll().as('n')).whereRef('r.managerEmployeeId', '=', 'e.id').where(inChart('r', s)).as('directReportCount'));
    // the heads with the biggest teams first; a level of the tree and the unassigned list read alphabetically
    if (!q.managerId && q.view === 'top') rows = rows.orderBy('directReportCount', 'desc');
    const data = await rows.orderBy('e.displayName').orderBy('e.id').limit(page.pageSize).offset(page.offset).execute();
    return { data: data.map((r) => toNodeDto(r as NodeRow)), total };
  });
}

/**
 * GET /orgs/:orgId/org-chart/path/:employeeId — where one employee sits: their primary managers in the set, from the head of
 * the chart down to the direct manager (the walk stops at the first manager outside the set, after MAX_REPORTING_DEPTH levels,
 * or on a loop), and whether they are on the tree at all.
 */
export async function getOrgChartPath(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, filter: OrgChartFilter): Promise<OrgChartPathDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.view');
  const s = chartSet(grant, orgId, filter);
  // a malformed id names nobody: 404 like an unknown one (never a uuid cast error)
  if (!uuidSchema.safeParse(employeeId).success) throw errors.notFound('Employee', employeeId);
  return runUser(deps.db, actor, async (trx) => {
    const { rows } = await sql<{ id: string; depth: number }>`
      with recursive up(id, manager_id, depth, seen) as (
        select e.id, e.manager_employee_id, 0, array[e.id]
        from public.employees e
        where e.id = ${employeeId}::uuid and ${inChart('e', s)}
        union all
        select m.id, m.manager_employee_id, u.depth + 1, u.seen || m.id
        from up u
        join public.employees m on m.id = u.manager_id and ${inChart('m', s)}
        where u.depth < ${MAX_REPORTING_DEPTH} and m.id <> all(u.seen)
      )
      select up.id, up.depth from up order by up.depth`.execute(trx);
    if (rows.length === 0) throw errors.notFound('Employee', employeeId);
    const ancestorIds = rows.slice(1).map((r) => r.id).reverse();
    if (ancestorIds.length > 0) return { employeeId, placement: 'tree', ancestorIds };
    const report = await trx.selectFrom('employees as r').select('r.id').where('r.managerEmployeeId', '=', employeeId).where(inChart('r', s)).limit(1).executeTakeFirst();
    return { employeeId, placement: report ? 'tree' : 'unassigned', ancestorIds };
  });
}
