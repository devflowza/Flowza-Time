# Flowza Finance: inventory of the Employee Self-Service Portal (A) and the Approval Engine and Roles (B)

**Scope and method**
- Repository: `/home/user/Flowza_Finance_V1` (React 19, Zustand 5, Supabase).
- I read the repository files only. Migrations are treated as the replay truth. The live database was not queried. Nothing was modified.
- Paths: `src/…` means `/home/user/Flowza_Finance_V1/src/…`. `M:<stamp>` means `/home/user/Flowza_Finance_V1/supabase/migrations/<stamp>_*.sql`.
- "SecDef" means SECURITY DEFINER with `SET search_path = public, pg_catalog`.
- `docs/hr-portal/prompt-pack.md` is referenced by CLAUDE.md but **does not exist**.

---

# PART A: Employee self-service portal (attendance, leave, shifts)

## A1. Architecture and identity model

**Layering** (`/home/user/Flowza_Finance_V1/docs/hr-portal/v1-plan.md`)
- The UI reads through RLS.
- Writes go only through RPCs or Edge Functions.
- Every RPC runs `is_entitled` → `user_has_permission` → `in_scope` → action → audit.

**Login-to-employee link**
- `employees.user_id` is the link.
- Partial unique index `uq_employees_organization_id_user_id_unmerged` on `(organization_id, user_id)` for unmerged rows (M:20270502000002). This gives one login one employee row per org.
- Merge tombstones keep `user_id`, so `undo_merge` stays reversible.

**Portal state columns on `employees`**
- `portal_enabled` (bool)
- `portal_invite_status`, CHECK (`not_invited`, `pending`, `accepted`, `revoked`)
- `portal_invited_at`, `portal_invite_sent_by`, `portal_accepted_at`
- `secondary_manager_id` (M:20260730000000)
- `manager_id`

**`user_is_employee()`** returns true only when `user_id = auth.uid()` AND `portal_enabled`.

**Membership: `organization_members`**
- Columns: `user_id`, `organization_id`, `role` (text), `role_id` (uuid), `is_active`, `is_hr_user` (bool, M:20260901000800).
- Permissions resolve from `role_id`.
- The text `role` drives the shell, the owner UI and Sentry.

**Which shell renders**
- The portal shell renders when `isEmployeePortalRole(role)` is true (`role === 'employee'`, `src/lib/permissions.ts:2839`).
- It also renders when the per-tab `sessionStorage` key `flowza_portal_mode` is set; `?portal=1` sets it.

**Multi-role users**
- Portal capability rides on the employee link, not on the member role.
- Accepting an invitation never demotes an existing member: `role = COALESCE(role, 'employee')`.

**Not the same as `modules_portal`**
- The HR portal is role-gated.
- `organization_module_settings.modules_portal` gates the separate ITSM/contact portal (`/home/user/Flowza_Finance_V1/docs/hr-portal/impact-map.md`).

## A2. Shell, routing and navigation

| Item | File | Behaviour |
|---|---|---|
| Shell | `src/components/layout/EmployeePortalShell.tsx` (139 lines) | See the bullets below this table. |
| Guards | `src/routes/guards.tsx` | `PORTAL_MODE_KEY='flowza_portal_mode'`. `AppShellRouter` renders the portal shell when `forcePortal \|\| isEmployeePortalRole(currentRole)`. `SmartDashboardRedirect` sends portal users to `/hrms/self-service`. |
| Route | `src/App.tsx:745` | `hrms/self-service` → `SelfServicePage` with **no PermissionGuard**; the page handles unlinked and disabled states itself. |
| Standalone check-in routes | `src/App.tsx:758-769` | `/hrms/check-in` and `/hrms/geo-check-in` sit inside `ModulePlusGuard tier="hr_plus"` plus `PermissionGuard(PERMISSIONS.ESS.ATTENDANCE_CHECKIN.CHECKIN)`. |
| Public invite accept | `src/pages/portal/PortalAcceptPage.tsx` | Route `/portal/accept/:token`. |

EmployeePortalShell details:
- Header shows the logo, portal title and org name.
- **"Exit to Finance"** appears only if the user also holds a non-employee membership in the same org. It clears `flowza_portal_mode` and hard-navigates to `orgPath(org, '/')`.
- The user menu has Sign-out, which also clears the flag.
- It renders `OfflineBanner`, the session-timeout warning, the absolute timeout and `<Outlet/>`.
- Its `navItems` entry is unused. Navigation is the in-page tab bar.

Line managers without `hrms.approvals.view`: the notification bell routes them to `/hrms/self-service` (phase-F report).

## A3. SelfServicePage (`src/pages/hrms/SelfServicePage.tsx`, 1906 lines)

**Tabs, in render order**

| Tab | Content |
|---|---|
| dashboard | `DashboardTab`, see below |
| checkin | `SelfieCheckInCard` + embedded `GeoCheckInPage`. **No client entitlement or permission gate on the tab**; the server gates. |
| profile | `SelfServiceProfileForm` + `PortalThemeCard`, with a completion-% badge |
| signature | `MySignatureTab` (`src/pages/settings/MySignatureTab.tsx`) |
| documents | `PortalDocumentsUploader` |
| leave | See A10–A13 |
| approvals | `ApprovalsTab`, with a red count badge `data-testid="ess-approvals-tab-badge"` |
| shift | `ShiftTab` |
| payslips | Latest net pay plus a list; links go to `/payroll/runs/:run/payslips/:id` |
| attendance | `PortalAttendanceCalendar` + note editor |
| other | `OtherDataTab` (the portal expenses sub-tab is behind `isPortalExpensesV1Enabled()` + `useEntitled('portal')` + `ess.reimbursements.view`) |

**DashboardTab** (`src/pages/hrms/self-service/DashboardTab.tsx`, `QuickAccessRow.tsx`) shows:
- About: designation, department, joined, reports to, years of service, anniversary.
- A timeline from `employee_history`.
- Documents compliance.
- Leave summary.
- Goals (`performance_goals`).
- My Team.
- Pinned announcements.
- Upcoming holidays (`holiday_calendars` / `holidays`).
- My upcoming leave.

**Employee lookup**
- Query: `employees.select('*, department:departments!department_id(name), manager:manager_id(first_name,last_name,designation,photo_url)')` with `.eq('organization_id', org).eq('user_id', uid).neq('status','merged').maybeSingle()`.
- The manager embed must use the bare column hint because the relation is self-referential.
- Errors go to Sentry.

**Blocked states** (only `MySignatureTab` stays usable in each)
- `portal_enabled === false` and invite status `pending`: call `rpc('reactivate_employee_portal_access', {p_org_id})` **once**. On success, reload. Otherwise show the `portalPending` banner, or `portalRevoked` if the status is revoked.
- No employee row: try `reactivate…` once, otherwise show the `notLinked` banner.

**Data loaded after linking**
- Leave: `leave_types`, `leave_allocations` (current year), `leave_requests`.
- Documents and compliance.
- Comp-off: balance, `comp_off_settings` (`min_hours_for_full_day`, `min_hours_for_half_day`, `min_credit_days`, `leave_type_id`), `comp_off_credits`.
- Payslips (12).
- `attendance_records` from last month to today (limit 30), plus the matching `attendance_notes`.
- Direct reports (`manager_id = emp.id`, excluding terminated/merged, limit 50). If there are none, department colleagues.
- Team leaves: approved/pending with `end_date >= today`, limit 20.
- `loadPortalSummary()` runs only when the secure-tabs flag is on.

**Right rail**
- `TeamSidebar` + `TeamUpcomingLeavesCard`.
- Collapse state is in `localStorage.portalTeamCollapsed`; list/grid style in `portalTeamStyle`.

**Banners** for documents compliance and onboarding. `PortalSecureTabExtras` renders above the tab body (A16).

**Header stats:** total leave balance, days present, and `LastWorkingDaysTile`.

## A4. Attendance calendar and self stats

**`src/pages/hrms/self-service/PortalAttendanceCalendar.tsx`**
- Loads the last 365 days plus the previous calendar year (limit 400 each).
- Period pills: 7, **30 (default)**, 90, 365.
- Month grids: 1, 2, 3 or 12. The 365 view uses mini cells.
- The legend has 5 entries.
- The day-detail panel shows in/out, hours and status, plus an **"Add a reason"** button (`onAddReason`).
- `PunctualityCards` cover the last 7 days, this month and last month.
- An at-a-glance block has six rows: 7, 30, 90 and 365 days, last year, and overall 24 months.

Cell colours (`cellTone`):

| Condition | Class | Label |
|---|---|---|
| Future date | transparent + border | Future |
| No record | `slate-100` | No record |
| `weekend` / `holiday` | `slate-200` | Weekend / Holiday |
| `on_leave` | `sky-400` | On leave |
| `absent` | `red-400` | Absent |
| `late`, `half_day`, or check-in without check-out | `amber-400` | Late / Half day / Missing check-out |
| `present` | `emerald-500` | Present |
| Anything else | `slate-300` | Raw status |

`attendance_records.status` CHECK (M:20270470000000): `present, absent, half_day, late, on_leave, holiday, weekend, incomplete`.

**`src/utils/attendanceSelfStats.ts`**
- Non-working statuses: weekend, holiday.
- Weights: present 1, late 1, half_day 0.5.
- **Attendance % = presentEq / workingDays × 100**, rounded to 1 decimal.
- Average hours counts only days with hours > 0.
- Also counts late, absent, leave and missing-checkout days.
- Improvement hints: `lowAttendance` (<90), `shortHours` (<8), `lateDays`, `absentDays`, `missingCheckout`.
- Helpers: `lastNAttendanceDays`, `lastNWorkingDays`.

**`src/utils/attendancePunctuality.ts`**
- Defaults: start 09:00, grace 15 minutes (mirrors `recompute_attendance_day`).
- The raw delta is displayed, but the delay total counts only minutes past grace.

## A5. Attendance notes (per-day reasons) and their pay effect

**Employee UI (attendance tab)**
- Categories: `client_visit`, `field_work`, `late_reason`, `absence_reason`, `wfh`, `other`.
- Submit calls `rpc('submit_attendance_note', {p_date, p_note, p_category})`.
- Status pills: pending amber, approved emerald, rejected red, excused teal, info_requested indigo.

**Table `attendance_notes`** (M:20270448000000, extended by M:20270449000000, M:20270494000000, M:20270496000000)
- Core columns: `id, organization_id, employee_id, attendance_date, note NOT NULL, category CHECK, status CHECK, reviewed_by, reviewed_at, review_reason, created_at, updated_at`.
- Deduction columns: `deducted_leave_type_id, deducted_days, loss_of_pay`.
- Review columns: `excused_at, excused_by, pay_effect_days (CHECK 0 | 0.5 | 1.0), info_requested_at, info_request_message, payroll_run_id` (the last is the LOP payroll claim).
- `status` CHECK: `pending, approved, rejected, excused, info_requested`.
- Partial unique index `uq_attendance_notes_emp_date_active` on `(employee_id, attendance_date) WHERE status <> 'rejected'`.
- RLS SELECT: own row OR `hrms.attendance.view` / `hrms.attendance.manage`. **There is no write policy**; writes go only through RPCs.

**RPCs**

`submit_attendance_note(p_date date, p_note text, p_category text DEFAULT 'other')`
- Upserts the non-rejected note back to `pending` and clears the review fields. Logs the change.
- **Risk:** it finds the employee by `user_id` with `LIMIT 1` and no org filter.

`get_my_attendance(p_from date, p_to date)`
- Returns `attendance_date, check_in, check_out, work_hours, overtime_hours, status, within_geofence, note_id, note, note_category, note_status, note_review_reason`.
- Same multi-org risk.

`list_pending_attendance_notes_v2(p_org_id uuid, p_scope text DEFAULT 'mine')`
- Returns `note_id, employee_id, employee_name, employee_number, attendance_date, note, category, day_status, status, pay_effect_days, excused_count_year, is_oversight_only`.
- `'all'` requires `hrms.attendance.manage` or `hrms.attendance_regularisation.approve`.
- Excludes the caller's own notes.

`review_attendance_note_v2(p_note_id uuid, p_decision text, p_reason text DEFAULT NULL, p_pay_effect_days numeric DEFAULT NULL)` (M:20270498000000)
- `p_decision ∈ {approved, rejected, excused, info_requested}`; `p_pay_effect_days ∈ {0, 0.5, 1.0}`.
- **No self-review:** returns "you cannot review your own attendance reason".
- Authorised if HR (`hrms.attendance.manage` OR `hrms.attendance_regularisation.approve`) OR the **primary or secondary manager** of the note's employee.
- Approve or excuse **restores** a prior deduction (decrements `leave_allocations.used_days`) and clears LOP.
- Reject calls `_deduct_leave_for_unexcused_note`.
- Notifies the employee with type `attendance_note_reviewed`, link `/hrms/self-service`.
- Returns `{success, status, deducted_days, loss_of_pay}`.
- Errors come back as `{success:false, error}` (no RAISE).

`_deduct_leave_for_unexcused_note(p_note_id, p_override_days)` (M:20270495000000; revoked from clients)
- Amount: absent → `coalesce(override, 1.0)`; late → `coalesce(override, 0.5)`; anything else → 0.
- Paid types only, excluding SICK, MATERNITY, PATERNITY, HAJJ, MARRIAGE, BEREAVEMENT, ADOPTION and COMPASSIONATE.
- Order: ANNUAL, then CASUAL, then the type with the most remaining.
- With no balance, it sets `loss_of_pay = true`. Otherwise it increments `used_days`.

`_sweep_unexcused_attendance(p_org, p_asof)` (M:20270494000000)
- Driven by `attendance_policies.auto_deduct_unexcused` and `missing_punch_grace_days` (default 3).
- Targets absent, late, incomplete or single-punch days with **no** note in (pending, approved, excused, info_requested).
- Absent deducts 1.0, the others 0.5, or the day becomes LOP.
- Writes the system note "Auto: no reason provided...".

**Payroll bridge:** `get_payroll_attendance_summary` prices `loss_of_pay` notes (CLAUDE.md, "LOP Bridge").

**Manager and HR UI**
- `src/components/approvals/AttendanceNoteApprovalList.tsx` + `src/stores/attendanceNoteApprovalStore.ts`, shared by the inbox and the portal.
- Four actions:
  - Approve.
  - Excuse.
  - Ask info (input required).
  - Reject (pay effect required: 0 "No deduction", 0.5 or 1).
- Toasts report LOP, deducted, or no charge.
- Badges: excused count this year; "oversight".
- Props: `includeOversight`, `showWhenEmpty`, `onActioned`. Activity entity is `attendance_note`.

## A6. Attendance regularisation

**UI:** `src/pages/hrms/self-service/secure/SecureAttendancePanel.tsx`. It appears only under the secure-tabs flag (A16).
- Fields: date; type in `missed_punch | wrong_punch | wfh_unmarked | system_downtime`; expected in and out times; reason.
- Calls `portalAttendanceStore.submitRegularisation`.

**Table `attendance_regularisation_requests`** (M:20270424000000)
- `request_type` CHECK: the 4 types above.
- `status` CHECK: `pending, approved, rejected, cancelled`.
- Other columns: `expected_check_in/out` (time), `reason`, `supporting_notes`, `original_record_id`, `approval_request_id`, `applied_at`.

**RPCs**

`submit_attendance_regularisation(p_org_id uuid, p_employee_id uuid, p_attendance_date date, p_request_type text, p_expected_check_in time DEFAULT NULL, p_expected_check_out time DEFAULT NULL, p_reason text DEFAULT NULL, p_supporting_notes text DEFAULT NULL)`
- The caller must be the employee (`user_is_employee`), and the type is validated.
- Inserts `pending`, calls `submit_for_approval_atomic(org, 'attendance_regularisation', req, uid)`, and stamps `approval_request_id`.

`apply_attendance_regularisation(p_request_id uuid)`
- Runs only once the request is approved, and is idempotent via `applied_at`.
- Upserts `attendance_records` with source `regularisation`, then calls `log_audit_event`.

**HR side**
- `src/stores/attendanceRegularisationStore.ts`: `fetchRequests` (filters), `createRequest`, `bulkRegularise`, `applyRegularisation`.
- `src/components/hrms/RegularisationRequestModal.tsx` and `RegularisationFormSchema`.

## A7. Check-in: three coexisting paths

### (1) Server-authoritative punch, flag-gated and `hr_plus`

**UI:** in `SecureAttendancePanel`, the Check In/Out card renders only when `hrPlus = useEntitled('hr_plus')`.
- It shows a server-time note, the queued-punch count and "Day complete".
- Coordinates come from `getCoords` with a 5 s timeout.
- Calls `punch(org, action, coords, 'web')`.
- On mount it runs `flushQueue`, then `fetchToday`.

**Store: `src/stores/portalAttendanceStore.ts`**
- Queue key `flowza:portal.punch-queue` in localStorage. **The key is not org-scoped**; each entry carries its own `org_id`.
- `callPunch` → `rpc('portal_check_punch', {p_org_id, p_action, p_lat, p_lng, p_source})`.
- `already_checked_in` and `already_checked_out` are treated as benign.
- A network throw enqueues the punch.
- `flushQueue` replays punches and keeps failures. **Replayed punches get the replay time**, because the server uses `now()`.
- `fetchToday` reads today's `attendance_records` using the client's ISO date.

**RPC:** `portal_check_punch(p_org_id uuid, p_action text, p_lat numeric DEFAULT NULL, p_lng numeric DEFAULT NULL, p_source text DEFAULT 'web')` (M:20270424000000)
- Uses server `now()`.
- The employee must satisfy `user_id = auth.uid()`, the org, `portal_enabled` and `status = 'active'`.
- Policy gates return `web_checkin_disabled` / `mobile_checkin_disabled`.
- Errors: `already_checked_in`, `already_checked_out`, and `not_checked_in` (check-out without a check-in).
- Inserts `ON CONFLICT (employee_id, attendance_date)` and logs `checked_in` / `checked_out`.

### (2) Geofenced punch, used by the portal check-in tab

**UI: `src/pages/hrms/geo-checkin/GeoCheckInPage.tsx`**
- `ACCURACY_WARN_M = 50`. Geolocation uses high accuracy, a 15 s timeout and `maximumAge 0`.
- A "today" strip enables only the sensible next action.

**Step 1: Locate.** `previewCheckin` calls `rpc('preview_geofence_checkin', {p_org, p_lat, p_lng, p_accuracy, p_action, p_wifi_ssid, p_is_mock})`. `VerdictBanner` then shows one of:
- `noFence`, when the reason is `no_fences_assigned` or `no_evaluation`.
- `allowed`, `flagged`, `logged` or `denied`.
- A dedicated denied message when the reason is `mock_location_detected`.

It also shows the nearest zone with its distance, and a low-accuracy warning.

**Step 2: Confirm.** Disabled when the verdict is denied.
- Builds `{action, lat, lng, accuracy, ts: now ISO, is_mock: false, source: 'web'}`.
- Offline, it enqueues. Otherwise it calls `submitPunches`, which invokes the Edge Function `workforce-checkin` with `{organization_id, punches}`.
- A transport error enqueues the punch.
- The response is `{accepted, verdict, reason, warning}`.

**Queue UI:** "Sync now" and "Discard". Auto-flushes on the `online` event and on mount.

**Queue: `src/pages/hrms/geo-checkin/geoCheckinQueue.ts`**
- Key `flowza.geocheckin.queue.${orgId}`.
- `QueuedPunch {action 'in'|'out', lat, lng, accuracy?, ts (original time), is_mock?, source?}`.
- Functions: `loadQueue`, `saveQueue`, `enqueue`, `clearQueue`.
- Server `dedup_hash` collapses re-sends.

**Edge Function: `/home/user/Flowza_Finance_V1/supabase/functions/workforce-checkin/index.ts`**
- `verify_jwt = false`; the JWT is verified in the function body.
- `MAX_BATCH_SIZE = 200`. Each punch keeps its original `ts`. The client IP comes from gateway headers.
- Calls `checkin_punch`.

**`checkin_punch`** (M:20261117060000)
- Action must be in or out.
- The caller must be the employee or hold `hrms.attendance.manage`.
- Runs `evaluate_geofence`.
- A **denied** verdict is not persisted. It is logged as `rejected punch_event` with a human reason, for example "Mock or spoofed location detected..." or "You are N m outside X".
- Otherwise `ingest_punch` writes it (source `rest_api`, deduplicated).

**`evaluate_geofence(p_org_id, p_employee_id, p_lat, p_lng, p_accuracy_m, p_ts DEFAULT now(), p_action DEFAULT 'checkin', p_wifi_ssid, p_ip inet, p_is_mock)`** (M:20261117050000, PostGIS)
0. Mock guard: deny if any assigned fence has `allow_mock_location = false`.
1. Build the SRID 4326 point.
2. Resolve fences by priority: employee > team (department) > site > org.
3. Apply time windows `[{dow 1..7, start, end}]`.
4. Accuracy gate `gps_accuracy_threshold_m` → flagged (denied if `hard_block`).
5. Geometry: circle `radius_m` or polygon `boundary_geojson`, plus `grace_radius_m`.
6. Wi-Fi (`wifi_ssids`) and IP (`ip_cidrs`) co-validation.
7. Per-fence enforcement: `hard_block`→denied, `soft_warn`→flagged, `advisory_log`→logged. **The worst verdict wins.**
8. No fences → allowed, reason `no_fences_assigned`.

Other fence fields (`src/stores/geofenceStore.ts`): `site_id, type circle|polygon, center, min_dwell_seconds, require_on_checkin/checkout, priority, active_from/to, enabled`, and assignments scoped to org, site, team or employee.

**`attendance_records.within_geofence`** (M:20272090000000)
- `true` only when the punch was inside.
- `false` only when a real fence was evaluated and not passed.
- `NULL` when unknown.
- `'logged'` maps to false.
- Selfie approvals now write `null`.

### (3) Legacy standalone page: `src/pages/hrms/CheckInPage.tsx`
- Calls `workforceStore.checkIn(org, action, coords, 'mobile'|'web')`, which invokes the Edge Function `attendance-checkin`. That function uses `work_locations` + `attendance_policies` and writes `attendance_records`.
- The page shows a live clock, a `within_geofence` indicator and a notLinked message.
- `attendance_policies` fields:
  - `allow_web_checkin`, `allow_mobile_checkin`
  - `enforce_geofence`, `enforce_ip_restriction`, `default_geofence_radius_meters`
  - `work_start_time`, `late_grace_minutes`, `working_weekdays smallint[]` (0 = Sun), `timezone`
  - `auto_status_enabled`, `auto_deduct_unexcused`, `missing_punch_grace_days`

## A8. Selfie check-in (open attendance)

**Files:** `src/pages/hrms/self-service/SelfieCheckInCard.tsx`, `SelfieCameraModal.tsx`. HR panels: `src/pages/hrms/components/SelfieCheckinReviewPanel.tsx`, `OpenAttendanceGrantsPanel.tsx`.

**Visibility:** hidden unless an active `open_attendance_grants` row exists. That table is unique on (org, employee) and is set by `set_open_attendance_grant(p_employee, p_enabled)`, callable by `hrms.attendance.manage` or the manager.

**Flow**
1. Geolocation (high accuracy, 15 s).
2. Live camera only.
3. Optional face match against `employees.photo_url`, toggled by `hrms_preferences.selfie_face_verification_enabled`.
4. Upload to the private bucket `attendance-selfies` at `${org}/${emp}/${uuid}.jpg` (5 MB; jpeg/png/webp). Employees may insert only into their own folder; HR can delete.
5. `rpc('submit_selfie_checkin', {p_selfie_path, p_lat, p_lng, p_accuracy, p_captured_at})` checks the grant and the path, then notifies the manager (`selfie_checkin_submitted`).
6. `rpc('set_selfie_face_result', {p_selfie_path, p_ratio, p_status})` is write-once; status is `'skipped'` when verification is off.

The card shows the last 5 check-ins with status and face-match chips.

**Table `attendance_selfie_checkins`** (M:20270468000001, M:20270529000001)
- Columns: `latitude, longitude, accuracy_meters, selfie_path`, review fields, `attendance_record_id`, `face_match_ratio numeric(5,2)`.
- `status` CHECK: `pending, approved, rejected`.
- `face_match_status` CHECK: `match, partial, not_matched, no_face, no_reference, skipped`.
- SELECT: own row, HR view/manage, or the manager.

**Review and viewing**
- `review_selfie_checkin(p_id, p_decision, p_reason)`: approval creates an `attendance_records` row with source `selfie`.
- `list_pending_selfie_checkins(p_org)`.
- Managers view the photo through the Edge Function `attendance-selfie-url`, which returns a signed URL.

## A9. Shifts and shift swap

**`src/pages/hrms/self-service/ShiftTab.tsx`** is **read-only**.
- It loads the org's shifts and assignments.
- The current assignment is the one where `effective_from <= now <= effective_to` (or open-ended).
- `ShiftCard` shows start, end, break, grace and effective dates.
- It also lists available shifts (with weekly-off days) and shift history.
- There is **no swap button**.

**`shifts` fields**
- `shift_type` values: morning, evening, night, general, split.
- Times and allowances: `start_time, end_time, grace_period_minutes, early_departure_threshold_minutes, break_duration_minutes`.
- Other: `weekly_off_days text[], night_shift_allowance, is_active`.

**`shift_assignments`:** `employee_id, shift_id, department_id, effective_from, effective_to`.

**Shift swap: ORPHANED in the portal**
- `src/components/hrms/ShiftSwapModal.tsx` + `ShiftSwapFormSchema.ts` are not mounted anywhere.
- Validations:
  - zod: `targetEmployeeId` and `swapDate` required.
  - The requester has a shift on that date.
  - The target has a shift on that date.
  - The two shifts differ.
- `createSwapRequest` does a direct INSERT.
- The HR `src/pages/hrms/ShiftListPage.tsx` "swaps" tab creates swaps with its own modal, also a direct insert. **There is no approve/reject UI.**
- Table `shift_swap_requests`:
  - Columns: `requestor_employee_id, target_employee_id, swap_date, requestor_shift_id, target_shift_id`, `approval_request_id` (unused), `created_at`.
  - `status` CHECK: `pending, approved, rejected, cancelled`.
  - RLS is broad: any org member can SELECT and do ALL.
- Entity type `shift_swap` is registered in the engine (subject = `requestor_employee_id`) but **never submitted**.
- Permissions `hrms.shifts.view` / `.manage` are granted to owner only.

## A10. Leave: type visibility, applicability, balances, day count

**`leave_types`**
- Columns: `code, days_per_year, is_paid, carry_forward_days, max_consecutive_days, requires_approval, advance_notice_days, color, is_active, show_in_employee_portal (tri-state, M:20270510000000), applies_to, applicable_gender`.

**Portal visibility: `src/utils/leavePortalVisibility.ts`**
- `true` means always show; `false` means never; `NULL` means auto.
- Auto shows a type whose name matches `/(annual|earned|privilege|comp\s*-?\s*off|compensat|sick)/` or whose code is AL, ANNUAL, EL, PL, CO, COMPOFF, COMP_OFF, SL or SICK.
- `isCompOffLeaveType`: the settings id wins, otherwise the codes or name regex. `isAnnualLeaveType` is also exported.

**Applicability: `src/utils/leaveApplicability.ts`**
- `applies_to` (`all | local | expatriate`) is matched strictly against `employees.employee_type`.
- `applicable_gender` (NULL | male | female) is matched **laxly**: an employee with no gender still sees restricted types.

**Portal type list** = active ∧ visible-in-portal ∧ not comp-off ∧ applies to the employee.

**Balances: `src/utils/leaveBalances.ts`** (computed client-side; `computeLeaveTypeBalance`, `sumLeaveBalances`)
- consumed = approved requests.
- pending = `pending` + `info_requested`.
- entitled = allocated (else the type default) + carry-forward used + carry-forward available (respecting expiry).
- taken = `used_days` + approved days.
- available = entitled − taken.
- accrued = `accruedToDate` (day by day from the hire date) + carry-forward.
- availableToday = accrued − taken.
- `availableAfterPending` is also returned.
- A request counts in the year it **starts**.
- Supporting files: `leaveAccrual.ts`, `leaveCarryForward.ts`.

**Portal tiles:** entitlement, used (incl. approved), pending, remaining, accrued.

**Day count: `src/utils/leaveDayCount.ts`**
- Call: `countLeaveDays(start, end, hrms_preferences.leave_day_calculation_mode ?? 'calendar', workingWeekdays)`.
- Modes: `calendar` (inclusive) or `business_days` (default working weekdays `[1..5]`, 0 = Sunday).
- Dates are parsed as UTC.
- Server mirror: `leave_day_count(p_org, p_start, p_end)` (M:20272110000000, private).

**Allocations:** `leaveStore.fetchAllocations` (limit 500); `upsertAllocation` on conflict `(employee_id, leave_type_id, year)`; `closeLeaveYear` → `rpc('close_leave_year')`.

**Enforcement gaps**
- `advance_notice_days`, `max_consecutive_days` and `requires_approval` are **not enforced** for ordinary leave.
- `max_consecutive_days` **is** enforced for comp-off by `request_comp_off_leave`.
- `verifyLeaveRequest` in `src/utils/approvals/hrPayrollVerification.ts` computes advisory checks (balance vs `days_per_year`, consecutive limit, advance notice, overlap) but **has no consumer**.

## A11. Leave: apply, edit and withdraw

**Portal leave modal** (in `SelfServicePage`; backdrop click does not close it)
- Type* (comp-off excluded), From*, To* (`min` = From), and a days preview.
- **Balance preview:** available, pending, after this request. A negative "after" shows a red warning. It is **advisory; submit is not blocked.**
- Reason (optional).
- **No half-day and no attachments.** The columns `is_half_day`, `half_day_period` and `attachments jsonb default '[]'` exist but are unused by the portal.

**Store: `src/stores/leaveStore.ts`** (727 lines)

`createLeaveRequest`
1. Overlap pre-check against own pending/approved requests; **fails closed** if the check errors.
2. Direct INSERT with `status: 'pending'`.
3. Error mapping:
   - `23P01` / `daterange_excl` → overlap message.
   - `comp_off_requires_rpc` → comp-off message.
4. `logActivity`.
5. `submitForApproval(org, 'leave_request', id, actor)`. A no-manager error maps to "Ask HR to set your reporting manager".
6. Auto-approval is **not** mirrored client-side; a DB trigger does it.

`updateLeaveRequest(id, {start_date, end_date, leave_type_id?, reason?})`
- Reads the row, re-checks overlap excluding itself, and updates with `.select('id')` passed through `leaveWriteError`.
- Logs old and new values plus `correction_after_decision`.
- If the request was still undecided, it **re-submits** to the engine. The old request has already been invalidated by a trigger.
- The edit modal omits `days` (the server derives it) and shows a resubmit note.

`withdrawLeaveRequest`: sets status to `'cancelled'` with `.select('id')`.

**Utilities**
- `src/utils/leaveOverlap.ts`: blocking statuses are pending and approved. Two ranges overlap when `start <= endB && end >= startB`.
- `src/utils/leaveEditability.ts`:
  - Undecided = `pending, info_requested`.
  - `canEditLeave`: undecided → own or `canManage`; decided → `canManage` only.
  - `canWithdrawLeave`: undecided ∧ (own ∨ manage).
  - `leaveEditIsCorrection`.
- `src/utils/leaveWriteError.ts`:
  - Guard tokens: `leave_locked_after_decision`, `leave_locked_by_payroll`, `leave_end_before_start`, `comp_off_requires_rpc`.
  - `23P01` → overlap message.
  - 0 rows affected → "RLS refused".

**Server (DB)**
- `leave_requests` columns: `id, organization_id, employee_id, leave_type_id, start_date, end_date, days numeric(6,2), reason, status, approved_by, approved_at, rejection_reason, attachments jsonb, is_half_day, half_day_period, notes (deprecated), created_at, updated_at`.
- `status` CHECK: `pending, approved, rejected, cancelled, info_requested`.

**Constraints and triggers**
- **Overlap exclusion** (M:20270534000003): `leave_requests_employee_id_daterange_excl EXCLUDE USING gist (employee_id WITH =, daterange(start_date,end_date,'[]') WITH &&) WHERE status IN ('pending','approved')`. It needs btree_gist, and it also blocks two half-days on the same date.
- **`trg_leave_requests_edit_guard`** → `_leave_request_edit_guard()`, BEFORE INSERT OR UPDATE (M:20272110000000):
  - Enforces end ≥ start.
  - Derives `days` server-side (0.5 for a single-date half-day).
  - Lets status-only changes and callers with a NULL `auth.uid()` through.
  - Once decided, only `hrms.leave.manage` may edit.
  - Comp-off types require the RPC GUC.
  - A payroll-covered period is locked unless the caller has manage (logged).
- **`leave_requests_update_self_pending`** policy: USING own row ∧ status ∈ (pending, info_requested); WITH CHECK status ∈ (pending, info_requested, cancelled). An employee can never self-approve through the API.
- **`trg_leave_requests_invalidate_approval`**: AFTER UPDATE of content columns WHEN the old status was undecided → `invalidate_entity_approval_on_change('leave_request')`.
- **`trg_leave_requests_cancel_pending_approvals`** (M:20272122000000): status → cancelled calls `approval_requests_cancel_on_document_death()`.
- **Engine-to-leave sync**:
  - `trg_sync_leave_request_from_approval` (AFTER UPDATE OF status ON `approval_requests`, M:20270500000000). Approved sets leave `approved` plus `approved_at` and `approved_by`. Rejected sets `rejected` plus `rejection_reason = COALESCE(existing, last level comment)`. Cancelled sets `cancelled`. **It acts only when the leave is still `status='pending'`.**
  - `trg_sync_leave_request_from_approval_ins` (AFTER INSERT, M:20272130000000) handles auto-approved inserts.

**HR-side leave**
- `src/pages/hrms/EmployeeLeaveTab.tsx`: allocation cards (allocated − used) and a requests table.
- `src/pages/hrms/LeaveRequestFormSchema.ts`: employee, type and dates required; reason optional.
- `src/pages/hrms/components/LeaveModals.tsx`: balance preview with an exceeded warning. Comp-off goes through `request_comp_off_leave`.

**"My requests" list**
- Status badges: approved emerald, rejected red, pending amber, cancelled slate, info_requested indigo. The rejection reason is shown.
- History toggle. `fetchLeaveTimelines` merges leave rows, engine levels and `user_activity_log` through `src/utils/leaveRequestTimeline.ts` (`buildLeaveTimeline`).
  - Timeline kinds: `submitted, approved, rejected, info_requested, cancelled, skipped`.
  - Activity-log events are de-duplicated against engine events of the same kind.
- Edit and withdraw use `canWithdrawLeave(status, {isOwnRequest:true, canManage:false})`. Withdraw has a confirm modal.

## A12. Leave comment thread and the info-requested loop

**Table `leave_request_comments`** (M:20270496000003)
- Columns: `leave_request_id, organization_id, user_id (nullable), comment CHECK (btrim <> ''), created_at, updated_at`.
- **Append-only.**
- SELECT follows the parent leave's visibility.
- INSERT requires `user_id = auth.uid()` ∧ (requester ∨ `hrms.leave.manage` ∨ `hrms.leave.approve` ∨ manager).
- Existing `notes` were backfilled into the table.

**RPCs**
- `leave_request_ask_info(p_request uuid, p_comment text)`:
  - Allowed for manage, approve or manager.
  - The leave must be pending or info_requested.
  - Posts the comment and sets the leave to `info_requested`.
  - The approval request itself **stays pending**.
- `leave_request_resubmit(p_request uuid, p_comment text DEFAULT NULL)`: requester only; moves `info_requested` → `pending`.

**Stores and UI**
- `src/stores/leaveThreadStore.ts`:
  - `fetchThread` reads comments with `author:profiles!user_id(full_name)`, oldest first.
  - `askInfo` and `resubmit` call the RPCs and `logActivity`.
- `leaveStore.askLeaveInfo` also creates a notification of type `leave_info_requested` with `action_url '/self-service'`.
- `src/components/hrms/LeaveRequestThread.tsx`:
  - Mode `employee` can post only while `info_requested`, via "Reply & Resubmit" (comment optional).
  - Mode `approver` can post while undecided; the question is required.
  - Author fallback: profile name → manager name → system label. Each message shows date and time.
  - The portal shows the thread only on pending and info_requested rows.

## A13. Comp-off (credit and redeem)

**Credit request** (`useCompOffStore.requestCredit`, `src/stores/compOffStore.ts`)
- Earned date: must be ≤ today.
- Worked on: `weekly_off` | `holiday`.
- Hours: 0–24 in 0.5 steps.
- Location*: max 200 characters.
- Summary*: max 1000 characters.
- Preview via `compOffDaysFromHours`, using the org thresholds (defaults 8 h full day, 4 h half day).

**Redeem**
- `request_comp_off_leave(p_org uuid, p_employee uuid, p_start date, p_end date, p_reason text DEFAULT NULL, p_half_day_period text DEFAULT NULL)` (M:20270607000000). It is the RPC-only path; direct inserts are blocked by the edit guard.
- A date range. A half day (`first_half`/`second_half`) is allowed only for a single date.
- Reason: max 500 characters.
- Cannot exceed the balance. Enforces `max_consecutive_days`. Reserves credits FIFO by expiry.

## A14. Team views and pending counts

**`src/pages/hrms/self-service/TeamSidebar.tsx`**
- Title "Reporting Team" (when there are direct reports) or "My Team" (department colleagues), with a count.
- List or grid view; search appears when there are more than 5 members.
- Presence badge: "On leave" (approved leave covering today) or "In" (status active).

**`src/pages/hrms/self-service/TeamUpcomingLeavesCard.tsx`**
- `TeamLeave {employee_id, employee_name, start_date, end_date, leave_type_name, status}`.
- Shows name, status badge, type and dates. Scrolls; hidden when empty.

**`src/pages/hrms/self-service/pendingTeamLeaveCount.ts`**
- `fetchPendingTeamLeaveCount`: reads `approval_requests` (entity `leave_request`, status `pending`, limit 200) with their levels. It counts requests whose level row at `current_level` is `pending` with `approver_id` or `delegate_id` equal to the user.
- `fetchPendingAttendanceNoteCount`: `rpc('list_pending_attendance_notes_v2', {p_scope:'mine'})`.
- `fetchPendingApprovalsBadgeCount(org, userId)` is the sum. Each half degrades to 0 on error. It is refreshed by an `onActioned` bump.

## A15. Manager view inside the portal

**`src/pages/hrms/self-service/ApprovalsTab.tsx`**
1. `AttendanceNoteApprovalList` (`showWhenEmpty`).
2. The leave queue: engine-assigned leave requests.
   - Filter **Pending | All**. "All" adds the last 50 requests from direct reports (`manager_id`) as **view-only**.
   - Actions appear only on assigned pending rows:
     - Approve → `approveLeaveRequest`.
     - Deny (reason required) → `rejectLeaveRequest`.
     - Ask more info (question required) → `askLeaveInfo`.
   - `LeaveRequestThread` in approver mode, with a manager-name byline.

**`src/pages/hrms/self-service/managerResolver.ts`**
- `resolveManager` returns name, designation, photo, initials and `hasManager`.
- It contains a **hard-coded `MANAGER_OVERRIDES` tenant map. Do not replicate it.**

**`src/pages/hrms/self-service/types.ts`**: `PortalEmployee` includes `portal_enabled` and `portal_invite_status`.

## A16. Secure tabs, portal summary and entitlements

**Flag**
- `isPortalSecureTabsV1Enabled()` in `src/lib/featureFlags.ts:108`.
- Env `VITE_FF_PORTAL_SECURE_TABS_V1`, **default false**. localStorage override `flowza:portal.secure-tabs-v1`.

**`src/pages/hrms/self-service/secure/PortalSecureTabExtras.tsx`**
- Returns null unless the flag is on AND `useEntitled('portal')` is true.
- Tab mapping:
  - dashboard → `SecureDashboardCards`
  - payslips → `SecurePayslipsPanel`
  - documents → `SecureDocumentsPanel`
  - profile → `SecureProfileSensitivePanel`
  - attendance → `SecureAttendancePanel` (`hrPlus = useEntitled('hr_plus')`)

**`src/stores/portalSessionStore.ts`** → `rpc('get_portal_summary', {p_org_id})`. It returns:
- `entitlements {hrms, payroll, portal, hr_plus, payroll_plus, portal_plus}`
- `permissions`
- `notifications.unread`
- `employee`
- `dashboard {pending_approvals, leave_pending, leave_upcoming, unacknowledged_documents, latest_payslip}`

**Client gating is UX only**
- `src/hooks/useEntitled.ts` and `src/hooks/useCan.ts` read this store.

**`is_entitled(p_org_id, p_module)`** (M:20270417000000)
- `hrms`, `payroll`, `portal` → `organization_module_settings.modules_*`.
- `*_plus` → `org_has_module_plus`.

**Mostly declared only**
- `portal.*` slugs: `portal.{dashboard, profile, leave, payslips, documents, attendance, approvals, services, shift, signature}.view`.
- `ess.*` slugs (`src/lib/permissions.ts:922`, `ESS_PERMISSIONS` at :2827): `ess.profile.view/edit`, `ess.leave.view/request`, `ess.payslips.view/download`, `ess.attendance.view`, `ess.documents.view/upload`, `ess.reimbursements.view/submit`, `ess.attendance_checkin.checkin`, and others.
- **Portal tabs do not check these.** The only exceptions are the check-in routes and the expenses sub-tab.

## A17. Portal invite flow

**Tables and columns**
- `employee_portal_invitations`: `status` CHECK (`pending, accepted, expired, revoked`), `expires_at` default `now() + 7 days`, `token_hash bytea` (sha256, indexed).
- Legacy plaintext `token` values on consumed rows were overwritten with `'consumed:'||id`.

**RPCs** (SecDef; auth surface)

| RPC | Behaviour |
|---|---|
| `seed_employee_system_role(p_org_id)` | Inserts the per-org role ('Employee', slug `employee`, `is_system`, `is_system_role`, `is_active`). Backfilled for all orgs; trigger `trg_seed_employee_role_on_org_create`. **The role carries no permissions.** |
| `create_employee_portal_invitation(p_employee_id uuid, p_org_id uuid)` | See below. |
| `resend_employee_portal_invitation(p_employee_id, p_org_id)` | Same gate. If the employee is **already linked**, it restores access directly and returns `reactivated:true` (M:20270503000003+). |
| `validate_employee_portal_invitation(p_token text)` | Looks up by hash first, then plaintext. Handles accepted, revoked and expired. Returns `valid, invitation_id, email, employee_id, employee_name, organization_id, org_name, expires_at`. |
| `accept_employee_portal_invitation(p_token text, p_user_id uuid)` | See below. |
| `revoke_employee_portal_access(p_employee_id uuid, p_org_id uuid)` | Gated by `hrms.portal.manage`. Turns the portal off (status revoked). **Does not clear `user_id`**, because about 45 functions join on it. |
| `reactivate_employee_portal_access(p_org_id uuid)` | Self-heal called by the portal page. Re-links against an invitation anchor with status `pending` **or `expired`** (M:20270542000003). A first-time link requires a confirmed email. Latest body: M:20270542000003. |
| `revoke_portal_on_employee_termination()` | Trigger `trg_revoke_portal_on_termination`, BEFORE UPDATE OF status, fires on terminated/offboarded. Turns the portal off, sets revoked, and deactivates `employee`-role memberships. |

`create_employee_portal_invitation`:
- Requires active membership and `hrms.portal.manage` (sort 460; granted to owner and accountant).
- Email = `COALESCE(work_email, email)`.
- Revokes any pending invitations.
- Token = `uuid || '-' || uuid`, stored with its sha256 hash, 7-day expiry.
- Sets `employees.portal_invite_status = 'pending'` and the invited_at/by fields.
- Returns `{success, token, email, invitation_id}`.

`accept_employee_portal_invitation`:
1. Identity is `auth.uid()`; a mismatch with `p_user_id` raises an error.
2. Pending lookup by hash, then an expiry check.
3. The **JWT email must equal the invitation email**.
4. Looks up the org's `employee` role.
5. **Releases stale links** of this user (M:20270502000002).
6. Sets `employees.user_id`, `portal_enabled = true`, status `accepted`.
7. Upserts the membership with `role = COALESCE(role, 'employee')` and `role_id = COALESCE(role_id, v_role_id)`.

**Client**
- `src/stores/employeePortalStore.ts`: `inviteEmployee`, `resendInvitation` (passes `reactivated` through), `revokeAccess`, `validateInvitation`, `acceptInvitation` (safe error messages), `sendPortalInvitationEmail` → Edge Function `send-employee-portal-invitation`.
- Admin UI:
  - `src/components/hrms/PortalAccessPanel.tsx`, gated by `PERMISSIONS.HRMS.PORTAL.MANAGE`.
  - `src/pages/payroll/employee-detail/PortalAccessWidget.tsx`.
- Portal page states: `notLinked`, `portalPending`, `portalRevoked`.

**Supporting docs**
- `/home/user/Flowza_Finance_V1/docs/hr-portal/reports/employee-portal-single-user-link.md` (fixes shipped in M:20270502000002, M:20270503000003, M:20270504000003, M:20270505000000).
- `portal-pending-banner-expired-invitation.md` (M:20270542000003).

## A18. RLS and RPC model

**Self-scoped SecDef RPCs** (all key off `auth.uid()` → `employees.user_id`)
- `submit_attendance_note`
- `get_my_attendance`
- `submit_attendance_regularisation`
- `portal_check_punch`
- `checkin_punch` (self or manage)
- `submit_selfie_checkin`
- `set_selfie_face_result`
- `leave_request_resubmit`
- `request_comp_off_leave`
- `reactivate_employee_portal_access`
- `get_portal_summary`

**Visibility helpers (M:20270492000000, attendance)**
- New permission `hrms.attendance.view_all`, granted to owner, org_admin, hr_admin, hr_manager, time_attendance_admin, accountant and auditor.
- `hrms.attendance.view` backfilled to org_admin, hr_admin, hr_manager and time_attendance_admin.
- **`attendance_visible_employee_ids(p_org)`** returns employees where any of the following holds:
  - `auth.uid()` is NULL
  - super admin
  - the caller has `view_all`
  - the row is the caller's own
  - the row's `manager_id` or `secondary_manager_id` is the caller's employee row
- `attendance_records` policies:
  - `select_scoped`
  - `insert_scoped` (manage OR own row)
  - `update_manage` / `delete_manage` (`hrms.attendance.manage` only)
- `punch_events` is scoped the same way.
- `get_attendance_register(p_org, p_from, p_to, p_employee DEFAULT NULL)` and `get_attendance_daily_summary` are visibility-scoped; anon is revoked.

**Visibility helpers (M:20270493000002, leave)**
- `hrms.leave.view_all`, granted to owner, org_admin, hr_admin, hr_manager, leave_approver, accountant and auditor.
- `leave_visible_employee_ids(p_org)` has the same shape as the attendance helper, plus `hrms.leave.manage`.
- `leave_requests` policies:
  - `select_scoped`
  - `insert_scoped` (manage OR own)
  - `update_approvers` (manage, approve, or the manager/secondary manager)
  - `delete_manage`

**Approver visibility (M:20271910000000)**
- `caller_is_leave_approver(p_leave_id, p_org)` reads only the `approval_*` tables, so there is no recursion.
- `leave_requests_select_scoped` = org ∧ (visible ∨ named approver/delegate).
- The same migration adds `approval_request_subject_user` and the latest `approve_approval_level` / `reject_approval_level` bodies (B6).

**`employee_manager_closure`** (M:20270417000000)
- Columns: `organization_id, manager_id, report_id, depth`; PK `(manager_id, report_id)`.
- Rebuilt by a trigger on `manager_id` only (not the secondary manager).
- Used by `in_scope(...,'all_reports')`.

**`role_permission_scopes`**
- `scope_type` CHECK: `self, direct_reports, all_reports, department, branch, legal_entity, payroll_group, all, selected`; plus `scope_value` and `amount_limit`.
- `in_scope(p_target_employee_id, p_scope_type, p_scope_value DEFAULT NULL)`: `branch`, `legal_entity` and `payroll_group` return false (no dimension column).
- **Not observed wired** into the attendance/leave RLS, which uses the `*_visible_employee_ids` helpers instead.

## A19. Docs summary

**`docs/hr-portal/v1-plan.md`**
- Invite patches (four):
  - seed the per-org employee role (only 1 of 40 orgs had one);
  - `COALESCE` the role on accept;
  - store `token_hash`;
  - gate invites on `hrms.portal.manage`.
- Termination hook.
- §4.6: delegation wiring.
- §6: `manager_chain` and the HR entity types. A one-level `manager_chain` policy is seeded per org. For change requests, sensitive fields add an HR level after the manager.
- §7: ten portal tabs.
- §3.8: data scopes.
- MFA and impersonation rules.
- Security requirements SR-01 to SR-20; phases P0–P9.

**`docs/hr-portal/reports/`**
- **phase-A:** attendance notes plus `get_my_attendance`.
- **phase-B:** deduction rules. Absent 1.0, late 0.5. Paid-leave order ANNUAL > CASUAL > most remaining, excluding special types. No balance → LOP. Re-approval restores the deduction. Adds the review and list RPCs.
- **phase-F** (M:20270494000000 + M:20270495000000):
  - v2 RPCs with `mine`/`all` scope.
  - The `excused` and `info_requested` decisions, plus the pay effect.
  - A sweep-guard fix; the pay-effect override applies to absent and late days only.
  - `AttendanceReviewPanel` deleted; the shared `AttendanceNoteApprovalList` is used everywhere.
  - `useHrApprovalCount`.
  - Bell routing for managers.
- **phase-5** (M:20270424000000; decision D-P5 = A): `portal_check_punch`, regularisation submit/apply, the secure-tabs flag, `hr_plus` for check-in, and the offline queue. The Track-B geofence backbone was absent at the time; it is now used by `GeoCheckInPage`.

**`/home/user/Flowza_Finance_V1/docs/hr-portal/leave-enterprise-readiness.md`** (analysis)
- Scale limits: roster pagination capped at 25; allocations capped at 500; no server-side aggregation.
- Dead tables: `leave_accrual_policies`, `leave_accrual_log`, `leave_encashments`, `holiday_calendars`/`holidays`.
- Missing features:
  - group policy assignment
  - balance ledger
  - probation gating
  - LOP
  - team calendar and concurrency limits
  - blackout periods
  - cancel after approval
  - back-dated control
  - bulk allocation
  - escalation SLA
  - reports
  - sandwich rules
  - non-calendar leave year

**`impact-map.md`**: the `modules_portal` distinction, the accept route, the admin widgets, and `role` vs `role_id`.

## A20. Portal gaps and risks (do not copy blindly)

1. Shift swap: modal orphaned, direct inserts under broad org-member RLS, no engine submission, no approve/reject UI.
2. The portal leave form has no half-day and no attachments. The balance warning is advisory; there is no server balance check. Notice and consecutive-day rules are unenforced for ordinary leave.
3. Multi-org risk: `submit_attendance_note` and `get_my_attendance` look up the employee by `user_id` with `LIMIT 1` and no org filter.
4. The portal punch queue is not keyed by org, and replays record the replay time.
5. Three check-in paths and two geofence systems coexist (`work_locations`/`attendance_policies` vs `geofences`/`evaluate_geofence`). Manchi has `enforce_geofence` on with zero fences.
6. `/hrms/self-service` is unguarded. Portal tabs ignore the `portal.*`/`ess.*` slugs. The `employee` role has zero grants; security relies on self-scoped RLS and RPCs.
7. `managerResolver` contains a hard-coded tenant override.
8. `rejectLeaveRequest` issue (see B16 #1).
9. The engine-to-leave sync trigger ignores leaves in `info_requested`.

---

# PART B: Approval engine and roles

## B1. Tables, columns and CHECKs

| Table | Columns (key) | Constraints |
|---|---|---|
| `approval_policies` | `id, organization_id, entity_type, name, is_active, created_at, updated_at` | `approval_policies_entity_type_check` (list in B2). Partial unique `approval_policies_org_entity_unique (organization_id, entity_type) WHERE is_active` (M:20260411180000). Soft delete via `delete_approval_policy`. |
| `approval_policy_levels` | `id, policy_id, level_number (default 1), approver_type (default 'reporting_manager'), approver_role_id, approver_user_id, is_parallel, approval_mode (default 'all'), required_count, min_amount, created_at` | `UNIQUE(policy_id, level_number)`. `approver_type` CHECK (`reporting_manager, role, specific_user, manager_chain`). `approval_policy_levels_mode_check`: `approval_mode IN ('all','any','quorum')` (M:20261209000000). `min_amount IS NULL OR >= 0` (M:20271880000000). The first approver is mirrored onto the level's legacy columns. |
| `approval_policy_level_approvers` | `id, level_id → approval_policy_levels ON DELETE CASCADE, approver_type (default 'specific_user'), approver_role_id → roles, approver_user_id → profiles, sort_order, created_at` | `approver_type` CHECK (same four values after M:20270420000000). |
| `approval_requests` | `id, organization_id, entity_type, entity_id, policy_id (NULL = auto-approved), requestor_id (= auth.uid() of the submitter), current_level, status, created_at, updated_at, cancelled_at, cancelled_by, cancellation_reason, is_exception, exception_by, exception_reason` | `status` CHECK (`pending, approved, rejected, cancelled, invalidated`; `invalidated` added in M:20270464000000). Partial unique `approval_requests_pending_unique (organization_id, entity_type, entity_id) WHERE status='pending'` (M:20261216000000). |
| `approval_request_levels` | `id, request_id, level_number, approver_id, delegate_id, status, comments, acted_at, created_at, approval_mode (snapshot), required_count (snapshot: NULL for all, 1 for any, N for quorum), resolution_path, resolution_reason` | `status` CHECK (`pending, approved, rejected, skipped`). **One row per resolved person per level.** `resolution_path` values: `primary, secondary, hr_admin, owner, chain_step_N, chain_top, sensitive_hr, reassigned`. |
| `approval_delegations` | `id, organization_id, delegator_id, delegate_id, entity_type (NULL = all types), start_date, end_date, is_active, created_at` | `approval_delegations_date_check (end_date >= start_date)`. |
| `approval_email_outbox` (M:20261015000200) | `id, organization_id, approval_request_id, recipient_email, recipient_user_id, email_type, entity_type, entity_id, payload jsonb, status, attempts, last_error, sent_at, created_at` | `status` CHECK (`queued, sent, failed, cancelled`); `attempts` 0..10. `email_type` CHECK (final, M:20270438000000): `approval_requested, approval_completed_generic, approval_rejected_generic, approval_completed_candidate_offer, approval_completed_onboarding_task, approval_rejected_candidate_offer, approval_rejected_onboarding_task, approval_exception_bypassed, approval_exception_notice`. Dedupe unique `(approval_request_id, email_type, recipient_email) WHERE approval_request_id IS NOT NULL` (M:20261015000300). |
| `approval_action_tokens` (M:20270770000000) | `id, organization_id, approval_request_id, approval_request_level_id (NOT NULL), recipient_user_id (nullable → redeem refuses), recipient_email, token_hash bytea, expires_at, used_at, used_action, invalidated_at, created_at` | `UNIQUE(token_hash)`; `octet_length(token_hash) = 32`; `used_action IN ('approve','reject')`; `(used_at IS NULL) = (used_action IS NULL)`. Indexed on the level, and on `expires_at` WHERE unused and not invalidated. |
| `approval_info_requests` (M:20270627000000) | `approval_request_id, level_id (SET NULL), entity_type, entity_id, asked_by, asked_to, question, answer, answered_at, answered_by, notification_id, email_queue_id, answer_notification_id, answer_email_queue_id, timestamps` | The request **stays `pending`**. |
| `approval_exception_grantees` (M:20270438000000) | Per-org users allowed to bypass | Managed via `grant_approval_exception` / `revoke_approval_exception`; permission `settings.approval_hierarchy.manage_exceptions`. |

**Write posture:** M:20261217000000 adds deny INSERT/UPDATE/DELETE policies for `authenticated` on the engine tables. **Only the SecDef RPCs write.**

**Permissions** (M:20260314113923, fix in M:20260312160542): `hrms.approvals.view`, `.manage` and `.configure`, granted to owner.

## B2. Entity types and how a type is registered

**DB CHECK** (M:20270951000000):
- HR and payroll: `contract360, leave_request, employee_change_request, letter_request, loan_application, reimbursement, attendance_regularisation, fnf, salary_revision, shift_swap, comp_off, migration_review, payroll_run, candidate_offer, employee_onboarding_task`.
- Sales: `quote, sales_order, invoice, credit_note, debit_note, proforma_invoice, payment_received, recurring_invoice`.
- Purchases: `purchase_order, bill, vendor_credit, payment_made, expense, recurring_bill, recurring_expense, purchase_requisition`.
- Other: `sales_order_additional_cost, sales_track_override, sales_track_line_override`.

**Checklist to register an HR entity type**

*SQL, all SecDef:*
1. Add the value to `approval_policies_entity_type_check`.
2. Add a branch to `approval_entity_in_org(p_entity_type, p_entity_id, p_org_id)`. It RAISEs on unknown types; this is the only piece that fails loudly.
3. Add a branch to `approval_entity_subject_employee(p_entity_type, p_entity_id)` (M:20270500000000). Current map:
   - leave_request → `leave_requests.employee_id`
   - attendance_regularisation → `attendance_regularisation_requests.employee_id`
   - letter_request → `employee_letters.employee_id`
   - employee_change_request → `employee_change_requests.employee_id`
   - loan_application → `employee_loans.employee_id`
   - reimbursement → `reimbursement_claims.employee_id`
   - fnf → `fnf_settlements.employee_id`
   - comp_off → `comp_off_credits.employee_id`
   - shift_swap → `shift_swap_requests.requestor_employee_id`
   - employee_onboarding_task → `employee_onboarding_tasks.employee_id`
   - anything else → NULL (finance)

   A non-NULL result turns on subject-first routing, subject exclusion and the last-resort caller fallback.
4. Add a mapping in `approval_entity_approve_permission(p_entity_type)` (IMMUTABLE; latest M:20270950000000). HR values:
   - leave_request → `hrms.leave.approve`
   - reimbursement → `hrms.reimbursements.approve`
   - payroll_run → `payroll.payroll_runs.approve`
   - migration_review → `payroll.migration_review.review`
   - candidate_offer → `hrms.candidates.approve`
   - employee_onboarding_task → `hrms.onboarding.verify`
   - attendance_regularisation → `hrms.attendance_regularisation.approve`
   - employee_change_request → `hrms.employee_change_request.approve`
   - letter_request → `hrms.letter_request.approve`
   - contract360 → `contracts360.approve`

   Finance values are `sales.*.approve` / `purchases.*.approve`; the sales-track types map to `sales_track.approve`.
5. Seed a default policy per org. P3 (M:20270420000000) seeded 'Manager chain (default)', one level of `manager_chain`, mode `all`, for leave_request, attendance_regularisation, employee_change_request and letter_request.
6. Add a status-sync trigger from `approval_requests` to the entity table, or an apply RPC that checks for approval. Examples: the leave sync triggers; `apply_attendance_regularisation`; `apply_change_request`.
7. Optional:
   - the deep-link resolver (M:20270627000000);
   - `cancel_approval_request` entity branches;
   - `approval_entity_base_amount` (money types only);
   - the doc-table map in `approval_action_token_summary`.

*Client (all degrade silently if missing):*
- `ApprovalEntityType` union in `src/stores/approvalStore.ts`.
- `APPROVAL_ENTITY_TYPES` and its groups ('HR & Payroll', 'Sales', 'Purchases', 'Sales Tracker') in `src/components/hrms/ApprovalPolicyEditor.tsx`.
- `src/utils/approvalEntityCategories.ts`: types absent from `FINANCE_APPROVAL_ENTITY_META` are filed as HR (`approvalCategoryOf`); `HR_ENTITY_LABEL_KEYS_FOR_TEST` (14 HR types).
- `ApprovalContextCell` contexts.
- `ApprovalsInbox.canActOnRow` (HR types fall through to `true`; the server gates) and its click-through routes.
- `APPROVAL_DOC_SOURCES` / `APPROVAL_DOC_SOURCE_EXEMPT`.
- **Trap:** a type missing from the client lists either appears under HR with Approve/Reject shown to everyone (the server still refuses), or cannot be configured at all, which means it auto-approves forever.

## B3. Policy authoring

**`save_approval_policy(p_org_id uuid, p_entity_type text, p_name text, p_levels jsonb)`** (M:20261215000001, tier patch M:20271880000000)
- Requires `settings.approval_hierarchy.manage` or the owner. **`hrms.approvals.configure` is not checked.**
- Upserts by (org, type), deletes and recreates the levels, and sets `level_number` from array order.
- `required_count`: NULL for `all`, 1 for `any`, ≥1 for `quorum`.
- Mirrors the first approver onto the level row.
- Enforces non-decreasing `min_amount`.

**Other RPCs**
- `delete_approval_policy(p_policy_id uuid)`: soft delete.
- `approval_amount_tiers_enabled` (on `organization_module_settings`, default false) and `approval_entity_base_amount(entity_type, id)` handle base-currency conversion for tiers.

**Editor: `src/components/hrms/ApprovalPolicyEditor.tsx`**
- `APPROVER_TYPES`: `manager_chain`, `reporting_manager`, `role`, `specific_user`. Resolved types show hints instead of pickers.
- Modes: all / any / quorum.
- Level draft: `approval_mode, required_count, is_parallel, approvers[], min_amount` (raw string).
- Validation:
  - at least one approver per level, with every approver complete;
  - quorum between 1 and the number of approvers;
  - tier minimums ≥ 0 and non-decreasing, **only if** `approval_amount_tiers_enabled` reads true (read directly from the column).
- With tiers off, save sends `min_amount = null`. Delete asks for confirmation.

**Pages**
- `src/pages/settings/ApprovalHierarchyTab.tsx`: all groups, plus `src/components/settings/ApprovalExceptionUsers.tsx` and `ApprovalFinanceChecksSection`.
- `src/pages/hrms/ApprovalPoliciesPage.tsx`: HR & Payroll only.

## B4. Submission algorithm: `submit_for_approval_atomic(p_org_id uuid, p_entity_type text, p_entity_id uuid, p_requestor_id uuid) RETURNS jsonb`

Latest file body: M:20270951000000. Tier logic was patched onto the live body by M:20271880000000.

1. `auth.uid()` must be set. The caller must be an **active member** and **not disabled**.
2. `approval_entity_in_org`, else raise 'Entity not found' (22023).
3. `v_subject_employee = approval_entity_subject_employee(...)`, and `v_subject_user` = that employee's `user_id`.
4. Find the active policy for (org, type). A `sales_track_line_override` with no policy of its own falls back to the `sales_track_override` policy.
5. **No active policy:** insert the request with `status 'approved'`, `policy_id NULL`, and log `auto_approved:true`. Return `{success, request_id, auto_approved:true}`. Leave's AFTER INSERT sync trigger then approves the leave.
6. A policy with 0 levels raises 'Approval policy has no levels configured'.
7. **Tiers** (flag on): only levels with `level_number <= v_max_level` apply, i.e. those whose `min_amount <=` the base amount (the levels form a prefix). If the amount is below every threshold, insert an **approved** request (`below_threshold:true`). A NULL base amount means tiers do not apply.
8. Insert the `pending` request with `current_level = 1`.
9. **Resolve candidates per level** (distinct users):
   - `specific_user` → `approver_user_id`.
   - `role` → active `organization_members` with that `role_id`.
   - `reporting_manager` → the `manager_id` user of the **subject** employee, or of the caller's employee row when there is no subject. No secondary manager, no absence check, no backstop.
   - `manager_chain` → `resolve_hr_approver_at(subject_or_caller_employee, pl.level_number).approver_user_id` (B5).
   - **Absolute exclusion:** the subject user is never an approver.
   - **Caller exclusion with last resort** (M:20270535000000): drop the caller's row unless the level resolved to nobody else **and** the request has a subject employee (HR types). In that case the caller's row survives.
10. **Delegation stamping:** for each resolved approver, take the first active `approval_delegations` row where `delegator_id = approver`, `CURRENT_DATE` is between the start and end dates, and `entity_type IS NULL OR = p_entity_type`. Type-specific rows are preferred, then the newest. Stamp it as `delegate_id`.
11. Snapshot `approval_mode` and `required_count` onto each level row, and stamp `resolution_path` / `resolution_reason` for `manager_chain` levels.
12. Errors:
    - Fewer distinct resolved levels than policy levels → 'Approval policy has a level with no eligible approver' (22023).
    - Quorum rows fewer than `required_count` → 'Approval policy quorum exceeds the eligible approvers' (22023).
13. `current_level` = the lowest resolved level.
14. Insert `approval_email_outbox` rows (`approval_requested`) for every pending approver at the first level. Delegates are **not** emailed here.
15. Log `caller_is_approver_levels`.
16. A `unique_violation` (duplicate pending) returns `{success:false, error:'This document already has a pending approval request'}`.

**`submit_for_approval_exception(p_org_id uuid, p_entity_type text, p_entity_id uuid, p_requestor_id uuid, p_reason text)`** (M:20270438000000, level-aware in M:20270897000000)
- The caller must pass `user_can_approval_exception(p_org_id, p_user_id)`, and a reason is required.
- Creates an **approved** request with `is_exception`, `exception_by` and `exception_reason`.
- The would-be approvers are recorded as `skipped` and notified (`approval_exception_bypassed` / `approval_exception_notice`).

**Client: `approvalStore.submitForApproval`** (single-flight)
- Chooses the exception path when requested.
- Re-reads the status to report `autoApproved`.

## B5. Manager-chain resolvers (M:20270420000000, M:20270897000000)

**`hr_approver_absent(p_employee_id) RETURNS boolean`** (SQL, STABLE, SecDef). True when either holds:
- the employee has **no active org membership** (joined via `user_id`);
- the employee has an **approved leave covering CURRENT_DATE**.

It is evaluated only at submit time.

**`resolve_hr_approver(p_employee_id, OUT approver_user_id, OUT path, OUT reason)`**
- The ladder, in order:
  - primary `manager_id` (linked user and not absent) → path `primary`;
  - else `secondary_manager_id` (same test) → `secondary`;
  - else the HR admin (`organization_members.is_hr_user`) → `hr_admin`;
  - else the org owner → `owner`.
- Never NULL for an org that has an owner.

**`resolve_hr_approver_at(p_employee_id, p_steps, OUT approver_user_id, OUT path, OUT reason)`**
- Service-role only.
- Step ≤ 1 is identical to `resolve_hr_approver`.
- Otherwise it walks up one rung per level, each rung choosing the primary (if present, linked and not absent) or else the secondary. It is cycle-guarded and capped at 10 rungs.
- Returns `chain_step_N` when N rungs are reached.
- Returns `chain_top` (the most senior reachable manager) when the chain is shorter than the level.
- Falls back to `resolve_hr_approver` when no usable manager exists.

**Reassign:** `reassign_hr_approval(p_request_id uuid, p_level_id uuid, p_new_approver uuid, p_reason text DEFAULT NULL)`
- Allowed for the owner or an `is_hr_user`.
- Sets path `reassigned`.

**Change requests**
- `submit_change_request(p_org_id, p_employee_id, p_items jsonb, p_attachments jsonb DEFAULT NULL)`: if any item is sensitive per `hr_field_is_sensitive`, it appends a **level-2 HR-admin row** with path `sensitive_hr`.
- `apply_change_request(p_request_id)` applies the change.
- `employee_change_requests.status` CHECK: `draft, pending, approved, rejected, applied, cancelled`.

## B6. Deciding: `approve_approval_level` / `reject_approval_level`

Signature for both: `(p_request_id uuid, p_level_id uuid, p_approver_id uuid, p_comments text DEFAULT NULL) RETURNS jsonb`. Latest bodies are in M:20271910000000.

**Common guard sequence**
1. `auth.uid()` must be set (else 'Authentication required').
2. A `p_approver_id` that differs from `auth.uid()` raises 'Access denied' (42501).
3. `SELECT … FOR UPDATE` on the request serialises concurrent decisions ('Entity not found').
4. The caller must be an active member and not disabled.
5. The level row must belong to the request ('Approval row not found').
6. **Authorisation.** The caller must satisfy at least one of the following, with each comparison NULL-safe:
   - `approver_id = caller`
   - `delegate_id = caller`
   - holds `approval_entity_approve_permission(type)` (so any holder of, for example, `hrms.leave.approve` can decide **any** leave request)
   - is the org owner
7. **Segregation of duties.** `v_subject = approval_request_subject_user(entity_type, entity_id, requestor_id)`:
   - Leave resolves to the employee's login. It is NULL when the employee has no login, and it fails closed to the filer when the row is missing.
   - Every other type resolves to the requestor.
   - Subject = caller raises **'Self-approval is not permitted'** (42501), unless the caller is the org owner (then `self_approval_owner_bypass` is logged).
8. No-ops that return success with `noop`:
   - the request is not pending;
   - the row is not pending;
   - the row is not at `current_level`.

**Approve**
- Finance checks, for `bill`, `expense` and `purchase_order` only:
  - Controlled by `organization_module_settings.approval_checks_enabled` (default on).
  - `approval_blocking_failures()` finds blocking failures; the approval is refused unless the caller holds `finance.approval_checks.override`.
  - An override requires a reason (22023).
- The approver's row is set to `approved` with `comments` and `acted_at`.
- `required`: `all` = every row at the level; `any` = 1; `quorum` = `GREATEST(required_count, 1)`.
- If `approved ≥ required`:
  - the other pending rows at the level become `skipped`;
  - `v_next` = the lowest pending level above the current one;
  - if there is a next level, set `current_level = v_next` and queue `approval_requested` emails for it;
  - otherwise set the request to **`approved`**, which fires the entity sync triggers.
- Logs `approved_count, required, level_satisfied, terminal, next_level, subject_user_id, finance_check_*`.

**Reject**
- The row is set to `rejected`.
- `all` → terminal.
- `any` / `quorum` → terminal only when `approved + pending < required`. Otherwise it logs "rejection recorded (level still satisfiable)" and returns `terminal:false`.
- When terminal: the request becomes `rejected` and all pending rows become `skipped`.
- **No server-side reason requirement**; the client requires one.

## B7. Cancel, info requests and exceptions

**`cancel_approval_request(p_request_id uuid, p_reason text DEFAULT NULL)`** (M:20270675000000)
- The requestor may cancel. Otherwise:
  - `candidate_offer` → `hrms.candidates.approve`
  - `employee_onboarding_task` → `hrms.onboarding.verify`
  - `employee_change_request` → `hrms.employee_change_request.reject`
- Sets status `cancelled` plus `cancelled_at`, `cancelled_by` and `cancellation_reason`.
- Pending levels become `skipped`, and entity-specific reverts run.

**Info requests**
- `approval_request_more_info(p_request_id uuid, p_comment text, p_level_id uuid DEFAULT NULL, p_document_label text DEFAULT NULL)`.
- `answer_approval_info_request(p_info_request_id uuid, p_answer text, p_document_label text DEFAULT NULL)`.
- Both sides get an in-app notification with a deep link plus an email via `email_queue`, with `to_user_id` NULL to avoid a duplicate notification. The notification opt-out is honoured.
- **Leave is special:** the inbox and portal call `leave_request_ask_info`, which flips the **leave row** to `info_requested`. The engine request stays pending.

**Exceptions**
- `grant_approval_exception(p_org_id, p_user_id, p_reason DEFAULT NULL)`
- `revoke_approval_exception(p_org_id, p_user_id)`
- `user_can_approval_exception(p_org_id, p_user_id)`

## B8. Invalidation and document death

**`invalidate_entity_approval_on_change()`** (latest M:20270405000000; trigger argument = entity type)
- On a material UPDATE (bookkeeping-only columns are ignored), every `pending` **or `approved`** request for the entity becomes `invalidated`, and its pending levels become `skipped`.
- Logs `approval_invalidated` when `auth.uid()` is set.
- Attached to:
  - leave (AFTER UPDATE of content columns while undecided);
  - many finance tables;
  - `purchase_orders`, `quotes`, `sales_orders`, `proforma_invoices` and `debit_notes` (these five compare **amounts directionally**, M:20271900000000).

**`approval_requests_cancel_on_document_death()`** (M:20270945000000)
- Triggers `trg_<table>_cancel_pending_approvals`, AFTER UPDATE OF `deleted_at`, `status`, on 13 finance tables plus `recurring_profiles`, and on leave (M:20272122000000).
- Soft delete, or a status of `void`/`cancelled`, sets every pending request for the entity to `cancelled` with the `cancel_approval_request` shape.
- Matches on `(organization_id, entity_id)`.

## B9. Delegation

- `create_approval_delegation(p_org_id uuid, p_delegate_id uuid, p_start_date date, p_end_date date, p_entity_type text DEFAULT NULL)`: the delegator is always the caller. The delegate must be an active member and not the caller. Dates are validated.
- `revoke_approval_delegation(p_delegation_id uuid)`.
- **Delegation is applied only at submit time**, by stamping `delegate_id`. Requests already in flight are not re-routed.
- Both the delegate and the original approver can act.
- **No UI exists for engine delegations.** Store actions exist (`src/stores/approvalStore.ts` fetch/create/revoke; `src/stores/approvalDelegationStore.ts`, registered only in `resetStores`) but no component mounts them. `ExpenseClaimListPage` uses a separate expense-claim delegation system.

## B10. Reminders and escalation

**`run_pending_approval_reminders()`** (M:20261231000003)
- Cron `pending-approval-reminders-daily`, `0 7 * * *`.
- Covers **finance documents in `pending_approval` only**.
- Columns `approval_reminder_date` and `approval_reminder_sent_at`.
- Sends notifications of type `approval_pending`, falling back to holders of the approve permission.
- Stamps via `stamp_financial_document_reminder_sent` (service-only).

**Not built:** HR SLA timers, escalation to the next manager, or re-checking absence after submit. The manual workaround is `reassign_hr_approval`.

## B11. Notifications, emails and one-click email actions

**Outbox**
- The Edge Function `/home/user/Flowza_Finance_V1/supabase/functions/process-approval-emails/index.ts` drains `approval_email_outbox` via cron every 2 minutes.
- Subjects include "Approval requested" and "Your approval request was approved".
- For `approval_requested` rows it mints an action token for the **active level only**.

**Action tokens** (M:20270770000000)
- Minting: `issue_approval_action_token(p_approval_request_id, p_recipient_email, p_recipient_user_id, p_token, p_ttl_days DEFAULT 7)`.
- Token properties:
  - 256-bit CSPRNG, base64url;
  - only its sha256 is stored;
  - single-use under `FOR UPDATE`.
- Invalidation triggers: `trg_approval_levels_invalidate_tokens` and `trg_approval_requests_invalidate_tokens`, which fire on level or request status changes.
- Summary: `approval_action_token_summary(p_token)`. Invalid, expired, used and invalidated tokens all return the same `{valid:false}`.
- Decision: `redeem_approval_action_token(p_token, p_action, p_comment DEFAULT NULL)`. It sets `request.jwt.claims` to the recipient, transaction-locally, then calls the **same** `approve_approval_level` / `reject_approval_level`.
- All three are service-role only.

**Email links and the action page**
- Links point at the app route `/approval-action?t=<token>&intent=approve|reject` (`src/pages/approval-action/ApprovalActionPage.tsx`, `src/App.tsx:123`).
- The page's GET is static.
- It calls the Edge Function `/home/user/Flowza_Finance_V1/supabase/functions/approval-email-action/index.ts` (`verify_jwt=false`):
  - GET returns the summary and **never mutates**.
  - Only POST decides.
  - Per-IP rate limits: GET 60, POST 20.

**In-app notifications**
- Leave: `notifyLeaveStatus` in `leaveStore`, and `leave_info_requested` (`action_url '/self-service'`).
- `attendance_note_reviewed`, `selfie_checkin_submitted`, `approval_pending` (reminders).
- Info-request notifications carry deep links.

## B12. Client engine

**`src/stores/approvalStore.ts`** (826 lines)
- Unions:
  - `ApprovalEntityType`
  - `ApprovalStatus` (`pending | approved | rejected | cancelled | invalidated`)
  - `ApprovalVisibilityScope` (`all | team | own`)
  - `ApproverType`, `ApprovalMode`
- Actions:
  - `fetchPolicies`, `savePolicy`, `deletePolicy`, `submitForApproval`
  - `fetchPendingApprovals`: a row is actionable when the level at `current_level` is pending and the user is its approver or delegate. It also computes `pendingCount`, `pendingHrCount` and `pendingFinanceCount`.
  - `fetchApprovalHistory`: statuses approved, rejected, cancelled, invalidated; last 100; participant or scope.
  - `fetchApprovalForEntity`
  - `approveLevel` / `rejectLevel` (with `mapApprovalError` and `logActivity`)
  - `cancelRequest`
  - info-request actions → `approval_request_more_info`
  - delegation and exception-grantee actions
- **Visibility scope**:
  - text role `owner` or `'admin'`, or `hrms.approvals.manage` → `all`;
  - has direct reports via `manager_id`/`secondary_manager_id` → `team`;
  - otherwise `own`.

**`src/utils/approvalErrors.ts`**
- `SAFE_PREFIXES`: 'Authentication required', 'Access denied', 'Entity not found', 'Approval row not found', 'Self-approval is not permitted', 'This document fails a finance check', 'Approving past a finance check'.
- `PGRST202` means "not deployed". Anything else maps to a generic message.

**`src/utils/approvalEntityCategories.ts`**
- `FINANCE_APPROVAL_ENTITY_META`, each entry with `approvePermission`, `routeBase` and `labelKey`, covers: quote, sales_order, invoice, credit_note, debit_note, proforma_invoice, payment_received, recurring_invoice, purchase_order, bill, vendor_credit, payment_made, expense, recurring_bill, recurring_expense, sales_track_override, sales_track_line_override.

**`src/utils/approvalLevels.ts`**: `selectActionableLevelRow`.

## B13. UI

**`src/components/approvals/ApprovalsInbox.tsx`** (1090 lines)
- Scope note at the top.
- The HR tab embeds `AttendanceNoteApprovalList`, with oversight when the user holds `hrms.attendance.manage` or `hrms.attendance_regularisation.approve`.
- Controls:
  - HR/Finance category tabs and search;
  - type chips (the selected chip stays pinned);
  - a **Pending | History** toggle;
  - History CSV export (requires `reports.export`; logged).
- Each row shows:
  - entity badge;
  - `ApprovalContextCell` or document summary;
  - amount, a view-only badge and a mode badge;
  - approver chips;
  - View / Withdraw / history-eye controls.
- Leave actions route through `leaveStore` (approve, reject, and `askLeaveInfo`).
- `SUBJECT_BEARING_ENTITY_TYPES = {'leave_request'}` drives an advisory self-approval pre-block.
- `ApprovalInsightStrip` appears for bill, expense and PO checks.
- "Already actioned" wording, for example "You rejected this — another approver can still approve it."
- History outcome badges: Approved, Rejected, **Withdrawn** (cancelled, with its reason), **Superseded** (invalidated). Each has per-level "who / status / date / comments" lines.
- `canActOnRow`:
  - candidate → `hrms.candidates.approve`
  - onboarding → `hrms.onboarding.verify`
  - sales-track overrides → assigned approver/delegate or `sales_track.approve`
  - finance → the meta `approvePermission`
  - HR types → true (the server gates)

**`src/components/hrms/ApprovalActionButtons.tsx`**
- Visible only when the level is pending and the user is its approver or delegate, or when the level has no approver.
- Approve takes an optional or required reason. Reject requires a reason. Ask-info requires a question.
- Errors keep the panel open with `role="alert"`.

**`src/components/hrms/ApprovalContextCell.tsx`**
- Variants: `stacked` / `inline`.
- Contexts:
  - `candidate_offer`
  - `employee_onboarding_task`
  - `leave_request` (employee, type, colour, dates, days)
  - `employee_change_request` (field diffs)
  - the sales-track overrides

**`AttendanceNoteApprovalList`**: see A5.

**Approvals hub** (`src/utils/approvalHubSections.ts` + `src/hooks/useApprovalHubSections.ts`)
- `APPROVAL_HUB_SECTIONS`, in order:
  - finance
  - order_insights
  - po_insights
  - management_insights
  - financial_closures
  - contracts360
  - amc360
  - **hr** (`hrms.approvals.view`)
  - bank_apply (`hrms.bank_details.manage`)
  - payroll (`hrms.reimbursements.view`, `payroll.tds_declarations.view`, `payroll.compensation.view`)
- The HR section is **also visible to anyone who has pending HR requests** (the structural-approver hatch, audit F2).
- Module gates apply, but the pending hatches stay ungated.
- Also: `APPROVAL_HUB_PERMISSIONS` and legacy `?tab` aliases.

**Badges**
- `src/hooks/useHrApprovalCount.ts` = `pendingHrCount` + attendance `pendingMineCount`.
- The portal badge is covered in A14.

## B14. Roles and permissions

**Tables**
- `roles`: `organization_id` (NULL = global template), `name, slug, description, is_system, is_system_role, is_active, restrict_to_owned_contacts, restrict_to_amount_only`.
- `permissions`: `module, sub_module, action, slug, label, description, sort_order, module_key, resource`.
- `role_permissions`: `role_id, permission_id`.
- `organization_members.role_id`.

**Resolution (baseline dump)**
- `user_has_permission(p_org_id uuid, p_slug text)` (SQL, STABLE, SecDef) follows active membership → `role_permissions` → `permissions`. **It does not filter on the role's org**, so global templates resolve everywhere.
- `get_user_permissions(p_org_id)` uses the same join.
- Also `user_is_contact_restricted(p_org_id)`, `is_org_owner` (M:20260227020000) and `get_user_org_ids()`.

**System roles:** `SYSTEM_ROLE_IDS` = owner, accountant, staff, viewer, auditor (ids `a0000000-…-0001..0005`).

**Global templates** (M:20270417000000; `organization_id IS NULL`): org_admin, hr_admin, hr_manager, payroll_admin, payroll_manager, recruiter, reporting_manager, finance_approver, approver, department_head, branch_manager, time_attendance_admin, leave_approver.

**Per-org role:** `employee`, seeded bare.

**HR-relevant grants found in migrations** (live data may differ)

| Role | Grants |
|---|---|
| owner | `hrms.approvals.{view,manage,configure}`, `hrms.portal.manage`, `hrms.shifts.{view,manage}`, all `portal.*`, `hrms.employee.{bank,identity,compensation,dependants}.view`, approve/reject/return for leave, attendance_regularisation, employee_change_request and letter_request, `hrms.attendance.view_all`, `hrms.leave.view_all`, `hrms.leave.manage` |
| accountant | `hrms.portal.manage`, `hrms.leave.manage`, `hrms.attendance.view_all`, `hrms.leave.view_all` |
| auditor | `hrms.attendance.view_all`, `hrms.leave.view_all` |
| org_admin | `portal.*`, the sensitive-field views, approve/reject/return for the four HR types, `hrms.attendance.view(+_all)`, `hrms.leave.{view,view_all,manage}`, `settings.roles.{view,manage}`, `settings.team.manage_roles` |
| hr_admin | `hrms.attendance.view(+_all)`, `hrms.leave.{view,view_all,manage,approve,reject,return}` (M:20270510000000), `settings.roles.{view,manage}`, `settings.team.manage_roles` (M:20270494000001) |
| hr_manager | `hrms.attendance.view(+_all)`, `hrms.leave.{view,view_all,manage,approve,reject,return}` |
| time_attendance_admin | `hrms.attendance.view(+_all)` |
| leave_approver | `hrms.leave.view_all` only; it notably lacks `hrms.leave.approve` |
| reporting_manager, approver, finance_approver, department_head, branch_manager, payroll_*, recruiter, staff, viewer, employee | none found |

**Where these grants come from**
- **Sensitive-field and HR decision slugs** (M:20270417000000): `hrms.employee.{bank,identity,compensation,dependants}.view`; `hrms.leave.{reject,return}`; `hrms.{attendance_regularisation,employee_change_request,letter_request}.{approve,reject,return}`.
- **Leave:** `hrms.leave.{view,view_all,manage,approve}`.
- **Attendance:** `hrms.attendance.{view,view_all,manage}`, `hrms.attendance_regularisation.approve`.
- **Settings:** `settings.approval_hierarchy.manage`, `settings.approval_hierarchy.manage_exceptions`.

**Custom roles** (M:20270494000001)
- `create_custom_role(p_org_id, p_name, p_description, p_permission_ids uuid[], p_restrict_to_owned_contacts, p_restrict_to_amount_only)`, plus `update_custom_role` / `delete_custom_role`.
- Allowed for the owner or `settings.roles.manage`.
- **Escalation guard:** a delegate can grant only what their own role holds.
- Member role edits need the owner or `settings.team.manage_roles`, and can never touch the owner.

**Client**
- **`src/stores/roleStore.ts`**
  - RPCs: `get_org_roles`, `get_user_permissions` (5-minute TTL), `get_role_with_permissions`, `get_user_contact_restriction`, `get_user_amount_restriction`, `create/update/delete_custom_role`, `planner_set_role_permissions`.
  - `can(slug)`.
  - `OrgRole` includes the restriction flags, `permission_count` and `member_count`.
- **`src/hooks/usePermission.ts`**: `can`, `canAny`, `canAll`. When impersonating or read-only, **only `.view` slugs pass**.
- **`src/components/auth/PermissionGuard.tsx`**: props `permission` / `anyOf`. Shows a spinner until initialised, then `AccessDenied` or `<Outlet/>`.
- **Roles editor**
  - `src/pages/settings/permissionMatrix.ts`: `MATRIX_ACTIONS=['view','create','edit','delete','approve']`; `unboundPermissions` feeds "More Permissions"; `inertSelections` uses `ROUTE_PREREQUISITES`; `EDIT_POSTED_SLUG`.
  - `src/modules/consume/mergePermissions.ts` `bucketModule`: the row is the full sub-module path, and the action is the last slug segment. A slug whose last segment is not a matrix action lands only in "More Permissions".
  - `src/pages/settings/CustomRoleForm.tsx`: the matrix, a FULL row toggle, the More Permissions popup, the two restriction toggles, a prerequisite banner, and cloning.
  - `src/pages/settings/RolesPermissionsTab.tsx`: system vs custom roles, a read-only matrix, clone, delete (custom only). `canManage = settings.roles.manage`.

## B15. Manager semantics: several definitions coexist

1. **RLS visibility and update** (attendance/leave helpers and `leave_requests.update_approvers`): the caller's employee is the target's `manager_id` **or** `secondary_manager_id`. Direct only, not transitive.
2. **Attendance-note review, leave ask-info and leave comments:** the primary or secondary manager.
3. **Selfie grants, notifications and review:** the manager.
4. **Engine `reporting_manager`:** the subject's `manager_id` user only. No secondary, no absence check, no backstop, so it can fail with 22023.
5. **Engine `manager_chain`:** primary → secondary → HR admin (`is_hr_user`) → owner. Level N = N rungs up. Absence (inactive membership or approved leave today) is evaluated at submit.
6. **Transitive "all reports":** `employee_manager_closure`, built on `manager_id` only.
7. **Client inbox scope `team`:** having any direct report (primary or secondary). You see the team's requests but can act only where assigned.
8. **Portal `TeamSidebar`:** `manager_id` = me (primary only), falling back to department colleagues.
9. **The `reporting_manager` role template grants nothing.** Managerhood is structural (`employees.manager_id`), not a role.
10. **Approvals hub HR section:** also reachable by structural approvers who hold pending HR requests without `hrms.approvals.view`. The bell routes line managers to the portal Approvals tab.
11. **Approve-permission holders** (for example `hrms.leave.approve`) can decide any request of that type, even when not named.

## B16. Engine gaps and risks

1. `leaveStore.rejectLeaveRequest` **always** writes the leave row as `rejected` with its reason, even when a non-terminal any/quorum rejection leaves the engine request open.
2. `fetchPendingApprovals` checks the text role `'admin'`, but the template slug is `org_admin`.
3. `hrms.approvals.configure` is seeded but unused. Policy save requires `settings.approval_hierarchy.manage` or the owner.
4. Delegation: submit-time only, and no UI.
5. HR has no escalation or SLA. Reminders cover finance only.
6. `approval_requests` has no `info_requested` status. For leave, the info loop lives on the leave row, and the engine-to-leave sync ignores leaves that are not `pending`.
7. `shift_swap` is registered but never submitted.
8. The `employee` role and most templates carry no grants.
9. Entity-registration drift degrades silently on the client.
10. Resolution is snapshotted at submit. Later changes to the manager do not re-route the request; the only remedy is `reassign_hr_approval`.
11. `verifyLeaveRequest` is not wired.

---

# Feature checklist (acceptance, one behaviour per line)

**Portal shell and access**
1. A user whose membership text role is `employee` lands in the Employee Portal shell; other roles get the full app.
2. `?portal=1` forces the portal shell for the tab (sessionStorage `flowza_portal_mode`); sign-out and "Exit" clear it.
3. "Exit to Finance" appears only when the user also has a non-employee membership in the same org.
4. The root route redirects portal users to `/hrms/self-service`.
5. The portal shell shows the offline banner, the idle-timeout warning, and enforces the absolute timeout.
6. The employee record resolves by (org, `user_id`) and excludes `status='merged'`.
7. An unlinked user triggers one self-heal attempt, then sees the `notLinked` banner with only the Signature tab.
8. Portal disabled with a pending invite triggers one self-heal attempt, then the `portalPending` banner. A revoked invite shows `portalRevoked`.
9. Tabs render in order: dashboard, check-in, profile (completion %), signature, documents, leave, approvals (count badge), shift, payslips, attendance, other.
10. Secure blocks render only when the secure-tabs flag is on AND the org is entitled to `portal`; `hr_plus` gates the punch card.

**Attendance**
11. Calendar colours: present emerald; late, half day or missing check-out amber; absent red; on leave sky; weekend or holiday slate-200; no record slate-100; future outlined.
12. Period pills 7/30/90/365 (default 30); month grids 1/2/3/12; a 5-entry legend.
13. Attendance % = (present + late + 0.5 × half_day) / working days (excluding weekends and holidays), 1 decimal.
14. Average hours per day ignores days with zero hours.
15. Hints appear for attendance <90%, average <8 h, late days, absent days, missing check-outs.
16. Punctuality uses start 09:00 and grace 15 minutes; delay totals count only minutes beyond grace.
17. The day-detail panel shows in, out, hours and status, plus "Add a reason".
18. An employee can submit a reason for a date with one of six categories; editing a non-rejected note resets it to pending.
19. Only one active (non-rejected) note may exist per employee per date.
20. Note pills: pending amber, approved emerald, rejected red, excused teal, info requested indigo.
21. A reviewer can Approve, Excuse, Ask info (message required) or Reject (pay effect 0/0.5/1 required).
22. Nobody can review their own note. Reviewers are HR (`attendance.manage` or `regularisation.approve`) or the primary or secondary manager.
23. Rejection deducts absent 1.0 or late 0.5 (or the override) from paid leave in the order ANNUAL > CASUAL > most remaining, excluding special types; with no balance the day is loss of pay.
24. Approving or excusing after a deduction restores the balance and clears loss of pay.
25. The nightly sweep auto-deducts unexcused absent, late or incomplete days after N grace days (default 3) when the policy enables it, writing a system note.
26. A reviewed note notifies the employee with a link to the portal.
27. Regularisation request fields: date, type (missed punch, wrong punch, WFH unmarked, system downtime), expected in/out, reason. It is created pending and routed to the engine.
28. An approved regularisation is applied exactly once and upserts the attendance record with source `regularisation`.

**Check-in**
29. A server-time punch rejects a duplicate check-in or check-out, a check-out without a check-in, and channels disabled by policy.
30. Offline punches queue locally and replay on the next load; duplicate-punch responses count as success.
31. Geo check-in previews a verdict (allowed, flagged, logged, denied or no zone) with the nearest zone and distance, and warns when accuracy is worse than 50 m.
32. Confirm is disabled on a denied verdict; mock location shows a dedicated message.
33. Geo punches that fail in transport or while offline are queued per org, replayed with their original timestamps, and deduplicated server-side; "Sync now" and "Discard" are available.
34. Fence evaluation: priority employee > team > site > org; time windows; accuracy threshold; circle or polygon with grace; Wi-Fi/IP co-validation; hard block, soft warn or advisory log; worst verdict wins; no fence means allowed.
35. Denied punches are not stored but are logged as rejected.
36. `within_geofence` is true only inside a fence, false only when a real fence failed, and null otherwise.
37. Selfie check-in appears only for employees with an active open-attendance grant.
38. Selfie flow: live camera and precise location → upload to a private own-folder bucket → optional one-time face-match result → manager notified → manager approval creates the attendance record.

**Shifts**
39. The Shift tab shows the current assignment (effective window), start, end, break, grace, effective dates, available shifts with weekly offs, and history. It is read-only.
40. A shift swap requires a target and a date; both people must have shifts that day, and the shifts must differ.

**Leave**
41. The portal lists leave types that are active, portal-visible (true, false, or automatic for annual/earned/privilege/comp-off/sick), and applicable by employee type and gender. Comp-off is excluded from the ordinary form.
42. Per-type balance: entitled = allocation (or type default) + unexpired carry-forward; taken = used + approved; pending includes info_requested; available = entitled − taken; accrued to date is shown.
43. Five totals tiles show entitlement, used, pending, remaining and accrued.
44. Day count follows the org mode: calendar (inclusive) or business days (org working weekdays, default Mon–Fri).
45. The apply form takes type, from, to (≥ from) and an optional reason, and previews days and the balance after the request.
46. A request exceeding the balance shows a warning but is not blocked.
47. Overlap with the employee's own pending or approved leave is blocked client-side and by a database exclusion constraint.
48. The server recomputes `days` and rejects an end date before the start date.
49. Submitting routes the request to the approval engine; with no active policy it is auto-approved immediately.
50. With no reporting manager, the error reads "Ask HR to set your reporting manager".
51. The employee can edit their own pending or info-requested leave; editing re-checks overlap, voids the prior approval and resubmits.
52. The employee can withdraw pending or info-requested leave; the status becomes cancelled and the pending approval is cancelled.
53. Once decided, only a `hrms.leave.manage` holder can edit, and the change is logged as a correction.
54. Leave in a payroll-covered period is locked except for `manage` holders.
55. Status badges: approved emerald, rejected red, pending amber, cancelled slate, info requested indigo; the rejection reason is shown.
56. A request timeline shows submitted, approved, rejected, info requested, cancelled and skipped events with notes.
57. An approver's "Ask more info" (question required) moves leave to info requested; the employee replies (optional comment) and resubmits to pending.
58. The leave comment thread is append-only; the requester, managers, approvers and HR can read and post within their rules; each message shows author and timestamp.
59. A comp-off credit request needs earned date ≤ today, a worked-on type, hours 0–24 in half-hour steps, location (≤200) and summary (≤1000), with a day preview from org thresholds.
60. Comp-off redemption allows a half day only on a single date, may not exceed the balance or the consecutive-day cap, and consumes credits by earliest expiry.

**Team and manager in the portal**
61. The team rail lists direct reports (or department colleagues), searchable when there are more than 5, with On leave / In presence.
62. The team upcoming-leaves card lists approved or pending leave ending today or later (up to 20) and hides when empty.
63. The Approvals tab badge = my current-level pending leave approvals (as approver or delegate) + my pending attendance notes; each half fails to 0.
64. The Approvals tab shows attendance notes and my assigned leave; "All" adds up to 50 recent direct-report requests as view-only.
65. Approve, Deny (reason required) and Ask info (question required) are available only on rows assigned to me and pending.
66. A line manager without the approvals-hub permission is routed from the notification bell to the portal Approvals tab.

**Portal invites**
67. Only `hrms.portal.manage` holders can invite, resend or revoke portal access.
68. An invite goes to the work email (else the personal email), revokes older pending invites, stores only a token hash, and expires in 7 days.
69. Resending to an already-linked employee restores access directly.
70. Validation returns the employee and org names and the expiry, and reports accepted, revoked or expired tokens.
71. Accept requires the signed-in user's email to match the invite and the token to be unexpired; it links the login, enables the portal and marks the invite accepted.
72. Accept preserves an existing membership role and role_id, defaulting to the per-org `employee` role, and releases stale links.
73. Every org gets an `employee` system role automatically on creation.
74. Revoking the portal disables it without unlinking the login.
75. Terminating or offboarding an employee automatically revokes portal access and deactivates the employee-role membership.
76. The portal self-heals by reactivating a user who holds a pending or expired invite with a confirmed email.

**Security model**
77. Attendance records are visible to the employee, their primary or secondary manager, view_all holders and super admins; employees can insert only their own; only `manage` can update or delete.
78. Leave requests are visible to the employee, managers, view_all or manage holders, and named approvers or delegates.
79. Employees can update their own leave only while undecided and only to pending, info requested or cancelled.
80. Attendance notes are read-only to clients and written only through RPCs.

**Approval engine**
81. Each org has at most one active approval policy per entity type.
82. A policy has ordered levels. Each level has one or more approvers (specific user, role, reporting manager, manager chain) and a mode: all, any, or quorum (1..number of approvers).
83. Saving a policy validates approver completeness, the quorum range and non-decreasing tier minimums, and requires the approval-hierarchy permission or owner; delete is a soft delete.
84. Submitting with no active policy records an auto-approved request.
85. Submission fails when the policy has no levels, a level resolves to nobody, or a quorum exceeds the resolvable approvers.
86. A document can have only one pending request; a duplicate submission gets a clear message.
87. The subject employee is never an approver; the submitter is excluded unless they are the only resolvable HR approver.
88. `manager_chain` level N resolves N managers up, skipping absent or unlinked managers via the secondary manager, then falls back to HR admin and then the owner.
89. An active delegation (date window; type-specific preferred) stamps a delegate who can act alongside the approver.
90. Approvers at the first level, and at each newly active level, receive an "approval requested" email.
91. Only the assigned approver or delegate, an approve-permission holder, or the owner can decide; disabled users cannot.
92. Deciding a request about oneself is refused, except for the org owner (logged).
93. A level is satisfied when all approve (all), any one approves (any), or N approve (quorum); remaining pending rows are skipped, and the request advances or completes.
94. A rejection is terminal in `all` mode, or when the level can no longer reach the required approvals.
95. Acting on a non-current level or an already-decided row is a harmless no-op.
96. A material edit to a submitted document voids its pending or approved request, which must be resubmitted.
97. Deleting, voiding or cancelling a document cancels its pending approval requests.
98. The requestor, or the entity-specific permission holder, can withdraw a request with a reason.
99. Granted users can bypass approval with a mandatory reason; the request is approved as an exception and the approvers are notified.
100. Approvers can ask the submitter for more information; the request stays pending and both sides are notified in-app and by email.
101. Email Approve/Reject links are single-use, hashed, expire in 7 days, never act on page load, and decide as the recipient through the same RPCs.
102. Finance documents pending approval generate daily 07:00 UTC reminder notifications.
103. When amount tiers are enabled, only levels whose base-currency minimum is met apply, and amounts below every threshold are auto-approved.
104. The owner or an HR user can reassign an HR approval level to another person, recorded as `reassigned`.
105. The approvals inbox offers HR/Finance tabs, search, type chips, Pending/History and a permission-gated History CSV export; History shows Approved, Rejected, Withdrawn and Superseded with per-level audit lines.

**Roles**
106. Permissions resolve from the membership's `role_id`; global system templates apply in every org.
107. Custom roles can be created or edited by the owner or `settings.roles.manage` holders, who cannot grant beyond their own permissions; the owner's membership cannot be changed.
108. While impersonating or in read-only mode, only `.view` permissions pass on the client.
109. Guarded routes show a loader until permissions load, then Access Denied when the permission is missing.
