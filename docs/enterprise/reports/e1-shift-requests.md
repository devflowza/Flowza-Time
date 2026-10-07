# E1 — Shift change & swap requests (module `shift_requests`)

**Slice:** docs/enterprise/plan.md §5 (`shift_requests`), §6 (`shift_change_requests`), §7 (row `shift_requests`), §9 (double
shifts), §10 (E1). **Builds on:** the foundation commit (migration `20261007000100_enterprise_scheduling_policies.sql`,
`packages/contracts/src/dto-features/shift-requests.ts`, `composeDoubleShift`, `resolvePolicyFor`, the engine input loader).
**Migration added:** none. **New dependencies:** none.

## What shipped

### API (`apps/api`, all under `/api/v1/orgs/:orgId/`)

| Route | Who | What |
|---|---|---|
| `GET /me/shift-changes/options?date` | `shift.request_change` (own employee record) | The organisation's ACTIVE shifts and what the caller works on `date` (`resolveDays`). |
| `POST /me/shift-changes` | `shift.request_change` | File a CHANGE or ADDITIONAL request (201, `ShiftChangeRequestDto`). |
| `GET /me/shift-changes?status` | `shift.request_change` or `attendance.view_own` | The caller's own requests (read under RLS: own rows). |
| `POST /me/shift-changes/:id/cancel` | requester only | Withdraw a pending request (`cancelForEntity`). |
| `GET /shift-change-requests` | `attendance.view` (branch scope) or `attendance.view_team` | HR / manager list, paginated, filters `status`, `kind`, `employeeId`, `branchId`, `from`/`to` (range touches). |

The module gate (foundation) closes `me/shift-changes*`, `me/shift-swaps*` and `shift-change-requests*` when `shift_requests`
is off (403 `FEATURE_DISABLED`, `details.reason = MODULE_DISABLED`). An ADDITIONAL request also needs `advanced_scheduling`
(`requireModuleFor`, same 403). Decisions go through `POST /approvals/:id/decide` (entity `SHIFT_CHANGE`).

Files:
- `services/portal/shift-change.service.ts` — options, filing, own list, withdrawal, HR list.
- `services/portal/shift-change-effects.ts` — row / DTO mapping, shared checks (shift active, period lock, double-shift
  composition, swaps in the range), the approval blocker, what an approval does, rejection / withdrawal, inbox context.
- `services/portal/assignment-split.ts` — the range generalisation of the swap's `placeOneDayShift`: pure `planRangeSplit`
  (delete / trim end / trim start / split) + `runsOf`, and the appliers `placeEmployeeShiftRange` (EMPLOYEE `shift_assignments`)
  and `placeAdditionalShiftRange` (`additional_shift_assignments`). `swap-effects.ts` is unchanged.
- `services/approvals/hooks/shift-changes.ts` — `SHIFT_CHANGE` hook (`approvePermission: shift.assign`,
  `viewPermission: attendance.view`, `managePermission: shift.manage`), registered in `hooks/index.ts`.
- `routes/v1/portal-attendance.ts` — the five routes.
- `services/portal/regularisations.service.ts` — policy regularisation limits (below).

### Filing rules (`POST /me/shift-changes`)
1. Caller = own employee (`portalSelf`), employee locked (`pg_advisory_xact_lock`, scope `shift-change`).
2. Dates must exist (`2026-02-30` → 400); `fromDate` ≥ today (employee's branch timezone) and ≤ today + `SHIFT_CHANGE_AHEAD_DAYS`
   (180); range ≤ `SHIFT_CHANGE_MAX_DAYS` (92, checked before any day is enumerated); not before the joining date; employed
   through the last day.
3. Requested shift exists and is `active`.
4. At least one working day (shift, not off / holiday / leave) in the range.
5. CHANGE: refused when the requested shift is already the shift of every working day; refused (409 `SWAP_IN_RANGE`) when a
   pending or approved swap of the employee falls in the range.
6. ADDITIONAL: the requested shift must be FIXED; `composeDoubleShift(day shift, requested)` must succeed on every working day,
   else 400 `VALIDATION_ERROR` with `details.reason = DOUBLE_SHIFT_CONFLICT`, `details.conflicts` = first 5 `{ date, reason }`
   (`OVERLAP` / `NOT_FIXED` / `TOO_LONG` / `SAME_SHIFT`) and the dates in the message.
7. A pending request of the same kind overlapping → 409 `PENDING_OVERLAP` (the exclusion constraint's 23P01 is mapped to the
   same answer).
8. Any day in a locked period → 409 `PERIOD_LOCKED`.
9. Insert in the system step; `submit()` entity `SHIFT_CHANGE`, `noWorkflow: MANAGER`, branch = branch effective on
   `fromDate`, department, `units` = number of days (workflow tiers); secondary manager seated like swaps;
   `approval_request_id` stored; audit `shift.change_requested`.

### Approval (`SHIFT_CHANGE` hook)
- `approvalBlocker`: the employee is no longer an employee / no longer employed on `fromDate` → the engine rejects the request
  BY THE SYSTEM with that reason (409 `SYSTEM_REJECTED` to the decider, row `rejected`, `decided_by` null).
- `onApproved` re-validates and refuses with 409 — the request stays PENDING — when: `shift_requests` (and for ADDITIONAL
  `advanced_scheduling`) is off; the requested shift is no longer active (`SHIFT_INACTIVE`) or no longer fixed; a day is locked
  (`PERIOD_LOCKED`); a swap was approved in the range since filing (CHANGE, `SWAP_IN_RANGE`); no working day remains; the
  ADDITIONAL shift no longer combines (`DOUBLE_SHIFT_CONFLICT`).
- CHANGE → EMPLOYEE `shift_assignments` for `[fromDate, toDate + 1)`, splitting / trimming the employee's own assignments.
  ADDITIONAL → one `additional_shift_assignments` row for the range with `shift_change_request_id`, trimming / splitting any
  overlapping additional assignment. Row `approved`, `applied_assignment_ids`, `decided_by/at`, `decision_note`; audit
  `shift.change_applied` (with every touched row); `RECOMPUTE_DAILY` (reason `SHIFT_CHANGE`) for every day ≤ today (org date).
- `onRejected` / `onCancelled` → status. `loadContexts` → `ApprovalContextDto` `{ kind: 'SHIFT_CHANGE', summary, change: {…} }`;
  `summary()` for notifications. No new notification key: the engine's generic `approval.pending` / `approval.decided` are
  used; the notice facts carry the range (contracts `approvalContextFacts`, worker `approvalEntityFacts`).

### Regularisation limits (attendance policy, plan §4)
`submitRegularisation` resolves the policy of the regularised day with `resolvePolicyFor` (branch and department effective on
the day from employment history, the day's primary shift — else its additional shift) and enforces
`policy.regularisation.backdateDays` (date ≥ today − N) and `maxPerMonth` (non-cancelled regularisations of the employee whose
date is in that calendar month). Both → `VALIDATION_ERROR` with `details.reason` `REGULARISATION_TOO_OLD` /
`REGULARISATION_LIMIT`. Stored policies apply whatever the module state (plan §4.8; the test org has no
`attendance_policies`). A date that does not exist is now a 400 instead of reaching SQL.

### Web (`apps/web`; every string in en + ar, new namespace `shift-requests`)
- `features/shift-requests/` — `api.ts` (portal hooks under the `self-service` entity so inbox decisions refresh them; HR list
  hook), `i18n.ts`, components: `shift-change-dialog.tsx` (kind CHANGE / ADDITIONAL — ADDITIONAL only with
  `advanced_scheduling`, only FIXED shifts offered for it —, date range with client checks mirroring the API, shift picker from
  `/me/shift-changes/options` with the current shift, reason), `shift-changes-table.tsx` (status + withdraw),
  `shift-requests-tab.tsx` (HR list with status / kind / employee / date filters, a link per row to
  `/approvals/requests/:id` and to the inbox), `approval-context.tsx`, `parts.tsx` (badges, range, shifts text).
- Portal **My shift**: with `shift_requests` off the swap button, the change button and both tables are hidden and the request
  endpoints are never called; with it on, "Request a shift change", "My shift change requests", and a badge on upcoming days
  covered by a pending change or an approved additional shift. **My requests**: the swaps tab only with the module.
- **Approvals inbox**: `SHIFT_CHANGE` context (kind, range, current → requested / "Adds …", reason) and icon.
- **Shifts page**: "Shift requests" tab when `shift_requests` is on and the member holds `attendance.view`.
- Notification links: `SHIFT_CHANGE` notices open `/my/shift` for the employee.

## Decisions (priority order of AGENTS.md)
1. **Rotation rest days are preserved (data integrity).** A CHANGE over a range that contains rest days of the employee's
   rotation pattern is applied in runs around those days (one EMPLOYEE assignment per run), so a fixed shift never turns a
   rest day into a working day. Without rest days in the range — the usual case — it is exactly ONE assignment, as specified.
   `applied_assignment_ids` holds every row written. ADDITIONAL is always one row (on a day without a shift the day stays off).
2. **Swaps are never silently overwritten (data integrity).** A CHANGE over a day with a pending / approved swap is refused at
   filing; a swap approved after filing refuses the CHANGE approval (409, pending). ADDITIONAL is not concerned. A pending swap
   needs no extra rule: its own approval re-validates the day's shift.
3. **Module gating at approval too.** Applying a change needs `shift_requests` (and `advanced_scheduling` for ADDITIONAL) at
   approval time (403 `FEATURE_DISABLED`, the request stays pending and can still be rejected or withdrawn). Swaps were left as
   they are.
4. **`swap-effects.ts` untouched.** The range helper is a new file with its own audit vocabulary
   (`ends_before_change`, …); refactoring the swap onto it would change its audit trail for no functional gain.
5. **Regularisation limits answer 400.** The brief says "422 VALIDATION_ERROR"; in this codebase `VALIDATION_ERROR` maps to 400
   (`@flowza/shared` `HTTP_STATUS`), so the stable code is kept and the status follows it.
6. **HR list = attendance.view OR attendance.view_team, rows decided by RLS** (like the regularisation register); the
   `branchId` filter is checked against the caller's scope (403 outside it).
7. **New web namespace** (`shift-requests`) instead of adding keys to `portal-attendance` / `schedule` / `attendance-review`:
   no conflicts with the parallel slices; a parity test guards en / ar keys and variables.
8. **`current_shift_id`** is the shift of `fromDate` when filed (as the column comment says), null when that day has none.

## Files touched outside the slice's own files
- `packages/contracts/src/dto-features/approvals.ts` — the `SHIFT_CHANGE` context variant only.
- `packages/contracts/src/notifications/catalogue.ts` (+ test) — `approvalContextFacts` case for `SHIFT_CHANGE`.
- `apps/worker/src/handlers/approvals/facts.ts` (+ new `facts.test.ts`) — notice facts (range) for `SHIFT_CHANGE`.
- `apps/web/src/features/approvals/components/parts.tsx` — context + icon.
- `apps/web/src/features/schedule/pages/shifts-page.tsx` — the gated tab (shared file, minimal).
- `apps/web/src/features/notifications/notification-route.ts` (+ test) — `SHIFT_CHANGE` → `/my/shift`.
- `apps/web/src/features/portal/pages/requests-page.tsx` — swaps tab gated by the module.

## Test evidence
- `apps/api/src/routes/v1/portal-shift-changes.test.ts` (24 tests): module off → 403 on `/me/shift-changes*`, `/me/shift-swaps*`,
  `/shift-change-requests`; ADDITIONAL needs `advanced_scheduling`; options; validations (past, too far, too long, inverted,
  impossible dates, inactive / unknown shift, same shift, flexible additional, overlap composition, locked period); CHANGE happy
  path (routed to the line manager, pending overlap 409, inbox context, the requester cannot decide, approval splits the
  assignment, `GET /shifts/resolve` inside / outside the range, `GET /me/shift`, audit, no recompute for future days); a change
  starting today recomputes today; ADDITIONAL → `additional_shift_assignments` row → `loadDailyInputs` composes the day and the
  engine flags `DOUBLE_SHIFT`; withdrawal; rejection; re-validation 409 keeps the request pending; system rejection when the
  employee leaves; swaps in the range (filing and approval); HR list (filters, branch-scoped user sees branch B only, 403 for
  another branch, line manager sees the team only, employee 403); regularisation limits (backdate, monthly limit with cancelled
  requests excluded, no limits, impossible date).
- `apps/api/src/services/portal/assignment-split.test.ts` (8, pure) and `assignment-split.db.test.ts` (6, real schema in the
  system context: split, overlapping second range, same bounds, rotation kept on both sides, additional split keeping the
  request link, exclusion constraint).
- `apps/web/src/features/shift-requests/shift-requests.test.tsx` (10): swap / change UI hidden and endpoints not called when the
  module is off; requests page without the swaps tab; list + badges + the dialog files a request; client-side checks; ADDITIONAL
  only with `advanced_scheduling` and only fixed shifts; approvals context (change / additional); Shifts page HR tab with links,
  hidden without the module or `attendance.view`; locale parity.
- `apps/worker/src/handlers/approvals/facts.test.ts` (2), contracts `catalogue.test.ts` (+1 assertion), web
  `notification-route.test.ts` (+1 assertion).

Gate results (worktree, 2026-10-07):

| Gate | Result |
|---|---|
| `pnpm build:packages` | exit 0 |
| `pnpm lint` | exit 0 (0 warnings) |
| `pnpm -r --filter "./apps/*" run typecheck` | exit 0 (api, web, worker) |
| `pnpm test:unit` | shared 4, contracts 73, domain 403, device-providers 454, database 24 — all passed |
| `pnpm --filter @flowza/api run test` | 60 files, 745 tests passed |
| `pnpm --filter @flowza/worker run test` | 28 files, 291 passed, 1 skipped (pre-existing) |
| `pnpm --filter @flowza/web run test` | 119 files, 716 tests passed |

## Known limits / follow-ups
- A CHANGE approved on days that already carry an ADDITIONAL shift does not re-check the composition with the new primary
  shift; the engine falls back to the primary shift alone for a combination that no longer works (plan §9).
- The swap service does not (yet) refuse a swap on a day covered by a pending CHANGE; the CHANGE approval then refuses with
  `SWAP_IN_RANGE` once the swap is approved (no silent overwrite either way).
- The portal home "pending" strip counts swaps, not shift change requests (the overview DTO is outside this slice).
- Per-segment lateness of a double shift is E4 (plan §4.5).
