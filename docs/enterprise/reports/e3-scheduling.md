# E3 — Round-the-clock scheduling and per-policy check-in methods

**Module:** `advanced_scheduling` (Enterprise only) · **Plan:** docs/enterprise/plan.md §4.7–4.8, §5, §6, §7, §8, §9, §10 E3 ·
**Built on:** the foundation commit (migration `20261007000100`, contracts `dto-features/enterprise-scheduling.ts`,
`composeDoubleShift`, `resolvePolicyFor`, the engine input that folds an additional shift into a DOUBLE_SHIFT day).
**Migration added:** none in the slice; the review fixes use `enrolled_device_ids` from `20261007000200` (see §5).

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
- With `enrolOnDevices`, the terminals are enrolled ON THE FIRST DAY (host branch time), never before
  (`enrolBranchDeployment`, packages/database): when the deployment starts today it creates at once ONE `PUSH_EMPLOYEES`
  sync job with `PUSH_EMPLOYEE` items for the host branch's active terminals that have `employeePush` and on which the
  employee has no `desired = true` device row yet, stores it in `enrol_job_id` / `enrolJobId` (a `sync_jobs` id, which
  `/sync/:id` renders) and adds those terminals to `enrolled_device_ids`. A later deployment gets `enrolJobId: null`; the
  daily sweep enrols it on `fromDate`. The DTO carries `enrolledDevices` (how many terminals the deployment added).
- Status (scheduled / active / ended / cancelled) comes from the dates in the organisation's timezone and the cancellation.
- Audited as `employee.deployment_created` (`enrolment: now | first_day | off`, the job, the devices pushed and those the
  employee was already on).

**`POST branch-deployments/:id/cancel`:**
- An ended or already cancelled deployment answers 409.
- EVERY cancellation runs the clean-up at once (`cleanupBranchDeployment`, which re-checks what to keep): the queued
  enrolment items are cancelled and the employee's rows on the terminals of `enrolled_device_ids` get DELETE items —
  including terminals handed over to this deployment by an earlier one (it may have no enrolment job of its own).
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
- While a deployment covers the moment — in the HOST branch's local time, from `fromDate` through `toDate`, plus `toDate + 1`
  until 12:00 (a night shift's check-out) — a location the employee's own fences would not accept is judged again against
  the host branch's fences: the fences ASSIGNED to the host branch with scope `branch` (what the host's own staff get), with
  each assignment's `require_on_check_in` / `require_on_check_out`. A fence the host merely owns (`branch_id`) for someone
  else is neither judged nor shown.
- They are evaluated as one branch-scope set in the host branch's local time.
- An `allowed` verdict there is accepted. The raw payload records `deploymentId` and `deployedBranchId`.
- The punch is still written for the home branch and timezone.
- The selfie check-in applies the same fallback; the deployment is recorded in its audit row.

### Worker (`apps/worker/src/handlers/scheduling/index.ts`)

**Task `branch-deployments.cleanup`:**
- Hourly, enqueue-only.
- An organisation is enqueued when local hour 0 begins in its timezone OR one of its branches' timezones (a host branch's new
  day), as one `BRANCH_DEPLOYMENT_CLEANUP` job with the dedupe key `branch-deployment-cleanup:<org>:<localDate>`.

**Handler `BRANCH_DEPLOYMENT_CLEANUP`** (the daily sweep), in the organisation's system context, each date the host
branch's:
- **Access removal first. Selects** every deployment not cleaned up that was cancelled (whatever it enrolled), or whose
  host date is at least `toDate + 2` (`to_date + 1 < host today`: the morning after the last day stays covered).
- **Builds one sync job of `DELETE_EMPLOYEE` items** for the terminals of `enrolled_device_ids` where the employee has a row
  with `desired = true` (never a terminal they are on by another path; nothing for a deployment that enrolled nothing).
- **Keeps the terminals** when the host is now the employee's current branch; **hands them over** (adds them to its
  `enrolled_device_ids`) to another deployment of the employee to the same host that asks for terminals and covers the
  host's today.
- **Then enrolment:** every deployment whose first day has arrived at the host (not cancelled, `enrol_on_devices`, no
  `enrol_job_id`) is enrolled as at creation and audited as SYSTEM `employee.deployment_enrolled`. This part follows the
  `advanced_scheduling` module (it widens access).
- **Updates the device rows:** sets `desired = false` on the removed rows, so reconciliation does not push them back. A
  switched-off terminal, or one whose provider cannot delete, is reported as skipped.
- **Stamps** `cleanup_job_id` / `cleaned_up_at`.
- **Audits** as SYSTEM: `employee.deployment_cleaned_up`.
- **The removal runs whatever the module state.**
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
  - After a create that enrolled at once, the toast's "View" opens `/sync/<enrolJobId>`. A deployment that starts later
    gets a toast saying the terminals come on the first day (no link: there is no job yet); the list says "Added on the
    first day".
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
9. **Cancelling removes access at once.** Every cancellation runs the clean-up immediately (superseded by §5: before the
   review it ran only for a deployment with an enrolment job). Queued enrolment items are cancelled, so an enrolment cannot
   land after the removal. An item that is running leaves `cleaned_up_at` null, and the daily sweep repeats.
10. **The clean-up sweep is NOT module-gated.** This follows the brief (a security measure) and overrides plan §4.8, "the
    deployment cleanup scan is gated". The host-branch check-in, which widens where a punch is accepted, IS gated by the
    module. Stored deployments stay, and their access removal still runs.
11. **Superseded by §5.** The sweep removed any host-terminal row still `desired = true`, whatever the deployment had
    enrolled, and kept the terminals for any other deployment that had not ended. It now removes only what the deployment
    enrolled and hands them over to another deployment that covers the host's today.
12. **Host-fence semantics follow the domain.**
    - The host fences are evaluated as one branch-scope set, with the worst verdict winning, as for the host's own employees.
    - The fallback runs only for an own verdict of `denied_outside`, `flagged` or `logged` — never for a mock location.
    - Only `allowed` replaces the own verdict.
13. **`requireGeofence` from a policy overrides the organisation's**, as the brief says, so it can loosen it too. Web, mobile
    and selfie only restrict.
14. **Cadence.** The sweep runs once a day just after local midnight (organisation or branch timezone), so a deployment
    ending on D is removed during D+2's first hour at the host (superseded by §5: before the review, D+1's). A missed run is
    caught up the next day.

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
- **Plan §4.8:** the "worker cleanup is gated" line should be updated by the integrator to match decision 10 (done: plan §4
  item 8 now says the removal is never gated and the sweep's enrolment follows the module).
- **Branch deployments:** see §5 for the review fixes and the limits left.

## 5. Review fixes — branch deployments (2026-10-07)

Five findings of the review of this slice, each re-verified in the code at `ba41f6b` and fixed. Migration: none new — the
fixes use `employee_branch_deployments.enrolled_device_ids` from `20261007000200`. The rules now live in one pure module,
`packages/domain/src/scheduling/deployment-window.ts`, and in `packages/database/src/scheduling/deployments.ts`
(`enrolBranchDeployment`, `cleanupBranchDeployment`, the two "due" queries), shared by the API and the worker.

| # | Finding | Fix |
|---|---|---|
| 1 | MEDIUM security — access kept forever: an ended deployment was stamped "cleaned up" without removing anything because another not-ended deployment to the same host existed; when that one was cancelled without an enrolment job of its own, nothing ran (cancel cleaned up only with `enrol_job_id`, the sweep picked cancelled rows only with `enrol_job_id`). | Cancellation ALWAYS runs `cleanupBranchDeployment`; the sweep selects every cancelled deployment not cleaned up, whatever its `enrol_job_id`. A kept deployment HANDS its terminal ids over to the keeper's `enrolled_device_ids`, so the keeper's own end or cancellation removes them. |
| 2 | MEDIUM security — enrolment at creation: a deployment for 1–7 Dec created on 7 Oct put the employee on the host terminals at once. | Enrolment runs only when `fromDate ≤ host today ≤ toDate` (HOST branch timezone): at creation when the deployment starts today, otherwise the daily sweep enrols it on its first day and stamps `enrol_job_id`. DTO: `enrolJobId` is null until then, new `enrolledDevices`. UI: the create toast links to `/sync/<id>` only when there is a job, otherwise it says the terminals come on the first day; the list shows "Added on the first day"; the enrol hint and the cancel hint no longer promise "now" / "its terminals" (en + ar). |
| 3 | MEDIUM integrity — the clean-up removed enrolments the deployment never granted (every host-terminal row with `desired = true`, even with `enrolOnDevices: false`). | Enrolment records in `enrolled_device_ids` only the host terminals on which the employee had NO `desired = true` row before; those they are already on are neither pushed again nor recorded. The clean-up touches only `enrolled_device_ids` (minus the keep rules), so a deployment that enrolled nothing removes nothing. |
| 4 | MEDIUM functional + privacy — every fence OWNED by the host branch (someone's home / WFH fence, a team's client site, a check-out-only fence) was judged for both directions as a branch-scope fence (worst verdict wins → the office check-in was denied) and exposed in `GET /me/punch/status`. | `fencesForBranch` returns only the fences ASSIGNED to the host with scope `branch` — what the host's own staff get — with each assignment's `require_on_check_in` / `require_on_check_out`. Owned-but-unassigned fences are neither judged nor shown. |
| 5 | LOW-MEDIUM reliability — a night shift starting on `toDate`: the punch side used the HOME branch's today and the sweep ran at the ORGANISATION's local midnight, so the 06:00 check-out lost the host fences and terminals. | Coverage is computed in the HOST branch's timezone: host fences are accepted from `fromDate` through `toDate`, plus `toDate + 1` until 12:00 host time; the sweep removes terminal access only once `to_date + 1 < host today` (host date ≥ `toDate + 2`). The scheduler enqueues an organisation when a local day begins in its timezone or in any of its branches'. |

### Decisions (AGENTS.md order: security first)

1. **Which other deployment keeps the terminals.** The brief says "another not-ended, not-cancelled deployment". With
   finding 2 a deployment that has not started has not enrolled anything and will enrol on its own first day, so keeping
   access for it would grant the terminals through the gap between two deployments — what finding 2 forbids. The keeper is
   therefore a deployment of the same employee to the same host that is not cancelled or cleaned up, asks for terminals
   (`enrol_on_devices`), has started (`fromDate ≤ host today`) and whose own terminals are not yet due
   (`toDate ≥ host today − 1`); the latest such one. A gap of a day or more costs one delete and one re-push.
2. **The morning-after grace accepts both directions until 12:00 host time** (the brief's wording; the terminals also stay
   until the sweep at `toDate + 2`). The status endpoint's `deployment` (the portal banner) names only a deployment that
   covers the host's today; during the grace morning the host fences still appear in `fences` and still judge the punch.
   On the morning a deployment follows another, both deployments' host fences are tried (the one covering today first).
3. **Nothing to push leaves `enrol_job_id` null**, so the sweep looks again each day while the deployment runs (a terminal
   added to the host, or an enrolment by another path removed meanwhile, is then covered). Only an enrolment that created a
   job is audited (`employee.deployment_enrolled`, SYSTEM).
4. **The sweep's enrolment follows `advanced_scheduling`** (it widens access, like the host-fence check-in); the removal
   never does. A deployment enrolled while the module was off is picked up by the first sweep after it is back, while it
   still runs.
5. **A leaver is never enrolled.** The enrolment may run weeks after the deployment was created, so it re-checks the
   employee on the day (not archived, `active` / `on_leave`, not past the exit date — the worker's PUSH_EMPLOYEE rule).
6. **Terminals that moved.** A terminal of `enrolled_device_ids` that now belongs to the employee's own branch is left
   alone; one moved to a third branch is still cleaned (the deployment put the employee there).
7. **Rows enrolled before the column existed** (an `enrol_job_id` with an empty `enrolled_device_ids` — the current code
   stamps both together) fall back to the enrolment job's PUSH_EMPLOYEE items, i.e. the old behaviour for those rows. No
   data migration is needed for them.
8. **Names kept for compatibility.** The job type stays `BRANCH_DEPLOYMENT_CLEANUP` (jobs may be queued) and the dedupe key
   format `branch-deployment-cleanup:<org>:<localDate>`, although the sweep now also enrols; the handler entry point is
   `runBranchDeploymentSweep`.
9. **Status and form checks stay in the organisation's timezone.** `scheduled / active / ended`, the list filters (SQL on
   the organisation's today) and the create / cancel date checks are unchanged; only the terminal and fence decisions use the
   host's timezone. In a single-timezone organisation the two agree.

### Test evidence

New and changed tests:
- `packages/domain/src/scheduling/deployment-window.test.ts` (3 tests): the window (`before` / `active` /
  `checkout_grace` until 11:59 / `after` from 12:00), the enrolment window, `toDate + 2` removal across a month end, the
  host's local time with Luxon (Muscat vs Riyadh, unknown zone → UTC).
- `apps/worker/src/handlers/scheduling/deployments.test.ts` (9 tests): scheduling per organisation and branch timezone;
  removal from the enrolled terminals only (a terminal the employee is on by another path and their own branch's kept); not
  removed on `toDate + 1`, removed on `toDate + 2`; hand-over to a deployment that asks for terminals (and not to one that
  does not); the cancel-after-kept scenario cleaned up although the keeper had no enrolment job; enrolment on the first day
  only, skipping (and not recording) a terminal the employee is already on, which they keep after the clean-up; enrol off →
  nothing removed; a leaver never enrolled; the module off → removal still runs, nothing enrolled; a pre-column row cleaned
  from its enrolment job's terminals.
- `apps/api/src/test/enterprise-scheduling.test.ts` (22 tests, 4 new): future-dated creation enrols nothing (no sync job,
  audit `enrolment: first_day`); every cancel cleans up (scheduled, started with a queued enrolment, handed-over terminals
  without an enrolment job of its own — only those removed); a fence the host owns for another employee neither denies the
  check-in in the host's yard nor appears in the status; the night shift's check-out at 06:05 on `toDate + 1` (host time)
  accepted with the deployment on the payload, at 15:00 refused.
- `apps/web/src/features/scheduling/scheduling.test.tsx` (8 tests, 1 new): a deployment that starts later — the toast says
  the terminals come on the first day with no `/sync` action, the list says "Added on the first day", the dialog hint says so.

Gate results (final code of the review fixes):

| Gate | Result |
|---|---|
| `pnpm build:packages && pnpm lint && pnpm -r --filter "./apps/*" run typecheck` | exit 0 |
| `pnpm test:unit` | shared 4, contracts 73, domain 429 (31 files), device-providers 454, database 24 — all passed |
| `pnpm --filter @flowza/api run test` | Test Files 62 passed (62), Tests 782 passed (782) |
| `pnpm --filter @flowza/worker run test` | Test Files 29 passed (29), Tests 300 passed, 1 skipped (301) |
| `pnpm --filter @flowza/web run test` | Test Files 123 passed (123), Tests 743 passed (743) |
| `bash supabase/tests/run-rls-tests.sh` | RLS tests passed |

### Limits left

- **A deployment "kept" before this fix** (stamped cleaned up with `kept = other_deployment` by the old sweep) handed nothing
  over: if the later deployment it was kept for had no enrolment job, its end or cancellation removes nothing. Such rows can
  be listed from the audit (`employee.deployment_cleaned_up` with `kept = other_deployment` before this release) and cleaned
  with an explicit device sync; none are expected (the slice was merged the same day).
- **Host and organisation timezones.** Status and list filters use the organisation's date (decision 9); in an organisation
  whose branches span timezones the list can show "ended" while the host's morning-after check-out is still accepted.
