# Time away, terminal punch roles, meeting rooms and the manager hierarchy

Status: implemented (migrations `20261015000100`–`20261015000300`, engine `attendance-engine/1.5.0`).
Related: `docs/attendance-engine.md` (§ interpretation, breaks), `docs/locations.md` (places), `docs/enterprise/plan.md`.

## 1. The problem

An office day runs 08:00–14:00. During it, an employee leaves the site and comes back — a client visit, a ministry, the bank,
a school pick-up. The question HR asks is simple: **how long was the employee away during working hours, and was that
approved?** Until now the engine kept only `breakMinutes` (the unpaid part of the gaps) and the default `FIRST_LAST`
interpretation ignored every punch between the first and the last one, so a two-hour absence in the middle of the day was
either invisible or silently deducted as "break".

Two site layouts have to work:

| Layout | How leaving and returning are recorded |
|---|---|
| **Two-way terminals** — IN/OUT keys on one terminal, or separate exit and entry terminals | OUT when leaving, IN when coming back. Nothing else needed. |
| **Entry-only terminal** — "the machine is at the place only to log in" | The employee taps **Step out** in the portal (web / mobile) when leaving; the return is the next check-in on the terminal (or **I'm back** in the portal when the policy allows it). |

## 2. What comparable products do (and what we took)

| Product family | Mechanism | Taken over |
|---|---|---|
| ZKTeco (push / BioTime), Hikvision | Terminal punch states *Check-in, Check-out, Break-out, Break-in, OT-in, OT-out* | Break-out / break-in are already mapped to `BREAK_START` / `BREAK_END`; the portal's step-out writes a break-out punch |
| Matrix COSEC | *Official work* and *Short leave* in/out special functions (official work counts as worked; short leave is limited) | The two kinds **OFFICIAL** and **PERSONAL**, with a monthly quota for personal |
| GCC HR suites (Bayzat, Jisr, ZenHR, Menaitech) | "Permission / excuse" requests (استئذان) in hours, approved by the line manager, monthly quota (typically 2–4 h) | Time-away requests through the approval engine; `personalMonthlyQuotaMinutes`, `personalMaxMinutes` |
| greytHR, Keka, Zoho People | "On duty" (OD) requests for official work outside the office | OFFICIAL windows count as worked (`officialCountsAsWorked`) |
| Access-control suites (Suprema, Hikvision, Gallagher) | Door readers by zone; attendance only from designated readers; room/meeting attendance from door events | Terminal **punch roles**; `ACCESS` readers feed `access_events`, never attendance; meeting attendance from room entries |

## 3. Design

### 3.1 Terminal punch roles (`devices.punch_role`)

| Role | Meaning | Normaliser |
|---|---|---|
| `AUTO` (default) | The terminal reports a direction (IN/OUT keys) | today's mapping (`in→PUNCH_IN`, `break_out→BREAK_START`, …) |
| `CHECK_IN` | Entry-only terminal | every punch → `PUNCH_IN` |
| `CHECK_OUT` | Exit-only terminal | every punch → `PUNCH_OUT` |
| `ACCESS` | Door / meeting-room reader | a row in `access_events`; **no attendance event** (a meeting never splits a working day) |

The live readers of raw punches skip `ACCESS` readers too: the self-service punch status (today's punches, check-in /
check-out state), the portal home's punch card, and the step-out placement (`placementOf`).

### 3.2 The engine (1.5.0)

The attendance policy (`attendance_rule_sets.policy.timeAway`) switches it on. It needs `PAIRED` or `DIRECTIONAL` punch
interpretation (the API refuses `FIRST_LAST` with `TIME_AWAY_NEEDS_PAIRS`). Every gap between the first IN and the last OUT —
the gaps between closed work segments and the `BREAK_START → BREAK_END` spans — is classified (`packages/domain/src/attendance/time-away.ts`):

| Kind | Rule | Pay |
|---|---|---|
| `SHORT` | gap shorter than `ignoreUnderMinutes` (5) | worked |
| `OFFICIAL` | inside an **approved** OFFICIAL window (+ `returnGraceMinutes`, 10) | worked when `officialCountsAsWorked` |
| `PERMISSION` | inside an **approved** PERSONAL window (+ grace) | unpaid, excused (the day is not short when `permissionExcusesShortfall`) |
| `BREAK` | the rest, up to the shift's break allowance, in time order | paid part credited like a break |
| `UNAPPROVED` | whatever is left | unpaid; flag `UNAPPROVED_AWAY` beyond `flagUnapprovedAfterMinutes` (15) |

Persisted on `attendance_daily_records`: `away_minutes`, `official_duty_minutes`, `permission_minutes`,
`unapproved_away_minutes`; the intervals are in the trace step `timeAway`. Flags: `TIME_AWAY`, `UNAPPROVED_AWAY`. While the
employee is still at work (day `PENDING`), the completed out-and-backs are already reported — and the gap before an open
check-in only on such a working day: it is reported, never deducted (a weekly-off or holiday day still in progress keeps its
worked minutes). The shift's fixed unpaid break stays a floor: a day whose gaps are official, short or excused still loses its
unpaid lunch like a plain day (a scheduled break range is not charged twice where a permission or unapproved gap covers it).
Under `ASSUME_SHIFT_END`, a step-out never closed (the day ends on an open break) is classified from the break-out to the
assumed check-out, so approved windows and unapproved time apply instead of paying the absence; `FLAG_ONLY` is unchanged.
With the policy off nothing changes — every pre-1.5.0 test passes unchanged.

Example (08:00–14:00, two-way terminal): IN 08:00, OUT 10:00, IN 12:05, OUT 14:00 with an approved official window
10:00–12:00 → 125 min away, all official (the return is within the 10-minute grace), worked 360, PRESENT. Without the
approval → 125 unapproved, worked 235, `UNAPPROVED_AWAY`, `UNDER_HOURS`.

### 3.3 Requests and approval (`time_away_requests`, approval entity `TIME_AWAY`)

* **Plan a window** — `POST /orgs/:orgId/me/time-away` (kind, from–to, reason, destination).
* **Step out** — `POST /me/time-away/step-out` (kind, expected return): a break-out punch on the self-service device
  (server clock) + a window [now, expected return]. Only while on site; idempotent on the client's key. When the employee's
  own planned window covers now, the break-out is linked to it (same kind) instead of filing a second one. A step-out
  window ends at the return ("I'm back", or the first terminal arrival), so its rest never blocks the next step-out.
* **Punch status** — after a step-out or "I'm back" the working day stays open: the portal offers Check out (a break-in or
  break-out counts as "in"; a portal check-in while stepped out is refused — come back with "I'm back" or on the terminal).
* **I'm back** — `POST /me/time-away/back`: a break-in punch, only when `returnBy = device_or_portal`; with `device` the
  return must be a terminal punch (proof of presence).
* **Withdraw** — `POST /me/time-away/:id/cancel` (pending only).
* **Status** — `GET /me/time-away/status`: policy, on site / away, today's classified intervals, today's requests.
* Decisions go through `/approvals` (line manager, secondary stand-in, or a workflow). Approval recomputes the day — and the
  day before, for a night shift whose punch window reaches past midnight (history reason `TIME_AWAY`); only APPROVED
  windows ever reach the engine. Every path that files a window takes the employee's self-punch lock, then the time-away
  lock, so the overlap and quota checks never race.
* Limits: one day, ≤ 16 h, ≤ 7 days back / 60 ahead, no overlap (exclusion constraint), personal quota and longest window.
* HR / manager: `GET /time-away` (list) and `GET /time-away/summary?month=` (per-employee totals from the daily records).

### 3.4 Meeting rooms & access (Enterprise module `meeting_rooms`)

* `meeting_rooms` — a **place** of the location tree (e.g. HQ › Floor 3 › Boardroom) with capacity and an optional
  restriction (allowed departments / employees). Its readers are the `ACCESS` terminals installed there.
* `meetings` + `meeting_invitees` — one meeting per room at a time (exclusion constraint), capacity checked.
* Attendance on read (`packages/domain/src/meetings/attendance.ts`): first entry from 15 min before the start to the end →
  ON_TIME, or LATE after `lateAfterMinutes` (minutes from the start); no entry → ABSENT (UPCOMING before the start);
  uninvited entries → walk-ins, **unauthorised** in a restricted room unless allowed. The organiser counts as invited, and an
  early arrival for the next meeting in the room is not a walk-in of the previous one. A meeting cannot be booked more than
  15 minutes in the past without `meeting.rooms`, and walk-in identities are shown to `meeting.rooms` holders only (others
  see a count) — the room's movement record stays with the room administrators.
* Access log (`GET /access-events`, permission `meeting.rooms`): every entry (unknown badges included, employee null) with
  the meeting it belongs to and the verdict; paginated and filtered in SQL, by the entry's local date in its branch zone. A
  meeting cancelled after an entry still covers that entry.
* Permissions: `meeting.view`, `meeting.manage`, `meeting.rooms`. Built-in roles: owner, org admin, HR admin and attendance
  admin hold all three; the branch manager holds `meeting.view` + `meeting.manage` in its branches; HR user and auditor hold
  `meeting.view`. The built-in **Manager** role holds none: it is team-scoped (its direct reports), while meeting access is
  organisation / branch wide (every meeting with its attendees, booking and cancelling any room). Employees see their own
  invitations without a key (`GET /me/meetings`); an organisation that wants its line managers to book rooms gives them a
  custom role with `meeting.view` + `meeting.manage`, as for `report.export` (§6).
* Pushing door permissions to the controllers is not part of this change: the reader enforces its own access groups;
  FlowZa records and audits the entries.

### 3.5 Manager hierarchy (`organization_settings.attendance.team.scope`)

`direct` (default) keeps today's behaviour. `hierarchy` makes a manager's team the whole reporting line below them (depth 5).
One function, `app._team_of`, feeds both RLS (`app.team_employee_ids()`) and the API (principal snapshot), so they cannot
disagree. The team board labels indirect reports "via <their manager>". Scheduled reports delivered to a manager follow the
same team (the worker walks the reporting line exactly like `app._team_of`).

## 6. The daily roll call by e-mail (report schedules, cadence `daily`)

A report schedule can now run **daily** on chosen weekdays (`run_day` is a weekday mask: 31 = Sunday–Thursday) with the
period `previous_day`: each run covers the day before it and, after days without a run, every day since the previous run
(a Sunday run after a Sunday–Thursday week covers Thursday to Saturday), so every day is reported exactly once. The Daily
Report (who checked in and when, late, absent, on leave, worked hours) is scheduled this way only; range reports (late,
absence, missing punches) may use it too. Each recipient receives the report under their own scope: a line manager's copy
is narrowed to their team. Opening a delivered report needs `report.export`, which the built-in Manager role does not carry
(least privilege, unchanged): an organisation gives its managers a role with it (the demo uses a "Line manager" role =
Manager + `report.export`).

## 4. Security notes

* Time-away rows and room entries are written by the system context only (client privileges revoked); RLS reads: own rows,
  the team key, the organisation key in branch scope (`supabase/tests/rls_time_away_meetings.sql`).
* The room access log is a movement record: only `meeting.rooms` holders and the person themself read it; meeting
  attendance is served for meetings the caller can see.
* Rooms and meetings are read with `meeting.view` and written with `meeting.rooms` / `meeting.manage`, in branch scope.
  Invitations (`meeting_invitees`, no branch column) follow their meeting, like approval steps follow their request: read
  with `meeting.view` where the meeting itself is readable under the caller's RLS, or one's own invitation; inserted,
  changed or deleted with `meeting.manage` only for a meeting inside the caller's branches (the row as it becomes too, so
  an invitation is never moved onto another branch's meeting). A branch-scoped manager never reads, adds or drops an
  invitation of another branch's meeting. The data API stays closed (`meeting_invitees_no_data_api`).
* `app._team_of` is not executable by any application role.
* Step-out uses the server clock; the punch goes through the same raw → normaliser → engine pipeline as a terminal's.

## 5. Tests

* Daily schedules: `packages/domain/src/reports/schedule.test.ts` (weekday mask, missed runs, `previous_day`),
  `packages/contracts/src/reports.test.ts`, `apps/web/src/features/reports/components/schedules.test.tsx`

* Engine: `packages/domain/src/attendance/time-away.test.ts`, meetings: `packages/domain/src/meetings/attendance.test.ts`
* API: `apps/api/src/test/time-away.test.ts`, `meetings.test.ts`, `team-hierarchy.test.ts`
* Worker: `apps/worker/src/handlers/attendance/time-away.test.ts` (punch roles, room entries, end-to-end day)
* RLS: `supabase/tests/rls_time_away_meetings.sql` (+ the invariant probes in `rls_invariants.sql`)
