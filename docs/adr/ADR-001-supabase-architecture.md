# ADR-001: Supabase as the platform, with a Node API + worker monolith

**Status:** Accepted · **Date:** 2026-09-05

## Problem
The product must run on Supabase (Postgres, Auth, RLS, Storage, Realtime, Edge Functions) yet needs a
versioned REST API with server-side authorisation, long-running retried background jobs against vendor
APIs, tenant-fair scheduling, and shared domain logic. Where should application code run?

## Options
1. **Supabase only**: PostgREST for data access, Edge Functions for logic, pg_cron + pgmq for jobs.
2. **Node modular monolith (`apps/api`) + Node worker (`apps/worker`)** using Supabase Postgres/Auth/
   Storage/Realtime; Edge Functions only for auth hooks and glue.
3. **Separate microservices** per domain (employees, devices, attendance, sync) with their own deployables.

## Decision
Option 2.

## Reasons
- §49 forbids exposing tables as the API; PostgREST is exactly that. A thin Node API gives us a real
  contract (`/api/v1`), Zod validation, standard errors, rate limiting, idempotency keys and audit hooks.
- Edge Functions have wall-clock/memory limits and no durable worker model; polling 500 devices with
  retries, back-off and provider throttling needs long-lived worker processes.
- One TypeScript codebase (`packages/domain`, `packages/device-providers`) is shared by API and worker;
  microservices would duplicate the domain and add operational cost far beyond a 3–5 person team (§127).
- Supabase still provides what it is best at: managed Postgres with RLS as the last line of defence,
  Auth (JWT/MFA/SSO), Storage with tenant policies, Realtime broadcast for progress.

## Trade-offs
- We run two containers (API, worker) in addition to Supabase — a small but real operational surface.
  Mitigated by identical Docker images, health endpoints, and platform-agnostic deployment (Fly/Railway/
  Render/Cloud Run).
- Auth tokens are verified twice (API and Postgres RLS). Accepted: defence in depth is a requirement (§67).
