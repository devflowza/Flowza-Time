# Enterprise plan — round-the-clock scheduling, shift requests and global attendance policies

**Status:** E0–E3 are implemented on branch `claude/funny-curie-g7jz84` (migration `20261007000100_enterprise_scheduling_policies.sql`).
E4 and E5 are designed below and not built yet. **Date:** 2026-10-07.
**Priorities (AGENTS.md):** Security > Reliability > Data Integrity > Scalability > Maintainability > Performance > UX.

## 1. The request

The owner asked for an **Enterprise-only** set of features:

1. Round-the-clock operations with a multi-shift configuration.
2. Employees can **request a shift change** and **swap shifts** with colleagues.
3. An employee can **work two shifts** on one day (double shift).
4. An employee who is sent to **work at another branch** can check in there.
5. A **global attendance policy** built as *Country → Company → Location → Department → Employee group → Shift → Policy*.
   It replaces "one set of rules", with the sections general, working schedule, late & early, attendance methods, overtime,
   exceptions, discipline, payroll and approvals. The example is "Oman – Office Employees".
6. Benchmark the competitors first and match their configuration.

## 2. Competitor benchmark

| Capability | SAP SuccessFactors Time | Workday Time Tracking | UKG Pro WFM (Kronos) | Zoho People | Deputy | Keka / greytHR | Darwinbox | Bayzat | **FlowZa Time (this plan)** |
|---|---|---|---|---|---|---|---|---|---|
| Policy scoping | Time profile / work schedule per country, legal entity, employee group/subgroup | Time entry rules by eligibility (location, worker type) | Pay rules & work rules per pay group / location | Shift & attendance policy per location / dept / role | Per location | Capture scheme / tracking policy per employee group | Shift policy at group or company level | Per role and location | **Country → branch → department → employee group → shift; most specific wins (E2)** |
| Grace / rounding | Grace on day model + rounding model | Rounding rules | Rounding rules (7/8-minute rule) | Grace + rounding | Rounding | Grace + penalisation | Grace | Grace | Existing grace, thresholds, punch & worked rounding |
| Overtime | Daily / weekly thresholds, multi-layer valuation, premiums | OT calculation tags | Daily + weekly, double time, zones | OT rules | OT by award | OT policy | OT | OT per role / location | Existing daily OT; **weekly threshold, rates, statutory max (E2)**; approval flow (E4) |
| Shift differential / night | Shift premiums | Time calc tags | Shift differential zones | — | Award rates | — | — | — | Night window in the country packs; night OT computed in **E4** |
| Attendance points | via Time Valuation | **Attendance points with expiry, justification, alerts** | Attendance (occurrences) | — | — | **Penalisation for late / early / missing swipes with grace counts** | — | — | **Points per occurrence, rolling expiry, escalation ladder (E2)** |
| Shift rotation | Period work schedules | Work schedule calendars | Pattern templates | Shift rotation | Templates | Rotational shifts | Rosters | Shift scheduler | Existing patterns; **24/7 templates (DuPont, Panama 2-2-3, continental, weekly) + coverage targets (E3)** |
| Shift swap | Via scheduling add-on | Swap / give-away | Swap, open shifts | **Swap + change requests with approval** | **Swap & offer, manager approval optional** | Shift change request | Roster change request | Swap | Existing swap (now Enterprise); **shift change requests (E1)**; swap consent + open shifts (E5) |
| Multiple shifts per day | Split day programs | Multiple time blocks | Split / multi-shift | — | Multiple shifts | — | **Multiple check-ins / shifts** | **Split shifts** | **Double shift = two shifts combined into one day (E3)** |
| Multi-location | Org assignment | Location | Transfers / labor levels | Locations | **Multi-location clock-in** | Locations | **Multiple locations** | **Multi-site** | **Temporary branch deployment: check-in, terminals (E3)** |
| Country rules | **Country / industry / company rules, rest periods** | Country time rules | Pay policy per jurisdiction | — | Awards (AU) | India statutory | GCC + India | UAE / KSA | **Country rule packs OM, AE, SA, QA, KW, BH, IN + compliance check (E2)** |
| Exceptions (WFH / on duty) | Absence & time types | Time off / time types | Pay codes | WFH / on duty requests | Leave | On duty, WFH, regularisation | WFH, on duty | — | Existing regularisation and notes; **request kinds in E5** |

Sources:
- [SAP SuccessFactors Time Tracking feature scope](https://assets.cdn.sap.com/agreements/product-policy/css/service-specifications/feature-scope-description-for-sap-successfactors-time-tracking-english-v10-2025.pdf)
- [SAP daily/weekly overtime valuation](https://blogs.sap.com/2021/01/26/sf-ecp-timesheet-take-on-multi-layer-valuation-rules-to-generate-daily-weekly-ot/)
- [Workday attendance management](https://doc.workday.com/admin-guide/en-us/human-capital-management/time-tracking/reviewing-and-approving-time/steps--set-up-attendance-management.html)
- [Zoho People shift settings](https://help.zoho.com/portal/en/kb/people/administrator-guide/shifts/settings/articles/shift-settings)
- [Zoho Shifts swaps](https://help.zoho.com/portal/en/kb/shifts/scheduling/shift-request/articles/shift-swaps)
- [Deputy shift swapping](https://www.deputy.com/features/shift-swapping)
- [Keka penalisation policy](https://help.keka.com/hc/en-us/articles/39946747232529-Setting-up-a-Penalization-Policy)
- [Darwinbox leave & attendance](https://darwinbox.com/blog/track-better-act-smarter-with-our-leave-and-attendance-module)
- [Bayzat shift scheduler](https://bayzat.com/shift-scheduler-and-attendance)

What the benchmark settles:
- **Scope by eligibility, not one rule set.** Every tool resolves a policy from where the employee sits (SAP employee
  group, UKG pay group, Keka tracking policy).
- **Points with expiry** (Workday) and **penalisation with grace counts** (Keka) are the two discipline models. FlowZa uses
  points with a rolling window and an escalation ladder, which covers both.
- **Daily + weekly overtime** (SAP, UKG) is the norm. A weekly threshold counts only the minutes not already paid as daily
  overtime.
- **Swap with approval, optional consent, offer / give-away** (Deputy, Zoho). FlowZa keeps manager approval and adds
  colleague consent and open shifts in E5.

## 3. What FlowZa already had (gap analysis against the requested policy table)

| Policy area | Before this plan | After E0–E3 | Later |
|---|---|---|---|
| Work schedule (times, days, breaks) | Shifts (FIXED / FLEXIBLE, breaks, punch windows), weekly offs employee → branch → org | — | — |
| Shift policy: fixed, rotating, split, overnight, flexible | Fixed, flexible, overnight, rotation patterns | **Double / split days** (two shifts combined), **24/7 templates** | Per-segment late (E4) |
| Clock-in methods | Devices, web, mobile, selfie (org switches), geofences | **Per-policy allowed methods and geofence requirement** | QR (E5) |
| Grace period | Rule set + shift | — | — |
| Late arrival, repeated late | Late threshold | **VERY_LATE (e.g. after 09:00), repeated-late occurrences** | Late approval flow (E4) |
| Early departure | Threshold | — | Approval (E4) |
| Missing punch | Flags, behaviours, regularisation with approval | **Per-policy regularisation limits** | — |
| Half day / absent | Thresholds, auto-absent | — | — |
| Overtime | Daily (threshold, rounding, blocks, cap), weekly-off / holiday OT | **Weekly threshold, rates, statutory daily maximum, weighted OT summary** | OT request & approval, night OT (E4) |
| Breaks | Fixed / flexible (measured) / scheduled | — | Auto-deduct after N hours (E4) |
| WFH / on duty / travel / field | Notes, regularisation `wfh_unmarked`, Site Duty leave type | — | Attendance request kinds (E5) |
| Regularisation employee → manager → HR | Approval engine v2 (multi-level) | — | — |
| Leave integration, holidays by location, weekly off, night shift | Existing | — | — |
| Auto checkout | `missing_punch_behavior = ASSUME_SHIFT_END` | Shown as "Auto checkout" in the policy editor | — |
| Rounding | Existing | — | — |
| Attendance points, disciplinary rules | — | **Points, rolling expiry, escalation ladder, report** | Acknowledged warnings, notifications (E4) |
| Payroll integration | Period summaries, payroll exports | **Weighted overtime per policy rates** | — |
| Audit trail | Every write audited, record history | Same for every new write | — |
| Country rules | — | **Country rule packs + compliance check** | More countries |

## 4. Architecture decisions

1. **The attendance rule set IS the policy.** We did not add a parallel table. `attendance_rule_sets` gains the scope
   dimensions `country_code`, `department_id`, `employee_group_id` and `shift_id` (with the existing `branch_id`), plus
   `description` and a validated `policy` jsonb for the new sections. One editor, one resolver, one engine input, and
   existing rule sets keep working unchanged (an organisation / branch rule set is a policy with fewer dimensions).
2. **Resolution: most specific match wins.** `packages/domain/src/attendance/resolve-policy.ts`:
   - Every named dimension must match the employee on the date: the branch's country, the branch and department from
     employment history, the group membership on the date, and the day's primary shift.
   - The weights are shift 32, employee group 16, department 8, branch 4, country 2, organisation 0. A narrower dimension
     always beats any combination of broader ones.
   - Ties go to the latest `effective_from`, then the id.
   - A per-scope exclusion constraint stops two policies with the same scope from overlapping.
   - `GET /attendance-policies/resolve` explains the result for one employee and day.
3. **The engine stays country-agnostic.** Legal figures live in `@flowza/contracts` `COUNTRY_RULE_PACKS`. They are used only
   to pre-fill a new policy (`policyDefaultsFromPack`) and to warn (`@flowza/domain` `checkPolicyCompliance`). The engine
   reads only the stored policy.
4. **Policy sections are only stored when something reads them.** Each key of `attendancePolicySectionsSchema` names its
   consumer in the schema comment. Request kinds (WFH, on duty), overtime approval and night overtime are E4/E5 and are not
   in the schema yet.
5. **Double shifts do not change the daily-record grain.** Two FIXED shifts on one date are combined into one composite day
   (`composeDoubleShift`):
   - The day runs from the first start to the last end, with the gap as an unpaid break.
   - Grace and punch windows come from the outer shifts.
   - The record keeps the primary shift id; the trace keeps both segments; the day is flagged `DOUBLE_SHIFT`.
   - Additional shifts live in their own table (`additional_shift_assignments`), so every reader of `shift_assignments`
     keeps its one-shift-per-day meaning.
   - Per-segment lateness is E4 (`docs/risks.md` C-3).
6. **Approvals reuse the approval engine.** Shift change requests use the `SHIFT_CHANGE` entity, which existed but was
   never routed. Workflows, delegation, escalation, the inbox and the co-subject rules all apply as they do for swaps.
7. **Deployment is not a transfer.** A temporary deployment (`employee_branch_deployments`) does three things:
   - lets web / mobile check-in accept the host branch's fences (in addition to the employee's own);
   - enrols the employee on the host branch's terminals (async device job);
   - removes them from those terminals after the end date (cleanup job).

   The attendance calendar, payroll and data scope stay with the home branch. A permanent move is a transfer
   (`employment_history`), as before.
8. **Module gating has three layers, as for every module** (docs/pricing.md):
   - **API gate:** route prefixes in `module-gate.ts`, plus `requireModuleFor` for body-level features on core routes
     (a scoped policy, an ADDITIONAL change).
   - **Web:** `RequireModule`, sidebar, tabs.
   - **Worker:** the deployment cleanup scan is gated.

   Switching a module off never deletes data. The engine keeps applying stored scoped policies and double shifts, so a
   downgrade never silently changes calculated attendance or payroll.

## 5. Modules and plans

| Module | Key | Contents |
|---|---|---|
| Shift change & swap requests | `shift_requests` | Shift change requests (CHANGE / ADDITIONAL), shift swaps |
| Round-the-clock scheduling | `advanced_scheduling` | 24/7 rotation templates, coverage targets and report, additional (double) shift assignments, branch deployments |
| Global attendance policies | `attendance_policies` | Policy scope beyond the branch, employee groups, country packs and compliance, policy sections, attendance points and discipline, overtime summary |

- All three are in the **Enterprise** plan only. Trial, Starter, Professional and Business do not include them; the
  migration's post-verify block enforces this.
- A platform admin can switch one on for any tenant (Tenant → Modules), for example for an enterprise proof of concept.
- **Shift swaps** were part of every plan with the self-service portal. The migration keeps them for every organisation that
  has used them, through a recorded override (`organization_modules.reason`). An ADDITIONAL (double-shift) change also needs
  `advanced_scheduling`.

## 6. Data model (migration `20261007000100`)

`employee_groups` and `employee_group_memberships`:
- Memberships are effective-dated, one group per employee per date, enforced by an exclusion constraint.
- RLS: read with `attendance.view`, write with `attendance.manage_rules`.

`attendance_rule_sets` gains:
- `description`, `country_code`, `department_id`, `employee_group_id`, `shift_id`, `policy`.
- A per-scope no-overlap exclusion.
- FK behaviour: deleting a department removes its policies (as a branch does); a group or shift that a policy uses cannot
  be deleted.

`additional_shift_assignments`:
- Per employee, effective-dated, no overlap.
- RLS: `shift.view` / `shift.assign`, scoped by branch.

`shift_change_requests`:
- Columns: kind CHANGE / ADDITIONAL, inclusive range up to 92 days (366 in the DB), requested and current shift, approval
  request, applied assignment ids.
- At most one pending request per employee, kind and day (exclusion constraint).
- Written by the system step only. Read like swaps: `attendance.view` by branch, own rows, or the line manager's team.

`employee_branch_deployments`:
- Columns: home and host branch, inclusive range, reason, enrol and cleanup jobs, cancellation.
- No overlapping active deployments for an employee.
- Written by the system step only. Readable in the host or home branch scope and by the employee.

`shift_coverage_requirements`:
- A minimum headcount per (branch, shift) on given weekdays.

Permission `shift.request_change` is granted to the roles that hold `shift.request_swap`.

## 7. API

All paths are under `/api/v1/orgs/:orgId/`.

| Module | Routes |
|---|---|
| `attendance_policies` | `employee-groups` CRUD; `employee-groups/:id/members` (GET, POST put members from a date, PATCH `/:membershipId` ends one, DELETE `/:membershipId`); `attendance-policies/resolve?employeeId&date`; `attendance-policies/country-packs`; `POST attendance-policies/compliance?countryCode` (body = policy draft); `attendance-policies/points` (+ `/:employeeId`); `attendance-policies/overtime-summary?month` |
| core (body-gated) | `attendance-rule-sets` accepts the scope dimensions and `policy`. Dimensions other than the branch, and non-default sections, need `attendance_policies`. |
| `shift_requests` | `me/shift-changes` (GET, POST), `me/shift-changes/options?date`, `me/shift-changes/:id/cancel`; `me/shift-swaps*` (moved here); `shift-change-requests` (HR / manager list). Decisions go through `approvals/*`. |
| `advanced_scheduling` | `additional-shift-assignments` CRUD; `branch-deployments` (GET, POST, `/:id/cancel`); `shift-coverage` CRUD + `shift-coverage/report?branchId&from&to`; `round-the-clock/preview`, `round-the-clock` (POST, creates shifts, patterns, crew assignments, coverage) |

## 8. Round-the-clock templates

| Template | Shifts | Crews | Cycle | Avg hours / week |
|---|---|---|---|---|
| `TWO_SHIFT_4ON4OFF` | Day / Night 12 h | A–D | 16 days: 4 days, 4 off, 4 nights, 4 off | 42 |
| `TWO_SHIFT_PANAMA_223` | Day / Night 12 h | A–D | 28 days, 2-2-3 days then nights | 42 |
| `THREE_SHIFT_CONTINENTAL` | Morning / Evening / Night 8 h | A–D | 8 days: 2 M, 2 E, 2 N, 2 off | 42 |
| `THREE_SHIFT_WEEKLY` | Morning / Evening / Night 8 h | A–D | 28 days: a week of each, a week off | 42 |

Each crew gets the same pattern with its day offset (anchor date + k × cycle / 4). The preview proves 24/7 cover: every shift
on every day has at least one crew.

## 9. Double shifts

- **Assigning:** HR assigns an additional shift for a range, or an employee asks for one (ADDITIONAL change request).
- **Refused combinations:** combining with a flexible shift, overlapping shifts, ≥ 24 h, or the same shift. These are refused
  when the assignment is made. A shift edited later into such a combination falls back to the primary shift alone.
- **Example (tested):** morning 06:00–14:00 + evening 18:00–22:00. Punches 06:20 / 14:00 / 18:00 / 22:30 (PAIRED) give
  scheduled 12 h, late 20 min, worked 12 h 10 min, overtime 30 min, `DOUBLE_SHIFT`.

## 10. Phases

| Phase | Content | Status |
|---|---|---|
| **E0** | Benchmark, gap analysis, architecture (this file) | ✅ |
| **E1** | Modules and gating; swaps moved with grandfathering; shift change requests (portal + approvals + HR list) | ✅ |
| **E2** | Policy scope + resolution + explain card; employee groups; country packs + compliance; policy sections (very late, methods, OT weekly / rates / daily max, points, regularisation limits); points & discipline report; overtime summary | ✅ |
| **E3** | Double shifts (engine 1.4.0, assignments); 24/7 templates + coverage targets / report; branch deployments (check-in, terminals, cleanup) | ✅ |
| **E4** | Overtime requests & approval (`OVERTIME` entity) feeding payroll; night overtime minutes (country night windows); per-segment late for double / split shifts; auto break deduction; acknowledged disciplinary actions with notifications | Planned |
| **E5** | Attendance request kinds (WFH, on duty, business travel, field work) with policy-driven approval; swap colleague consent, shift offers and open shifts; QR check-in | Planned |

## 11. Decisions taken (priority rule of AGENTS.md)

1. **Trial does not include the Enterprise modules.** "Enterprise only" was the instruction. A platform admin can switch
   them on per tenant for an evaluation.
2. **Swaps are grandfathered rather than taken away.** Reliability comes first: a tenant never loses a feature it uses.
3. **Stored scoped policies keep applying when the module is switched off.** This is data integrity: a downgrade never
   recalculates payroll differently.
4. **Deployment is not a calendar change.** Timezone, holidays and policy stay with the home branch, which matches how a
   punch on another branch's terminal was already processed. A permanent move is a transfer.
5. **Country figures are defaults with sources and a verification date, never enforcement.** Sector and contract rules
   vary, so HR confirms them with counsel.
