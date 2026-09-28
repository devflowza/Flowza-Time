# Prompt 4 review — employee portal attendance (adversarial pass "rev4")

Commit under test: `ddc1cef` (integrated branch after `ce22056` merge of Prompt 4). Worktree `agent-ab708477a5f26f3c6`, reset to `ddc1cef`; `git status` clean at the end (every throwaway test was copied in, run, and deleted).
Databases used: `flowza_rev4` (seeded), `flowza_rev4_rls` (RLS suite + SQL probes), `flowza_rev4_ci2` (fresh replay, API probe run 1), `flowza_rev4_tx` (single-transaction replay, API probe runs 2–3).
Evidence files (all under `scratchpad/rev4/`): `rev4-api-evidence.jsonl` (every API probe's raw output), `rev4-rls-probe.sql` + `.out`, `rev4-engine-geofence.mjs` + `.out.json`, `rev4-web-evidence.json`, `rev4-e2e-evidence-{en,ar}.json` + `rev4-shot-*.png`, `rev4-i18n*.mjs` + `.out.json`, gate logs `rev4-g-*.log`, probe sources `rev4-punch.test.ts`, `rev4-requests.test.ts`, `rev4-requests2.test.ts`, `rev4-offline.test.tsx`, `rev4-mobile.spec.ts`.

## 1. Gates

| Gate | Result | Counts / notes |
|---|---|---|
| lint (`eslint . --max-warnings 0`) | pass | 0 warnings |
| typecheck (api, worker, web) | pass | |
| unit (packages) | pass | shared 4/4 (1 file) · contracts 5/5 (1) · domain 281/281 (21) · device-providers 286/286 (9) · database 20/20 (2) |
| web vitest | pass | 67 files · 308 tests |
| RLS suite (`flowza_rev4_rls`) | pass | 314 `ok` notices + the silent portal asserts; "RLS tests passed" |
| test:db | pass | 3 files · 15 tests |
| API vitest | 334 pass · 1 fail | 28 files (27 pass). The one failure is the known intermittent **P2-13** in `approvals-review.test.ts` — excluded as instructed |
| worker vitest | pass | 16 files · 159 pass · 1 skipped |
| build | pass | main chunk 854.85 kB (Vite >700 kB warning, pre-existing) |
| fresh replay (`flowza_rev4_ci2`) + re-apply over itself | pass | |
| seeded re-apply (`flowza_rev4`) | idempotent except 1 table | row counts identical; content hash of `public.device_providers` changes (`updated_at = now()` in the `on conflict … do update` of the Prompt 4 `self_service` upsert and the Finance-connector upserts) — see P2-19 |
| db:types | pass | regenerated `db.ts` diff = empty |
| single-transaction replay (`flowza_rev4_tx`) | pass | "single-transaction replay OK" |
| build:e2e + Playwright | pass | 48 passed (chromium + tablet) |

## 2. Defects

### P0 — security

**P0-1. A branch-scoped geofence manager can edit / delete organisation-wide fences and any fence assignment directly through PostgREST (the API's branch checks are bypassed).**
- Where: `supabase/migrations/20260928000500_portal_attendance_self_service.sql:261` (`apply_tenant_policies('public.geofences', 'attendance.view', 'attendance.manage_geofences', 'branch_id')`) and `:280` (`geofence_assignments` with no branch column at all). The generator (`20260928000100_roles_manager_and_permissions.sql:205-207`) makes the branch predicate `… or branch_id is null or branch_id = any(allowed_branch_ids)` and uses it for INSERT / UPDATE / DELETE too. `supabase/config.toml:7` exposes `public` through PostgREST, so any signed-in member can issue these writes with their JWT.
- Probe (`rev4-rls-probe.sql`, `set local role authenticated` + the JWT of a member scoped to branch A-2 holding `attendance.view` + `attendance.manage_geofences`, rolled back):
  - P-A1 UPDATE the org-wide fence (radius 4999 m, enforcement → `advisory_log`) → **1 row**
  - P-A2 move the member's own branch fence to organisation-wide (`branch_id := null`) → **1 row**
  - P-A3 INSERT an assignment of the HQ fence (another branch; not even readable by the caller) to an HQ employee → **1 row**
  - P-A4 INSERT an organisation-scope assignment → **1 row**
  - P-A5 DELETE the HQ fence's own assignment → **1 row**
  - P-A6 DELETE the org-wide fence → **1 row**
  - control: UPDATE the HQ fence itself → 0 rows
  - The API refuses the same member (API probe P13: PATCH / POST / DELETE of an org-wide fence → 403 ×3), so the API rule and the RLS rule disagree and the looser one is reachable.
- Impact: a branch-limited HR role can loosen every branch's hard-block fence (or delete other branches' assignments), silently turning geo-enforced check-in into advisory logging organisation-wide.
- Fix: treat both tables like the other portal tables — `app.deny_client_writes(...)` and perform writes in the system scope after the service's branch checks — or generate write policies where `branch_id is null` requires unrestricted access, and where an assignment is checked against its fence's branch and its target's branch.

**P0-2. Segregation of duties: the swap colleague decides the swap of their own shift.**
- Where: `apps/api/src/services/portal/shift.service.ts:156` submits the request with `employeeId: me.id` only; the engine's SoD test (`apps/api/src/services/approvals/engine.ts:83-85` `isRequestSubject`) knows only the requester; `seatSecondaryManager` (`line-manager.ts:25`) excludes the subject/requester, never the target; the SHIFT_SWAP hook re-validates shifts but not who decided.
- Probes (all 200, swap applied):
  - S1 (`rev4-requests.test.ts`): e1 swaps with e3 = e1's own primary manager; `managerUser` (e3's login) is the seated approver → `decide APPROVE` **200**; e3's own assignments become `2026-01-01→2026-10-01 EVE · 2026-10-01→2026-10-02 MORN · 2026-10-02→null EVE`.
  - S2 (`rev4-requests2.test.ts`): requester without a manager → HR admins seated (`hrAdmin`, `hrS`); `hrS` is the colleague (hr_admin linked to the target employee) → **200**, swap `approved`.
  - S2b: the colleague is the requester's secondary manager, seated as the stand-in (`resolution_path = secondary`) → **200**.
- Expected: 403 (the counterparty is removed from the eligible set / refused at decision, like the subject), with fallback to the next rung.
- Fix: record the target as a second subject of SHIFT_SWAP requests (e.g. `counterpartyEmployeeId` / `counterpartyUserId`) and make `isRequestSubject`, approver resolution and `seatSecondaryManager` honour it; refuse in `decideWithin` when the decider's live link is the target.

**P0-3. The offline punch queue is per organisation, not per user: a punch queued by user A is replayed with user B's credentials on the same browser.**
- Where: `apps/web/src/features/portal/offline-queue.ts:12-25` (`QueuedPunch` carries no user), `:91` (`queuedPunches` filters by `orgId` only); `use-offline-punches.ts:73-78` replays automatically on mount / `online`; `features/auth/auth-provider.tsx:23-24` clears the query cache and the cached `/me` on a user change but never the IndexedDB queue (`flowza-offline` persists).
- Probe W1 (`rev4-offline.test.tsx`, throwaway vitest): the store holds a punch queued by user A (`direction in`, lat 23.61 / lng 58.54, key `user-a-key-1`); user B opens `/my/checkin` → the page immediately POSTs `/me/punch` with **A's direction, coordinates and idempotency key** under B's session (`postedPunches` in `rev4-web-evidence.json`); queue emptied. The API derives the employee from the caller, so A's check-in (and A's location) is recorded on B's day and A loses it.
- Preconditions: shared browser profile / kiosk / family device, same organisation, A queued offline and did not sync before signing out.
- Fix: store `userId` + `employeeId` with every queued punch; replay only the signed-in user's items; clear (or quarantine and ask) other users' items on sign-in / sign-out and on the user change the AuthProvider already detects.

### P1 — functional

**P1-4. A check-out within `duplicatePunchSeconds` (default 60 s) of a check-in is refused as `DUPLICATE_PUNCH`, and the web's offline replay then drops it as "synced".**
- Server: `apps/api/src/services/portal/punch.service.ts:134-135` — `const lastSelf = recent.find((r) => r.source === 'SELF_SERVICE'); if (dupSeconds > 0 && lastSelf && … ) refusals.push('DUPLICATE_PUNCH')` is direction-agnostic. (The selfie path at `:355-360` filters on the same direction — "a second selfie of the same direction … is a double tap" — the punch path does not.)
- Web: `apps/web/src/features/portal/use-offline-punches.ts:21-25` maps `DUPLICATE_PUNCH` to `{ kind: 'sent' }`, on the (false) premise that "the server already holds a punch of that direction".
- Probe P3b (`rev4-requests.test.ts`, fresh employee, default settings): `in` → 201; `out` right after → **409 CONFLICT `{ reason: DUPLICATE_PUNCH }`**; raw ledger holds `["in"]` only.
- Probe W2: replaying a queued `[in, out]` pair with that server answer → `replayQueue` result `{ sent: 2, refused: 0, remaining: 0 }` — the toast says 2 synced, the check-out is gone and the day ends as a missing punch with nothing telling the employee to regularise it. Every offline in/out pair replayed together hits this (both are sent within seconds of each other).
- Fix: make the window direction-aware (same direction within N s = double tap; opposite direction is judged by the sequence rules), and have the web treat `DUPLICATE_PUNCH` as recorded only when the refused punch has the direction of the last recorded one.

**P1-5. Editing a PENDING reason keeps its approval request; a level-1 approval of the old text carries over to the rewritten note.**
- Where: `apps/api/src/services/portal/notes.service.ts:147` — `const resubmit = before.status === 'info_requested';` (only an answer to a question invalidates and re-routes). This contradicts the report (§3 decision 8: "Editing a pending note … invalidates its request and submits a fresh one (B8)"; the Appendix B row "editing a note invalidates its request") and the engine rule "invalidate on material change".
- Probe N2a: PATCH a pending note (text + category) → 200; request list after = `[PENDING, same id]`; audit `attendance.note_updated` (not `…resubmitted`).
- Probe N2b (two-level ATTENDANCE_NOTE workflow MANAGER → HR_ADMIN): level 1 approves "Text A…" → the employee PATCHes to "Text B: a completely different story", category `wfh` → request stays **PENDING at step 2 with level 1 APPROVED**; HR approves level 2 → note `approved` with text B. The manager's approval stands for text they never saw.
- Fix: invalidate + re-route on every edit of an open note (as decision 8 states), or refuse edits of a pending note once any level has decided.

**P1-6. A `wrong_punch` regularisation with only one proposed time edits the day's opposite punch.**
- Where: `apps/api/src/services/portal/regularisation-effects.ts:66-67` — `outTarget = … ?? [...events].reverse().find((e) => e.id !== inTarget?.id)` (and `inTarget = … ?? events[0]`): when the day has no check-out, the fallback picks the check-in (and vice versa).
- Probe R1: day with one `PUNCH_IN` 06:30Z; `wrong_punch` with `proposedOutAt 13:00Z` only; approved → correction `EDIT_PUNCH` of **the day's check-in** with `proposedEventType PUNCH_OUT` — applying it voids the only check-in.
- Probe R1b: day with one `PUNCH_OUT` 13:30Z; `wrong_punch` with `proposedInAt` only → `EDIT_PUNCH` of **the day's check-out** into a `PUNCH_IN`.
- Fix: only edit a punch of the proposed direction (or of unknown direction `PUNCH`); otherwise ADD the proposed punch.

### P2 — minor

**P2-7. The engine raises `OUTSIDE_GEOFENCE` when the location is unknown** (B-36 / ATT-67 truth table). `packages/domain/src/attendance/calculate.ts:27` flags any punch with `isMock` regardless of the verdict, and `:15` counts verdict `flagged` (which the punch service also stores for `location_missing` / `gps_accuracy_too_low`). Engine probe (`rev4-engine-geofence.out.json`, built domain): mock + no fence assigned → OUTSIDE_GEOFENCE; mock + geofencing **off** → OUTSIDE_GEOFENCE; no coordinates on a soft fence (`flagged`, `location_missing`) → OUTSIDE_GEOFENCE; no fence / geofencing off without mock → no flag; inside → no flag. API P9/P10 confirm these payloads are what gets stored. Finance's `_attendance_geofence_pass` gives NULL for no coordinates and for `no_fences_assigned`. The report's ATT-67 row ("only when a real fence was evaluated and failed") is contradicted by the no-coordinates case; an organisation with geofencing off still gets OUTSIDE_GEOFENCE exceptions. Fix: flag only when a fence was evaluated with a location (map no-coords / no-fence / off to "unknown").

**P2-8. The web/mobile switches trust the client-declared channel.** `punch.service.ts:105-106` judges `input.channel` from the body. Probe P4: `webCheckIn=false, mobileCheckIn=true`, a desktop-Chrome request with `channel: 'mobile'` → **201**, stored `channel: mobile` with the Chrome user agent. Low impact (geofence / IP / window rules still apply), but the switch is not a control. Fix: derive the channel server-side (client id / app attestation) or document the switches as UX only.

**P2-9. Regularisations bypass `allowSelfServiceCorrections = false` (the default) and the "status is HR's" rule.** `regularisations.service.ts:22,56+` never reads the switch; `regularisation-effects.ts:79` creates `SET_STATUS PRESENT` corrections. Probe R3: with the switch off, a self-correction `SET_STATUS` → 403 "Only HR can change the status of a day"; `ADD_PUNCH` → 403 "Self-service corrections are turned off"; a `wfh_unmarked` regularisation → 201, approved by the line manager (hr_user role **without** `attendance.approve`) → corrections `ADD_PUNCH:PUNCH_IN:APPROVED`, `SET_STATUS:PRESENT:APPROVED`. Decide whether regularisations need their own switch and whether SET_STATUS needs an HR level.

**P2-10. A pending self-correction and a regularisation for the same instant both apply.** The regularisation hook inserts corrections without the "equivalent correction pending / approved" check `createCorrection` applies. Probe R2 (`rev4-requests2.test.ts`): ADD_PUNCH 05:00Z self-correction (seated: `owner`, `hrAdmin`; approved by the owner) + `missed_punch` 05:00Z regularisation (approved by the manager) → **2 approved ADD_PUNCH corrections for the same instant, 2 APPLY_CORRECTION jobs**. (The engine may collapse the duplicate events; the correction trail is duplicated either way.)

**P2-11. Swap approval does not re-check the colleague's employment.** `swap-effects.ts:56-66` re-validates shifts only. Probe S3: colleague terminated (exit today) after the request → approval **200**; the terminated colleague gets `2026-10-05→2026-10-06 MORN` after their exit date.

**P2-12. Concurrent swap requests naming the same colleague and day both succeed.** `shift.service.ts:139` locks only the requester (`lockEmployee(trx, 'shift-swap', self.employeeId)`), the clash check at `:150` races. Probe S6: two colleagues file with e1 for the same day in parallel → **201, 201**, 2 pending swaps involving e1 (the second approval would then fail re-validation, leaving a stale request and a double notice).

**P2-13. After a future-dated transfer the shift tab and the swap rules use the new branch for days before the transfer.** `employees.service.ts:394` PATCH updates `employees.branch_id` immediately (the history transition at `:391` starts at `effectiveFrom`); `shift-resolve.ts:66` and `shift.service.ts:147` use the current row, while `GET /shifts/resolve` (`schedule.service.ts:265-270`) and the engine use employment history. Probe S5 (transfer A→B effective today+7; branch assignments A=Morning, B=Evening): `/me/shift` today = **Evening**, `/shifts/resolve` today = **Morning**; swap candidates before the transfer date list branch-B colleagues (`includesBranchB_e2: true`, `includesBranchA_e1: false`).

**P2-14. Two different attendance percentages on `/my/attendance`, and today's running day is counted.** `packages/domain/src/attendance/self-stats.ts:42` excludes LEAVE from working days; the month card (`self-service.service.ts:116-129`, same page, `attendance-page.tsx:211`) counts it. Probe E1 (same 11 seeded days): stats tab **78.6 %** (7 working days), month card **61.1 %** (9 working days). `self-stats.ts:77` includes today: a check-in still open today counts as a missing check-out (`missingCheckouts: 2`, hint `missing_checkouts`) — the overview's `reasonsRequired` excludes today for exactly this reason. Finance B-13 counts working days from the calendar (weekends and holidays excluded, leave included).

**P2-15. `/my/shift` overflows horizontally at 390 px (en and ar).** `apps/web/src/features/portal/pages/shift-page.tsx:58` — the grid items have no `min-w-0`, so the `truncate` on the day rows cannot shrink the card. Playwright probe (`rev4-mobile.spec.ts`, 390×844): document `scrollWidth` **961** (en) / **905** (ar) vs `clientWidth` 390; screenshot `rev4-shot-en-_my_shift.png` shows the "Next 14 days" rows cut off. (Separately, every page at 390 px scrolls to 464 / 453 px because of the global top bar, `components/layout/topbar.tsx:56` — not changed by Prompt 4, last touched in `de24b1c`; in Arabic it clips the check-in heading, `rev4-shot-ar-_my_checkin.png`.)

**P2-16. No accuracy warning above 50 m (B-31).** `checkin-page.tsx:162` shows `±N m` only; the "imprecise" text appears only when the server returns `gps_accuracy_too_low` against the fence's threshold (default 100 m). Probe W3: a 90 m fix inside the zone → banner "Inside HQ — You are inside your work zone. You can punch.", no warning.

**P2-17. Selfie validation is a magic-byte sniff.** `punch.service.ts:301-303`. Probe P13: `FF D8 FF` + `<script>alert(1)</script>…` → **201**, stored as `image/jpeg` (`checkins/<org>/<employee>/<uuid>.jpg`). Low risk (private bucket, 60 s signed URL, image content type), but not an image. Decode / re-encode (or at least parse the JPEG/PNG structure) before storing.

**P2-18. The IP allow-list trusts client-supplied headers until `EDGE_SHARED_SECRET` is set, and nothing enforces it in production.** `apps/api/src/lib/http.ts:40-54`, `config.ts:29-35`. Probe P5: production shape (`CLIENT_IP_HEADER=cf-connecting-ip`, `TRUSTED_PROXY_HOPS=2`) accepts `cf-connecting-ip: 10.1.1.1` or `X-Forwarded-For: 10.1.1.1, <proxy>` as the allowed address; with the edge secret configured a direct-origin request is refused (403). Documented as a go-live precondition (`docs/go-live.md:150-177`, `fly.api.toml:18,42`); the allow-list is a new Prompt 4 enforcement point, so refusing to start (or ignoring `ipAllowList`) in production without the secret would make the precondition fail closed.

**P2-19. Migration re-apply is not byte-idempotent.** Re-applying all migrations over the seeded DB changes only `public.device_providers` (`updated_at = now()` in the upserts, including Prompt 4's `self_service` row at `20260928000500_…:43-53`). Harmless; drop `updated_at = now()` from the `do update` unless a column changed.

## 3. Verified correct (evidence)

- **Server time decides** (P1): `punchedAt` within 1 s of the server clock with client `punchedAt/timestamp = 2020-01-01`; `clientQueuedAt` kept in the payload only.
- **Idempotency under concurrency** (P2): 6 parallel requests with one key → one 201 + five 200 `replayed`, 1 raw row.
- **Sequence and window rules**: ALREADY_CHECKED_IN / NOT_CHECKED_IN refusals (P3/P5); out-of-window `accept` stores silently (`outOfWindowAccepted: true`, no flag) (P6).
- **IP**: a spoofed left-most XFF entry is ignored (hop counting from the right) → IP_NOT_ALLOWED; `TRUST_PROXY=false` ignores XFF; the edge gate refuses direct-origin requests (P5).
- **Virtual device is invisible / untouchable** (P12): delete, decommission, credentials, push-token rotate, logs, employees, commands → 404; sync attendance / employees / health-check → 409; group membership → 400; absent from reconciliation and the provider catalogue; `providerKey: self_service` on device create → 400.
- **Selfie**: GIF / PDF / SVG → 400; >2 MB → 413 (JSON and multipart); a traversal file name is ignored (server-built path); branch-B HR user / HR admin → 404 on photo, review and list; another org's owner → 403; two simultaneous approvals → 200 + 409, exactly one raw `face` punch, linked (P13). Storage: no `checkins/` object readable by a secondary manager, org-B owner, `anon` (permission denied) or `flowza_system` (no storage usage) (`rev4-rls-probe.out`).
- **Geofence API branch scope** (P13): branch-scoped HR admin PATCH / POST / DELETE of org-wide fences → 403 (the RLS gap is P0-1).
- **Reasons**: 5 parallel submits → one 201, four 409, 1 note, 1 request (N1); another employee's PATCH → 404 (N2a); reject charges AL, re-filing keeps the decided charge, approve reverses it exactly once (`AL:CANCELLED`, both marks revoked), re-approve → 409 (N6); manager reject and HR approve at the same time → 200 + 409, one outcome; two simultaneous full-day rejections → leave charged once (N10); request-info / answer-info through the inbox keeps note and request in step (N8); legacy `/approve` and `/reject` with `{ comment }` only → 200, rejection without pay effect = `UNEXCUSED:NOTE_REVIEW:0`, no charge; HR oversight on the alias without `stepNo` → 400 with a clear message (N9); a seated manager whose login is re-linked to the subject → 403 on both the notes endpoint and the inbox (N4); scopes: hr_user of branch B sees none of branch A's reasons and cannot review them (403), auditor → 403 on `scope=all` and review, branch manager B → empty list / 403 review, manager role (no `attendance.view`) → 403 on `scope=all`, all-branch hr_user sees them (N7).
- **Regularisations**: two-level workflow applies only after the last level (0 corrections after level 1, 2 after level 2) (R4); a period locked between submit and approval → 409 PERIOD_LOCKED, request stays PENDING, submit on the locked day → 409, approve after unlock → 200 (R5); legacy `/reject` with `{ comment }` → 200, `rejected` (R6).
- **Swaps**: a rejected swap leaves every assignment untouched (S4).
- **Backward compatibility** (B1/B2): `/me/profile`, `/me/overview` (+ `month.totals`), `/me/attendance?month`, `/me/leave?year` and a leave record keep every `1dc82a9` key; the `1dc82a9` leave apply body → 201 and cancel → 200 (`CANCELLED`, request `CANCELLED`); `GET /approvals/inbox` → 200.
- **i18n**: en/ar parity for `portal-attendance` (303 / 351 keys), `attendance-review` (241 / 245), `approvals`, `portal`, `common` — no key missing on either side (extra ar keys are plural forms), no empty or untranslated ar values, every static `t('…')` key and every dynamic family (verdicts, refusals, geo errors, categories, statuses, decisions, charges, hints) resolves in both languages.
- **RTL / phone**: all six Prompt 4 pages set `dir=rtl lang=ar`; the punch button is inside the 390 px viewport in both languages (en 37–197 px, ar 193–353 px); `/my/checkin`, `/my/requests`, notes review and geofences pages add no overflow of their own beyond the pre-existing top bar.

## 4. ATT / B items not satisfied (or only with a deviation)

- **ATT-63 / ATT-64** — Prompt 4 judges only the most specific scope's fences (decision 3); Finance's `evaluate_geofence` judges every assigned fence, worst verdict wins. P8: an employee-scope `soft_warn` fence makes an org-scope `hard_block` fence irrelevant (far from both → `flagged` instead of `denied_outside`; inside the employee fence but outside the org hard fence → `allowed`).
- **ATT-67 / B-36** — truth table differs from Finance for unknown locations (P2-7).
- **ATT-68 / B-33** — offline punches take the server time (decision 2; no batch endpoint, original timestamps not kept); the queue is per organisation, not per user (P0-3).
- **B-30** — "a duplicate answer counts as success" loses opposite-direction punches (P1-4).
- **B-31** — no accuracy warning above 50 m (P2-16).
- **B-8 / ATT-74 (as claimed in the report)** — editing a pending reason does not renew its request (P1-5).
- **ATT-82** — the default exclusion list (`SL, ML, PTL, HJ`, `packages/contracts/src/organizations.ts:145`) lacks Finance's MARRIAGE, BEREAVEMENT, ADOPTION, COMPASSIONATE. Probe N5 (AL exhausted, MR 5 days, BRV 3, SL 10): a full-day rejection is charged to **MR** (marriage leave).
- **B-13** — attendance % excludes leave days from working days (Finance counts calendar working days) and counts missing-punch days as present; the portal shows a second, different % on the same page (P2-14).
- **ATT-106 / B-40** — the approval step exists but the counterparty can decide it (P0-2); approval does not re-check the colleague's employment (P2-11).
- Documented partials, confirmed: ATT-62 (no Wi-Fi SSID), ATT-66 (no map editor), B-39 (no "available shifts" list), ATT-100 (no face match).
