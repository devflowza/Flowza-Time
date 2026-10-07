/**
 * Modules, plans & pricing, billing and platform settings (super-admin portal parity with Flowza Finance; migration
 * 20260929000600, docs/pricing.md). The pricing helpers are pure and shared by the API (invoices, revenue figures) and the
 * web (plan editor preview, tenant billing page), so a price can never be computed two different ways.
 */
import { z } from 'zod';
import { SUBSCRIPTION_STATUSES } from '../enums.js';
import { booleanQuerySchema, currencyCodeSchema, emailSchema, isoDateSchema, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from '../common.js';

// ------------------------------------------------------------------------------------------------------------------------------
// Modules
// ------------------------------------------------------------------------------------------------------------------------------

/** Switchable modules. The core (employees, attendance, shifts, reports, approvals, users, settings, audit) is always on. */
export const MODULE_KEYS = ['devices', 'self_service', 'geofences', 'leave', 'manager_workspace', 'payroll', 'report_schedules', 'finance_integration',
  // Enterprise only (migration 20261007000100, docs/enterprise/plan.md)
  'shift_requests', 'advanced_scheduling', 'attendance_policies'] as const;
/** Modules only the Enterprise plan includes (a platform admin can still switch one on for a tenant). */
export const ENTERPRISE_MODULE_KEYS = ['shift_requests', 'advanced_scheduling', 'attendance_policies'] as const satisfies readonly (typeof MODULE_KEYS)[number][];
export type ModuleKey = (typeof MODULE_KEYS)[number];
export const MODULE_CATEGORIES = ['workforce', 'time', 'devices', 'insights', 'integrations'] as const;
export type ModuleCategory = (typeof MODULE_CATEGORIES)[number];
export const moduleKeySchema = z.enum(MODULE_KEYS);

/** A module as the platform console sees it: catalogue row + adoption across tenants. */
export const platformModuleDtoSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(MODULE_CATEGORIES),
  sortOrder: z.number().int(),
  isAvailable: z.boolean(),
  /** Tenants for which the module is effectively on / the total number of tenants. */
  enabledCount: z.number().int(),
  totalOrganizations: z.number().int(),
  /** Tenants carrying a platform override that forces the module on / off. */
  overrideOnCount: z.number().int(),
  overrideOffCount: z.number().int(),
  /** Plans that include the module. */
  planKeys: z.array(z.string()),
  updatedAt: isoDateTimeSchema,
});
export type PlatformModuleDto = z.infer<typeof platformModuleDtoSchema>;

/** PATCH /platform/modules/:key — the fleet-wide switch. */
export const updatePlatformModuleSchema = z.object({
  isAvailable: z.boolean(),
  reason: z.string().trim().min(3).max(500),
});
export type UpdatePlatformModuleInput = z.infer<typeof updatePlatformModuleSchema>;

export const MODULE_BULK_ACTIONS = ['enable', 'disable', 'reset'] as const;
/** POST /platform/modules/:key/apply-all — set (enable / disable) or clear (reset → the plan decides) every tenant's override. */
export const applyModuleToAllSchema = z.object({
  action: z.enum(MODULE_BULK_ACTIONS),
  reason: z.string().trim().min(3).max(500),
});
export type ApplyModuleToAllInput = z.infer<typeof applyModuleToAllSchema>;
export const applyModuleToAllResultSchema = z.object({ key: z.string(), action: z.enum(MODULE_BULK_ACTIONS), organizations: z.number().int() });
export type ApplyModuleToAllResult = z.infer<typeof applyModuleToAllResultSchema>;

/** One module for one tenant: what the plan says, the platform override, and the result. */
export const orgModuleStateDtoSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(MODULE_CATEGORIES),
  enabled: z.boolean(),
  inPlan: z.boolean(),
  override: z.boolean().nullable(),
  available: z.boolean(),
  lapsed: z.boolean(),
  reason: z.string().nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
});
export type OrgModuleStateDto = z.infer<typeof orgModuleStateDtoSchema>;

/** PUT /platform/orgs/:id/modules — module key → true / false (override) or null (back to the plan). */
export const putOrgModulesSchema = z.object({
  /** At least one module (checked by the service: the request sample synthesizer of the schema-trap suite cannot satisfy a refinement). */
  modules: z.partialRecord(moduleKeySchema, z.boolean().nullable()),
  reason: z.string().trim().min(3).max(500),
});
export type PutOrgModulesInput = z.infer<typeof putOrgModulesSchema>;

// ------------------------------------------------------------------------------------------------------------------------------
// Plans & pricing
// ------------------------------------------------------------------------------------------------------------------------------

export const BILLING_CYCLES = ['monthly', 'yearly'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

const money = z.number().min(0).max(10_000_000);
/** Price of a plan in one currency. Extra users are charged per user beyond `includedUsers`. */
export const planPriceSchema = z.object({
  monthly: money,
  yearly: money,
  extraUserMonthly: money.default(0),
  extraUserYearly: money.default(0),
});
export type PlanPrice = z.infer<typeof planPriceSchema>;
export const planPricesSchema = z.record(currencyCodeSchema, planPriceSchema);

export const PLAN_LIMIT_KEYS = ['employees', 'devices', 'branches', 'users', 'storage_mb', 'api_calls_month', 'raw_retention_days'] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];
export const planLimitsSchema = z.partialRecord(z.enum(PLAN_LIMIT_KEYS), z.number().int().min(0).max(1_000_000_000));

const planKeySchema = z.string().trim().regex(/^[a-z][a-z0-9_]{1,31}$/, 'Lower-case letters, digits and _ (2–32)');
const featureSchema = z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/);

/** POST /platform/plans */
export const createPlanSchema = z.object({
  key: planKeySchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  prices: planPricesSchema.optional(),
  limits: planLimitsSchema.optional(),
  features: z.array(featureSchema).max(50).optional(),
  modules: z.array(moduleKeySchema).max(MODULE_KEYS.length).optional(),
  includedUsers: z.number().int().min(1).max(100_000).nullable().optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  isCustom: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CreatePlanInput = z.infer<typeof createPlanSchema>;
/** PATCH /platform/plans/:key — explicit optional fields, no defaults (a one-field PATCH must change one field). */
export const updatePlanSchema = createPlanSchema.omit({ key: true }).partial().refine((v) => Object.values(v).some((x) => x !== undefined), 'Change at least one field of the plan.');
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

export const platformPlanDtoSchema = z.object({
  id: uuidSchema,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  prices: z.record(z.string(), z.unknown()),
  limits: z.record(z.string(), z.unknown()),
  features: z.array(z.string()),
  modules: z.array(z.string()),
  includedUsers: z.number().int().nullable(),
  trialDays: z.number().int(),
  isCustom: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  /** Tenants currently subscribed (any status) / in a live status (trialing, active, past due). */
  subscribers: z.number().int(),
  liveSubscribers: z.number().int(),
});
export type PlatformPlanDto = z.infer<typeof platformPlanDtoSchema>;

/** Minor units per major unit for the platform's billing currencies (OMR, BHD, KWD have three decimals). */
export function currencyDecimals(currency: string): number {
  return ['OMR', 'BHD', 'KWD', 'JOD', 'TND', 'LYD', 'IQD'].includes(currency.toUpperCase()) ? 3 : 2;
}
function toMinor(amount: number, decimals: number): number { return Math.round(amount * 10 ** decimals); }
function fromMinor(minor: number, decimals: number): number { return minor / 10 ** decimals; }
/** Rounds to the currency's minor unit (baisa for OMR). */
export function roundMoney(amount: number, currency = 'OMR'): number {
  const d = currencyDecimals(currency);
  return fromMinor(toMinor(amount, d), d);
}

/** The price of a plan in a currency, or null when the plan has none (custom / free plans). */
export function planPriceFor(prices: Record<string, unknown> | null | undefined, currency: string): PlanPrice | null {
  const raw = prices?.[currency.toUpperCase()];
  const parsed = planPriceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface SubscriptionQuote {
  currency: string;
  cycle: BillingCycle;
  seats: number;
  includedUsers: number;
  extraUsers: number;
  base: number;
  extraUnit: number;
  extraAmount: number;
  /** Amount per billing cycle, before VAT. */
  amount: number;
  /** The same amount spread per month (yearly / 12). */
  monthlyEquivalent: number;
  /** Per user per month, before VAT. */
  perUserMonthly: number;
}

/**
 * Price of a subscription for one billing cycle: the plan's base price (which includes `includedUsers` users) plus every
 * user beyond that at the plan's extra-user price. Seats below the included users still pay the base price. Null when the
 * plan has no price in the currency. Example (docs/pricing.md): Professional, yearly, 11 users → 500 OMR; 20 users → 860.
 */
export function quoteSubscription(input: { prices: Record<string, unknown> | null | undefined; includedUsers: number | null; currency: string; cycle: BillingCycle; seats: number | null }): SubscriptionQuote | null {
  const price = planPriceFor(input.prices, input.currency);
  if (!price) return null;
  const d = currencyDecimals(input.currency);
  const included = input.includedUsers ?? 0;
  const seats = Math.max(input.seats ?? included, 0);
  const extraUsers = Math.max(0, seats - included);
  const baseMinor = toMinor(input.cycle === 'yearly' ? price.yearly : price.monthly, d);
  const unitMinor = toMinor(input.cycle === 'yearly' ? price.extraUserYearly : price.extraUserMonthly, d);
  const amountMinor = baseMinor + extraUsers * unitMinor;
  const monthlyMinor = input.cycle === 'yearly' ? Math.round(amountMinor / 12) : amountMinor;
  const users = Math.max(seats, included, 1);
  return {
    currency: input.currency.toUpperCase(), cycle: input.cycle, seats, includedUsers: included, extraUsers,
    base: fromMinor(baseMinor, d), extraUnit: fromMinor(unitMinor, d), extraAmount: fromMinor(extraUsers * unitMinor, d),
    amount: fromMinor(amountMinor, d), monthlyEquivalent: fromMinor(monthlyMinor, d), perUserMonthly: fromMinor(Math.round(monthlyMinor / users), d),
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Subscriptions
// ------------------------------------------------------------------------------------------------------------------------------

export const subscriptionQuoteSchema = z.object({
  currency: z.string(), cycle: z.enum(BILLING_CYCLES), seats: z.number().int(), includedUsers: z.number().int(), extraUsers: z.number().int(),
  base: z.number(), extraUnit: z.number(), extraAmount: z.number(), amount: z.number(), monthlyEquivalent: z.number(), perUserMonthly: z.number(),
});

/** Where a tenant's user limit comes from (migration 20261001000300, `app.org_user_limits`). */
export const USER_LIMIT_SOURCES = ['override', 'seats', 'plan'] as const;
export type UserLimitSource = (typeof USER_LIMIT_SOURCES)[number];

/**
 * Licensed users (active employees) against the tenant's user limit — what the super-admin portal and the tenant show as
 * "used / limit". Only a platform admin changes the limit (the subscription's seats); `limit` null = no limit configured.
 */
export const userLimitDtoSchema = z.object({
  used: z.number().int().min(0),
  limit: z.number().int().min(0).nullable(),
  /** Users that can still be added (null without a limit; 0 when the limit is reached or exceeded). */
  remaining: z.number().int().min(0).nullable(),
  /** No more users can be added: `used >= limit`. */
  reached: z.boolean(),
  source: z.enum(USER_LIMIT_SOURCES).nullable(),
});
export type UserLimitDto = z.infer<typeof userLimitDtoSchema>;

/** The one shape of a user limit, from users in use and the effective limit. */
export function toUserLimit(used: number, limit: number | null, source: UserLimitSource | null): UserLimitDto {
  return { used, limit, remaining: limit === null ? null : Math.max(0, limit - used), reached: limit !== null && used >= limit, source: limit === null ? null : source };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Invoices & payments
// ------------------------------------------------------------------------------------------------------------------------------

export const INVOICE_STATUSES = ['issued', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_CYCLES = ['monthly', 'yearly', 'custom'] as const;
export const PAYMENT_METHODS = ['bank_transfer', 'card', 'cash', 'cheque', 'online', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_KINDS = ['payment', 'refund'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const invoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: z.number().min(0).max(1_000_000),
  unitPrice: money,
});
export type InvoiceLineInput = z.infer<typeof invoiceLineSchema>;
export const invoiceLineDtoSchema = invoiceLineSchema.extend({ amount: z.number() });
export type InvoiceLineDto = z.infer<typeof invoiceLineDtoSchema>;

export interface InvoiceTotals { lines: InvoiceLineDto[]; subtotal: number; discount: number; taxRate: number; taxAmount: number; total: number }

/** Line amounts, subtotal, discount (capped at the subtotal), VAT on (subtotal − discount) and total, in the currency's minor units. */
export function computeInvoiceTotals(input: { lines: InvoiceLineInput[]; discount?: number; taxRate: number; currency: string }): InvoiceTotals {
  const d = currencyDecimals(input.currency);
  const lines = input.lines.map((l) => ({ ...l, amount: fromMinor(Math.round(l.quantity * toMinor(l.unitPrice, d)), d) }));
  const subtotalMinor = lines.reduce((a, l) => a + toMinor(l.amount, d), 0);
  const discountMinor = Math.min(Math.max(toMinor(input.discount ?? 0, d), 0), subtotalMinor);
  const taxMinor = Math.round(((subtotalMinor - discountMinor) * input.taxRate) / 100);
  return {
    lines, subtotal: fromMinor(subtotalMinor, d), discount: fromMinor(discountMinor, d), taxRate: input.taxRate,
    taxAmount: fromMinor(taxMinor, d), total: fromMinor(subtotalMinor - discountMinor + taxMinor, d),
  };
}

/** The lines of a subscription invoice: the plan's base price and the extra users. */
export function subscriptionInvoiceLines(input: { planName: string; quote: SubscriptionQuote }): InvoiceLineInput[] {
  const { quote } = input;
  const cycle = quote.cycle === 'yearly' ? 'yearly' : 'monthly';
  const lines: InvoiceLineInput[] = [{
    description: `FlowZa Time ${input.planName} — ${cycle} subscription${quote.includedUsers > 0 ? ` (includes ${quote.includedUsers} users)` : ''}`,
    quantity: 1, unitPrice: quote.base,
  }];
  if (quote.extraUsers > 0) lines.push({ description: `Additional users (${cycle})`, quantity: quote.extraUsers, unitPrice: quote.extraUnit });
  return lines;
}

/** POST /platform/billing/invoices — a subscription invoice (plan + cycle + seats) and/or custom lines. */
export const createInvoiceSchema = z.object({
  organizationId: uuidSchema,
  /** Subscription invoice: the plan priced for the cycle and seats; omitted for a custom invoice (lines required). */
  planKey: z.string().trim().min(1).max(64).optional(),
  billingCycle: z.enum(BILLING_CYCLES).optional(),
  seats: z.number().int().min(1).max(100_000).optional(),
  periodStart: isoDateSchema.optional(),
  periodEnd: isoDateSchema.optional(),
  /** Extra lines (setup, devices, training …); for a custom invoice, the only lines. */
  lines: z.array(invoiceLineSchema).max(50).optional(),
  discount: money.optional(),
  /** Percent; defaults to the platform's VAT rate. */
  taxRate: z.number().min(0).max(100).optional(),
  issueDate: isoDateSchema.optional(),
  dueDate: isoDateSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
  /** When fully paid, move the tenant's subscription to the invoiced plan, cycle, seats and period. Default: true for a plan invoice. */
  activatesSubscription: z.boolean().optional(),
}).refine((v) => v.planKey !== undefined || (v.lines?.length ?? 0) > 0, { message: 'Choose a plan or add at least one line.', path: ['lines'] })
  .refine((v) => !v.periodStart || !v.periodEnd || v.periodEnd >= v.periodStart, { message: 'The period ends before it starts.', path: ['periodEnd'] });
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

/** POST /platform/billing/invoices/:id/payments */
export const recordPaymentSchema = z.object({
  kind: z.enum(PAYMENT_KINDS).optional(),
  amount: z.number().positive().max(10_000_000),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(200).optional(),
  receivedOn: isoDateSchema.optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

/** POST /platform/billing/invoices/:id/void */
export const voidInvoiceSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type VoidInvoiceInput = z.infer<typeof voidInvoiceSchema>;

export const billingPaymentDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  invoiceId: uuidSchema,
  invoiceNumber: z.string(),
  kind: z.enum(PAYMENT_KINDS),
  amount: z.number(),
  currency: z.string(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().nullable(),
  receivedOn: isoDateSchema,
  notes: z.string().nullable(),
  recordedByLabel: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type BillingPaymentDto = z.infer<typeof billingPaymentDtoSchema>;

export const billingInvoiceDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  organizationName: z.string().nullable(),
  invoiceNumber: z.string(),
  status: z.enum(INVOICE_STATUSES),
  /** Issued, not fully paid and past its due date. */
  overdue: z.boolean(),
  currency: z.string(),
  planKey: z.string().nullable(),
  planName: z.string().nullable(),
  billingCycle: z.enum(INVOICE_CYCLES).nullable(),
  seats: z.number().int().nullable(),
  periodStart: isoDateSchema.nullable(),
  periodEnd: isoDateSchema.nullable(),
  lines: z.array(invoiceLineDtoSchema),
  subtotal: z.number(),
  discount: z.number(),
  taxRate: z.number(),
  taxAmount: z.number(),
  total: z.number(),
  amountPaid: z.number(),
  balance: z.number(),
  activatesSubscription: z.boolean(),
  subscriptionAppliedAt: isoDateTimeSchema.nullable(),
  issueDate: isoDateSchema,
  dueDate: isoDateSchema.nullable(),
  paidAt: isoDateTimeSchema.nullable(),
  voidedAt: isoDateTimeSchema.nullable(),
  voidReason: z.string().nullable(),
  notes: z.string().nullable(),
  seller: z.record(z.string(), z.unknown()),
  customer: z.record(z.string(), z.unknown()),
  createdByLabel: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  payments: z.array(billingPaymentDtoSchema).optional(),
});
export type BillingInvoiceDto = z.infer<typeof billingInvoiceDtoSchema>;

export const invoiceListQuerySchema = paginationQuerySchema.extend({
  organizationId: uuidSchema.optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  overdueOnly: booleanQuerySchema.default(false),
  search: z.string().trim().max(100).optional(),
});
export const paymentListQuerySchema = paginationQuerySchema.extend({ organizationId: uuidSchema.optional() });

/** GET /platform/billing/summary — revenue at a glance (live subscriptions priced with their plan, cycle and seats). */
export const billingSummaryDtoSchema = z.object({
  currency: z.string(),
  /** Monthly recurring revenue of active and past-due subscriptions (yearly ones spread per month), before VAT. */
  mrr: z.number(),
  arr: z.number(),
  payingSubscriptions: z.number().int(),
  trialingSubscriptions: z.number().int(),
  /** Subscriptions whose plan has no price (custom / free) and are therefore not in MRR. */
  unpricedSubscriptions: z.number().int(),
  outstanding: z.number(),
  overdueInvoices: z.number().int(),
  overdueAmount: z.number(),
  collectedLast30Days: z.number(),
  byPlan: z.array(z.object({ planKey: z.string(), planName: z.string(), subscriptions: z.number().int(), mrr: z.number() })),
  subscriptions: z.array(z.object({
    organizationId: uuidSchema, organizationName: z.string(), companyCode: z.string(), planKey: z.string(), planName: z.string(),
    status: z.enum(SUBSCRIPTION_STATUSES), billingCycle: z.enum(BILLING_CYCLES), seats: z.number().int().nullable(), employees: z.number().int(),
    amount: z.number().nullable(), mrr: z.number().nullable(), currentPeriodEnd: isoDateTimeSchema.nullable(), trialEndsAt: isoDateTimeSchema.nullable(),
  })),
});
export type BillingSummaryDto = z.infer<typeof billingSummaryDtoSchema>;

// ------------------------------------------------------------------------------------------------------------------------------
// Platform settings
// ------------------------------------------------------------------------------------------------------------------------------

export const platformSettingsSchema = z.object({
  general: z.object({
    platformName: z.string().trim().min(1).max(80),
    supportEmail: emailSchema,
  }),
  billing: z.object({
    currency: currencyCodeSchema,
    vatRate: z.number().min(0).max(100),
    invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Letters and digits, 2–10, starting with a letter'),
    paymentTermsDays: z.number().int().min(0).max(365),
    sellerName: z.string().trim().min(1).max(200),
    sellerVatNumber: z.string().trim().max(50),
    sellerAddress: z.string().trim().max(500),
    bankDetails: z.string().trim().max(1000),
  }),
});
export type PlatformSettings = z.infer<typeof platformSettingsSchema>;
/** PUT /platform/settings — any subset of any group (no defaults: unsent fields stay as they are). */
export const putPlatformSettingsSchema = z.object({
  general: platformSettingsSchema.shape.general.partial().optional(),
  billing: platformSettingsSchema.shape.billing.partial().optional(),
}).refine((v) => Object.values(v.general ?? {}).some((x) => x !== undefined) || Object.values(v.billing ?? {}).some((x) => x !== undefined), 'Change at least one setting.');
export type PutPlatformSettingsInput = z.infer<typeof putPlatformSettingsSchema>;
export const platformSettingsDtoSchema = platformSettingsSchema.extend({ updatedAt: isoDateTimeSchema.nullable() });
export type PlatformSettingsDto = z.infer<typeof platformSettingsDtoSchema>;

// ------------------------------------------------------------------------------------------------------------------------------
// Tenant view: GET /orgs/:orgId/subscription, GET /orgs/:orgId/billing/invoices
// ------------------------------------------------------------------------------------------------------------------------------

export const tenantSubscriptionDtoSchema = z.object({
  planKey: z.string(),
  planName: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  trialEndsAt: isoDateTimeSchema.nullable(),
  currentPeriodStart: isoDateTimeSchema.nullable(),
  currentPeriodEnd: isoDateTimeSchema.nullable(),
  cancelAt: isoDateTimeSchema.nullable(),
  billingCycle: z.enum(BILLING_CYCLES),
  seats: z.number().int().nullable(),
  includedUsers: z.number().int().nullable(),
  isCustom: z.boolean(),
  /** The price of the current cycle before VAT (null for custom or free plans). */
  price: subscriptionQuoteSchema.nullable(),
  vatRate: z.number(),
  limits: z.record(z.string(), z.number()),
  usage: z.record(z.string(), z.number()),
  /** Licensed users (active employees) against the user limit the platform set — `limits.employees` / `usage.employees`. */
  userLimit: userLimitDtoSchema,
  features: z.array(z.string()),
  modules: z.array(orgModuleStateDtoSchema),
  /** Plans a tenant may move to (active, priced or custom), for comparison. */
  availablePlans: z.array(z.object({
    key: z.string(), name: z.string(), description: z.string().nullable(), includedUsers: z.number().int().nullable(), isCustom: z.boolean(),
    modules: z.array(z.string()), prices: z.record(z.string(), z.unknown()),
  })),
  billingContact: z.object({ supportEmail: z.string(), sellerName: z.string(), bankDetails: z.string(), currency: z.string() }),
});
export type TenantSubscriptionDto = z.infer<typeof tenantSubscriptionDtoSchema>;
