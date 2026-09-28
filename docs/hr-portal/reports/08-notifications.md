# Phase 8 — Notifications & reminders

**Prompt:** `docs/hr-portal/prompt-pack.md` §Prompt 8 (+ the implementing brief of 2026-09-28: complete catalogue, en + ar templates, preferences and organisation switches honoured, `notification.manage` enforced, preferences API + UI, missing check-out reminder, B-102 reminders on every entity type, retention purge, delivery robustness).
**Branch:** worktree branch `worktree-agent-aaeb804f5d9968fc5` (from `claude/modest-fermi-fnwqq7` @ `08ce01c`) · **Migration:** `supabase/migrations/20260928001000_notifications_v2.sql` · **Date:** 2026-09-28.
**Status:** every gate green on the branch (§8), except one pre-existing, random API test flake in the approval engine that this branch does not touch (`approvals-review.test.ts > P2-13`, reproduced in isolation; §8). Not merged with the integrated branch (the integrator merges it; §9 lists every shared file). Nothing applied to the hosted project.

## 1. What shipped

### The catalogue (`packages/contracts/src/notifications/catalogue.ts`, exported from `@flowza/contracts`)
One entry per notification type the relay can write (the domain event type is the notification type) — **38 entries**. Each says how a notice is **composed** (template key, outcome variants, the template variables the payload may carry and their kinds), where it **leads** (`deepLink(payload, ctx)` → the canonical web path; `route(payload, ctx)` → the routing facts `entityType` / `entityId` / `requestId` / `date` / `employeeId` copied into `notifications.data` so a client can re-route, Prompt 5), and on which **channels** it goes (category, default channels, `userConfigurable`, `inAppAlways` for items the recipient must act on, the organisation switch that governs its e-mail, one-click links). Functions: `resolveNotification` (variant, template key, switch, link, route for one recipient), `decideNotificationChannels` (the matrix of §4), `notificationData` (the whitelist written to `notifications.data`), `notificationPreferenceCells` (the category × channel matrix), `approvalContextFacts` (the day / leave dates / leave type of an approval request). `NON_NOTIFYING_EVENT_TYPES` lists the domain events that are published but never notify (11). Who **receives** a type stays the worker's `ROUTING` table.
- Completeness is enforced both ways: a contracts test fails when a `DOMAIN_EVENT_TYPES` entry is neither catalogued nor listed as non-notifying; a worker test fails when `ROUTING` and the catalogue differ; a worker test fails when a template key of any entry (base + every variant) is missing in either language.
- Enums: `NOTIFICATION_CATEGORIES` += `LEAVE`, `REPORTS`; `NOTIFICATION_DELIVERY_CHANNELS` (`IN_APP`, `EMAIL`), `NOTIFICATION_LOCALES` (`en`, `ar`). `DOMAIN_EVENT_TYPES` += `leave.info_requested`, `punch.missing_out` (appended).
- Settings: `notificationSettingsSchema` (+ `DEFAULT_NOTIFICATION_SETTINGS`, `resolveNotificationSettings`) — the five existing switches plus `leaveUpdates`, `attendanceNotes`, `punchFlagged`, `missingPunchReminder` (all default **on**), `missingPunchReminderHours` (integer 1–12, default **2**) and `reportScheduledDelivery` (on). `NOTIFICATION_ORG_SWITCHES` is the Settings order.
- DTOs (`dto/notifications.ts`): preferences query / matrix / update (strict; max 14 cells; duplicates refused).

### Database (`20260928001000_notifications_v2.sql` — additive, idempotent, one transaction, `lock_timeout 5s`, `statement_timeout 120s`, post-verify block)
1. `notification_category` += `LEAVE`, `REPORTS` (not used in the file that adds them — the hosted apply runs each file as one transaction; the single-transaction replay passes, §8).
2. `notifications.in_app boolean not null default true` — a notice kept only as the record of its e-mail is `in_app = false` (and read).
3. `notification_deliveries.next_attempt_at` — e-mail back-off.
4. Retention indexes `notifications (organization_id, created_at) where read_at is not null`, `notification_deliveries (organization_id, created_at) where status <> 'pending'` (runbook in the header for large hosted tables: build them concurrently first).
5. **`missing_punch_reminders`** (organisation × employee × date, `due_at`, `reminded_at`, `recipients`) — the once-per-employee-day ledger; RLS on, no client privileges, system context of its own organisation only.
6. **`notification_preferences` RLS** — own rows only (select / insert / update / delete split), and a row can only be written for an organisation the caller is an active member of (the old ALL policy accepted any organisation id); the system context reads its own organisation's rows only.
7. **`organization_settings`** — INSERT / UPDATE admit `organization.manage` **or** `notification.manage`; DELETE keeps `organization.manage`; trigger `organization_settings_group_guard` checks every group that actually changes: `notifications` needs `notification.manage`, any other group `organization.manage` (migrations, system and platform contexts are not checked). `notification.manage` was declared since migration 1600 and enforced by nothing.
8. `app.organization_notification_settings(org)` — SECURITY DEFINER, system contexts only (the relay runs in the platform context, which has no policy on `organization_settings`); not executable by clients.
9. `notifications_system` / `notification_deliveries_system` scoped to the system context's own organisation (they admitted any); the relay's platform-context policies are unchanged.

### Worker
- **Templates** (`apps/worker/src/handlers/notifications/templates/{en,ar}.ts`, `render.ts`): title, body parts, e-mail subject and call-to-action label for every catalogue key (38 base + 34 variant keys = 72 per language) in English and Arabic. `{{var}}` / `{{var|fallback}}`; a body part whose variable is missing is dropped (never "undefined" or a dangling label), `bodyFallback` when every part dropped; values are inserted once (never re-expanded), collapsed to one line (no header injection), and HTML-escaped only in the e-mail layout. Derived phrases: the approval item ("Leave request — Sara Ali"), details (leave type + range, else the day), the level, "pending for 26 hours", plurals (Arabic zero/one/two/few/many/other), localised entity names, report types, sync job types, geofence reasons, regularisation types, plan metrics, pay effect (half / one day), distance (`Intl` unit). Dates in the recipient's language, instants in the **organisation's timezone** (Luxon). Language = the recipient's `user_profiles.locale` (en / ar), else the organisation's locale, else English.
- **E-mail layout** (`renderEmail`): plain HTML (tables + inline styles, max 560 px, `lang` / `dir="rtl"` for Arabic), brand + organisation display name, title, body, **one** CTA button to the deep link, the link as text for clients that block buttons, the one-click Approve / Reject block (links to the web action page — confirm, then POST; unchanged from Prompt 2) with its security note, and a footer (why you receive it + a link to the recipient's notification settings — `/my/profile` for an employee, `/settings/notifications` otherwise — or "cannot be switched off" for system / subscription notices); a plain-text alternative carries the same content.
- **Relay** (`outbox.ts`): `ROUTING` now holds recipients only (every existing type's recipients kept; `leave.info_requested` and `punch.missing_out` added, targeted). Per event: recipients kept to **active members** with their profile language and employee link; the catalogue resolves variant / switch / link per recipient (audience `subject` when the recipient's membership is linked to `payload.employeeId`); the channel decision applies the organisation switch and the recipient's (category, channel) preferences; the notice is rendered in the recipient's language and written (`in_app` / read per the decision) with the whitelisted `data`; an e-mail delivery is queued when e-mail is on. **Each event runs under a savepoint** (a failing event rolls back alone and is retried by the next run; the events behind it are relayed) and an event failing 20 runs is left unpublished as a dead letter (error log, never purged); queueing the e-mail runs under its own savepoint, so it never costs the in-app notice.
- **Delivery** (`deliverNotifications`): due = `next_attempt_at` null or passed; the recipient must have a deliverable, placeholder-free address (single plain address, no header characters, not the `*.invalid` placeholder a profile gets without an e-mail), an active account and an active membership — else `skipped` with the reason (`invalid_recipient_address` / `recipient_disabled` / `recipient_not_member`); the e-mail is rendered for the recipient at send time and goes **only** to the address on the recipient's own profile; a failed send backs off 1 → 5 → 15 → 60 minutes and is `failed` after 5 attempts; the in-app notice is never touched.
- **`attendance.missing-punch-reminder`** (scheduler, every 15 min → one deduped `MISSING_PUNCH_REMINDERS` job walking the active organisations, each in its own system-context transaction; `missing-punch.ts`): records of the organisation's local today / yesterday with an IN and no OUT (`last_out_at` empty, or `MISSING_OUT`), not LEAVE / HOLIDAY / WEEKLY_OFF / NOT_JOINED / EXITED and not covered by an approved full-day leave; the day ends at the resolved shift's expected end (the engine already falls back to the organisation's default shift), else the self-service check-out window's end, else first IN + `fullDayHours` (an end before the first IN — work after the shift — falls back to first IN + `fullDayHours`); due = end + `missingPunchReminderHours`; not sent more than 12 h after it became due; the ledger row is claimed (`ON CONFLICT DO NOTHING`) before `punch.missing_out` is emitted to the employee's own login(s); ledger rows older than 35 days pruned. The organisation switch off = no reminder at all.
- **`notifications.retention`** (scheduler, daily → one deduped `NOTIFICATION_RETENTION` job, platform context; `retention.ts`): published `domain_events` older than **90 days** (never unpublished ones), **read** notifications older than **180 days** (unread ones stay; an organisation with its own enabled `notifications` retention policy is left to it), settled (`sent` / `failed` / `skipped`) deliveries older than **90 days**; per organisation (and the organisation-less rows) on the time indexes, in batches of **5 000** rows, each batch its own transaction, capped at 200 batches per class per run (a capped class continues the next day); organisations under legal hold skipped; one `notification_retention` log line and one platform audit row (`notifications.retention_applied`) per run.
- **Approval reminders (B-102)**: the 24 h reminder, the escalation and the daily digest were already entity-agnostic; they now go through the catalogue and templates, and the reminder / escalation payloads carry the request's facts for **every** entity type with a document (`approvals/facts.ts`: the correction / note / regularisation day, the swap date, the comp-off worked day, a leave's dates and type; overtime / missing punch / shift change / manual attendance / overtime claims render with the entity and the person). The digest e-mail is governed by `dailyDigest`.
- Day close: `attendance.unexcused_marked` carries `employeeName` (the managers' notice names the employee).

### API
- `GET /me/notification-preferences?organizationId=` and `PUT /me/notification-preferences?organizationId=` (`notification-preferences.service.ts`, §3).
- `PUT /orgs/:orgId/settings/:group` — the notifications group needs `notification.manage`, every other group `organization.manage` (`settingsGroupPermission`); the database checks it again (§1.7).
- `GET /me/notifications` lists `in_app` rows only.
- Leave hook: an approver's question (`onInfoRequested`) now emits **`leave.info_requested`** to the employee's own login(s), with the question and the leave's type and dates — the engine leaves the subject out of `approval.info_requested` for leave (`notifiesSubject`), so until now the employee was never told (B-100).
- Approval engine: request payloads carry `date` / `endDate` / `leaveTypeName` (from the inbox context the engine already loads) for the templates.

### Web
- **Notification preferences card** (`features/notifications/preferences/`): one row per category that can reach the member (relevance from the catalogue audience × the member's permissions), In-app and E-mail switches, locked cells with a lock and the notes ("items you must act on always appear in your inbox", "security, system and subscription notices cannot be switched off"), each switch saves at once (optimistic, rolled back on a refusal), and the language of notifications and e-mails (the profile locale, `PATCH /me`). On **`/my/profile`** (employees) and at the top of **Settings → Notifications** (staff). Namespace `notificationPrefs` (en + ar).
- **Settings → Notifications**: the organisation's e-mail switches (all ten, in catalogue order) + "Remind after (hours)" (1–12), read-only without `notification.manage` (with a note); copy rewritten (the switches govern e-mails; in-app notices are always written). en + ar.
- Playwright: the mock backend answers GET / PUT `/me/notification-preferences` statefully; `e2e/notifications.spec.ts` — an employee switches off leave e-mails on their profile → saved, still off after a reload.

## 2. Catalogue

Recipients are the worker's `ROUTING`, always kept to active members. Channels: every type is in-app + e-mail by default (`report.scheduled_delivery` may ask for a subset, Prompt 6a). "Switch" = the organisation switch that governs the **e-mail**. "Configurable" = the member's preferences apply (★ = the in-app notice is written whatever the in-app preference says: an item to act on). Links are canonical paths; `data` also carries `entityType` / `entityId` / `requestId` / `date` / `employeeId`.

| Type | Category | Recipients | Switch | Configurable | Deep link (variants) |
|---|---|---|---|---|---|
| `approval.pending` | APPROVAL | `userIds`: pending approvers of the current level / reassignee | approvalPending | ✓★ one-click | `/approvals?request=<id>` (reassigned) |
| `approval.reminder` | APPROVAL | `userIds`: pending approvers after 24 h; digest: each approver at 08:00 local | approvalPending; digest: **dailyDigest** | ✓★ (digest ✓) one-click (not digest) | `/approvals?request=<id>`; digest `/approvals` |
| `approval.escalated` | APPROVAL | `userIds`: escalation target | approvalPending | ✓★ one-click | `/approvals?request=<id>` |
| `approval.decided` | APPROVAL | `userIds`: requester + subject (not the decider) | leave/comp-off: leaveUpdates; else attendanceNotes | ✓ | `/approvals?request=<id>` (APPROVED / REJECTED / CANCELLED / INVALIDATED) |
| `approval.info_requested` | APPROVAL | `userIds`: requester + subject | by entity (as above) | ✓★ | `/approvals?request=<id>` |
| `approval.info_answered` | APPROVAL | `userIds`: pending approvers | approvalPending | ✓★ | `/approvals?request=<id>` |
| `approval.reassigned` | APPROVAL | `userIds`: approvers whose seats moved | approvalPending | ✓ | `/approvals?request=<id>` |
| `approval.bypassed` | APPROVAL | `userIds`: approvers still waiting | approvalPending | ✓ | `/approvals?request=<id>` |
| `attendance.unexcused_marked` | ATTENDANCE | `userIds`: employee + line managers (attendance.approve) | attendanceNotes | ✓ | self `/my/attendance?month=YYYY-MM`; manager `/attendance?employeeId=` |
| `attendance.correction_approved` / `_rejected` | ATTENDANCE | `attendance.correct` holders + requester | attendanceNotes | ✓ | subject `/my/attendance?month=`; other `/attendance?employeeId=&date=` |
| `attendance.note_submitted` | ATTENDANCE | `userIds`: line managers not seated on the request | attendanceNotes | ✓ | `/approvals?request=<approvalRequestId>` else `/attendance/notes` |
| `attendance.note_decided` | ATTENDANCE | `userIds`: the employee | attendanceNotes | ✓ | `/my/requests?tab=reasons&date=` (approved / excused / rejected / rejected_leave / rejected_lop) |
| `attendance.note_info_requested` | ATTENDANCE | `userIds`: the employee | attendanceNotes | ✓★ | `/my/requests?tab=reasons&date=` |
| `attendance.selfie_submitted` | APPROVAL | `userIds`: line managers (else attendance.approve holders in reach) | attendanceNotes | ✓★ | `/attendance/notes?tab=selfies` (in / out) |
| `attendance.selfie_decided` | ATTENDANCE | `userIds`: the employee | attendanceNotes | ✓ | `/my/requests?tab=selfies&date=` (approved / rejected) |
| `attendance.punch_flagged` | ATTENDANCE | `userIds`: line managers | **punchFlagged** | ✓ | `/attendance?employeeId=&date=` (denied / flagged) |
| `attendance.regularisation_decided` | ATTENDANCE | `userIds`: the employee | attendanceNotes | ✓ | `/my/requests?tab=regularisations&date=` (approved / rejected) |
| **`punch.missing_out`** (new) | ATTENDANCE | `userIds`: the employee's own login(s) | **missingPunchReminder** (also gates the reminder) | ✓ | `/my/checkin?date=` (shift / default end) |
| `shift.swap_requested` | ATTENDANCE | `userIds`: the colleague | attendanceNotes | ✓ | `/my/shift?date=` |
| `shift.swap_decided` | ATTENDANCE | `userIds`: requester + colleague | attendanceNotes | ✓ | `/my/shift?date=` (approved / rejected) |
| `leave.requested` | APPROVAL | `leave.manage` holders (unrouted leave only) | approvalPending | ✓★ | `/leave?status=PENDING` |
| `leave.approved` / `leave.rejected` | LEAVE | the employee (`userId`) | **leaveUpdates** | ✓ | `/my/leave?request=<id>` |
| **`leave.info_requested`** (new) | LEAVE | `userIds`: the employee | leaveUpdates | ✓★ | `/my/leave?request=<id>` |
| `leave.comment_added` | LEAVE | `userIds`: the other side of the thread | leaveUpdates | ✓ | employee `/my/leave?request=`; approvers `/approvals?request=` else `/leave` |
| `leave.year_closed` | LEAVE | `leave.manage` holders + who queued it | leaveUpdates | ✓ | `/leave?tab=allocations` |
| `leave.comp_off_expired` | LEAVE | the employee (`userId`) | leaveUpdates | ✓ | `/my/leave` |
| `report.ready` / `report.failed` | REPORTS | who requested it (`userId`) | reportReady | ✓ | `/reports` |
| `report.scheduled_delivery` | REPORTS | `userIds`: the recipient of the copy | **reportScheduledDelivery** | ✓ | `/reports?download=<id>` (send_now / scheduled) |
| `device.offline` / `device.online` | DEVICE | `device.view` holders (15-min dedupe) | deviceOffline | ✓ | `/devices/<id>` |
| `sync.failed` | DEVICE | `device.sync` holders | syncFailed | ✓ | `/sync/<id>` |
| `sync.completed` | DEVICE | `device.sync` holders, manual syncs only | — | ✓ | `/sync/<id>` |
| `sync.finance.failed` | DEVICE | `integration.manage` holders | syncFailed | ✓ | `/settings/integrations` (streak / batch_skipped) |
| `employee.imported` | SYSTEM | `employee.import` holders | — | ✗ | `/employees/imports/<id>` (queued / finished) |
| `subscription.limit_reached` | SUBSCRIPTION | `organization.manage` holders | — | ✗ | `/settings/subscription` |

Prompt-pack names → types: `note.info_requested` = `attendance.note_info_requested`, `note.decided` = `attendance.note_decided`, `leave.decided` = `leave.approved` / `leave.rejected`, `punch.flagged` = `attendance.punch_flagged`.

## 3. Endpoints

| Method & path | Who | What |
|---|---|---|
| `GET /api/v1/me/notification-preferences?organizationId` | a member of that organisation (a platform support grant is refused) | the matrix: 7 categories × IN_APP / EMAIL — effective value (stored, else on; locked cells always on), `configurable`, `alwaysOn` types, `relevant`, and the member's notification language |
| `PUT /api/v1/me/notification-preferences?organizationId` `{ preferences: [{category, channel, enabled}] }` | same | bulk upsert of the caller's **own** rows (the organisation from the query, never the body; strict body — no user or organisation in it; ≤ 14 cells, no duplicates; a locked cell → 400 with `details.cells`), audited `notification.preferences_updated`, answers the new matrix |
| `PUT /api/v1/orgs/:orgId/settings/notifications` | **`notification.manage`** (was `organization.manage`) | the organisation's switches; other groups keep `organization.manage` |
| `GET /api/v1/me/notifications` | unchanged | now lists `in_app` rows only |

## 4. The channel decision (per recipient × type)

| | In-app | E-mail |
|---|---|---|
| requested by the event (`payload.channels`) and in the type's default channels | required | required |
| organisation switch of the type off | written anyway | **off** |
| member preference (category, EMAIL) off — configurable type | — | **off** |
| member preference (category, IN_APP) off — configurable type | **off** unless the type is an item to act on (★) | — |
| non-configurable type (system, subscription) | preferences ignored | preferences ignored (the switch, if any, still applies) |
| absent preference | on | on |

In-app off + e-mail on ⇒ the row is kept with `in_app = false` and read (the e-mail's content and trail; not in the inbox, no badge). Both off ⇒ nothing is written.

## 5. Decisions (Security > Reliability > Data Integrity > Scalability > Maintainability > Performance > UX)

1. **Organisation switches govern e-mail; the inbox is part of the product.** In-app notices are always written, whatever the switch. `missingPunchReminder` is the one switch that also stops the notice itself (the reminder exists only to nudge). **`dailyDigest` now governs the digest e-mail** (default off, as declared since the settings group was created): Prompt 2 mailed the digest to everyone although the switch said off; the per-request 24 h reminder e-mails still go out by default (`approvalPending`), so B-102 holds by e-mail out of the box.
2. **Items to act on are never removed from the inbox by a preference** (★ in §2): pending / reminded / escalated approvals, questions to the member, answers to their question, selfies to review, unrouted leave. Their e-mail still follows the preference and the switch. The APPROVAL in-app switch therefore covers decisions, reassignments, exceptions and the digest.
3. **System and subscription notices are not suppressible** (security and billing notices), and the one-click links' security copy is part of the e-mail layout, not a preference.
4. **Categories re-assigned by the catalogue** (the category is what preferences key on): `sync.*` → DEVICE (was ATTENDANCE), corrections / notes submitted / swap requested → ATTENDANCE (were APPROVAL), `leave.approved` / `rejected` / `comment_added` / `comp_off_expired` / `year_closed` → LEAVE, `report.*` → REPORTS (were SYSTEM). Stored notifications keep the category they were written with.
5. **Recipients kept to active members for every route** — the `user` route and the permission route's `payload.userId` did not check membership; a removed member no longer receives an organisation's notices. Every other recipient rule is unchanged.
6. **`notifications.data` is a whitelist**: the aggregate, the routing facts and the catalogue's template variables, each validated by kind (texts ≤ 500 characters). Recipient lists, other people's logins (`requestedBy`, `decidedBy`, `userIds`), employee numbers and free-form payload keys are no longer copied.
7. **Rendered twice, from the same data**: the relay renders the in-app title / body in the recipient's language; the delivery renders the e-mail from the stored `data` at send time (current language, organisation timezone and name) — the texts agree because both read only the whitelisted variables; the link is the one stored by the relay. A pre-existing notice of an uncatalogued type falls back to its stored title / body.
8. **Deep links follow the brief**: approvals `/approvals?request=<id>` (the inbox opens the request; `/approvals/requests/:id` still exists), employee items the matching `/my/*` page with the date or id. Re-routing a manager without the approve key to `/team?tab=approvals` is Prompt 5's client routing, fed by `data`.
9. **Missing check-out reminder: one job per tick, not one per organisation** — a queue row per organisation every 15 minutes would dominate the queue for no work; the job walks the active organisations with one indexed query each, in separate transactions (one organisation failing never stops the others). Reminders more than 12 h late are not sent. An employee without a login gets a ledger row (recipients 0) so the day is not re-evaluated every quarter hour.
10. **Retention** keeps the `RETENTION` job's floors and policies untouched: this purge is platform-wide defaults for the notification tables, skipping legal hold and organisations with their own notifications policy; unpublished events and unread notices are never deleted.
11. **Relay robustness**: a savepoint per event (a failing row used to abort the whole batch — every later event failed with it, and the batch retried forever); dead letters after 20 attempts stay visible and are never purged.
12. **`notification.manage` enforced twice** — the API per group, the database by RLS + a group guard that checks only groups that change, so a caller holding one key can never write the other key's groups in the same statement.
13. **Language**: the profile locale is the notification language (the UI language switcher stays client-side; the card sets the profile locale). Arabic digits follow ICU's defaults for `ar`, exactly like the web's `Intl` formatting.

## 6. Finance parity

| Item | | How |
|---|---|---|
| ATT-76 (manager notified in-app and by e-mail on submission) | ✓ | `approval.pending` to the seated approvers + `attendance.note_submitted` to the other line managers; both e-mailed unless the member / organisation switched it off (`attendanceNotes`) |
| ATT-85 (outcome-specific decision texts with deduction / LOP) | ✓ | `attendance.note_decided` variants approved / excused / rejected / rejected_leave ("Half a day deducted from your AL leave") / rejected_lop ("One day recorded as loss of pay"), en + ar |
| ATT-98 (selfie submission, manager notified) | ✓ | `attendance.selfie_submitted` (in / out), ★ in the manager's inbox |
| ATT-99 (selfie decided, employee notified) | ✓ | `attendance.selfie_decided` (approved / rejected with the reason) |
| B-26 (a reviewed note notifies the employee with a link to the portal) | ✓ | `/my/requests?tab=reasons&date=` |
| B-66 (a line manager without the hub permission routed to the portal Approvals tab) | ◐ | the notice carries `requestId` / `entityType` / `entityId` / `date`; the re-route is Prompt 5's client routing |
| B-90 (approvers of each newly active level e-mailed) | ✓ | `approval.pending` per activated level, e-mailed with the one-click links |
| B-100 (more information: both sides notified in-app and by e-mail) | ✓ | `approval.info_requested` (requester), **`leave.info_requested`** (the leave's employee — was missing), `attendance.note_info_requested`, `approval.info_answered` (approvers) |
| B-102 (daily reminders for pending approvals) | ✓ | 24 h reminder once per level, escalation, 08:00 digest — every entity type, catalogue templates, facts per entity |

## 7. Tests added / changed

- **contracts** (`catalogue.test.ts`, 40 in the package): completeness vs `DOMAIN_EVENT_TYPES`, well-formedness, non-suppressible types, deep links incl. malformed ids, route facts and data minimisation, organisation-local dates, the channel decision table, the preference matrix, PUT validation, settings defaults / salvage, approval facts per entity kind.
- **worker**: `templates.test.ts` (12) — every catalogue key × en / ar renders (non-empty, no `{{` / `undefined` / `null`, canonical link table, HTML escaped, one CTA, `lang` / `dir`), Arabic is Arabic, empty payload falls back cleanly, organisation timezone across midnight, outcome texts, interpolation safety; `notifications.test.ts` (30) — the relay matrix (16 cases: switch × preference × non-configurable × digest × report channels), recipient language / link / minimal data, savepoint isolation + retry + dead letter, delivery back-off to failure with the in-app row untouched, skipped addresses and former members, the Arabic e-mail, the missing check-out reminder (threshold, once per employee-day, leave / holiday / approved leave / checked out / stale skipped, New York night shift across midnight, switch off, relayed to the employee), an approval reminder on an attendance correction and an overtime claim (facts, text, link, one-click links), retention (batches, cap, unpublished / unread / legal hold / own policy kept, audit row), the two scheduler tasks. Updated: `outbox.test.ts` (categories), `approvals.test.ts` (links, texts), `policy-parity.test.ts` (payload name, titles).
- **api** (`routes/v1/features/notifications.test.ts`, 9): preferences GET / PUT (matrix, own rows, audit, validation, cross-organisation 403, missing organisation 400, 401), `notification.manage` on the group (API + database guard), the leave question reaching the employee with e-mail suppressed and the in-app notice kept — **end to end through the worker's relay**, e-mail-only rows out of the inbox and the unread count.
- **web**: `notification-preferences-card.test.tsx` (4), `notifications-section.test.tsx` (4).
- **RLS** (`supabase/tests/rls_notifications.sql`, in the runner before `rls_approvals.sql`, self-contained / rolled back): own-row preferences, member organisations only, no cross-tenant read / write / delete, notifications own-only, deliveries and the ledger invisible to clients, the settings group guard for both keys, the system reader not callable by clients, system context scoped to its organisation, the platform relay's view.
- **Playwright**: `notifications.spec.ts` (1).

## 8. Verification (local Postgres 16 @ 127.0.0.1:54329, databases `flowza_p8*`; DB-sharing suites under `flock /tmp/flowza-dbtests.lock`; final branch state)

| Gate | Result |
|---|---|
| `pnpm build:packages` | pass |
| `pnpm lint` (`--max-warnings 0`) | pass |
| `pnpm -r --filter "./apps/*" run typecheck` | pass (api, web, worker) |
| `pnpm test:unit` | pass — shared 4, contracts 40, domain 308, device-providers 286, database 20 |
| `pnpm --filter @flowza/web run test` | pass — 73 files, 346 tests |
| RLS suite (`flowza_p8_rls`) | pass — "RLS tests passed", 427 `ok` assertions (incl. `rls_notifications.sql`) |
| `pnpm test:db` | pass — 3 files, 15 tests |
| `pnpm --filter @flowza/api run test` | 385 / 386 in each of two full runs (29 / 30 files). The one failure, both times, is `approvals-review.test.ts > P2-13 a QUORUM override counts one approval…` — a **pre-existing random flake, not caused by this branch** (see below) |
| worker vitest | pass — 19 files, 206 passed, 1 skipped (207) |
| `pnpm -r --filter "./apps/*" run build` | pass |
| `db-reset-local.sh` on `flowza_p8_ci2` | pass (ready) |
| single-transaction replay (`flowza_p8_tx`) | pass |
| `pnpm db:types` against `flowza_p8` | no diff after `reset --seed` |
| `build:e2e` + Playwright | pass — 52 (26 scenarios × chromium + tablet), incl. the new `notifications.spec.ts` |

**The P2-13 flake.** The test's owner override names no seat, so the engine fills `open[0]`, "the first pending seat, in seat order". Seat order is `approval_step_actors` by `(created_at, id)`, but every seat of a level is inserted in the same transaction (one `created_at`) and `id` is `gen_random_uuid()`, so the override lands on one of the three HR-admin seats **at random**. One time in three it takes `hrLinked`'s seat; `hrLinked`'s own approval is then a no-op and the request stays `PENDING`, which is exactly the failure. It reproduces **in isolation** (the single test, run alone: 1 failure in 3 runs; the whole file alone passed 19 / 19 once). This branch does not touch the test, the seat ordering (`packages/domain`), the approval migrations or the test harness; its only engine change adds facts to the domain-event payload. Fix belongs to the approval-engine owner: pick the default override seat deterministically (e.g. `order by created_at, user_id`) or have the test name `onBehalfOfUserId`.

## 9. Shared files changed (for the integrator)

- **Registries**: `packages/contracts/src/sync.ts` (`DOMAIN_EVENT_TYPES` +2, appended), `packages/contracts/src/enums.ts` (`NOTIFICATION_CATEGORIES` +2 appended; new constants), `packages/contracts/src/organizations.ts` (notifications settings group → `notificationSettingsSchema`), `packages/contracts/src/dto/notifications.ts`, `packages/contracts/src/index.ts` (+1 export), worker `ROUTING` in `apps/worker/src/handlers/notifications/outbox.ts` (rewritten: recipients only; +2 types).
- **Generated**: `packages/database/src/generated/db.ts` (regenerate after merging: `NotificationCategory`, `MissingPunchReminders`, `NotificationDeliveries.nextAttemptAt`, `Notifications.inApp`).
- **Worker**: `handlers/index.ts` (comment), `tasks/index.ts` (+`notificationTasks`), `handlers/approvals/reminders.ts` (payload facts), `handlers/attendance/day-close.ts` (`employeeName`), `test/harness.ts` (e-mails keep html / text).
- **API**: `routes/v1/me.ts` (+2 routes), `services/me.service.ts` (inbox `in_app` filter), `services/organizations.service.ts` (per-group permission), `services/approvals/engine.ts` (payload facts), `services/approvals/hooks/leave.ts` (`leave.info_requested`).
- **Web**: `features/settings/sections/notifications-section.tsx`, `features/portal/pages/profile-page.tsx` (card appended), `locales/{en,ar}/settings.json` (`notifications` block), new `locales/{en,ar}/notification-preferences.json`, `e2e/support/mock-backend.ts` (preferences double; PUT defaults map).
- **Tests / RLS runner**: `supabase/tests/run-rls-tests.sh` (+1 suite before `rls_approvals.sql`), worker `outbox.test.ts`, `approvals/approvals.test.ts`, `attendance/policy-parity.test.ts`.
- **Not touched** (Prompt 5): the topbar bell count, the notifications inbox page and its click routing, dashboard widgets, the team workspace.

## 10. Limits and open items

- **Inbox page (Prompt 5 surface)**: shows the raw category code as its badge and has no tone for `LEAVE` / `REPORTS`; the bell and the page should localise category names.
- **`employee.imported#finished`** is templated but never emitted: no worker handler executes an import yet (pre-existing).
- The missing check-out reminder trusts the day record's status for holidays and weekly offs (a holiday added after the day was computed is caught only by the next recompute); only the employee is reminded (no manager copy).
- A report copy asked for e-mail only whose recipient switched REPORTS e-mail off is not delivered at all (the sender chose the channel, the recipient opted out).
- Deliveries are sent inside the batch transaction (pre-existing design; batch 100): a slow mailer holds the delivery rows' locks for the batch.
- Arabic texts were written by the implementer; a native-speaker review of `templates/ar.ts` and `notification-preferences.json` is recommended.
- SMS / WhatsApp / push remain declared in the channel enum and unused.
- Pre-existing API flake `approvals-review.test.ts > P2-13` (random default override seat, §8) — not fixed here: it belongs to the approval engine, not to notifications.
