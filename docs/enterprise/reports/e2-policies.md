# E2 — Global attendance policies: slice report

**Module:** `attendance_policies` (Enterprise only). **Plan:** `docs/enterprise/plan.md` §4–§7, §10 E2.
**Built on:** the foundation commit (migration `20261007000100`, contracts, `resolvePolicy`, `checkPolicyCompliance`,
`@flowza/database` policy helpers). **No new migration, no new dependency.**

## What shipped

### Domain (`packages/domain/src/policy/`)

**`computeAttendancePoints(records, sections, asOf)`** in `points.ts`. It is pure, and the window is the `points.expiryDays` days
that end on `asOf`. Each day earns at most one event per kind:

- `VERY_LATE` replaces `LATE`.
- `EARLY_DEPARTURE` counts separately.
- An `ABSENT` status earns `ABSENT`.
- `MISSING_PUNCH` comes from the status or from `MISSING_IN` / `MISSING_OUT`, once per day.
- `UNEXCUSED` counts separately.
- An `EXCUSED` day earns nothing and does not count towards repeated late.

Repeated late walks the late days in date order and keeps those of the last D days. When N are reached it emits one
`REPEATED_LATE` event and the count restarts. Each event carries `expiresOn = date + expiryDays`. The result gives the total,
the occurrences per kind, the escalation step reached and the next step.

**`summariseOvertime(records, sections, month)`** in `overtime.ts`. It computes:

- regular, weekly-off and holiday overtime for the month's days;
- weekly overtime per ISO week whose Sunday falls in the month (`overtimeSummaryFrom(month)` gives the Monday the caller must
  read from);
- weighted minutes, rounded once;
- the days over `maxDailyWorkMinutes`.

Both functions are exported from `@flowza/domain` and have unit tests next to them. The tests cover excused days, the
repeated-late reset and the period, the window and expiry, half points, a week that crosses the month boundary, a week left to
the next month, and the null threshold or maximum.

### Contracts

- `ruleSetListQuerySchema` gains `countryCode`, `departmentId`, `employeeGroupId` and `shiftId`. It stays backwards
  compatible.
- `enterprise-policies.ts` gains three helpers:
  - `policySectionsOf(raw)` never throws. It falls back section by section to the defaults.
  - `policySectionsEqual` compares two sets of sections.
  - `isDefaultPolicySections` tells whether the sections are the defaults.
- It also gains these types and schemas:
  - `EmployeeGroupMembersResultDto` and `EndedEmployeeGroupMembershipDto`;
  - `attendancePointsDetailQuerySchema` and `AttendancePointsListMeta`;
  - `pointsEnabled` on `AttendancePointsRowDto`.

### API (all paths under `/api/v1/orgs/:orgId/`)

| Route | Permission | Notes |
|---|---|---|
| `GET/POST attendance-rule-sets`, `PATCH/DELETE …/:id` | `attendance.view` / `attendance.manage_rules` | See "Rule sets are policies" below. |
| `GET/POST employee-groups`, `GET/PATCH/DELETE employee-groups/:id` | `attendance.view` / `attendance.manage_rules`, writes only for callers with every branch | `memberCount` counts today in the organisation's timezone. `DELETE` is refused with **409 CONFLICT** while a policy uses the group; its memberships are cascaded. |
| `GET employee-groups/:id/members` | `attendance.view` | Paginated. `activeOn` defaults to today; `all` and `search` are supported. Employees are read under RLS and the branch scope. |
| `POST employee-groups/:id/members` | `attendance.manage_rules` | See "Membership rules" below. |
| `PATCH employee-groups/:id/members/:membershipId` | `attendance.manage_rules` | Takes an inclusive last day, stored as +1. A last day before the first day is a 400. |
| `DELETE employee-groups/:id/members/:membershipId` | `attendance.manage_rules` | |
| `GET attendance-policies/resolve?employeeId&date` | `attendance.view` + branch access | See "Resolution" below. |
| `GET attendance-policies/country-packs` | `attendance.view` | The static packs. |
| `POST attendance-policies/compliance?countryCode=` | `attendance.view` | The body is a draft parsed with `attendanceRuleSetInputSchema`. When `shiftId` is set, the scoped shift's scheduled minutes are passed. A country without a pack returns `packVersion: null` and no warnings. |
| `GET attendance-policies/points` and `/points/:employeeId` | `attendance.view` | See "Points and overtime reports" below. |
| `GET attendance-policies/overtime-summary?month=` | `attendance.view` | See "Points and overtime reports" below. |

**Rule sets are policies.** The DTO carries `description`, `countryCode`, `departmentId`, `employeeGroupId`, `shiftId`,
`policy` (parsed, with defaults filled in) and `specificity`.

- Department, group and shift must belong to the organisation. Otherwise the request is a 400 with the issue path.
- These need `attendance_policies` (403 `FEATURE_DISABLED` otherwise):
  - any scope dimension other than the branch;
  - non-default policy sections on create;
  - new non-default sections on PATCH.
- Every scope dimension is immutable. A change is a 400 `Immutable` that tells the user to create a new policy. Sending the
  same value is accepted.
- A `policy` sent on PATCH replaces the stored one. A PATCH without `policy` keeps it.
- The list filters by every dimension.

**Membership rules.**

- Every employee must exist in the organisation and be visible under RLS; otherwise the answer is a 404 listing the ids. The
  employee must also be in the caller's branch scope.
- An open-ended membership of any group that started before `effectiveFrom` is ended the day before. The stored exclusive end
  is `effectiveFrom`, and the response lists it in `ended`.
- Any other overlap is a 409 that names the employee. Nothing is written in that case.
- Membership writes recalculate the affected employees from the first affected date up to today (`recalcIfPast` with
  `employeeIds`). Every write is audited as `attendance.employee_group_*`.

**Resolution.** The placement on the date matches the engine's input loader:

- the branch and department in force (employment history);
- the shift from `resolveShift`, with the default shift as fallback (not on a rotation off day);
- the additional shift when there is no primary one.

The service then calls `explainPolicyFor`. A branch-scoped caller gets the organisation-wide policies, the policies of their
own branches and the winner.

**Points and overtime reports.**

- The page of employees is read first: employees employed on the date, filtered by branch, department, group and search,
  under RLS and the caller's branch scope.
- Each employee's policy is then resolved, in batch, on `asOf` for points and on the month's last day for overtime.
- Only after that are the daily records of the window read.
- An employee whose policy has points off shows `pointsEnabled: false` and 0 points.
- `minPoints` filters the computed page. `meta.total` still counts the employees.

**Enforcement helpers** (`services/policies/enforcement.ts`):

- `employeePolicyOn`;
- `checkInMethodRefusal`;
- `effectiveGeofenceRequirement`;
- `regularisationRefusal`.

They are the consumers of `policy.methods` and `policy.regularisation`, ready for the self-service endpoints (see the known
limits).

### Web

**Policy editor** (`features/schedule/components/rule-set-dialog.tsx`, same component and props, plus an optional `pack`). It
has tabbed sections: General, Late & early, Attendance, Overtime, Discipline, Regularisation and Ramadan. Every section stays
mounted, and inactive ones are hidden with CSS. On an invalid submit the editor opens the first section that has an error, and
the tab triggers show an error or warning dot.

- **General:** the scope (country, branch, department, group, shift), read-only when editing, and the country-pack picker. The
  picker merges `policyDefaultsFromPack` into the form and records `policy.countryPack`.
- **Late & early:** grace, thresholds, very late, repeated late (N in D) and rounding.
- **Attendance:**
  - full and half day;
  - punch interpretation and the duplicate window;
  - methods and the geofence override;
  - the missing-punch behaviour, where `ASSUME_SHIFT_END` is shown as "Auto checkout at shift end";
  - auto-absent.
- **Overtime:** the existing fields, plus the weekly threshold, the statutory daily maximum and the rates.
- **Discipline:** the points switch, the values, the expiry and the escalation ladder (`useFieldArray`).
- **Regularisation:** the monthly limit and how far back.
- **Ramadan.**

When the policy names a country, a compliance panel appears. It runs a debounced POST and shows each warning in the panel and
under its field; a click opens that warning's section.

Without the module, the Enterprise sections and fields are hidden, and the request never carries `policy` or a scope beyond
the branch.

**Rules tab.**

- Scope chips per policy.
- Policies sorted most specific first, with a Specificity column.
- A "Which policy applies?" card (employee + date → resolve). It shows the placement, the winner and the reason for each other
  policy.

The column and the card require the module.

**`/attendance/policies`** (`features/policies/`, namespace `policies` in en and ar). The route sits behind
`RequirePermission attendance.view` and `RequireModule attendance_policies`, and has one sidebar item (Time section). It has
four tabs:

- **Employee groups:** list, create, edit and delete dialogs, and a members drawer to add employees from a date, end a
  membership or remove one.
- **Points & discipline:** as-of date, filters, points, escalation badge, next step, and an events drawer.
- **Overtime summary:** month picker and filters, with the weighted overtime column.
- **Country packs:** cards with the law, figures, sources and verification date, and "Create policy from this pack", which
  opens the editor prefilled.

Toasts for recalculations point to `/attendance?tab=recalc`, because those are queue job ids.

## Decisions (AGENTS.md priority order)

1. **Weekly overtime nets every daily overtime category, not only REGULAR. This deviates from the brief.** Under the brief's
   formula `Σworked − threshold − Σ REGULAR`, a worked weekly off (its minutes are already paid as WEEKLY_OFF overtime) would
   be paid a second time as weekly overtime. This choice protects data integrity. It is also what the plan states ("a weekly
   threshold counts only the minutes not already paid as daily overtime") and what the contract comments say ("net of the
   daily overtime already counted").
2. **Only callers with access to every branch can create, rename or delete groups.** Groups are organisation-wide policy
   configuration, like the organisation-wide rule set, and `employee_groups` RLS is not branch-scoped. Branch-scoped managers
   still manage the memberships of their own branches' employees, checked per employee by the service. The memberships table
   has no branch column, so the service is the branch gate.
3. **The module gate on PATCH applies only to new non-default sections.** A PATCH that resets the sections to the defaults,
   or sends back the stored sections unchanged, works without the module. A downgraded tenant can therefore still edit grace
   and other fields of its existing policies: removing Enterprise configuration is never blocked.
4. **The placement and the policy for resolve, points, overtime and the enforcement helpers are read in the organisation's
   system scope** (`withSystemScope`), after the employee has been authorised under the caller's RLS. This gives exactly the
   policy the engine applies, whatever the caller's keys reveal of assignments, history or rule sets. Only the derived result
   goes back. On the resolve card, policies of branches outside the caller's scope are not listed (except the winner).
5. **The repeated-late walk reads only the records of the window.** A point therefore drops off exactly `expiryDays` after it
   was earned, and the standing is a pure function of the window.
6. **Points list.** Employees employed on `asOf` are listed. `minPoints` thins the page after computing, as the brief says;
   `total` counts employees.
7. **Overtime summary.** Employees employed during the month are listed. The group filter uses membership on the month's last
   day, which is the same day the policy is resolved on.
8. **Members can only be added to an active group.** Adding to an inactive group is refused with `INVALID_STATE` (409). Existing
   memberships of an inactive group keep applying to policies, because the engine does not read the group status.
9. **The regularisation monthly limit counts requests for days of the calendar month of the regularised day**, which aligns
   with payroll periods. The day lies at most `backdateDays` before today.
10. **Country-pack statute text (`law`, `notes`) is contract data, shown as is.** It is not a UI string (English, `dir="ltr"`).
    Country names use the packs' `name` and `nameAr`.

## Test evidence

| Suite | Result |
|---|---|
| `TEST_PG_URL=… pnpm --filter @flowza/api exec vitest run src/test/enterprise-policies.test.ts` | 15 passed |
| Domain `src/policy` (points, overtime, compliance) | 13 passed |
| `apps/api/src/services/policies/enforcement.test.ts` | 3 passed |
| Web: `rule-set-dialog.test.tsx` (existing test unchanged + 4 new), `rule-sets-tab.test.tsx` (2), `policies.test.tsx` (6), `locales/policies-locales.test.ts` (7) | all passed |
| `pnpm build:packages && pnpm lint && pnpm -r --filter "./apps/*" run typecheck && pnpm test:unit` | pass (domain 413, contracts 73, device-providers 454, database 24, shared 4) |
| `pnpm --filter @flowza/web run test` | 121 files, 725 tests passed |
| `TEST_PG_URL=… pnpm --filter @flowza/api run test` (whole API suite) | 59 files, 724 tests passed |

## Known limits and open issues

- **`policy.methods` and `policy.regularisation` are edited and stored, but not yet enforced.** Their endpoints,
  `apps/api/src/services/portal/punch.service.ts` and `apps/api/src/services/portal/regularisations.service.ts`, belong to
  another slice. The helpers in `apps/api/src/services/policies/enforcement.ts` are ready to call:
  - **Check-in:** after the organisation switches, call `employeePolicyOn(trx, orgId, employeeId, date)` and then
    `checkInMethodRefusal(policy.sections, 'web' | 'mobile' | 'selfie')`. Use
    `effectiveGeofenceRequirement(policy.sections, attendanceSettings.selfService.requireGeofence)` in place of the organisation
    setting.
  - **Regularisation:** call `regularisationRefusal(policy.sections, { date, today, requestsInMonth })`.
- **Night overtime, overtime approval and acknowledged disciplinary actions are E4.** The packs' night window is
  informational only.
- **Points are not stored.** They are computed on read from the daily records, under the policy in force on `asOf`. An
  employee who changed policy within the window is scored entirely under the `asOf` policy.
- **The overtime summary is a read, not an export.** The payroll export does not yet use the weighted minutes (E4: overtime
  requests feeding payroll).
- **Groups are not paginated** (at most 1000 per organisation). This is fine for the expected tens of groups.
