import type { AuditLogDto, AuditLogQuery } from '@flowza/contracts';
import type { ApiDeps } from '../deps.js';
import { branchFilter, requirePermission } from '../lib/authorize.js';
import { type Actor, runUser } from '../lib/service.js';
import { pageOf, resolveSort, toCount } from '../lib/pagination.js';
import { isoDateTime } from '../lib/mappers.js';
import { sql } from 'kysely';

const AUDIT_SORT = { createdAt: 'a.created_at', action: 'a.action', entityType: 'a.entity_type' } as const;

export async function listAudit(deps: ApiDeps, actor: Actor, orgId: string, q: AuditLogQuery): Promise<{ data: AuditLogDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'audit.view');
  const scope = branchFilter(grant, q.branchId);
  const sort = resolveSort(AUDIT_SORT, q.sort, q.order === 'asc' && q.sort ? 'asc' : q.sort ? q.order : 'desc', 'a.created_at');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = trx.selectFrom('audit.logs as a').leftJoin('userProfiles as u', 'u.id', 'a.actorUserId').where('a.organizationId', '=', orgId);
    if (scope) base = q.branchId ? base.where('a.branchId', '=', q.branchId) : base.where((eb) => eb.or([eb('a.branchId', 'is', null), eb('a.branchId', 'in', scope)]));
    if (q.entityType) base = base.where('a.entityType', '=', q.entityType);
    if (q.entityId) base = base.where('a.entityId', '=', q.entityId);
    if (q.actorUserId) base = base.where('a.actorUserId', '=', q.actorUserId);
    if (q.action) base = q.action.endsWith('.') || !q.action.includes('.') ? base.where('a.action', 'like', `${q.action.replace(/[%_]/g, '')}%`) : base.where('a.action', '=', q.action);
    if (q.from) base = base.where('a.createdAt', '>=', new Date(q.from));
    if (q.to) base = base.where('a.createdAt', '<=', new Date(q.to));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(['a.id', 'a.organizationId', 'a.actorUserId', 'a.actorType', 'a.actorLabel', 'a.action', 'a.entityType', 'a.entityId', 'a.branchId', 'a.oldValue', 'a.newValue', 'a.reason', 'a.ip', 'a.requestId', 'a.jobId', 'a.createdAt', 'u.fullName as actorName'])
      .orderBy(sql.raw(sort.column), sort.direction).orderBy('a.id', sort.direction).limit(page.pageSize).offset(page.offset).execute();
    return {
      data: rows.map((r): AuditLogDto => ({
        id: String(r.id), organizationId: r.organizationId, actorUserId: r.actorUserId, actorType: r.actorType, actorLabel: r.actorLabel, actorName: r.actorName ?? null, action: r.action, entityType: r.entityType, entityId: r.entityId,
        branchId: r.branchId, oldValue: r.oldValue, newValue: r.newValue, reason: r.reason, ip: r.ip === null ? null : String(r.ip), requestId: r.requestId, jobId: r.jobId === null ? null : String(r.jobId), createdAt: isoDateTime(r.createdAt),
      })),
      total,
    };
  });
}
