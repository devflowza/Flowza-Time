# E3 — Round-the-clock scheduling and per-policy check-in methods

**Module:** `advanced_scheduling` (Enterprise only) · **Plan:** docs/enterprise/plan.md §4.7–4.8, §5, §6, §7, §8, §9, §10 E3 ·
**Built on:** the foundation commit (migration `20261007000100`, contracts `dto-features/enterprise-scheduling.ts`,
`composeDoubleShift`, `resolvePolicyFor`, the engine input that folds an additional shift into a DOUBLE_SHIFT day).
**Migration added:** none.

## 1. What shipped

### Domain (`packages/domain/src/scheduling/round-the-clock.ts`, pure)

- `buildRoundTheClockPlan(input)` for the four templates of plan §8:

  | Template | Shifts | Cycle | Crew offset |
  |---|---|---|---|
  | `TWO_SHIFT_4ON4OFF` | D / N, 12 h | `DDDD····NNNN····` (16 days) | 4 days |
  | `TWO_SHIFT_PANAMA_223` | D / N, 12 h | 2-2-3 on days for 14 days, then on nights (28 days) | 7 days |
  | `THREE_SHIFT_CONTINENTAL` | M / E / N, 8 h | `MMEENN··` (8 days) | 2 days |
  | `THREE_SHIFT_WEEKLY` | M / E / N, 8 h | a week of each, a week off (28 days) | 7 days |

  - Shifts run back to back from `firstShiftStart`.
  - Each shift has `breakMinutes` unpaid and its own colour.
  - Codes are `<prefix>-D` / `-N` (or `-M` / `-E` / `-N`); crew patterns are `<prefix>-A..D`. Names come from `namePrefix`.
  - `coverageCheck` counts the crews on every shift of every cycle day.
  - `averageWeeklyHours` is 42 for all four templates.
- `crewSequenceWithShiftIds()` turns a crew sequence into the `shift_patterns.sequence` shape.

### API (`/api/v1/orgs/:orgId/…`)

All routes are gated by the module (`module-gate.ts`, 403 `FEATURE_DISABLED`), Zod-validated and permission-checked in the
service and again by RLS. Every write is audited.

| Route | Permission | Notes |
|---|---|---|
| `POST round-the-clock/preview` | `shift.manage` | The plan; nothing is written. |
| `POST round-the-clock` (201) | `shift.manage` (+ `shift.assign` with `crewTeams`, + access to every team's branch and the coverage branch) | See below. |
| `GET shift-coverage` | `shift.view` | Branch-scoped list. |
| `POST shift-coverage` (201), `PATCH`/`DELETE shift-coverage/:id` | `shift.manage` + branch access | 409 on a duplicate (branch, shift). The PATCH schema has no defaults. |
| `GET shift-coverage/report?branchId&from&to` | `shift.view` + branch access | At most 62 days. See below. |
| `GET additional-shift-assignments` | `shift.view` | Paginated, branch-scoped; filters `employeeId`, `shiftId`, `branchId`, `activeOn`. |
| `POST additional-shift-assignments` (201), `PATCH`/`DELETE …/:id` | `shift.assign` + access to the employee's branch | Inclusive last day in the API. See below. |
| `GET branch-deployments` | `employee.view` | Readers of the host or home branch (RLS); filters `status`, `branchId`, `employeeId`, `activeOn`. |
| `POST branch-deployments` (201) | `employee.update` + access to the home branch (on `fromDate`) and the host branch | See below. |
| `POST branch-deployments/:id/cancel` | as above | See below. |
| `GET me/punch/status` | (portal) | New field `deployment: { branchId, branchName, toDate } \| null`. |

**`POST round-the-clock`** writes, in one transaction:
1. the shifts (409 `CONFLICT` if a code exists, compared case-insensitively);
2. one rotation pattern per crew, all anchored on `anchorDate`;
3. TEAM assignments for `crewTeams` from `anchorDate` (409 if a team already has an assignment from that date on);
4. coverage rows when `coverage` is set.

It audits each row and `shift.round_the_clock_applied`, and recalculates the teams' members when the anchor is not in the
future (`recalculationJobId`, a queue job).

**The coverage report** works as follows:
- `scheduled` counts the employees placed at the branch on the date (employment history) whose shift that day, from the
  working calendar plus `defaultShiftId`, is the shift. Weekly offs, rotation off days, holidays, approved full-day leave and
  days outside the employment are left out. It adds the branch's employees with an additional shift of that shift that day.
- `required` is the target's minimum when the weekday is listed.
- `gap` = max(0, required − scheduled).

**Additional (double) shifts:**
- The shift must be FIXED and active: 422 `UNPROCESSABLE` (`NOT_FIXED` / `INACTIVE`).
- Every worked date of the range must compose with the day's shift (`composeDoubleShift`). Otherwise 422 with
  `details = { reason, conflicts: [{ date, reason, shiftId }] }` (at most 10).
- Overlap with another additional assignment: 409.
- Writes recalculate the employee's affected past days.

**`POST branch-deployments`:**
- Checks:
  - host ≠ home (400);
  - the employee is employed over the range (400);
  - the range has not already ended (400);
  - no overlapping deployment (409).
- The row is inserted by the system step.
- With `enrolOnDevices`, it creates ONE `PUSH_EMPLOYEES` sync job with `PUSH_EMPLOYEE` items for the host branch's active
  terminals that have `employeePush`, and stores it in `enrol_job_id` / `enrolJobId` (a `sync_jobs` id, which
  `/sync/:id` renders).
- Status (scheduled / active / ended / cancelled) comes from the dates in the organisation's timezone and the cancellation.
- Audited as `employee.deployment_created`.

**`POST branch-deployments/:id/cancel`:**
- An ended or already cancelled deployment answers 409.
- A deployment that had enrolled the employee is cleaned up at once: the queued enrolment items are cancelled and the host
  rows get DELETE items.
- Audited as `employee.deployment_cancelled` with the clean-up outcome.

### Portal punch (`apps/api/src/services/portal/punch.service.ts`, `geofences.service.ts`)

**Per-policy check-in methods** (`policy.methods`):
- The policy is resolved for today's placement and primary shift (`resolvePolicyFor`, the engine's resolution).
- `web` / `mobile` false → 403 `FORBIDDEN`, `details.reason = CHECKIN_METHOD_NOT_ALLOWED`. It is also a blocker in the status.
- `selfie` false → the same for the selfie check-in. The "selfie required" grant goes dormant, so the employee is not locked
  out of both.
- `requireGeofence` other than `inherit` replaces the organisation's setting.
- The organisation switches are judged first.
- Stored policies apply whatever the module state.

**Check-in at the host branch:**
- While a deployment covers today, a location the employee's own fences would not accept is judged again against the host
  branch's fences:
  - the fences assigned to the host branch (scope `branch`);
  - the fences whose `branch_id` is the host branch.
- They are evaluated as one branch-scope set in the host branch's local time.
- An `allowed` verdict there is accepted. The raw payload records `deploymentId` and `deployedBranchId`.
- The punch is still written for the home branch and timezone.
- The selfie check-in applies the same fallback; the deployment is recorded in its audit row.

### Worker (`apps/worker/src/handlers/scheduling/index.ts`)

**Task `branch-deployments.cleanup`:**
- Hourly, enqueue-only.
- An organisation is enqueued in its local hour 0, as one `BRANCH_DEPLOYMENT_CLEANUP` job with the dedupe key
  `branch-deployment-cleanup:<org>:<localDate>`.

**Handler `BRANCH_DEPLOYMENT_CLEANUP`**, in the organisation's system context:
- **Selects** every deployment with `to_date < today` that is not cancelled, plus cancelled ones that enrolled, where
  `cleaned_up_at is null`.
- **Builds one sync job of `DELETE_EMPLOYEE` items** for the host branch's terminals where the employee has a row with
  `desired = true`.
- **Keeps the terminals** when the host is now the employee's current branch, or the host of another deployment that has not
  ended.
- **Updates the device rows:** sets `desired = false` on the removed rows, so reconciliation does not push them back. A
  switched-off terminal, or one whose provider cannot delete, is reported as skipped.
- **Stamps** `cleanup_job_id` / `cleaned_up_at`.
- **Audits** as SYSTEM: `employee.deployment_cleaned_up`.
- **Runs whatever the module state.**
- **Shared code:** the removal logic lives in `packages/database/src/scheduling/deployments.ts`, used by both the worker and
  the API's cancel.

### Web (`apps/web/src/features/scheduling/`, namespace `scheduling`, en + ar)

- **Shifts page:** tabs **Round-the-clock**, **Coverage** and **Double shifts**, shown only with
  `useModuleEnabled('advanced_scheduling')`.
  - Round-the-clock has the template picker, the per-crew cycle preview from the preview endpoint, prefixes, start, anchor,
    break, crew → team mapping, a coverage target and Apply.
  - Coverage has the targets list, a dialog with weekday toggles, and the report grid (days × shifts, `scheduled / required`,
    gaps tinted with the tenant's `chart-absent` token).
  - Double shifts has the list with filters, an assign dialog showing the composed day and listing the API's 422 dates, and
    end / delete.
- **`/deployments`:** `RequireModule advanced_scheduling` + `employee.view`; a sidebar item under Workforce.
  - The list has a status / branch filter, a create dialog and cancel with a reason.
  - After a create, the toast's "View" opens `/sync/<enrolJobId>`.
  - Recalculation toasts point at `/attendance?tab=recalc`, never at `/sync`.
- **Portal check-in page:** banner "You are deployed to … until …" from `/me/punch/status`. The refusal text
  `CHECKIN_METHOD_NOT_ALLOWED` is added to `portal-attendance`.

## 2. Decisions (AGENTS.md priority order)

1. **Base commit.** The worktree had been created from `main` (a018493). It was fast-forwarded to the foundation commit
   `2632979`, which the brief says is HEAD.
2. **One anchor, offsets in the sequence.** Each crew's pattern is anchored on `anchorDate`, with the crew offset folded into
   its sequence. This is "an equivalent sequence rotation": `patternCycleDay` maps a date exactly as the preview shows it,
   and the preview DTO (which has no offset field) is self-describing.
3. **Average hours are gross:** 42 h. The unpaid break is part of each shift's span and is deducted by the engine from the
   worked time.
4. **Existing team assignments are never ended silently.** A crew team that is already on a shift from the anchor date gives
   409; nothing is written.
5. **422 is a new shared code.** `AppError` code `UNPROCESSABLE` was added in `@flowza/shared`. Until now the only 422 was
   `DEVICE_UNSUPPORTED_OPERATION`.
6. **Composition is checked on worked days only**, as the brief says ("on which the employee works a shift"). Weekly offs,
   rotation off days and holidays are skipped. An open-ended range is checked over 92 days and a closed one over at most 366.
7. **Out-of-scope employees answer 403.** An additional shift for an employee outside the caller's branches gives 403: the
   employee is read in system scope for the authorisation and nothing else is returned.
8. **The coverage report counts employment status `active` only**, so gaps show rather than hide. Additional shifts count on
   days off too, since they are extra work. Deployed employees are **not** counted at the host branch: deployment is not a
   calendar change (plan §4.7).
9. **Cancelling removes access at once.** A cancelled deployment that had enrolled is cleaned up immediately, whether or not
   it had started, because its enrolment ran at creation. This is stricter than "already started". Queued enrolment items
   are cancelled, so an enrolment cannot land after the removal. An item that is running leaves `cleaned_up_at` null, and
   the daily sweep repeats.
10. **The clean-up sweep is NOT module-gated.** This follows the brief (a security measure) and overrides plan §4.8, "the
    deployment cleanup scan is gated". The host-branch check-in, which widens where a punch is accepted, IS gated by the
    module. Stored deployments stay, and their access removal still runs.
11. **The sweep ignores `enrolOnDevices`.** It removes any host-terminal row that is still `desired = true` (the brief's rule).
    Terminals of another deployment that has not ended (active or scheduled) are kept: that enrolment already ran, and its
    own clean-up removes it later.
12. **Host-fence semantics follow the domain.**
    - The host fences are evaluated as one branch-scope set, with the worst verdict winning, as for the host's own employees.
    - The fallback runs only for an own verdict of `denied_outside`, `flagged` or `logged` — never for a mock location.
    - Only `allowed` replaces the own verdict.
13. **`requireGeofence` from a policy overrides the organisation's**, as the brief says, so it can loosen it too. Web, mobile
    and selfie only restrict.
14. **Cadence.** The sweep runs once a day just after local midnight, so a deployment ending on D is removed during D+1's
    first hour. A missed run is caught up the next day.

## 3. Test evidence

New tests:
- `packages/domain/src/scheduling/round-the-clock.test.ts` (12 tests) covers:
  - 24/7 cover with exactly one crew per shift per day for each template;
  - the sequences, cycle lengths, hours, codes, colours;
  - sequences that pass `shiftPatternInputSchema`;
  - consistency with `patternCycleDay`.
- `apps/api/src/test/enterprise-scheduling.test.ts` (19 tests) covers:
  - the module gate on all 14 new routes;
  - round-the-clock preview / apply / 409, with crews resolving through `GET /shifts/resolve`;
  - additional shifts: 201 / 409 / 422 (dates, open-ended, flexible, same shift) / extend / branch scope / delete, and
    `loadDailyInputs` yielding a DOUBLE_SHIFT day;
  - coverage CRUD (PATCH one field), the report figures (gap, leave, weekly off, additional shift), 62-day and branch limits;
  - deployments: enrolment job with items for the host terminal only, 409 / 400 / 403 cases, list scopes, cancel with clean-up;
  - check-in at a host fence only during the deployment and while the module is on, with the payload facts;
  - policy methods: web / mobile / selfie refusals and the `requireGeofence` override, with `attendance_policies` off.
- `apps/worker/src/handlers/scheduling/deployments.test.ts` (4 tests) covers:
  - the scheduler window and dedupe;
  - removal only from host terminals, skips reported, kept terminals (transfer, another deployment);
  - the cancelled enrolment stopped;
  - idempotency, and the next day's catch-up.
- `apps/web/src/features/scheduling/scheduling.test.tsx` (7 tests) covers:
  - en/ar key parity;
  - tabs hidden with the module off;
  - the preview rendering every crew, and apply with the toast pointing at `/attendance?tab=recalc`;
  - the deployment dialog creating a deployment and linking to `/sync/<enrolJobId>`;
  - the coverage grid's gap, the portal banner, and the composed-day helper.

Gate results (this worktree, on the final code):

| Gate | Result |
|---|---|
| `pnpm build:packages` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm -r --filter "./apps/*" run typecheck` | exit 0 |
| `pnpm test:unit` | shared 4, contracts 73, domain 415 (28 files), device-providers 454, database 24 — all passed |
| `pnpm --filter @flowza/api run test` | Test Files 58 passed (58), Tests 725 passed (725) |
| `pnpm --filter @flowza/worker run test` | Test Files 28 passed (28), Tests 293 passed, 1 skipped (294) |
| `pnpm --filter @flowza/web run test` | Test Files 119 passed (119), Tests 713 passed (713) |

API and worker tests ran with `TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres` (throwaway databases).

## 4. Known limits / follow-ups

- **Optional pieces not built:** the roster cell for an additional shift, and a deployments card on the employee profile.
- **Selfie check-ins:** the deployment is recorded in the audit row only. `selfie_checkins` has no payload column, so the raw
  punch created on approval carries the host verdict but not the deployment id.
- **Long closed ranges:** a double-shift range longer than a year is checked over its first 366 days. The engine falls back
  to the primary shift on any later conflict.
- **Coverage at the host branch:** the report does not count deployed employees there (see decision 8).
- **Plan §4.8:** the "worker cleanup is gated" line should be updated by the integrator to match decision 10.
