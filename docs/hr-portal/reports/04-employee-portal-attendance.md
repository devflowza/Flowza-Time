# Phase 4 — Employee portal: reasons, regularisation, check-in/out, selfie, shift

**Prompt:** `docs/hr-portal/prompt-pack.md` §Prompt 4 (+ the implementing brief: RPC-only self-service tables, the per-organisation self-service virtual device, `evaluateGeofence` / `computeSelfStats`, the self-service and manager / HR endpoints, the `/my` pages, the notes review page, geofences, grants, Playwright).
**Branch:** worktree branch `worktree-agent-a98ce3a1dca0539b3` (from `ba825d2`) · **Migration:** `supabase/migrations/20260928000500_portal_attendance_self_service.sql` · **Date:** 2026-09-28.
**Status:** every gate green on this branch (§8), including the single-transaction replay. **Not merged with `claude/modest-fermi-fnwqq7`** — the merge was refused by this session's permission system (§6); nothing applied to the hosted project.

## 1. What shipped

### Database (one additive, idempotent migration; single-transaction safe)
- `raw_source` += `SELF_SERVICE` (never used inside the file — the application writes it at runtime).
- Reference rows for the virtual provider `self_service` (`device_providers`, `device_models`); no provider implementation (nothing is ever sent to it).
- Enums `attendance_note_category`, `attendance_note_status`, `regularisation_type`, `regularisation_status`, `selfie_checkin_status`, `geofence_enforcement`, `geofence_scope`, `shift_swap_status` (mirrored in `packages/contracts/src/enums.ts`).
- Tables (RLS through the tenant generators):
  | Table | Purpose | Writes |
  |---|---|---|
  | `attendance_notes` | per-day reason; partial unique `(org, employee, date) where status <> 'rejected'`; pay effect, LOP, charged leave record, day mark, engine request, excuse stamps | API only (system context) |
  | `attendance_regularisation_requests` | missed / wrong punch, WFH unmarked, system downtime; applied through `attendance_corrections` | API only |
  | `employee_attendance_grants` | per-employee open (selfie) attendance / selfie required | API only |
  | `selfie_checkins` | pending selfie punches, photo path, location, verdict, review, raw transaction written on approval | API only |
  | `geofences` + `geofence_assignments` | circle (mandatory) + optional polygon, enforcement, accuracy threshold, grace, active dates, weekly local windows; assignments by scope with priority and check-in / check-out switches | `attendance.manage_geofences` (RLS twice with the API) |
  | `shift_swap_requests` | one-day swap between two colleagues; the two one-day assignments written on approval | API only |
- The five self-service tables are READ by the organisation-wide key (`attendance.view`, branch-scoped where the table has a branch), the employee's own rows, and line managers holding `attendance.view_team` for direct reports (swaps: either party). They are written only by the system context: client INSERT / UPDATE / DELETE privileges are revoked and `app.deny_client_writes` adds three explicit restrictive denials that survive a later GRANT.
- `flowza_selfie_photos_deny_client`: a restrictive storage policy that denies `anon`, `authenticated` and `flowza_system` every operation on `employee-photos/checkins/%` (§4).
- `attendance_corrections.device_id` (nullable FK): the device a correction's punch stands for — the self-service device for regularisations; the worker copies it onto the CORRECTION event.
- Post-verify block fails the migration on any missing piece (enum value, provider, no permissive client write policy, 3 denials each, no write privilege, system-write policy, self/team predicates, geofence write key, one-active-note index, `device_id`, the storage denial).

### Contracts (`packages/contracts`)
`dto/portal-attendance.ts` (inputs + DTOs for punch / preview / status, selfies, notes + review, regularisations, grants, geofences + evaluate, shift tab + swaps + candidates, stats), `enums.ts` (the enums above, `SELF_PUNCH_REFUSALS`, `SELF_SERVICE_PROVIDER_KEY`, `RAW_SOURCES` += `SELF_SERVICE`), `dto/self-service.ts` (additive overview fields), `dto-features/approvals.ts` (decide `payEffectDays`, three context kinds), `sync.ts` (nine domain events appended).

### Shared primitives (`packages/database`)
`attendance/self-service-device.ts` — `ensureSelfServiceDevice` (lazy, advisory-locked, `disabled`, no auto sync, no push token); `attendance/pay-effect.ts` — `reverseUnexcusedCharge` gains an optional `sources` filter.

### Domain (`packages/domain`)
- `geofence/evaluate.ts` — `evaluateGeofence` (pure): applicability (active, dates, local weekly windows incl. wrap past midnight, direction switches), scope precedence employee > team > department > branch > org (the most specific scope with an applicable fence is the ONLY one judged), inside = within radius + grace or inside the polygon / within grace of its edge with a fix at least as precise as the fence's threshold, mock location never inside, worst verdict wins (ties: priority, distance, id), the organisation policy caps enforcement (`off` → not evaluated, `flag` → never refuses, `block` → as configured), no applicable fence → `no_fence`.
- `attendance/self-stats.ts` — `computeSelfStats`, `punctualityWindows`, `selfStatsRange` (§3 decision 13).

### API (`apps/api`)
Self-service (the caller's own employee record — never an id from the client):

| Method | Route | What |
|---|---|---|
| GET | `/orgs/:orgId/me/punch/status` | today's punches, can check in / out, blockers, policy, grant, fences (for the nearest-zone hint) |
| POST | `/orgs/:orgId/me/punch/preview` | verdict + refusals for a location, nothing written |
| POST | `/orgs/:orgId/me/punch` | server-time punch (idempotency key); 201, or 200 `replayed` |
| POST | `/orgs/:orgId/me/selfie-checkin` | JSON (base64) or multipart; photo sniffed (JPEG / PNG / WebP, ≤ 2 MB), stored by the API |
| GET | `/orgs/:orgId/me/selfie-checkins` | own selfie check-ins |
| GET | `/orgs/:orgId/me/selfie-checkins/:id/photo` | 60-second signed URL of the caller's own photo (audited) |
| GET / POST / PATCH | `/orgs/:orgId/me/attendance/notes[/:id]` | own reasons; one active per day; an edit re-submits |
| GET / POST | `/orgs/:orgId/me/regularisations` | own regularisations; file one |
| POST | `/orgs/:orgId/me/regularisations/:id/cancel` | withdraw a pending one |
| GET | `/orgs/:orgId/me/shift` | today + next 14 days (source, shift, offs, holidays, leave, swaps) + assignment history |
| GET | `/orgs/:orgId/me/shift-swaps/candidates` | colleagues of the branch and their shift that day |
| GET / POST | `/orgs/:orgId/me/shift-swaps` | own swaps (asked for or naming me); request one |
| POST | `/orgs/:orgId/me/shift-swaps/:id/cancel` | withdraw a pending one |
| GET | `/orgs/:orgId/me/stats?range=30d\|month\|year` | own statistics, hints, punctuality |
| GET | `/orgs/:orgId/me/overview` (existing) | + `punch`, `pendingNotes`, `infoRequestedNotes`, `pendingRegularisations`, `pendingSwaps`, `reasonsRequired` (optional, additive) |

Manager / HR:

| Method | Route | What |
|---|---|---|
| GET | `/orgs/:orgId/attendance/notes?scope=mine\|team\|all` | review list (day status + flags, excused count this year, oversight flag, can-review) |
| POST | `/orgs/:orgId/attendance/notes/:id/review` | approve / excuse / request_info (question required) / reject (`payEffectDays` 0 / 0.5 / 1 required) |
| GET | `/orgs/:orgId/attendance/selfie-checkins` | selfie review list (`viaManager`, `canReview`, `canViewPhoto`) |
| GET | `/orgs/:orgId/attendance/selfie-checkins/:id/photo` | 60-second signed URL for the photo's viewers (audited) |
| POST | `/orgs/:orgId/attendance/selfie-checkins/:id/review` | approve (writes the raw punch) / reject (reason required) |
| GET / PUT | `/orgs/:orgId/employees/:id/attendance-grants` | open attendance / selfie required (line manager or attendance approver; never oneself) |
| GET / POST | `/orgs/:orgId/geofences` | list / create |
| GET / PATCH / DELETE | `/orgs/:orgId/geofences/:id` | read / partial update / delete (assignments cascade) |
| PUT | `/orgs/:orgId/geofences/:id/assignments` | replace the assignments as a whole |
| POST | `/orgs/:orgId/geofences/evaluate` | dry-run tester for an employee and a spot (nothing recorded) |
| POST | `/orgs/:orgId/approvals/:id/decide` (existing) | + optional `payEffectDays` for ATTENDANCE_NOTE rejections |

Approval engine: three entity hooks (`ATTENDANCE_NOTE`, `REGULARISATION`, `SHIFT_SWAP`) with inbox context cells and one-line summaries; `noWorkflow: { kind: 'MANAGER' }` routing; decision `detail` / `payEffectDays` handed to the hook and recorded on the timeline; optional `onInfoRequested` / `onInfoAnswered` hooks; `alsoApprovePermissions`; `managePermission` declared for the corrected engine's cancel rule. Device services refuse the virtual device (`self-service-device-guard.ts`) and every device list / count / search / plan-seat / sync resolution excludes it.

### Worker (`apps/worker`)
Normaliser: `SELF_SERVICE` rows become `MOBILE` events of the employee the row names (both markers — source and provider — must agree; a device-user id that looks like a uuid can never hijack it). Corrections carry `device_id` onto their CORRECTION events. Day close skips days with an open or accepted reason (`skippedNote`). The virtual device is excluded from the poll / health / reconciliation scheduler, employee pushes and usage metering. Nine notification routes appended (links to the portal tabs and review pages).

### Web (`apps/web`)
- Portal (`/my`): **Attendance** gains *Last 30 days* (status, times, worked, flags, the reason chip and *Add a reason* / *Edit* / *Answer* inline, "Reason required" where the organisation requires one) and *Statistics* (range chips, cards, punctuality windows, hints); the calendar marks days carrying a reason. **Check in / out** (`/my/checkin`): big button, geolocation with accuracy, nearest zone + distance, verdict banner (six verdict texts + low-accuracy / no-location / mock notes), blockers, server clock, offline queue (IndexedDB, memory fallback) with *waiting to sync / Sync now / Discard*, selfie capture (camera or file, JPEG re-encode ≤ 720 px) when granted. **My requests** (`/my/requests`): reasons, regularisations (+ *Request regularisation* dialog), swaps, selfies (+ *View photo*). **My shift** (`/my/shift`): today, next 14 days, history, swap dialog. Home: punch strip + pending items (incl. reasons required). Sidebar entries appended.
- HR / manager: `/attendance/notes` (scope chips, status filters, oversight banner, approve / reject with pay effect half / full / none / excuse / ask for info, excused-count badge; *Selfies* tab with photo on demand), `/attendance/geofences` (list, create / edit, assignments, dry-run tester), attendance grants card on the employee profile, approvals inbox context cells for the three entities and the pay-effect choice in the decision dialog.
- en + ar for every string (`portal-attendance`, `attendance-review` namespaces).

## 2. Acceptance items (Appendix A `ATT-*`, feature checklist `B-*`)

| Item | Status |
|---|---|
| ATT-45 one append-only ledger with a dedupe hash for device, portal and geo punches | ✓ portal / selfie punches are raw transactions of the virtual self-service device (same hash, same normaliser) |
| ATT-46 punches recompute their days | ✓ the normaliser is queued in the punch's transaction; it queues the recompute |
| ATT-60 circle / polygon fences, hard_block / soft_warn / advisory_log | ✓ |
| ATT-61 accuracy threshold, grace, priority, check-in / check-out switches, active dates, weekly windows | ✓ (windows in the branch's LOCAL time) |
| ATT-62 Wi-Fi SSID + IP CIDR co-validation; mock location | partial — IP / CIDR allow-list (organisation-wide, Prompt 3 setting) enforced; mock → `denied_mock` / flagged; Wi-Fi SSID n/a (a browser cannot read it; no mobile app yet) |
| ATT-63 scopes with precedence employee > team > site > org | ✓ plus `department` between team and branch |
| ATT-64 denied > flagged > logged > allowed; no fence = allowed | ✓ (`no_fence` = accepted, not judged) |
| ATT-65 denied not persisted; flagged accepted with warning | ✓ refusal audited (`attendance.self_punch_refused`) + manager notified; flagged stored with its flags + manager notified |
| ATT-66 map editor, enable switch, dry run | partial — numeric centre / radius, polygon as "lat, lng" lines, active switch, dry-run tester; no map / draw tools (§9) |
| ATT-67 truthful `within_geofence` | ✓ `OUTSIDE_GEOFENCE` only when a real fence was evaluated and failed (or a mock location); `no_fence` / `geofence_off` add no flag |
| ATT-68 geo check-in accepting offline batches keeping original timestamps | partial by decision — offline punches replay one by one with idempotency keys; the server clock is authoritative, the queued time is kept in the payload (§3 decision 2) |
| ATT-69 web / mobile switches, geofence enforcement, IP restriction | ✓ enforced server-side |
| ATT-73 categories | ✓ |
| ATT-74 one active reason per day; resubmission resets to pending | ✓ partial unique index; an edit / an answer returns the note to pending with a fresh request; a rejected note is history |
| ATT-75 submitting a reason reverses the auto-deduction | ✓ the sweep's charge is reversed; a reviewer's decided charge stays until the new reason is decided (§3 decision 7) |
| ATT-76 manager notified in-app + email | ✓ `attendance.note_submitted` to the routed approvers (both channels) |
| ATT-77 queue "mine" + HR "all" oversight | ✓ `scope=mine\|team\|all`; `all` needs `attendance.view` + `attendance.review_notes` or `attendance.approve` |
| ATT-78 day status, excused-this-year count, oversight flag | ✓ |
| ATT-79 approve / excuse / ask info (comment) / reject with pay effect 0 / 0.5 / 1 | ✓ |
| ATT-80 no self-review; own notes excluded | ✓ segregation on the live employee link; own notes never in the queue |
| ATT-81 approve / excuse restore deductions, clear LOP | ✓ |
| ATT-82 reject charges paid leave in priority order (special types excluded) or LOP | ✓ the Prompt 3 charger |
| ATT-83 pay effect only on absent / late / incomplete; 0 = no charge | ✓ other days reject with `not_applicable` |
| ATT-84 never charge a leave-covered day | ✓ `covered_by_leave` |
| ATT-85 decision notice with outcome title and deduction / LOP text | ✓ `attendance.note_decided` |
| ATT-86 same list in the approvals inbox and the portal; badge counts pending reasons | ✓ one engine request per note: inbox context cell + pay effect, `/attendance/notes`, the employee's *My requests*; the approvals badge counts them |
| ATT-88 sweep skips days with pending / approved / excused / info-requested reasons | ✓ `skippedNote` |
| ATT-91 regularisation types, expected in / out, reason | ✓ |
| ATT-92 pending / approved / rejected / cancelled with colours | ✓ |
| ATT-93 submitted through the engine, manager chain, HR / owner fallback | ✓ (`REGULARISATION` workflow, else the MANAGER level) |
| ATT-94 applied only after approval, idempotent, marked "regularisation" | ✓ through corrections (`applied_at`, `applied_correction_id`, reason "Regularisation (…)", self-service device on the events) |
| ATT-96 per-employee open-attendance grant (HR or mapped manager) | ✓ nobody grants themselves |
| ATT-97 private selfie bucket, own folder, no direct read | ✓ stronger: the API uploads; no client role can read or write the prefix (§4) |
| ATT-98 grant + valid own path; manager notified | ✓ the path is built server-side from the caller's employee id |
| ATT-99 approve creates the day's check-in; reject with reason; employee notified | ✓ a `face` raw punch at the selfie's time → normaliser → recompute |
| ATT-100 advisory face match | n/a (excluded by the pack) |
| ATT-101 every selfie view audited; 60-second URL | ✓ `attendance.selfie_photo_viewed` with `via` (self / manager / oversight) |
| ATT-104 shift master (portal read) | ✓ times, grace, break on the shift card (administration is Prompt 6) |
| ATT-105 assignments with effective dates; roster with off days | partial — the portal shows the resolved next 14 days (offs, holidays, leave) and the assignment history; the HR roster is Prompt 6 |
| ATT-106 shift swap requests with an approval step | ✓ `SHIFT_SWAP` entity |
| B-11 calendar colours | partial — the existing month calendar's status palette; a reason marker added; no separate legend |
| B-12 period pills / multi-month grids | partial — statistics ranges 30 days / this month / this year; one month grid with navigation |
| B-13 attendance % | ✓ (present incl. late + missing punch + ½ half day) / working days, one decimal |
| B-14 average hours ignore zero-hour days | ✓ |
| B-15 hints (< 90 %, < 8 h, late, absent, missing check-out) | ✓ thresholds are the Prompt 3 `stats.*` settings |
| B-16 punctuality | ✓ with the resolved shift start and the rule-set grace (not a fixed 09:00 / 15 min); delay = minutes beyond grace |
| B-17 day detail with "Add a reason" | partial — each row of *Last 30 days* carries it; the calendar's day dialog is the shared record dialog (Prompt 6a area, not modified) |
| B-18 six categories; editing resets to pending | ✓ |
| B-19 one active note per day | ✓ |
| B-20 note pill colours | ✓ (excused uses the success tone rather than a separate teal) |
| B-21 approve / excuse / ask info / reject with pay effect | ✓ |
| B-22 no self-review; reviewers HR or primary / secondary manager | ✓ HR = `attendance.review_notes` or `attendance.approve` with `attendance.view` |
| B-23 rejection charges absent 1.0 / late 0.5 (override) in leave priority order, else LOP | ✓ defaults from `attendance.unexcused` (missing punch 0.5) |
| B-24 approve / excuse after a deduction restores it | ✓ |
| B-26 reviewed note notifies the employee with a portal link | ✓ `/my/requests?tab=reasons` |
| B-27 regularisation fields, pending, routed to the engine | ✓ |
| B-28 approved regularisation applied exactly once | ✓ through corrections (raw immutable) |
| B-29 server-time punch refuses duplicate check-in / out, check-out without check-in, disabled channels | ✓ `DUPLICATE_PUNCH`, `ALREADY_CHECKED_IN`, `NOT_CHECKED_IN`, `WEB_CHECKIN_DISABLED` / `MOBILE_CHECKIN_DISABLED` |
| B-30 offline queue replays; duplicate responses count as success | ✓ replays of the same key answer `replayed`; a `DUPLICATE_PUNCH` answer counts as recorded |
| B-31 verdict preview with nearest zone, distance, accuracy warning | ✓ the accuracy threshold is per fence (default 100 m) and judged server-side |
| B-32 confirm disabled on a denied verdict; mock message | ✓ |
| B-33 offline geo punches queued per org, deduplicated, Sync now / Discard | ✓ (server time, §3 decision 2) |
| B-34 fence evaluation rules | ✓ (Wi-Fi n/a; IP organisation-wide) |
| B-35 denied punches not stored but logged | ✓ |
| B-36 `within_geofence` truth table | ✓ (Prompt 3 flag semantics, unchanged) |
| B-37 selfie only with an open-attendance grant | ✓ (organisation switch AND open attendance or selfie required) |
| B-38 selfie flow | ✓ camera + location → API upload → manager notified → approval records the punch (face match n/a) |
| B-39 shift tab | partial — current / upcoming days with times, break, grace, source, offs, history; no list of "available shifts" |
| B-40 swap needs a target and a date; both work that day on different shifts | ✓ + same branch, not in the past, ≤ 90 days, no open clash, re-validated at approval |
| Appendix B engine refs: B2 (entity registration), B7 (info loop), B8 (invalidation), B13 (inbox context cells + pay effect) | ✓ three hooks registered; ask-info / answer loop on notes; editing a note invalidates its request; context cells + pay-effect choice |

## 3. Decisions (priority order Security > Reliability > Data Integrity > … > UX)

1. **One virtual device per organisation, not `device_id null`.** The pack's sketch had self-service rows without a device; the brief's virtual-device convention (§6.1) keeps ONE pipeline — raw (immutable) → normaliser → events → day — with the standard dedupe hash and audit trail. The device is created lazily in the system context under an advisory lock, `disabled`, auto sync off, no push token (the push / webhook endpoints can never authenticate as it). It is excluded explicitly everywhere a device appears or is counted (lists, counts, search, plan seats, usage metering, scheduler polls / health / reconciliation, employee pushes) and every generic device operation (actions, test connection, sync / reconcile by id) refuses it with 409 `INVALID_STATE`, mirroring the Finance connector's treatment.
2. **The server clock decides the punch time.** A client clock can be set to anything; an offline punch is recorded when it reaches the server, with the queued time kept in the payload for the record (Finance kept original timestamps — declined). Idempotency key per punch (`self:<employee>:<key>`, 14-day replay window, same answer on a replay); the organisation's `duplicatePunchSeconds` window refuses a double tap; the in / out sequence is judged from the last punch of the last 20 hours.
3. **Geofences.** Most specific scope wins (an employee fence overrides the branch's — not added to it); worst verdict of that scope; weekly windows in LOCAL time (Finance evaluated UTC); a mock location is never inside; the organisation policy caps enforcement (`off` / `flag` / `block`); no applicable fence → not judged. An **open-attendance grant** turns a geofence refusal into a flag (the grant exists for people who work away from the fences; recorded as `openAttendance: true` in the payload). The preview is advice — the punch is re-evaluated server-side.
4. **A refused punch is not stored** (audited; geofence / mock refusals notify the line manager). A flagged punch is stored with the payload the engine turns into `OUTSIDE_GEOFENCE` / `OUT_OF_WINDOW` / `SELF_SERVICE_PUNCH`, and the manager is told.
5. **Routing = one MANAGER level** when no workflow is configured (the engine's resolver: primary → secondary → HR admins → owner). Right after submit the secondary manager is seated on the SAME seat as a stand-in (`via_delegation_of` = the primary, path `secondary`): either decides for the reporting line and a rejection by either is final, exactly as with one manager. A configured workflow takes precedence. HR oversight (org-wide keys in branch scope) decides as an override that names the request's current `stepNo`, read in the same transaction (the corrected engine's rule); the note records `review_via = 'oversight'`.
6. **Pay effect.** Required on the notes endpoint; optional (0) on the generic approvals decide so an inbox built before this prompt keeps working. The review dialog proposes the organisation default for the day (absent → `payEffectAbsent`, missing punch → `payEffectMissingPunch`, late / half → `payEffectLate`). The charge goes through the one Prompt 3 charger (paid leave in priority order, special types excluded, else LOP), only on days that need an explanation, never on a leave-covered or excused day; approve / excuse reverse it.
7. **Filing a reason reverses only the sweep's automatic charge** (SWEEP marks). A reviewer's decided charge (NOTE_REVIEW marks) stands until the new reason is itself decided — otherwise re-filing after a rejection would buy back a decided pay effect. Oversight can still excuse.
8. **Editing a pending note** (or answering a question) invalidates its request and submits a fresh one (B8); the question stays on the note.
9. **Regularisations are applied through corrections** (ADD_PUNCH / EDIT_PUNCH / SET_STATUS PRESENT), created APPROVED by the regularisation's own approval and stamped with the self-service device — raw immutability and the void / add audit trail hold. One open request per day; proposed times on (or next to) the day and not in the future (the dialog rolls a check-out earlier than the check-in to the next day).
10. **Swaps**: one day, same branch, both working different shifts, ≤ 90 days ahead; approval re-validates, then writes two one-day EMPLOYEE assignments and splits any covering employee assignment around the day. The colleague is told but does not consent in the system (the manager's decision covers it). Swap RLS / hook view key is `attendance.view`, not `shift.view`: the manager role holds `shift.view` organisation-wide to read the rota, and a swap carries the employee's own reason.
11. **RPC-only self-service tables** (revoked privileges + explicit restrictive denials; system-context writes after the service checks). Authorization twice: the service decides who may act; RLS decides what each caller may read.
12. **Selfie photos are reachable only through the API** (§4).
13. **Statistics** (`computeSelfStats`, from the engine's daily records): working days = PRESENT, HALF_DAY, ABSENT, MISSING_PUNCH; attendance % = (present incl. late + missing punch + ½ half day) / working days, one decimal; average hours over days with worked time; hints against `stats.attendanceTargetPct` / `stats.fullDayHours`, late, absent, missing check-outs; punctuality per window (last 7 days, this month, last month) from the expected start and the engine's `lateMinutes`.
14. **`notes.requireReasonForLate` / `requireReasonForAbsent`** (Prompt 3 settings) are consumed as a nudge: the overview counts the recent days that need a reason and carry none (`reasonsRequired`), the home shows a badge and the last-30-days table marks the days. It is not a block — the day close still decides unexplained days.
15. **Day close leaves explained days to the reviewer** (pending / info-requested / approved / excused notes); a rejected note leaves the review's own marks.
16. **Notifications are targeted** (`payload.userIds`, re-checked at relay) and use both channels (no `payload.channels`).
17. **No new dependencies**: IndexedDB through the browser API (memory fallback), `getUserMedia` + canvas for the selfie, Node's `BlockList` for IP / CIDR.
18. **Single-transaction migration**: the new enum value is never used in the file; no `CONCURRENTLY`.

## 4. Storage paths and access rules

| Path | Written by | Read by | Client storage access |
|---|---|---|---|
| `employee-photos/checkins/<org_id>/<employee_id>/<selfie_id>.<jpg\|png\|webp>` | the API's service client only, after its checks (organisation switch, grant, active employment, unlocked day, duplicate window, magic-byte sniff, ≤ 2 MB); `upsert: false` | nobody directly. The API issues a **60-second signed URL** — `GET /orgs/:orgId/me/selfie-checkins/:id/photo` for the employee themself (RLS: own rows only), `GET /orgs/:orgId/attendance/selfie-checkins/:id/photo` for the primary / secondary manager (the team relationship) and attendance reviewers in scope (`attendance.view` + `attendance.approve` or `attendance.review_notes`, inside their branches). Anybody else — incl. `attendance.view` alone (payroll, auditors) and colleagues — gets 404. Every issue is audited (`attendance.selfie_photo_viewed`, `via` self / manager / oversight). | **none**: the first path segment is not an organisation id, so no tenant storage policy (all keyed on `app.path_org_id`) matches it, and the restrictive `flowza_selfie_photos_deny_client` denies `anon` / `authenticated` / `flowza_system` every operation on the prefix — a later, broader policy cannot open it |

No other storage path is added by this prompt. The RLS suite proves: a same-org employee without rights reads 0 selfie objects (even by exact name) and can neither change, delete nor upload one; managers, branch managers, auditors and the owner read 0; with a deliberately broad permissive policy added, a plain employee reads the control object (tenant path) but still 0 selfie objects. Dropping the restrictive policy in that situation exposes them (checked by hand as a negative control), so the assertion is meaningful.

## 5. Backward compatibility (the current production web keeps calling the new API)

- **No existing route, field, status code or meaning changed.** `/orgs/:orgId/me/*` (profile, overview, attendance month, leave), corrections, attendance daily / monthly, devices, sync and approvals keep their contracts.
- `GET /me/overview` only **adds** optional fields (`punch`, `pendingNotes`, `infoRequestedNotes`, `pendingRegularisations`, `pendingSwaps`, `reasonsRequired`); API test "the overview keeps every existing field and adds the open items".
- `POST /approvals/:id/decide` accepts an **optional** `payEffectDays` (ATTENDANCE_NOTE rejections; absent = no charge) — an older inbox's decide is unchanged; API test "an inbox that predates the pay-effect choice still decides a reason: no pay effect sent = no charge" sends the old `{ decision, comment }` body.
- Approval context DTO: three new `kind`s, each carrying `summary`, so an older inbox renders the summary text.
- `RAW_SOURCES` appended `SELF_SERVICE`; raw / event DTOs unchanged (self-service events are `MOBILE`).
- Device endpoints return what they returned before: the virtual device is simply never listed or counted; generic operations on it answer 409 (it could not exist before this release).
- `attendance_corrections.device_id` is a new nullable column; the correction DTO is unchanged.
- The day-close job summary gains `skippedNote` (additive).
- Self-service check-in, selfie check-in, geofence enforcement and the reason requirements sit behind the Prompt 3 organisation settings (all off by default); reasons, regularisations and swaps are new routes behind the permission keys Prompt 1 already seeded (`attendance.note`, `attendance.request_correction`, `shift.request_swap`, `attendance.review_notes`, `attendance.manage_geofences`) — no new permission.

## 6. Integration — the merge was NOT performed

The integrator asked, before the final gates, to `git merge claude/modest-fermi-fnwqq7` (first at `2b82b16`, later at `7b47fe4`) and to re-run every gate on the merged tree. **The merge command was refused by this session's permission system ("Untrusted Code Integration")**; per its instruction it was not retried or worked around (no reading or copying of that branch's changes). So there is **no merge commit and no post-merge gate run**: every result in §8 is for this branch alone (base `ba825d2` + the commits listed in the hand-back). The integrator — or the user — needs to perform the merge.

What was done instead so the merge is clean:
- **Engine (corrected rules)**: every internal decision names the request's current `stepNo`, read in the same transaction (oversight = override of the current level; line managers act through their seat — the secondary manager is seated as the primary's stand-in); segregation of duties on the live membership employee link in every service (notes, selfies, grants, swaps); every withdraw path passes a reason of ≥ 3 characters ("Withdrawn by the employee" when none is given); no `allowSelfApproval` in any of this prompt's code or tests; tests cover an org-wide holder who is not seated (override) and a manager of a different team (refused).
- **`managePermission`** declared on the three hooks: ATTENDANCE_NOTE and REGULARISATION → `attendance.review_notes` (HR oversight of employee requests), SHIFT_SWAP → `shift.manage` (the rota owner). The base engine's `canCancel` does not read it yet; the corrected engine will.
- **Self-service device exclusions** applied independently, the same set the connector gets (lists, counts, search, plan seats, usage metering, scheduler, employee pushes, generic reconcile / test-connection / actions → 409).
- No change to `load-inputs.ts` (the loader moved to `packages/database` on the shared branch — nothing to re-home). Notifications set no `payload.channels` (both channels).

Expected conflicts (resolve keeping both sides' intent):
- `apps/api/src/services/approvals/engine.ts` — this branch: `noWorkflow: { kind: 'MANAGER' }` + the submit branch; `DecideInput.payEffectDays` / `detail` recorded on the timeline and handed to the hook (`hookCtx(..., detail)` in `completeApproved` / `completeRejected`); `holdsApprovePermission` in `assessDecider` and `canCancel`; `requestInfo` / `answerInfo` call `onInfoRequested` / `onInfoAnswered` and leave the subject out of the generic notice when the hook notifies.
- `apps/api/src/services/approvals/hooks/index.ts` — `HookContext.detail`, `EntityHook.alsoApprovePermissions` / `onInfoRequested` / `onInfoAnswered` / `managePermission` (the shared branch adds `managePermission` too — keep one), the three registry entries, `approvePermissionsFor` / `holdsApprovePermission`.
- `apps/api/src/routes/v1/features/approvals.ts`, `packages/contracts/src/dto-features/approvals.ts`, `apps/web/src/features/approvals/{api.ts,components/decision-dialog.tsx,components/parts.tsx}` — this branch adds `payEffectDays` and the context cells; the shared branch makes `stepNo` required and bulk decide take items.
- Registries (unions): `DOMAIN_EVENT_TYPES`, outbox ROUTING, sidebar sections, locale files, `apps/web/src/features/routes.tsx`, the RLS runner (keep `rls_approvals.sql` last; `rls_portal_attendance.sql` runs just before it), `apps/web/e2e/support/mock-backend.ts`.
- Device exclusions (unions, e.g. `provider_key not in ('flowza_finance', 'self_service')`): `apps/worker/src/tasks/sync.ts`, `apps/worker/src/handlers/maintenance/index.ts`, `apps/worker/src/handlers/sync/employees.ts`, `apps/api/src/services/features/{devices,sync}.service.ts`, `apps/api/src/services/{platform,search}.service.ts`.
- `packages/database/src/generated/db.ts` — regenerate from a fresh `--seed` reset after the merge; never hand-merge.
- Migration stamps do not collide (this prompt `…000500`; 6a `…000600`; Prompt 7 `…000700`).

## 7. Files

- Migration `supabase/migrations/20260928000500_portal_attendance_self_service.sql`; generated `packages/database/src/generated/db.ts`; RLS suite `supabase/tests/rls_portal_attendance.sql` (+ runner line).
- Contracts: `src/dto/portal-attendance.ts` (new), `src/dto/self-service.ts`, `src/dto-features/approvals.ts`, `src/enums.ts`, `src/sync.ts`, `src/index.ts`.
- Database: `src/attendance/self-service-device.ts` (new), `src/attendance/pay-effect.ts`, `src/attendance/index.ts`.
- Domain: `src/geofence/{types,evaluate,index}.ts` + `evaluate.test.ts`, `src/attendance/self-stats.ts` + `self-stats.test.ts`, indexes.
- API: `routes/v1/portal-attendance.ts` (new) + `portal-punch.test.ts` / `portal-requests.test.ts`, `routes/v1/{index,self-service}.ts`, `routes/v1/features/approvals.ts`, `services/portal/*` (new: common, line-manager, punch, geofences, notes, note-effects, regularisations, regularisation-effects, shift, shift-resolve, swap-effects, stats), `services/approvals/{engine,index}.ts`, `services/approvals/hooks/{index,attendance-notes,regularisations,shift-swaps}.ts`, `services/features/{devices,sync,self-service-device-guard}.ts`, `services/{platform,search}.service.ts`, `deps.ts`, `lib/supabase-clients.ts` (storage upload), `test/features-harness.ts`.
- Worker: `handlers/attendance/{normalize,corrections,day-close}.ts` + `self-service.test.ts` / `policy-parity.test.ts`, `handlers/notifications/outbox.ts`, `handlers/maintenance/index.ts`, `handlers/sync/employees.ts`, `tasks/sync.ts`.
- Web: `features/portal/*` (attendance-api, attendance-i18n, geo, notes-model, offline-queue, shift-format, use-offline-punches, components/*, pages/{attendance,checkin,requests,shift,home}-page, routes, tests), `features/attendance-review/*` (new), `features/approvals/{api.ts,components/decision-dialog.tsx,components/parts.tsx}`, `features/employees/pages/employee-profile-page.tsx`, `features/routes.tsx`, `components/layout/sidebar.tsx`, locales `en|ar/{portal-attendance,attendance-review}.json`, e2e `e2e/portal.spec.ts` + `e2e/support/mock-backend.ts`.
- Report: this file.

## 8. Verification (local Postgres 16 @ 127.0.0.1:54329; DB-sharing suites under `flock /tmp/flowza-dbtests.lock`)

Final run on the tree of `155aaac` (all of this branch's code; the report commit changes no code). The `./apps/*` glob was replaced by the explicit filters `--filter @flowza/api --filter @flowza/web --filter @flowza/worker` (the worktree guard refuses the glob in a command chain).

| Gate | Result |
|---|---|
| `pnpm build:packages` | pass |
| `pnpm lint` (`--max-warnings 0`) | pass |
| typecheck (api, web, worker) | pass |
| `pnpm test:unit` | pass — shared 4, contracts 5, domain 254 in 20 files (new: `geofence/evaluate.test.ts` 14, `attendance/self-stats.test.ts` 6), device-providers 165, database 20 |
| `pnpm --filter @flowza/web run test` | pass — 59 files, 257 tests (new: `portal/portal-attendance.test.tsx` 18, `portal/attendance-model.test.ts` 7, `attendance-review/attendance-review.test.tsx` 15) |
| `PGDATABASE=flowza_p4_rls flock … bash supabase/tests/run-rls-tests.sh` | pass — new `rls_portal_attendance.sql` (≈ 130 assertions): RLS on, no client write privilege, one active note per day, cross-tenant FKs refused; the employee reads only their own rows (a relationship without a team key reveals nothing) and writes nothing directly; primary and secondary manager read direct reports only (a report of a report stays hidden; swaps by either party); branch manager reads their branch; owner / auditor read the organisation and write only geofences (owner) / nothing (auditor); owner B sees nothing of org A; re-granted INSERT / UPDATE / DELETE still refused; the system context writes its own organisation only; storage as §4 (incl. the broad-policy check) |
| `flock … pnpm test:db` | pass — 2 files, 11 tests |
| `pnpm --filter @flowza/api run test` | pass — 23 files, 266 tests (new: `portal-punch.test.ts` 19 — switches, windows, IP list, geofence verdicts / refusals / notices, replay and duplicates, locked periods, virtual device hidden and 409 on every device operation, grants, selfies incl. photo access, geofence CRUD / assignments / dry run, tenant isolation, other team; `portal-requests.test.ts` 23 — notes both sides incl. sweep reversal, one active per day, ask-info loop, oversight override, other team refused, LOP / half-day charge, inbox decide incl. the legacy body, secondary manager seat, SoD; regularisations applied through corrections; shift tab, candidates, swap validation / approval; statistics; overview compatibility; reasons required) |
| `flock … pnpm --filter @flowza/worker exec vitest run` | pass — 14 files, 135 passed + 1 skipped (pre-existing); new `attendance/self-service.test.ts` 5 (virtual device, normaliser mapping + impostor rows, recompute flags, correction device on the event, day close skips explained days) |
| build (api, web, worker) | pass — the > 700 kB main-chunk warning predates this phase (Prompt 2 report); the main chunk is 842 kB |
| `PGDATABASE=flowza_p4_ci2 bash scripts/db-reset-local.sh` | pass; the migration re-applied a second time on it without error (idempotent) |
| `PGDATABASE=flowza_p4 … --seed` + `pnpm db:types` | pass; `packages/database/src/generated/db.ts` unchanged (committed with the backend) |
| single-transaction replay (`replay-single-tx.sh <worktree> flowza_p4_tx`, floor `20260927000100`) | **pass** — `…000100`, `…000150`, `…000200`, `…000300`, `…000400` and `…000500` each applied with `psql -1` on a fresh database |
| `pnpm --filter @flowza/web run build:e2e && … run test:e2e` (`CI=1`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`) | pass — 36 passed (every spec on chromium + tablet), incl. the new `portal.spec.ts` (check-in preview → punch → reason → listed in My requests) |

Notes: on the 4 shared cores one earlier web run failed the pre-existing timing test `monthly-grid.test.tsx` (6.8 s against its 4 s budget, load average ≈ 11); it passed alone and in both full runs after it. The integrator ran this worktree's former `gates.sh` once (01:20–01:35 UTC); every result above comes from runs started after that, with the `p4-` scripts.

## 9. Known limits / follow-ups

- **Not merged** with the shared branch (§6); the post-merge gate run and the merged `db.ts` are the integrator's.
- **No map editor** for geofences (numbers + polygon points as text); a map needs a tile provider and a dependency — a follow-up with its own review.
- **Wi-Fi SSID** co-validation is not possible from a browser; revisit with a mobile app.
- **Offline punches take the server time** of their replay (by design, §3 decision 2); the queued time is in the payload.
- **Selfie photos are kept** (rejected ones too) — no retention / deletion job yet; a retention policy (and a purge through the service client) is a follow-up.
- **Face match** (ATT-100) is out of scope.
- **The calendar's day dialog** (the shared record dialog, Prompt 6a area) does not offer *Add a reason*; the last-30-days table does (B-17).
- **`managePermission`** is declared but read only by the corrected engine after the merge.
- **Web bundle**: the main chunk is 842 kB (Vite warns above 700 kB; the warning predates this phase) — the new pages are lazy, but locale JSON is bundled eagerly; code-splitting the namespaces is a follow-up.
- Playwright covers one portal scenario (check in → add a reason) with the mocked backend.
- No new dependencies.
