# Phase 3 — Attendance policy parity and engine flags

**Prompt:** `docs/hr-portal/prompt-pack.md` §Prompt 3 (+ the implementing brief: settings groups with exact keys/defaults, `attendance_day_marks`, the pay-effect charger, engine flags, period-summary columns, the day-close sweep, HR endpoints).
**Branch:** worktree branch `worktree-agent-a71725ba1c79bd4f8` (from `claude/modest-fermi-fnwqq7` @ `0749045`) · **Migration:** `supabase/migrations/20260928000300_attendance_policy_parity.sql` · **Date:** 2026-09-27.
**Status:** every gate green (§5); nothing applied to the hosted project (Prompt 12).

## 1. What shipped

### Settings — `organization_settings.attendance` (contracts `attendanceSettingsSchema`)
Every pre-existing key is kept (`defaultShiftId`, `processingDelaySeconds`, `payrollPeriod`, `payrollCutoffDay`, `allowSelfServiceCorrections`). New nested groups (each `.prefault({})`, so a row saved before a group existed resolves to the full defaults — `.default({})` would short-circuit to `{}` in Zod 4):

| Group | Keys (default) |
|---|---|
| `selfService` | `webCheckIn` (false), `mobileCheckIn` (false), `requireGeofence` `'off'\|'flag'\|'block'` ('flag'), `allowSelfieCheckIn` (false), `ipAllowList` IPv4/IPv6 addresses or CIDRs, ≤ 50 ([]), `checkInWindow` / `checkOutWindow` `{start,end}` HH:mm or null (null), `outOfWindowAction` `'accept'\|'flag'\|'reject'` ('flag'), `duplicatePunchSeconds` 0–3600 (60) |
| `missedPunch` | `detectionEnabled` (true), `dayCloseGraceDays` 0–7 (2), `singlePunchSplitTime` HH:mm ('12:00') |
| `nonWorkingDay` | `action` `'record'\|'ignore'\|'overtime'` ('record'; **existing organisations are backfilled to 'overtime'**, §3 decision 8) |
| `unexcused` | `autoDeductEnabled` (false), `graceDays` 0–30 (3), `payEffectAbsent` (1), `payEffectLate` (0.5), `payEffectMissingPunch` (0.5) — each 0 / 0.5 / 1, `leaveTypePriority` (['AL','CL']), `excludeLeaveTypeCodes` (['SL','ML','PTL','HJ']) — codes normalised to upper case |
| `notes` | `requireReasonForLate` (false), `requireReasonForAbsent` (false) |
| `stats` | `attendanceTargetPct` 0–100 (90), `fullDayHours` 1–24 (8) |

`resolveAttendanceSettings(raw)` gives the effective document to the worker and the API (never throws; a malformed key — only possible through a manual DB edit — falls back to its own default and never resets the other keys). Settings → **Attendance** renders all groups (switches, selects, time windows, IP list, leave-code lists, numeric limits), PUTs the whole group and validates it with the shared schema (en + ar).

### Finance policy → FlowZa Time mapping

Finance keeps one `attendance_policies` row per org; FlowZa Time splits the same decisions between **effective-dated rule sets** (`attendance_rule_sets`, per branch), **shifts / weekly offs / holidays** (scheduling master data) and the new **`organization_settings.attendance`** groups.

| Finance field (default) | FlowZa Time | Notes |
|---|---|---|
| `punch_pairing_mode` first_in_last_out / net_worked | rule set `punch_interpretation` `FIRST_LAST` / `PAIRED` / `DIRECTIONAL` | existing |
| `auto_status_enabled` (false) | — | not ported: the engine is the only writer of a day's status; a manual status is a `SET_STATUS` correction (auditable, replayed by the engine) |
| `work_start_time` / `work_end_time` (09:00/18:00) | shift `start_time` / `end_time` (+ assignments) and `attendance.defaultShiftId` fallback | the fallback is now applied by the worker (defect fix) |
| `late_grace_minutes` (15) | rule set `grace_in_minutes` (+ shift `grace_in_minutes`) and `late_threshold_minutes` | existing; late is an arrival judgement only |
| `half_day_hours` (4) | rule set `half_day_threshold_minutes` | existing |
| `full_day_hours` (8) | rule set `min_full_day_minutes`; `attendance.stats.fullDayHours` for the self statistics | |
| `working_weekdays` ({1..5}) | weekly-off days: employee → branch → organisation `weekly_off_days`; rotation patterns | inverse representation, existing |
| `out_of_window_action` (late / absent / ignore) | device punches: shift punch windows (`punch_in_window_before_minutes` / `punch_out_window_after_minutes`) → `OUT_OF_WINDOW` flag + `missing_punch_behavior`; self-service punches: `attendance.selfService.outOfWindowAction` (accept / flag / reject) | self-service enforcement is the Prompt 4 punch endpoint; the engine already turns its `outOfWindow` payload into `OUT_OF_WINDOW` |
| `checkin_window_*` (06:00–12:00), `checkout_window_*` (12:00–22:00) | `attendance.selfService.checkInWindow` / `checkOutWindow` (null = any time) | for self-service punches; device punches use the shift punch windows |
| `single_punch_split_time` (13:00, deprecated) | `attendance.missedPunch.singlePunchSplitTime` ('12:00') | stored; see known limits |
| `missed_punch_detection_enabled` (false) | engine always flags `MISSING_IN` / `MISSING_OUT` (status per rule set `missing_punch_behavior`); `attendance.missedPunch.detectionEnabled` (true) decides whether the day close judges them | |
| `missing_punch_grace_days` (3) | `attendance.unexcused.graceDays` (3) and `attendance.missedPunch.dayCloseGraceDays` (2); the day close waits for the larger | |
| `auto_deduct_unexcused` (false) | `attendance.unexcused.autoDeductEnabled` (false) | |
| pay-effect weights absent 1.0 / late 0.5 / incomplete 0.5 | `attendance.unexcused.payEffectAbsent` / `payEffectLate` / `payEffectMissingPunch` | the largest applicable weight wins for a day |
| deduction order ANNUAL → CASUAL → most remaining; special types excluded | `attendance.unexcused.leaveTypePriority` / `excludeLeaveTypeCodes` (+ unpaid and untracked types are never charged) | tenant leave-type codes |
| `non_working_day_handling_enabled` + `non_working_day_action` (block / auto_label / overtime) | `attendance.nonWorkingDay.action` record / overtime / ignore; rule set `weekly_off_work_counts_as_overtime` / `holiday_work_counts_as_overtime` still apply under overtime | `block` not ported (a device punch is never refused; the day carries `NON_WORKING_DAY_WORK`); `auto_label` = status stays `WEEKLY_OFF` / `HOLIDAY` with `WORKED_ON_*` + `NON_WORKING_DAY_WORK` |
| `timezone` (Asia/Muscat) | branch timezone, organisation fallback | existing |
| `allow_web_checkin` / `allow_mobile_checkin` (true) | `attendance.selfService.webCheckIn` / `mobileCheckIn` (**false**) | opt-in (decision 13) |
| `enforce_geofence` (false) + fence `enforcement` | `attendance.selfService.requireGeofence` off / flag / block | per-fence rules arrive with geofences (Prompt 4); the engine flags `OUTSIDE_GEOFENCE` |
| `enforce_ip_restriction` + `work_locations.allowed_ip_ranges` | `attendance.selfService.ipAllowList` | org-wide list |
| `default_geofence_radius_meters` (200) | geofence `radius_m` (Prompt 4) | not a setting |
| selfie / open attendance | `attendance.selfService.allowSelfieCheckIn` + per-employee grant (Prompt 4) | |
| replay / duplicate guard | `attendance.selfService.duplicatePunchSeconds` (60); device punches: rule set `duplicate_punch_window_seconds` | |
| self-stats thresholds (< 90 %, < 8 h) | `attendance.stats.attendanceTargetPct` / `fullDayHours` | consumed by `/me/stats` (Prompt 4) |
| note requirements | `attendance.notes.requireReasonForLate` / `requireReasonForAbsent` | consumed by the notes endpoint (Prompt 4) |
| `calendar_feed_token` | — | HR calendar feed not in scope |
| `comp_off_settings` | — | Prompt 7 (leave v2); the day records and summaries already carry `NON_WORKING_DAY_WORK` / `non_working_day_work_minutes` as its input |

### Database (one additive, idempotent migration)
- **`attendance_day_marks`** — a reviewed verdict on one employee-day: `kind` UNEXCUSED / EXCUSED / LOP / PAY_EFFECT, `pay_effect_days` ∈ {0, 0.5, 1} (> 0 for LOP / PAY_EFFECT, 0 for EXCUSED, informative for UNEXCUSED), `source` SWEEP / NOTE_REVIEW / HR / SYSTEM, `source_id`, `reason`, `created_by`, revocation columns. Composite FKs to employees and branches; partial unique index = at most one **active** mark per (organisation, employee, date, kind); indexes for the loaders and the sweep. **Append-only with revocation** (trigger `app.protect_attendance_day_marks`): no DELETE, only the three revocation columns may change, once. RLS through `app.apply_tenant_policies` — read `attendance.view` (branch scope) OR own rows (`employee_id`) OR `attendance.view_team` for direct reports; write `attendance.approve` (branch scope).
- **`attendance_period_summaries`** += `lop_days numeric(6,1)`, `unexcused_days`, `excused_days`, `non_working_day_work_minutes` (defaults 0, CHECK ≥ 0).
- **Settings backfill:** `nonWorkingDay.action = 'overtime'` for every existing `organization_settings` row that never set it.
- `lock_timeout` / `statement_timeout`, `if not exists`, post-verify block (table, index, trigger, 4 policies with self + team predicates, the 4 columns, backfill complete). Applied twice on `flowza_p3` without change.

### Shared write primitives — `packages/database/src/attendance/`
The worker cannot import API code, so the functions both sides need live in `@flowza/database` (the API files named in the brief wrap them):
- `recompute-queue.ts` — the RECOMPUTE_DAILY contract (moved from the worker's `common.ts`, identical dedupe keys and reasons; the worker re-exports it).
- `day-marks.ts` — `markDay` (idempotent per employee/date/kind; a different pay effect supersedes the active mark by revoking it), `revokeMark` (idempotent), loaders; every write queues the day's recompute in the same transaction, so a mark reaches the record only through the engine.
- `pay-effect.ts` — `chargeUnexcusedDay` / `reverseUnexcusedCharge`: never charges an EXCUSED day, a day already charged (PAY_EFFECT / LOP mark) or a day covered by APPROVED leave; charges the first leave type in `leaveTypePriority` (then the paid type with the most remaining allowance for the year) that is active, paid, tracked (`annual_allowance_days` set) and not excluded, by writing a **PAY_EFFECT mark** and an **APPROVED `leave_records` row** (`source='INTERNAL'`, `external_ref='mark:<id>'`, reason/decision note "Unexcused day — auto-charged", `approved_by` null, half day for 0.5); with no balance it writes an **LOP mark**. Reversal cancels the leave row and revokes the PAY_EFFECT / LOP marks.

### Engine — `packages/domain/src/attendance`
- Inputs `dayMarks[]` and `settings.nonWorkingDay`; events carry the self-service punch payload (`channel`, `geofenceVerdict`, `isMock`, `outOfWindow`).
- New flags (appended to `ATTENDANCE_FLAGS`, so stored records keep their order): `UNEXCUSED`, `EXCUSED`, `LOP`, `PAY_EFFECT_HALF`, `PAY_EFFECT_FULL`, `OUTSIDE_GEOFENCE`, `SELF_SERVICE_PUNCH`, `NON_WORKING_DAY_WORK` (`OUT_OF_WINDOW` already existed and is now also raised by the payload). Each has a trace step (`punch.selfService`, `punch.geofence`, `punch.outOfWindow`, `nonWorkingDay`, `marks.*`).
- Result gains `lopDays` (0 / 0.5 / 1) and `unexcused`. `applyDayMarks` is pure: EXCUSED keeps LATE / ABSENT on the record but supersedes UNEXCUSED / PAY_EFFECT / LOP (`lopDays` 0); PAY_EFFECT → `PAY_EFFECT_HALF|FULL`; LOP → `LOP` + `PAY_EFFECT_*`. One rule `lopDaysOf(flags)` in contracts serves the engine, the API mappers, the period summaries and the reports.
- `nonWorkingDay.action`: `record` keeps the minutes with `NON_WORKING_DAY_WORK`, no overtime; `overtime` also counts them (rule-set switches and caps still apply); `ignore` zeroes worked/break/OT minutes (punch facts and `WORKED_ON_*` stay). A leave day always records.
- `OUTSIDE_GEOFENCE` only when a real fence failed (`flagged`, `logged`, `denied_outside`, `denied_mock`, `denied`, `outside`) or a mock location was reported — no verdict / no fence says nothing (B-36).

### Worker
- **Defect fix:** `load-inputs.ts` applies `settings.attendance.defaultShiftId` to D, D−1, D+1 when no assignment resolves (not on a rotation-pattern off day; an unknown shift degrades to NO_SHIFT). Loads the punch payloads (join on the raw partition key) and the active marks.
- `period-summary.ts` fills the four new columns.
- **Day close:** job `ATTENDANCE_DAY_CLOSE` + scheduler task `attendance.day-close` (hourly tick; an organisation is enqueued once, in its local 01:00 hour; dedupe key carries the local date). Marks ABSENT / LATE / MISSING_IN / MISSING_OUT days older than `max(dayCloseGraceDays, unexcused.graceDays)` with no active mark and no approved leave UNEXCUSED (source SWEEP); with `autoDeductEnabled` charges the pay effect through `chargeUnexcusedDay`; skips locked periods; 31-day lookback, ≤ 5,000 days per org per run (`capped` reported), savepoint per day; audit row; one `attendance.unexcused_marked` event per employee.
- **Notifications:** `attendance.unexcused_marked` (added to `DOMAIN_EVENT_TYPES`) is routed with the new recipients kind `'users'` — exactly `payload.userIds` (the employee's login + line managers holding `attendance.approve`, else the approvers who can open the employee's records: `attendance.approve` + `attendance.view`, all branches or the employee's branch), re-checked against active memberships.
- **Reports:** Summary (Sample 3) appends `UNX` / `LOP` columns, Monthly (Sample 4) appends `LOP` after `Abs` — after the samples' own columns so positional imports do not shift — with an explanatory footnote (en + ar).

### API
- `GET /orgs/:orgId/attendance/day-marks?employeeId&from&to[&includeRevoked&kind]` — `attendance.view` (branch scope), own days (`attendance.view_own`), direct reports (`attendance.view_team`); ≤ 366 days.
- `POST /orgs/:orgId/attendance/day-marks` — `attendance.approve`; kinds EXCUSED / UNEXCUSED / PAY_EFFECT + reason (LOP is written by the charger only). Line managers: direct reports only; nobody marks their own day; locked period → 409 `PERIOD_LOCKED`; a contradictory verdict (UNEXCUSED / PAY_EFFECT on an excused or leave-covered day) → 409 `INVALID_STATE` with the charger outcome. EXCUSED reverses any charge first; PAY_EFFECT and UNEXCUSED-with-pay-effect run the charger (response carries `charge {outcome, leaveTypeCode}`).
- `POST /orgs/:orgId/attendance/day-marks/:id/revoke` — `attendance.approve` + the same scope rules; a PAY_EFFECT revocation cancels its leave row (balance restored). Idempotent.
- Daily record DTO: `lopDays`, `unexcused`; record detail: `marks` (active and revoked). Payroll summaries: the four new columns.
- **Defect fixes:** dashboard summary / trends / branches and the daily list count missing punches by the `MISSING_IN` / `MISSING_OUT` flags (the engine never stores a `MISSING_PUNCH` status); the daily list's `status=MISSING_PUNCH` filter uses the same predicate and its meta carries `missingPunch`.

### Web
- Settings → Attendance: the six groups above (en + ar), read-only without `organization.manage`.
- Attendance record dialog: **Day marks** strip — one badge per mark (unexcused / excused / charged to leave · n day / loss of pay · n day; revoked ones struck through) with a tooltip and accessible label naming source, time, reason and revocation, plus the record's loss-of-pay badge. Labels and tones for the eight new flags (flag chips everywhere). Trace view shows the new steps.
- Daily view: the "Missing punch" card shows the flag-based count and filters by it.
- Payroll summaries: **Unexcused (excused)**, **LOP days**, **Off-day work h:mm** columns (en + ar).

## 2. Acceptance items (Appendix A `ATT-*`, Appendix B `B-*`)

| Item | Status |
|---|---|
| ATT-28 policy singleton with every 4.1 field | ✓ `organization_settings.attendance` + rule sets; every field mapped (table above); `auto_status_enabled`, `block`, calendar feed deliberately not ported |
| ATT-29 master switch `auto_status_enabled` | — not ported by design (decision 12) |
| ATT-30 arrival ladder / out-of-window action | ✓ existing engine (grace, late threshold, punch windows → `OUT_OF_WINDOW`, missing-punch behaviour); self-service action setting stored for Prompt 4 |
| ATT-31 half day < threshold | ✓ existing (`half_day_threshold_minutes`) |
| ATT-32 late is arrival-only | ✓ existing (`UNDER_HOURS` is a separate flag) |
| ATT-33 night shift overnight | ✓ existing (cross-midnight shifts) |
| ATT-34 working weekdays | ✓ existing (weekly-off days, inverse) |
| ATT-35 missed-punch detection + day close | ✓ `MISSING_IN/OUT` flags + `missing_punch_behavior`; day close judges them after the grace when `missedPunch.detectionEnabled` |
| ATT-36 windows decide a single punch's side | partial — device punches: shift windows + `punch_interpretation`; `singlePunchSplitTime` stored, not yet read by the engine (known limit) |
| ATT-37 non-working-day handling | ✓ record / overtime / ignore (block not ported) + `NON_WORKING_DAY_WORK` |
| ATT-38 pairing mode | ✓ existing (`FIRST_LAST` / `PAIRED` / `DIRECTIONAL`) |
| ATT-39 policy timezone | ✓ existing (branch / organisation zone) |
| ATT-40 server-side classifier, TS mirror | ✓ one pure engine executed server-side by the worker (no mirror to drift) |
| ATT-41 / ATT-42 manual never overwritten | ✓ existing (corrections are events; raw immutable); marks follow the same rule (append-only + revocation) |
| ATT-43 derived register | ✓ existing (engine writes HOLIDAY / LEAVE / ABSENT / NOT_JOINED / EXITED) |
| ATT-44 comp-off credit | — Prompt 7; `NON_WORKING_DAY_WORK` + `non_working_day_work_minutes` are its input |
| ATT-87 sweep of unexplained days after N grace days | ✓ `attendance.day-close` (marking by default, deduction opt-in) |
| ATT-88 sweep skips processed / excused / leave days | ✓ any active mark, EXCUSED, approved leave, locked periods; note statuses join in Prompt 4 (notes write marks through `markDay`) |
| ATT-89 payroll read model | ✓ period summaries: working / paid-leave / leave days + `lop_days`, `unexcused_days`, `excused_days`; claimable LOP note ids → Prompt 4 |
| ATT-90 LOP priced in payroll | — out of scope: FlowZa Time exports LOP days (payroll page, CSV, reports); pricing is the payroll system's (Finance sync, Prompt 9) |
| B-13 attendance % | partial — `stats.attendanceTargetPct` (hint threshold); the rate itself is the existing `/me` month total (present incl. late + ½ half day over expected days); `selfStats.ts` in Prompt 4 |
| B-14 average hours ignore zero-hour days | — Prompt 4 (`selfStats.ts`); `stats.fullDayHours` ready |
| B-15 improvement hints (< 90 %, < 8 h, late, absent, missing check-out) | partial — thresholds in `stats.*`; hints in Prompt 4 |
| B-16 punctuality (start, grace) | — Prompt 4; FlowZa reads start from the resolved shift and grace from the rule set (no fixed 09:00 / 15 min) |
| B-25 sweep auto-deducts unexcused absent / late / incomplete after N grace days when enabled, writing a system note | ✓ — the "system note" is a SWEEP-sourced day mark with its reason; the charge is the same function a note rejection will use (Prompt 4) |
| B-36 `within_geofence` truth table | ✓ at flag level: `OUTSIDE_GEOFENCE` only when a real fence failed (or mock location); no verdict / no fence ⇒ no flag |

## 3. Decisions (priority order Security > Reliability > Data Integrity > … > UX)

1. **Shared write primitives in `@flowza/database`.** Marks and the charger are needed by the API (HR, note review) and the worker (sweep). Duplicating them would let the two drift; the API's `services/attendance/{day-marks,pay-effect}.ts` are authorised wrappers over the same functions.
2. **Marks are append-only with revocation, enforced by a trigger** (like raw transactions and events): a wrong verdict is revoked with who/why and a new one written. No DELETE path at all (organisations are closed, employees soft-deleted).
3. **The engine is the only writer of the record.** A mark never patches a daily record; it queues the day's recompute in the same transaction and `applyDayMarks` folds it in (deterministic, traced). `lopDays` is **derived from flags**, not a column on the hot daily-records table.
4. **EXCUSED wins.** It keeps the facts (LATE / ABSENT stay) and waives the consequences (`lopDays` 0); writing it reverses any charge first, so the leave balance comes back. UNEXCUSED / PAY_EFFECT on an excused or leave-covered day is refused (409) rather than silently layered.
5. **A charge to leave is a real APPROVED leave row** anchored on its PAY_EFFECT mark (`external_ref='mark:<id>'`). The recompute then sees the day as (half-day) leave, balances and payroll read it with no special case, and the reversal is exact. Balance = allowance − APPROVED days in the calendar year of the date (pending requests do not reserve); only active, paid, tracked, non-excluded types; priority list first, then most remaining (tie: code). Half day: FIRST_HALF for a late arrival, SECOND_HALF for absent / missing punch (sweep); HR default FIRST_HALF.
6. **Idempotent per (employee, date):** an existing PAY_EFFECT / LOP → `already_charged` (the existing mark is returned); approved leave → `covered_by_leave` (never charged); EXCUSED → `excused`.
7. **Authorization twice for HR marks.** Service: `attendance.approve`, direct reports only for line managers without `attendance.view`, branch scope, no own days (segregation of duties), locked periods refused. RLS: the mark itself is written in the user context (write policy = `attendance.approve` + branch); the leave row / reversal runs in a `systemStep` because an APPROVED leave row is a system decision the user-level policy reserves for `leave.manage`. Every write is audited (`attendance.day_mark_created|revoked`).
8. **`nonWorkingDay.action` default `record` (per the brief) with a backfill to `overtime` for existing organisations.** The engine counted weekly-off / holiday work as overtime (per the rule-set switches) until now; flipping existing tenants to "no overtime" on deploy would silently change payroll figures. New organisations start with `record`.
9. **Default shift fallback** applies where no assignment resolves (D and both neighbours for window attribution), never on a rotation-pattern off day, keeps `shiftAssignmentId` null (it is not an assignment), and an unknown shift id degrades to NO_SHIFT instead of failing the day.
10. **Day close:** grace = the larger of the two grace settings; a 31-day lookback so switching the policy on does not judge months of history; ≤ 5,000 days per run with a savepoint per day (one bad day never blocks the rest); marking is on by default (detection on) but money moves only with `autoDeductEnabled`; a day is judged once — days marked while deduction was off are not charged when it is switched on (HR can charge by hand). The job is enqueued once per local day in the organisation's 01:00 hour because the queue only dedupes *pending* jobs (a completed job would otherwise be re-enqueued every hour); a missed window is caught up by the next day's lookback.
11. **Targeted notifications:** one event per employee per run; recipients resolved at emit time and re-checked at relay time (active members only). A line manager of another team is never notified.
12. **`auto_status_enabled` and `block` are not ported.** FlowZa Time never discards or blocks a device punch (raw immutability, §AGENTS 3) and always classifies; the org can express "don't count it" with `nonWorkingDay.action = 'ignore'` and "manual status" with a `SET_STATUS` correction.
13. **Self-service check-in defaults off** (Finance: on). The punch endpoint arrives in Prompt 4; tenants opt in (Security first).
14. **`missedPunch.detectionEnabled` defaults on** (brief) — FlowZa already flags missing punches on every day; the switch only decides whether the day close judges them.
15. **Report columns are appended**, never inserted, so the sample layouts' positions stay where existing payroll imports expect them.
16. **Settings group is PUT whole** and parsed through the partial schema; the contracts test pins that a full document round-trips unchanged (no defaults re-applied) and that a single nested key leaves its siblings at their defaults.

## 4. Files

- Migration: `supabase/migrations/20260928000300_attendance_policy_parity.sql`; generated types `packages/database/src/generated/db.ts`
- Contracts: `packages/contracts/src/{organizations,attendance,enums,sync}.ts`, `dto-features/{day-marks,index}.ts`, test `organizations.test.ts`
- Database: `packages/database/src/attendance/{recompute-queue,day-marks,pay-effect,index}.ts`, `src/index.ts`
- Domain: `packages/domain/src/attendance/{types,calculate,period,testing}.ts`, `reports/labels.ts`; tests `calculate.test.ts`, `period.test.ts`, `marks.test.ts`
- Worker: `apps/worker/src/handlers/attendance/{common,load-inputs,period-summary,day-close,tasks,index}.ts`, `handlers/notifications/outbox.ts`, `handlers/reports/definitions/{summary,monthly}.ts`; tests `attendance/{attendance,policy-parity}.test.ts`, `reports/generate.test.ts`
- API: `apps/api/src/services/attendance/{day-marks,pay-effect}.ts`, `routes/v1/features/{day-marks,index}.ts`, `services/features/{attendance.service,mappers,reports.service}.ts`, `services/dashboard.service.ts`; test `routes/v1/features/day-marks.test.ts`
- Web: `apps/web/src/features/settings/sections/attendance-section.tsx` (+ test), `features/attendance/{status,types,api}.ts`, `components/{day-marks (+ test),record-dialog,daily-view}.tsx`, `features/payroll/{types.ts,pages/payroll-page.tsx (+ test)}`, `features/portal/portal.test.tsx` (fixture), locales `en|ar/{settings,attendance,payroll}.json`
- RLS: `supabase/tests/{rls_isolation,rls_system_context}.sql`

## 5. Verification (local Postgres 16 @ 127.0.0.1:54329; DB-sharing suites under `flock /tmp/flowza-dbtests.lock`)

| Gate | Result |
|---|---|
| `pnpm build:packages` | pass |
| `pnpm lint` (`--max-warnings 0`) | pass |
| `pnpm -r --filter "./apps/*" run typecheck` | pass (api, web, worker) |
| `pnpm test:unit` | pass — shared 4, contracts 5 (new: defaults, legacy keys, full round-trip / partial trap, range rejection, per-key fallback), domain 208 (new `marks.test.ts`: payload flags, geofence verdicts incl. mock, marks, excused override, determinism; non-working-day actions; period columns), device-providers 140, database 20 |
| `pnpm --filter @flowza/web run test` | pass — 50 files, 185 tests (new: attendance settings section, day-mark badges + flag labels, payroll columns) |
| `PGDATABASE=flowza_p3_rls bash supabase/tests/run-rls-tests.sh` | pass — 32 new day-mark assertions: owner org-wide read/write, one active mark per kind, cross-tenant write refused, verdict immutable, no delete, revoke once then frozen; branch manager branch scope (read, write, revoke); employee own marks only, cannot excuse / revoke own day, relationship without team key reveals nothing; line manager and secondary manager see the direct report's marks only; auditor reads all, every write refused / 0 rows; owner B cross-tenant zero; platform read grant reads but cannot write; system context reads own org only |
| `pnpm test:db` | pass — 2 files, 11 tests |
| `pnpm --filter @flowza/api run test` | pass — 18 files, 178 tests (new `day-marks.test.ts`, 7 tests: settings round-trip + defaults for omitted keys + validation + owner-only; mark authorization (employee / outsider / other team / own day / invalid kinds); manager excuse + RLS-scoped list + record detail marks; charger AL first → CL half day → LOP, never double-charges, excused / leave-covered refused, revoke restores the balance and allows a re-charge, EXCUSED reverses a charge; locked period 409; dashboard and daily-list missing-punch counters by flags) |
| `pnpm --filter @flowza/worker run test` | pass — 11 files, 115 tests (1 skipped, pre-existing); new `policy-parity.test.ts` (10: assessDay weights; sweep grace / skips / notifications incl. relay; idempotency; manager-less routing; auto-deduction AL → LOP → CL half day, recompute folds marks into flags/status, sweep ignores recomputed days, period-summary columns; grace + detection switch; scheduler local-hour window + dedupe; default-shift fallback; payload flags end-to-end; payload key allow-list); report tests extended (UNX / LOP columns + footnote) |
| `pnpm -r --filter "./apps/*" run build` | pass |
| `PGDATABASE=flowza_p3_ci2 bash scripts/db-reset-local.sh` | pass (all migrations on a fresh DB) |
| `PGDATABASE=flowza_p3 bash scripts/db-reset-local.sh --seed` + `pnpm db:types` | pass; `db.ts` in sync (committed); migration re-applied a second time without error |

## 6. Known limits / follow-ups

- **Self-service settings are stored, validated and shown, but enforced by Prompt 4**: `webCheckIn` / `mobileCheckIn` / `allowSelfieCheckIn`, `requireGeofence`, `ipAllowList`, check-in / check-out windows and `outOfWindowAction`, `duplicatePunchSeconds`, `notes.*`, `stats.*`. The engine side is ready (payload → `SELF_SERVICE_PUNCH` / `OUTSIDE_GEOFENCE` / `OUT_OF_WINDOW`).
- **`missedPunch.singlePunchSplitTime` is not read by the engine**: device punches keep using the rule set's `punch_interpretation` and the shift punch windows; the split time is for the self-service endpoint.
- **Notes (Prompt 4)** will write NOTE_REVIEW marks through `markDay` / `chargeUnexcusedDay` and extend the sweep's "open explanation" to pending notes; LOP note ids for the payroll read model come with them.
- **Days marked while auto-deduction was off are not charged retroactively** (decision 10).
- **Write team scope is service-level**: the RLS write policy on marks is `attendance.approve` + branch (like corrections); the direct-report rule for line managers is enforced in the service.
- **Comp-off** (ATT-44) → Prompt 7; **payroll pricing of LOP** (ATT-90) is not FlowZa Time's job.
- **Merge note for Prompt 2**: `apps/api/src/services/features/attendance.service.ts` changed only in its imports, `listDaily` (missing-punch predicate + meta) and `getRecord` (marks) — no approval code; `packages/contracts/src/sync.ts` gained one `DOMAIN_EVENT_TYPES` entry. Textual conflicts, if any, are local.
- Playwright e2e (`build:e2e` / `test:e2e`) was not part of this prompt's gate list and was not run; the new DTO fields are optional on the web side.
- No new dependencies.
