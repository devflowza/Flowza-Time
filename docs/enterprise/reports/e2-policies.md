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

**Enforcement** (integration note): `policy.methods` is enforced by the check-in endpoints (`apps/api/src/services/portal/punch.service.ts`,
E3) and `policy.regularisation` by the self-service regularisation endpoint (`apps/api/src/services/portal/regularisations.service.ts`,
E1), each resolving the policy exactly as the engine does. The stand-alone helpers this slice had prepared for them
(`services/policies/enforcement.ts`) were removed at integration as unused duplicates.

## Known limits and open issues

- **Night overtime, overtime approval and acknowledged disciplinary actions are E4.** The packs' night window is
  informational only.
- **Points are not stored.** They are computed on read from the daily records, under the policy in force on `asOf`. An
  employee who changed policy within the window is scored entirely under the `asOf` policy.
- **The overtime summary is a read, not an export.** The payroll export does not yet use the weighted minutes (E4: overtime
  requests feeding payroll).
- **Groups are not paginated** (at most 1000 per organisation). This is fine for the expected tens of groups.
