# Customer review — October 2026

Traceability from the customer's review to what the product does and where an organisation admin configures it. Two inputs:

- **Support screenshots** (customer support, 19 Oct 2026): five issues about approval routing and weekly-off overtime.
- **"Electronic Attendance System Review — FlowZa Time"** (Employee Relations Department): 18 requirements compared against the
  video presentations (8 "Partial", 10 "Not demonstrated").

Every behaviour below is admin-configurable; the defaults are the customer's answers. Strings exist in English and Arabic.

## 1. Support issues (approval routing and overtime)

| # | Reported | Cause | Now | Configure |
|---|---|---|---|---|
| 1 | An employee's leave shows on the **admin's** "Mine" queue instead of going to the manager | Leave, comp-off and corrections without a workflow were seated on **every holder of `leave.approve`** in reach (owner, org admin, HR admin, HR user…) as well as the manager | Routed to the requester's **line manager** (one MANAGER level), like attendance reasons and regularisations | Settings → Approvals → *Leave, comp-off and attendance corrections without a workflow go to* (line manager / approve-permission holders) |
| 2 | A manager's leave never reaches **their** reporting manager | Same: permission routing only reached the subject's manager if that person's role held `leave.approve` | The manager's own line manager is seated and notified (`approval.pending`) | as above |
| 3 | A reason for being late reaches the manager **and** the second-level manager; the second should get it only when the manager is on leave | The secondary manager was always seated beside the primary on the portal's requests | Secondary manager is a **backup** (default): asked only when the primary cannot act (on approved leave, no login). If neither can act, the **next manager up** the reporting line. A request already waiting when the manager goes on leave is **handed over** by the hourly sweep (`approval.escalated#absence`) | Settings → Approvals → *Secondary manager* (backup / alongside), *When neither manager can act* (next manager up / HR admins), *Hand pending requests over when the manager goes on leave* |
| 4 | The highest-level manager's leave stays Pending with nobody to decide it | Nobody above; the fallback reached only `hr_admin` members and the owner account | Ladder for the top of the organisation: HR admins → **organisation admins** → owner; or a **named approver** (e.g. the Director General); or **automatic approval** (recorded on the request). Never stranded | Settings → Approvals → *Requests from the top of the organisation* (+ *Approver*) |
| 5 | Work on a weekly off is not counted as overtime | (a) Punches on an off day outside the shift's punch window were dropped (worked 0 m); (b) the organisation default recorded the hours without overtime | Engine 1.5.0 attributes such punches to the off day; hours on a weekly off / holiday count as **WEEKLY_OFF / HOLIDAY overtime** by default (rule-set switches and daily cap still apply) | Settings → Attendance → *Hours worked on a non-working day*; rule set → *Weekly-off / holiday work counts as overtime* |

Notes for existing tenants:
- Requests already pending keep the approvers they were given at submit; HR can reassign them (Approvals → request → Reassign).
- An organisation that **saved** its attendance settings before keeps its stored choice for non-working days (often "record");
  switch it to *Count the hours as overtime* and recalculate the period (Attendance → Recalculate) to apply it to past days.

## 2. Requirements review (PDF)

### First — Basic requirements and calculation method

| Requirement | Review | Delivered | Configure |
|---|---|---|---|
| 1. Official holidays | Partial | Add / edit holidays with recalculation (existing); **recurring yearly** holidays; **copy a calendar to next year**; **automatic rollover** each December; recalculation when a branch's calendar changes, a calendar becomes / stops being the default, or the default calendar is deleted | Holidays page (*Every year*, *Copy to <year>*); calendar dialog (*Automatic rollover*); branch dialog (calendar) |
| 2. Flexible working hours (07:00–09:00) | Not demonstrated | FLEXIBLE shifts (existing) and a **flexible start band on fixed shifts**: start anywhere in the band, the expected end moves with the start, lateness counts from the band's end | Shifts → shift dialog → *Flexible start* (minutes after the start time) |
| 3. Approved working hours (circulars) | Not demonstrated | **Approved hours periods** on a policy: name, circular reference, date range, start/end time and/or scheduled minutes, all or flagged employees; flag SPECIAL_HOURS; precedence over Ramadan hours | Attendance policy (rule set) → *Approved hours* tab |
| 4. Grace margin (15 min in and out) | Not demonstrated | Grace in / out per policy and per shift (existing) plus a **grace mode**: *deduct* (as before) or *tolerance* (within the grace on time; beyond it every minute counts) | Policy → *Late & early* → grace minutes and *Grace margin* |
| 5. Lateness / early-departure notifications | Not demonstrated | **Automatic alerts** to the employee and the direct manager on the day (late arrival, early departure once the day is complete), once per day, never for historical recalculations; minimum minutes | Settings → Notifications → *Attendance alerts* |
| 6. Lost hours (20-minute allowance) | Partial | **Short leave** types classify out-of-office time (personal permission, official assignment, remote work, nursing, disability); **lost time** = out-of-office time inside working hours not covered by an approved short leave, beyond the policy's **allowance** (e.g. 20 min); shown as *Lost* in the register, record dialog and monthly summary | Policy → *Out-of-office allowance (min)*; Leave → *Short leave types* |

### Second — Absence, notifications and follow-up

| Requirement | Review | Delivered | Configure |
|---|---|---|---|
| 1. Automatic handling of absence | Not demonstrated | **Absence notice** to the employee (and manager) with the **excuse deadline**; reminder the day before; reasons after the deadline refused (HR can still excuse); unexcused marking and pay effect (0 / ½ / 1 day, leave then LOP — existing) | Settings → Attendance → *Unexcused days* (grace, deadline, pay effect, auto-deduct); Settings → Notifications → *Attendance alerts* |
| 2. Periodic report on irregular cases | Partial | **Daily** report schedules; recipient option **each employee's line manager (their team only)**; new **Irregular cases** report (late, early, absent, missing punch, short hours, unexcused + per-employee summary); monthly report to the Director General = monthly schedule to named users / a role | Reports → Scheduled reports → New schedule |
| 3. Thank-you messages | Not demonstrated | **Weekly appreciation** message to employees with a clean week (criteria, minimum worked days, weekday and hour, en / ar text, preview, *Send now*) | Settings → Notifications → *Attendance alerts* → Weekly appreciation |
| 4. Search and report extraction | Partial | Report filters (branch, location, department, employees, dates, **status**); **daily register export** to Excel / CSV with the register's filters; Excel / CSV / PDF on every report | Attendance → Daily register → Export; Reports |
| 5. Statistics and indicators | Partial | Dashboard KPIs (existing) plus **attendance by department** and **month-to-date indicators** (attendance rate, late days and minutes, absences, short hours, average worked time) | Settings → Dashboard (show / hide the two widgets) |

### Third — Daily monitoring and data processing

| Requirement | Review | Delivered | Configure |
|---|---|---|---|
| 1. Integration with Mawred Plus | Not demonstrated | **HR system feed**: organisation API keys (shown once, hashed, scoped, expiring, revocable), `POST /api/v1/inbound/hrms/employees` and `/org-units` (batches ≤ 500, async, idempotent), editable field mapping with a **Mawred Plus** starting preset; employee / organisational-unit **imports** from CSV or Excel (the import job now completes — `EXECUTE_IMPORT` had no handler) | Settings → *HR system*; Employees → Import (kind: employees / organisational units). See [integrations/hrms.md](integrations/hrms.md) |
| 2. Missing check-ins / check-outs | Not demonstrated | Detection, policy behaviour (flag / assume shift end / absent / half day), regularisation requests, missing check-out reminder (existing) plus a **missing check-in reminder** N minutes after the shift start (optional copy to the manager) | Policy → *Missing punch*; Settings → Attendance → *Missed punches*; Settings → Notifications → *Attendance alerts* |
| 3. Actual and shortfall hours | Partial | Worked, scheduled, late, early and overtime minutes (existing) plus **shortfall** per day ("Short" column, record dialog "1 h 15 min (75 min)", portal day list) | — (derived; same rule as the reports' under-time) |
| 4. Correcting attendance transactions | Not demonstrated | Corrections (add / edit / remove punch, set status) with approval workflows and permissions (existing); corrections now follow the line-manager routing | Approvals → Workflows; Settings → Approvals; Users → Roles |

### Fourth — Work patterns and access permissions

| Requirement | Review | Delivered | Configure |
|---|---|---|---|
| 1. Remote work management | Not demonstrated | **Remote work** and **official assignment** short-leave types count as worked time (a remote window covering the shift makes a no-punch day present); web / mobile check-in with geofences (existing) | Leave → *Short leave types* (*Counts as work*); Settings → Attendance → self-service check-in |
| 2. Employee Relations permissions | Partial | Custom roles with granular permissions and branch scope (existing) plus **role templates**: Employee Relations, Line manager, HR viewer | Users → Roles → New role → template |

### Fifth — Short-leave permissions

| Requirement | Review | Delivered | Configure |
|---|---|---|---|
| 1. Short-leave management (nursing hour, persons with disabilities) | Partial | **Short leave** requests (portal *My leave → Short leave*), monthly quotas (minutes and count), maximum per request, gender applicability, approval through the line manager; HR records on behalf; **reduced daily hours** per employee (nursing hour with an end date, disability open-ended; start / end / either) excused by the engine | Leave → *Short leave types*, *Short leave*; Employee → Attendance → *Reduced hours* |

## 3. Engine and data

- Attendance engine **1.5.0**: off-day attribution, flexible start band, grace mode, approved-hours periods, short leave
  (excused / credited / lost minutes), reduced hours. A day without any of them keeps its figures; the next recompute of an
  existing record writes a history row because the version changed.
- Migrations `20261019000100` … `20261019000600` are additive and idempotent, with bounded lock waits; checked on a populated
  database the way the Deploy workflow applies them.

## 4. Known limits / follow-ups

- Mawred Plus field names are not public: the preset is a starting mapping each organisation checks against its own extract.
- "Flagged employees" for approved hours / Ramadan read an employee custom field that no screen sets yet.
- Holiday rollover runs in December only (no January catch-up).
- The portal day list, payroll exports and period summaries do not show lost / short-leave minutes yet; shortfall does not
  subtract excused short-leave minutes.
- Line-manager report copies go to primary managers; data scoping by department (beyond branch) is not available for roles.
