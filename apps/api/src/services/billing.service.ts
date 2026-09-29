/**
 * Modules, plans & pricing, billing and platform settings (migration 20260929000600) — the super-admin portal's Modules,
 * Plans & Pricing, Billing and Settings pages (Flowza Finance /adm parity) and the tenant's own Subscription view.
 *
 * Same conventions as platform-admin.service.ts: every platform handler starts with `requirePlatformAdmin`; reads run in the
 * caller's session (platform-admin read policies); writes run in the target organisation's system context (or the platform
 * scope for reference data: modules, plans, settings) and are audited as PLATFORM_ADMIN on the organisation, so the tenant
 * sees what the platform changed. Money is computed by the pure helpers of @flowza/contracts (integer minor units).
 */
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { z } from 'zod';
import {
  MODULE_CATEGORIES, computeInvoiceTotals, quoteSubscription, subscriptionInvoiceLines,
  type ApplyModuleToAllInput, type ApplyModuleToAllResult, type BillingCycle, type BillingInvoiceDto, type BillingPaymentDto, type BillingSummaryDto,
  type CreateInvoiceInput, type CreatePlanInput, type InvoiceLineInput, type ModuleCategory, type OrgModuleStateDto, type PlatformModuleDto,
  type PlatformPlanDto, type PlatformSettings, type PlatformSettingsDto, type PutOrgModulesInput, type PutPlatformSettingsInput, type RecordPaymentInput,
  type TenantSubscriptionDto, type UpdatePlanInput, type UpdatePlatformModuleInput, type VoidInvoiceInput,
  type invoiceListQuerySchema, type paymentListQuerySchema,
} from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requirePermission, requirePlatformAdmin } from '../lib/authorize.js';
import { type Actor, runUser, runSystem, audit, diffObjects, PLATFORM_SCOPE_ORG } from '../lib/service.js';
import { likeContains, pageOf, toCount } from '../lib/pagination.js';
import { isoDate, isoDateOrNull, isoDateTime, isoDateTimeOrNull, jsonArray, jsonObject, numberOrNull } from '../lib/mappers.js';

type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;
type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;

const BILLING_ZONE = 'Asia/Muscat';
const LIVE_STATUSES = ['trialing', 'active', 'past_due'] as const;

const platformAudit = (trx: Trx, actor: Actor, orgId: string | null, action: string, entityType: string, opts: Parameters<typeof audit>[5] = {}) =>
  audit(trx, actor, orgId, action, entityType, { ...opts, actorType: 'PLATFORM_ADMIN' });

const todayInZone = () => DateTime.now().setZone(BILLING_ZONE).toISODate()!;
const num = (v: unknown): number => numberOrNull(v as string | number | null | undefined) ?? 0;
const category = (c: string): ModuleCategory => ((MODULE_CATEGORIES as readonly string[]).includes(c) ? (c as ModuleCategory) : 'workforce');

// ------------------------------------------------------------------------------------------------------------------------------
// Platform settings
// ------------------------------------------------------------------------------------------------------------------------------

/** Settings key ↔ field of the structured settings object, with the value the migration seeds (used when a key is missing). */
const SETTING_FIELDS = [
  { key: 'general.platform_name', group: 'general', field: 'platformName', fallback: 'FlowZa Time' },
  { key: 'general.support_email', group: 'general', field: 'supportEmail', fallback: 'support@flowza.ai' },
  { key: 'billing.currency', group: 'billing', field: 'currency', fallback: 'OMR' },
  { key: 'billing.vat_rate', group: 'billing', field: 'vatRate', fallback: 5 },
  { key: 'billing.invoice_prefix', group: 'billing', field: 'invoicePrefix', fallback: 'FZT' },
  { key: 'billing.payment_terms_days', group: 'billing', field: 'paymentTermsDays', fallback: 14 },
  { key: 'billing.seller_name', group: 'billing', field: 'sellerName', fallback: 'F & Z Capital' },
  { key: 'billing.seller_vat_number', group: 'billing', field: 'sellerVatNumber', fallback: '' },
  { key: 'billing.seller_address', group: 'billing', field: 'sellerAddress', fallback: 'Muscat, Sultanate of Oman' },
  { key: 'billing.bank_details', group: 'billing', field: 'bankDetails', fallback: '' },
] as const;

/** Reads the settings visible in the current context (platform admin: all; system context: all; a tenant user: public ones). */
export async function loadPlatformSettings(trx: Trx): Promise<PlatformSettingsDto> {
  const rows = await trx.selectFrom('platformSettings').select(['key', 'value', 'updatedAt']).execute();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: Record<string, Record<string, unknown>> = { general: {}, billing: {} };
  let updatedAt: Date | null = null;
  for (const f of SETTING_FIELDS) {
    const row = byKey.get(f.key);
    const value = row?.value;
    out[f.group]![f.field] = typeof value === typeof f.fallback ? value : f.fallback;
    if (row && (!updatedAt || row.updatedAt > updatedAt)) updatedAt = row.updatedAt;
  }
  return { ...(out as unknown as PlatformSettings), updatedAt: isoDateTimeOrNull(updatedAt) };
}

export async function getPlatformSettings(deps: ApiDeps, actor: Actor): Promise<PlatformSettingsDto> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, loadPlatformSettings);
}

export async function putPlatformSettings(deps: ApiDeps, actor: Actor, input: PutPlatformSettingsInput): Promise<PlatformSettingsDto> {
  requirePlatformAdmin(actor.principal);
  return runSystem(deps.db, PLATFORM_SCOPE_ORG, actor.requestId, async (trx) => {
    const before = await loadPlatformSettings(trx);
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const f of SETTING_FIELDS) {
      const group = input[f.group] as Record<string, unknown> | undefined;
      const value = group?.[f.field];
      if (value === undefined) continue;
      const prev = (before[f.group] as Record<string, unknown>)[f.field];
      if (JSON.stringify(prev) === JSON.stringify(value)) continue;
      changed[f.key] = { from: prev, to: value };
      await trx.insertInto('platformSettings').values({ key: f.key, value: JSON.stringify(value), updatedBy: actor.userId })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updatedBy: actor.userId })).execute();
    }
    if (Object.keys(changed).length > 0) {
      await platformAudit(trx, actor, null, 'platform.settings_updated', 'platform_settings', {
        oldValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.from])), newValue: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.to])),
      });
    }
    return loadPlatformSettings(trx);
  });
}

// ------------------------------------------------------------------------------------------------------------------------------
// Modules
// ------------------------------------------------------------------------------------------------------------------------------

interface ModuleStateRow { organizationId: string; moduleKey: string; enabled: boolean; inPlan: boolean; override: boolean | null; available: boolean; lapsed: boolean }

/** Effective module states through the guarded `app.org_module_states` (members, the org's system context, platform admins). */
export async function moduleStates(trx: Trx, orgIds: string[]): Promise<ModuleStateRow[]> {
  if (orgIds.length === 0) return [];
  const { rows } = await sql<ModuleStateRow>`
    select organization_id as "organizationId", module_key as "moduleKey", enabled, in_plan as "inPlan", override, available, lapsed
    from app.org_module_states(${orgIds}::uuid[])`.execute(trx);
  return rows;
}

async function orgModules(trx: Trx, orgId: string): Promise<OrgModuleStateDto[]> {
  const catalogue = await trx.selectFrom('modules').select(['key', 'name', 'description', 'category', 'sortOrder']).orderBy('sortOrder').orderBy('key').execute();
  const states = new Map((await moduleStates(trx, [orgId])).map((s) => [s.moduleKey, s]));
  const overrides = new Map((await trx.selectFrom('organizationModules').select(['moduleKey', 'reason', 'updatedAt']).where('organizationId', '=', orgId).execute()).map((o) => [o.moduleKey, o]));
  return catalogue.map((m) => {
    const s = states.get(m.key);
    const o = overrides.get(m.key);
    return {
      key: m.key, name: m.name, description: m.description, category: category(m.category),
      enabled: s?.enabled ?? true, inPlan: s?.inPlan ?? true, override: s?.override ?? null, available: s?.available ?? true, lapsed: s?.lapsed ?? false,
      reason: o?.reason ?? null, updatedAt: isoDateTimeOrNull(o?.updatedAt ?? null),
    };
  });
}

export async function listModules(deps: ApiDeps, actor: Actor): Promise<PlatformModuleDto[]> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const catalogue = await trx.selectFrom('modules').selectAll().orderBy('sortOrder').orderBy('key').execute();
    const orgIds = (await trx.selectFrom('organizations').select('id').execute()).map((o) => o.id);
    const states = await moduleStates(trx, orgIds);
    const plans = await trx.selectFrom('plans').select(['key', 'modules']).orderBy('sortOrder').execute();
    return catalogue.map((m) => {
      const mine = states.filter((s) => s.moduleKey === m.key);
      return {
        key: m.key, name: m.name, description: m.description, category: category(m.category), sortOrder: m.sortOrder, isAvailable: m.isAvailable,
        enabledCount: mine.filter((s) => s.enabled).length, totalOrganizations: orgIds.length,
        overrideOnCount: mine.filter((s) => s.override === true).length, overrideOffCount: mine.filter((s) => s.override === false).length,
        planKeys: plans.filter((p) => p.modules.includes(m.key)).map((p) => p.key), updatedAt: isoDateTime(m.updatedAt),
      };
    });
  });
}

async function requireModule(trx: Trx, key: string): Promise<void> {
  const m = await trx.selectFrom('modules').select('key').where('key', '=', key).executeTakeFirst();
  if (!m) throw errors.notFound('Module', key);
}

/** PATCH /platform/modules/:key — the fleet-wide switch (off ⇒ off for every tenant, whatever its plan or override). */
export async function updateModule(deps: ApiDeps, actor: Actor, key: string, input: UpdatePlatformModuleInput): Promise<PlatformModuleDto> {
  requirePlatformAdmin(actor.principal);
  await runSystem(deps.db, PLATFORM_SCOPE_ORG, actor.requestId, async (trx) => {
    const before = await trx.selectFrom('modules').select(['key', 'isAvailable']).where('key', '=', key).executeTakeFirst();
    if (!before) throw errors.notFound('Module', key);
    if (before.isAvailable === input.isAvailable) return;
    await trx.updateTable('modules').set({ isAvailable: input.isAvailable, updatedBy: actor.userId }).where('key', '=', key).execute();
    await platformAudit(trx, actor, null, 'platform.module_updated', 'module', { entityId: key, oldValue: { isAvailable: before.isAvailable }, newValue: { isAvailable: input.isAvailable }, reason: input.reason });
  });
  const all = await listModules(deps, actor);
  return all.find((m) => m.key === key)!;
}

async function setOrgModules(trx: Trx, actor: Actor, orgId: string, changes: Record<string, boolean | null>, reason: string): Promise<boolean> {
  const before = new Map((await trx.selectFrom('organizationModules').select(['moduleKey', 'enabled']).where('organizationId', '=', orgId).execute()).map((o) => [o.moduleKey, o.enabled]));
  const oldValue: Record<string, boolean | null> = {};
  const newValue: Record<string, boolean | null> = {};
  for (const [key, enabled] of Object.entries(changes)) {
    const prev = before.get(key) ?? null;
    if (prev === enabled) continue;
    if (enabled === null) await trx.deleteFrom('organizationModules').where('organizationId', '=', orgId).where('moduleKey', '=', key).execute();
    else await trx.insertInto('organizationModules').values({ organizationId: orgId, moduleKey: key, enabled, reason, updatedBy: actor.userId })
      .onConflict((oc) => oc.columns(['organizationId', 'moduleKey']).doUpdateSet({ enabled, reason, updatedBy: actor.userId })).execute();
    oldValue[key] = prev;
    newValue[key] = enabled;
  }
  if (Object.keys(newValue).length === 0) return false;
  await platformAudit(trx, actor, orgId, 'organization.modules_changed', 'organization_modules', { entityId: orgId, oldValue, newValue, reason });
  return true;
}

/** POST /platform/modules/:key/apply-all — the same override (or none) for every tenant; each change audited on its tenant. */
export async function applyModuleToAll(deps: ApiDeps, actor: Actor, key: string, input: ApplyModuleToAllInput): Promise<ApplyModuleToAllResult> {
  requirePlatformAdmin(actor.principal);
  const orgIds = await runUser(deps.db, actor, async (trx) => {
    await requireModule(trx, key);
    return (await trx.selectFrom('organizations').select('id').orderBy('createdAt').execute()).map((o) => o.id);
  });
  const value = input.action === 'enable' ? true : input.action === 'disable' ? false : null;
  let changed = 0;
  for (const orgId of orgIds) {
    if (await runSystem(deps.db, orgId, actor.requestId, (trx) => setOrgModules(trx, actor, orgId, { [key]: value }, input.reason))) changed += 1;
  }
  return { key, action: input.action, organizations: changed };
}

export async function getOrgModules(deps: ApiDeps, actor: Actor, orgId: string): Promise<OrgModuleStateDto[]> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', orgId);
    return orgModules(trx, orgId);
  });
}

/** PUT /platform/orgs/:id/modules — switch modules on / off for one tenant, or back to what the plan says (null). */
export async function putOrgModules(deps: ApiDeps, actor: Actor, orgId: string, input: PutOrgModulesInput): Promise<OrgModuleStateDto[]> {
  requirePlatformAdmin(actor.principal);
  if (Object.keys(input.modules).length === 0) throw errors.validation('Change at least one module.', { issues: [{ path: 'modules', message: 'Empty' }] });
  return runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    const org = await trx.selectFrom('organizations').select('id').where('id', '=', orgId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', orgId);
    await setOrgModules(trx, actor, orgId, input.modules as Record<string, boolean | null>, input.reason);
    return orgModules(trx, orgId);
  });
}

// ------------------------------------------------------------------------------------------------------------------------------
// Plans
// ------------------------------------------------------------------------------------------------------------------------------

const PLAN_COLUMNS = ['id', 'key', 'name', 'description', 'prices', 'limits', 'features', 'modules', 'includedUsers', 'trialDays', 'isCustom', 'isActive', 'sortOrder'] as const;

export async function listPlans(deps: ApiDeps, actor: Actor): Promise<PlatformPlanDto[]> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const plans = await trx.selectFrom('plans').select(PLAN_COLUMNS).orderBy('sortOrder').orderBy('key').execute();
    const counts = await trx.selectFrom('subscriptions').select(['planId', (eb) => eb.fn.countAll().as('n'),
      (eb) => eb.fn.count(sql`case when status in ('trialing', 'active', 'past_due') then 1 end`).as('live')]).groupBy('planId').execute();
    const byPlan = new Map(counts.map((c) => [c.planId, c]));
    return plans.map((p) => ({
      id: p.id, key: p.key, name: p.name, description: p.description, prices: jsonObject(p.prices), limits: jsonObject(p.limits), features: p.features,
      modules: p.modules, includedUsers: p.includedUsers, trialDays: p.trialDays, isCustom: p.isCustom, isActive: p.isActive, sortOrder: p.sortOrder,
      subscribers: toCount(byPlan.get(p.id)?.n), liveSubscribers: toCount(byPlan.get(p.id)?.live),
    }));
  });
}

function planValues(input: Partial<CreatePlanInput>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  if (input.name !== undefined) v.name = input.name;
  if (input.description !== undefined) v.description = input.description;
  if (input.prices !== undefined) v.prices = JSON.stringify(input.prices);
  if (input.limits !== undefined) v.limits = JSON.stringify(input.limits);
  if (input.features !== undefined) v.features = input.features;
  if (input.modules !== undefined) v.modules = input.modules;
  if (input.includedUsers !== undefined) v.includedUsers = input.includedUsers;
  if (input.trialDays !== undefined) v.trialDays = input.trialDays;
  if (input.isCustom !== undefined) v.isCustom = input.isCustom;
  if (input.isActive !== undefined) v.isActive = input.isActive;
  if (input.sortOrder !== undefined) v.sortOrder = input.sortOrder;
  return v;
}

async function planByKey(deps: ApiDeps, actor: Actor, key: string): Promise<PlatformPlanDto> {
  const plan = (await listPlans(deps, actor)).find((p) => p.key === key);
  if (!plan) throw errors.notFound('Plan', key);
  return plan;
}

export async function createPlan(deps: ApiDeps, actor: Actor, input: CreatePlanInput): Promise<PlatformPlanDto> {
  requirePlatformAdmin(actor.principal);
  await runSystem(deps.db, PLATFORM_SCOPE_ORG, actor.requestId, async (trx) => {
    const exists = await trx.selectFrom('plans').select('id').where('key', '=', input.key).executeTakeFirst();
    if (exists) throw errors.conflict(`A plan with the key "${input.key}" already exists.`);
    const values = { key: input.key, name: input.name, ...planValues(input) } as never;
    const created = await trx.insertInto('plans').values(values).returning(PLAN_COLUMNS).executeTakeFirstOrThrow();
    await platformAudit(trx, actor, null, 'platform.plan_created', 'plan', { entityId: created.key, newValue: { ...input } });
  });
  return planByKey(deps, actor, input.key);
}

export async function updatePlan(deps: ApiDeps, actor: Actor, key: string, input: UpdatePlanInput): Promise<PlatformPlanDto> {
  requirePlatformAdmin(actor.principal);
  await runSystem(deps.db, PLATFORM_SCOPE_ORG, actor.requestId, async (trx) => {
    const before = await trx.selectFrom('plans').select(PLAN_COLUMNS).where('key', '=', key).executeTakeFirst();
    if (!before) throw errors.notFound('Plan', key);
    const values = planValues(input);
    if (Object.keys(values).length === 0) return;
    await trx.updateTable('plans').set(values as never).where('key', '=', key).execute();
    const after = await trx.selectFrom('plans').select(PLAN_COLUMNS).where('key', '=', key).executeTakeFirstOrThrow();
    const diff = diffObjects({ ...before, prices: jsonObject(before.prices), limits: jsonObject(before.limits) } as Record<string, unknown>,
      { ...after, prices: jsonObject(after.prices), limits: jsonObject(after.limits) } as Record<string, unknown>);
    await platformAudit(trx, actor, null, 'platform.plan_updated', 'plan', { entityId: key, ...diff });
  });
  return planByKey(deps, actor, key);
}

// ------------------------------------------------------------------------------------------------------------------------------
// Invoices & payments
// ------------------------------------------------------------------------------------------------------------------------------

type InvoiceRow = {
  id: string; organizationId: string; invoiceNumber: string; status: string; currency: string; planKey: string | null; planName: string | null;
  billingCycle: string | null; seats: number | null; periodStart: Date | string | null; periodEnd: Date | string | null; lines: unknown;
  subtotal: string | number; discount: string | number; taxRate: string | number; taxAmount: string | number; total: string | number; amountPaid: string | number;
  activatesSubscription: boolean; subscriptionAppliedAt: Date | null; issueDate: Date | string; dueDate: Date | string | null; paidAt: Date | null;
  voidedAt: Date | null; voidReason: string | null; notes: string | null; seller: unknown; customer: unknown; createdByLabel: string | null; createdAt: Date;
  organizationName?: string | null;
};
const INVOICE_COLUMNS = ['i.id', 'i.organizationId', 'i.invoiceNumber', 'i.status', 'i.currency', 'i.planKey', 'i.planName', 'i.billingCycle', 'i.seats', 'i.periodStart',
  'i.periodEnd', 'i.lines', 'i.subtotal', 'i.discount', 'i.taxRate', 'i.taxAmount', 'i.total', 'i.amountPaid', 'i.activatesSubscription', 'i.subscriptionAppliedAt',
  'i.issueDate', 'i.dueDate', 'i.paidAt', 'i.voidedAt', 'i.voidReason', 'i.notes', 'i.seller', 'i.customer', 'i.createdByLabel', 'i.createdAt'] as const;

function toInvoiceDto(r: InvoiceRow, payments?: BillingPaymentDto[]): BillingInvoiceDto {
  const total = num(r.total);
  const amountPaid = num(r.amountPaid);
  const dueDate = isoDateOrNull(r.dueDate);
  const status = r.status as BillingInvoiceDto['status'];
  return {
    id: r.id, organizationId: r.organizationId, organizationName: r.organizationName ?? null, invoiceNumber: r.invoiceNumber, status,
    overdue: status === 'issued' && amountPaid < total && dueDate !== null && dueDate < todayInZone(),
    currency: r.currency, planKey: r.planKey, planName: r.planName, billingCycle: r.billingCycle as BillingInvoiceDto['billingCycle'], seats: r.seats,
    periodStart: isoDateOrNull(r.periodStart), periodEnd: isoDateOrNull(r.periodEnd),
    lines: jsonArray<Record<string, unknown>>(r.lines).map((l) => ({ description: String(l.description ?? ''), quantity: num(l.quantity), unitPrice: num(l.unitPrice), amount: num(l.amount) })),
    subtotal: num(r.subtotal), discount: num(r.discount), taxRate: num(r.taxRate), taxAmount: num(r.taxAmount), total, amountPaid,
    balance: Math.max(0, Math.round((total - amountPaid) * 1000) / 1000),
    activatesSubscription: r.activatesSubscription, subscriptionAppliedAt: isoDateTimeOrNull(r.subscriptionAppliedAt),
    issueDate: isoDate(r.issueDate), dueDate, paidAt: isoDateTimeOrNull(r.paidAt), voidedAt: isoDateTimeOrNull(r.voidedAt), voidReason: r.voidReason, notes: r.notes,
    seller: jsonObject(r.seller), customer: jsonObject(r.customer), createdByLabel: r.createdByLabel, createdAt: isoDateTime(r.createdAt),
    ...(payments ? { payments } : {}),
  };
}

type PaymentRow = { id: string; organizationId: string; invoiceId: string; invoiceNumber: string; kind: string; amount: string | number; currency: string; method: string;
  reference: string | null; receivedOn: Date | string; notes: string | null; recordedByLabel: string | null; createdAt: Date };
function toPaymentDto(p: PaymentRow): BillingPaymentDto {
  return { id: p.id, organizationId: p.organizationId, invoiceId: p.invoiceId, invoiceNumber: p.invoiceNumber, kind: p.kind as BillingPaymentDto['kind'], amount: num(p.amount),
    currency: p.currency, method: p.method as BillingPaymentDto['method'], reference: p.reference, receivedOn: isoDate(p.receivedOn), notes: p.notes,
    recordedByLabel: p.recordedByLabel, createdAt: isoDateTime(p.createdAt) };
}
function paymentQuery(trx: Trx) {
  return trx.selectFrom('billingPayments as p').innerJoin('billingInvoices as i', 'i.id', 'p.invoiceId')
    .select(['p.id', 'p.organizationId', 'p.invoiceId', 'i.invoiceNumber', 'p.kind', 'p.amount', 'p.currency', 'p.method', 'p.reference', 'p.receivedOn', 'p.notes', 'p.recordedByLabel', 'p.createdAt']);
}

async function loadInvoice(trx: Trx, id: string): Promise<BillingInvoiceDto | null> {
  const row = await trx.selectFrom('billingInvoices as i').leftJoin('organizations as o', 'o.id', 'i.organizationId')
    .select([...INVOICE_COLUMNS, 'o.displayName as organizationName']).where('i.id', '=', id).executeTakeFirst();
  if (!row) return null;
  const payments = (await paymentQuery(trx).where('p.invoiceId', '=', id).orderBy('p.createdAt').execute()).map(toPaymentDto);
  return toInvoiceDto(row as InvoiceRow, payments);
}

export async function listInvoices(deps: ApiDeps, actor: Actor, q: InvoiceListQuery): Promise<{ data: BillingInvoiceDto[]; total: number }> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = trx.selectFrom('billingInvoices as i').leftJoin('organizations as o', 'o.id', 'i.organizationId');
    if (q.organizationId) base = base.where('i.organizationId', '=', q.organizationId);
    if (q.status) base = base.where('i.status', '=', q.status);
    if (q.overdueOnly) base = base.where('i.status', '=', 'issued').where('i.dueDate', '<', sql<Date>`${todayInZone()}::date`).whereRef('i.amountPaid', '<', 'i.total');
    if (q.search) { const term = likeContains(q.search); base = base.where((eb) => eb.or([eb('i.invoiceNumber', 'ilike', term), eb('o.displayName', 'ilike', term), eb(sql`o.company_code::text`, 'ilike', term)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select([...INVOICE_COLUMNS, 'o.displayName as organizationName']).orderBy('i.issueDate', 'desc').orderBy('i.invoiceNumber', 'desc').limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map((r) => toInvoiceDto(r as InvoiceRow)), total };
  });
}

export async function getInvoice(deps: ApiDeps, actor: Actor, id: string): Promise<BillingInvoiceDto> {
  requirePlatformAdmin(actor.principal);
  const inv = await runUser(deps.db, actor, (trx) => loadInvoice(trx, id));
  if (!inv) throw errors.notFound('Invoice', id);
  return inv;
}

export async function listPayments(deps: ApiDeps, actor: Actor, q: PaymentListQuery): Promise<{ data: BillingPaymentDto[]; total: number }> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = trx.selectFrom('billingPayments as p');
    if (q.organizationId) base = base.where('p.organizationId', '=', q.organizationId);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    let rows = paymentQuery(trx);
    if (q.organizationId) rows = rows.where('p.organizationId', '=', q.organizationId);
    const data = (await rows.orderBy('p.receivedOn', 'desc').orderBy('p.createdAt', 'desc').limit(page.pageSize).offset(page.offset).execute()).map(toPaymentDto);
    return { data, total };
  });
}

function periodEndFor(start: string, cycle: 'monthly' | 'yearly' | 'custom'): string | null {
  if (cycle === 'custom') return null;
  return DateTime.fromISO(start, { zone: BILLING_ZONE }).plus(cycle === 'yearly' ? { years: 1 } : { months: 1 }).minus({ days: 1 }).toISODate();
}

/** POST /platform/billing/invoices — issue an invoice (a plan priced for a cycle and seats, and / or custom lines). */
export async function createInvoice(deps: ApiDeps, actor: Actor, input: CreateInvoiceInput): Promise<BillingInvoiceDto> {
  requirePlatformAdmin(actor.principal);
  const id = await runSystem(deps.db, input.organizationId, actor.requestId, async (trx) => {
    const org = await trx.selectFrom('organizations').select(['id', 'legalName', 'displayName', 'companyCode', 'address', 'contact', 'status']).where('id', '=', input.organizationId).executeTakeFirst();
    if (!org) throw errors.notFound('Organisation', input.organizationId);
    const settings = await loadPlatformSettings(trx);
    const currency = settings.billing.currency;
    const sub = await trx.selectFrom('subscriptions').select(['billingCycle', 'seats']).where('organizationId', '=', org.id).executeTakeFirst();
    const lines: InvoiceLineInput[] = [];
    let plan: { key: string; name: string } | null = null;
    let cycle: 'monthly' | 'yearly' | 'custom' = 'custom';
    let seats: number | null = null;
    if (input.planKey) {
      const p = await trx.selectFrom('plans').select(['key', 'name', 'prices', 'includedUsers', 'isActive', 'isCustom']).where('key', '=', input.planKey).executeTakeFirst();
      if (!p) throw errors.validation(`Unknown plan "${input.planKey}".`, { issues: [{ path: 'planKey', message: 'Unknown plan' }] });
      cycle = input.billingCycle ?? (sub?.billingCycle as BillingCycle | undefined) ?? 'yearly';
      const employees = toCount((await trx.selectFrom('employees').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', org.id).where('deletedAt', 'is', null)
        .where('employmentStatus', 'not in', ['terminated', 'resigned']).executeTakeFirst())?.n);
      seats = input.seats ?? sub?.seats ?? Math.max(p.includedUsers ?? 0, employees, 1);
      const quote = quoteSubscription({ prices: jsonObject(p.prices), includedUsers: p.includedUsers, currency, cycle, seats });
      if (quote) lines.push(...subscriptionInvoiceLines({ planName: p.name, quote }));
      else if ((input.lines?.length ?? 0) === 0) {
        throw errors.validation(`The plan "${p.name}" has no ${currency} price${p.isCustom ? ' (custom pricing)' : ''}: add the invoice lines.`, { issues: [{ path: 'lines', message: 'Required for a plan without a price' }] });
      }
      plan = { key: p.key, name: p.name };
    }
    lines.push(...(input.lines ?? []));
    const totals = computeInvoiceTotals({ lines, discount: input.discount, taxRate: input.taxRate ?? settings.billing.vatRate, currency });
    const issueDate = input.issueDate ?? todayInZone();
    const periodStart = input.periodStart ?? (plan ? issueDate : null);
    const periodEnd = input.periodEnd ?? (periodStart ? periodEndFor(periodStart, cycle) : null);
    const dueDate = input.dueDate ?? DateTime.fromISO(issueDate, { zone: BILLING_ZONE }).plus({ days: settings.billing.paymentTermsDays }).toISODate();
    const { rows } = await sql<{ n: string }>`select app.next_billing_invoice_number(${settings.billing.invoicePrefix}) as n`.execute(trx);
    const free = totals.total === 0;
    const now = new Date();
    const inserted = await trx.insertInto('billingInvoices').values({
      organizationId: org.id, invoiceNumber: rows[0]!.n, status: free ? 'paid' : 'issued', currency, planKey: plan?.key ?? null, planName: plan?.name ?? null,
      billingCycle: plan ? cycle : 'custom', seats, periodStart, periodEnd, lines: JSON.stringify(totals.lines), subtotal: totals.subtotal, discount: totals.discount,
      taxRate: totals.taxRate, taxAmount: totals.taxAmount, total: totals.total, amountPaid: 0, activatesSubscription: plan ? (input.activatesSubscription ?? true) : false,
      issueDate, dueDate, paidAt: free ? now : null, notes: input.notes ?? null,
      seller: JSON.stringify({ name: settings.billing.sellerName, vatNumber: settings.billing.sellerVatNumber, address: settings.billing.sellerAddress, bankDetails: settings.billing.bankDetails, supportEmail: settings.general.supportEmail, platformName: settings.general.platformName }),
      customer: JSON.stringify({ legalName: org.legalName, displayName: org.displayName, companyCode: String(org.companyCode), address: jsonObject(org.address), contact: jsonObject(org.contact) }),
      createdBy: actor.userId, createdByLabel: actor.email || null,
    }).returning(['id', 'invoiceNumber', 'total']).executeTakeFirstOrThrow();
    await platformAudit(trx, actor, org.id, 'billing.invoice_issued', 'billing_invoice', { entityId: inserted.id, newValue: { invoiceNumber: inserted.invoiceNumber, planKey: plan?.key ?? null, cycle, seats, total: totals.total, currency } });
    if (free) await applyInvoiceToSubscription(trx, actor, inserted.id);
    return inserted.id;
  });
  return getInvoice(deps, actor, id);
}

/** A fully paid plan invoice moves the subscription to the invoiced plan, cycle, seats and period (once). */
async function applyInvoiceToSubscription(trx: Trx, actor: Actor, invoiceId: string): Promise<void> {
  const inv = await trx.selectFrom('billingInvoices').select(['id', 'organizationId', 'planKey', 'billingCycle', 'seats', 'periodStart', 'periodEnd', 'activatesSubscription', 'subscriptionAppliedAt', 'status', 'invoiceNumber'])
    .where('id', '=', invoiceId).executeTakeFirstOrThrow();
  if (inv.status !== 'paid' || !inv.activatesSubscription || inv.subscriptionAppliedAt || !inv.planKey) return;
  const plan = await trx.selectFrom('plans').select('id').where('key', '=', inv.planKey).executeTakeFirst();
  if (!plan) return;
  const zoneDay = (d: Date | string | null, endOfDay: boolean) => {
    if (!d) return null;
    const dt = DateTime.fromISO(isoDate(d), { zone: BILLING_ZONE });
    return (endOfDay ? dt.endOf('day') : dt.startOf('day')).toJSDate();
  };
  const before = await trx.selectFrom('subscriptions').select(['planId', 'status', 'billingCycle', 'seats', 'currentPeriodStart', 'currentPeriodEnd', 'cancelAt']).where('organizationId', '=', inv.organizationId).executeTakeFirst();
  const next = {
    planId: plan.id, status: 'active' as const, billingCycle: (inv.billingCycle === 'monthly' ? 'monthly' : 'yearly') as BillingCycle, seats: inv.seats,
    currentPeriodStart: zoneDay(inv.periodStart, false) ?? new Date(), currentPeriodEnd: zoneDay(inv.periodEnd, true), cancelAt: null,
  };
  if (before) await trx.updateTable('subscriptions').set(next).where('organizationId', '=', inv.organizationId).execute();
  else await trx.insertInto('subscriptions').values({ organizationId: inv.organizationId, ...next }).execute();
  await trx.updateTable('billingInvoices').set({ subscriptionAppliedAt: new Date() }).where('id', '=', inv.id).execute();
  // a paying tenant is no longer on trial
  const org = await trx.selectFrom('organizations').select('status').where('id', '=', inv.organizationId).executeTakeFirst();
  if (org?.status === 'trial') {
    await trx.updateTable('organizations').set({ status: 'active' }).where('id', '=', inv.organizationId).execute();
    await platformAudit(trx, actor, inv.organizationId, 'organization.status_changed', 'organization', { entityId: inv.organizationId, oldValue: { status: 'trial' }, newValue: { status: 'active' }, reason: `Invoice ${inv.invoiceNumber} paid` });
  }
  await platformAudit(trx, actor, inv.organizationId, 'organization.subscription_changed', 'subscription', {
    entityId: inv.organizationId,
    oldValue: before ? { planId: before.planId, status: before.status, billingCycle: before.billingCycle, seats: before.seats, currentPeriodEnd: isoDateTimeOrNull(before.currentPeriodEnd) } : null,
    newValue: { planKey: inv.planKey, status: 'active', billingCycle: next.billingCycle, seats: next.seats, currentPeriodEnd: isoDateTimeOrNull(next.currentPeriodEnd) },
    reason: `Invoice ${inv.invoiceNumber} paid`,
  });
}

async function invoiceOrg(deps: ApiDeps, actor: Actor, invoiceId: string): Promise<string> {
  const row = await runUser(deps.db, actor, (trx) => trx.selectFrom('billingInvoices').select('organizationId').where('id', '=', invoiceId).executeTakeFirst());
  if (!row) throw errors.notFound('Invoice', invoiceId);
  return row.organizationId;
}

/** POST /platform/billing/invoices/:id/payments — a payment (up to the balance) or a refund (up to what was paid). */
export async function recordPayment(deps: ApiDeps, actor: Actor, invoiceId: string, input: RecordPaymentInput): Promise<BillingInvoiceDto> {
  requirePlatformAdmin(actor.principal);
  const orgId = await invoiceOrg(deps, actor, invoiceId);
  await runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    const inv = await trx.selectFrom('billingInvoices').select(['id', 'organizationId', 'invoiceNumber', 'status', 'currency', 'total', 'amountPaid']).where('id', '=', invoiceId).forUpdate().executeTakeFirstOrThrow();
    if (inv.status === 'void') throw errors.invalidState('A void invoice takes no payment.');
    const kind = input.kind ?? 'payment';
    const total = num(inv.total);
    const paid = num(inv.amountPaid);
    const cents = (v: number) => Math.round(v * 1000);
    if (kind === 'payment' && cents(input.amount) > cents(total) - cents(paid)) throw errors.validation(`The payment exceeds the invoice balance (${((cents(total) - cents(paid)) / 1000).toFixed(3)} ${inv.currency}).`, { issues: [{ path: 'amount', message: 'More than the balance' }] });
    if (kind === 'refund' && cents(input.amount) > cents(paid)) throw errors.validation(`The refund exceeds what was paid (${paid.toFixed(3)} ${inv.currency}).`, { issues: [{ path: 'amount', message: 'More than was paid' }] });
    await trx.insertInto('billingPayments').values({
      organizationId: inv.organizationId, invoiceId: inv.id, kind, amount: input.amount, currency: inv.currency, method: input.method, reference: input.reference ?? null,
      receivedOn: input.receivedOn ?? todayInZone(), notes: input.notes ?? null, recordedBy: actor.userId, recordedByLabel: actor.email || null,
    }).execute();
    const newPaidMinor = kind === 'payment' ? cents(paid) + cents(input.amount) : cents(paid) - cents(input.amount);
    const fullyPaid = newPaidMinor >= cents(total);
    await trx.updateTable('billingInvoices').set({ amountPaid: newPaidMinor / 1000, status: fullyPaid ? 'paid' : 'issued', paidAt: fullyPaid ? new Date() : null })
      .where('id', '=', inv.id).execute();
    await platformAudit(trx, actor, inv.organizationId, kind === 'payment' ? 'billing.payment_recorded' : 'billing.refund_recorded', 'billing_invoice', {
      entityId: inv.id, newValue: { invoiceNumber: inv.invoiceNumber, kind, amount: input.amount, currency: inv.currency, method: input.method, amountPaid: newPaidMinor / 1000 },
    });
    if (fullyPaid) await applyInvoiceToSubscription(trx, actor, inv.id);
  });
  return getInvoice(deps, actor, invoiceId);
}

/** POST /platform/billing/invoices/:id/void — only an invoice with nothing paid on it (refund first). */
export async function voidInvoice(deps: ApiDeps, actor: Actor, invoiceId: string, input: VoidInvoiceInput): Promise<BillingInvoiceDto> {
  requirePlatformAdmin(actor.principal);
  const orgId = await invoiceOrg(deps, actor, invoiceId);
  await runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    const inv = await trx.selectFrom('billingInvoices').select(['id', 'invoiceNumber', 'status', 'amountPaid', 'total']).where('id', '=', invoiceId).forUpdate().executeTakeFirstOrThrow();
    if (inv.status === 'void') throw errors.invalidState('The invoice is already void.');
    if (num(inv.amountPaid) > 0) throw errors.invalidState('Refund the payments on this invoice before voiding it.');
    await trx.updateTable('billingInvoices').set({ status: 'void', voidedAt: new Date(), voidReason: input.reason, paidAt: null }).where('id', '=', inv.id).execute();
    await platformAudit(trx, actor, orgId, 'billing.invoice_voided', 'billing_invoice', { entityId: inv.id, oldValue: { status: inv.status }, newValue: { status: 'void', invoiceNumber: inv.invoiceNumber }, reason: input.reason });
  });
  return getInvoice(deps, actor, invoiceId);
}

// ------------------------------------------------------------------------------------------------------------------------------
// Revenue summary
// ------------------------------------------------------------------------------------------------------------------------------

export async function billingSummary(deps: ApiDeps, actor: Actor): Promise<BillingSummaryDto> {
  requirePlatformAdmin(actor.principal);
  return runUser(deps.db, actor, async (trx) => {
    const settings = await loadPlatformSettings(trx);
    const currency = settings.billing.currency;
    const subs = await trx.selectFrom('subscriptions as s').innerJoin('plans as p', 'p.id', 's.planId').innerJoin('organizations as o', 'o.id', 's.organizationId')
      .select(['s.organizationId', 'o.displayName', 'o.companyCode', 'p.key as planKey', 'p.name as planName', 'p.prices', 'p.includedUsers', 's.status', 's.billingCycle', 's.seats',
        's.currentPeriodEnd', 's.trialEndsAt'])
      .orderBy('o.displayName').execute();
    const { rows: employeeCounts } = await sql<{ organizationId: string; employees: string }>`select organization_id as "organizationId", employees from app.platform_org_counts(null)`.execute(trx);
    const employeesByOrg = new Map(employeeCounts.map((r) => [r.organizationId, toCount(r.employees)]));
    let mrrMinor = 0;
    let paying = 0; let trialing = 0; let unpriced = 0;
    const byPlan = new Map<string, { planKey: string; planName: string; subscriptions: number; mrrMinor: number }>();
    const rows = subs.map((s) => {
      const cycle = (s.billingCycle === 'monthly' ? 'monthly' : 'yearly') as BillingCycle;
      const employees = employeesByOrg.get(s.organizationId) ?? 0;
      const quote = quoteSubscription({ prices: jsonObject(s.prices), includedUsers: s.includedUsers, currency, cycle, seats: s.seats });
      const counts = s.status === 'active' || s.status === 'past_due';
      if (s.status === 'trialing') trialing += 1;
      const entry = byPlan.get(s.planKey) ?? { planKey: s.planKey, planName: s.planName, subscriptions: 0, mrrMinor: 0 };
      if ((LIVE_STATUSES as readonly string[]).includes(s.status)) entry.subscriptions += 1;
      if (counts) {
        if (quote) { paying += 1; const m = Math.round(quote.monthlyEquivalent * 1000); mrrMinor += m; entry.mrrMinor += m; } else unpriced += 1;
      }
      byPlan.set(s.planKey, entry);
      return {
        organizationId: s.organizationId, organizationName: s.displayName, companyCode: String(s.companyCode), planKey: s.planKey, planName: s.planName,
        status: s.status, billingCycle: cycle, seats: s.seats, employees, amount: quote?.amount ?? null, mrr: counts && quote ? quote.monthlyEquivalent : null,
        currentPeriodEnd: isoDateTimeOrNull(s.currentPeriodEnd), trialEndsAt: isoDateTimeOrNull(s.trialEndsAt),
      };
    });
    const open = await trx.selectFrom('billingInvoices').select(['total', 'amountPaid', 'dueDate']).where('status', '=', 'issued').execute();
    const today = todayInZone();
    let outstandingMinor = 0; let overdueMinor = 0; let overdue = 0;
    for (const i of open) {
      const bal = Math.round(num(i.total) * 1000) - Math.round(num(i.amountPaid) * 1000);
      outstandingMinor += bal;
      if (bal > 0 && i.dueDate && isoDate(i.dueDate) < today) { overdue += 1; overdueMinor += bal; }
    }
    const since = DateTime.fromISO(today, { zone: BILLING_ZONE }).minus({ days: 30 }).toISODate()!;
    const recent = await trx.selectFrom('billingPayments').select(['kind', 'amount']).where('receivedOn', '>=', sql<Date>`${since}::date`).execute();
    const collectedMinor = recent.reduce((a, p) => a + (p.kind === 'refund' ? -1 : 1) * Math.round(num(p.amount) * 1000), 0);
    return {
      currency, mrr: mrrMinor / 1000, arr: (mrrMinor * 12) / 1000, payingSubscriptions: paying, trialingSubscriptions: trialing, unpricedSubscriptions: unpriced,
      outstanding: outstandingMinor / 1000, overdueInvoices: overdue, overdueAmount: overdueMinor / 1000, collectedLast30Days: collectedMinor / 1000,
      byPlan: [...byPlan.values()].map((b) => ({ planKey: b.planKey, planName: b.planName, subscriptions: b.subscriptions, mrr: b.mrrMinor / 1000 })),
      subscriptions: rows,
    };
  });
}

// ------------------------------------------------------------------------------------------------------------------------------
// Tenant view
// ------------------------------------------------------------------------------------------------------------------------------

/** GET /orgs/:orgId/subscription — the tenant's plan, price, limits and usage, modules and the plans it could move to. */
export async function getTenantSubscription(deps: ApiDeps, actor: Actor, orgId: string): Promise<TenantSubscriptionDto> {
  requirePermission(actor.principal, orgId, 'organization.view');
  // read in the organisation's system context after the permission check: the tenant's plan may be inactive (hidden from
  // members by the plans policy) and usage counts must cover every branch, not only the caller's scope. Nothing is written.
  return runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    const s = await trx.selectFrom('subscriptions as s').innerJoin('plans as p', 'p.id', 's.planId')
      .select(['p.key as planKey', 'p.name as planName', 'p.prices', 'p.limits', 'p.features', 'p.includedUsers', 'p.isCustom', 's.status', 's.trialEndsAt',
        's.currentPeriodStart', 's.currentPeriodEnd', 's.cancelAt', 's.billingCycle', 's.seats'])
      .where('s.organizationId', '=', orgId).executeTakeFirst();
    if (!s) throw errors.notFound('Subscription', orgId);
    const settings = await loadPlatformSettings(trx);
    const cycle = (s.billingCycle === 'monthly' ? 'monthly' : 'yearly') as BillingCycle;
    const limits: Record<string, number> = {};
    for (const [k, v] of Object.entries(jsonObject(s.limits))) { const n = numberOrNull(v as number); if (n !== null) limits[k] = n; }
    if (s.seats !== null) limits.employees = s.seats;
    const count = async (q: Promise<{ n: string | number | bigint } | undefined>) => toCount((await q)?.n);
    const usage = {
      employees: await count(trx.selectFrom('employees').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('deletedAt', 'is', null).where('employmentStatus', 'not in', ['terminated', 'resigned']).executeTakeFirst()),
      devices: await count(trx.selectFrom('devices').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('status', '<>', 'decommissioned').where('providerKey', 'not in', ['flowza_finance', 'self_service']).executeTakeFirst()),
      branches: await count(trx.selectFrom('branches').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('status', '<>', 'archived').executeTakeFirst()),
      users: await count(trx.selectFrom('orgMemberships').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('status', '=', 'active').executeTakeFirst()),
    };
    const plans = await trx.selectFrom('plans').select(['key', 'name', 'description', 'includedUsers', 'isCustom', 'modules', 'prices']).where('isActive', '=', true).where('key', '<>', 'trial')
      .orderBy('sortOrder').execute();
    return {
      planKey: s.planKey, planName: s.planName, status: s.status, trialEndsAt: isoDateTimeOrNull(s.trialEndsAt), currentPeriodStart: isoDateTimeOrNull(s.currentPeriodStart),
      currentPeriodEnd: isoDateTimeOrNull(s.currentPeriodEnd), cancelAt: isoDateTimeOrNull(s.cancelAt), billingCycle: cycle, seats: s.seats, includedUsers: s.includedUsers,
      isCustom: s.isCustom, price: quoteSubscription({ prices: jsonObject(s.prices), includedUsers: s.includedUsers, currency: settings.billing.currency, cycle, seats: s.seats }),
      vatRate: settings.billing.vatRate, limits, usage, features: s.features, modules: await orgModules(trx, orgId),
      availablePlans: plans.map((p) => ({ key: p.key, name: p.name, description: p.description, includedUsers: p.includedUsers, isCustom: p.isCustom, modules: p.modules, prices: jsonObject(p.prices) })),
      billingContact: { supportEmail: settings.general.supportEmail, sellerName: settings.billing.sellerName, bankDetails: settings.billing.bankDetails, currency: settings.billing.currency },
    };
  });
}

/** GET /orgs/:orgId/billing/invoices — the tenant's invoices with their payments (organization.manage; RLS again). */
export async function listTenantInvoices(deps: ApiDeps, actor: Actor, orgId: string): Promise<BillingInvoiceDto[]> {
  requirePermission(actor.principal, orgId, 'organization.manage');
  return runUser(deps.db, actor, async (trx) => {
    const rows = await trx.selectFrom('billingInvoices as i').select(INVOICE_COLUMNS).where('i.organizationId', '=', orgId).orderBy('i.issueDate', 'desc').orderBy('i.invoiceNumber', 'desc').limit(200).execute();
    const payments = rows.length ? (await paymentQuery(trx).where('p.invoiceId', 'in', rows.map((r) => r.id)).orderBy('p.createdAt').execute()).map(toPaymentDto) : [];
    return rows.map((r) => toInvoiceDto(r as InvoiceRow, payments.filter((p) => p.invoiceId === r.id)));
  });
}
