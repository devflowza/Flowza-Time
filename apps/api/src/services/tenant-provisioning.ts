import type { Trx } from '@flowza/database';
import { seedDefaultLeaveTypes } from './features/leave-defaults.js';
import { ORG_COLUMNS, type OrgRow } from './organizations.mappers.js';

export interface ProvisionTenantInput {
  orgId: string;
  companyCode: string;
  legalName: string;
  displayName: string;
  countryCode: string;
  timezone: string;
  currencyCode: string;
  locale: 'en' | 'ar';
  weeklyOffDays: number[];
  contact: Record<string, unknown>;
  address: Record<string, unknown>;
  plan: { id: string; key: string };
  createdBy: string;
}

export const TRIAL_DAYS = 14;

/**
 * Every tenant starts with one branch. Employees and devices both *require* a branch, so a tenant provisioned without
 * one opens on a required picker with nothing in it and no way forward until someone finds Organisation → Branches.
 * It is an ordinary branch: rename it, add more, archive it once the real sites exist. Weekly off days stay null so it
 * inherits the organisation's, and its country/timezone are the ones given at sign-up.
 */
export const DEFAULT_BRANCH = { code: 'HQ', name: 'Head Office', nameAr: 'المقر الرئيسي' } as const;

/**
 * The rows every new tenant needs, regardless of who creates it: the organisation, its settings row, the default leave
 * types (attendance reports print a leave day as the leave type's code, so without them the Summary report has no leave
 * columns), the head-office branch and the subscription. Runs inside the caller's transaction, which must be the system
 * context of `orgId`.
 * Owner membership and auditing stay with the caller: the platform console and self-service differ exactly there.
 */
export async function provisionTenant(trx: Trx, input: ProvisionTenantInput): Promise<OrgRow> {
  const trial = input.plan.key === 'trial';
  const org = await trx.insertInto('organizations').values({
    id: input.orgId, companyCode: input.companyCode, legalName: input.legalName, displayName: input.displayName, countryCode: input.countryCode, timezone: input.timezone, currencyCode: input.currencyCode,
    locale: input.locale, weeklyOffDays: input.weeklyOffDays, contact: JSON.stringify(input.contact), address: JSON.stringify(input.address), status: trial ? 'trial' : 'active', createdBy: input.createdBy,
  }).returning(ORG_COLUMNS).executeTakeFirstOrThrow();
  await trx.insertInto('organizationSettings').values({ organizationId: input.orgId, updatedBy: input.createdBy }).execute();
  await seedDefaultLeaveTypes(trx, input.orgId);
  await trx.insertInto('branches').values({
    organizationId: input.orgId, code: DEFAULT_BRANCH.code, name: DEFAULT_BRANCH.name, nameAr: DEFAULT_BRANCH.nameAr, countryCode: input.countryCode, timezone: input.timezone,
  }).execute();
  await trx.insertInto('subscriptions').values({ organizationId: input.orgId, planId: input.plan.id, status: trial ? 'trialing' : 'active', trialEndsAt: trial ? new Date(Date.now() + TRIAL_DAYS * 86_400_000) : null }).execute();
  return org;
}
