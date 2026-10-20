import { timeOffCountsAsWorkByDefault, type TimeOffCategory, type TimeOffTypeDto, type TimeOffTypeInput, type TimeOffTypeUpdateInput } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, diffObjects, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate } from '../../lib/mappers.js';
import { toCount } from '../../lib/pagination.js';
import { recalcLeaveRange } from '../leave/lifecycle.js';
import { TYPE_COLUMNS, loadTimeOffTypes, toTimeOffTypeDto, type TypeRow } from './common.js';

/**
 * Short leave types (HR → Leave → Short leave types): list with leave.view, manage with leave.manage. Writes run under the
 * caller's RLS (time_off_types takes leave.manage writes). A type in use is archived instead of deleted; a change of what an
 * approved window means for the day (counts as work, category) recomputes the past days it shaped.
 */

/**
 * The default set, offered as a one-click seed (codes the organisation already has are left alone): a personal permission
 * (at most 2 hours per request, 4 hours a month), an official assignment and remote work (both count as work), the nursing hour
 * (women, one hour) and short leave for persons with disabilities (two hours).
 */
export const DEFAULT_TIME_OFF_TYPES: ReadonlyArray<{ code: string; name: string; nameAr: string; category: TimeOffCategory; maxMinutesPerRequest: number | null; monthlyQuotaMinutes: number | null; monthlyQuotaCount: number | null; applicableGender: 'all' | 'female' }> = [
  { code: 'PERSONAL', name: 'Personal permission', nameAr: 'استئذان شخصي', category: 'PERSONAL', maxMinutesPerRequest: 120, monthlyQuotaMinutes: 240, monthlyQuotaCount: null, applicableGender: 'all' },
  { code: 'OFFICIAL', name: 'Official assignment', nameAr: 'مهمة رسمية', category: 'OFFICIAL', maxMinutesPerRequest: null, monthlyQuotaMinutes: null, monthlyQuotaCount: null, applicableGender: 'all' },
  { code: 'REMOTE', name: 'Remote work', nameAr: 'عمل عن بعد', category: 'REMOTE', maxMinutesPerRequest: null, monthlyQuotaMinutes: null, monthlyQuotaCount: null, applicableGender: 'all' },
  { code: 'NURSING', name: 'Nursing hour', nameAr: 'ساعة رضاعة', category: 'NURSING', maxMinutesPerRequest: 60, monthlyQuotaMinutes: null, monthlyQuotaCount: null, applicableGender: 'female' },
  { code: 'DISABILITY', name: 'Short leave for persons with disabilities', nameAr: 'استئذان لذوي الإعاقة', category: 'DISABILITY', maxMinutesPerRequest: 120, monthlyQuotaMinutes: null, monthlyQuotaCount: null, applicableGender: 'all' },
];

async function oneType(trx: Trx, orgId: string, id: string): Promise<TimeOffTypeDto | null> {
  const r = await trx.selectFrom('timeOffTypes').select(TYPE_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
  return r ? toTimeOffTypeDto(r as TypeRow) : null;
}

export async function listTimeOffTypes(deps: ApiDeps, actor: Actor, orgId: string): Promise<TimeOffTypeDto[]> {
  requirePermission(actor.principal, orgId, 'leave.view');
  return runUser(deps.db, actor, (trx) => loadTimeOffTypes(trx, orgId));
}

/** POST /time-off-types/seed-defaults — adds the default codes the organisation does not have; never touches existing types. */
export async function seedTimeOffTypes(deps: ApiDeps, actor: Actor, orgId: string): Promise<{ created: string[]; types: TimeOffTypeDto[] }> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const existing = new Set((await trx.selectFrom('timeOffTypes').select('code').where('organizationId', '=', orgId).execute()).map((r) => String(r.code).toUpperCase()));
    const missing = DEFAULT_TIME_OFF_TYPES.filter((d) => !existing.has(d.code));
    if (missing.length) {
      await trx.insertInto('timeOffTypes').values(missing.map((d) => ({
        organizationId: orgId, code: d.code, name: d.name, nameAr: d.nameAr, category: d.category, countsAsWork: timeOffCountsAsWorkByDefault(d.category),
        maxMinutesPerRequest: d.maxMinutesPerRequest, monthlyQuotaMinutes: d.monthlyQuotaMinutes, monthlyQuotaCount: d.monthlyQuotaCount, applicableGender: d.applicableGender, createdBy: actor.userId,
      }))).execute();
      await audit(trx, actor, orgId, 'time_off_type.seeded', 'time_off_type', { newValue: { created: missing.map((d) => d.code) } });
    }
    return { created: missing.map((d) => d.code), types: await loadTimeOffTypes(trx, orgId) };
  });
}

export async function createTimeOffType(deps: ApiDeps, actor: Actor, orgId: string, input: TimeOffTypeInput): Promise<TimeOffTypeDto> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const dup = await trx.selectFrom('timeOffTypes').select('id').where('organizationId', '=', orgId).where('code', '=', input.code).executeTakeFirst();
    if (dup) throw errors.conflict(`A short leave type with the code ${input.code} already exists.`, { reason: 'DUPLICATE_CODE' });
    const row = await trx.insertInto('timeOffTypes').values({
      organizationId: orgId, code: input.code, name: input.name, nameAr: input.nameAr ?? null, category: input.category,
      countsAsWork: input.countsAsWork ?? timeOffCountsAsWorkByDefault(input.category),
      maxMinutesPerRequest: input.maxMinutesPerRequest ?? null, monthlyQuotaMinutes: input.monthlyQuotaMinutes ?? null, monthlyQuotaCount: input.monthlyQuotaCount ?? null,
      requiresApproval: input.requiresApproval ?? true, applicableGender: input.applicableGender ?? 'all', portalVisible: input.portalVisible ?? true, status: input.status ?? 'active', createdBy: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    const dto = (await oneType(trx, orgId, row.id))!;
    await audit(trx, actor, orgId, 'time_off_type.created', 'time_off_type', { entityId: row.id, newValue: dto as unknown as Record<string, unknown> });
    return dto;
  });
}

export async function updateTimeOffType(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: TimeOffTypeUpdateInput): Promise<TimeOffTypeDto> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await oneType(trx, orgId, id);
    if (!before) throw errors.notFound('Short leave type', id);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length) await trx.updateTable('timeOffTypes').set(patch).where('organizationId', '=', orgId).where('id', '=', id).execute();
    const after = (await oneType(trx, orgId, id))!;
    await audit(trx, actor, orgId, 'time_off_type.updated', 'time_off_type', { entityId: id, ...diffObjects(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>) });
    // what an approved window means for the day changed: recompute the past days the type's approved windows shaped
    if (before.countsAsWork !== after.countsAsWork || before.category !== after.category) {
      const earliest = await withSystemScope(trx, orgId, (s) => s.selectFrom('timeOffRequests').select((eb) => eb.fn.min('requestDate').as('from')).where('organizationId', '=', orgId).where('timeOffTypeId', '=', id).where('status', '=', 'APPROVED').executeTakeFirst());
      if (earliest?.from) await recalcLeaveRange(deps, trx, actor, orgId, isoDate(earliest.from as Date), null, { reason: `short leave type ${after.code} changed` });
    }
    return after;
  });
}

export async function deleteTimeOffType(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<{ archived: boolean }> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const t = await oneType(trx, orgId, id);
    if (!t) throw errors.notFound('Short leave type', id);
    // requests are system-written: count them in the system view of the organisation (HR may not see every branch's)
    const used = toCount((await withSystemScope(trx, orgId, (s) => s.selectFrom('timeOffRequests').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('timeOffTypeId', '=', id).executeTakeFirst()))?.n);
    if (used > 0) {
      await trx.updateTable('timeOffTypes').set({ status: 'archived' }).where('organizationId', '=', orgId).where('id', '=', id).execute();
      await audit(trx, actor, orgId, 'time_off_type.archived', 'time_off_type', { entityId: id, oldValue: { code: t.code, status: t.status }, reason: `${used} short leave request(s) reference it` });
      return { archived: true };
    }
    await trx.deleteFrom('timeOffTypes').where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'time_off_type.deleted', 'time_off_type', { entityId: id, oldValue: { code: t.code } });
    return { archived: false };
  });
}
