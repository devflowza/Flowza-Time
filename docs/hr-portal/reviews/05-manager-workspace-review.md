# Review: Prompt 5 (manager workspace) + Prompt 6b (HR admin parity), FlowZa Time @ `9072934`

I reset the review worktree to `9072934` from a clean tree and committed nothing. I used the databases `flowza_rev5` (seeded), `flowza_rev5_rls`, `flowza_rev5_ci2` and `flowza_rev5_tx`, plus per-file databases that the API features harness creates for each probe.

The probes were:
- throwaway vitest files `apps/api/src/test/rev5-probes-*.test.ts` (9 files);
- one Playwright spec, `apps/web/e2e/rev5-probe.spec.ts`, run against the e2e mock backend at 390 px;
- a script that runs the web notification resolver over the notification catalogue.

Evidence is in `scratchpad/rev5/`: `rev5-evidence-*.jsonl`, `rev5-notif-routing.out` and the gate logs `rev5-gate-*.log`. I deleted every throwaway file afterwards, and `git status --porcelain` is empty.

**Summary: 3 P0 (security), 6 P1 (functional), 9 P2 (minor).**
- **Team scope** (the priority) held under every probe.
- **Security:** all three defects sit on the user-administration boundary:
  - a branch-scoped `user.manage` holder can give themselves, and anyone they invite, all branches;
  - an `employee.update` holder can point an employee's portal invitation at their own mailbox and take over that employee's login;
  - a lower user admin can suspend and restore an org admin through the new access card.
- **Functional:** the main gaps are:
  - no seat choice in the regularisation register;
  - a 1 000-row window on invitation lookup;
  - secondary-manager stand-in seats that appear in no queue;
  - a roster that ignores placement history;
  - role deletion that silently removes open invitations;
  - manager notifications that open the manager's own attendance page.

## 1. Gates

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` + `pnpm build:packages` | OK |
| `pnpm lint` | 0 problems (`--max-warnings 0`, exit 0) |
| typecheck (api, web, worker) | OK |
| `pnpm test:unit` | 39 files / 676 tests pass (shared 1/4, contracts 3/43, device-providers 9/286, domain 24/323, database 2/20) |
| web `vitest run` | 80 files / 437 tests: 436 pass, 1 fails. The failure is the timing assertion in `monthly-grid.test.tsx` (4 762 ms against a 4 000 ms limit, while other agents shared the 4 cores). Run alone, the file passes (2/2). It is a timing flake that predates Prompt 5, not a regression. |
| RLS (`flowza_rev5_rls`, under the lock) | 7 suites, 464 `ok` notices, 0 `not ok` / ERROR lines, "RLS tests passed" |
| `pnpm test:db` (under the lock) | 3 files / 15 tests |
| API `vitest run` | 34 files / 442 tests |
| worker `vitest run` (under the lock) | 20 files: 218 pass, 1 skipped |
| `pnpm -r --filter "./apps/*" run build` | OK. Main chunk 952.33 kB (gzip 285.95 kB); Vite's > 700 kB warning was already there. |
| fresh replay on `flowza_rev5_ci2` | OK: every migration through `20260928001000` |
| seeded reset of `flowza_rev5` | OK: 500 employees, 14 915 daily records |
| second apply of `20260928000900` on the seeded `flowza_rev5` (`psql -1`) | OK and idempotent: 19 `invitations` columns before and after, FK `confdeltype = c` |
| single-transaction replay on `flowza_rev5_tx` | OK: the 14 files above the floor each ran as one transaction, `000900` included |
| `pnpm db:types` + `git diff --exit-code` | 99 tables introspected, no diff (file restored) |
| `build:e2e` + Playwright (`CI=1`, `/opt/pw-browsers/chromium`) | 54 passed (55.8 s) |

## 2. Defects

### P0: security

**P0-1: A branch-scoped `user.manage` holder can escape their branch scope, both by giving themselves all branches and by issuing invitations with `allBranches: true`.**

Where:
- `apps/api/src/services/members.service.ts:215` (`createInvitation`) and `:256` (`inviteMember`) check only `input.branchIds` against the grant; `allBranches` is never checked.
- `members.service.ts:372` and `:385` (`updateMember`): `nextAll = input.allBranches ?? …`, with no scope check and no guard against changing one's own membership.
- `apps/api/src/services/portal-access.service.ts:87-88` and `:96`: the new access-card invite takes `allBranches` from the request body.
- `packages/contracts/src/organizations.ts:361`: `inviteMemberSchema.allBranches` defaults to `true`.

Probe (`rev5-probes-inv`, I5). The caller holds a custom role `user_admin_b` (user.view, user.manage, employee.view, employee.update, dashboard.view) with a membership scoped to branch B.

| Request | Result |
|---|---|
| `POST /invitations {roleId: own role, allBranches: true}` | **201**, `allBranches: true, branchIds: []` |
| `POST /employees/:id/portal-access/invite {allBranches: true, roleId: own role}` (branch-B employee) | **201**, invitation `allBranches: true` |
| `PATCH /members/:ownMembershipId {allBranches: true}` | **200**; `/me` then shows `allBranches: true` |
| control: branch A in `branchIds` | 403 "This branch is outside your access scope." |
| control: org_admin role | 403 |
| control: owner role | 403 |

Origin:
- `PATCH /members` and `POST /invitations` behave the same way at `1dc82a9` (`members.service.ts:109-111`, `209-224`), so this is already in production.
- Prompt 6b adds a third path: the access card.

Fix:
- When `!grant.allBranches`, refuse `allBranches: true` with a 403. Require every branch to be inside the grant in `createInvitation`, `updateMember`, `invitePortalAccess` and the resend re-issue.
- Refuse any change to one's own membership (role, scope, status), as `assertMayChange` already does for the access card.
- Default `inviteMemberSchema.allBranches` to `false`.

**P0-2: An `employee.update` holder can redirect an employee's FlowZa Time invitation to their own mailbox and take over the employee's portal login.**

Where:
- `portal-access.service.ts:37-43`: `suggestedEmailOf` returns the work e-mail, else `customFields.personalEmail` or `personal_email`.
- `portal-access.service.ts:85`: `email = input.email ?? suggestedEmailOf(...)`.
- Web `features/users/components/portal-access-card.tsx:27` and `:42`: the dialog pre-fills that address with the hint "From the work email" or "From the personal email", and nothing about who last changed it.

Probe, end to end (`rev5-probes-inv`, I6):
1. An hr_user (employee.update, no user.* key) sends `PATCH /employees/:eV {customFields.personalEmail: attacker@evil.test}` → 200.
2. The owner's access card now shows `suggestedEmail: attacker@evil.test, source: personal`.
3. The owner clicks Invite, which sends `POST …/portal-access/invite {}` → 201, `email: attacker@evil.test, employeeId: eV`. The worker e-mails the link to the invitation's own address (`apps/worker/src/handlers/members/index.ts:55`, `to: inv.email`).
4. The attacker signs in as attacker@evil.test and accepts → 200.
5. `/me` is now linked to eV with the employee role, and `GET /me/profile` → 200 "Employee 50".

The audit trail reads employee.updated (hr_user), member.invited (owner), member.invitation_accepted (attacker). Nothing in it flags where the address came from.

The same works through the work e-mail (`rev5-probes-inv5`, W2):
- hr_user sends `PATCH /employees/:id {email: attacker2@evil.test}` → 200.
- The card now suggests that address with source **work**, which looks legitimate.
- The default invite → 201 to attacker2@evil.test.

Fix:
- Do not default the invitation address from fields that people without `user.manage` can edit.
- Otherwise, make the admin confirm the address, showing its provenance (who changed it, and when).
- Or restrict e-mail and personal-e-mail edits on employees without a login to `user.manage` holders.
- Record the address source on the invitation, and notify the previous address.

**P0-3: A lower user admin can suspend and restore the login of a more privileged member (an org_admin) through the access card, and "resend" restores it too.**

Where:
- `portal-access.service.ts:102-106`: `assertMayChange` protects only owners and oneself.
- `portal-access.service.ts:133-143` (`restoreWithin`) and `:152-158` (resend → restore).
- The same gap already exists in `members.service.ts` `updateMember` / `suspendMember` (`1dc82a9:219`).

Probe (`rev5-probes-inv2`, I11). The caller has `user_admin_b` scoped to branch B; the org_admin's login is linked to a branch-B employee.

| Request | Result |
|---|---|
| access card GET | 200, role "Organisation Admin" |
| revoke | 200, membership **suspended** (sessions ended) |
| restore | 200, **active** |
| resend, after a DB-level suspension (standing in for an owner's decision) | 200, `action: restored`, **active** |
| members API suspend / re-activate | 200 / 200 (already so in production) |
| control: a branch-A employee | 404 |
| control: the org_admin changing their own access | 409 |

Fix: apply one "may manage this member" rule to `updateMember`, `suspendMember` and the access card:
- the caller must be able to grant the target's role (`assertRoleGrantable` against the target's role);
- the target's branch scope must sit within the caller's.

### P1: functional

**P1-1: The regularisation register cannot decide an organisation-wide override on an ALL or QUORUM level that has more than one waiting seat. The §9.8 seat choice is missing.**

Where:
- `packages/contracts/src/dto-features/attendance-admin.ts:79-84`: the decide schema has no `onBehalfOfUserId`, and zod strips the field.
- `attendance-admin.ts:89-94`: bulk items carry only `{id, stepNo}`.
- `attendance-admin.ts:50-63`: `RegularisationApprovalDto` has no `mustChooseSeat` or `pendingSeats`.
- `apps/api/src/services/attendance/regularisations-admin.service.ts:172-174` and `:200` never pass a seat to the engine.
- Web `features/attendance-admin/pages/regularisations-page.tsx:44` and `:50` send `{id, decision, comment, stepNo}` and have no "Deciding for" control.

Probe (`rev5-probes-admin`, R1). A REGULARISATION workflow with one ROLE level (hr_admin, mode ALL) seats hrAdmin and hr2.
- The register row, for both owner and org_admin, shows `canDecide: true, decideVia: override`.
- The inbox detail of the same request shows `mustChooseSeat: true` and two `pendingSeats`.
- The owner decides through the register → **400** "Choose which approver you are deciding for: this level needs every approver and 2 are still waiting…" (issue path `onBehalfOfUserId`).
- The same request with `onBehalfOfUserId` in the body → the same 400, because the field is stripped.
- org_admin through bulk → the item comes back `ok: false`, VALIDATION_ERROR.
- Control: `POST /approvals/:id/decide {…, onBehalfOfUserId}` → 200.

Fix:
- Add `onBehalfOfUserId` to the single and bulk-item schemas, and pass it to `decideWithin` and `bulkDecide`.
- Expose `mustChooseSeat` and `pendingSeats` on `RegularisationApprovalDto`.
- Reuse Prompt 2's "Deciding for" select in the dialog: per row in bulk, or refuse such rows up front.

**P1-2: An open invitation can no longer be validated or accepted once its organisation has 1 000 newer invitation rows.**

Where: `members.service.ts:183-184` (validate) and `:331-332` (accept) both read `.where(org).orderBy('createdAt','desc').limit(1000)` and only then compare hashes.

Probe (`rev5-probes-inv`, I8):
- An open invitation validates as `valid`.
- After 1 000 newer rows are added: validate → **404**, accept → **404** "Invitation not found."
- At that point the row is still open: `acceptedAt` null, `revokedAt` null, not yet expired.

Origin:
- The accept window already existed at `1dc82a9`.
- Prompt 6b now keeps every revoked, resent and superseded row, and puts the public validate on the same window.
- Bulk onboarding at a large tenant fills 1 000 rows.

Fix:
- Look the row up by an indexed equality on the hash: `token_hash = $h or delivery_token_hash = $h`. `delivery_token_hash` already has a unique index; add one on `token_hash`.
- Then compare in constant time on that one row.

**P1-3: A secondary manager's stand-in seat on a regularisation (and, by the same code, a shift swap) can be decided, but appears in no count and no queue.**

Where:
- `supabase/migrations/20260928000800_approval_engine_v2_review_fixes.sql:111-132`: `app.approval_actionable_request_ids` keeps a `via_delegation_of` row only while a delegation to the caller is in force.
- Stand-in rows carry `via_delegation_of = primary` and `resolution_path = 'secondary'` (`apps/api/src/services/portal/line-manager.ts:33`), with no delegation behind them, so they are dropped.
- `apps/api/src/services/team.service.ts:140-148`: the notes half adds stand-ins back only for `ATTENDANCE_NOTE`.

Probe (`rev5-probes-team`, C3). u6's primary manager is mgr9 and the secondary is lm; the request seats mgr9 (primary) and lm (secondary, via mgr9).
- lm: pending-counts `{2,0,2}`, `/me` 2, inbox 2. None of these include the regularisation.
- The request detail shows `canDecide: true, decideVia: actor`, and the register row shows `canDecide: true`.
- lm decides → 200, APPROVED.

Effect:
- The sidebar badge, the chip, the dashboard widget, `/me`, the inbox "Mine" queue and the team tab's "Waiting for me" all leave it out.
- The stand-in does receive an `approval.pending` notification (`line-manager.ts:35`). For a line manager without an approve key, it routes to `/team?tab=approvals` (see the resolver matrix), where the item is not listed.

The report's §7 records this limit for "non-reason entities such as leave", which gets the scope wrong. Leave never seats a stand-in: `seatSecondaryManager` is called only for notes (`notes.service.ts:91`), regularisations (`regularisations.service.ts:84`) and shift swaps (`shift.service.ts:158`).

Fix: either
- count pending rows with `resolution_path = 'secondary'` as the caller's own seats in `app.approval_actionable_request_ids`, then drop the notes-half special case; or
- until the engine owner changes that function, extend the notes half to REGULARISATION and SHIFT_SWAP.

**P1-4: The roster shows the shift for the employee's current placement on every day of the month, while the engine resolves each day from employment history.**

Where:
- `apps/api/src/services/features/roster.service.ts:78-86` takes today's `e.branchId` / `e.departmentId` for the weekly off, the holiday calendar, the branch-subset holidays and the `resolveShift` scope.
- The engine (`packages/database/src/attendance/load-inputs.ts:150-157`) uses `historyOn(history, date)` for each day.

Probe (`rev5-probes-admin`, S2). The employee is in branch A until 15 Sep and branch B from 16 Sep; the branch shifts are SA and SB.

| Day | Roster cell | Engine (`loadDailyInputs`) |
|---|---|---|
| 1 Sep | **SB** | A / SA |
| 15 Sep | **SB** | A / SA |
| 16 Sep | SB | B / SB |
| 30 Sep | SB | not queried |

Fix:
- Resolve each date's branch and department from employment history, as the engine does (load the page's history once). The weekly off, calendar and holidays then follow.
- Apply the branch filter per day as well.

**P1-5: Deleting a custom role silently deletes an open invitation when the person deleting cannot read invitations.**

Where:
- `apps/api/src/services/roles.service.ts:87-89`: the in-use count runs under the caller's RLS, and invitations need `user.view` to be visible.
- `supabase/migrations/20260928000900_manager_workspace.sql:58-66`: `invitations.role_id` is `ON DELETE CASCADE`.

Probe (`rev5-probes-inv`, I7). The caller holds a role with only role.manage and dashboard.view.
1. A role is created, and the owner invites someone with it (the invitation stays open).
2. The role admin sends `DELETE /roles/:id` → **204**.
3. The open invitation row is gone, and validate → 404.
4. The only audit row is `role.deleted`.

Control: the owner doing the same delete while an invitation is open → 409, so the guard works when the caller can see invitations. The migration comment says "roles.service still refuses while a member or an OPEN invitation uses the role"; for this caller, it does not.

Fix: run the in-use counts in system scope (or through a SECURITY DEFINER helper), or make deletion fail (trigger) while an open invitation references the role, and audit every invitation a cascade removes.

**P1-6: Attendance notifications meant for line managers send a manager on the system Line Manager role to their own attendance page.**

Where:
- `apps/web/src/features/notifications/notification-route.ts:58-78` re-routes only approval types and `attendance.note_submitted`; every other type follows the worker's link.
- `apps/web/src/features/attendance/routes.tsx:13`: `/attendance` requires `attendance.view` and sets `selfServiceTo="/my/attendance"`.
- `components/layout/protected-route.tsx:28`: the redirect also drops the query string.

Probe: the resolver matrix in `rev5-notif-routing.out`, with recipients taken from `apps/worker/src/handlers/notifications/outbox.ts:34` and `:55-56` and from `apps/api/src/services/portal/punch.service.ts:252` and `:274`:

| Notification | Recipients |
|---|---|
| `attendance.punch_flagged` | line managers |
| `attendance.unexcused_marked` | managers holding `attendance.approve` |
| `attendance.correction_approved` / `rejected` | holders of `attendance.correct` |

For approver readers and line-manager-only readers alike, all four resolve to `/attendance?employeeId=<report>`, with `&date=…` added for the punch and correction types. The live system `manager` role holds `attendance.approve`, `attendance.correct` and `attendance.view_team`, but **not** `attendance.view` (DB query on `flowza_rev5`). The route guard therefore redirects the manager to `/my/attendance`: their own record, not the report's.

Fix: for readers without `attendance.view`, route these types to the team workspace (for example `/team?tab=attendance&employeeId=…&date=…`, or the record dialog). Alternatively, let `/attendance` accept `attendance.view_team` for a report's row.

### P2: minor

**P2-1: A delegate's own request is counted and listed as waiting for them.**
- Cause: the shared SQL function (see P1-3) returns the delegate's seat even on a request whose subject is the delegate.
- Probe (A2): lmlite, a delegate of hrAdmin, files their own leave; the default level seats hrAdmin. lmlite's counts go 3 → **4**, `/me` shows 4, and the inbox shows 4, their own request among them. The detail shows `canDecide: false`, and a decide attempt → 403 "Self-approval is not permitted: this request is about you."
- Segregation of duties holds; only the count and the list are wrong.
- Fix: exclude requests whose subject is the caller in `app.approval_actionable_request_ids`.

**P2-2: A secondary manager whose role carries no team key can review a stand-in reason that their badge counts as 0.**
- Cause: `team.service.ts:140-148` joins `attendance_notes` under the caller's RLS, which hides the report's notes from someone without a team key.
- Probe (K2): seats are prim (primary) and sec (secondary, role `employee`).
  - sec: counts `{0,0,0}`, `/me` 0, inbox 0.
  - `GET /attendance/notes?scope=mine&open=true` → 1 row with `canReview: true`.
  - The review → 200.
- Fix: read the stand-in rows in system scope, restricted to `a.user_id = caller`; the seat itself is the authorisation.

**P2-3: The same screen shows two different pending numbers, and the same phrase stands for two different numbers.**
- The Operations dashboard KPI tile (`features/dashboard/layouts.tsx:74` and `:141`) shows `dashboard/summary.pendingApprovals`, which is the approvals half only.
- The rail widget on the same screen (`:97`, and `widgets/approvals-card.tsx:24`) shows `pending-counts.total`.
- Probe (K1): the KPI shows **1** while the rail and the chip show **2** (1 request + 1 reason).
- The sidebar badge shows the approvals half (`components/layout/sidebar.tsx:79`), but its accessible description reuses `team:chip.label` (`:173`). The badge is therefore described as "1 item waiting for you" while the chip reads "2 items waiting for you".
- Fix: label the KPI "Approval requests" (or show the total), and give the badge its own string.

**P2-4: At 390 px the chip widens a topbar that already overflows, pushing the bell and the account menu further off-screen.**
- Where: `components/layout/topbar.tsx:57` and `:62`.
- Probe (Playwright, 390×844), document scroll width:

| State | en | ar |
|---|---|---|
| without the chip (control) | 464 px | 453 px |
| with the chip | **519 px** | **508 px** |
| chip at 99+ | **539 px** | **528 px** |

  The control overflow already existed before Prompt 5.
- Elements outside the viewport (en): the right cluster `div.flex … ms-auto lg:ms-0` spans 213–519; the chip sits at 392–443, the bell at 447–483, the account menu at 487–519.
- Fix: below `sm`, collapse the chip to an icon badge, or move the language and theme buttons into the account menu.

**P2-5: `safeLink` lets through paths that browsers resolve to another origin.**
- Where: `notification-route.ts:56`.
- It accepts `/\evil.com`, `/\/evil.com` and `/\t/evil.com`. Resolved by the WHATWG URL parser against `https://time.flowza.ai/notifications`, each becomes **`https://evil.com/`**, and `notifications-page.tsx:33` renders the result as `<a href>`.
- Correctly refused: `//evil.com`, `javascript:`, `JavaScript:`, `https://evil.com`, `" /x"`, `"\t//evil.com"`.
- Links are built by the server today, so this is defence in depth.
- Fix: require `new URL(link, location.origin).origin === location.origin`, and reject backslashes and control characters.

**P2-6: The chip's breakdown text is not pluralised.**
- en: "1 item waiting for you · 0 approval requests · 1 attendance reasons".
- ar: "عنصر واحد بانتظارك · 0 طلبات موافقة · 1 مبررات حضور".
- Source: `locales/*/team.json`, key `chip.split`.
- Fix: two plural keys, with the Arabic plural forms, and leave out a half that is zero.

**P2-7: Edge cases on the public validate endpoint.**
- (a) A token whose organisation part is 36 dashes passes the regex in `parseToken` (`members.service.ts:143`), then fails the uuid cast → **400** VALIDATION_ERROR. The report documents "unknown / malformed → 404", and the other bad tokens behave that way: unknown org, wrong secret, no dot and short secret all → 404 "Invitation not found." with an identical body.
- (b) Median over 15 requests: 3 ms for an unknown organisation against 9.9 ms for an existing one, both 404. This leaks whether an organisation exists by timing; organisation ids are UUIDs, which limits the value.
- (c) The limiter keys on `clientIp(...) ?? 'unknown'` (`app.ts:54-55`).
  - With the edge gate unset, rotating `X-Forwarded-For` produced 23 requests without a 429; the same IP got 429 from the 21st request.
  - With `EDGE_SHARED_SECRET` set: without the edge header → 403; with it → 20 per IP, then 429.
  - Requests that pass the edge but carry no client IP all share one bucket (429 after 20), so a misconfigured edge would let one visitor lock every invitee out.
  - This depends on deployment (edge secret and trusted-proxy configuration) and belongs in the deployment doc.
- Fix for (a): validate the organisation part with `uuidSchema` and answer 404.

**P2-8: A 429 from the export quota carries no `Retry-After` header.**
- `apps/api/src/lib/quota.ts:16` sets `retryAfterMs`, but only `middleware/rate-limit.ts:24` turns it into a header.
- Probe (X2): 429 RATE_LIMITED "At most 30 regularisation exports per hour per organisation.", `retry-after` null.
- The same pattern already exists in the hr-workspace and reports quotas.

**P2-9: The same token can be accepted four times concurrently.**
- Where: `members.service.ts:331-332` and `:355`. The row is not locked, and the `acceptedAt` update has neither an `acceptedAt is null` guard nor a row-count check.
- Probe (`rev5-probes-inv4`, R2): 4 concurrent accepts by the invitee → **4 × 200**, one membership, **4** `member.invitation_accepted` audit rows.
- The address binding limits this to the invitee, so the effect is duplicated audit rows and side effects. The same code is in production at `1dc82a9`.
- Fix: `select … for update` on the matched row, or `update … where accepted_at is null and revoked_at is null` and refuse when it updates 0 rows.

## 3. Verified correct (with evidence)

### Team scope (`rev5-probes-team`, T1–T7)

**T1: who appears in the summary.**
- lm's summary lists exactly lm's primary and secondary reports (e5, e6, e15). The indirect report (e8) and the unrelated employee (e7) are absent.
- mgr9, primary manager of e6, sees e6.

**T2: `/team/attendance` with crafted `employeeId` values.**
- A report or a secondary report → 200.
- Unrelated, report-of-report, oneself, cross-tenant and random ids all → 403 "This employee is not one of your direct reports." Every case gets the same answer, so it reveals nothing about whether an id exists.
- Malformed uuid → 400; a range over 62 days → 400; `page=0` or `pageSize=1000` → 400.
- The summary refuses 30 Feb (400) and accepts 1900 (200).

**T3: `GET /attendance/records/:id`.**
- A report or a secondary report → 200.
- Unrelated, report-of-report, cross-tenant and random ids all → 404 "Attendance record not found."
- A member who manages e8 but holds no team key → 404.
- A branch-B report → 200.

**T4: holders without direct reports.**
- `attendance.view` org-wide, no reports → summary `[]`.
- Manager role with no reports → `[]` and counts `{0,0,0}`.
- An employee → 403.
- A non-member of the tenant → 403 on summary, counts and attendance.
- A branch manager with `leave.view` scoped to B, no `leave.view_team` and a report in branch A → `/team/leave` shows 0 entries.

**T5: branch scope.** A manager scoped to branch B, with the team key, sees their branch-A report's card, day rows and record. The team predicate takes precedence over branch scope, as designed.

**T6: the manager's own record.** When the manager's own employee record is terminated or archived (membership still active): summary `[]`, record 404, attendance 403, and `/me` shows `isManager: false`.

**T7: a terminated report.** They drop off the summary, and their records return 404.

### Counts (C0–C4, K1)

**C0.** Everything is zero for every user.

**C1: a leave request.**
- lm: `{1,0,1}`, `/me` 1, inbox 1.
- The summary's `pendingItems`, the leave tab's `pendingForMe` and `upcoming` (all 1) agree.
- After lm asks the employee for information, every surface still agrees.

**C2: delegation.**
- deputy: `{1,0,1}`, `/me` 1 (`delegatedToMe: true`), inbox 1.
- mgr9: 1 / 1 / 1.
- lm: 2 / 2 / 2.

**C3: a reason with a secondary stand-in.** The notes half counts it (lm `{2,1,3}`), and the reasons list shows it with `canReview: true`.

**C4: an ALL level.** After hrAdmin decides their own seat, hrAdmin goes 3 → 2 on every surface, hr2 stays at 3, and the inbox lists agree.

**K1: no double counting.** The seated reason's request is counted once, in the approvals half (inbox 1), and the reason without a request is counted in the notes half. The dashboard KPI, the approvals half, `/me` and the inbox are all 1.

### Team approvals (A1–A3)

**A1: request validation.**
- A decision without `stepNo` → 400.
- A caller not seated on the level → 403.
- A closed request → 403.

**A2: segregation of duties.** A request about oneself, reached through a delegation → 403, and `canDecide` is false.

**A3: a MANAGER → HR_ADMIN workflow.**
- A line manager without approve keys decides their level-1 seat → 200, and the request moves to step 2.
- A second decision on step 1 → 409 "Step 1 is not the current step (2)."
- Bulk decisions are handled per item: ok / INVALID_STATE "already APPROVED" / NOT_FOUND, reported as `succeeded: 1, failed: 2`.

### Register and notes report (`rev5-probes-admin`, `rev5-probes-admin2`)

**Permission.** A register reader without `report.export` gets 403 on both exports and 200 on the list (E1).

**Filters (E2, E3).** The export row count equals the list total for every filter tried:
- register, 9 combinations: 6/6, 4/4, 2/2, 2/2, 6/6, 6/6, 2/2, 4/4, 4/4;
- notes report, 6 combinations: 3, 2, 2, 1, 2, 2.

**Audit.** Every export writes an audit row carrying its filters and row count (15 rows).

**CSV escaping (X1, X4).**
- Cells starting with `=`, `+`, `-` or `@` are prefixed with `'`.
- Leading tab, CR, space or LF is trimmed first, then the cell is escaped.
- Quotes are doubled.
- The notes export escapes `=HYPERLINK(…)` and `@cmd`.

**Bounds (X3).**
- More than 10 000 rows → 400 "The export is limited to 10000 rows; narrow the dates or the branch." (339 ms).
- The first page of a list over 10 000 rows loads in 70 ms.

**Quota (X2).** 30 exports per organisation per hour, then 429; the notes export has its own quota.

**Scope (X1, X4).**
- A branch manager's register export returns 0 rows when all the rows are in branch A.
- Notes report scopes: hrAdmin sees 2; the branch-B manager sees 1, from Branch B only; the other branch → 403; an employee's team scope → 0.

**R1 control.** The engine refused the unnamed override, so the register offers no way around the engine.

### Roster (`rev5-probes-admin`, S1 and S3)

**S1: scope, validation and routing.**
- Branch-B manager: 1 row, Branch B only; another branch → 403.
- No `shift.view` → 403; month 13 → 400.
- `/shifts/roster` → 400, because `/shifts/:id` captures it. The roster lives at `/shift-roster`, so the two do not collide.

**S3: performance with 1 005 employees × 31 days.**
- 11 pages of 100 employees, 37–188 ms each; a search takes 39 ms.
- EXPLAIN: the assignment load is a bitmap index scan (0.39 ms) and the employee count an index scan (0.31 ms).

**Rotation, holidays, branch-subset holidays and weekly offs:** covered by the repo's roster suite, which passes.

### Invitations (`rev5-probes-inv`, `inv2`, `inv3`, `inv4`)

**I1: nothing secret is stored or queued.**
- The job payload holds ids only: `{invitationId, organizationId}`.
- `pg_dump` contains 0 occurrences of the plaintext secret and 1 of its hash.

**I2: the preview is minimal.**
- A valid token returns only `{state: valid, organizationName, employeeName: null, emailMasked: "n***@r***.test", expiresAt}`.
- Every bad token returns 404 with an identical body (the one exception is P2-7a).

**I3: resend.**
- Resend rotates: new id, new token.
- The old token now validates as `revoked`, and accepting it → 409 "This invitation was revoked."
- Resending the revoked row → 404.
- Signed in with a different e-mail → 403 "This invitation was issued to a different email address."
- The invitee accepts → 200; accepting again → 409 "already accepted"; validate then reports `accepted`.

**I4: expiry and revocation.**
- An expired invitation validates as `expired`.
- `DELETE`, the call the `1dc82a9` web makes, → 204. The row leaves the list, a second DELETE → 404, validate → `revoked`, and re-inviting → 201.

**R1: concurrent resends.** Four resends at once → one 201 and three 409, leaving one open row.

**W1: only `user.manage` may write.**
- Members without `user.manage` all get 403 on resend, DELETE and every portal-access write (invite, revoke, restore, resend). Tested roles: hr_admin (which holds `user.view`), hr_user, manager, branch manager, payroll and employee.
- The owner of another tenant also gets 403.
- The `user.view` holder can read the access card (200).
- The invitation is left untouched.

**I5: role and scope checks.**
- A role above one's own → 403, listing the missing permissions.
- The owner role → 403 "Only an owner can invite another owner."
- A branch outside one's scope → 403.
- The access card for an employee outside one's branches → 404.

**I10: edge gate.** Without the edge header → 403; with it, 20 requests per IP, then 429.

**I11: own access.** Changing one's own access → 409.

**I7: role deletion by the owner.**
- An open invitation blocks deleting its role (409).
- A revoked invitation is deleted with the role; the audit trail keeps `member.invited` and `member.invitation_revoked`.

**The migration** is idempotent, safe in a single transaction, and leaves RLS and anon access to `invitations` unchanged (post-verify block and replays).

### Notification routing (`rev5-notif-routing.out`, 76 type × audience rows)

**Approval types.**
- The subject goes to their own `/my/*` page.
- An approver goes to `/approvals?request=<id>`.
- A line manager without an approve key goes to `/team?tab=approvals` for the action types (pending, reminder, escalated, info_answered, reassigned), and to `/approvals?request=<id>` for outcome types, which the inbox route allows for every member.

**`attendance.note_submitted`.** A line-manager-only reader goes to `/team?tab=approvals`; the others follow the worker's link.

**Open-redirect vectors refused.** `//`, `javascript:` in any case, absolute URLs, a leading space and a leading tab. The `%2F%2F`, `%5C` and `%09` forms stay same-origin paths.

### Web (`rev5-probe.spec.ts` plus the gate suites)

**Text and direction.**
- No raw i18n keys on any probed page in en or ar: team tabs, register, notes report, roster, access card, dashboard, accept page.
- `dir` and `lang` switch to rtl / ar.

**Accept page.** No overflow at 390 px, in en or ar.

**Chip.**
- Its accessible name is "1 item waiting for you · 0 approval requests · 1 attendance reasons".
- It is reachable by keyboard.
- For a line manager without approve keys it links to `/team?tab=approvals`.

**"No direct reports" rule.** `team-page.test.tsx:64` ("You have no direct reports") and the locale-parity tests pass in the web gate.

### Backward compatibility with the live `1dc82a9` web

**DTOs.** Against `1dc82a9` the changes are additive and optional: `invitationDtoSchema` gains `employeeId`, `employeeNumber` and `deliverySentAt`. Nothing the old web reads was removed.

**Endpoints.**
- `DELETE /invitations/:id` behaves as the old web expects (I4).
- `GET /attendance/records/:id` keeps its org-wide and own-record rules; the branch check still applies off the team path. The existing record tests pass in the API gate.
- The dashboard API is unchanged by these commits, which touch only the web.

## 4. Acceptance items not satisfied (B-61…B-76, ATT)

| Item | Status | Why |
|---|---|---|
| **B-63** | partial | Stand-in regularisation and shift-swap seats are not counted (P1-3); a delegate's own request is counted (P2-1); a secondary manager without a team key reads 0 (P2-2). |
| **B-64** | partial | "My assigned requests" on the team Approvals tab omits stand-in regularisations (P1-3). |
| **B-65** | partial | The register offers Approve / Reject on rows the server then refuses: organisation-wide overrides on ALL/QUORUM levels with several waiting seats (P1-1). |
| **B-66** | partial | Approval routing matches the spec, but a line-manager-only stand-in is routed to a queue that does not list the item (P1-3), and manager attendance notifications land on the manager's own page (P1-6). |
| **B-67** | partial | The single `user.manage` rule holds (W1), but it has no branch or role boundary (P0-1, P0-3). |
| **B-68** | partial | Built as specified, but defaulting to an address that `employee.update` holders can edit enables account takeover (P0-2). |
| **B-70 / B-71** | partial | Correct within the newest 1 000 rows of the organisation, 404 beyond them (P1-2); a malformed organisation part answers 400 (P2-7a). |
| **B-69** | met, with a caveat | Resend on a suspended login restores it (I11), but it inherits the missing role boundary (P0-3). |
| **ATT-105** | not met | Fails for employees whose branch or department changes within the month (P1-4). |

These held under the probes: **B-61**, **B-62**, **B-74** (I11 plus the repo suite), **ATT-70**, **ATT-77**, **ATT-78**, **ATT-86**, and **ATT-102…104** (repo roster suite, with the P1-4 caveat). **B-76** is n/a by design.

## 5. Observations (not counted as defects)

**Team scope follows the current reporting line, and it applies to past dates too (T7).**
- After e5 moved from lm to mgr9, lm lost e5 entirely: summary without e5, record 404, attendance 403. That includes the days lm was e5's manager.
- mgr9 can read e5's earlier day (200).
- A former manager gets 404 on a terminated report's records, even for days inside the employment.
- This is consistent with `app.team_employee_ids()`, but §7 does not say so. `employment_history.manager_employee_id` exists, so a date-aware rule is possible.

**Requests waiting on the employee's answer still count as "waiting for you" (C1, K1).** This is consistent across every surface; whether they should count is a product decision.

**One person approved both levels of one request (A3).** lmlite decided level 1 through their own MANAGER seat, then level 2 (HR_ADMIN) as hrAdmin's delegate. Prompt 2's engine allows this (it has no distinct-approver rule); noted for the engine owner.

**Outside this scope, for the Prompt 8 relay owner.** `attendance.correction_approved` / `rejected` go to every active holder of `attendance.correct` (`outbox.ts:55-56`, permission mode). The system Line Manager role holds that permission (live DB), so every line manager is told about corrections to non-reports, and the payload includes the approver's comment (`hooks/corrections.ts:22`). This is from the code and the live role only; I did not run a delivery end to end.

**Web timing flake.** The `monthly-grid.test.tsx` 4-second limit fails under shared-core load.

## 6. Hygiene

**Throwaway files, created and deleted.**
- `apps/api/src/test/rev5-probes-{team,team2,admin,admin2,inv,inv2,inv3,inv4,inv5}.test.ts`
- `apps/web/e2e/rev5-probe.spec.ts`

**Worktree state.**
- `git status --porcelain` is empty, and HEAD is `9072934`.
- Only ignored outputs remain: `apps/web/dist-e2e`, `playwright-report`, `test-results` (just `.last-run.json`).
- The generated `db.ts` was restored after the diff.

**Scratch.** Everything lives under `scratchpad/rev5/`: the `rev5-*.sh` scripts, the gate logs `rev5-gate-*.log`, the evidence files `rev5-evidence-{team,team2,admin,admin2,inv,inv2,inv3,inv4,inv5,web}.jsonl`, and `rev5-notif-routing.{ts,out}`.
