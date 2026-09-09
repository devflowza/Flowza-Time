# Demo tenant seed — Majan Gulf Trading & Contracting LLC

Turns the test tenant that owns `acme@flowza.ai` (organisation `27bfe270-5dea-4587-aec3-0f5c23113261`) into a
realistic Oman-based company with six months of operating history. It complements the local fixture seed
(`packages/database/src/seed`, Al Bahja, 500 employees) — this one targets the **hosted** project and keeps the
existing owner login.

## What it creates

| Area | Content |
|---|---|
| Organisation | Legal/display name, contact, address (Al Khuwair, Muscat), Sunday–Thursday week, every settings group (12-hour clock, `hijri_secondary` calendar, payroll cut-off, Ramadan-aware rules, report notation), business plan, feature flags |
| Locations | Head office (Muscat) + Sohar, Salalah, Nizwa, Sur, Duqm site — full address, coordinates, geofence, contact person/email/phone, weekly-off (Duqm works Saturdays) |
| Devices | 7 ZKTeco push terminals (two at head office, one per branch), model, serial, firmware, tags, notes, push-token hash, enrolment state per employee; Nizwa is offline |
| Structure | 10 departments in a hierarchy with managers, 27 designations with levels and Arabic names, 12 teams with leads and members |
| People | 53 employees (26 HQ, 8 Sohar, 6 Salalah, 4 Nizwa, 4 Sur, 5 Duqm) with Arabic display names, DOB, nationality, contact, manager, device PIN/card, custom fields (blood group, marital status, grade, emergency contact, Ramadan eligibility), identity documents, employment history (one transfer, two leavers, two joiners inside the window) |
| Logins | 8 memberships, password **`Test@1234`** — see table below |
| Schedule | Shifts OFFICE 08:00–17:00, SITE 07:00–16:00, FLEX 8 h; assignments org → Duqm branch → IT-DEV team → individual drivers/technicians; company rule set + Duqm rule set; Oman public holidays 2026 (+ two company days) |
| Leave | 10 leave types (product defaults + Hajj + Paternity), 62 records Mar–Oct 2026 across every type and status |
| Attendance | ~13 000 raw punches (1 Mar → yesterday) with per-employee habits: punctuality band, overtime appetite, absence rate, lunch punches, duplicate punches, missing punch-outs, half-day leave, Ramadan hours, weekend work on site |
| Corrections | Approval workflow "Line manager → HR", 6 corrections (3 approved and applied by the worker, 2 pending, 1 rejected) |
| Extras | Notifications, audit trail entries |

Attendance records are **not** written by the seed. Raw punches land as `pending`; the worker's normaliser turns them into
events and recompute jobs, a queued `RECALCULATE_RANGE` fills the punch-less days, and `BUILD_PERIOD_SUMMARY` jobs build the
monthly payroll summaries — every figure in the app is the real engine's output. Allow ~30 minutes for the queue to drain.

## Logins

| Email | Role | Person |
|---|---|---|
| acme@flowza.ai | Organisation Owner | Hamad Al Busaidi, Managing Director |
| orgadmin@flowza.ai | Organisation Admin | Khalid Al Harthi, General Manager |
| hradmin@flowza.ai | HR Admin | Fatma Al Balushi, HR Manager |
| hruser@flowza.ai | HR User | Aisha Al Rawahi, HR Executive |
| payroll@flowza.ai | Payroll / Finance | Maryam Al Siyabi, Payroll Specialist |
| attadmin@flowza.ai | Attendance Admin | Zainab Al Zadjali, Attendance Administrator |
| brmanager@flowza.ai | Branch Manager (Sohar only) | Said Al Rawahi |
| employee@flowza.ai | Employee (self-service) | Priya Sharma, Software Engineer |

## Running

Run the files in order on the admin connection (they write `auth.users` directly, mirroring the rows Supabase Auth
creates, so they need the `postgres` role):

```sh
for f in supabase/seeds/demo-tenant/0*.sql; do psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 -f "$f"; done
```

or paste each file into the Supabase SQL editor. Every step is idempotent: ids are UUID v5 in the tenant namespace and
rows are upserted on their natural keys; append-only tables (raw transactions, events, audit) use `on conflict do nothing`.
Re-running refreshes master data and regenerates the identical punch stream without duplicates; step 04 also adds the
punches of the current day up to the current time, so re-running it (any day, any time) keeps the dashboard's "today"
populated. Changing the generator's
distributions after a first run would add new punches next to the old ones (raw transactions cannot be deleted); void the
old events through corrections or start from a fresh tenant instead.

## Known limits

- Leave balances and entitlements do not exist in the data model; the Leave page lists records only.
- Teams have no department column; the team name carries the department where it matters.
- Devices are push terminals without a live connection. The seed stamps a fresh heartbeat and a 24-hour offline threshold,
  so they read "online" for a day after each run and the worker's health sweep marks them offline afterwards — re-run
  step 01 to refresh. Nizwa is seeded offline on purpose (30-minute threshold, last seen yesterday).
