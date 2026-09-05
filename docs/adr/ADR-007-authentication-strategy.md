# ADR-007: Supabase Auth with database-resolved authorisation and hook-based login history

**Status:** Accepted · **Date:** 2026-09-05

## Problem
Enterprise-grade authentication (email/password now; MFA; SSO later) with immediate effect of account/role
changes, login auditing, and no authorisation data in tokens.

## Options
1. Custom auth service.
2. **Supabase Auth** with JWT verification in the API (JWKS), DB-resolved permissions, Password
   Verification Hook for login history, Custom Access Token Hook limited to a `platform_admin` boolean.
3. Third-party IdP (Auth0/Clerk) in front of Supabase.

## Decision
Option 2.

## Reasons
- Supabase Auth integrates natively with RLS (`request.jwt.claims`), Storage and Realtime authorisation,
  supports TOTP MFA and SAML SSO on paid plans, and removes an entire category of security work.
- Keeping permissions out of the token avoids staleness; the API bootstraps the UI with permissions from
  the database and the database enforces them regardless.
- Hooks give login history and allow per-organisation MFA enforcement without a custom identity layer.

## Trade-offs
- SSO/SAML depends on the Supabase plan; domain-based org mapping is our responsibility.
- Session lifetime and refresh behaviour are Supabase's; org-level "force logout" is implemented by
  suspending the membership (immediate effect) rather than revoking tokens.
