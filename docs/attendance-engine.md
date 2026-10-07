# Attendance Engine

Pure, deterministic TypeScript in `packages/domain/src/attendance/` (no IO, 139 unit tests). The worker feeds it from the
database; the API only reads its results. Design: `docs/blueprint.md` §G, ADR-005.

## Pipeline
```
attendance_raw_transactions ──normaliser──▶ attendance_events ──engine──▶ attendance_daily_records (+ history, trace)
   (immutable, per device)   employee resolution     (immutable, void-only)   per (employee, attendance_date)
                                                      + manual/correction events
```
Recompute triggers: new event, approved correction, rule-set/shift/holiday/leave change, a changed joining or exit date (the
days between the old and the new date, up to today), explicit recalculation request — and, for days nobody punched on,
the hourly materialisation job (`ATTENDANCE_MATERIALIZE_DAYS`, below), so every past day of employment has a record.
Records inside a locked period are skipped and listed in the recalculation summary.

## Public API (`@flowza/domain`)
| Function | Purpose |
|---|---|
| `computePunchWindow(shift, date, tz)` | FIXED: `[start − punchInWindowBefore, end + punchOutWindowAfter)`, end on D+1 when `endTime <= startTime`; FLEXIBLE: `[dayBoundary(D), dayBoundary(D+1))`; no shift: local calendar day |
| `attributeEvents(events, windows)` | Deterministic attribution when neighbouring windows overlap: nearest scheduled start wins, ties → earlier date, no-shift windows never beat a real shift; voided/out-of-window recorded |
| `carryOvernightCheckOuts(attribution, windows, shiftOf)` | FLEXIBLE shifts (engine 1.3.0): the next day's leading check-out that closes a day's open check-in moves back to that day (`OVERNIGHT_CHECK_OUT`), within `overnightMaxSpanMinutes(shift)` = required + unpaid breaks + 4 h (≤ 20 h) |
| `collapseDuplicates`, `interpretPunches`, `computeBreaks` | Duplicate collapsing (keep first within `duplicatePunchWindowSeconds`), FIRST_LAST / PAIRED / DIRECTIONAL interpretation, MISSING_IN/MISSING_OUT, measured vs fixed vs scheduled breaks (paid allowance credited back) |
| `roundMinutes`, `roundInstant`, `roundPunches` | Rounding (NONE/NEAREST/UP/DOWN) from local midnight; raw timestamps stay in the trace |
| `calculateDailyRecord(input)` | The daily calculation (below) |
| `resolveShift(assignments, patterns, scope, date)` | EMPLOYEE > TEAM > DEPARTMENT > BRANCH > ORGANIZATION, half-open effective ranges `[effective_from, effective_to)` as stored (the API and the UI speak of the inclusive last day and convert at the boundary, see docs/api.md), rotation cycle day from `anchorDate`, `isPatternOff` |
| `resolveRuleSet(ruleSets, date, branchId)` | Branch-specific first, then organisation default; latest `effectiveFrom` (policies scoped by another dimension are ignored) |
| `resolvePolicy(policies, date, scope)` / `explainPolicyResolution` | Enterprise attendance policies (docs/enterprise/plan.md §4): every dimension a policy names (country of the branch, branch, department, employee group, the day's primary shift) must match; the most specific wins — shift 32 > group 16 > department 8 > branch 4 > country 2 > organisation 0 — then the latest `effectiveFrom`, then id. The loader (`packages/database/src/attendance/policy.ts` `resolvePolicyFor`) feeds the engine with it |
| `composeDoubleShift(primary, additional)` | Engine 1.4.0: two FIXED shifts on one date become one day from the first start to the last end, the gap an unpaid break, grace / windows from the outer shifts, `segments` kept (flag `DOUBLE_SHIFT`); refused: flexible, overlap, ≥ 24 h, same shift |
| `summarisePeriod(records, opts)` | Payroll totals matching `attendance_period_summaries` (HALF_DAY = 0.5 present; MISSING_PUNCH in `missingPunchDays` only; weekly-off/holiday OT in their own columns) |
| `decideRetry`, `nextAdaptiveInterval` (sync) | Provider-agnostic retry policy and adaptive polling |

## Status precedence and rules (`calculateDailyRecord`)
1. `NOT_JOINED` (before `joiningDate`) / `EXITED` (after `exitDate`).
2. `HOLIDAY` → `WEEKLY_OFF` → `LEAVE` (full day). Work on these days keeps the status, adds `WORKED_ON_HOLIDAY` /
   `WORKED_ON_WEEKLY_OFF`, and — when the rule set allows — counts all worked minutes as overtime with `overtimeCategory`
   `HOLIDAY` / `WEEKLY_OFF`. Half-day leave/holiday halves expectations and thresholds (`HALF_DAY_LEAVE`).
3. Punches: late = `firstIn − (expectedStart + grace)`, flagged `LATE` only above `lateThresholdMinutes`; early departure
   symmetric with `graceOutMinutes` / `earlyDepartureThresholdMinutes`; worked = span − unpaid breaks (worked rounding);
   overtime (engine 1.2.0) = the minutes WORKED after the expected end (before the expected start too with
   `countEarlyInAsOvertime`) — measured on the worked spans, so a punched break out there does not count, and never more than
   the minutes worked — less `overtimeStartAfterMinutes`, rounded DOWN to `overtimeRoundingMinutes`, whole
   `overtimeMinBlockMinutes` blocks, capped by `overtimeMaxMinutesPerDay`. By default every minute after the shift end counts
   (threshold, rounding and block 0); `overtimeRequiresScheduledHours` keeps only the part beyond the scheduled minutes (a late
   arrival who makes up the time after the end earns none — the rule of engines ≤ 1.1.0, kept by rule sets saved before 1.2.0);
   flexible shifts (engine 1.1.0): **check in at any time, leave after the required time** — the expected check-out
   (`expected_end_at`) is the (rounded) first IN + required minutes + the shift's unpaid breaks (no break on a half day),
   or the core end when that is later; `expected_start_at` is the core start, else the check-in itself. Without core hours
   the employee is never late. Early departure (engine 1.3.0) is the **shortfall**: the larger of the time left before that
   expected check-out and required − worked (not on a half day, whose fixed break is already out of the worked minutes);
   `graceOutMinutes` is a tolerance on it — a shortfall within the grace is forgiven, one beyond it counts in full (required
   8 h, grace 1: 7h59m → no early departure, 7h58m → 2 min; engines ≤ 1.2.0 shaved the grace off every shortfall, so
   7h58m showed 1 min). FIXED shifts keep `lastOut` vs `expectedEnd − grace`. The expected check-out is on
   the record from the moment of the check-in (PENDING day), so the portal's check-in page ("You can check out from …")
   and the missing check-out reminder use it. OT = worked − required − threshold. **Overnight** (engine 1.3.0): a
   check-in still open at the day boundary is closed by the next day's leading check-out (`PUNCH_OUT`, not an undirected
   `PUNCH`) within required + unpaid breaks + 4 h (at most 20 h) — 22:00 → 06:00 is 8 h worked on the check-in day,
   `CROSS_MIDNIGHT`, no `MISSING_OUT`, and the next day does not see a stray check-out. Until that limit has passed the
   check-in day stays `PENDING`; a check-out later than that (a forgotten one) stays on its own day as before. A check-out
   with no open check-in behind it still belongs to the day it falls on;
   `UNDER_HOURS` when worked < `minFullDayMinutes`; `HALF_DAY` when worked < `halfDayThresholdMinutes`.
4. No punches: `ABSENT` when `autoAbsentWithoutPunches` and the day is over (`now` past the window end); otherwise `PENDING`.
   **Callers must pass `now`** when computing the current day; without it the day is treated as finished (historical recompute).
   **A working day without a resolved shift** follows the same rule as any working day — one rule for the daily register,
   the monthly summary and the reports: punches → `PRESENT` + `NO_SHIFT` (worked = first → last punch, no lateness,
   early departure or overtime expectations), none → `ABSENT` + `NO_SHIFT` once the day is over. It is never dropped: a
   day of employment without any record yet is reported as *not calculated* (summary column / report column `Not calc.`)
   until the materialisation job or a recalculation writes it.
5. Missing punch (IN only / OUT only): `FLAG_ONLY` → `MISSING_PUNCH` + `MISSING_OUT`/`MISSING_IN` with 0 worked minutes
   (engine 1.3.0; engines ≤ 1.2.0 wrote `PRESENT`, which inflated Present and understated Worked). Its hours are unknown,
   so it is counted on its own — in Missing punch only (period summaries, the monthly summary, report code `MP`), never in
   Present, Absent or Days worked — until the punch is corrected; on a half-day leave/holiday it stays `HALF_DAY`.
   `ASSUME_SHIFT_END` → worked to the scheduled end (no OT, assumed instant not reported as a timestamp; without a shift
   it falls back to FLAG_ONLY); `TREAT_AS_ABSENT`; `TREAT_AS_HALF_DAY`. The dashboard "missing punches" KPI counts the flags.
6. Ramadan mode (`rules.ramadanMode`): within the date range (and eligibility) scheduled minutes shrink and `expectedEnd`
   moves earlier; flag `RAMADAN_HOURS`.
6b. Engine 1.4.0 (Enterprise): `VERY_LATE` when a late arrival is more than the policy's `late.veryLateAfterMinutes` after the
   SCHEDULED start (not after the grace: "after 09:00" on an 08:00 shift is 60); `DOUBLE_SHIFT` on a composite day of two
   shifts (an `additional_shift_assignments` row folded in by the loader). Nothing changes for a day without either.
7. Flags (canonical order): `LATE, EARLY_DEPARTURE, OVERTIME, MISSING_IN, MISSING_OUT, MANUAL_CORRECTION, OUT_OF_WINDOW,
   WORKED_ON_HOLIDAY, WORKED_ON_WEEKLY_OFF, HALF_DAY_LEAVE, DUPLICATE_PUNCHES_COLLAPSED, RAMADAN_HOURS, CROSS_MIDNIGHT,
   NO_SHIFT, UNDER_HOURS, …, VERY_LATE, DOUBLE_SHIFT`.

## Known design choices (from the adversarial review)
- Punch rounding is applied to the punch instants **before** late/early evaluation (09:08 with NEAREST-15 → 09:15 → 5 min late
  despite a 10-min grace). This matches how most payroll-grade systems define "punch rounding"; organisations that want grace
  evaluated on raw instants should keep `punchRoundingMinutes = 0` and use `workedRoundingMinutes`.
- Work on holidays/weekly offs credits **all** worked minutes as overtime (cap only) — thresholds/min-blocks apply to regular
  overtime only.
- Omitting `now` means "the day is over"; the worker always passes it.

## Trace (support and payroll disputes, §88)
`trace.inputs` (shift, rule set, timezone, window, holiday, leave, weekly off), `trace.punches` (every event with its local time
and role IN/OUT/BREAK_*/IGNORED/DUPLICATE/OUT_OF_WINDOW), `trace.steps` (each rule with intermediate values) and
`engineVersion`. Stored as `attendance_daily_records.trace`; every recompute snapshots the previous record into
`attendance_daily_record_history` with a `reason`.

## Cross-midnight example (tested)
Shift 22:00–06:00 Asia/Muscat, punches 21:57 (D) and 06:08 (D+1) → attendance date D, worked 8h11m minus unpaid break, flag
`CROSS_MIDNIGHT`; a punch at 05:50 (D+1) belongs to D's window, a punch at 21:50 (D+1) to D+1's window (nearest start). For
rotating schedules pass `adjacentShifts` (D−1/D+1) so neighbouring windows are exact.

Flexible shift (8 h required, day boundary 00:00), check-in 22:00 (D) and check-out 06:00 (D+1) → attendance date D, 480
worked minutes, `CROSS_MIDNIGHT`; D+1 has no punch left (ABSENT once over, not `MISSING_IN`). At 02:00 (D+1) D is still
`PENDING`; with no check-out by 22:00 + 12 h it becomes `MISSING_PUNCH` (`calculate.test.ts`, "flexible overnight check-out").

## Worker integration contract
- Normaliser resolves `device_employee_id` → employee via `device_employee_states` → `employee_provider_identities` →
  `employees.device_user_id` (unmatched rows stay `unmatched`), attaches the **effective branch on that date**, and enqueues a
  throttled `RECOMPUTE_DAILY` per (employee, date) — for cross-midnight shifts also for D−1. The organisation's
  `processingDelaySeconds` is the throttle window: a day not recalculated within the last window is recomputed at once (a
  pushed punch reaches the register within seconds), a day recalculated less than a window ago at the end of that window.
- For a FLEXIBLE shift the normaliser's D−1 reach covers the overnight carry: a punch up to `overnightMaxSpanMinutes` after
  D−1's day boundary also recomputes D−1 (`neighbour-reach.test.ts`).
- The recompute job loads events in `[date − 1, date + 2)` (branch timezone), resolves shift (+ the additional shift of a double
  shift) and the policy (`resolvePolicyFor`: country / branch / department / employee group on the date / primary shift), holidays
  (branch calendar), weekly-off (employee → branch → org), approved leave, passes `now`, writes the record with
  `calculation_version + 1`, a history snapshot when anything changed, and emits `attendance.created`/`attendance.updated`.
- `summarisePeriod` needs `leaveIsPaid` per record (join leave records); `overtimeMinutes` is REGULAR only.
- Materialisation (`ATTENDANCE_MATERIALIZE_DAYS`, `apps/worker/src/handlers/attendance/materialize.ts`): records exist only
  where something triggered a recompute, so a day nobody punched on used to have no record and dropped out of every
  summary column. Every hour the scheduler (`attendance.materialize`, deduped per org) enqueues one job per active org that
  computes the missing or still-`PENDING` days of the last 3 days (up to yesterday, org timezone) for employees in
  employment, at most 20 000 pairs per run, 200 per transaction chunk. Older gaps are closed by a recalculation (the
  Attendance summary page offers "Recalculate month" when it sees them).
- Joining / exit date changes (`employees.service.ts`, `employmentDatesRecalcRange`) enqueue a recalculation of the days
  between the old and the new date (up to today), so NOT_JOINED / EXITED records in that gap are recomputed. An employee created
  with a past joining date gets the days since joining calculated too — from the organisation's first day (its creation date)
  at the earliest, so a long-serving employee entered at go-live is not given years of absences.
