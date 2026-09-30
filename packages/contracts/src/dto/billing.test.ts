import { describe, expect, it } from 'vitest';
import { computeInvoiceTotals, createPlanSchema, putOrgModulesSchema, quoteSubscription, roundMoney, subscriptionInvoiceLines, updatePlanSchema } from './billing.js';

const PROFESSIONAL = { OMR: { monthly: 50, yearly: 500, extraUserMonthly: 4, extraUserYearly: 40 } };

describe('quoteSubscription (docs/pricing.md)', () => {
  it('prices the reference package: Professional, yearly, 11 users = 500 OMR', () => {
    const q = quoteSubscription({ prices: PROFESSIONAL, includedUsers: 11, currency: 'OMR', cycle: 'yearly', seats: 11 });
    expect(q).toMatchObject({ amount: 500, base: 500, extraUsers: 0, extraAmount: 0, monthlyEquivalent: 41.667 });
    expect(q?.perUserMonthly).toBe(3.788);
  });
  it('charges every user beyond the included ones at the extra-user price', () => {
    expect(quoteSubscription({ prices: PROFESSIONAL, includedUsers: 11, currency: 'OMR', cycle: 'yearly', seats: 20 })?.amount).toBe(860);
    expect(quoteSubscription({ prices: PROFESSIONAL, includedUsers: 11, currency: 'OMR', cycle: 'monthly', seats: 20 })?.amount).toBe(86);
  });
  it('never charges less than the base price for fewer seats than included, and defaults the seats to the included users', () => {
    expect(quoteSubscription({ prices: PROFESSIONAL, includedUsers: 11, currency: 'OMR', cycle: 'yearly', seats: 5 })?.amount).toBe(500);
    expect(quoteSubscription({ prices: PROFESSIONAL, includedUsers: 11, currency: 'OMR', cycle: 'yearly', seats: null })).toMatchObject({ seats: 11, amount: 500 });
  });
  it('yearly is ten months of monthly (two months free)', () => {
    const m = quoteSubscription({ prices: PROFESSIONAL, includedUsers: 11, currency: 'OMR', cycle: 'monthly', seats: 11 })!;
    const y = quoteSubscription({ prices: PROFESSIONAL, includedUsers: 11, currency: 'OMR', cycle: 'yearly', seats: 11 })!;
    expect(y.amount).toBe(m.amount * 10);
  });
  it('returns null for a plan without a price in the currency (custom / free plans)', () => {
    expect(quoteSubscription({ prices: {}, includedUsers: null, currency: 'OMR', cycle: 'yearly', seats: 10 })).toBeNull();
    expect(quoteSubscription({ prices: PROFESSIONAL, includedUsers: 11, currency: 'USD', cycle: 'yearly', seats: 10 })).toBeNull();
  });
  it('keeps baisa precision on fractional prices', () => {
    expect(quoteSubscription({ prices: { OMR: { monthly: 110, yearly: 1100, extraUserMonthly: 3.5, extraUserYearly: 35 } }, includedUsers: 25, currency: 'OMR', cycle: 'monthly', seats: 28 })?.amount).toBe(120.5);
  });
});

describe('computeInvoiceTotals', () => {
  it('adds 5% VAT on the discounted subtotal and rounds to the baisa', () => {
    const q = quoteSubscription({ prices: PROFESSIONAL, includedUsers: 11, currency: 'OMR', cycle: 'yearly', seats: 11 })!;
    const t = computeInvoiceTotals({ lines: subscriptionInvoiceLines({ planName: 'Professional', quote: q }), taxRate: 5, currency: 'OMR' });
    expect(t).toMatchObject({ subtotal: 500, discount: 0, taxAmount: 25, total: 525 });
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]?.description).toContain('includes 11 users');
  });
  it('lists extra users as their own line', () => {
    const q = quoteSubscription({ prices: PROFESSIONAL, includedUsers: 11, currency: 'OMR', cycle: 'yearly', seats: 14 })!;
    const lines = subscriptionInvoiceLines({ planName: 'Professional', quote: q });
    expect(lines[1]).toMatchObject({ quantity: 3, unitPrice: 40 });
    expect(computeInvoiceTotals({ lines, taxRate: 5, currency: 'OMR', discount: 20 })).toMatchObject({ subtotal: 620, discount: 20, taxAmount: 30, total: 630 });
  });
  it('caps the discount at the subtotal and never produces a negative total', () => {
    expect(computeInvoiceTotals({ lines: [{ description: 'x', quantity: 1, unitPrice: 10 }], discount: 50, taxRate: 5, currency: 'OMR' })).toMatchObject({ discount: 10, taxAmount: 0, total: 0 });
  });
  it('total = subtotal − discount + VAT exactly, even with fractions', () => {
    const t = computeInvoiceTotals({ lines: [{ description: 'a', quantity: 3, unitPrice: 0.1 }, { description: 'b', quantity: 7, unitPrice: 1.234 }], discount: 0.001, taxRate: 5, currency: 'OMR' });
    expect(roundMoney(t.subtotal - t.discount + t.taxAmount)).toBe(t.total);
    expect(t.subtotal).toBe(8.938);
  });
});

describe('plan and module schemas', () => {
  it('a one-field plan PATCH changes one field (no defaults re-applied)', () => {
    expect(updatePlanSchema.parse({ name: 'Pro' })).toEqual({ name: 'Pro' });
    expect(updatePlanSchema.safeParse({}).success).toBe(false);
  });
  it('plan limits and module overrides accept a subset of their keys', () => {
    expect(createPlanSchema.parse({ key: 'pro_plus', name: 'Pro+', limits: { employees: 50 }, modules: ['leave'] }).limits).toEqual({ employees: 50 });
    expect(putOrgModulesSchema.parse({ modules: { leave: false }, reason: 'Not needed' }).modules).toEqual({ leave: false });
    expect(putOrgModulesSchema.safeParse({ modules: { unknown_module: false }, reason: 'x y z' }).success).toBe(false);
  });
});
