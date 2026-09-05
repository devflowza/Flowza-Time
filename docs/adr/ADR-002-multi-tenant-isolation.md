# ADR-002: Multi-tenant isolation with database-driven RBAC and generated RLS policies

**Status:** Accepted · **Date:** 2026-09-05

## Problem
Every organisation-owned row must be unreachable by other tenants even if the API is bypassed. Branch
managers must be confined to their branches. Role changes must apply immediately. Hundreds of ad-hoc
policies would be inconsistent and slow.

## Options
1. Tenant id and roles as JWT custom claims; policies compare `auth.jwt()` claims.
2. Membership tables + helper functions evaluated per row (`app.has_permission(organization_id, 'x')`).
3. Membership tables + **uncorrelated array-returning helper functions** used as `= ANY((select …))`,
   applied by a single policy generator; explicit service-layer checks on top.

## Decision
Option 3. Permissions never live in the JWT. Contexts: user (`authenticated`), system-for-org
(`flowza_system` with `org_id` claim), platform admin (requires an active reason-based grant).

## Reasons
- JWT claims go stale until refresh; a suspended membership or demoted role must take effect now.
- Per-row function calls are evaluated for every candidate row; uncorrelated subselects are evaluated
  once per statement and let the planner use `(organization_id, …)` indexes.
- One generator (`app.apply_tenant_policies`) guarantees the same shape on every table; tests assert every
  tenant table has RLS enabled and the expected policies.
- The worker impersonates *one* organisation per job, so even a bug in a job handler cannot write another
  tenant's rows.

## Trade-offs
- A membership lookup per statement (cheap, indexed, cached in the plan). Acceptable.
- Cross-organisation reports for platform staff require explicit grants — deliberate friction (§91).
