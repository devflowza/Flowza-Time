# Prompt 8 (Notifications & reminders): adversarial review of `e760ba2`

**Worktree.** `/home/user/Flowza-Time/.claude/worktrees/agent-a1c279f6c8142a516`, reset to `e760ba2`. `git log -1` gives `e760ba2 merge: Prompt 8 notifications & reminders …`.

**Tree state.** No tracked file was modified and nothing was committed. The four throwaway probe files I added were deleted afterwards, and `git status --short` (including ignored files) is empty.

**Databases.**
- `flowza_rev8` is seeded. Every SQL probe ran inside a transaction that was rolled back. The migration was applied again twice.
- `flowza_rev8_rls` ran the RLS suite.
- `flowza_rev8_ci2` ran the fresh replay and the API-harness probes.
- `flowza_rev8_tx` ran the single-transaction replay and the worker-harness probes.

**Where the evidence is.** All probes, logs and screenshots are under `scratchpad/rev8/` (inventory in §6). "Worker harness" = a throwaway vitest file driving the **real** relay / delivery / reminder / retention code against a real Postgres. "API harness" = one driving the real HTTP routes and then the real relay. Malicious payload strings below are described, not reproduced.

**Summary.**
- Every gate is green.
- I found **5 security defects (P0)**, **4 functional defects (P1)** and **8 minor defects (P2)**.
- **P0-1 is critical.** Any signed-in member can write to the outbox; the relay then sends platform e-mails with attacker-chosen facts and working one-click Approve/Reject links for real requests.
- **P0-2 is high.** A holder of `notification.manage` can move another organisation's settings row, leaking its settings and silently switching off its MFA requirement.

---

## 1. Gates (from scratch, on the unmodified tree)

The gate run happened before any probe file existed; the file counts (19 worker, 30 API) are the committed test files.

| # | Gate | How | Result |
|---|---|---|---|
| 1 | lint | `pnpm lint` (eslint `--max-warnings 0`) | pass |
| 2 | typecheck | apps/api, apps/web, apps/worker | pass |
| 3 | unit | `pnpm test:unit` | shared 4/4 (1 file) · contracts 43/43 (3) · device-providers 286/286 (9) · domain 313/313 (23) · database 20/20 (2) |
| 4 | web | vitest | **359/359** (73 files) |
| 5 | RLS | `flowza_rev8_rls`, under the lock | "RLS tests passed": **464 `ok`**, 0 failures (42 in `rls_notifications.sql`) |
| 6 | test:db | under the lock | **15/15** (3 files) |
| 7 | API | vitest | **409/409** (30 files); the P2-13 flake did not occur |
| 8 | worker | under the lock | **214 passed, 1 skipped** (19 files) |
| 9 | build | apps | pass |
| 10 | fresh replay | `flowza_rev8_ci2` | 38 migrations, "database flowza_rev8_ci2 ready" |
| 11 | idempotent re-apply of `20260928001000` | `psql -1 -v ON_ERROR_STOP=1`, twice, seeded `flowza_rev8` | rc 0 / rc 0, 0 errors |
| 12 | single-transaction replay | `replay-single-tx.sh … flowza_rev8_tx` | "single-transaction replay OK" (13 files single-tx) |
| 13 | `pnpm db:types` + `git diff --exit-code` | against `flowza_rev8` | 99 tables, **no diff** |
| 14 | Playwright | `build:e2e` + `test:e2e` (`/opt/pw-browsers/chromium`) | **52/52** |

---

## 2. Defects

### P0 — security

#### P0-1 (critical): any member can write to the outbox → forged notices, forged e-mails, and working one-click decisions on real requests

**Where.**
- `supabase/migrations/20260905001400_rls_policies.sql:233-234`: `grant insert on public.domain_events to authenticated;` and the `domain_events_insert` policy whose whole check is `organization_id = any((select app.member_org_ids())::uuid[])` — every member, every role, passes.
- PostgREST exposes `public` (`supabase/config.toml:7`).
- This contradicts `docs/blueprint.md:417` ("outbox tables have **no** client policies at all").
- The grant predates Prompt 8; Prompt 8 turns a forged row into mail with authority:
  - `apps/worker/src/handlers/notifications/outbox.ts:135` reads recipients straight from `payload.userIds` (any active member, capped at `MAX_TARGETED_RECIPIENTS = 500`, `outbox.ts:96`).
  - `outbox.ts:275-289` (`oneClickLinks`) mints an Approve/Reject token pair whenever the recipient holds a pending seat on `payload.requestId`.
  - Titles/bodies render from the payload.
  - `apps/web/src/features/approvals/pages/email-action-page.tsx:46` POSTs the decision on one click; the page shows no request detail first.

**Probe 1** — `rev8-forge-event.sql` on `flowza_rev8`, rolled back, run as `authenticated` with a plain `employee` member's JWT claims (`rev8-forge-event.log`):
```
 current_user  | uid
 authenticated | 3b85c6e8-…-c37cd3    (role key: employee, employee_id linked)
INSERT 0 1   -- approval.pending targeting a REAL pending ATTENDANCE_CORRECTION (9c5d3764…, current step 2),
             --   userIds [hr_admin b483e561…], with an attacker-chosen employeeName/leaveTypeName
INSERT 0 1   -- approval.decided REJECTED carrying an attacker-chosen phishing comment, userIds [owner de73b10e…]
```
A row for another org is refused: `new row violates row-level security policy for table "domain_events"`.

**Probe 2** — worker harness `relayOutbox` then `deliverNotifications` (`rev8-probe-out.jsonl`: `forged.pending.mail`, `forged.phish.mails`, `forged.mass`):
- A forged `approval.pending` on a **real pending OVERTIME request where hr holds a seat** produced an e-mail to `hr@r8.local` ("Approval needed …") whose body carried the forged facts, and minted APPROVE + REJECT tokens for hr on that real request (`tokens: [{requestId f87bbf00…, userId <hr>, action APPROVE}, {… REJECT}]`).
- A forged `approval.decided` reached owner, hr and an Arabic-profile member (rendered in Arabic), body carrying an attacker-supplied "verify your account" link.
- 3 forged events → **21 e-mails** (`forged.mass {emails: 21}`).

**Attack chain.** Member submits a leave/overtime request (API returns its id) → member `POST`s `/rest/v1/domain_events` with their own JWT + anon key, an `approval.pending` for that id and `userIds:[approver]` → the approver gets a genuine platform e-mail whose Approve link decides the **real** request, on facts the attacker wrote, with no request detail shown. Non-configurable types (e.g. `subscription.limit_reached`) can also be forged and cannot be switched off.

**Fix.** (a) Restrict the insert to the API login: `with check (… and session_user = 'flowza_api')` (the API pool logs in as `flowza_api`, PostgREST as `authenticator`), or revoke INSERT and emit via a SECURITY DEFINER function granted only to `flowza_api`; add an RLS test that a client JWT cannot insert. (b) Defence in depth: for `approval.*`, derive facts and one-click eligibility from the request (the worker already has `approvalEntityFacts`), and show the request summary on the action page before confirm.

#### P0-2 (high): the `notification.manage` delegation lets another org's settings row be moved — leaking its settings and disabling its MFA requirement

**Where.** `supabase/migrations/20260928001000_notifications_v2.sql`:
- `:96-98` — the UPDATE policy admits `organization.manage` **or** `notification.manage`, in both USING and WITH CHECK, for the whole row.
- `:99` — DELETE needs only `organization.manage`.
- `:104-131` — the group guard (`app.organization_settings_group_guard`) skips `organization_id` at `:116` (`continue when v_key in ('organization_id', …)`), so a change to `organization_id` is never checked against any permission.

A `notification.manage` holder who also owns a second org B (with its own settings row) can, in two statements: DELETE B's row, then `UPDATE organization_settings SET organization_id = B WHERE organization_id = A` — carrying A's `security`/`integrations` groups into B, which they own and can read; and A is now left with **zero** rows, so A's settings revert to defaults.

**Probe** — `rev8-settings-move.sql` (attacker owns B, holds only `organization.view`+`notification.manage` in A; `rev8-settings-move.log`), rolled back:
```
attacker cannot write A.security directly  → ERROR: organization.manage is required to change the security settings
DELETE 1                                   -- own org B's row
UPDATE 1                                   -- move victim A's row into B
read in B: security {"mfaRequired": true, "sessionIdleMinutes": 15}, integrations {flowzaFinance baseUrl "https://victim-finance.example"}
victim A rows left: 0
```
**MFA impact** — `rev8-settings-move-mfa.sql` (`rev8-settings-move-mfa.log`) adds `app.principal_snapshot` before/after for A's owner. `mfaRequiredOrgIds` is derived from `organization_settings.security->'mfaRequired'` (`supabase/migrations/20260928000100_roles_manager_and_permissions.sql:334`, and `20260909000300`). With A's row gone:
```
A owner mfaRequiredOrgIds before: ["00000000-…-000000000001"]
A owner mfaRequiredOrgIds after:  []
```
So A's org-wide MFA enforcement is silently switched off, and A's Flowza-Finance integration base URL is disclosed to B's owner. This is introduced by Prompt 8: the guard's `organization_id` skip plus the `notification.manage` branch on UPDATE/DELETE.

**Fix.** In the guard, raise when `to_jsonb(new)->>'organization_id'` differs from OLD (a row's org must be immutable), or `revoke update (organization_id)`. Keep DELETE at `organization.manage` (already so) but a moved-away row still needs the immutability check. Add an RLS/guard test: "a `notification.manage` holder cannot re-parent a settings row".

#### P0-3 (low): the settings relay reader crosses tenants

**Where.** `20260928001000_notifications_v2.sql:137-146`. `app.organization_notification_settings(p_org)` is SECURITY DEFINER and only checks `if not app.is_system() then raise` (`:141`). It never checks that `p_org` is the caller's own system org, so a system context bound to org A reads **any** org's notifications group.

**Probe** — `rev8-settings-guard.sql` P6 (`rev8-settings-guard.log`): a `flowza_system` context with `org_id = A` calls the function for B and gets B's group (`{"marker":"org-B","approvalPending":false}`), while a direct `select … from organization_settings where organization_id = B` under the same context returns 0 rows (RLS working). Severity is low: the caller is a trusted server role and the relay only ever passes its own `row.organizationId` (`outbox.ts:123`). It is still a latent cross-tenant reader that the RLS on the table would otherwise prevent.

**Fix.** `if not app.is_system() or p_org <> app.system_org_id() then raise` (or gate it to the platform context, as the platform relay batches per-org anyway).

#### P0-4 (low): correction-decision fan-out crosses branch scope and over-notifies the requester

**Where.** `ROUTING['attendance.correction_approved'|'_rejected'] = { permission: 'attendance.correct' }` (`outbox.ts:55-56`) plus the `payload.userId` requester branch (`outbox.ts:139-146` via `recipientsOf`). The routing predates Prompt 8 but Prompt 8 keeps it and adds the requester copy.

**Probe** — API harness, an employee's own correction decided by HR (`rev8-api-out.jsonl` `correction.decided`, `correction.scope`): one approval produced **9 in-app notices and 9 e-mails**. Recipients include `branchManagerB` — a branch-B-only manager (`allBranches:false`) while the employee is in branch A — and the decider, and the requester received **two** notices for one decision (`attendance.correction_approved` with `userId`, plus `approval.decided`). `data` carries only `employeeId`, `attendanceDate`, `comment` (whitelisted).

**Fix.** Route correction decisions to targeted recipients (the requester and the actual approvers), or drop `attendance.correction_*` from notification routing entirely (the requester already gets `approval.decided`). At minimum, keep permission-holder fan-out inside the document's branch scope.

#### P0-5 (informational): `notifications.data` from the pre-Prompt-8 relay still holds the full payload (code evidence only)

**Where.** The current relay stores only whitelisted keys (verified — see §3). But the previous relay wrote `data: JSON.stringify({ aggregateType, aggregateId, ...row.payload })` (`git show 3e9a6d1:apps/worker/src/handlers/notifications/outbox.ts:173`, and `git show 1dc82a9:…outbox.ts:80,173`), i.e. the whole event payload. The Prompt 8 migration does not scrub pre-existing `notifications.data`. I could not probe production data, so this is code evidence only. Consider a one-off backfill to prune old rows to the whitelist.

### P1 — functional

#### P1-1: retention starves organisations past `RETENTION_MAX_BATCHES`

**Where.** `apps/worker/src/handlers/notifications/retention.ts:62-76`. The `batches` counter is shared across all orgs of a class (`:63`), every org consumes at least one batch even when it deletes nothing (`:66-72`), and the loop breaks at `maxBatches` (`RETENTION_MAX_BATCHES = 200`, `:25`). Orgs are iterated in a fixed `order by id` (`:52`), and the null (org-less) bucket is last (`:55`).

**Probe** — worker harness, 205 empty orgs plus a TAIL org holding purgeable rows, default constants, 3 runs (`rev8-probe-out.jsonl` `retention.starvation`):
```
run 1: capped [deliveries, notifications, domainEvents], batches 600, organizations 212, tailNotificationsLeft 3, tailEventsLeft 3
run 2/3: identical — the TAIL keeps its 3 notifications and 3 events every run
```
Each empty org burns one batch, so with >200 orgs the tail (and the org-less bucket) is never reached, on every run, forever.

**Fix.** Do not count empty batches toward the cap (only advance on `deleted > 0`), or drive each class with one ordered delete instead of a per-org loop, or persist a per-class cursor across runs.

#### P1-2: escalation e-mail one-click links fail on multi-seat levels

**Where.** `oneClickLinks` (`outbox.ts:275-289`) mints links for any recipient with a pending actor row, but the decide path requires an escalated/override decider to name the seat when the level is ALL/QUORUM with >1 pending seat (`apps/api/src/services/approvals/engine.ts:389-404`: `seatMustBeNamed` → 400 "…onBehalfOfUserId").

**Probe** — API harness, an ALL level with two HR-admin seats waiting, escalated to OWNER (`rev8-api-out.jsonl` `escalated.oneclick`): the owner's "Escalated to you" e-mail contains links (`hasLinks: true`); clicking Approve returns `400 VALIDATION_ERROR "Choose which approver you are deciding for … (onBehalfOfUserId)"`. The link is dead for exactly the case escalation exists to unblock.

**Fix.** In `oneClickLinks`, return `null` (link only to the request) when the recipient would decide as an escalated approver or override on a level where `seatMustBeNamed`. The seat-choice UI is only reachable in-app, so the e-mail should send them there.

#### P1-3: HR withdrawing an employee's pending leave notifies only the approver, not the requester/subject

**Where.** `engine.ts:526` emits the CANCELLED `approval.decided` only to the current step's pending/skipped actors excluding the canceller; the leave hook's `onCancelled` (`apps/api/src/services/approvals/hooks/leave.ts:115-120`) emits nothing to the employee. The catalogue's own spec says the requester + subject should hear (`catalogue.ts:180`, "the requester and the person concerned").

**Probe** — API harness, HR (`hrUser`) withdraws `staff`'s pending leave (`rev8-api-out.jsonl` `withdraw`):
```
events: approval.decided CANCELLED → to [lineMgr(approver)]
notices: [{to lineMgr(approver), "Leave request — Employee 5 was withdrawn"}]
```
The employee whose leave it was is told nothing.

**Fix.** When the canceller is not the requester, add the requester (and the subject when different) to the CANCELLED recipients in `cancelWithin`, or emit an employee-facing notice from the leave hook's `onCancelled`.

#### P1-4: preferences are unreachable for a member with neither `organization.view` nor an employee link

**Where.** `/settings` requires `organization.view` (`apps/web/src/features/settings/routes.tsx:17`); `/my/*` is wrapped in `RequireEmployeeLink` (`apps/web/src/features/portal/routes.tsx:23,33`). The two mounts of the preferences card are `/settings/notifications` and `/my/profile`. The delivery e-mail footer links such a member to `/settings/notifications` (`outbox.ts:366`, `preferencesUrl` is `/settings/notifications` when there is no employee link).

**Probe** — Playwright, a device tech (`device.view`/`device.sync`, no employee link) following each path (`rev8-e2e-out.jsonl` `prefs.unreachable`):
```
/settings/notifications → denied: true, card count 0
/my/profile            → card count 0 (RequireEmployeeLink blocks the route)
```
So a non-employee member who can receive notifications (e.g. device/sync notices) has nowhere to change their preferences, and the e-mail "manage your settings" link lands on a permission-denied page.

**Fix.** Mount the preferences card on a route every member can reach (e.g. an account page gated only on `!!membership`), and point the non-employee `preferencesUrl` at it.

### P2 — minor

1. **Reminder + escalation fire while a request waits for the requester's answer.** `currentSteps` (`apps/worker/src/handlers/approvals/reminders.ts:22-27`) has no `info_requested_at` filter; the reminder loop (`:110-118`) reminds after 24 h regardless. Worker-harness probe (`rev8-probe2-out.jsonl` `reminder.whileInfoRequested`): a level in `info_requested` produced `{escalated 1, reminded 1}`, and the escalated owner received both in the same sweep. The reports do not say a pending question pauses the clock, so this is a judgement call — flag it, likely a P2.
2. **Arabic notices use the English leave-type name and Latin codes.** `approvalEntityFacts` (`apps/worker/src/handlers/approvals/facts.ts:18`) and both leave decision emitters (`hooks/leave.ts:100,113,135`) select `t.name` only, never `name_ar` (the column exists — `20260928000700_leave_v2.sql:342`). API-harness `flow.notifications`: an ar-profile employee got "تمت الموافقة على الإجازة: Casual Leave". Also `attendance.note_decided#rejected_leave` prints the Latin `{{leaveTypeCode}}` (`templates/ar.ts:84` → "…رصيد إجازة AL") and `sync.finance.failed` prints `{{code}}` (`ar.ts:130` → "NETWORK_ERROR: …"). Worker-harness `ar.latin` lists all 15 such Arabic bodies. (ATT-85.)
3. **Delivery has no per-delivery savepoint.** `deliverNotifications` (`outbox.ts:326-388`) runs the whole batch in one transaction with no inner savepoint. Worker-harness `delivery.abort` (a trigger made one token insert fail): `"current transaction is aborted, commands ignored until end of transaction block"`, the earlier recipient (`a1`) was mailed, and across 3 runs all three deliveries stayed `pending attempts 0` while `a1` was re-mailed every run. One failing delivery both re-mails earlier recipients and stalls the batch. Fix: wrap each delivery in its own savepoint (the relay already does per event, `outbox.ts:242-255`).
4. **Backward compatibility — `punch.missing_out` links to `/my/checkin`, absent from the live main bundle.** `catalogue.ts:284` → `/my/checkin?date=`. `rev8-new-links.mjs` against the `e760ba2` bundle: the route exists now. `rev8-main-links.mjs` against `1dc82a9` (`git archive`): `/my/checkin` is **not** in main's 45 routes, and this notice is worker-generated for every device user during the deploy window. (Also main-absent but user-triggered, lower risk: the other portal deep links `/my/requests`, `/my/shift`, `/attendance/notes`.) Fix: deploy web before/with the worker, or keep a redirect.
5. **`employee.imported` deep link is broken on both bundles.** `catalogue.ts:394` → `/employees/imports/:id`; no such route exists in `e760ba2` (`rev8-new-links.log`) or `1dc82a9`. Playwright `link.imported`: `/employees/imports/<id>` renders **Not found**; the real page is `/employees/import?importId=<id>` (`apps/web/src/features/employees/pages/employee-import-page.tsx:26`). Fix: `deepLink` → `/employees/import?importId=${id}`.
6. **Branch timezone ahead of the org timezone → the reminder is never sent.** `missing-punch.ts:67-75` computes the date window from the **org** timezone (`org.timezone`), then filters `attendance_date` to org-local yesterday..today. Worker-harness `mp.branch_tz` (org Pago Pago UTC−11, branch Kiritimati UTC+14): across the six ticks the row is either outside the org window (`candidates 0`) or already `stale 1` by the time it enters it; `events 0`. A branch far east of the org loses the reminder. (Org == branch timezone, and org-tz night shifts, work — `mp.la`/`mp.ki` remind once at the right minute.)
7. **Non-concurrent index builds on hot tables.** `20260928001000_notifications_v2.sql:49-50` builds two partial indexes on `notifications` / `notification_deliveries` inside the transaction (`AGENTS.md:108-109` asks for `CONCURRENTLY` on hot tables). Mitigated: `set lock_timeout='5s'` (`:32`) and a runbook comment (`:28-31`) telling the operator to build them `CONCURRENTLY` out of band first. Flagged because the migration file cannot itself be non-transactional.
8. **A note answered by editing the reason tells the approver "changed while pending", not "answer received".** `apps/api/src/services/portal/notes.service.ts:147-153`: an `info_requested` note edited via `PATCH /me/attendance/notes/:id` calls `invalidateForEntity` then `routeNote`, so the approver gets `approval.decided` INVALIDATED ("…changed while pending and needs a new decision") + a fresh `approval.pending`, never `approval.info_answered`. API-harness `note.answer`: notices to the approver were exactly those two. The approver is notified but the wording misrepresents an answer as a change. (The dedicated answer path `POST …/answer-info` does emit `approval.info_answered` correctly — see §3.) Fix: on a note answered by edit, emit `info_answered`/`onInfoAnswered` rather than invalidate+re-route.

---

## 3. Verified correct (with evidence)

**Completeness.** `rev8-emits.py` found **40** `emitDomainEvent` sites plus the `emitToUsers`/engine targeted emits; every emitted type maps to a `ROUTING` entry + a catalogue entry + en/ar templates, or is in `NON_NOTIFYING_EVENT_TYPES` (device.created/updated/credentials_changed, employee.created/updated/deleted, sync.queued, attendance.correction_submitted). `subscription.limit_reached` and `employee.imported#finished` are catalogued but never emitted (dead, not missing). No raw `insert into … domain_events` outside `emitDomainEvent`. The single retention/outbox readers of `domain_events` are the relay and the purge.

**Approval notices per entity kind.** API/worker harness confirmed pending / reminder (24 h) / escalation / decided / info_requested / info_answered with correct recipients and facts. `approvalEntityFacts` (`facts.ts`) supplies the day for CORRECTION/NOTE/REGULARISATION, the swap date for SHIFT_SWAP, the worked day for COMP_OFF, and dates+type for LEAVE; OVERTIME/MISSING_PUNCH/SHIFT_CHANGE/MANUAL_ATTENDANCE/OVERTIME_CLAIM correctly render with the entity label + person only. `leave.info_requested` reaches the employee (B-100); `approval.info_answered` reaches the pending approvers (`flow.notifications`: "Answer received: Leave request — Employee 5", body "Answer: Ali covers it").

**Channel matrix.** Worker-harness `matrix`: **162 cases** (switch × IN_APP/EMAIL preference × configurable/non-configurable × ★), **0 mismatches**. `matrix.emailOnlyUnread {n:0}` — e-mail-only rows (`in_app=false`) never enter the inbox list or the unread count; `me.service.listNotifications` filters `inApp=true` and `unreadCount` counts `readAt is null` on the same filter. Both-off writes nothing; `missingPunchReminder=false` → `skipped:'disabled'` (`missing-punch.ts:62`).

**Defaults / digest.** `defaults`: `dailyDigest=false`, everything else on, `missingPunchReminderHours=2`. `digest.vs.reminder`: the daily digest is in-app only (`email:false`) while the 24 h reminder still e-mails (`email:true`). The change (Prompt 2 mailed the digest despite the off switch) is documented (`docs/hr-portal/reports/08-notifications.md:116`) and shown in the settings hint (`settings.json:278`). B-102 still holds by e-mail out of the box via `approvalPending`.

**Injection.** Worker-harness `inject.*`, `escape.and.locale`: employee names / reasons / comments / leave-type names / org display names containing `<script>`, `"><img onerror>`, `javascript:`, CRLF, and literal `{{var}}` are HTML-escaped in the e-mail body (`&lt;script&gt;…`), the subject is one line, body is length-capped (509 chars), and a user-supplied `{{org}}` stays literal (no re-interpolation). The only tags in the Arabic/English HTML are the layout's own `<meta>` (viewport, color-scheme) — no `script`/`img`/`svg`/`iframe`/`on*`/`javascript:`. `interpolate` never re-expands, `oneLine` collapses control chars, `escapeHtml` is applied in `renderEmail`.

**Deep links.** Worker-harness `links.checked {checked:684, bad:[]}` — no link escaped the web origin under crafted ids/dates (`//evil`, `../`, `javascript:`, encoded slashes); `webUrl` (`outbox.ts:294`) requires a leading `/` and rejects `//`.

**One-click tokens.** Minted per recipient per level in the org's system context (`oneClickLinks`, `issueApprovalEmailTokens` hashes at rest, `packages/database/src/approval-tokens.ts:17-27`); the action page POSTs only on explicit click (`email-action-page.tsx:46`); `email-tokens.ts:41` passes `requireSeat: true`, so a token for a seat you no longer hold is refused (`engine.ts:390`). Committed `approvals.test.ts:473-485` covers single-use/expiry/409.

**Recipients.** Worker-harness `recipients`: an outsider / removed member / unknown id / non-uuid gets nothing; a disabled profile gets an in-app row but its e-mail is `skipped: recipient_disabled` (`outbox.ts:346-349`); the mailer only ever receives the recipient's own address (the delivery query joins `user_profiles u on u.id = n.user_id`, `outbox.ts:337`).

**Data whitelist.** Worker-harness `data.scan` over 310 synthetic rows and API-harness `flow.dataLeaks []`: stored `data` keys are the whitelist only (aggregateId/Type, dates, ids, entityType, counts, excerpt, question, decision, …) — no e-mails, no employee numbers, no non-whitelisted user ids. (The one `data.scan` "e-mail-like" hit is the injection fixture's literal `<script>alert(1)</script>"@…` text in `employeeName`, not a real address.)

**RLS + settings guard.** RLS suite: 42 `ok` in `rls_notifications.sql` — preferences own-rows-only (write/update/move/hand-off/delete of another's row all refused), notifications own-only, deliveries + ledger invisible to clients, the relay reader not client-callable, cross-tenant zero, and the group guard (org.manage cannot change notifications; notification.manage cannot change other groups; a mixed write is refused whole). `rev8-settings-guard.sql` P1/P2/P4/P5 reproduce the same guard behaviour directly. (The guard's one gap is P0-2 above: it does not police `organization_id`.)

**Preferences API.** API-harness `prefs`: suspended member GET/PUT → 403/403; other-org GET/PUT → 403/403; a non-configurable IN_APP write is accepted but the resulting cell stays `enabled:false` with `alwaysOn` listing the ★ types; a not-relevant category PUT is accepted (200) and ignored. Committed `notifications.test.ts:89-107` covers SYSTEM/PAYROLL/SMS/duplicate/empty/cross-user/cross-org rejections (400/403).

**Missing check-out reminder.** Worker-harness: exactly **1** event under 3 concurrent ticks (`mp.concurrent`); none before threshold and one after (`mp.la`, `mp.ki` — LA and Kiritimati night shifts across midnight remind once at the right minute); a no-login employee → ledger row with 0 recipients, no event; terminated employee still reminded (they have an open punch), suspended org skipped, org failure isolated (`mp.misc`, `mp.isolation` — `errors:1` did not stop the others); stale cut-off at 12 h holds (`mp.stale`: sent at 11:59, not at 12:01); approved full-day leave skipped, half-day handled by the engine's midpoint `expected_end_at` (`mp.halfday` — both a first-half and a second-half employee reminded correctly at their real shift end; domain `calculate.test.ts:366-388` pins the midpoint). EXPLAIN at 2,000 employees (`rev8-mp-explain.sql`): **12.7 ms**, driven by a Bitmap Index Scan on `attendance_daily_records_date_branch_idx`.

**Relay robustness.** Worker-harness `relay.concurrent`: 3 concurrent relays over 40 events → exactly 40 notices (savepoint per event, `outbox.ts:242`; 15-min dedupe for non-targeted routes, `:98,193`). `relay.deadletter`: a poisoned event is retried every run and left unpublished at `publish_attempts 20` (`MAX_PUBLISH_ATTEMPTS`) while 22 good events publish through it.

**Localisation.** Worker-harness `ar.mail`: `<html lang="ar" dir="rtl">`, a plain-text part present, subject in Arabic; `tz.selfie`/`ar.latin` show org-timezone dates (00:30 Muscat). `rev8-locale-parity.py`: en/ar parity 28/28 (notification-preferences) and 25/25 (settings notifications); the two "latin/untranslated" ar hits are the language selector's own label `English` and the `{{category}}: {{channel}}` interpolation key, both intentional. Locale fallback: profile → org → en (an `fr` profile in an `ar` org renders `ar`, `escape.and.locale`).

**Web.** Playwright (390 px): the preferences card renders on `/my/profile` (en+ar) and `/settings/notifications`; the six System/Subscription switches are `disabled` with the two explanatory notes; without `notification.manage` the org switches are read-only with the note and the member's own e-mail switches stay enabled (`settings.withoutKey`); a `notification.manage`-only member can PUT the group but cannot write `/settings/security` (`settings.notifOnly`); the card's language select only PATCHes `/me` and leaves the UI language and switcher untouched (`language.select navStillEnglish:false, storedUiLocale:"en"`); RTL applies (`dir:"rtl"`). The 390 px overflow (`scrollWidth 464`) comes from the pre-existing topbar (offenders are the `ms-auto` avatar/language cluster at right 464; the card is 358 px wide) — not from the Prompt 8 card.

**Old bundle tolerates the new categories.** The live `1dc82a9` notifications page renders the category as a raw badge with `CATEGORY_TONE[…] ?? 'neutral'` (`main-web/…/notifications-page.tsx:11,28`), so `LEAVE`/`REPORTS` show as a grey badge, not a crash; the inbox `in_app` filter is server-side (`me.service`), and the endpoints it calls (`/me/notifications`, `/unread-count`, `/read-all`, `/:id/read`) are unchanged (`apps/api/src/routes/v1/me.ts:14-21`). The only main-bundle breakage is the two dead links in P2-4/P2-5.

---

## 4. ATT / B items

| Item | State | Evidence |
|---|---|---|
| ATT-76 (manager notified on submit) | ✓ | `attendance.note_submitted` routed to the line managers not seated (`ROUTING`, catalogue); committed portal tests. |
| ATT-85 (decision with outcome-specific title + deduction/LOP text) | ◐ | Titles/variants correct (`note_decided#rejected_leave/_lop`), but Arabic prints the Latin leave code and English name — P2-2. |
| ATT-98 (selfie submission → manager notified) | ✓ | `attendance.selfie_submitted` targeted; `tz.selfie` link `/attendance/notes?tab=selfies`. |
| ATT-99 (selfie decision → employee notified) | ✓ | `attendance.selfie_decided` variants approved/rejected, org-tz timestamp. |
| B-26 (reviewed note notifies the employee with a portal link) | ✓ | `attendance.note_decided` → the employee; link `/my/requests?tab=reasons&date=` (route exists on `e760ba2`). |
| B-66 (line-manager bell → portal Approvals) | ◐ | The routing data + `/approvals?request=` link exist; the inbox is reachable by any member (`useApprovalAccess.inbox = !!membership`, `approvals-page.tsx:55` reads `?request=`). No dedicated bell→portal redirect is on this branch (Prompt 5). |
| B-90 (each newly active level e-mails its approvers) | ✓ (one gap) | `approval.pending` at each level with one-click; **except** the escalation link on a multi-seat level — P1-2. |
| B-100 (more-info: both sides notified in-app and by e-mail) | ✓ | `approval.info_requested` (requester) + `leave.info_requested`/`attendance.note_info_requested` (subject) + `approval.info_answered` (approvers). Caveat: an answer via note-edit reads as "changed" — P2-8. |
| B-102 (daily reminders for pending approvals) | ◐ | 24 h reminder once per level + escalation + 08:00 digest, facts per entity. The digest **e-mail** is now off by default (`dailyDigest=false`); the per-request 24 h reminder still e-mails, so B-102 holds by e-mail. Documented behaviour change. Caveat: reminders fire during a pending question — P2-1. |

---

## 5. Not satisfied / behaviour changes to note

- **P0-1 / P0-2** are the material failures against "outbox tables have no client policies" (`blueprint.md:417`) and against the intent of the `notification.manage` delegation.
- **B-102 digest** now defaults to no e-mail (`dailyDigest=false`) — intended and documented, but a change from Prompt 2's "mail everyone".
- **P1-4** leaves a class of members (no `organization.view`, no employee link) with no reachable preferences page though the e-mail footer points them at one.
- Deep-link drift (**P2-4**, **P2-5**) breaks `punch.missing_out` on the live bundle during a deploy window and `employee.imported` on both bundles.

---

## 6. Scratch inventory (`scratchpad/rev8/`)

- Gate runner + logs: `rev8-gates.sh`, `gates/*.log`, `gates/summary.txt`; re-apply `rev8-reapply-1/2.log`; db:types `rev8-dbtypes2.log`.
- SQL probes (rolled back on `flowza_rev8`): `rev8-forge-event.sql/.log`, `rev8-settings-guard.sql/.log`, `rev8-settings-move.sql/.log`, `rev8-settings-move-mfa.sql/.log`, `rev8-settings-delete.sql/.log`, `rev8-mp-explain.sql/.log`.
- Worker-harness output: `rev8-probe-out.jsonl`, `rev8-probe2-out.jsonl` (from throwaway `apps/worker/.../rev8-probe*.test.ts`, since deleted).
- API-harness output: `rev8-api-out.jsonl` (from throwaway `apps/api/.../rev8-probe.test.ts`, deleted).
- Playwright output: `rev8-e2e-out.jsonl`, `rev8-profile-{en,ar}.png`, `rev8-settings-{nokey,ar}.png` (from throwaway `apps/web/e2e/rev8-probe.spec.ts`, deleted).
- Link checks: `rev8-main-links.mjs` (vs `1dc82a9`, `main-web/`), `rev8-new-links.mjs` (vs `e760ba2`).
- Helpers: `rev8-emits.py`, `rev8-locale-parity.py`, `rev8-tags.py`.

Evidence only — every claim above is backed by a probe whose output is in one of these files.
