# Attendance Engine

Pure, deterministic TypeScript in `packages/domain/src/attendance/` (no IO, 139 unit tests). The worker feeds it from the
database; the API only reads its results. Design: `docs/blueprint.md` §G, ADR-005.

## Pipeline
```
attendance_raw_transactions ──normaliser──▶ attendance_events ──engine──▶ attendance_daily_records (+ history, trace)
   (immutable, per device)   employee resolution     (immutable, void-only)   per (employee, attendance_date)
                                                      + manual/correction events
```
Recompute triggers: new event, approved correction, rule-set/shift/holiday/leave change, explicit recalculation request.
Records inside a locked period are skipped and listed in the recalculation summary.

## Public API (`@flowza/domain`)
| Function | Purpose |
|---|---|
| `computePunchWindow(shift, date, tz)` | FIXED: `[start − punchInWindowBefore, end + punchOutWindowAfter)`, end on D+1 when `endTime <= startTime`; FLEXIBLE: `[dayBoundary(D), dayBoundary(D+1))`; no shift: local calendar day |
| `attributeEvents(events, windows)` | Deterministic attribution when neighbouring windows overlap: nearest scheduled start wins, ties → earlier date, no-shift windows never beat a real shift; voided/out-of-window recorded |
| `collapseDuplicates`, `interpretPunches`, `computeBreaks` | Duplicate collapsing (keep first within `duplicatePunchWindowSeconds`), FIRST_LAST / PAIRED / DIRECTIONAL interpretation, MISSING_IN/MISSING_OUT, measured vs fixed vs scheduled breaks (paid allowance credited back) |
| `roundMinutes`, `roundInstant`, `roundPunches` | Rounding (NONE/NEAREST/UP/DOWN) from local midnight; raw timestamps stay in the trace |
| `calculateDailyRecord(input)` | The daily calculation (below) |
| `resolveShift(assignments, patterns, scope, date)` | EMPLOYEE > TEAM > DEPARTMENT > BRANCH > ORGANIZATION, half-open effective ranges, rotation cycle day from `anchorDate`, `isPatternOff` |
| `resolveRuleSet(ruleSets, date, branchId)` | Branch-specific first, then organisation default; latest `effectiveFrom` |
| `summarisePeriod(records, opts)` | Payroll totals matching `attendance_period_summaries` (HALF_DAY = 0.5 present; weekly-off/holiday OT in their own columns) |
| `decideRetry`, `nextAdaptiveInterval` (sync) | Provider-agnostic retry policy and adaptive polling |

## Status precedence and rules (`calculateDailyRecord`)
1. `NOT_JOINED` (before `joiningDate`) / `EXITED` (after `exitDate`).
2. `HOLIDAY` → `WEEKLY_OFF` → `LEAVE` (full day). Work on these days keeps the status, adds `WORKED_ON_HOLIDAY` /
   `WORKED_ON_WEEKLY_OFF`, and — when the rule set allows — counts all worked minutes as overtime with `overtimeCategory`
   `HOLIDAY` / `WEEKLY_OFF`. Half-day leave/holiday halves expectations and thresholds (`HALF_DAY_LEAVE`).
3. Punches: late = `firstIn − (expectedStart + grace)`, flagged `LATE` only above `lateThresholdMinutes`; early departure
   symmetric with `graceOutMinutes` / `earlyDepartureThresholdMinutes`; worked = span − unpaid breaks (worked rounding);
   overtime = after `expectedEnd + overtimeStartAfterMinutes` (optionally early-in), rounded DOWN to
   `overtimeRoundingMinutes`, whole `overtimeMinBlockMinutes` blocks, capped by `overtimeMaxMinutesPerDay`;
   flexible shifts: OT = worked − required − threshold, late/early against core hours; `UNDER_HOURS` when
   worked < `minFullDayMinutes`; `HALF_DAY` when worked < `halfDayThresholdMinutes`.
4. No punches: `ABSENT` when `autoAbsentWithoutPunches` and the day is over (`now` past the window end); otherwise `PENDING`.
   **Callers must pass `now`** when computing the current day; without it the day is treated as finished (historical recompute).
5. Missing punch (IN only / OUT only): `FLAG_ONLY` → `PRESENT` + `MISSING_OUT`/`MISSING_IN` with 0 worked minutes;
   `ASSUME_SHIFT_END` → worked to the scheduled end (no OT, assumed instant not reported as a timestamp);
   `TREAT_AS_ABSENT`; `TREAT_AS_HALF_DAY`. The dashboard "missing punches" KPI counts the flags.
6. Ramadan mode (`rules.ramadanMode`): within the date range (and eligibility) scheduled minutes shrink and `expectedEnd`
   moves earlier; flag `RAMADAN_HOURS`.
7. Flags (canonical order): `LATE, EARLY_DEPARTURE, OVERTIME, MISSING_IN, MISSING_OUT, MANUAL_CORRECTION, OUT_OF_WINDOW,
   WORKED_ON_HOLIDAY, WORKED_ON_WEEKLY_OFF, HALF_DAY_LEAVE, DUPLICATE_PUNCHES_COLLAPSED, RAMADAN_HOURS, CROSS_MIDNIGHT,
   NO_SHIFT, UNDER_HOURS`.

## Trace (support and payroll disputes, §88)
`trace.inputs` (shift, rule set, timezone, window, holiday, leave, weekly off), `trace.punches` (every event with its local time
and role IN/OUT/BREAK_*/IGNORED/DUPLICATE/OUT_OF_WINDOW), `trace.steps` (each rule with intermediate values) and
`engineVersion`. Stored as `attendance_daily_records.trace`; every recompute snapshots the previous record into
`attendance_daily_record_history` with a `reason`.

## Cross-midnight example (tested)
Shift 22:00–06:00 Asia/Muscat, punches 21:57 (D) and 06:08 (D+1) → attendance date D, worked 8h11m minus unpaid break, flag
`CROSS_MIDNIGHT`; a punch at 05:50 (D+1) belongs to D's window, a punch at 21:50 (D+1) to D+1's window (nearest start). For
rotating schedules pass `adjacentShifts` (D−1/D+1) so neighbouring windows are exact.

## Worker integration contract
- Normaliser resolves `device_employee_id` → employee via `device_employee_states` → `employee_provider_identities` →
  `employees.device_user_id` (unmatched rows stay `unmatched`), attaches the **effective branch on that date**, and enqueues a
  debounced `RECOMPUTE_DAILY` per (employee, date) — for cross-midnight shifts also for D−1.
- The recompute job loads events in `[date − 1, date + 2)` (branch timezone), resolves shift and rule set, holidays
  (branch calendar), weekly-off (employee → branch → org), approved leave, passes `now`, writes the record with
  `calculation_version + 1`, a history snapshot when anything changed, and emits `attendance.created`/`attendance.updated`.
- `summarisePeriod` needs `leaveIsPaid` per record (join leave records); `overtimeMinutes` is REGULAR only.
