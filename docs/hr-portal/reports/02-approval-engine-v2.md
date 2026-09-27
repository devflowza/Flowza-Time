# Phase 2 — Approval engine v2 (multilevel, Finance parity)

**Prompt:** `docs/hr-portal/prompt-pack.md` §Prompt 2 (+ the coordinator addendum on corrections — P1 own record through
self-service, P2 no auto-approval for team-only callers, RLS hardening — and the note that approval views resolve names in
the organisation's system scope because `manager` loses `employee.view` in the Prompt 1 review).
**Branch:** `claude/modest-fermi-fnwqq7` · **Migration:** `supabase/migrations/20260928000200_approval_engine_v2.sql` ·
**Date:** 2026-09-27. **Status:** every gate green (§6); nothing applied to the hosted project (Prompt 12).

## 1. What shipped

### Database (one additive, idempotent migration, `lock_timeout 5s` / `statement_timeout 60s`)
- **Enums:** `approver_type` + `SECONDARY_MANAGER`, `MANAGER_CHAIN`, `HR_ADMIN`, `DEPARTMENT_HEAD`, `BRANCH_MANAGER`;
  `approval_entity` + `ATTENDANCE_NOTE`, `SHIFT_SWAP`, `COMP_OFF`, `REGULARISATION`, `OVERTIME_CLAIM`; `approval_status` +
  `INVALIDATED`, `SKIPPED`. (Added, never used as values in the same file — the runner wraps each file in one transaction.)
- **Workflows:** `steps jsonb` keeps its place with the v2 level shape (§2), validated by the immutable
  `app.approval_steps_valid(jsonb)` CHECK (the structural minimum of the Zod schema); existing rows are normalised in place
  first (the v1 seed's snake_case keys, explicit `order`, `mode: 'ANY'`). New columns `applies_to` (branchIds /
  departmentIds), `min_units` (tiers in the entity's units — leave days, overtime minutes) and `allow_self_approval`
  (default off). The single-default index gives way to one keyed on branch + threshold + applies-to, so tiers can coexist.
- **Requests:** `units`, `department_id`, `subject_user_id` (the subject's login snapshot), `decided_by`, `cancelled_by`,
  `cancel_reason`, `invalidation_reason`, `info_requested_at`; **one PENDING request per document** (older duplicates are
  cancelled first, then a partial unique index); the subject's login is back-filled on in-flight requests.
- **Steps:** `mode`, `required_count`, `resolution_path` / `resolution_reason`, `delegated_from_user_id`, `permission_key`,
  `activated_at`, `due_at`, `escalate_to`, `escalate_after_hours`, `escalated_at`, `reminded_at` (+ CHECKs); open steps of
  existing requests start their reminder clock at the request's creation.
- **New tables:** `approval_step_actors` (one row per eligible person of a level; `via_delegation_of`, decision, comment),
  `approval_delegations` (date window, optional entity types, revocation), `approval_request_events` (append-only timeline —
  `app.reject_modification` trigger), `approval_email_tokens` (sha256 of the one-click token only, 7-day expiry, single use),
  `approval_digest_runs` (one daily digest per organisation). `leave_records.approval_request_id` links leave to its request.
- **In-flight v1 requests:** every PENDING level without actors gets its approvers seated — the named user, else the role's
  members whose branch scope covers the request, never the requester or the subject, else the organisation's owners — so
  requests created before the release reach the v2 queues (proved on a v1-shaped scratch database, §6).
- **RLS:** requests are readable through ONE rule — organisation-wide key (`attendance.view`, `leave.view`,
  `approval.manage`; branch scope applies) OR assignee (`app.approval_assigned_request_ids()`: a step or actor row for me, or a
  pending actor who delegates to me today for that entity type) OR subject (own employee) OR requester OR team (direct report
  + a team key). Steps, actors and events are readable exactly where their request is. Writes are system-context only.
  Delegations: either side or `approval.manage`. Tokens and digest runs: no client access at all. Workflows: written by
  `approval.manage` or `organization.manage`.
- **Corrections hardening (coordinator addendum):** a client INSERT must be `PENDING`, filed in the caller's own name, with
  no approval / application stamps, for somebody in reach (organisation-wide `attendance.view`, a direct report, or the
  caller's own record); client UPDATE / DELETE policies are gone (the engine approves and applies in the system context).
  The migration's post-verify refuses to finish if any client UPDATE / DELETE / ALL policy survives on the table.

### Contracts / domain
- `approvalWorkflowStepSchema` v2 (source of truth, §2), workflow input / PATCH schema without defaults, inbox query
  (scope / view / type / status / employee / branch / dates / search), decide, bulk-decide, cancel, reassign, bypass,
  ask / answer info, e-mail action, delegation input / list, DTOs (request with levels, actors, context, abilities, timeline;
  delegation; bulk result). New domain events: `approval.reminder`, `approval.escalated`, `approval.decided`,
  `approval.info_requested`, `approval.info_answered`, `approval.reassigned`, `approval.bypassed`.
- `packages/domain/src/approvals/` (pure, 26 unit tests): `resolveStepActors` (the ladders: MANAGER → secondary → HR admins →
  owner; MANAGER_CHAIN walks `chainLevel` rungs, absent rungs substituted by the secondary manager, a shorter chain resolves
  to the most senior reachable; HR_ADMIN, DEPARTMENT_HEAD, BRANCH_MANAGER, ROLE by permission or role, USER; delegates
  stamped in the approver's seat; segregation of duties), `evaluateLevel` + `collapseSeats` (ANY / ALL / QUORUM on seats;
  rejection terminal only when the level can no longer be satisfied), `escalationDueAt`, `selectWorkflow` (branch-specific
  over organisation-wide, applies-to narrowing, highest applicable tier).

### API (`apps/api/src/services/approvals/`)
- `engine.ts` — `submit` (select the workflow, resolve EVERY level at submission, snapshot actors, arm the first level's
  escalation, targeted `approval.pending`; no workflow → the caller's policy: an APPROVED request whose hook runs at once, or
  one synthetic level routed to a permission), `decideWithin` (FOR UPDATE on the request; actor / delegate / permission /
  owner; SoD by the subject; modes; hooks; advance or complete), `bulkDecide`, `cancelWithin` / `cancelForEntity`,
  `invalidateForEntity`, `reassignRequest`, `bypassRequest`, `requestInfo` / `answerInfo`, `assessDecider` (shared with the
  DTO abilities so the UI never offers what the API refuses).
- `context.ts` (resolution context in the organisation's system scope: reporting chain, absence = no login / inactive
  membership / approved leave today, HR admins, owners, role members, permission holders scoped to the subject's branch and
  to org-wide view or the subject's own managers, delegations — type-specific preferred), `dto.ts` (hydration: names,
  contexts, abilities — all names in the system scope), `queries.ts` (inbox, history CSV, one request, my requests),
  `workflows.ts`, `delegations.ts`, `email-tokens.ts`, hooks `corrections.ts` / `leave.ts`.
- **Corrections** (`attendance.service.ts`): own record → self-service branch (request_correction or correct, self-service
  types only, never auto-approved, the org switch applies only to pure self-service callers); anyone else needs
  `attendance.correct` + org-wide `attendance.view` or a direct report; auto-approval only for org-wide `attendance.view` +
  `attendance.approve` (HR) without a workflow; team-only callers are routed to `attendance.approve` holders. Old
  approval/workflow routes on the attendance router are gone (the v2 router serves them, `/approve` `/reject` kept as aliases).
- **Leave** (`schedule.service.ts`, `self-service.service.ts`): every leave record gets a request; HR recording leave is
  auto-approved without a workflow (unless it is their own), self-service leave is routed to `leave.approve` holders; an HR
  decision on the Leave page goes through the engine (a note is required to reject); a material edit of pending leave
  invalidates the request and resubmits it; withdrawal / deletion cancels it; leave pending from before the engine keeps
  HR's direct decision path.

### Worker
- Scheduler task `approvals.reminders` (hourly): a platform scan enqueues one deduped `APPROVAL_REMINDERS` job per
  organisation with pending requests; the handler escalates overdue levels (adds the target — next level's approvers, HR
  admins or the owner, never the subject or the requester — as `escalated` actors, stamps `escalated_at`, timeline event,
  `approval.escalated`), sends the 24-hour reminder once per level (`approval.reminder`), and one digest per approver per day
  at 08:00 in the organisation's timezone (`approval_digest_runs`). Clock injected in tests.
- The relay routes every `approval.*` event to exactly `payload.userIds` (no permission fan-out, no 15-minute dedupe for
  deliberate transitions); e-mails for pending / reminder / escalated notices carry a one-click Approve / Reject token pair
  minted for that recipient only while they still hold a pending seat. `leave.requested` notifies HR only for leave the
  engine did not route.

### Web
- `/approvals` — Pending | History, scope chips Mine / My team / Everyone (each shown only with its key), type chips,
  search by employee name or number, a context cell per entity (correction diff, leave range + balance), the current level
  and its rule, approve / reject from the row (reject needs a comment), row selection + "Approve selected" (bulk, Pending),
  History CSV export (`report.export`), delegate banner. A row opens the request panel (deep link `?request=<id>`, also
  `/approvals/requests/:id`): every level, its approvers and how each was chosen, decisions, the timeline, and the actions the
  API allows (decide, ask / answer information, reassign, approve as exception, withdraw).
- `/approvals/delegations` (mine both directions; HR sees and creates the organisation's), `/approvals/email-action` (confirm
  before posting; nothing on page load), workflow editor v2 (levels with approver type, chain level, role by permission or
  role, named user, mode + quorum, escalation; applies-to; minimum units; self-approval switch).
- Sidebar shows Approvals to approvers and line managers; the dashboard queue card shows for any approve key and reads the
  v2 queue; `/my/leave` shows the request's level and its timeline; decisions refresh the inbox, the documents and the
  dashboard count. en + ar throughout.

### Seeds / docs
- Local fixture seed writes v2 workflows and complete v2 requests (levels, actors, decisions, timeline; the correction is the
  request's entity). The hosted demo seed writes `mode` on its levels and brings every seeded request to the v2 shape.
- `docs/api.md` (Approvals rows), `docs/blueprint.md` (data model), this report.

## 2. Workflow level schema (`approvalWorkflowStepSchema`)

```
{ order: 1..5,
  approverType: MANAGER | SECONDARY_MANAGER | MANAGER_CHAIN | HR_ADMIN | DEPARTMENT_HEAD | BRANCH_MANAGER | ROLE | USER,
  roleId?: uuid, permission?: Permission,          // ROLE: one of them
  userId?: uuid,                                   // USER
  chainLevel?: 1..10,                              // MANAGER_CHAIN (1 = manager, 2 = manager's manager …)
  mode: ANY | ALL | QUORUM  (default ANY), requiredCount?: 1..50 (QUORUM),
  escalateAfterHours?: 1..720, escalateTo?: NEXT_STEP | HR_ADMIN | OWNER   // both or neither
}
workflow: { name, entityType, branchId?, isDefault, status, steps[1..5], appliesTo { branchIds?, departmentIds? },
            minUnits?, allowSelfApproval }
```

## 3. Endpoints (all under `/api/v1/orgs/:orgId`)

`GET approvals` (alias `approvals/inbox`), `GET approvals/history`, `GET approvals/history/export`, `GET approvals/mine`,
`GET approvals/:id`, `POST approvals/:id/decide` (+ `/approve`, `/reject` aliases), `POST approvals/bulk-decide`,
`POST approvals/:id/cancel`, `POST approvals/:id/reassign`, `POST approvals/:id/bypass`, `POST approvals/:id/request-info`,
`POST approvals/:id/answer-info`, `POST approvals/email-action`, `GET|POST approval-workflows`,
`PATCH|DELETE approval-workflows/:id`, `GET|POST approval-delegations`, `GET approval-delegations/candidates`,
`DELETE approval-delegations/:id`. Permissions per row in `docs/api.md`.

## 4. Decisions (priority order Security > Reliability > Data Integrity > … > UX)

1. **Segregation of duties is keyed on the SUBJECT.** The person a request is about never decides it, whatever seat resolved
   to them (the owner may, and it is logged as `sod_owner_bypass`). The requester is removed at every rung and kept only at
   the owner level when nobody else remains and the request has a subject (HR filed for somebody and is the only possible
   approver) — Finance B-87 adapted to a ladder that always ends at the owner.
2. **Every level is resolved at submission** and snapshotted in `approval_step_actors`, so what an approver sees in the
   timeline is what was decided; escalation and reassignment are explicit, recorded changes of that snapshot.
3. **Permission seats are scoped.** A ROLE step by permission seats holders whose branch scope covers the subject AND who
   hold the entity's organisation-wide view key or are the subject's own managers — otherwise every line manager (who holds
   `attendance.approve`) would sit on every correction of the organisation.
4. **B-91 permission override.** An approve-permission holder (organisation-wide, or for a direct report) or the owner may
   decide a level they are not seated on; it settles the level on its own and is logged `override`. An approver added by
   escalation also settles the level and never counts as an extra seat of an ALL / QUORUM level.
5. **Closed requests and non-current levels are conflicts (409), a repeated decision by the same actor is a no-op (200,
   `noop: true`).** Finance treats both as no-ops (B-95); keeping 409 for the first preserves the concurrency guarantee the
   existing tests pin (`[200, 409, 409]`) and tells a stale screen it is stale.
6. **Self-service is never auto-approved** (addendum P1/P2): without a workflow, an employee's own correction or leave goes
   to the approve-permission holders in reach; only HR (organisation-wide view + approve) recording a correction or leave is
   auto-approved — and the request row still exists (Finance B-84).
7. **Absent** = no linked login, inactive membership, or approved leave today. An active delegation does not make the
   approver absent: the delegate acts alongside them in their seat (Finance B-89), and replaces them when they are absent.
8. **Tiers use one generic `min_units`** (leave days, overtime minutes) instead of `min_days` / `min_minutes`: the entity
   type fixes the unit, and one column keeps the selection rule single (the highest applicable minimum wins).
9. **Self-approval is a workflow switch**, not a per-level flag — it lifts SoD for the whole request or not at all.
10. **Decide by request, not by URL step:** `POST approvals/:id/decide` with an optional `stepNo` guard in the body
    (instead of `/steps/:stepNo/decide`); the v1 `/approve` and `/reject` routes stay as aliases.
11. **Names are resolved in the organisation's system scope** for the requests the caller is already allowed to see (RLS
    decides the rows); the inbox search matches names / numbers the same way and only narrows the caller's view.
12. **Exception approval (B-99)** requires `approval.manage` (or owner), branch scope and a reason, skips every open level,
    runs the hook, tells the approvers who were waiting, and is refused on one's own request (owner excepted, logged).
13. **Bulk decisions run one request per transaction** so a refusal never undoes the others; the answer has one line per
    request with the API's own error code.
14. **Deleting a workflow archives it** (B-83): requests keep their workflow; archived rows are neither listed nor editable.
15. **One notice per decision:** when the entity hook tells the person concerned itself (leave.approved / leave.rejected),
    the engine leaves them out of `approval.decided`.
16. **E-mail actions** (B-101): tokens minted only when the e-mail is composed, for a recipient who still holds a pending seat;
    sha256 at rest, 7 days, single use, the pair is consumed together, the landing page never acts on load, and the
    decision goes through the same `decideWithin` as the UI.
17. **In-flight v1 requests are migrated, not abandoned** (§1), including the subject snapshot, so SoD applies to them.
18. **Corrections: client writes removed rather than narrowed.** An UPDATE policy cannot tell the engine's state changes
    from a client's, so authenticated UPDATE / DELETE are gone; the API writes in the system context after its own checks.
19. **Digest counts are an array** (`[{ entityType, count }]`), never an object keyed by enum values — the Kysely
    CamelCasePlugin rewrites nested jsonb keys on read.
20. **`.claude/**` is ignored by ESLint**: parallel agents' worktrees live there and are full repository copies.

## 5. Finance parity — Appendix B items B-81…B-105 (+ Appendix A ids of this phase)

| Id | Status | Where / note |
|---|---|---|
| B-81 one active policy per entity type | ✓ (adapted) | one active default per entity × branch scope × tier × applies-to (tiers are separate workflows) |
| B-82 ordered levels, approver kinds, all/any/quorum | ✓ | 8 approver types, ANY / ALL / QUORUM |
| B-83 validation, permission, soft delete | ✓ | Zod + DB CHECK; `approval.manage` or `organization.manage`; DELETE archives |
| B-84 no policy ⇒ auto-approved request | ✓ (adapted) | HR recording; self-service is routed instead (decision 6) |
| B-85 fail on no levels / nobody / quorum too high | ✓ | CHECK (1–5 levels); 400 with the level and the reason |
| B-86 one pending request per document | ✓ | partial unique index + 409 |
| B-87 subject never approver; requester excluded | ✓ | domain `segregate` (decision 1) |
| B-88 manager_chain with fallbacks | ✓ | secondary substitution, most senior reachable, HR admins, owner |
| B-89 delegation (date window, type-specific preferred) | ✓ | stamped `via_delegation_of`; acts alongside |
| B-90 "approval requested" to each newly active level | ✓ | targeted `approval.pending` at submit and on advance |
| B-91 who may decide; disabled users cannot | ✓ | `assessDecider`; inactive membership has no grant |
| B-92 deciding about oneself refused, owner logged | ✓ | `sod_owner_bypass` |
| B-93 level satisfaction per mode, skip the rest, advance | ✓ | `evaluateLevel`, SKIPPED actors |
| B-94 rejection terminal in ALL or when unreachable | ✓ | `evaluateLevel` |
| B-95 non-current level / already decided ⇒ no-op | ◐ | own repeat = no-op; closed / non-current = 409 (decision 5) |
| B-96 material edit voids and resubmits | ◐ | pending leave: invalidate + automatic resubmission; HR edits of APPROVED leave stay HR's direct correction (Prompt 7) |
| B-97 delete / void / cancel cancels pending requests | ✓ | leave withdrawal / deletion / status change, correction cancellation |
| B-98 requester or permission holder withdraws with a reason | ✓ | reason optional (the portal withdraw has none) |
| B-99 exception bypass with a reason | ✓ | `POST approvals/:id/bypass` |
| B-100 ask for information, both sides notified | ✓ | in-app + e-mail, "waiting for your answer" marker |
| B-101 one-click e-mail actions | ✓ | decision 16 |
| B-102 daily reminders for every entity type | ✓ (adapted) | hourly scan: 24-hour reminder per level + 08:00 local digest |
| B-103 tiers; below every threshold auto-approved | ✓ (adapted) | `min_units`; below every tier = no workflow ⇒ decision 6 |
| B-104 reassign a level, recorded | ✓ | `approval.manage` / owner; `reassigned` event + notices |
| B-105 inbox: tabs, search, chips, Pending/History, CSV, audit lines | ✓ | scope chips stand in for Finance's HR/Finance tabs (one product domain here) |
| ATT-93 submission through the engine, manager_chain + fallbacks | ✓ engine | regularisation itself arrives with Prompt 4 |
| ATT-95 bulk approve through the engine | ✓ | `bulk-decide` + "Approve selected" |
| ATT-106 shift swap approval step | ◐ | `SHIFT_SWAP` entity type exists (GENERIC context); the hook ships with the swaps in Prompt 4 |

## 6. Verification (local Postgres 16 @ 127.0.0.1:54329; DB suites under `flock /tmp/flowza-dbtests.lock`)

| Gate | Result |
|---|---|
| `pnpm build:packages` | pass |
| `pnpm lint` (`--max-warnings 0`) | pass |
| `pnpm -r --filter "./apps/*" run typecheck` | pass (api, web, worker) |
| `pnpm test:unit` | pass — shared 4, domain 220 (26 approvals), device-providers 140, database 20 |
| `pnpm --filter @flowza/web run test` | pass — 51 files, 197 tests (inbox, request panel, decision dialog, workflow editor, delegations, sidebar, dashboard, portal, leave) |
| `bash supabase/tests/run-rls-tests.sh` | pass — plus the new `rls_approvals.sql` (44 assertions: assignee without keys, delegate for the delegated type only, subject, line manager, organisation-wide reader, cross-tenant zero rows, no client writes, tokens unreadable, corrections INSERT PENDING-in-reach only / no UPDATE / no DELETE, system context) |
| `pnpm test:db` | pass — 2 files, 11 tests |
| `pnpm --filter @flowza/api run test` | pass — 18 files, 195 tests (`approvals.test.ts` 22, `team.test.ts` 10 incl. the addendum cases, `attendance.test.ts` 9) |
| `pnpm --filter @flowza/worker run test` | pass — 11 files, 110 tests (1 skipped, pre-existing); `approvals.test.ts` 6 with an injected clock |
| `pnpm -r --filter "./apps/*" run build` | pass (the >700 kB chunk warning predates this phase) |
| fresh replay of every migration + second apply of `20260928000200` | pass (own scratch database) |
| `pnpm db:types` | in sync (82 tables) |
| `db-reset-local.sh --seed` (Al Bahja) | pass — 15 v2 requests (3 at level 1, 3 at HR, 6 approved, 3 rejected) with actors and timelines |
| demo tenant seed 01…05 on a scratch database | pass — seeded requests carry actors, decided levels, SKIPPED leftovers, timelines |
| v1 in-flight backfill proof (scratch database at the pre-v2 schema) | pass — named user, role members across branch scope, requester + subject excluded, owner fallback, closed requests untouched, idempotent |

Existing tests changed on purpose: `attendance.test.ts` (inbox DTO shape; the B-91 override case now uses an HR user
without `attendance.approve`; `hr_admin` holds `approval.manage` since Prompt 1), the HR Leave page test (a note is required
to reject), the leave-decision notice test (one notice, `leave.approved`, instead of two).

## 7. Known limits / follow-ups

- **Merge note for Prompt 3:** a later migration that re-runs `app.apply_tenant_policies` on `attendance_corrections`
  would recreate client UPDATE / DELETE policies and reopen direct approval of corrections. `rls_approvals.sql` fails loudly
  if that happens ("manager cannot approve a correction by UPDATE"); re-drop them in that migration.
- Entity hooks exist for corrections and leave. `ATTENDANCE_NOTE`, `SHIFT_SWAP`, `COMP_OFF`, `REGULARISATION`,
  `OVERTIME_CLAIM` already get requests, decisions and a GENERIC context; their document side arrives with Prompts 3/4/7.
- HR edits of APPROVED leave are not re-routed (B-96 partial) — Prompt 7 (leave v2) decides the rule.
- A leave decision made through the HR Leave page returns `recalculationJobId: null`; the hook still enqueues the
  recalculation (same job), the response just does not carry its id.
- Bulk decisions from the UI are approve-only (a rejection needs its own comment); the API accepts a shared comment.
- Withdrawal reasons are optional (the portal's withdraw has no field); Finance B-98 asks for one.
- The migration file was extended after the first commit on this branch (in-flight backfill, subject snapshot) — still one
  unreleased file; hosted apply and re-seed happen in Prompt 12.
- Work was done in `/home/user/Flowza-Time` on the branch, as the brief requires, although the session environment named a
  `.claude/worktrees/agent-*` directory as its working directory; nothing under `.claude/` was touched.
- No new dependencies.

## 8. Files

- Migration `supabase/migrations/20260928000200_approval_engine_v2.sql`; RLS suite `supabase/tests/rls_approvals.sql`
  (+ `run-rls-tests.sh`); seeds `packages/database/src/seed/index.ts`, `supabase/seeds/demo-tenant/{03b_employee_portal,04_attendance}.sql`, README.
- Contracts `packages/contracts/src/{enums,sync}.ts`, `dto-features/{approvals,attendance}.ts`, `dto/self-service.ts`; domain
  `packages/domain/src/approvals/*`; database `packages/database/src/approval-tokens.ts`, generated types.
- API `apps/api/src/services/approvals/*` (engine, context, dto, queries, workflows, delegations, email-tokens, hooks),
  `routes/v1/features/approvals.ts`, `services/features/{attendance,schedule}.service.ts`, `services/self-service.service.ts`,
  `lib/{mappers,csv}.ts`; tests `routes/v1/features/{approvals,attendance}.test.ts`, `test/team.test.ts`.
- Worker `apps/worker/src/handlers/approvals/*`, `handlers/notifications/outbox.ts`, task registration; test
  `handlers/approvals/approvals.test.ts`.
- Web `apps/web/src/features/approvals/**` (api, labels, components, pages, routes, tests), sidebar, dashboard card + layout,
  portal and HR leave pages, corrections / leave / portal query invalidation, locales `en|ar/{approvals,portal,leave}.json`,
  `e2e/support/mock-backend.ts`, `eslint.config.js`.
