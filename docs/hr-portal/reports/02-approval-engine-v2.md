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

## 9. Review fixes (adversarial review, 2026-09-28)

Source: `docs/hr-portal/reviews/02-approval-engine-v2-review.md` (committed first, `db99cc1`). Branch
`worktree-agent-afdfea9db307db7b0`. Commits:
- `198b3a6`: engine, API, contracts, domain, worker, database;
- `b2a8464`: merge of `claude/modest-fermi-fnwqq7` @ `2b82b16` (Finance connector review fixes, Prompt 6a workspace);
- `ac8f736`: web and the regression suites;
- `09c1034`: e-mail limiter test and API reference;
- this report.

There is one new migration, `20260928000800_approval_engine_v2_review_fixes.sql`. It is additive and idempotent, sets
`lock_timeout 5s` / `statement_timeout 120s`, passes as one transaction, and ends with a post-verify block.
`20260928000200` is untouched.

**Assigned to Prompt 7 (leave v2), not fixed here:** P1-3, P1-4, P2-9, and the Leave-page parts of P1-2 and P2-4. No
leave, attendance-note, regularisation, swap or comp-off code was edited. The one attendance edit is `cancelCorrection`,
which now asks the engine's `canCancel`.

This section supersedes decisions 4, 9 and 10 of §4 (see §9.2). It also supersedes the §7 note that withdrawal reasons
are optional: the HTTP route now requires one (P2-4); the portal's withdraw form is Prompt 7's.

### 9.1 Defect → fix → regression test

Every test is named after its defect id. API tests are in `apps/api/src/routes/v1/features/approvals-review.test.ts`
unless another file is named.

| Id | Fix | Test(s) |
|---|---|---|
| P0-1 | **One seat per call.** A seated actor, or their active delegate, decides their own seat. An approver added by escalation fills one pending seat. An organisation-wide holder of the entity's approve key (with its organisation-wide view key; branch scope applies) or the owner may override ONE pending seat, and only when the call names the current `stepNo`: the seat named by `onBehalfOfUserId`, else the first pending seat. The override is recorded on the actor row (`resolution_path` `override` / `owner_override`, `on_behalf_of_user_id`), as an `override` event and as an `approval.override` audit row. The seat's other pending rows are skipped and the level is evaluated by its mode. A line manager never overrides. `abilities.canDecide` / `decideVia` follow the same rule (`assessDecider`), and the decision dialog and request panel say whose seat an override fills. | API: "P0-1 manager cannot decide the HR level"; "P0-1 an organisation-wide HR override fills one seat in ALL mode and the level stays pending"; "P0-1 an override without stepNo is refused with a clear message"; "P0-1 an ANY-mode override settles the level". Domain `evaluate.test.ts`: "P0-1 / P2-13 one seat per decision". Web `decision-dialog.test.tsx`: "P0-1 tells an organisation-wide approver that the decision is an override filling one seat, and names it"; "P0-1 shows no override note to a seated approver". Web `request-detail.test.tsx`: "P0-1 shows whose seat an override filled". |
| P0-2 | Every read rule of `approval_requests`, `approval_steps`, `approval_step_actors`, `approval_request_events` and `approval_delegations` is ANDed with `app.member_org_ids()`. That set is the caller's active memberships, the organisation's system context and a live platform grant. A delegation covers a seat only while the delegator is an active member (`app.approval_delegate_of`). | `rls_approvals.sql`: "P0-2 a suspended assignee reads no request / level / actor row (no comments) / timeline"; "P0-2 a suspended requester reads no request / level / timeline"; "P0-2 a removed member reads no request / actor row / timeline"; "P0-2 a suspended delegator reads no request"; "… no longer reads their delegation (nor its reason)"; "P0-2 the delegate of a suspended delegator no longer covers their seat"; "…nor counts it as actionable"; "P0-2 an outsider reads no request / level / actor row / timeline / delegation, has nothing actionable, has no inbox summary"; "P0-2 anon is denied approval requests / delegations". |
| P0-3 | `allowSelfApproval` is removed from the workflow input schema, the domain resolver, the engine and the workflow editor. The DTO always says `false`. The migration clears every row (one `approval_workflow.self_approval_removed` audit row each) and adds `check (allow_self_approval = false)` (`approval_workflows_no_self_approval`). The only exception left is the owner deciding about themselves (`sod_owner_bypass`). | API: "P0-3 a workflow cannot switch self-approval on, and an HR admin never approves their own request". Domain `resolve.test.ts`: "P0-3 no switch lifts the exclusion: a workflow flag passed along is ignored and the subject is never seated". Database `approvals-review-migration.db.test.ts`: "P0-3 clears self-approval on every workflow (audited) and pins it with a CHECK". RLS: "P0-3 a workflow cannot allow self-approval". Worker: see P0-4. Web `workflow-dialog.test.tsx`: "P0-3 a ROLE level resolves by permission by default, and the editor offers no self-approval switch". |
| P0-4 | SoD looks at the live link: `isRequestSubject` is the caller's CURRENT membership `employeeId` equal to the subject employee, OR the snapshot `subject_user_id`. It is checked by decide, bypass, reassign (both the caller and the target), request-info and cancel; the owner is excepted and logged. Worker reminders and escalation also leave out logins that are currently linked to the subject. | API: "P0-4 a login linked to the subject after submit can neither decide, bypass, ask about, withdraw nor be handed the request". Worker `approvals.test.ts`: "P0-3 P0-4 escalation never seats the person a request is about — by the submit snapshot or by the CURRENT membership link — whatever the workflow". |
| P1-1 | Reassignment replaces the level's PENDING seats with the reassignee. `required_count` becomes `min(required, approvals given + 1)` (`requiredAfterReassign`; in ALL mode every remaining seat is still needed). An APPROVE can no longer produce a rejection. | API: "P1-1 reassigning a QUORUM level never turns an approval into a rejection" (the review's probe). Domain: "P1-1 reassigning a level". |
| P1-2 | `stepNo` is required on `decide` and on every bulk item (`approvalBulkDecideSchema.items`). The `/approve` / `/reject` aliases take an optional `stepNo`; without it they decide only a seat the caller holds. The internal `decide()` keeps `stepNo` optional, but no `stepNo` means no override. A non-current level still returns 409. The web bulk bar sends each row's own level. | API: "P1-2 a late click never closes the next level (bulk, aliases, concurrent decisions)". Web `approvals-page.test.tsx`: "P1-2 approves several selected requests in one call, each line naming the level it was on — the API decides each one and reports refusals". E2E: "P2-12 inbox → …" asserts `stepNo: 2` in the body. |
| P1-3 | Prompt 7 (the HR leave PATCH lives in `schedule.service.ts`) | — |
| P1-4 | Prompt 7 | — |
| P1-5 | The assignee branch is `app.approval_request_assigned(id, organization_id, entity_type)`: a per-row boolean over indexed columns. It returns true for a seat or decision on any level, a v1 level naming the caller, or the pending seat of somebody who delegates to the caller today, and only for an active member of that organisation. No policy builds the array of every historical assignment any more. New indexes: `approval_step_actors_user_step_idx`, `approval_steps_org_request_idx`, `approval_request_events_org_request_idx`, `approval_delegations_delegate_window_idx`. EXPLAIN before / after is in §9.4. | RLS: "P1-5 no approval read rule builds the array of every assignment"; "P1-5 the assignee branch is a per-row check on the request's own ids"; "P1-5 the read rules' indexes exist". A third tenant (2,000 requests / 4,000 levels / 8,000 seats of one approver) feeds "P1-5 the heavy approver reads one of their requests", "…and nothing of the other tenants" and "P1-5 org A's owner reads nothing of the heavy tenant", with EXPLAIN buffer bounds: a by-id read touches 25 buffers (bound 100) and org A's read 17 (bound 200). |
| P1-6 | `/approvals` (inbox, request panel, the new "My requests" tab, delegations) is open to every active member; the API scopes the rows. `/me` gains `approvals: { actionable, delegatedToMe }` per membership, from one indexed query (`app.approval_inbox_summary()`). The sidebar shows Approvals for an approve key, direct reports (`hasDirectReports`, kept), or when `/me` reports approvals waiting or a delegation in force. The item's `visible` / `any` rules are kept. | API: "P1-6 /me reports the approvals waiting for a delegate or a named approver, and the inbox lists them". Web `sidebar.test.tsx`: "P1-6 shows Approvals to a member without any approve key when /me says approvals wait for them or a delegation is in force". Web `approvals-page.test.tsx`: "P1-6 opens the inbox to a member who holds no approve key, and lists what waits for them"; "P1-6 lists "My requests" — what the caller filed or what is about them — from /approvals/mine". |
| P1-7 | At the owner rung, when the subject is the organisation's only owner and nobody else is eligible, the owner is seated and decides with `sod_owner_bypass` recorded. | API: "P1-7 the single owner files and decides their own leave, their HR-recorded leave and their own correction (owner bypass logged)". Domain: "P1-7 seats the subject when they are the organisation's only owner and nobody else can decide (owner bypass)". |
| P2-1 | There is one "today": `app.org_today(org)` / `app.org_date_at(org, instant)`, taken from `organizations.timezone`. RLS, the inbox / `mine` queries, the actionable counts, `activeOnly` delegation lists and the engine (`approvalToday`) all use it. | API: "P2-1 a delegation window in the organisation's date works end to end in Kiritimati, Los Angeles and Pago Pago; the UTC date does not". RLS: "P2-1 Kiritimati: 23:30 UTC on the 27th is already the 28th", "…09:59 UTC is still the 28th", "…10:00 UTC is the next day"; "P2-1 Los Angeles: 00:30 UTC on the 28th is still the 27th", "…07:00 UTC (PDT) is the 28th"; "P2-1 org_today is org_date_at(now())"; window in force / ended in organisation dates for the read rule, the inbox queue and `/me`. |
| P2-2 | Reassign refuses the requester or the subject as target (400). It refuses somebody who already decided at the level (409; their decision stands). It refuses a caller who filed the request or is its subject (the owner is excepted, logged). | API: "P2-2 reassignment never seats the requester or the subject, and never erases a decision already taken". |
| P2-3 | The subject cannot request information on a request about them. `answerInfo` without an outstanding question returns 409. | API: "P2-3 the subject cannot ask about their own request, and an answer needs an outstanding question". |
| P2-4 | The engine lets these withdraw: the requester (a subject withdrawing their own filing included), `approval.manage` / the owner, and a holder of the entity's manage key with its organisation-wide view key (`leave.manage` / `attendance.correct`; branch scope applies). A seated approver cannot, and neither can a subject who did not file (owner excepted, logged). The HTTP reason is required (3–500 characters). Internal callers default to "Withdrawn by the requester" (`DEFAULT_WITHDRAW_REASON`). The web withdraw prompt requires a reason, and the corrections page offers withdrawal on the same rule. | API: "P2-4 only the requester, the entity's organisation-wide manager or approval.manage withdraws, always with a reason". Web `request-detail.test.tsx`: "P2-4 withdrawing always says why (at least 3 characters), and the reason reaches /cancel". |
| P2-5 | A login linked to an employee whose membership is not active is reported as "membership suspended" (or the actual status), never "no linked login". | API: "P2-5 a suspended manager is reported as "membership suspended", not "no linked login"". Domain: "P2-5 reports a suspended manager as such, not as "no linked login"". |
| P2-6 | The e-mail action has its own limiters: `approval-email-ip` and `approval-email-user`, 20 POST / minute each (`APPROVAL_EMAIL_ACTION_LIMIT`), on top of the API-wide limiter. A failed attempt writes `approval.email_token_failed` with the action, the error code and an 8-hex-character sha256 prefix only. A link decides only the seat it was minted for, never an override. | API `approvals-email-limit.test.ts`: "P2-6 twenty guesses a minute per IP and per user, then 429; failures are audited with a hash prefix, never the token" (mutation-checked: without the IP limiter it fails). |
| P2-7 | A workflow with QUORUM > 1, or ALL with a count > 1, is refused on a single-seat approver type (`MANAGER`, `SECONDARY_MANAGER`, `MANAGER_CHAIN`, `DEPARTMENT_HEAD`, `USER`), with a field error on `steps.N.requiredCount`. The editor shows the error under the field, and leaving QUORUM clears the count. | API: "P2-7 a quorum above one is refused on single-seat approver types, with a field error". Web: "P2-7 refuses a quorum above one on a single-seat approver type, with the reason under the field". E2E: "P2-12 workflow editor → …". |
| P2-8 | `applies_to` is canonical: sorted, de-duplicated, lower-cased id arrays with empty lists dropped. This holds on write (API `canonicalAppliesTo`, a BEFORE trigger) and in the uniqueness index `approval_workflows_default_v3_idx`. Existing rows are rewritten. Active defaults that become duplicates are deactivated, keeping the oldest, with one `approval_workflow.duplicate_deactivated` audit row each. **On every fresh replay and seeded database the migration found none**, because workflows are created after it. The hosted apply (Prompt 12) reports any it finds in `audit.logs`. The superseded text-keyed index `…_default_v2_idx` is dropped; it is an index, not data, and the generic 23505 → 409 mapping covers the new one. | API: "P2-8 appliesTo is canonical: reordered or repeated ids are the same default workflow". Database: "P2-8 canonicalises applies_to and deactivates the newer duplicate it reveals (audited); the index then refuses a reordered copy". RLS: "P2-8 applies_to is stored sorted, de-duplicated, lower-cased, without empty lists"; "P2-8 the same scope in another order is a duplicate default". |
| P2-9 | Prompt 7 (HR Leave page toast) | — |
| P2-10 | In the migration, PENDING levels and approvers of closed requests become SKIPPED. Levels the request never reached lose the invented `activated_at`. The timeline is untouched. | Database: "P2-10 closes the PENDING levels of closed requests, keeps their history and leaves open requests alone", plus "is idempotent: applied again, it changes nothing and audits nothing new". |
| P2-11 | The dashboard's `pendingApprovals` counts `app.approval_actionable_request_ids(org)`. That is the same definition as the inbox's Mine queue and `/me` `approvals.actionable`: the caller's pending seats on the current level, including a delegation in force today. The tile opens `/approvals` for everyone. | API: "P2-11 pendingApprovals equals what the Approvals card lists for the caller". |
| P2-12 | `e2e/support/mock-backend.ts` gains a stateful approvals double: inbox, request, decide, the one-click e-mail action, delegations, candidates, workflows, roles and members. `e2e/approvals.spec.ts` has five scenarios; each runs on the chromium and tablet projects. | E2E: "P2-12 inbox → approve the level waiting for me, with a comment"; "P2-12 request panel → every level with its approvers and the timeline"; "P2-12 e-mail link → nothing is sent on load; the approver confirms and the token is sent once" (mutation-checked: a page that acts on load fails it); "P2-12 delegations → delegate my approvals to a colleague and see it listed"; "P2-12 workflow editor → a quorum above one on the manager is refused; one approval saves". |
| P2-13 | See P0-1. A QUORUM or ALL level counts an override as one approval, and a branch-scoped approver never overrides outside their branches. | API: "P2-13 a QUORUM override counts one approval; a branch-scoped approver never overrides outside their branch". Domain: "P0-1 / P2-13 one seat per decision". |

The reviewer's "verified correct" list (§3 of the review) is covered by the existing suites, and all of them pass
unchanged in intent. Existing tests changed on purpose:
- in `approvals.test.ts`, every decision names its level, and bulk decisions send items;
- a withdrawal carries a reason;
- the organisation-wide override fills the owner's seat and says so;
- "an approver added by escalation fills one seat" (it used to settle the level);
- `employees.test.ts` expects `pendingApprovals: 0` on the dashboard.

### 9.2 Decisions

**From the brief:**
1. **Who may decide:** one seat per call, as in the P0-1 row. A line manager whose key reaches the subject only through
   the reporting line never overrides. This replaces decision 4 of §4.
2. **Every decision names its level (`stepNo`).** The aliases decide only a seat the caller holds. This replaces
   decision 10. Decision 5 stands: a non-current level or closed request is 409, and a repeat on a decided seat is a no-op.
3. **Self-approval is not configurable.** This replaces decision 9. The owner deciding about themselves is the one
   exception, logged `sod_owner_bypass`.
4. **SoD on the live link** for decide, bypass, reassign (both caller and target), request-info and cancel. This extends
   decision 1.
5. **Reassign** moves the pending seats and lowers the requirement to `min(required, approvals + 1)`. It is never done
   onto the requester, the subject, or somebody who already decided.
6. **Read rules** are membership-scoped, with a per-row assignee check. **One "today"**: the organisation's date.
7. **Withdrawal:** requester; the entity's organisation-wide manager; `approval.manage` / owner. The reason is required
   over HTTP. **Info requests:** never by the subject, and only answered while a question is outstanding.
8. **Single-owner organisation:** the owner is seated as the last resort and decides with the bypass logged.

**Taken while implementing:**
9. **An approver added by escalation fills one seat**, the one they name or else the first pending seat, exactly like an
   override. Until they decide, their row is an extra hand, not a seat, so it never raises an ALL / QUORUM requirement.
   This was the old decision 4's other half. One seat per call applies to every route.
10. **Seat authority is not branch-limited.** A seated actor or their delegate decides their own seat whatever their
    branch scope, because the workflow seated them. Branch scope limits overrides only.
11. **A delegate stamped at submit keeps the seat only while that delegation is still in force** (organisation date,
    delegator still active). This mirrors the read rule, so a lapsed delegate cannot decide what they can no longer see.
12. **The "Mine" scope is not narrowed by the caller's membership branch scope.** A seat is a seat; an explicit
    `branchId` filter still narrows it.
13. **A subject who did not file cannot withdraw** (P0-4 lists cancel). The requester can always withdraw their own
    filing, and that includes the subject who filed for themselves. The owner is excepted and logged.
14. **Bulk decide** keeps `requestIds` as an optional internal input next to `items`, so existing internal callers
    compile. The HTTP schema requires `items`.
15. **The e-mail link decides its own seat only** (`requireSeat`). A token minted for a seat never becomes an override.
16. **`onBehalfOfUserId` / `onBehalfOfName` are optional on the actor DTO**, so fixtures of parallel prompts compile.
17. **Leave and comp-off without a registered hook use the leave keys** (`leave.approve` / `leave.view` / `leave.manage`);
    every other type uses the attendance keys. A hook can override this through the new optional `managePermission`.
18. **Every use of the owner's SoD exception is recorded** (`sod_owner_bypass` event plus audit row). That covers:
    - deciding a request about themselves by any route, their own seat included (P1-7);
    - deciding one they filed by a route that is not their own seat;
    - withdrawing one about them that they did not file;
    - reassigning, exception-approving, or asking about one they filed or that is about them.

### 9.3 Exported signatures

Nothing is renamed or removed, and no parameter became required. Added: optional `onBehalfOfUserId` / `requireSeat` on
`DecideInput`; optional `via` / `onBehalfOfUserId` on `DecideOutcome`; `override` / `alreadyDecided` fields and the
`'escalated'` value of `via` on `DeciderAssessment`; `items?` on `bulkDecide`'s input (`requestIds` is now optional
beside it); optional `employeeId` on `canBypass`'s request. `assessDecider` / `buildResolutionContext` accept
`allowSelfApproval` as optional and ignore it. `EntityHook.managePermission?` is new, and so are these exports:
- engine: `isRequestSubject`, `decideViaOf`, `approvalToday`, `delegatorsOf`, `DEFAULT_WITHDRAW_REASON`,
  `managePermissionFor`;
- workflows: `canonicalAppliesTo`;
- domain: `seatOfRow`, `pendingSeats`, `requiredAfterReassign`, `ActorDecisionRow.onBehalfOfUserId?`.

`ResolutionContext.allowSelfApproval` is gone from the domain type. It was optional, and nothing sets it now.

The HTTP contract changes the brief asked for:
- `approvalDecideSchema.stepNo` is required;
- `approvalBulkDecideSchema` takes `items: [{ requestId, stepNo }]`;
- `approvalCancelSchema.reason` is required (3–500 characters);
- `approvalLegacyDecisionSchema` gains `stepNo?`;
- the workflow input has no `allowSelfApproval`;
- `ApprovalAbilitiesDto` gains `decideVia?`;
- `/me` memberships gain `approvals`.

### 9.4 P1-5: EXPLAIN (ANALYZE, BUFFERS) before / after

**Setup.** A scratch copy of the seeded database, plus a synthetic tenant of 100,000 requests / 200,000 levels /
400,000 actor rows (`SCALE`). Its heavy approver is an active employee-role member who holds a seat on every level of
that tenant. The seeded HR admin and employee are Al Bahja's; Al Bahja has 15 requests.

**Runs.**
- "Before" is the schema at `20260928000200`.
- "After" is the same data with `20260928000800`.
- "After, realistic spread" adds 300 small organisations (20 requests, 40 levels, 80 seats each; 302 tenants in all) and
  runs `ANALYZE`, as a production catalogue would have.

Times are EXPLAIN execution times. Warm psql `\timing` is given in brackets.

| Read (under the caller's RLS) | Before | After (2 tenants) | After (realistic spread) |
|---|---|---|---|
| HR admin: `count(*) from approval_requests` | 651.9 ms, 208,519 buffers (seq scan of every tenant) | 18.1 ms, 2,274 buffers | **4.3 ms**, 863 buffers, index on the organisation (warm 1.8–2.0 ms) |
| HR admin: the same, filtered by organisation (the API's shape) | — | (1.7–2.1 ms) | (1.7–1.9 ms) |
| HR admin: `count(*) from approval_steps` | 949.0 ms, 211,013 buffers | 272 ms (JIT; filtered by organisation 2.3–2.9 ms) | **2.4 ms**, 49 buffers, index-only (warm 2.0–3.5 ms) |
| Employee: `count(*) from approval_requests` | 626.6 ms, 208,548 buffers | 22.3 ms (filtered by organisation 2.3–3.2 ms) | **6.6 ms** cold, 943 buffers (warm 2.1–2.3 ms) |
| Heavy approver: `count(*) from approval_requests` (100,000 visible rows) | 22,605.6 ms, temp spill (seq scan of the whole table) | 1,847 ms, seq scan (their organisation is 99.99% of this table) | 1,976 ms (warm 1.75–1.82 s), index on their organisation, 100,000 rows |
| Heavy approver: one request by id | 492.5 ms, 7,118 buffers + temp spill | **1.9 ms**, 48 buffers | **1.9 ms**, 58 buffers |
| Heavy approver: the levels of one request | 545.6 ms, 7,126 buffers + temp spill | **2.1 ms**, 72 buffers | **2.3 ms**, 86 buffers |

**Why the 2-tenant column is slower.** With only two tenants, the statistics give `organization_id` two distinct
values. The planner therefore estimates that `organization_id = any(<my organisations>)` matches half the table, and
seq-scans. On the steps count, that estimate also crosses `jit_above_cost`, and JIT compilation is most of the 272 ms.
The API never issues an unfiltered read: every list and count filters `organization_id = :org`, and those run in
1.7–2.9 ms on the same data. With a realistic spread of tenants, even the unfiltered reads use the organisation index,
in single-digit milliseconds.

**The heavy approver's full count** is now bounded by their own organisation: 100,000 visible rows, each with a per-row
assignee check. It no longer touches another tenant, spills to disk, or builds an array of 200,000 assignments. The API
never counts that set unfiltered. The inbox pages at most 100 rows, and "Mine" is driven by the caller's own pending
seats (`app.approval_actionable_request_ids`).

**Regression bounds.** `rls_approvals.sql` pins the shape in CI with a smaller third tenant (2,000 requests / 4,000
levels / 8,000 seats of one approver): a by-id read touches ≤ 100 buffers (measured 25), and an owner of another
organisation reading theirs touches ≤ 200 (measured 17).

### 9.5 Finance parity — rows changed by the fixes (B-81…B-105)

| Id | Status | Where / note |
|---|---|---|
| B-81 one active policy per entity type | ✓ (adapted) | canonical `applies_to` on write and in the index (P2-8) |
| B-83 validation, permission, soft delete | ✓ | the single-seat quorum is refused with a field error (P2-7) |
| B-87 subject never approver; requester excluded | ✓ | no self-approval switch (P0-3); SoD on the live link (P0-4); reassign never seats the requester or subject (P2-2) |
| B-91 who may decide; disabled users cannot | ✓ | one seat per call; override only by an organisation-wide approve holder or the owner, naming the level; line managers never override (P0-1 / P2-13); suspended members read and decide nothing (P0-2) |
| B-92 deciding about oneself refused, owner logged | ✓ | live link (P0-4); single-owner organisation (P1-7) |
| B-93 / B-94 level satisfaction, rejection terminal | ✓ | reassignment keeps the arithmetic (P1-1) |
| B-95 non-current level / already decided ⇒ no-op | ✓ (adapted) | a decision always names its level, so no re-targeting (P1-2); a repeat on a decided seat is a no-op; closed or non-current is 409 (decision 5) |
| B-96 material edit voids and resubmits | ◐ | P1-3 / P1-4 are Prompt 7's |
| B-98 withdraw with a reason | ✓ engine | requester / organisation-wide manager / `approval.manage`, reason required (P2-4); the Leave page is Prompt 7's |
| B-101 one-click e-mail actions | ✓ | per-IP and per-user limiter, failures audited without the token (P2-6) |
| B-104 reassign a level, recorded | ✓ | P1-1, P2-2 |
| B-105 inbox | ◐ | reachable by every member, plus "My requests" (P1-6); the pending count is one definition on the dashboard tile and in `/me` (P2-11); the sidebar item shows no count badge yet (§9.7) |

All other rows of §5 stand as written.

### 9.6 Verification on the merged tree (after `b2a8464`, with every commit above)

Local Postgres 16 @ 127.0.0.1:54329. DB suites ran under `flock /tmp/flowza-dbtests.lock` in this worktree's own
databases: `flowza_p2f`, `flowza_p2f_rls`, `flowza_p2f_ci2`, and the brief's replay target `flowza_p2f_tx`.

| Gate | Result |
|---|---|
| `pnpm build:packages` | pass |
| `pnpm lint` (`--max-warnings 0`) | pass. Re-run after the e-mail scenario was added. |
| `pnpm -r --filter @flowza/api --filter @flowza/web --filter @flowza/worker run typecheck` | pass |
| `pnpm test:unit` | pass: shared 4, contracts 5, domain 261 (19 files; approvals `evaluate` 10, `resolve` 18), device-providers 286, database 20 |
| `pnpm --filter @flowza/web run test` | pass: 64 files, 268 tests |
| `PGDATABASE=flowza_p2f_rls … run-rls-tests.sh` | pass: 314 assertions. `rls_isolation` 170, `rls_system_context` 18, `rls_hr_workspace` 37, `rls_approvals` 89 (44 before the review; still last in the runner). |
| `pnpm test:db` | pass: 3 files, 15 tests, including `approvals-review-migration.db.test.ts` (4) |
| `pnpm --filter @flowza/api run test` | pass: 26 files, 293 tests. `approvals.test.ts` 22, `approvals-review.test.ts` 19, `approvals-email-limit.test.ts` 1. |
| `pnpm --filter @flowza/worker exec vitest run` | pass: 15 files, 154 tests. 1 skipped, pre-existing. `approvals.test.ts` 7. |
| `pnpm -r --filter @flowza/api --filter @flowza/web --filter @flowza/worker run build` | pass. The > 700 kB chunk warning predates this work. |
| `PGDATABASE=flowza_p2f_ci2 bash scripts/db-reset-local.sh` | pass |
| single-transaction replay (`replay-single-tx.sh … flowza_p2f_tx`) | pass. Every file above the hosted floor ran as one transaction, `20260928000800` included. |
| `PGDATABASE=flowza_p2f bash scripts/db-reset-local.sh --seed` | pass. 15 requests: 6 pending, 6 approved, 3 rejected. No closed request keeps a pending level, no workflow allows self-approval, and the migration needed no clean-up audit row. |
| `pnpm db:types` (against the fresh `--seed` reset) | in sync: 87 tables, no diff |
| `pnpm --filter @flowza/web run build:e2e && … test:e2e` (`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`) | pass: 46 tests (23 scenarios × chromium + tablet). Approvals: 10 (5 scenarios). Re-run on the final tree after the e-mail scenario was added. |

### 9.7 Open items

- **Prompt 7:** P1-3 (an HR PATCH that edits leave and decides in one call skips invalidation), P1-4 (HR overturning
  an engine rejection), P2-9 (the Leave page toast), and the Leave-page parts of P1-2 (`stepNo` from the HR Leave
  page) and P2-4 (withdraw reason on the portal).
- **Sidebar count badge:** `/me` carries `approvals.actionable` per membership, but the sidebar item shows no number
  yet. The sidebar layout is shared with parallel prompts, so the badge is left to the integrator or a follow-up.
- **The heavy approver's unfiltered count** is ~1.8 s for 100,000 visible rows (§9.4). The API never issues that
  query. If a report ever needs it, it should count in the organisation's system scope after the permission check.
- **Merge note:** in `attendance.service.ts`, `cancelCorrection` now calls the engine's `canCancel`, and the engine
  import names it. Nothing else in that file changed; `createCorrection` is untouched. A parallel prompt that edits
  `cancelCorrection` should keep the call.
- The hosted apply (Prompt 12) will report any workflows the self-approval clean-up or the canonical `applies_to`
  de-duplication touched, as `approval_workflow.self_approval_removed` / `approval_workflow.duplicate_deactivated`
  rows in `audit.logs`.
