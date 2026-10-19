# Test tenant — Research and Innovation Authority (RIA)

Creates a small, fully-featured test organisation on the **hosted** project: **Research and Innovation Authority**
(company code `RIA`, id `1fa2602c-06d4-4341-86ba-2bc971d83563`) on the **Enterprise** plan with every module and feature
flag on, one login per role, five employees and seven weeks of attendance history that the real engine computes.

## Logins

| Login | Role | Person |
|---|---|---|
| ria.admin@flowza.ai | Organisation Owner (the tenant admin; superset of Organisation Admin) | Mazin Al Lawati, Director General (RIA-001) |
| ria.hr@flowza.ai | HR Admin | Shaima Al Hosni, HR Manager (RIA-002) |
| ria.manager@flowza.ai | Line Manager (team = direct reports) | Khalid Al Rashdi, Head of Research Programmes (RIA-003) |
| ria.employee@flowza.ai | Employee (self-service portal `/my`) | Reem Al Shukaili, Research Scientist (RIA-004), reports to Khalid |

The fifth employee, Vikram Nair (Data Scientist, RIA-005), has no login and also reports to Khalid.

**The password is not in this repository** (it is public). It is chosen when the seed runs (below) and handed to whoever
asked for the tenant. All four logins share it; MFA is not required on this tenant.

## What it creates

| Area | Content |
|---|---|
| Plan | Enterprise, active, yearly, no seat cap (the plan's own user limit). All 11 modules come from the plan — devices, self-service, geofences, leave, manager workspace, payroll, scheduled reports, Finance integration, round-the-clock scheduling, attendance policies, shift requests — so no module overrides are written |
| Feature flags | Every flag on for the tenant (advanced reports, all device providers including the placeholder vendors, Flowza Finance in the wizard, payroll export, Arabic UI, …) **except `biometric_template_sync`**, which is gated on a legal review: one toggle in `/adm` → Tenant → Feature flags |
| Settings | Web, mobile and selfie check-in, regularisation and self-service corrections on; geofence outside = flag; missed-punch detection; work on a weekly off counts as overtime; 12-hour clock with the Hijri date alongside; dashboard style *Ocean* |
| Organisation | Head Office (Al Khuwair, Muscat) with a 200 m geofence; Sunday–Thursday week; Oman public holidays 2026; departments Office of the DG, HR & Administration, Research & Development, Innovation & Technology Transfer (empty, for testers); nine designations |
| Schedule | Shift *Government hours 07:30–14:30* (15 min grace) assigned to the whole organisation from 1 Aug 2026 |
| Leave | The product's default leave types + comp-off, with yearly allowances (AL 30, CL 6, SL 10, EL 6, ML 98) and 2026 entitlements for everybody |
| Approvals | Workflow *Line manager → HR* for leave, corrections, regularisations, shift changes and swaps, overtime claims and comp-off |
| Terminal | One **demo** Hikvision terminal, *Head Office Main Entrance* (serial `FZD-RIA-0001`, "no physical device behind it"), all five employees enrolled |
| History | ~340 terminal punches 1 Sep 2026 → the run, one habit profile per person (the Data Scientist is late-prone, the Head of Research does overtime), duplicates and a rare missed punch-out; leave: Reem 21–24 Sep (approved), Vikram sick 7 Oct (approved), Khalid half-day 12 Oct (approved by the Director General, then HR) |
| Inbox | Pending at **ria.manager@** (level 1, then HR): Reem's annual leave 2–5 Nov, Vikram's casual leave 27 Oct, Reem's correction for the punch-out she missed on 14 Oct |

Attendance records are **not** written by the seed. Raw punches land as `pending`; the worker's normaliser, a
`RECALCULATE_RANGE` request with parallel `RECOMPUTE_DAILY` jobs and `BUILD_PERIOD_SUMMARY` (September, October) produce
every figure with the real engine. Allow ~10 minutes for the queue to drain.

## Running

Run the files in order on the admin connection (Supabase SQL editor, MCP `execute_sql`, or `psql "$DATABASE_URL_ADMIN"`).
Step 2 needs the password **in the same session**:

```sql
-- SQL editor / execute_sql: first statement of the step-2 script
select set_config('ria.seed_password', '<password, 12+ characters — or its bcrypt hash>', false);
```

```sh
psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 -f supabase/seeds/ria-tenant/01_tenant.sql
PGOPTIONS='-c ria.seed_password=<password>' psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 -f supabase/seeds/ria-tenant/02_people.sql
psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 -f supabase/seeds/ria-tenant/03_activity.sql
```

- A **bcrypt hash** (`$2a$…`, e.g. `select extensions.crypt('<password>', extensions.gen_salt('bf', 10))` on a local
  database) is accepted in place of the password: a multi-statement script that contains DDL can be written to the server's
  statement log whole, and the hash keeps the plain password out of it.
- Without the setting, step 2 keeps the passwords of logins that already exist (and refuses to create a missing one), so
  re-running it never resets a password by accident; with it, all four are reset.
- Every step is idempotent (uuid v5 ids in the tenant namespace, upserts, `on conflict do nothing` on append-only tables).
  Re-running step 3 on a later day tops the history up from the day before the last demo punch to the current minute and
  recalculates that window only; the leave, approval and correction records are created once.
- Through the Supabase MCP `execute_sql`, a script containing a `delete` waits for a confirmation and the call times out
  (nothing is applied). Step 1's only `delete` drops module overrides a tester left behind; a new tenant has none, so leave
  that statement out there.
- Locally (`scripts/db-reset-local.sh`), add `create extension if not exists "uuid-ossp" schema extensions;` first: the
  local Supabase shim does not ship it; the hosted project does.

## Before a demo

The demo terminal drops to *offline* a day after the last run (threshold 24 h). Re-run `03_activity.sql`: it refreshes the
heartbeat and fills the days since the last run.

## Known limits

- The four logins have e-mail notifications off for the attendance and system categories (in-app stays on): the addresses
  are test mailboxes.
- The placeholder vendor providers the flags reveal in the device wizard answer `NOT_IMPLEMENTED` when a device is tested or
  synced — they never fake success.
