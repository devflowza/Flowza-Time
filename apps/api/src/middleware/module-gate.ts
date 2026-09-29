import type { MiddlewareHandler } from 'hono';
import type { ModuleKey } from '@flowza/contracts';
import { AppError } from '@flowza/shared';
import type { AppEnv } from './request-context.js';

/** `details.reason` of a request refused because a module is off for the organisation. */
export const MODULE_DISABLED = 'MODULE_DISABLED';

/**
 * Organisation routes that belong to a switchable module (migration 20260929000600). A path may need more than one module:
 * `/me/leave` is the self-service portal AND leave management. Paths are relative to `/orgs/:orgId/`. Everything else —
 * employees, attendance and corrections, shifts and holidays, reports, approvals, users, settings, audit — is the core of
 * the product and never switchable. Disabling a module never deletes data and never stops a terminal's punches from being
 * recorded: it closes the module's screens and endpoints (and the worker's scheduled deliveries of that module).
 */
export const MODULE_ROUTE_RULES: ReadonlyArray<{ pattern: RegExp; modules: readonly ModuleKey[] }> = [
  { pattern: /^(devices|device-groups|pin-mappings|sync)(\/|$)/, modules: ['devices'] },
  { pattern: /^employees\/[^/]+\/devices(\/|$)/, modules: ['devices'] },
  { pattern: /^me(\/|$)/, modules: ['self_service'] },
  { pattern: /^employees\/[^/]+\/portal-access(\/|$)/, modules: ['self_service'] },
  { pattern: /^geofences(\/|$)/, modules: ['geofences'] },
  { pattern: /^attendance\/selfie-checkins(\/|$)/, modules: ['geofences'] },
  { pattern: /^me\/(punch|selfie-checkin|selfie-checkins)(\/|$)/, modules: ['geofences'] },
  { pattern: /^leave-(types|records|balances|allocations|calendar)(\/|$)/, modules: ['leave'] },
  { pattern: /^me\/(leave|comp-off)(\/|$)/, modules: ['leave'] },
  { pattern: /^(me\/)?team\/leave(\/|$)/, modules: ['leave'] },
  // the manager workspace; team/pending-counts stays core — it is THE "waiting for you" figure of the approvals badge
  { pattern: /^team\/(summary|attendance|leave)(\/|$)/, modules: ['manager_workspace'] },
  { pattern: /^me\/team(\/|$)/, modules: ['manager_workspace'] },
  { pattern: /^payroll(\/|$)/, modules: ['payroll'] },
  { pattern: /^(report-schedules|report-deliveries|report-recipients|reports\/share)(\/|$)/, modules: ['report_schedules'] },
  { pattern: /^integrations\/finance(\/|$)/, modules: ['finance_integration'] },
];

const MODULE_NAMES: Record<ModuleKey, string> = {
  devices: 'Devices & sync', self_service: 'Employee self-service portal', geofences: 'Web check-in & geofencing', leave: 'Leave management',
  manager_workspace: 'Manager workspace', payroll: 'Payroll', report_schedules: 'Scheduled reports', finance_integration: 'Flowza Finance integration',
};

/** The modules a path (relative to `/orgs/:orgId/`) needs. */
export function modulesForPath(relativePath: string): ModuleKey[] {
  const out = new Set<ModuleKey>();
  for (const rule of MODULE_ROUTE_RULES) if (rule.pattern.test(relativePath)) for (const m of rule.modules) out.add(m);
  return [...out];
}

export function moduleDisabledError(key: ModuleKey): AppError {
  return new AppError('FEATURE_DISABLED', `The ${MODULE_NAMES[key]} module is not enabled for this organisation. Your administrator can enable it with FlowZa.`, {
    details: { reason: MODULE_DISABLED, module: key },
  });
}

/**
 * Module gate: 403 FEATURE_DISABLED (details.reason MODULE_DISABLED) for an organisation route of a module that is off for
 * that organisation. Runs after the tenant boundary (orgAccessGate) and the MFA gate, before any body is parsed. The disabled
 * set comes with the principal snapshot (one round trip for the whole request), so it is exactly as fresh as the caller's
 * permissions: a platform admin's change applies to the next request.
 */
export function moduleGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const orgId = c.req.param('orgId');
    const disabled = orgId ? c.get('disabledModules')?.get(orgId) : undefined;
    if (disabled && disabled.size > 0) {
      const match = /\/orgs\/[^/]+\/(.*)$/.exec(c.req.path);
      const rest = match?.[1] ?? '';
      for (const key of modulesForPath(rest)) if (disabled.has(key)) throw moduleDisabledError(key);
    }
    await next();
  };
}
