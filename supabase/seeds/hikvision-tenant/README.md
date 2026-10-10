# Hikvision test tenant — Enterprise demo data

Turns the test organisation **Hikvision** (`78a5a348-69b6-4c51-8d72-3697f72c50f0`, real Hikvision push terminal "james",
serial GN6733356) into an Enterprise demo with 100 employees in 10 departments and six weeks of attendance history that
exercises every Enterprise feature. It targets the **hosted** project and keeps everything that was there: the 20 employees,
their shift assignments, the real terminal and its punches, the corrections made while testing, the three logins.

## Logins (existing accounts, passwords unchanged)

| Login | Role | Use it for |
|---|---|---|
| prem@flowza.ai | Owner | Everything; level 2 of requests the HR admin approved at level 1 (four-eyes) |
| reddyprem1311@gmail.com | HR Admin | Approvals inbox, policies, scheduling, deployments, reports, payroll |
| premreddy1311@gmail.com | **Line Manager** (was Employee) — K Kumar, 001, IT Manager | Employee portal (`/my`), manager workspace (`/team`), first approver of the IT team |

## What it creates

| Area | Content |
|---|---|
| Plan | Enterprise, active, **user limit 100** (exactly 100 active employees), every module on (the five "testing" overrides of 1 Oct removed, audited) |
| Locations | Existing Ghala office (coordinates, geofence) + **Sohar Plant (24/7)** — no weekly off, the rotations decide |
| Departments | 10 × 10: Management, HR, Finance, IT, Sales, Customer Service, Operations (Ghala) · Warehouse, Security, Maintenance (Sohar). The old "owner" department is inactive (empty) |
| People | The 20 existing employees spread over the office departments (department, designation, manager, history) + 80 new ones (EMP021–EMP100, device user ids 1001–1080, `@example.com` e-mails, no logins). Joiners on 13 and 20 Sep |
| Terminals | 3 **demo** Hikvision terminals (serials `FZD-…`, notes say "no physical device behind it"): Ghala Staff Entrance, Sohar Plant Gate, Sohar Warehouse Dock — all generated punches are on these; "james" only ever holds real punches |
| Shifts | OFFICE 08–17, LATE 10–19, EVE 18–22, SITE 07–16 (Maintenance), and the round-the-clock shifts SEC-D/N (12 h) and WH-M/E/N (8 h). The existing flexible "1" stays on 001 and TEST001 |
| Round-the-clock | Security "4 on 4 off" and Warehouse "continental", crews A–D (teams SEC-A…D, WH-A…D) on rotation patterns anchored on 1 Sep; coverage target 2 per shift (Crew C security is short 3–9 Oct: leave) |
| Policies | Company standard → Sohar Plant – Maintenance (branch) → Sales – Field staff (department) → **Oman – Office Employees** (country OM + group, from the OM pack: very late after 60 min, repeated late, points with a 5-step escalation, weekly 40 h threshold, OT rates) / Sohar Plant – 24/7 Shift Workers (branch + group, terminal-only, auto check-out) / Senior Management – exempt (group) → Security – Night shift (shift) |
| Employee groups | Office Employees (50), 24/7 Shift Workers (20), Senior Management (10) |
| Double shifts | Jennifer Santos 28 Sep–1 Oct, Aisha Al-Saadi 5–8 Oct (approved request) — office day + evening support |
| Deployments | Jamal Uddin Ghala → Sohar 13–17 Sep (done), Khalfan Al-Siyabi → Sohar 4–15 Oct (active, punches at the plant gate), Santosh Kumar Sohar → Ghala 18–22 Oct (upcoming), Kareem Mostafa (cancelled) |
| Shift requests | Changes: approved (EMP060), approved double shift (EMP056), rejected (EMP078), **pending**: K Kumar → LATE 18–22 Oct, EMP087 nights → days 19–22 Oct, EMP057 extra evening 19–20 Oct. Swaps: approved 24 Sep (EMP084 ↔ EMP089), **pending** 15 Oct (EMP085 ↔ EMP090) |
| Leave | 2026 allowances (AL 30, CL 6, SL 10, EL 6) for everybody; 20 records (approved past and future, half days, 5 pending, 2 rejected) |
| Approvals | Workflows "Line manager → HR" for leave, corrections, shift changes and swaps. Pending: 5 leave, 3 shift changes, 1 swap, 2 corrections (+ the regularisation that was already pending) |
| Attendance | ~5 100 Hikvision HTTP-Listening events 1 Sep → now (punctual / average / late-prone habits, overtime, crews' night shifts, missed punch-outs, duplicates, face / fingerprint / card), handed to the worker: NORMALIZE_RAW, RECALCULATE_RANGE 1 Sep → today, BUILD_PERIOD_SUMMARY for Sep and Oct, APPLY_CORRECTION for the 3 approved corrections |

Days on which an employee already had attendance events (real punches, corrections made while testing) are not touched.

## Running

Run the files in order on the admin connection (Supabase SQL editor or MCP `execute_sql`, or
`psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 -f …`). Every step is idempotent (uuid v5 ids in the tenant namespace,
upserts, `on conflict do nothing` on the append-only tables); re-running step 4 on a later day adds the punches of the days
since the last run.

```
01_plan.sql                 Enterprise plan, user limit 100, modules back to plan
02_structure_people.sql     locations, departments, designations, shifts, demo terminals, 100 employees
03_enterprise.sql           groups, policies, round-the-clock, coverage, double shifts, deployments, shift requests & swaps
04_leave_attendance.sql     leave, punches, corrections, recalculation jobs
05_verify.sql               read-only checks once the queue has drained (~30 min)
```

## Before a demo

The demo terminals have no device behind them, so they drop to *offline* a day after the last run (threshold 24 h). To
show them online, refresh the heartbeat:

```sql
update public.devices set connection_status = 'online', last_heartbeat_at = now(), last_successful_communication_at = now(), updated_at = now()
where organization_id = '78a5a348-69b6-4c51-8d72-3697f72c50f0' and serial_number like 'FZD-%';
```

and re-run `04_leave_attendance.sql` to add the punches of the days since the last run.
