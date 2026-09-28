# Phase 5 — Manager workspace and approvals UX (+ Prompt 6b HR admin parity)

**Prompt:** `docs/hr-portal/prompt-pack.md` §Prompt 5 and the remaining items of §Prompt 6 (regularisation admin, comments & approvals report, invitations parity, holidays & shifts parity), per the implementing brief.
**Branch:** worktree branch `worktree-agent-a07a43320ce00c32d` (from `08ce01c`) · **Migration:** `supabase/migrations/20260928000900_manager_workspace.sql` · **Date:** 2026-09-28.
**Status:** every gate green (§6); nothing applied to the hosted project. Not built here: notifications & reminders (Prompt 8 — templates, preferences, delivery, missing-punch reminder, event retention). The worker's notification `link` / `data` are read, never changed.

## 1. What shipped

### API — the team workspace (`apps/api/src/services/team.service.ts`, `routes/v1/features/team.ts`)
Scope = the caller's direct reports (primary OR secondary manager — `grant.teamEmployeeIds`, the rule of `app.team_employee_ids()`) **and** the key the table's RLS team predicate needs: `attendance.view_team` / `leave.view_team`, or the organisation-wide `attendance.view` / `leave.view` (whose branch scope then applies — an org-wide key alone reaches only reports inside the caller's branches). A crafted id that is not a report (an unrelated employee, an indirect report, oneself) is refused **403 before any read**; everything is read under the caller's RLS (`runUser`), which applies the team predicate again. Only reference data the rows already point at (branch zone and name, department / designation names, the organisation's date) is read in the organisation's system scope.
- `GET /orgs/:orgId/team/summary?date` — one card per reachable report, read in the **report's branch zone** (default: each report's own today): status chip from the pure `teamDayStatus` (`packages/domain/src/attendance/team-today.ts`: present / late / absent / on leave / missing punch / weekly off / holiday / not in yet / not scheduled — engine verdict first, a still-`PENDING` day read from the punches), first in, last out, **live state** IN / OUT / NONE from the day's non-voided normalised events, worked so far (live while checked in, else the engine's minutes), late minutes, flags, approved leave (type, colour, half day + part), primary / secondary relation, **pending items** (what of theirs waits for the caller: requests on the caller's level + reasons the caller reviews) and the totals row.
- `GET /orgs/:orgId/team/attendance?from&to&employeeId&page&pageSize` — the reports' daily records (≤ 62 days, `to ≥ from`), paginated **by report**; a named report hidden by RLS → 404, outside the branch scope of an org-wide key → 403.
- `GET /orgs/:orgId/team/leave?from&to` — approved + pending + info-requested leave of the reports for the month calendar, the **upcoming** list (ending today or later, ≤ 20 — B-62) and the leave requests waiting for the caller.
- `GET /orgs/:orgId/team/pending-counts` → `{ approvals, notes, total }` (any active member). **approvals** = `count(*) from app.approval_actionable_request_ids(org)` — the SQL function `/me.approvals.actionable`, the inbox "Mine" queue and the dashboard already use (no second formula). **notes** = pending reasons of the reports with no live request (the line manager decides those directly) + reasons whose current level seats the caller as the secondary manager standing in, minus any the actionable set already lists (never counted twice). Each half runs on its own (`halfOrZero`): a failure reads **0 with a logged warning** (`team_pending_count_failed`, requestId, organisation, half) and the other half still counts (B-63).
- `GET /attendance/records/:id` (the record dialog) now also opens a **direct report's** record for an `attendance.view_team` holder (team predicate, not a branch grant); every other caller keeps the organisation-wide / own rule.

### Web — `/team` (`apps/web/src/features/team/*`)
Replaces the "coming soon" placeholder. Tabs (each shown only with its key): **Today · Attendance · Leave · Approvals · Delegation**; the Approvals tab carries the pending count. A member without direct reports gets an explanation, not an empty board.
- **Today** (B-61): totals (present incl. late, late, absent, on leave, missing punch, in now), one card per report — status chip, In / Out, worked (live), live-state dot ("In now" / "Checked out" / "No punch yet"), leave badge (half day + part), late by, secondary-manager badge, flags, **pending badge → Approvals tab**, "Open the day" (record dialog). Search (accent-insensitive, name or number) appears when the team is larger than five. Refreshes every minute. Without an attendance key the tab shows the members directory with a note.
- **Attendance**: Month / Day toggle. Month = the 6a HR register's `MonthlyGrid` + legend fed by the team endpoint (register totals: half day = ½ present; late / missing from the flags); Day = a table with pagination; employee picker from the team. The record dialog is read-only unless the caller holds `attendance.correct` ("Request a correction" then opens the Prompt 2 correction dialog; the API decides for which employee).
- **Leave**: pending banner → Approvals, **Upcoming leave** card (hidden when empty — B-62), a month calendar of the team built from the Prompt 7 leave helpers (include-pending switch).
- **Approvals** (B-63…B-65): "Waiting for me" = the Prompt 2 inbox query `scope=mine&view=pending` (≤ 50, more → link to `/approvals`) with the Prompt 2 decision dialog and request panel; **Approve / Reject only on rows the engine lets the caller decide** (`abilities.canDecide`, status `PENDING`). Below it, **Attendance reasons** = Prompt 4's review list (`scope=mine`, open; "show decided" switch) with its actions — approve / reject with pay effect none / half / full / excuse / ask — **only on pending rows the caller may review and that are not HR-oversight rows**; excused-this-year badge; oversight chip; `ATTENDANCE_NOTE` requests are shown once, as reasons (never twice). **All my team** = view-only merge of the team's pending + decided requests (the 50 most recent, B-64).
- **Delegation**: the Prompt 2 delegations panel embedded (extracted from its page as `DelegationsPanel`, the page unchanged) + a link to the page.

### Dashboard widgets (`features/dashboard/model.ts` registry `TEAM_WIDGETS`)
- **Awaiting your approval** (members with reports or an approve key): count = `team/pending-counts.total`, the 5 oldest requests of the "Mine" queue with how long each has waited (link to the request for approvers, to `/team?tab=approvals` for a line manager without an approve key), a "N attendance reasons to review" row. It replaces the rail's old "Pending approvals" card (same data source for its list).
- **Team on leave today** / **Team late today** (reports + an attendance key): read the team summary; a past or future dashboard date reads that date.
- Only the overview / operations rail shows them; the executive layout and every dashboard of a member without reports or approve keys renders exactly as before.

### Topbar chip, sidebar badge, notification routing
- **Chip** next to the bell (managers, approvers, reviewers, anybody with something waiting): `team/pending-counts.total`, refreshed every 60 s and on window focus; tooltip / accessible name split "n approval requests · n attendance reasons"; links to the inbox (approvers), `/team?tab=approvals` (line managers without an approve key, or when only reasons wait), else `/attendance/notes`. Hidden at 0. The bell keeps the unread-notification badge.
- **Sidebar Approvals badge**: `pending-counts.approvals` (the same engine function as `/me.approvals.actionable`, from the chip's cached query — no extra request), falling back to `/me` while loading; decorative, with the count as the link's accessible description. Theme tokens (`bg-destructive` / `text-destructive-foreground`), so every sidebar style shows it.
- **Routing** (`features/notifications/notification-route.ts`, used by the notifications page): an approval notification asking the reader to act → `/approvals?request=<id>` for an approver / delegate, `/team?tab=approvals` for a line manager **without** `attendance.approve` / `leave.approve` (B-66); the subject employee → the matching `/my/*` page (`/my/leave`, `/my/requests?tab=reasons|selfies|regularisations`, `/my/shift`); the worker's `link` is the fallback for any type the table does not know, and unsafe links are ignored. Derived client-side from `type` + `data`; the worker is untouched.

### Prompt 6b — regularisation admin (`/attendance/regularisations`)
`attendance.approve` or `attendance.review_notes`; rows under the caller's RLS (org-wide with branch scope, the team predicate, or one's own). Filters: status, type, date range, branch, department, employee search. Columns: employee, date, type, proposed in / out, reason, status, **current level + approvers** (from the linked approval request), the **applied correction** link (`/corrections?employeeId&from&to`). Row actions and **bulk approve / reject** (≤ 100 selected) go **only through the engine** on the linked request (`decideWithin` / `bulkDecide`): the engine decides who may decide which level (an organisation-wide override must name its level), the regularisation hook applies the outcome; nothing writes a regularisation's status. Per-item authorisation and results (a refusal never stops the others; a results dialog lists them); **reject requires a comment** (client and API). CSV (`report.export`): formula-escaped, ≤ 10 000 rows, 30 exports / organisation / hour, audited with its row count.

### Prompt 6b — comments & approvals report (`/attendance/notes?tab=report`)
A **Report** tab on the Prompt 4 reasons page: one row per reason with employee, date, day status + flags, category, comment, review status + approval request status, reviewed by / via, pay effect, **impact** (paid leave charged — type and days — / loss of pay / excused / none / pending) and the employee's excused count that year. Scope chips all (organisation oversight: `attendance.view` with `review_notes` or `approve`, branch scope applies) / team / mine; filters date range (≤ 366 days), status, category, branch, search; totals. CSV (`report.export`): formula-escaped, ≤ 20 000 rows, quota, audited with its row count.

### Prompt 6b — invitations parity (B-67 … B-71, B-74, B-76)
One rule, the one `inviteMember` already used: **reads `user.view`, writes `user.manage`**.
- `POST /orgs/:orgId/invitations/:id/resend`: revokes the open invitation (reason `resent`, row kept, `replaced_by_id` → successor) and issues a new one through **every** invitation rule again (grantable role, linkable employee, no active member / other open invitation) — a new 7-day token; audited `member.invitation_resent`; the row is locked so two resends never both issue a successor.
- **E-mail delivery** (worker `SEND_INVITATION_EMAIL`, queued with every invitation / resend, payload = ids only): the worker mints the token **at send time** and stores only its sha256 (`invitations.delivery_token_hash`), sends the en / ar e-mail (organisation locale, HTML-escaped), audits `member.invitation_emailed` (provider + message id, never the token); an accepted / revoked / expired invitation is not sent. The inviter's copyable link keeps its own hash; **either token accepts the same single-use invitation** (constant-time comparison over every candidate).
- **Public preview** `POST /api/v1/invitations/validate {token}` (no session; edge-gated; **20 / minute per client IP** through the existing `clientIp` helper): `{ state: valid | accepted | revoked | expired, organizationName, employeeName, emailMasked (a***@e***.com), expiresAt }`; unknown / malformed → 404; nothing is accepted.
- **Revocation keeps the row** (`revoked_at` / `revoked_by` / `revoke_reason`) so a revoked token is reported as revoked; the list, link-clash guard, offboarding and the role-in-use check ignore revoked rows; offboarding now revokes (`employee_left`) instead of deleting.
- **Employee profile → "FlowZa Time access"** card (`GET|POST /employees/:id/portal-access[/invite|/revoke|/restore|/resend]`): state none / invited / active / suspended; **invite** defaults — the work e-mail, else a `personalEmail` custom field; the `employee` role; the employee's own branch; the employee link — older open invitations of the employee or address are superseded (B-68); **revoke** = suspend the linked login **without unlinking** the employee, end its sessions, revoke open invitations (B-74); **restore** re-activates (never while the employee counts as left — B-75); **resend** restores a suspended linked login directly (B-69) or re-issues an open invitation; nobody changes their own access.
- **Web**: Resend (confirm) + "e-mailed" status on the invitations list, a one-time copyable-link dialog; the access card on the employee profile (other people's profiles); the accept page shows the validation result (organisation, employee, masked address, expiry) **before** sign-in, a closed state (accepted → sign-in link, revoked / expired → ask HR) instead of the form, and auto-accept waits for a valid preview.

### Prompt 6b — holidays & shifts parity (ATT-102 … ATT-105)
Verified against the Finance reference (evidence in §3); the one genuine gap — the **monthly roster** (ATT-105) — is built: `/shifts?tab=roster` + `GET /orgs/:orgId/shift-roster?month&branchId&departmentId&search&page&pageSize` (`shift.view`; branch scope via `branchFilter` + RLS). Employees × days of the month, each cell the shift the **engine** resolves (`resolveShift`: employee → team → department → branch → organisation assignments with effective dates, rotation patterns, the attendance policy's default shift), **Off** on weekly-off / rotation-off days (employee → branch → organisation weekly offs), **H** holidays (branch calendar else the organisation default, branch-subset holidays honoured), **L** approved leave, "–" when nothing resolves; days outside employment are blank. Legend with shift colours and times, weekend shading, today highlighted, month navigation, branch / department / search filters, 50 employees per page.

### Database — one migration, idempotent, single-transaction safe (no enum value, no `CONCURRENTLY`)
`20260928000900_manager_workspace.sql` touches **only `invitations`**: `revoked_at`, `revoked_by`, `revoke_reason`, `replaced_by_id`, `delivery_token_hash` (unique partial index), `delivery_sent_at`; CHECK `invitations_revocation_shape` (revocation columns consistent, ≤ 500-char reason, an accepted invitation cannot be revoked); index on open invitations by employee; `invitations.role_id` FK re-created ON DELETE CASCADE (a closed invitation no longer blocks deleting its custom role; `roles.service` still refuses while a member or an OPEN invitation uses it). `lock_timeout 5s`, `statement_timeout 120s`; post-verify block (columns, CHECK, indexes, FK action, RLS still on, `anon` cannot read). No RLS policy changed. `db.ts` regenerated.

## 2. Decisions (Security > Reliability > Data Integrity > Scalability > Maintainability > Performance > UX)
1. **The `/team` menu needs direct reports.** The brief / pack say "reports with a team key, or `attendance.view_team`"; Prompt 1's reviewed rule (and its sidebar test: an owner holding every key but no reports gets no team entry) keeps the relationship mandatory, because the RLS team predicate is relationship-based — a key alone only ever opens an empty workspace. A team attendance / leave key now also opens it (with reports), not only `employee.view_team`. A member without reports who lands on `/team` is told why.
2. **One definition of "waiting for me".** The approvals half is the engine's SQL function itself; the notes half counts only what the engine does not (reasons without a live request; secondary stand-in seats not in the actionable set). The sidebar badge reads the approvals half from the chip's query (same key → one request; fresher than `/me`, which falls back while loading).
3. **Actions only where the server would accept them.** Request buttons follow `abilities.canDecide`; reason buttons follow `canReview` and hide on HR-oversight rows; the API re-checks both (engine seats, notes.service rules), RLS a third time.
4. **Regularisations are decided through the engine only** (Finance's bulk approve bypassed it — ATT §9 quirk not copied); bulk is per-item, never all-or-nothing.
5. **Invitations: soft revocation, worker-minted e-mail token.** Keeping revoked rows is what lets the public preview say "revoked" (B-70); the e-mail token never exists in the database, the queue or a log. Tokens stay ≥ 256-bit random, sha256-stored, 7-day, single-use, bound to the lower-cased address, compared constant-time.
6. **Notification routes are derived client-side** from `type` + `data` (Prompt 8 owns the worker's templates and links).
7. **Reuse over rebuild**: the Prompt 2 inbox query, decision dialog, request panel and delegations panel; the Prompt 4 review list + dialog; the 6a month grid and record dialog; the Prompt 7 leave helpers (the team calendar is local to `/team` so Prompt 7's in-flight review fixes do not collide).
8. **Roster route** is `/orgs/:orgId/shift-roster`: under `/shifts/…` the existing `/shifts/:id` would capture it.
9. **Dashboard**: the rail's approvals card became "Awaiting your approval" (Finance wording) rather than a second approvals card; team widgets live on the rail only.
10. **No new dependencies.**

## 3. Acceptance items
**Appendix B (Finance portal / approvals / roles)**
- [x] **B-61** Team rail → Today tab: direct reports (primary + secondary), search above five, on leave / in presence (live state).
- [x] **B-62** Upcoming leave: approved or pending (incl. info requested) ending today or later, ≤ 20, card hidden when empty.
- [x] **B-63** Badge = my current-level requests (as approver or delegate — the engine's actionable set) + my pending reasons; each half fails to 0 (logged).
- [x] **B-64** Approvals tab: reasons + my assigned requests; "All my team" adds up to 50 recent direct-report requests, view-only.
- [x] **B-65** Approve / reject / ask only on rows assigned to me and pending: a request's rejection needs a comment (the Prompt 2 dialog), a reason's rejection names its pay effect and "ask" needs the question (the Prompt 4 dialog), a regularisation's rejection needs a comment (register, client and API).
- [x] **B-66** Bell routing: a line manager without an approve key → `/team?tab=approvals`; approver → `/approvals?request=<id>`; employee → `/my/*`.
- [x] **B-67** One permission rule for invite / resend / revoke / restore (`user.manage`; Finance's `hrms.portal.manage`), reading `user.view`.
- [x] **B-68** Work e-mail else personal e-mail; older open invitations revoked; hash only; 7 days.
- [x] **B-69** Resending to an already-linked, suspended employee restores access directly.
- [x] **B-70** Validation: organisation + employee names, masked address, expiry, and the accepted / revoked / expired states.
- [x] **B-71** Accept: address must match, token unexpired, single use (re-tested with both tokens of one invitation).
- [x] **B-74** Revoking suspends the login without unlinking the employee (sessions end); restore re-activates.
- [n/a] **B-76** Self-heal from a pending **or expired** invite is not copied: an expired token must stay refused (7-day rule). The FlowZa path: a valid invitation accepts normally; an expired one is reported as expired on the accept page and HR's resend (or restore) brings the person back (B-69).
- (B-72, B-73, B-75 belong to Prompt 1 and still hold; offboarding now revokes open invitations instead of deleting them.)

**Appendix A (Finance HR attendance module)**
- [x] **ATT-70** Own + direct reports (primary / secondary) unless organisation-wide: team endpoints (relationship AND key, crafted ids refused, RLS team predicate), the record dialog via the team predicate.
- [x] **ATT-77** Queue "mine" (mapped reports) on `/team` → Approvals; HR "all" oversight stays on `/attendance/notes` (Prompt 4) and in the report's `all` scope.
- [x] **ATT-78** Rows show day status + flags, excused-this-year count, oversight chip (team queue and report).
- [x] **ATT-86** The same list and actions in the inbox and the team workspace (Prompt 2 inbox + Prompt 4 list); the badge counts pending reasons.
- [x] **ATT-102** Verified: `holiday_calendars` (name, country, `is_default`) + `holidays` (single day or `end_date` range, half day, tentative, branch subset, Arabic name) typed PUBLIC / RELIGIOUS / COMPANY / REGIONAL; branches pick a calendar (`branches.holiday_calendar_id`). Not added: Finance's calendar "year" and "state" (FlowZa calendars are year-less and branch-scoped holidays cover regional ones) and the "restricted" / "optional" holiday types (an employee-choice holiday needs leave-side rules — follow-up). Recurrence: neither system repeats holidays (GCC religious holidays move every year; `is_tentative` covers moon-sighting dates).
- [x] **ATT-103** Verified: the branch calendar else the organisation default drives the engine's holidays, the roster, comp-off and the period summaries.
- [x] **ATT-104** Verified: shifts carry type (fixed / flexible), start / end, grace in / out, breaks, core hours, punch windows, cross-midnight, colour, active status; early-departure and half-day thresholds live on the attendance rule sets (`earlyDepartureThresholdMinutes`, `halfDayThresholdMinutes`); weekly offs employee → branch → organisation. Not added: night allowance (a payroll amount — FlowZa Time is not payroll) and forced upper-case codes (codes are free text; the roster shows them upper-cased).
- [x] **ATT-105** Assignments with effective dates targeting organisation / branch / department / team / employee + rotation patterns (existing); **the monthly roster with Off days — built here**.

## 4. Endpoints
| Method | Path | Gate |
|---|---|---|
| GET | `/api/v1/orgs/:orgId/team/summary?date` | `attendance.view_team` or `attendance.view` (+ reports) |
| GET | `/api/v1/orgs/:orgId/team/attendance?from&to&employeeId&page&pageSize` | same |
| GET | `/api/v1/orgs/:orgId/team/leave?from&to` | `leave.view_team` or `leave.view` |
| GET | `/api/v1/orgs/:orgId/team/pending-counts` | active member |
| GET | `/api/v1/orgs/:orgId/attendance/regularisations` (+ `/export`) | `attendance.approve` or `attendance.review_notes` (+ `report.export` for CSV) |
| POST | `/api/v1/orgs/:orgId/attendance/regularisations/:id/decide` | same; the engine decides the seat (idempotency key) |
| POST | `/api/v1/orgs/:orgId/attendance/regularisations/bulk-decide` | same; per item (≤ 100) |
| GET | `/api/v1/orgs/:orgId/attendance/notes/report` (+ `/export`) | review scope (Prompt 4 rules) (+ `report.export`) |
| GET | `/api/v1/orgs/:orgId/shift-roster?month&branchId&departmentId&search&page&pageSize` | `shift.view` |
| POST | `/api/v1/orgs/:orgId/invitations/:id/resend` | `user.manage` |
| GET | `/api/v1/orgs/:orgId/employees/:id/portal-access` | `user.view` |
| POST | `/api/v1/orgs/:orgId/employees/:id/portal-access/{invite,revoke,restore,resend}` | `user.manage` |
| POST | `/api/v1/invitations/validate` | public, 20 / min / IP |

Changed (backward compatible): `GET /attendance/records/:id` accepts a team-key holder for a direct report; `DELETE /invitations/:id` now revokes (row kept) instead of deleting; invitation DTOs gain `deliverySentAt`.

## 5. Tests added
- **API** (`apps/api`): `test/team-workspace.test.ts` (13 — reports only incl. secondary, org-wide key limited to the caller's branches, keys required, live state + leave, paginated records, crafted non-report / indirect / self refused, range ≤ 62 days, record dialog via the team predicate, leave + upcoming ≤ 20, pending counts = `/me` actionable + reviewable reasons with no double count, assigned-only incl. delegate, halves independent), `test/attendance-admin.test.ts` (7 — register scope, single decision through the engine incl. level-named override, bulk per-item authorisation with engine state agreeing, CSV permission / escaping / audit for both, report rows, crafted id outside the branch), `test/invitations-parity.test.ts` (10 — e-mail job carries no token, resend / validate states / single use / address mismatch, e-mailed token, expiry, per-IP rate limit, revoked row + role deletion, access card suggestions and permissions, invite defaults + supersede, revoke without unlink + sessions + restore + resend-restores, never restore a leaver, no own-access change, address required), `routes/v1/features/roster.test.ts` (3), `test/roles-review.test.ts` (adapted to soft revocation).
- **Worker**: `handlers/members/invitations.test.ts` (token minted at send, hash only, closed invitations skipped, locale).
- **Domain**: `attendance/team-today.test.ts` (status precedence, live state, worked so far).
- **Web**: team page (12 — tabs per key, today cards / totals / search / pending → approvals, attendance month grid + day table, leave upcoming + hidden when empty, approvals mine + actions only when assignable, reasons with Prompt 4 actions / oversight / excused badge, all-my-team view-only, delegation), team model (6), pending chip (3), notification routing matrix (6) + notifications page (2), dashboard widgets (3 new), sidebar (3 new: badge, team keys, regularisations item), regularisation admin + notes report + roster (10), invitations parity (6), accept-page preview (6 new), locale parity en / ar (3).
- **Playwright**: `e2e/team.spec.ts` — a team lead (team keys, no approve key) opens `/team`: the late report's card, the leave card, the chip "1" linking to `/team?tab=approvals`; pending badge → Approvals; rejects the reason with a **half-day** pay effect (the POST body is asserted: `{ decision: 'reject', payEffectDays: 0.5 }`); the queue empties, the chip and the tab count disappear. `e2e/support/mock-backend.ts` gains `teamHandlers()` (stateful), `LINE_MANAGER_PERMISSIONS`, `MANAGER_EMPLOYEE_ID`, `TEAM_NOTE_ID`; `e2e/workspace.spec.ts` follows the renamed card.

## 6. Verification (local Postgres @ 127.0.0.1:54329; shared DB suites under `flock /tmp/flowza-dbtests.lock`)
| Gate | Result |
|---|---|
| `pnpm build:packages` | ✅ |
| `pnpm lint` | ✅ 0 problems |
| `pnpm -r --filter "./apps/*" run typecheck` | ✅ api, web, worker |
| `pnpm test:unit` | ✅ 37 files / 633 tests (contracts 5, shared 4, device-providers 286, domain 318, database 20) |
| `pnpm --filter @flowza/web run test` | ✅ 78 files / 416 tests |
| RLS suites (`flowza_p5_rls`) | ✅ 6 suites, 385 `ok` assertions — "RLS tests passed" (no policy changed) |
| `pnpm test:db` | ✅ 3 files / 15 tests |
| `pnpm --filter @flowza/api run test` | ✅ 33 files / 410 tests (see note) |
| worker `vitest run` | ✅ 18 files / 168 passed, 1 skipped |
| `pnpm -r --filter "./apps/*" run build` | ✅ (Vite's > 700 kB warning predates this phase; §7) |
| `PGDATABASE=flowza_p5_ci2 bash scripts/db-reset-local.sh` | ✅ |
| single-transaction replay (`flowza_p5_tx`) | ✅ every file one transaction; the new migration applied a second time is a no-op |
| `pnpm db:types` (`flowza_p5`) | ✅ no diff (the committed `db.ts` is current) |
| `build:e2e` + `test:e2e` (`/opt/pw-browsers/chromium`, `CI=1`) | ✅ 52 passed (26 scenarios × chromium + tablet) |

Notes: the first full API run failed one **pre-existing** test, `approvals-review.test.ts` › "P2-13 a QUORUM override counts one approval…" (19/19 alone, 410/410 on the rerun). Cause (not touched here): an organisation-wide override fills `open[0]` of the level's pending seats, ordered by `(created_at, id)`; the role-holder seats share one `created_at`, so the tie falls to random uuid order and the override sometimes fills `hrLinked`'s own seat, whose later approval is then a no-op. `CI=1` for Playwright is deliberate: other agents' `vite preview` servers use port 4173 in this container, and without it Playwright silently reuses whatever answers there (a run against another bundle was observed and discarded).

## 7. Known limits / follow-ups
- **Engine stand-in seats** — *corrected by the review (P1-3)*: the original line here understated the gap. The engine's actionable set did not count a secondary manager's stand-in seat (`resolution_path = 'secondary'`) for ANY entity type — leave, corrections, and also regularisations and shift swaps, which the notes half did not cover either, so those stand-in seats were decidable but listed and counted nowhere. **Fixed in `20260928000950`**: `app.approval_actionable_request_ids` counts stand-in seats for every entity type, the notes half no longer carries a special case, and the team Approvals tab, the inbox "Mine" queue, `/me` and the badge all read the one set (see "Review fixes").
- **Team scope follows the CURRENT reporting line, for past dates too (review O1, kept by design)**: when a report moves to another manager, the former manager loses the whole history (summary, records, attendance — including days they managed) and the new manager reads the earlier days. This is `app.team_employee_ids()`'s rule, which every team read and RLS predicate shares; a date-aware rule is possible (`employment_history.manager_employee_id` exists) but changes the RLS team predicate and belongs to a separate, reviewed RLS change.
- **Requests waiting on the employee's answer stay "waiting for you" (review O2, kept by design)**: a request on which an approver asked for more information is still pending on its level — its approvers can withdraw the question or decide at any time — so it stays in the one number (chip, badge, KPI, inbox), consistently on every surface.
- **Record history for line managers**: `attendance_daily_record_history` has no team predicate in its RLS, so the record dialog's history section is empty for a line manager (the day, punches, corrections and marks are visible). Not changed here (RLS change + suite needed).
- **Night shifts on the board**: Today reads each report's calendar day in the branch zone; a shift that started the previous evening shows its punches on the previous date until the next day's first punch.
- **Holidays**: no "restricted" / "optional" holiday types (employee-choice holidays) — ATT-102 follow-up.
- **Personal e-mail** is read from an `employees.custom_fields.personalEmail` value (there is no dedicated column). Since the review (P0-2) neither it nor the work e-mail is ever used by default: they are offered, with who last changed them and when, and the administrator chooses.
- **Web bundle**: the main chunk is 924.9 kB (886.7 kB at `08ce01c`); the +38 kB is mostly the eagerly bundled `team` / `attendance-admin` / `invitation` locale JSON (the pattern every feature uses) — code-splitting the namespaces is the standing follow-up (Prompt 4 report).
- The roster reads a whole month for ≤ 100 employees per page in one request; very large branches page through it.

## 8. Shared files changed (for the integrator)
Registries / indexes: `apps/api/src/routes/v1/features/index.ts` (team, attendance-admin, roster registrations appended), `apps/api/src/app.ts` (public validate route + limiter), `apps/api/src/routes/v1/members.ts`, `apps/worker/src/handlers/index.ts` (members handlers appended), `packages/contracts/src/dto-features/index.ts` (exports appended), `packages/contracts/src/dto/members.ts` (appended section), `packages/database/src/generated/db.ts`, `packages/domain/src/attendance/index.ts`, `apps/web/src/features/routes.tsx`, `apps/web/src/components/layout/sidebar.tsx` (+ test), `apps/web/src/components/layout/topbar.tsx`.
Engines / hooks reused and touched: `apps/web/src/features/approvals/api.ts` (document entities appended to the approval-view invalidation list), `apps/web/src/features/approvals/pages/delegations-page.tsx` (`DelegationsPanel` extracted, page unchanged), `apps/web/src/features/attendance-review/api.ts` (invalidation list appended), `apps/web/src/features/attendance-review/pages/notes-review-page.tsx` (Report tab), `apps/web/src/features/schedule/pages/shifts-page.tsx` (Roster tab), `apps/web/src/features/employees/pages/employee-profile-page.tsx` (access card), `apps/web/src/features/notifications/notifications-page.tsx`, `apps/web/src/features/dashboard/{model.ts,layouts.tsx,dashboard-page.tsx,widgets/approvals-card.tsx}`, `apps/web/src/features/auth/accept-invitation-page.tsx`, `apps/web/src/features/users/{api.ts,components/invitations-tab.tsx}`; API services `members.service.ts`, `members.mappers.ts`, `employees.service.ts`, `offboarding.ts`, `roles.service.ts`, `features/attendance.service.ts` (getRecord).
Locales: `en|ar/team.json` (rewritten — every key of the placeholder kept except its unused `comingSoon` / `comingSoonHint` pair), `en|ar/attendance-admin.json` + `en|ar/invitation.json` (new), `en|ar/dashboard.json` and `en|ar/users.json` (keys appended).
E2E: `apps/web/e2e/support/mock-backend.ts` (team section appended), `apps/web/e2e/workspace.spec.ts` (card title), `apps/web/e2e/team.spec.ts` (new).

## Review fixes (review `docs/hr-portal/reviews/05-manager-workspace-review.md` @ `9df34c4`, fixed from `1b4a026`)
One migration, `supabase/migrations/20260928000950_manager_workspace_review_fixes.sql` (additive, idempotent, one transaction, bounded lock waits, post-verified; `…000900` and earlier untouched). Every test is named after its defect id; every P0 / P1 fix was mutation-checked (fix reverted → its test red → fix restored byte for byte): 17 mutations, 17 red.

| Defect | Fix | Tests |
|---|---|---|
| **P0-1** branch-scoped user admin escapes their scope | ONE member-management rule, `apps/api/src/services/member-authority.ts` `assertMayManageMember`, asked by every members / invitations / access-card write (invite, update, suspend, restore, revoke, resend, delete invitation): (a) nobody changes their own role, branch scope or status; (b) owners are changed by owners, and only an owner grants the owner role; (c) the caller must be able to grant the target's current AND new role; (d) the target's current and new branch scope lie within the caller's. The target's branch ids are read in the organisation's system scope (`membershipBranchIds`), so a caller who cannot read branches does not see a restricted member as "no branches" and pass (d). An invitation that leaves the scope out gets the CALLER's scope (`defaultInviteScope`), never "all branches". Web: own row not editable / suspendable (an owner may still link their own login to their employee record), "All branches" disabled for a scoped admin, the invite dialog defaults to the caller's branches. | api `members-review.test.ts` 5-P0-1 ×5, `core.test.ts`; contracts `organizations.test.ts`; web `member-dialog.test.tsx` ×3, `invite-dialog.test.tsx` ×2, `invitations-parity.test.tsx` (own login) |
| **P0-2** invitation redirected to an address an `employee.update` holder edits | The access card's invite requires an EXPLICIT address (`portalAccessInviteSchema.email`; `{}` → 400). `GET …/portal-access` returns the record's known addresses with provenance (source, when and by whom each field last changed, from the employee audit trail); nothing is preselected; an address changed recently by somebody else carries a warning the admin must confirm; "Another address" is typed. The invitation audit row records the address source (`work` / `personal` / `entered`) and its provenance. | api `members-review.test.ts` 5-P0-2 ×2, `invitations-parity.test.ts`; web `invitations-parity.test.tsx` 5-P0-2 ×2 |
| **P0-3** lower admin suspends / restores / resends an org admin | The same rule, clause (c) on the target's CURRENT role: suspend, restore, revoke, resend and the access card's revoke / restore / resend refuse a target whose role carries permissions the caller lacks — also an open invitation of such a role. | api `members-review.test.ts` 5-P0-3 ×2 |
| **P1-1** register cannot decide an override on an ALL / QUORUM level with several seats | The register (single and bulk) carries the engine's §9.8 seat choice: rows expose `mustChooseSeat` + `pendingSeats`; the page shows "Deciding for" (single) and a per-row seat select (bulk); the API passes `onBehalfOfUserId` to the engine and audits it. | api `attendance-admin.test.ts` 5-P1-1; web `attendance-admin.test.tsx` 5-P1-1 ×3 |
| **P1-2** old invitation unreachable behind 1 000 newer rows | Indexed equality lookup on `token_hash` / `delivery_token_hash` (both uniquely indexed — asserted by the migration's post-verify), then a constant-time confirmation; no newest-N window. | api `members-review.test.ts` 5-P1-2 (1 001 newer rows) |
| **P1-3** stand-in regularisation / shift-swap seats counted and listed nowhere | `app.approval_actionable_request_ids` rewritten: stand-in (`secondary`) seats count for every entity type; the notes half lost its special case. Corrects §7. | api `team-workspace.test.ts` 5-P1-3 ×2; RLS `rls_approvals.sql` 5-P1-3 ×3 |
| **P1-4** roster uses today's placement all month | Each day resolved with the shared per-date working calendar (`loadEmployeeWorkingCalendars`, the resolver of the engine's input loader and leave counting): that date's branch / department / team, shift, weekly offs, branch holiday calendar; branch / department filters apply per day (a branch-B reader never sees the branch-A days). Days carry `branchId`. | api `roster.test.ts` 5-P1-4 (engine agreement asserted per day) |
| **P1-5** role deletion silently revokes an open invitation the deleter cannot read | Usage counted in the organisation's system scope: members and OPEN invitations block deletion (409 with counts); closed invitations are reported, not blocking. | api `members-review.test.ts` 5-P1-5 |
| **P1-6** line-manager attendance notifications land on the manager's own page | The route follows WHOSE day it is: the subject → `/my/attendance?date=…` (the portal page opens that day); a line manager without `attendance.view` → `/team?tab=attendance&employeeId=…&date=…` (the team page honours both params, Day view on that date; a non-report id is dropped with a note); an HR reader → the register. | web `notification-route.test.ts` 5-P1-6 ×3, `team-page.test.tsx` 5-P1-6 ×2, `portal-attendance.test.tsx` 5-P1-6 |
| **O3** one person approved two levels | Four-eyes in the ENGINE: `resolveStepActors` skips anyone who approved an earlier level (a level held only by them falls through to the next rung, event `four_eyes_excluded`); `assessDecider` refuses such a person (own seat, delegate or override); exception approval (bypass) and reassignment refuse them; the worker's escalation never adds them; the actionable set excludes those levels. The organisation owner keeps a LOGGED override (`four_eyes_owner_bypass`). The reviewer's A3 probe is refused. | api `approvals-review.test.ts` 5-O3 ×4; domain `resolve.test.ts` 5-O3 ×4, `evaluate.test.ts`; worker `approvals.test.ts` 5-O3; RLS `rls_approvals.sql` 5-O3 ×3 |
| **P2-1** a delegate's own request waits for them | Actionable set: never a request about the caller (subject, linked employee, co-subjects), never one they filed reached only as a delegate. Null-safe (a request without a subject login is not "about" anybody). | api `team-workspace.test.ts` 5-P2-1; RLS 5-P2-1 |
| **P2-2** secondary manager without a team key reads 0 | The stand-in seat is in the approvals half (the engine set needs no team key). | api `team-workspace.test.ts` 5-P2-2 |
| **P2-3** two pending numbers, one phrase | ONE number (`features/team/waiting.ts` `useWaitingForYou`): `team/pending-counts.total` = actionable requests + reasons with no live request; chip, Approvals badge, dashboard KPI ("Waiting for you") and widget read it. Info-requested requests stay counted (O2). | web `dashboard-page.test.tsx` 5-P2-3, `sidebar.test.tsx` |
| **P2-4** chip at 390 px | Pinned by Playwright at 390 × 844, en + ar, `/` and `/team`, with a count and "99+": no horizontal scroll, every top-bar control on screen. | e2e `team-mobile.spec.ts` 5-P2-4 ×4 |
| **P2-5** `safeLink` lets other origins through | Only same-origin app paths: must start with `/`, never `//`, no backslash or control characters, and must resolve to the same origin. | web `notification-route.test.ts` 5-P2-5 |
| **P2-6** breakdown not pluralised | `chip.approvals_*` / `chip.notes_*` plural keys (Arabic zero / one / two / few / many / other), a zero half omitted. | web `pending-chip.test.tsx` 5-P2-6 (en + ar) |
| **P2-7** validate edge cases | (a) the organisation part is validated as a uuid → 404 like every bad token; (b) every bad token answers the same 404 after the same single indexed lookup; (c) the per-IP limit's dependence on `EDGE_SHARED_SECRET` / `CLIENT_IP_HEADER` documented in `docs/deployment.md` ("Public endpoints and the per-IP limits"). | api `members-review.test.ts` 5-P2-7, `invitations-parity.test.ts`; contracts |
| **P2-8** quota 429 without `Retry-After` | The error handler turns any 429 carrying `retryAfterMs` into `Retry-After` (seconds, ≥ 1) — every quota, not only the rate limiter. | api `error-handler.test.ts` 5-P2-8, `attendance-admin.test.ts` 5-P2-8 |
| **P2-9** one token accepted four times concurrently | Accept claims the invitation with a conditional update (`accepted_at is null and revoked_at is null`); the losers of a race by the same invitee get the same answer (their membership) and write nothing; a later re-accept is 409. | api `members-review.test.ts` 5-P2-9 (4 concurrent accepts → one membership, one audit row) |

### Decisions taken
1. **Nobody changes their own membership, owners included** (403). There is no single-step ownership transfer: an owner promotes another member to owner, who then changes the first. The one self change left is an owner linking their own login to their own employee record.
2. **An invitation with no branch scope gets the caller's scope** — organisation-wide admins keep "all branches" as before; a scoped admin gets exactly their branches.
3. **The member-management rule reads the target's reach in system scope** and the caller's grant from their session, so what a caller cannot read never widens what they may do.
4. **Four-eyes spans every path** (decide, delegate, override, bypass, reassign, escalation, the "waiting for you" set); only the organisation owner may break it, and that is logged. Requests created before this change are protected by the decide-time check (`assessDecider`); their stored seats are not rewritten.
5. **One number for "waiting for you"**, defined once in SQL (approvals) and once in the team service (reasons without a request), consumed by one hook; info-requested requests stay in it (O2).
6. **The accept race is idempotent for the racers only**: a sequential re-accept after success stays 409 (single use).
7. **`validateInvitationSchema.token` is `min(1).max(256)`**: shape errors are no longer 400 — the service answers every bad token with the same 404.
8. **O1 and O2 stay as designed** and are documented in §7.

### Acceptance items after the fixes
| Item | Status |
|---|---|
| **B-61, B-62, B-74** | met (unchanged) |
| **B-63** | met — stand-in seats of every entity type counted (P1-3), a delegate's own request excluded (P2-1), a secondary manager without a team key counted (P2-2) |
| **B-64** | met — "My assigned requests" lists stand-in regularisations and shift swaps (P1-3) |
| **B-65** | met — the register names the seat on ALL / QUORUM overrides (P1-1) |
| **B-66** | met — stand-in items are listed where they are routed (P1-3); attendance notifications route by whose day it is (P1-6) |
| **B-67** | met — one permission AND one member-management rule (branch and role boundaries, no self-change) (P0-1, P0-3) |
| **B-68** | met — explicit, provenance-shown address; older open invitations revoked; hash only; 7 days (P0-2) |
| **B-69** | met — resend on a suspended login restores it, within the member-management rule (P0-3) |
| **B-70 / B-71** | met — indexed lookup, no row window (P1-2); every bad token 404 (P2-7); single use under concurrency (P2-9) |
| **B-76** | n/a by design (unchanged) |
| **ATT-70, ATT-77, ATT-78, ATT-86, ATT-102 … ATT-104** | met (unchanged) |
| **ATT-105** | met — the roster resolves every day from the per-date working calendar (P1-4) |

### Verification of the fixes
| Gate | Result |
|---|---|
| `pnpm build:packages` | ✅ |
| `pnpm lint` | ✅ 0 problems |
| `pnpm -r --filter "./apps/*" run typecheck` | ✅ api, web, worker |
| `pnpm test:unit` | ✅ 41 files / 712 tests (shared 4, contracts 48, device-providers 286, domain 353, database 21) |
| `pnpm --filter @flowza/web run test` | ✅ 83 files / 498 tests |
| RLS suites (`flowza_p5f_rls`) | ✅ 532 `ok` assertions — "RLS tests passed" |
| `pnpm test:db` | ✅ 5 files / 24 tests |
| `pnpm --filter @flowza/api run test` | ✅ 39 files / 514 tests |
| worker `vitest run` | ✅ 21 files / 224 passed, 1 skipped |
| `pnpm -r --filter "./apps/*" run build` | ✅ |
| `PGDATABASE=flowza_p5f_ci2 bash scripts/db-reset-local.sh` | ✅ |
| single-transaction replay (`flowza_p5f_tx`) | ✅ every file one transaction |
| `pnpm db:types` (`flowza_p5f`) | ✅ no diff |
| `build:e2e` + `test:e2e` (`/opt/pw-browsers/chromium`, `CI=1`) | ✅ 72 passed (incl. `team-mobile.spec.ts` 4 × chromium + tablet) |
| Mutation checks (P0 / P1 / O3) | ✅ 17 of 17 red with the fix reverted |

The migration's exclusion is null-safe (`not coalesce((…), false)`): a first draft wrote `not (subject_user_id = me.uid or …)`, which is NULL for a request without a subject login and silently dropped it from everybody's set; the existing RLS test "P2-1 …the inbox queue" caught it, and the post-verify now asserts the null-safe form.

### Open items
- A member-admin role needs `branch.view` to PICK branches in the web dialogs; without it the API still judges scope correctly (system-scope read), but `MemberDto.branchIds` / names display empty.
- The Prompt 4 notes review (`canReview`) does not know about four-eyes; reasons without a live request are single-level, so no second level exists to protect today.
- Requests in flight before this change keep their stored seats; a prior approver seated on a later level is refused at decide time and no longer counted as waiting, but the seat row stays until the level is decided or reassigned.
