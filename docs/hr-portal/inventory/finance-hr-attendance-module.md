# Flowza Finance: HR Attendance module feature inventory (for re-implementation)

**Scope.** This covers the HR and manager side of attendance in `/home/user/Flowza_Finance_V1`. The stack is a React 19 SPA with Zustand 5 stores and Supabase (Postgres RLS, SECURITY DEFINER RPCs, Deno Edge Functions, Storage, pg_cron).

**How this was produced.** A read-only survey on 2026-09-27; nothing was modified. For each DB object, the facts come from the **newest migration file that defines it**. I did not query production. CLAUDE.md records several cases where live function bodies drifted from the files, so re-read the live DB before copying any SQL.

**Shorthand used below:**
- **view** = `hrms.attendance.view`, **view_all** = `hrms.attendance.view_all`, **manage** = `hrms.attendance.manage`.
- **Mapped manager** = the caller's own `employees` row is the subject's `manager_id` (primary) or `secondary_manager_id`.

---

## 0. Architecture in one screen

```
PUNCH SOURCES                                   RECORD OF TRUTH                         READ / EXCEPTION FLOW
ZKTeco ADMS ----> attendance-adms  --+
Hikvision/Dahua -> attendance-push --+-> ingest_punch() -> punch_events --(stmt triggers)--+
LAN agent/REST --> attendance-ingest-+   dedup, PIN->employee,     + process_punches()      |
Manual file import (advanced import)-+   geofence verdict                                   v
Geo web/mobile -> workforce-checkin -> checkin_punch() -> evaluate_geofence -> ingest_punch  recompute_attendance_day()
Employee portal button -> portal_check_punch() -> punch_events + recompute                  |
                                                                                             v
HR Add/Edit/Bulk (AttendancePage) ---------+                                   attendance_records (1 row/employee/day)
Legacy attendance-checkin fn (web/mobile) -+-> attendance_records <- BEFORE trg _attendance_apply_policy
Regularisation apply / client bulk approve-+       (classify_attendance_day; skips device_punch rows)
Selfie approval (review_selfie_checkin) ---+
Legacy biometric-punch-ingest ------------> attendance_records directly (+ biometric_punch_events)

Read:       get_attendance_register (stored + derived absent/on_leave/holiday), get_attendance_daily_summary,
            get_my_attendance
Exceptions: attendance_notes -> review_attendance_note_v2 -> leave_allocations.used_days or loss_of_pay
            -> get_payroll_attendance_summary -> payroll SYS_LOP line
Cron:       attendance-unexcused-sweep '30 2 * * *' (opt-in), attendance-report-schedules-daily '15 6 * * *'
```

**Core invariants:**
- **One row per day.** `attendance_records` has UNIQUE(employee_id, attendance_date).
- **`punch_events` is the single source of truth** for device, portal and geo punches (migrations 20270565000000 and 20270601000000). Its behaviour:
  - It never overwrites a row whose `check_in_source` or `check_out_source` is `manual`.
  - It keeps `status` when `status_source = 'manual'`.
- **Classification runs server-side:**
  - `classify_attendance_day`, via the trigger, for non-device rows.
  - An inline ladder inside `recompute_attendance_day` for device rows.
  - It is mirrored in TypeScript only for form preview (`/home/user/Flowza_Finance_V1/src/utils/attendanceClassification.ts`).
- **Licensing:**
  - Base tier ("HR Mini"): attendance, summary, regularisation, holidays, comp-off.
  - HR Plus (`ModulePlusGuard tier="hr_plus"`, sidebar `requiresPlus: 'hr_plus'`): shifts, workforce, workforce-config/devices, geofences, check-in, geo-check-in.

---

## 1. HR / manager pages

### 1.0 Routes, guards, navigation

Sources: `/home/user/Flowza_Finance_V1/src/App.tsx` lines 733-901 and `/home/user/Flowza_Finance_V1/src/components/layout/Sidebar.tsx` lines 355-392.

| Route | Page | Route guard | Tier |
|---|---|---|---|
| `hrms/attendance` | AttendancePage | view | base |
| `hrms/attendance-summary` | AttendanceSummaryPage | view | base |
| `hrms/attendance-regularisation` | AttendanceRegularisationPage | `hrms.attendance_regularisation.view` | base |
| `hrms/holidays` | HolidayCalendarPage | `hrms.holidays.view` | base |
| `hrms/shifts`, `hrms/shifts/calendar` | ShiftListPage, ShiftCalendarPage | `hrms.shifts.view` | hr_plus |
| `hrms/shifts/new`, `hrms/shifts/:id/edit` | ShiftFormPage | `hrms.shifts.manage` | hr_plus |
| `hrms/workforce` | WorkforcePage | `hrms.workforce.view` | hr_plus |
| `hrms/workforce-config`, `hrms/geofences` | WorkforceConfigPage, GeofencesPage | `hrms.workforce_devices.view` | hr_plus |
| `hrms/check-in`, `hrms/geo-check-in` | CheckInPage, GeoCheckInPage (employee self check-in) | `ess.attendance.checkin` | hr_plus |
| `hrms/pending-approvals` | redirect to `/approvals?section=hr` | - | - |
| `hrms/comp-off` | CompOffPage (not inventoried) | `hrms.comp_off.view` | base |
| `hrms/self-service` | SelfServicePage (employee portal: own attendance, reasons, selfie) | none | base |

**Badges.**
- The HR approvals badge (`useHrApprovalCount`) sums approval-engine requests and pending attendance notes (`attendanceNoteApprovalStore.pendingMineCount`).
- The Sidebar loads that count for every signed-in user, because any mapped manager may have a queue.
- The notification-bell HR row routes to `/hrms/self-service` for users whose HR count is only attendance notes and who lack `hrms.approvals.view`.

### 1.1 Attendance register: `/home/user/Flowza_Finance_V1/src/pages/hrms/AttendancePage.tsx`

**Panels at the top:**
- `SelfieCheckinReviewPanel`: always mounted; hides itself when empty.
- `OpenAttendanceGrantsPanel`: manage only.
- `AttendanceCommentsPanel`: always mounted; hides when empty.
- Note reviews are not on this page any more (the Phase F migration deleted `AttendanceReviewPanel`). They live in the Approvals surfaces.

**"Today" cards:** Present, Absent, Late, Half Day, On Leave, from RPC `get_attendance_daily_summary(p_org_id, p_date = today)`.

**Toolbar and filters:**
- View toggle: Table / Calendar.
- From / To dates (table view only). Default is the current month.
- Employee select (active employees).
- Client-side name search.
- Status chips with live counts: all, present, absent, late, half_day, on_leave, incomplete, holiday_work, weekly_off_work.
- Buttons:
  - **Sync**, Excel, PDF and CSV **Export**: ungated, so available to anyone with view.
  - **Share**: manage only.
  - **Add Record**: manage only, in the header.
- Record count.

**Load sequence** (on mount and on range or employee change; Sync repeats it, with toasts `page.synced` / `page.syncFailed`):
1. `process_punches(p_org, p_from, p_to)`. This RPC is manage-only, so it fails for view-only users.
2. `fetchAttendance`: `attendance_records` with an employee embed, limit 1000, ordered by date descending.
3. `fetchDerivedRegister`: `get_attendance_register(...)`. It keeps only derived `absent` and `on_leave` rows and drops derived `holiday` rows. Derived rows get the synthetic id `derived:{employee_id}:{date}` and `is_derived = true`.

The page also loads the org's **default** holiday-calendar dates so the preview can tell Holiday Work from Weekly Off Work.

**Table columns:**

| Column | Content / behaviour |
|---|---|
| checkbox | Manage only; stored rows only (not derived). |
| Employee | Initials avatar, full name, `employee_number`. |
| Date | `attendance_date`. |
| Check In / Check Out | Times. |
| Hours | `formatDurationHM(work_hours)`. Red and blinking when `work_hours < 8` (hard-coded 8). Overtime suffix when `overtime_hours > 0`. A "View punches" toggle expands a timeline of `punch_events` chips (time, `punch_state`, source; the first punch is emerald). |
| Status | Coloured chip, plus a "Derived" badge for synthetic rows, plus a zone badge ("In zone" emerald / "Out of zone" amber) shown only when `within_geofence` is not null. |
| Notes | Clamped to 2 lines. |
| Edit | Pencil icon; manage only; stored rows only. |

**Status colours:**

| Status | Colour |
|---|---|
| present | emerald |
| absent | red |
| late | amber |
| half_day | blue |
| on_leave | slate |
| incomplete | orange |
| holiday_work | violet |
| weekly_off_work | indigo |
| anything else (`holiday`, `weekend`) | gray |

Label keys: `hrmsAttendance.attendance.statusLabels.{present,absent,late,halfDay,onLeave,incomplete,weekend,holiday,holidayWork,weeklyOffWork}`.

**Bulk action (manage).**
- When rows are selected, a bar shows "N selected", a "Set status" select and Apply.
- Apply calls `updateRecord({status, status_source: 'manual'})` sequentially per row, then toasts `bulkUpdated`.

**Calendar view.**
- Month navigation.
- Each day shows up to 3 records (coloured dot plus first name), then "+N more".
- Today is highlighted; a legend is shown.
- Clicking a record opens Edit, for manage users and non-derived rows only.

**Edit modal** (stored rows):
- Check In / Check Out (time inputs).
- Auto-hours hint, or red `errors.checkoutBeforeCheckin`.
- Hours Worked: number, min 0, step 0.5; blank means auto from the preview.
- Overtime Hours.
- Status select with a StatusHint:
  - `autoStatusHint`, or `manualStatusHint` plus a "Use auto status" link.
  - The hint is hidden when the rules engine is off.
- Notes.

The Status dropdown follows the live classifier preview until the user touches it; touching it saves `status_source = 'manual'`. A blocked preview shows `errors.nonWorkingDay` or `errors.checkoutBeforeCheckin`.

**Add modal:**
- Employee\* (`errors.selectEmployee`), Date\* (`errors.selectDate`), check in/out, calculated hours, Status plus hint, Notes.
- Times are combined into timestamps with `combineDateTime`, which uses **browser-local** time.

**Server error mapping** (`mapAttendanceError`):
- `attendance_non_working_day` → "This date is a non-working day and your attendance policy does not allow recording work on it."
- Status CHECK violation → "That attendance status is not allowed."
- Duplicate → "An attendance record already exists for this employee on this date."
- Anything else → "Could not save the attendance record."

**Exports:**
- **CSV** `attendance-{start}-to-{end}.csv`. Columns: Employee, Date, Check In, Check Out, Hours, Overtime, Status, Notes. Not activity-logged.
- **Excel** (ExcelJS, sheet "Attendance") and **PDF** (`AttendanceReportPDF`). Columns: Employee, Employee No., Date, Check In, Check Out, Hours, Overtime, Status, Zone (In/Out/n/a), Notes, plus summary rows.
  - Both log `logActivity(org, 'exported', 'attendance_report', -, title, 'Exported attendance report (Excel|PDF)')`.

**Empty / loading:** a Clock icon with `emptyState`, and a spinner.

**i18n:** `hrmsAttendance.{attendance,page,report,share,fields}.*`, `common.*`.

### 1.2 Monthly summary: `/home/user/Flowza_Finance_V1/src/pages/hrms/AttendanceSummaryPage.tsx`

- **Controls:** month picker (max = current month); search by name or employee number; employee count.
- **Columns:** Employee (+ number), Present, Late, Half Day, On Leave, Absent, Incomplete, Days Worked, Total Hours, Overtime, Avg/Day, plus a totals footer.
- **Data:** `attendanceStore.fetchMonthlySummary`.
  - It buckets `get_attendance_register` rows; present, late, half_day and incomplete count as "worked".
  - Overtime is summed from paged `attendance_records`.
- **Export:** CSV `attendance-summary-YYYY-MM.csv`, gated on `reports.export`. Logs `('exported','report', -, 'attendance-summary-YYYY-MM', 'Exported monthly attendance summary', {month, rows})`.
- **States:** empty state and spinner. The empty row uses colSpan 10 for an 11-column table.
- **i18n:** `hrmsAttendance.summary.*`.

### 1.3 Regularisation: `/home/user/Flowza_Finance_V1/src/pages/hrms/AttendanceRegularisationPage.tsx` and `/home/user/Flowza_Finance_V1/src/components/hrms/RegularisationRequestModal.tsx`

**Colours:**
- Status: pending amber, approved emerald, rejected red, cancelled gray.
- Request type: `missed_punch` red, `wrong_punch` orange, `wfh_unmarked` blue, `system_downtime` purple (labels `hrmsAttendance.regularisation.types.*`).

**Header buttons:**
- "Approve selected (N)": needs `hrms.attendance_regularisation.bulk_regularise`.
- "New request": needs `hrms.attendance_regularisation.manage`.

**Page body:**
- Cards: Pending, Approved, Rejected, Total.
- Status chips (each refetches from the server); search by employee name or type label.
- Table: checkbox (pending rows only), Employee, Date, Type chip, Expected In, Expected Out, Reason (truncated), Status chip (+ an "applied" label when `applied_at` is set).
- There is **no per-row approve/reject UI**.

**Modal fields:**
- Employee\* (active employees only).
- Attendance Date\* (default today).
- Request Type\*: `missed_punch` / `wrong_punch` / `wfh_unmarked` / `system_downtime`; default `missed_punch`.
- Expected Check-In, Expected Check-Out (time inputs).
- Reason\*.
- Supporting Notes.
- Errors: `errors.selectEmployee`, `errors.selectDate`, `errors.provideReason`.

**Toasts:** `submitted`, `bulkApproved`, `errors.noOrganization`.

**i18n:** `hrmsAttendance.regularisation.*`, `hrmsComponentsA.regularisationRequestModal.*`.

### 1.4 Holiday calendars: `/home/user/Flowza_Finance_V1/src/pages/hrms/HolidayCalendarPage.tsx`

- **Gates:** view `hrms.holidays.view`, manage `hrms.holidays.manage`.
- **Holiday types:** public (blue), restricted (amber), company (teal), regional (purple), optional (gray).
- **Calendar list:**
  - Search by name or year.
  - Expandable cards showing a Default star badge, year and state.
  - Edit and delete; delete confirmation modal shows the name in bold.
- **Inline holidays:**
  - Add and edit with name, date, type.
  - Delete with inline Confirm/Cancel.
  - Error `holidayNameDateRequired`.
- **Calendar modal:**
  - Name\* (`calendarNameRequired`).
  - Year\*, 2000-2100 (`invalidYear`).
  - State: "All states" or one of 13 hard-coded Indian states.
  - "Set as default" checkbox.
- **Feedback:** created/updated/deleted toasts; empty state with "create first".
- **i18n:** `hrmsLeave.holidayCalendar.*`.

### 1.5 Shifts: ShiftListPage, ShiftFormPage (+ ShiftFormSchema.ts), ShiftCalendarPage

Files are under `/home/user/Flowza_Finance_V1/src/pages/hrms/`.

**List page** has tabs Shifts / Assignments / Swap Requests (with counts), resizable columns and per-tab search.

**Shifts table:**
- Columns: Name, Code, Type chip, Timing (+ break), Grace, Weekly-off chips (or "None"), Active/Inactive, Edit, Delete (confirmation modal).
- Type colours: morning amber, evening orange, night indigo, general teal, split purple.

**Assignments table:**
- Columns: Employee, Shift (name + code), Department, Effective From, Effective To (or "Ongoing"), Edit (modal), Remove (no confirmation).
- Assign modal fields: Employee\*, Shift\* (active shifts only), Department, Effective From\* (default today), Effective To.
- Errors: `employeeRequired`, `shiftRequired`, `dateRequired`.

**Swaps table:**
- Columns: Requestor, Target, Date, "A <-> B", Status chip.
- Swap modal fields: Swap Date\*, Requestor Employee\*, Requestor Shift\*, Target Employee\*, Target Shift\*.
- There is **no approve/reject UI** for swaps.

**Shift form** (react-hook-form + zod):
- Required: name, code, start_time, end_time. Code is upper-cased.
- Defaults: type `general`, 09:00-18:00, grace 15, early departure 15, break 60, night allowance 0, active.
- Sections: Basic Info, Timing, Weekly Off Days (sunday..saturday toggles).
- Users without manage see a `permissionDenied` text.

**Shift calendar** (monthly roster):
- Rows: employees whose assignment overlaps the month.
- Each cell shows the shift code (2 characters) coloured by type, "Off" on the shift's `weekly_off_days`, or "-".
- Tooltip shows the shift name and start-end.
- Legend, Saturday/Sunday shading, today highlight.

**i18n:** `hrmsShifts.shifts.list.*`, `hrmsShifts.shiftTypes.*`, `hrmsShifts.days.*`.

**Not wired:** shifts are not used by the classifier, and `shift_rotations` has no UI.

### 1.6 Workforce (legacy locations/devices + policy): `/home/user/Flowza_Finance_V1/src/pages/hrms/WorkforcePage.tsx`

Gates: view `hrms.workforce.view`, manage `hrms.workforce.manage`.

**Tabs:**
- **devicespunches** (only with `hrms.workforce_devices.view`; embeds the workforce-config tabs, section 1.7).
- **locations.** LocationModal fields:
  - name\*, address, lat, lng.
  - radius (default = the policy default, else 200).
  - "Use my location" (tries high-accuracy geolocation, then a low-accuracy fallback).
  - allowed IPs as comma-separated text.
  - Delete is soft (`is_active = false`).
- **devices** (legacy `biometric_devices`). DeviceModal fields:
  - name\*; type fingerprint / face / iris / card / pin; serial; location; integration provider.
  - status active / inactive / offline.
  - "Generate/Regenerate credentials" calls `rotate_biometric_ingest_secret` and opens a CredentialModal showing the endpoint `${VITE_SUPABASE_URL}/functions/v1/biometric-punch-ingest`, `x-device-key` and `x-device-secret`, shown once.
- **enrollments.**
  - Device user ID → employee, optional device ("Any device").
  - A duplicate shows "That device user ID is already mapped".
- **policy.** Controls, in order:
  1. Toggles: `enforce_geofence`, `enforce_ip_restriction`, `allow_web_checkin`, `allow_mobile_checkin`; plus `default_geofence_radius_meters`.
  2. Punch pairing radio: `first_in_last_out` / `net_worked`.
  3. `auto_status_enabled`, which reveals `work_start_time`, `work_end_time`, `late_grace_minutes`, `half_day_hours`, `full_day_hours`, `working_weekdays` (0=Sun..6=Sat) and `out_of_window_action` (late / absent / ignore).
  4. `auto_deduct_unexcused`, which reveals `missing_punch_grace_days` and a warning.
  5. `missed_punch_detection_enabled`, which reveals the check-in window and check-out window (from-to), with a fallback note.
  6. `non_working_day_handling_enabled`, which reveals `non_working_day_action` (auto_label / overtime / block).
  7. Timezone select (country IANA zones + UTC; an unknown stored zone is kept).
  - Save fills blank times with defaults, logs `('updated','attendance_policy')` and toasts.
- **calendar.** Shows the HR calendar-feed URL `${VITE_SUPABASE_URL}/functions/v1/hr-calendar-feed?org=...&token=${calendar_feed_token}` with Generate and copy.

**i18n:** `hrmsOrgAnalytics.workforce.*`.

### 1.7 Devices and punches: `/home/user/Flowza_Finance_V1/src/pages/hrms/workforce-config/`

Files: WorkforceConfigPage, DevicesTab, DeviceDrawer, PinMappingTab, UnmappedPunchesTab, PunchLogTab, PunchRawModal, EmployeePicker, CopyField.

- **Gates and tabs:** view `hrms.workforce_devices.view`, manage `hrms.workforce_devices.manage`. Tabs: devices / pins / unmapped / punchlog.

- **DevicesTab:**
  - Columns: Device (friendly_name + serial), Brand·Model, Method, Site, Status, Enabled toggle, Edit.
  - Status is derived live from `last_seen_at`: online < 5 min, stale < 60 min, otherwise offline; "never" if not seen.

- **DeviceDrawer:**
  - **Common fields:**
    - friendly name\*, brand, model (picking a model sets the default method).
    - method: `adms_push` / `device_http_push` / `vendor_cloud_pull` / `agent_rest` / `manual_import`.
    - timezone (default Asia/Muscat).
    - serial\* (required for adms, http and agent methods).
  - **`adms_push`:**
    - Server URL = `VITE_ADMS_PUSH_URL`, else `${SUPABASE_URL}/functions/v1/attendance-adms`.
    - A push token is generated on save, with Regen.
    - The model's `setup_instructions` are shown.
  - **`device_http_push`:**
    - host, port, scheme; write-only admin user and password.
    - Listen URL `/functions/v1/attendance-push/sn/<serial>/t/<token>`.
    - "Probe device" calls `attendance-push/setup`.
  - **`vendor_cloud_pull`:** API URL plus a write-only key.
  - **`agent_rest`:** `/functions/v1/attendance-ingest` plus the token.
  - **`manual_import`:** a note only.

- **PinMappingTab:**
  - Device select and a mappings table with delete.
  - Bulk rows of PIN → employee, with collision detection ("Already mapped").
  - Toasts: `mapped`, `backfilled`, `skippedCollisions`; error `errors.atLeastOne`.
  - Saving backfills `punch_events.employee_id`, which fires a recompute.

- **UnmappedPunchesTab:**
  - Grouped by device serial / PIN, with count and last seen.
  - Assign employee (manage) upserts the mapping and backfills; toast "mapped {pin, count}".

- **PunchLogTab:**
  - Filters: from (default 14 days ago), to, device, status (all / mapped / unmapped), employee.
  - Page size 50, exact count, pagination.
  - Columns: Time (in the device's timezone), Device, PIN, Employee or "Unmapped", Source (`sources.{device_push,rest_api,vendor_cloud,agent,manual_import}`), Geo (red verdict when `geo_flagged`), View raw.

- **PunchRawModal:** all punch fields, `raw_payload` JSON, `geo_evaluation` JSON, Copy JSON; Esc closes.

- **EmployeePicker:** 200 ms debounce; excludes terminated and merged employees; limit 500.

### 1.8 Geofences (PostGIS): `/home/user/Flowza_Finance_V1/src/pages/hrms/geofences/`

Files: GeofencesPage, GeofenceEditorPanel, GeofenceMap, AssignmentEditor, TimeWindowsEditor, ChipListInput.

**List** shows per fence:
- type icon, name, an "Off" badge when disabled.
- enforcement badge: hard_block red, soft_warn amber, advisory_log sky.
- "Priority n".
- assignment summary: "Whole org", "N sites · N teams · N people", or "Unassigned".
- edit button and an enabled switch (`set_geofence_enabled`).

**Map (Leaflet):**
- Colours: hard #dc2626, soft #d97706, advisory #0284c7, active #0d9488, disabled #94a3b8.
- Circle and polygon drawing.

**Editor sections:**
1. **Name\*.**
2. **Geometry:** circle (lat/lng/radius) or polygon; Clear.
3. **Enforcement** radio.
4. **Tuning:** `gps_accuracy_threshold_m`, `grace_radius_m`, `min_dwell_seconds`, `priority`, require on check-in / check-out.
5. **Active period:** `active_from` / `active_to`, plus time windows (dow 1=Mon..7=Sun, start/end; empty means always active).
6. **Network:**
   - Wi-Fi SSID chips.
   - IP CIDR chips, validated by `/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/`.
   - "Allow mock location".
7. **Assignment:** Whole org, OR sites (`work_locations`) / teams (departments) / employees.
8. **Enabled.**

**New-fence defaults:** radius 100, accuracy 50, soft_warn, priority 100, whole-org assignment.

**Validation:** name required; a circle needs center and radius; a polygon needs at least 4 ring points.

**i18n:** `hrmsShifts.geofences.*`.

### 1.9 Shared panels: `/home/user/Flowza_Finance_V1/src/pages/hrms/components/`

**AttendanceCommentsPanel.tsx**
- Data: RPC `get_attendance_notes_report(p_org, p_from, p_to)`. Collapsible, closed by default, hidden when empty.
- Columns:
  - Employee, Date (+ the day's status).
  - Comment ("category: note"; any rejection reason in red).
  - Status chip, Reviewed by.
  - Leave impact: "Loss of pay" (red), "deducted N" (amber), or "-".
- Status chips: pending amber, approved emerald, rejected red, excused teal, info_requested indigo.
- CSV `attendance-comments-{start}-to-{end}.csv`: Employee, Number, Date, Day Status, Category, Comment, Status, Reviewed By, Leave Impact. The `csvCell` helper guards against formula injection by prefixing `'` to cells starting with `= + - @ \t \r`.

**AttendanceReportSharePanel.tsx** (manage): a modal with two tabs; see section 8 for delivery.
- **Now tab:**
  - Channels in_app / email / whatsapp (default in_app).
  - Send generates the PDF blob and uploads it to bucket `attendance-reports` at `${orgId}/${Date.now()}-attendance.pdf`.
  - It then invokes `send-attendance-report` with `{organization_id, storage_path, period_label "start → end", channels, recipient_mode: 'each_own'}`.
  - Toast "sentSummary {emailed, whatsapped, notified}".
- **Scheduled tab:**
  - Create form: name (required), run day 1-28, period `previous_month` / `current_month_to_date` / `custom_offset` (from/to day 1-28).
  - Saved with cadence `monthly`, recipient_mode `each_own`, format `pdf`, and channels **hard-coded to `['in_app']`**.
  - List: name plus "day, next run"; Power toggle; delete (no confirmation); an amber `schedulePending` note (copy predates the Phase E cron; verify it).

**OpenAttendanceGrantsPanel.tsx** (manage)
- Collapsible, loads lazily.
- Lists employees (not terminated/merged, limit 1000) with switches reflecting `open_attendance_grants.is_active`; search.
- Toggling calls `set_open_attendance_grant(p_employee, p_enabled)`.

**SelfieCheckinReviewPanel.tsx**
- Data: `list_pending_selfie_checkins(p_org)`; one signed URL per row via the `attendance-selfie-url` edge function.
- Card: thumbnail, name/number, captured date and time, and a Google Maps link "lat,lng ± accuracy" (or an amber "no location" note).
- Actions: Approve, or Reject with a reason → `review_selfie_checkin(p_id, p_decision, p_reason)`.
- Hidden when empty; open by default. Face-match fields are **not** displayed.

### 1.10 Employee detail tab: `/home/user/Flowza_Finance_V1/src/pages/hrms/employee-detail/EmployeeAttendanceTab.tsx`

- Columns: Date, Check In, Check Out, Hours, Status.
- Only present (green) and absent (red) are coloured; everything else is amber.
- "Export PDF" prints escaped HTML through a hidden iframe.
- i18n `hrmsEmpDetailB.attendance.*`.

### 1.11 Reason approvals: `/home/user/Flowza_Finance_V1/src/components/approvals/AttendanceNoteApprovalList.tsx`

**Where it renders:** the Approvals inbox (HR category) and the employee-portal Approvals tab. Both act on the same rows. Props: `orgId`, `includeOversight`, `onActioned`, `showWhenEmpty`.

**Row:** name, number, date, a `day_status` chip, an "excused N× this year" badge, an "Oversight" badge, and "category: note".

**Actions:**
- **Approve.**
- **Excuse.**
- **Ask info** (comment required).
- **Reject.** The pay effect is required: No deduction (0) / Half day (0.5) / Full day (1). The reason is optional. Confirm stays disabled until a pay effect is chosen.

**Toasts:** `rejectedLossOfPayToast`, `rejectedDeductedToast {days}`, `rejectedNoChargeToast`, `approvedToast`, `excusedToast`, `infoRequestedToast`.

**Layout:**
- A separate oversight section (`oversightTitle` / `oversightHint`), shown for HR.
- A `deductionNote` footer.
- `emptyMine` when there is nothing to review.

---

## 2. Stores

All stores are under `/home/user/Flowza_Finance_V1/src/stores/`. **No attendance store checks permissions client-side**; gating is page/UI-level plus RLS/RPC.

| Store | Tables / views | RPCs / functions | Activity log (action, entity_type) |
|---|---|---|---|
| `attendanceStore.ts` | `attendance_records` (employee embed, limit 1000); `punch_events` (per-day punch timeline) | `process_punches{p_org,p_from,p_to}`, `get_attendance_register{p_org,p_from,p_to,p_employee?}` | checkIn: created, attendance_record "Employee checked in"; updateRecord: updated "Updated attendance record"; createRecord: created "Attendance record created". checkOut is not logged. |
| `attendanceNoteApprovalStore.ts` | - | `list_pending_attendance_notes_v2(p_org_id, p_scope 'mine'\|'all')`, `review_attendance_note_v2(p_note_id, p_decision, p_reason, p_pay_effect_days)` (pay effect sent only for rejected) | updated, attendance_note {decision, pay_effect_days, employee_id, via_oversight}. `pendingMineCount` feeds the badges. |
| `attendanceRegularisationStore.ts` | `attendance_regularisation_requests` (limit 500; filters status / employee / date); `attendance_records` (client apply) | none. The page does **not** use `submit_attendance_regularisation` / `apply_attendance_regularisation`. | created, attendance_regularisation; bulk approve: updated "Bulk approved N"; apply: updated "Applied regularisation for date". Raw `error.message` is returned to the UI. |
| `attendanceScheduleStore.ts` | `attendance_report_schedules` (hard delete) | `computeNextRun` = next date whose day-of-month is run_day (clamped 1-28) | created / updated / deleted, attendance_report_schedule |
| `attendanceDeviceStore.ts` | `attendance_devices` (+ brand/model/site embeds), `device_brands`, `device_models` (SWR cache) | `functions.invoke('attendance-push/setup')` (probe) | created / updated, attendance_device (incl. enable/disable). Errors go through `mapStoreError`. |
| `devicePinMapStore.ts` | `device_user_map`, `employees` (search), `punch_events` (backfill + log), view `unmapped_punches` | - | created (bulk map + backfill), updated (assign PIN), deleted, device_user_map |
| `geofenceStore.ts` | - | `get_geofences`, `upsert_geofence`, `set_geofence_enabled`, `preview_geofence_checkin`; the `workforce-checkin` function for punches. Verdicts: allowed / flagged / logged / denied. | created / updated, geofence (enable toggle not logged client-side) |
| `holidayCalendarStore.ts` | `holiday_calendars` (+ holidays count, limit 200), `holidays` (hard deletes) | - | created / updated / deleted for holiday_calendar and holiday |
| `shiftStore.ts` | `shifts`, `shift_assignments`, `shift_swap_requests` (hard deletes) | - | shift, shift_assignment (created / updated / deleted), shift_swap_request (created) |
| `workforceStore.ts` | `work_locations`, `biometric_devices`, `biometric_enrollments` (soft deletes), `attendance_policies` (singleton read and upsert) | `rotate_biometric_ingest_secret`; the `attendance-checkin` function for check-in | work_location, biometric_device, biometric_enrollment (created / updated / deleted); attendance_policy updated |

---

## 3. Rules (utilities and their SQL mirrors)

### 3.1 Status vocabulary (`attendance_records.status` CHECK, final form in 20270502000000)

The ten allowed values: `present, absent, half_day, late, on_leave, holiday, weekend, incomplete, holiday_work, weekly_off_work`.

| Status | Set by | Meaning |
|---|---|---|
| present | default, ladder | Arrived by `work_start_time + late_grace_minutes`; also everything when the engine is off. |
| late | ladder | Check-in after start+grace and at or before `work_end_time` (or after end when `out_of_window_action = 'late'`). Judged on **arrival only** (20270533000001). |
| half_day | ladder | Worked hours < `half_day_hours` (applies to present and late, not absent). |
| absent | ladder (out_of_window=absent) or derived register | No stored row on a past working day (derived), or arrival after end with action absent. |
| on_leave | derived register | Approved leave on a working day without a stored row. |
| holiday | recompute (device punches) / derived | Punches on a date in any org holiday calendar (recompute); a holiday on the default calendar (derived). |
| weekend | recompute | Punches on a weekday outside `working_weekdays`. |
| incomplete | missed-punch logic | One-sided day once the day is closed (lone check-out immediately; lone check-in after day close). |
| holiday_work / weekly_off_work | classifier (manual/portal rows) | Work on a non-working day when `non_working_day_handling_enabled` and action = `auto_label`. |

**Terms that are not statuses:**
- `short_day`: a short-day→late rule existed in 20270465000000 and was removed in 20270533000001. Short days are shown only by hours and the red <8h flag.
- `missed_punch`: implemented as `incomplete`, plus the regularisation type `missed_punch`.
- `weekly_off`: appears as `weekend` or `weekly_off_work`.
- `comp_off`: a credit row in `comp_off_credits`, not a status.
- The "chequeless" util named in the brief **does not exist**.

### 3.2 Classification ladder

Implemented in `classifyAttendance` in `/home/user/Flowza_Finance_V1/src/utils/attendanceClassification.ts`, which mirrors `classify_attendance_day`.

`DEFAULT_ATTENDANCE_RULES`:

| Rule | Default |
|---|---|
| `auto_status_enabled` | false |
| work hours | 09:00-18:00 |
| `late_grace_minutes` | 15 |
| `half_day_hours` | 4 |
| `full_day_hours` | 8 |
| `working_weekdays` | [1..5] (Mon-Fri) |
| `out_of_window_action` | `late` |
| `missed_punch_detection_enabled` | false |
| check-out window | 12:00-22:00 |
| `non_working_day_handling_enabled` | false |
| `non_working_day_action` | `auto_label` |

The ladder, in order:
1. **Hours.** `calcWorkHours(in, out, {allowOvernight})`:
   - out > in: hours = difference.
   - out ≤ in: wraps past midnight **only** when the policy is a night shift (`work_end_time <= work_start_time`).
   - Otherwise the input is invalid → `blocked`, `blockReason = 'checkout_before_checkin'`.
2. **Engine off** (`auto_status_enabled = false`): status `present`; hours are still computed.
3. **Non-working day** (handling enabled, and the day is a holiday or its weekday is not in `working_weekdays`):
   - `block`: blocked with `non_working_day` (the server raises `attendance_non_working_day`, P0001).
   - `overtime`: present, overtime = hours.
   - `auto_label`: `holiday_work` or `weekly_off_work`, overtime = hours.
4. **Missed punch** (detection on, exactly one side present):
   - A lone check-out → `incomplete` immediately.
   - A lone check-in → `incomplete` only once `isDayClosed`. A day is closed when now ≥ date + `checkout_window_end`, plus one day if the window wraps midnight.
5. **No check-in** → present.
6. **Arrival:**
   - check-in ≤ start + grace (inclusive) → present.
   - otherwise ≤ `work_end_time` → late.
   - otherwise `out_of_window_action`: absent / ignore→present / late.
7. **Half day:** if the status is not absent and hours < `half_day_hours` → half_day.

### 3.3 Device-punch ladder (`recompute_attendance_day`, 20270601000000 as patched by 20272090000000)

1. **Local date** comes from the punch's `device_timezone` (default Asia/Muscat).
2. **Pairing** (`attendance_policies.punch_pairing_mode`):
   - `first_in_last_out` (default): hours = last punch − first punch.
   - `net_worked`: sum of consecutive in/out pairs; a trailing odd punch adds 0.
3. **Single-punch resolution** (only after day close, on working days) uses the windows:
   - inside `checkin_window` (default 06:00-12:00) → treated as check-in;
   - inside `checkout_window` (default 12:00-22:00) → check-out;
   - outside both → check-out if ≥ `checkout_window_start`.
4. **Status order:**
   - non-working day → `holiday` / `weekend` (via `_attendance_nonworking_kind`, which checks ANY org holiday calendar);
   - else `incomplete`;
   - else the auto ladder;
   - else present.
5. **Comp-off:** credited on non-working days that have hours (see 3.5).
6. **Protection:**
   - The UPDATE skips rows whose `check_in_source` or `check_out_source` is `manual`.
   - It keeps `status` when `status_source = 'manual'`.
   - The INSERT is `ON CONFLICT DO NOTHING`.
7. **Source labels** are derived from the punches (e.g. `device_punch`, `web`).
8. **`within_geofence`** = `_attendance_geofence_pass(lat, geofence_id, verdict, flagged, reason)`:

| Input | Result |
|---|---|
| lat is null | NULL |
| verdict is null | NULL |
| reason `no_fences_assigned` | NULL |
| allowed, no fence id | NULL |
| flagged, or verdict denied / flagged / logged | false |
| allowed (with a fence) | true |

### 3.4 Policy trigger (`trg_attendance_records_apply_policy` → `_attendance_apply_policy`, BEFORE INSERT/UPDATE)

- Skips rows with source `device_punch`.
- Recomputes hours on INSERT with NULL hours, or on UPDATE when either time changes.
- A blocked day raises `attendance_non_working_day` (P0001).
- Sets `status` only when `status_source = 'auto'` and the classifier's `apply_status` is true.
- Sets overtime from the classifier when the current value is 0.

### 3.5 Comp-off (`_credit_comp_off_for_nonworking_day(p_org, p_employee, p_date, p_hours, p_kind)`, 20270497000000)

- **Settings** (`comp_off_settings`): `min_hours_for_full_day` (default 8) → 1.0 day; `min_hours_for_half_day` (default 4) → 0.5 day; `expiry_days` (default 90).
- **Status:** `auto_credit_on_holiday_work` → `approved`; otherwise `pending_approval`.
- **Row written:** one `comp_off_credits` row per (employee, earned_date), with `worked_on_type` holiday / weekly_off. Re-runs update hours and credit in place.
- Logs `created`, `comp_off_credit`.

### 3.6 Pay-effect weights (four places; keep them consistent)

| Use | absent | late | incomplete | one-sided punch | Override |
|---|---|---|---|---|---|
| Reject deduction `_deduct_leave_for_unexcused_note` (20270546000000) | 1.0 | 0.5 | 0.5 | - (other statuses 0) | `pay_effect_days` override replaces the value for absent / late / incomplete only; ≤ 0 means no charge |
| Nightly sweep `_sweep_unexcused_attendance` | 1.0 | 0.5 | 0.5 | 0.5 | none |
| Payroll LOP bridge `get_payroll_attendance_summary` | 1.0 | 0.5 | 0.5 | 0.5 | `COALESCE(pay_effect_days, ladder)` |
| Employee self-stats `attendanceSelfStats.ts` | 0 | 1 (counts as present) | - | - | half_day 0.5, present 1, on_leave 0 |

**How a deduction is charged:**
- It picks a **paid** leave type with enough balance for that year.
- It excludes the codes SICK, MATERNITY, PATERNITY, HAJJ, MARRIAGE, BEREAVEMENT, ADOPTION, COMPASSIONATE.
- Preference order: ANNUAL, then CASUAL, then the type with the most remaining balance.
- If none qualifies, the day is marked `loss_of_pay = true`.
- It never charges a day already covered by approved leave (`employee_has_approved_leave_on`).
- It is idempotent: a note already deducted or already LOP is skipped.

### 3.7 Punctuality and self statistics

**`attendancePunctuality.ts`:**
- Defaults: start 09:00:00, grace 15 min.
- The signed delta ignores grace; `delayMinutes = max(0, delta − grace)`.
- Helpers:
  - `lastWorkingDates` (capped at 400 days) and `summarizePunctuality`;
  - `formatMinutesHM` / `formatSignedMinutes` (uses U+2212 minus);
  - month / previous-month / last-N ranges;
  - timezone-aware `clockMinutesInZone`.

**`attendanceSelfStats.ts`:**
- Working days exclude weekends and holidays.
- % = present-equivalent ÷ working days. Average hours count only days with hours > 0.
- Improvement flags: `lowAttendance` (<90%), `shortHours` (<8), `lateDays`, `absentDays`, `missingCheckout`.
- Helpers `lastNAttendanceDays(7)`, `lastNWorkingDays(5)`.

### 3.8 Other helpers

- **`attendanceTime.ts`:** `toTimeInput`, and `combineDateTime` (builds a local-timezone ISO string).
- **`attendanceReport.ts`:** report headers, row cells (Zone in/out/na), `summariseAttendance`, `downloadAttendanceExcel`.

---

## 4. Database (`/home/user/Flowza_Finance_V1/supabase/migrations/`)

### 4.1 Tables

**`attendance_records`** (baseline 20260402201358, then additions)
- **Columns:**
  - `id, organization_id, employee_id, attendance_date, check_in, check_out`.
  - `work_hours numeric(5,2)`, `overtime_hours numeric(5,2) default 0`.
  - `status default 'present'` (CHECK in 3.1), `notes`, timestamps.
  - From 20261107000000:
    - `check_in/out_latitude/longitude numeric(9,6)`, `check_in/out_ip`.
    - `check_in_source text NOT NULL default 'manual'`, `check_out_source`.
    - `device_id`, `work_location_id`, `within_geofence boolean`.
  - `status_source text NOT NULL default 'auto' CHECK (auto|manual)` (20270502000000).
- **Constraints:** UNIQUE(employee_id, attendance_date).
- **Source vocabulary is by convention only (no CHECK):** manual, web, mobile, biometric, device_punch, regularisation, selfie.
- **RLS (20270492000000):**
  - SELECT: org member AND `employee_id IN attendance_visible_employee_ids(org)`.
  - INSERT: manage OR the caller's own employee row.
  - UPDATE / DELETE: manage only.

**`attendance_policies`** (one active row per org; unique org where active)

| Column | Default / CHECK | Migration |
|---|---|---|
| enforce_geofence, enforce_ip_restriction | false | 20261107000000 |
| allow_web_checkin, allow_mobile_checkin | true | 20261107000000 |
| default_geofence_radius_meters | 200 | 20261107000000 |
| is_active | true | 20261107000000 |
| calendar_feed_token | random 32-hex | 20261107000100 |
| punch_pairing_mode | 'first_in_last_out' CHECK (first_in_last_out, net_worked) | 20270455000000 |
| auto_status_enabled | false | 20270461000000 |
| work_start_time / work_end_time | 09:00 / 18:00 | 20270461000000 |
| late_grace_minutes | 15 | 20270461000000 |
| half_day_hours | 4 | 20270461000000 |
| working_weekdays smallint[] | {1,2,3,4,5} (0=Sun) | 20270461000000 |
| out_of_window_action | 'late' CHECK (late, absent, ignore) | 20270461000000 |
| full_day_hours | 8 | 20270465000000 |
| missing_punch_grace_days | 3 | 20270465000000 |
| auto_deduct_unexcused | false | 20270465000000 |
| missed_punch_detection_enabled | false | 20270470000000 |
| single_punch_split_time | 13:00 (deprecated) | 20270470000000 |
| checkin_window_start / _end | 06:00 / 12:00 | 20270471000000 |
| checkout_window_start / _end | 12:00 / 22:00 | 20270471000000 |
| timezone | 'Asia/Muscat' | 20270502000000 |
| non_working_day_handling_enabled | false | 20270502000000 |
| non_working_day_action | 'auto_label' CHECK (block, auto_label, overtime) | 20270502000000 |

RLS: any org member can SELECT and write (UI-gated only).

**`work_locations`**
- Columns: name, address, latitude/longitude numeric(9,6), `geofence_radius_meters` (default 200), `allowed_ip_ranges text[]`, timezone, is_active.
- RLS: org member, all operations.

**Legacy biometric tables:**
- `biometric_devices`: + `ingest_key`, `ingest_secret_hash`, `ingest_secret_set_at`.
- `biometric_enrollments`: unique (org, external_user_id) where active.
- `biometric_punch_events`.

**Device integration (20261117000000):**
- **Native enums:**
  - `integration_method`: adms_push, device_http_push, vendor_cloud_pull, vendor_webhook, agent_rest, manual_import.
  - `protocol_family`: zkteco_adms, hikvision_isapi, dahua_http, suprema_biostar, vendor_cloud, generic_rest, legacy_sdk, manual.
  - `punch_source`: device_push, rest_api, vendor_cloud, agent, manual_import.
- **Tables:**
  - `device_brands` (15 seeded) and `device_models`: `brand_id, model_name, default_integration_method, supports_https, default_config, setup_instructions`.
  - `attendance_devices`: `organization_id, serial_number` (unique-partial globally), `brand_id, model_id, friendly_name, site_id → work_locations, integration_method (default manual_import), connector_config jsonb, push_token, device_timezone default 'Asia/Muscat', firmware, enabled, last_seen_at, status default 'pending'`.
  - `device_user_map`: `device_id, device_pin, employee_id`, UNIQUE(device_id, device_pin).
  - `punch_events`: `organization_id, device_id, device_serial, device_pin, employee_id, punch_time_utc NOT NULL, device_timezone, verify_mode, punch_state, work_code, source punch_source default device_push, raw_payload, dedup_hash` (unique partial), `geo_lat, geo_lng, geo_accuracy_m, geofence_id, geo_evaluation`, and `geo_flagged, geo_verdict` (20261117060000).
- **View** `unmapped_punches`: punches with a PIN but no employee, grouped for the inbox.
- **RLS on `punch_events`:**
  - SELECT: manage OR a visible employee.
  - Writes: manage.

**Geofences (20261117040000; PostGIS):**
- **`geofences` columns:**
  - `name, site_id`, `type geofence_type` (circle | polygon).
  - `center_lat, center_lng, radius_m`, `boundary geometry(Polygon, 4326)`.
  - `gps_accuracy_threshold_m` 50, `min_dwell_seconds` 0.
  - `enforcement geofence_enforcement` (hard_block | soft_warn | advisory_log) default soft_warn.
  - `require_on_checkin/checkout` true, `grace_radius_m` 0, `priority` 100.
  - `active_from/to`, `time_windows jsonb`, `wifi_ssids text[]`, `ip_cidrs text[]`, `allow_mock_location` false, `enabled` true.
- **`geofence_assignments`:** `geofence_id, scope CHECK (org, site, team, employee), target_id`.
- **RLS:** org member, all operations (writes are meant to go through RPCs).

**`attendance_notes`** (20270448000000, 20270449000000, 20270494000000, 20270496000000)
- **Columns:**
  - `employee_id, attendance_date, note`.
  - `category CHECK (client_visit, field_work, late_reason, absence_reason, wfh, other)` default 'other'.
  - `status CHECK (pending, approved, rejected, excused, info_requested)`.
  - `reviewed_by, reviewed_at, review_reason`.
  - `deducted_leave_type_id, deducted_days, loss_of_pay`.
  - `excused_at, excused_by`.
  - `pay_effect_days` CHECK (0, 0.5, 1.0).
  - `info_requested_at, info_request_message`.
  - `payroll_run_id` (LOP claim, 20270685000000).
- **Uniqueness:** partial unique index on (employee_id, attendance_date) WHERE status <> 'rejected', i.e. one active note per day.
- **RLS:**
  - SELECT: own notes, plus view/manage holders in the org.
  - **No write policy**: all writes go through RPCs.

**`attendance_report_schedules`** (20270450000000)
- **Columns:**
  - `name`, `cadence CHECK ('monthly')`, `run_day 1..28`.
  - `period CHECK (previous_month, current_month_to_date, custom_offset)`, `period_from_day`, `period_to_day` (1..28).
  - `recipient_mode CHECK (each_own, specific_employees, emails)`, `recipient_employee_ids uuid[]`, `recipient_emails text[]`.
  - `channels text[]` default {email}.
  - `format CHECK (pdf, excel, both)`.
  - `is_active, next_run_at date, last_run_at, created_by`.
- **RLS:** one FOR ALL policy requiring manage.

**Selfie / open attendance (20270468000001; face match 20270529000001):**
- **`open_attendance_grants`:**
  - Columns: `employee_id, granted_by, is_active`; unique (org, employee).
  - RLS: SELECT for org members; no write policy (writes go through the RPC).
- **`attendance_selfie_checkins`:**
  - Columns: `captured_at, latitude, longitude, accuracy_meters, selfie_path`, `status CHECK (pending, approved, rejected)`, `reviewed_by/at, review_reason, attendance_record_id`.
  - Face match: `face_match_ratio numeric(5,2)` (0-100) and `face_match_status CHECK (match, partial, not_matched, no_face, no_reference, skipped)`.
  - RLS SELECT: own, OR view, OR manage, OR mapped manager.

**Holidays (20260312133553):**
- `holiday_calendars`: `name, year, state, is_default`.
- `holidays`: `calendar_id, name, date, type CHECK (public, restricted, company, regional, optional)`.
- `payroll_runs.holiday_calendar_id` also added.
- RLS: org member via the calendar, all operations.

**Shifts (20260312160637):**
- `shifts`: `name, code, shift_type CHECK (morning, evening, night, general, split), start_time, end_time, grace_period_minutes 15, early_departure_threshold_minutes 15, break_duration_minutes 60, weekly_off_days text[], night_shift_allowance numeric(12,2), is_active`.
- `shift_assignments`: `employee_id, shift_id, department_id, effective_from, effective_to`.
- `shift_rotations`: `name, rotation_frequency CHECK (weekly, monthly), shift_ids uuid[]`. No UI.
- `shift_swap_requests`: `requestor_employee_id, target_employee_id, swap_date, requestor_shift_id, target_shift_id, status CHECK (pending, approved, rejected, cancelled), approval_request_id`.

**`attendance_regularisation_requests`** (20260312160713)
- Columns: `employee_id, attendance_date`, `request_type CHECK (missed_punch, wrong_punch, wfh_unmarked, system_downtime)`, `expected_check_in/out time`, `reason, supporting_notes, original_record_id`, `status CHECK (pending, approved, rejected, cancelled)`, `approval_request_id`.
- `applied_at` is the idempotency marker for apply.

**Storage buckets:**
- **`attendance-reports`** (20270462000000):
  - Private, 20 MB, PDF/XLSX only.
  - Write / update / delete: manage holders, in folder `<org_id>/`.
  - Read: org members.
- **`attendance-selfies`** (20270468000001):
  - Private, 5 MB, JPEG/PNG/WebP.
  - INSERT: only into the caller's own `<org>/<employee>/` folder.
  - DELETE: manage.
  - **No SELECT policy**: images are served only through signed URLs from an edge function.

### 4.2 RPCs (latest signature → behaviour)

**Ingestion**

`resolve_device(p_serial text, p_token text) → TABLE(id, organization_id)`
- Service role only; authenticates a device by serial + push_token.

`ingest_punch(p_device_id uuid, p_org uuid, p_pin text, p_time_utc timestamptz, p_tz text, p_verify text, p_state text, p_workcode text, p_source punch_source, p_raw jsonb, p_lat, p_lng, p_accuracy double precision, p_employee_override uuid DEFAULT NULL, p_geofence_id, p_geo_eval) → jsonb`
- Service role only.
- Checks the device belongs to the org; a deviceless punch needs both org and employee.
- Maps the PIN to an employee via `device_user_map` (or the override).
- Deduplicates via `dedup_hash`; stores `geo_verdict` / `geo_flagged`.
- The insert fires statement-level triggers `trg_punch_events_sync_attendance_ins/_upd`, which call `recompute_attendance_day`.

`heartbeat(p_device_id) → jsonb`
- Stamps `last_seen_at` and the device status.

`checkin_punch(p_employee_id, p_action 'in'|'out', p_lat, p_lng, p_accuracy=NULL, p_ts=now(), p_device_serial=NULL, p_wifi_ssid=NULL, p_ip inet=NULL, p_is_mock=false, p_source_channel='web') → jsonb`
- Authorisation:
  - self (`employees.user_id = auth.uid()`), or manage to punch for someone else;
  - a NULL uid is trusted.
- Evaluates geofences, then:
  - `denied` → not persisted, with a message;
  - `flagged` → accepted with a warning;
  - otherwise calls `ingest_punch`.

`evaluate_geofence(...)` (10-argument form, plus a 4-argument shim `(p_org_id, p_lat, p_lng, p_accuracy_m) → jsonb`)
1. Mock-location guard → denied, unless the fence allows mock locations.
2. Fence selection: scope priority employee > team (department) > site > org, then fence `priority` ascending.
3. Honours `active_from/to` and `require_on_checkin/out`.
4. Time windows are evaluated in **UTC** with ISO day-of-week.
5. Accuracy gate → `flagged` with reason `gps_accuracy_too_low` (`denied` if hard_block).
6. Shape test:
   - circle: distance ≤ radius + grace;
   - polygon: `ST_Contains`, or within the grace distance.
7. Wi-Fi / IP co-validation.
8. The worst verdict wins: denied > flagged > logged > allowed.
9. No fences → allowed, reason `no_fences_assigned`.

`min_dwell_seconds` is **not** evaluated.

`process_punches(p_org uuid, p_from timestamptz, p_to timestamptz) → jsonb`
- Dual mode:
  - an authenticated user needs org membership AND manage;
  - a NULL uid means service role or cron.
- Recomputes every (employee, local day) in the range; writes an audit log entry.

`recompute_attendance_day(p_org, p_employee, p_date) → text`
- Internal; revoked from clients (20270456000001). Rules in 3.3.

`advanced_import_commit_batch_attendance` (20261117020000)
- Manual file import target `attendance_punches`.
- Auto-creates a device `MANUAL-IMPORT-<org>`.
- Fields: `punch_time`\*, `employee_code`, `device_pin`, `device_serial`, `punch_state`, `verify_mode`, `work_code`, `geo_lat`, `geo_lng`, `geo_accuracy`.

**Classification**

`classify_attendance_day(p_org, p_employee, p_date, p_check_in timestamptz, p_check_out timestamptz) → TABLE(status, work_hours, overtime_hours, apply_status, blocked, block_reason)`
- Revoked from clients (20270503000000).
- It uses the **default** holiday calendar and the policy timezone.

`_attendance_apply_policy()`
- Trigger function; see 3.4.

**Read models and visibility**

`attendance_visible_employee_ids(p_org) → SETOF uuid`
- Returns ALL employees when:
  - `auth.uid()` is null, or
  - the caller is a super admin, or
  - the caller holds view_all.
- Otherwise: the caller's own employee row plus every employee whose `manager_id` or `secondary_manager_id` is the caller's employee row.

`get_attendance_register(p_org, p_from, p_to, p_employee=NULL) → TABLE(employee_id, employee_name, employee_number, attendance_date, status, check_in, check_out, work_hours, is_derived)`
- Returns stored rows for non-terminated, non-merged employees.
- When `auto_status_enabled`, it adds **derived** rows for each working weekday (within the employee's hire/termination dates) that has no stored row:
  - `holiday` when the date is on the default calendar;
  - `on_leave` when there is approved leave;
  - `absent` for strictly past days only.
- **Warning:** the newest body (20270493000003_merge_employees.sql) checks org membership only. It lost the `attendance_visible_employee_ids` scoping that 20270492000000 added, so any org member can read the whole register. Verify live.

`get_attendance_daily_summary(p_org_id, p_date) → TABLE(present, absent, late, half_day, on_leave bigint)`
- Counts stored rows for visible employees.
- Non-members get `insufficient_privilege`.

`get_my_attendance(p_from, p_to) → TABLE(attendance_date, check_in, check_out, work_hours, overtime_hours, status, within_geofence, note_id, note, note_category, note_status, note_review_reason)`
- Self-scoped, via `employees.user_id = auth.uid()`.

`get_attendance_notes_report(p_org, p_from, p_to) → TABLE(note_id, employee_id, employee_name, employee_number, attendance_date, day_status, note, category, note_status, review_reason, reviewed_by_name, reviewed_at, deducted_days, loss_of_pay)`
- view or manage holders see all notes; mapped managers see their reports' notes.

**Attendance notes lifecycle**

`submit_attendance_note(p_date, p_note, p_category='other') → jsonb`
- The caller must be a linked employee.
- It reverses any earlier auto-deduction for that day.
- It upserts the active note and resets it to `pending`, so the ask-for-info → reply loop needs no extra UI.
- It notifies the manager (primary, else secondary) in-app and by email; see section 7.
- Logs `created`, attendance_note.

`review_attendance_note_v2(p_note_id, p_decision, p_reason=NULL, p_pay_effect_days=NULL) → jsonb`
- **Decisions:** approved, rejected, excused, info_requested.
- **Authorisation:**
  - HR (manage OR `hrms.attendance_regularisation.approve`) OR the mapped manager;
  - **never** the subject employee (20270498000000).
- **Effects:**
  - approved / excused: restore any deduction and clear `loss_of_pay`;
  - rejected: stores `pay_effect_days` and calls the deduction;
  - info_requested: stamps `info_request_message`.
- Returns `deducted_days` and `loss_of_pay`; notifies the employee.
- The legacy `review_attendance_note` and `list_pending_attendance_notes` are thin delegates.

`list_pending_attendance_notes_v2(p_org_id, p_scope 'mine'|'all') → TABLE(note_id, employee_id, employee_name, employee_number, attendance_date, note, category, day_status, status, pay_effect_days, excused_count_year, is_oversight_only)`
- Returns only `pending` notes and excludes the caller's own.
- `mine` = notes of employees mapped to the caller as manager (no HR escape hatch).
- `all` = oversight; requires manage or `regularisation.approve`.

`_deduct_leave_for_unexcused_note(p_note_id[, p_override_days])`
- Internal (owner / service role only); rules in 3.6.

`_sweep_unexcused_attendance(p_org, p_asof) → int` and `run_unexcused_attendance_sweep() → jsonb`
- Cron job `attendance-unexcused-sweep` at `'30 2 * * *'`, and only for orgs with `auto_deduct_unexcused`.
- **What it sweeps:** stored rows that are absent, late or incomplete, or one-sided, dated on or before the cutoff `asof − missing_punch_grace_days` (default 3).
- **What it skips:**
  - days with a note in pending / approved / excused / info_requested;
  - days already processed;
  - days covered by approved leave.
- **What it writes:** a `rejected` note "Auto: no reason provided within the grace window" (category `other`), with the deduction or LOP.
- Logs `updated`, attendance_note "Auto-processed unexcused attendance day".

**Selfie / open attendance**

`set_open_attendance_grant(p_employee, p_enabled) → jsonb`
- manage OR mapped manager (the UI exposes it to manage only).
- Upserts the grant; logs `updated`, open_attendance_grant.

`submit_selfie_checkin(p_selfie_path, p_lat, p_lng, p_accuracy, p_captured_at=now()) → jsonb`
- Requires an active grant.
- The path must be `<org>/<employee>/...`.
- Notifies the manager.

`review_selfie_checkin(p_id, p_decision approved|rejected, p_reason) → jsonb`
- Allowed for manage OR the mapped manager; only while the row is `pending`.
- **On approval**, it upserts `attendance_records` on the **UTC** date of `captured_at`:
  - `check_in` is set only if the row's check-in is empty (`check_in_source = 'selfie'`);
  - status `present`;
  - `within_geofence` NULL.
- Notifies the employee.

`list_pending_selfie_checkins(p_org)`
- Returns pending rows for manage holders, or for the mapped manager.

`set_selfie_face_result(p_selfie_path, p_ratio, p_status) → jsonb`
- Write-once, by the employee, on their own pending row.
- The face match is computed client-side and is advisory.
- Tenant toggle: `hrms_preferences.selfie_face_verification_enabled`.

**Regularisation (approval engine)**

`submit_attendance_regularisation(p_org_id, p_employee_id, p_attendance_date, p_request_type, p_expected_check_in, p_expected_check_out, p_reason, p_supporting_notes) → jsonb`
- Inserts the request, then calls `submit_for_approval_atomic('attendance_regularisation')`.
- The default policy seeded per org is one-level `manager_chain` (20270420000000): primary manager → secondary manager (unless the primary is "absent", i.e. inactive or on approved leave today) → first `is_hr_user` member → owner.

`apply_attendance_regularisation(p_request_id) → jsonb`
- Only runs when the approval request is `approved`; idempotent via `applied_at`.
- Writes the times, with source `regularisation` and notes "Applied from regularisation <id>".
- Calls `log_audit_event`.

`approval_entity_approve_permission('attendance_regularisation')` = `hrms.attendance_regularisation.approve`.

**Portal punch**

`portal_check_punch(p_org_id, p_action, p_lat, p_lng, p_source='web') → jsonb`
- Inserts a `punch_events` row (source `rest_api`) and recomputes the day.
- Handles an orphan check-out (20270502000000).

**Geofence management** (all check org membership plus `hrms.workforce_devices.view` / `.manage`, raising 42501 otherwise)

| RPC | Permission | Notes |
|---|---|---|
| `get_geofences(p_org) → jsonb` | view | |
| `upsert_geofence(p_org, p_payload jsonb) → uuid` | manage | Validates name, type, and circle / polygon geometry. |
| `set_geofence_enabled(p_id, p_org, p_enabled)` | manage | |
| `preview_geofence_checkin(p_org, p_lat, p_lng, p_accuracy, p_action, p_wifi_ssid, p_is_mock) → jsonb` | org membership | Dry run. |

**Legacy device secret**

`rotate_biometric_ingest_secret(p_device_id) → TABLE(ingest_key, secret)`
- Requires `hrms.workforce.manage`.
- Stores a sha256 of the secret; logs `rotated_secret`.

**Reports and cron**

`run_attendance_report_schedules() → integer`
- Service role only; cron `attendance-report-schedules-daily` at `'15 6 * * *'`. See section 8.

**Payroll bridge** (20270685000000)

`get_payroll_attendance_summary(p_org_id, p_period_start, p_period_end, p_run_id=NULL, p_holiday_calendar_id=NULL) → TABLE(employee_id, working_days, lop_days, unpaid_leave_days, paid_leave_days, lop_note_ids)`
- One row per **active** employee.
- `working_days` = policy `working_weekdays` minus the run's (or default) holiday calendar.
- LOP comes from two disjoint sources:
  - notes with `loss_of_pay = true`, weighted as in 3.6;
  - approved **unpaid** leave.
- Payroll pricing (edge function `generate-payslips`):
  - gated by `payroll_preferences.attendance_lop_enabled`;
  - `lop_divisor` = working_days / calendar_days / fixed_30;
  - line `SYS_LOP` = gross (before overtime) ÷ divisor × LOP days, capped at gross.
- `generate_payslips_atomic(p_lop_notes)` stamps `attendance_notes.payroll_run_id`. Trigger `trg_payroll_runs_release_lop_notes` releases the claims when a run is voided.

### 4.3 Key migration timeline

| Migration | Adds |
|---|---|
| 20260312133553 | Holiday calendars + permissions (Owner). |
| 20260312160637 / 160713 | Shift and regularisation tables + permissions (owner). |
| 20261107000000 / 20261108000000 | Workforce: locations, policies, legacy biometric, ingest secret. |
| 20261117000000..070000 | A1 device schema; ingestion RPCs; manual import; device permissions; PostGIS geofences + RPCs + checkin wiring. |
| 20270417000000 / 20270420000000 | Role templates + portal/approve permissions; `manager_chain` approver. |
| 20270424000000 | Regularisation via the approval engine; portal punch v1. |
| 20270448000000 / 449 / 450 | Notes; review + leave deduction; report schedules. |
| 20270455000000 / 456000001 | Pairing mode; statement triggers; revoke internals. |
| 20270461000000..471000000 | Rules engine columns; reports bucket; scheduler cron; register RPC; full_day / grace / auto-deduct; sweep; notes report; selfie; incomplete status; windows. |
| 20270491000000..503000000 | Day-close; visibility RLS + view_all; manager routing v2; pay-effect fixes; non-working day + comp-off; no self-review; classifier + policy trigger + `status_source`. |
| 20270529000001 / 533000001 / 546000000 | Face match; late = arrival only; approved-leave guard. |
| 20270565000000 = 20270601000000 | `punch_events` as the single source of truth (the two files are identical). |
| 20270685000000 | Payroll LOP bridge. |
| 20272090000000 | Truthful `within_geofence` + backfill (policy trigger disabled during the backfill, then re-enabled). |

---

## 5. Permissions

### 5.1 Slugs

Constants: `/home/user/Flowza_Finance_V1/src/lib/permissions.ts` lines 768-966. Role-editor registry: lines 2340-2410.

| Slug | Gates |
|---|---|
| `hrms.attendance.view` | Attendance + Summary routes; see all notes in the comments report; see selfies. |
| `hrms.attendance.view_all` | RLS / RPC visibility of every employee (otherwise own + direct reports). |
| `hrms.attendance.manage` | Add / edit / bulk / share / grants; `process_punches`; UPDATE/DELETE RLS; `punch_events` writes; review notes as HR; selfie review; `send-attendance-report`; `attendance-push` admin paths; report bucket writes; schedules table. |
| `hrms.attendance_regularisation.view` / `.manage` / `.bulk_regularise` / `.approve` (+ DB-only `.reject`, `.return`) | Regularisation page, new request, bulk approve, engine approval; `.approve` also authorises note review as HR. |
| `hrms.holidays.view` / `.manage` | Holiday calendar page / edits. |
| `hrms.shifts.view` / `.manage` | Shift pages / form. |
| `hrms.workforce.view` / `.manage` | WorkforcePage; legacy device secret rotation. |
| `hrms.workforce_devices.view` / `.manage` | Devices & Punches, PIN mapping, geofences (RPC-enforced). |
| `hrms.leave.view` / `.view_all` / `.manage` / `.approve` (+ `.reject`, `.return`) | Leave (feeds on_leave and deductions). |
| `hrms.comp_off.view` / `.manage` | Comp-off page. |
| `hrms.approvals.view` / `.manage` / `.configure` | HR approvals inbox and policy config. |
| `ess.attendance.view`, `ess.attendance.checkin` | Employee self-service view and self check-in routes. |
| `portal.attendance.view`, `portal.shift.view`, `portal.approvals.view` | Employee portal tabs. |
| `reports.export` | Monthly summary CSV. |

### 5.2 Default grants found in migrations

| Grant | Roles | Source |
|---|---|---|
| holidays.\*, shifts.\*, regularisation view/manage/bulk | owner | 20260312\* |
| workforce view/manage + `ess.attendance.checkin` | `('owner','admin')`; the `admin` slug does not exist, so effectively owner | 20261107000000 |
| `ess.attendance.checkin` | employee | 20261107000000 |
| workforce_devices.\* | Owner + Accountant templates | 20261117030000 |
| workforce_devices.view | any template holding `hrms.workforce.view` | 20261117030000 |
| portal.\* and the leave / regularisation / change-request / letter approve-reject-return slugs | owner + org_admin | 20270417000000 |
| `hrms.attendance.view_all` | owner, org_admin, hr_admin, hr_manager, time_attendance_admin, accountant, auditor | 20270492000000 |
| `hrms.attendance.view` (backfill) | org_admin, hr_admin, hr_manager, time_attendance_admin | 20270492000000 |

- The role templates seeded in 20270417000000 include hr_admin, hr_manager, reporting_manager, time_attendance_admin ("Manages attendance, shifts and regularisation") and leave_approver.
- The owner grants of `hrms.attendance.view/manage` and `hrms.leave.*` are **not in any migration**; they are presumably pre-baseline data.
- 20270492000000 also renames a tenant's custom `backoffice_staff` role to "Time & Attendance Admin" and grants it view + view_all.

### 5.3 How "manager" is determined

- **No role or slug is involved.** A manager is whoever's employee row (`employees.user_id = auth.uid()`) is the subject's `employees.manager_id` or `employees.secondary_manager_id`. It is resolved live at call time, so re-orgs re-route automatically.
- **Direct reports only, for visibility.** `attendance_visible_employee_ids` and the note, selfie and report RPCs do not walk further up the chain.
- **Regularisation** uses the approval engine's `manager_chain` / `resolve_hr_approver`, with fallback to HR and then the owner.

### 5.4 Capability matrix

| Capability | Employee | Mapped manager (no HR slugs) | HR with view | HR with view_all | HR with manage |
|---|---|---|---|---|---|
| See own attendance, add reasons, portal punch, selfie (if granted) | yes | yes | yes | yes | yes |
| See team rows (RLS / register / daily summary) | own only | own + direct reports | own + reports | everyone | per view / view_all |
| Open /hrms/attendance | no (needs view) | no | yes | yes (needs view) | yes |
| Review / approve / excuse / ask info / reject notes | no, never own | yes, own reports (Approvals inbox + portal) | no | no | yes, all (oversight block) |
| Review selfies; toggle open-attendance grant | no | yes (grant toggle via RPC only; no UI) | selfies visible, cannot review | - | yes |
| Add / edit / bulk / delete records; Sync punches | no (legacy check-in edge fn inserts own row) | no | no (Sync fails) | no | yes |
| Share / schedule reports; manage devices / geofences | no | no | no | no | share: manage; devices: workforce_devices.manage |

---

## 6. Edge functions (`/home/user/Flowza_Finance_V1/supabase/functions/`)

`verify_jwt=false` in `supabase/config.toml` for attendance-checkin, workforce-checkin, attendance-ingest, attendance-adms, attendance-push, biometric-punch-ingest and hr-calendar-feed. `send-attendance-report` and `attendance-selfie-url` are **not** listed, so they use the platform default (JWT verified; the Phase D doc confirms `verify_jwt=true` for send-attendance-report).

**attendance-checkin** (legacy self check-in; used by `workforceStore.checkIn` and CheckInPage)
- **Auth:** the JWT is verified in the function body (`auth.getUser()`); all writes run as the **caller** (anon key + Authorization header).
- **Input:** `{organization_id, action: 'check_in'|'check_out', latitude?, longitude?, source?: 'web'|'mobile'}`.
- **Checks:**
  - Loads the caller's employee row, the active `attendance_policies` and the active `work_locations`.
  - 403 if the channel is disabled.
  - Haversine distance against each location's radius (default 200) gives `within_geofence` and `work_location_id`.
  - `enforce_geofence` → 422 without coordinates or when outside.
  - `enforce_ip_restriction` → 422 when the client IP is outside every location's `allowed_ip_ranges`.
  - The date is the org-local date in the policy timezone (default Asia/Muscat).
- **check_in:**
  - 409 if already checked in.
  - Insert or update: `check_in`, status `present` (a seed value the trigger reclassifies), coordinates, IP, `check_in_source`.
- **check_out:**
  - 409 if already checked out.
  - Without a check-in, it is allowed only after `work_end_time`, and writes an orphan check-out that the trigger marks `incomplete`.
  - Otherwise it updates `check_out`, coordinates, IP and source; hours come from the trigger.
- **Likely defect:** since 20270492000000, UPDATE RLS requires manage, so a plain employee's check-out UPDATE filters to 0 rows while the function returns `ok`.

**workforce-checkin** (PostGIS geofence path)
- **Auth:** the JWT is verified in-body; `checkin_punch` enforces self vs manage. The client IP is taken from gateway headers.
- **Input:** a single punch `{organization_id?, employee_id?, action: 'in'|'out', lat, lng, accuracy?, ts?, wifi_ssid?, is_mock?, source?}` or an offline batch `{punches:[...]}` (max 200; each keeps its original ts).
- **Writes:** via `checkin_punch` → `ingest_punch` → `punch_events` → recompute. Replays collapse through `dedup_hash`.
- **Returns:** `{received, accepted, rejected, flagged, errors, results}`; raw Postgres errors are masked.

**attendance-ingest** (LAN agent / partner REST)
- **Auth:** no JWT; `device_serial` + `token` validated via `resolve_device` (service role).
- **Input:** `{device_serial, token, punches:[{pin, time, verify?, state?, workcode?, lat?, lng?, accuracy?}]}`, with an optional `X-Punch-Source` header.
- **Writes:** `ingest_punch` per punch (device timezone applied), then `heartbeat`.

**attendance-adms** (ZKTeco ADMS/PUSH server)
- **Transport:** the device polls every 10-60 s; responses are text/plain.
- **Auth:** serial in `?SN=`, push token in `?pushver=` or an Authorization header, validated via `resolve_device`. No JWT.
- **Routes:**
  - `GET /iclock/cdata`: handshake (options include `TimeZone` from the device timezone, `Realtime=1`, `Stamp=9999`), plus heartbeat.
  - `POST /iclock/cdata?table=ATTLOG`: parses tab-separated lines and calls `ingest_punch` per line (counts ingested / duplicates / errors).
  - `OPERLOG` / `USERINFO`: stored raw in `punch_events` (no PIN, no dedup).
  - `GET /iclock/getrequest`: command poll + heartbeat.
  - `POST /iclock/devicecmd`: command acknowledgement.

**attendance-push** (generic vendor HTTP push + admin tools)
- Parsers: adms / hikvision_isapi / dahua_http / multipart; adapters for anviz / biotime / suprema; digest auth.
- **Device push (no JWT):** `POST /[sn/<serial>/t/<token>]?protocol=...`.
  - `resolve_device` on every request.
  - Parse → `ingest_punch` per punch, then heartbeat.
  - Tolerant: a parser error is logged and acknowledged, never a 500.
- **Admin `POST /setup`:**
  - Requires JWT + `user_has_permission(org, 'hrms.attendance.manage')`, **not** the workforce_devices slug.
  - Hikvision: probes `httpHosts` and `AccessControl` capabilities with digest admin credentials, and registers the platform's listen URL on the device.
  - Merges only non-secret probe metadata into `connector_config`.
  - Logs `attendance_device_setup`.
- **Admin `POST /pull`:** historical backfill (Hikvision `AcsEvent`, Dahua `recordFinder.cgi`) → `ingest_punch`.

**biometric-punch-ingest** (legacy)
- **Auth:** headers `x-device-key` + `x-device-secret`; the secret's sha256 is compared in constant time with `biometric_devices.ingest_secret_hash`.
- **Processing:**
  - Resolves `external_user_id` via `biometric_enrollments` (or the employee number).
  - Writes `biometric_punch_events` (raw) and upserts `attendance_records` **directly**, on the UTC date: `check_in_source` / `check_out_source = 'biometric'`, `device_id`, status `present`.
  - Logs `biometric_punch` per punch; updates `biometric_devices.last_sync_at`.
- It does not use `punch_events`.

**attendance-selfie-url**
- **Auth:** reads `attendance_selfie_checkins` in the **caller's** RLS context (own / view / manage / mapped manager); 403 otherwise.
- **Input:** `{checkin_id}`.
- **Output:** a 60-second signed URL from the private `attendance-selfies` bucket (service role), plus `captured_at`, lat/lng and accuracy.
- Logs `viewed`, attendance_selfie_checkin.

**send-attendance-report**
- **Auth:** JWT; the caller must hold manage in the org (checked in the caller's context).
- **Input:** `{organization_id, storage_path, period_label, channels[], recipient_mode: each_own|specific_employees|emails, recipient_employee_ids?, recipient_emails?}`.
- **Processing:**
  - Mints a 7-day signed URL for `storage_path` in `attendance-reports`, **without** checking that the path belongs to the org.
  - Resolves recipients from `employees` (no status filter) or from the fixed addresses.
- **Writes:**
  - email → `email_queue` rows (subject "Attendance report — {period}" with a download link);
  - in_app → `notifications` rows ("Your attendance report is ready", link `/hrms/self-service`);
  - whatsapp → `_shared/whatsapp/sender.ts sendWhatsApp` per phone number (internal recipient, the stored PDF as the document).
- **Returns:** `{emailed, whatsapped, notified, recipients}`.

**hr-calendar-feed** (not inventoried in detail)
- Token feed (`attendance_policies.calendar_feed_token`), consumed by the WorkforcePage calendar tab.

---

## 7. Notifications and emails

| Event | Recipient | Channel | Type / title / link | Source |
|---|---|---|---|---|
| Employee submits a reason | Primary manager, else secondary | in-app | `attendance_note_submitted`, "Attendance reason to review", link `/hrms/attendance` | `submit_attendance_note` |
| Employee submits a reason | Same manager | email_queue | subject "Attendance reason awaiting your approval"; HTML with the escaped note | `submit_attendance_note` |
| Manager / HR reviews a reason | Employee | in-app | `attendance_note_reviewed`; titles "Attendance reason approved" / "Attendance day excused" / "More information requested" / "Attendance reason rejected"; message appends the LOP or "N day(s) leave were deducted" text; link `/hrms/self-service` | `review_attendance_note_v2` |
| Selfie submitted | Primary manager, else secondary | in-app | `selfie_checkin_submitted`, "Selfie check-in to approve", link `/hrms/attendance` | `submit_selfie_checkin` |
| Selfie reviewed | Employee | in-app | `selfie_checkin_reviewed`, "Selfie check-in approved/rejected", link `/hrms/self-service` | `review_selfie_checkin` |
| Scheduled report (each_own / specific) | Each employee | email + in-app per `channels` | "Your attendance report — {period}" (HTML counts) / "Your attendance report is ready" (type `attendance_report`) | `run_attendance_report_schedules` |
| Scheduled report (emails mode) | Fixed addresses | email | "Attendance report — {period}" (org totals) | same |
| On-demand share | Employees / addresses | email / in-app / WhatsApp | see section 6 | `send-attendance-report` |
| Regularisation submitted / decided | Approvers / requester | approval-engine notifications | standard engine behaviour | `submit_for_approval_atomic` |

**Gaps:**
- The nightly sweep sends **no** notification.
- Notification-preference types `attendance_regularisation` and `shift_swap_request` exist (`/home/user/Flowza_Finance_V1/src/utils/notificationTriggers.ts`, `/home/user/Flowza_Finance_V1/src/pages/notifications/NotificationPreferencesPage.tsx`), but no code emits them.
- The SQL-created notifications bypass `notification_preferences`.

---

## 8. Report sharing and schedules (Phases C/D/E)

Docs are in `/home/user/Flowza_Finance_V1/docs/hr-portal/reports/`: `phase-C-report-sharing-plan.md`, `phase-C-attendance-sharing-applied.md`, `phase-D-storage-delivery.md`, `phase-E-scheduler-cron.md`.

**On demand** (Phase C part 1 + Phase D)
- **Where:** the Share panel on AttendancePage (manage).
- **Flow:**
  1. The browser generates the PDF (`AttendanceReportPDF` / `generateReportPdfBlob`) for the current range.
  2. It uploads to the private bucket `attendance-reports/<org_id>/<ts>-attendance.pdf` (20 MB, PDF/XLSX, org-folder RLS).
  3. It calls `send-attendance-report`.
- **Channels:** In-app / Email / WhatsApp (WhatsApp needs the org's configuration; best-effort).
- **Link validity:** 7 days.
- **Recipients:** the UI always sends `each_own`. The edge function also supports `specific_employees` and `emails`, but the UI does not expose them.

**Scheduled** (Phase C part 2 table + Phase E cron)
- **Config table:** `attendance_report_schedules`.
  - Cadence: **monthly only**. `run_day` 1-28.
  - Period rules:
    - `previous_month`;
    - `current_month_to_date`;
    - `custom_offset`: previous month's `period_from_day` → this month's `period_to_day`, e.g. 21 → 20.
  - Recipient modes: `each_own` (every employee in the org, with no status filter), `specific_employees`, `emails`.
  - Channels array; `format` pdf / excel / both (not used by the cron).
  - `is_active`, `next_run_at`, `last_run_at`.
- **Runner:** `run_attendance_report_schedules()` (service role only) via pg_cron `attendance-report-schedules-daily` at `'15 6 * * *'` (06:15 UTC). For each active schedule with `next_run_at <= today`:
  1. Compute the window.
  2. Per employee: count stored `attendance_records` statuses (present / absent / late / half_day / on_leave) plus hours. Derived register rows are **not** counted.
  3. Queue the email and/or in-app notification per `channels`.
  4. In `emails` mode, send org totals to the fixed addresses.
  5. Set `last_run_at = now()` and `next_run_at` = next month's `run_day`. This makes it idempotent per cycle.
- **Limitations:**
  - Scheduled delivery is an **HTML summary only**, never a PDF.
  - WhatsApp is on demand only.
  - SharePoint is deferred.
  - Schedules created in the UI hard-code channels `['in_app']`, so they never email.

---

## 9. Defects and design quirks to decide on before replicating

1. **Register visibility regression.** `get_attendance_register` (newest body in 20270493000003) lost the `attendance_visible_employee_ids` scoping; any org member can read the whole register. Verify live.
2. **Silent legacy check-out.** `attendance-checkin` writes as the caller, but UPDATE RLS needs manage, so an employee's check-out (and re-check-in on an existing row) is likely a silent no-op that returns `ok`.
3. **Cross-org report links.** `send-attendance-report` does not check that `storage_path` starts with `<organization_id>/`, so a manage holder could mint a link for another org's file if they know the path.
4. **Privacy of shared reports.** `each_own` sends the **same org-wide PDF** to every employee. Both the send-now and cron paths ignore employee status, so terminated and merged employees are included.
5. **Regularisation bypasses approvals.** Bulk approve on the regularisation page is client-side: it sets status `present`, writes raw TIME values into timestamptz, and never uses the approval engine or `apply_attendance_regularisation`. There is no per-row approve/reject UI.
6. **Shifts are cosmetic.** Swaps have no approve/reject UI; `shift_rotations` has no UI; shifts do not feed classification.
7. **Inconsistent non-working-day labels and calendars.** Device recompute uses `holiday` / `weekend` and ANY calendar; the classifier uses `holiday_work` / `weekly_off_work` and only the default calendar; the derived register uses only the default calendar.
8. **UTC date bugs.** Selfie approval and biometric-punch-ingest use the UTC date; manual Add uses browser-local time rather than the policy timezone.
9. **Config tables writable by any member.** RLS on `attendance_policies`, `work_locations`, holidays, shifts and geofences allows any org member to write; gating is UI-only.
10. **Page-level gating gaps on AttendancePage.**
    - It calls `process_punches` (manage-only) on every load, even for view-only users.
    - Sync, CSV, Excel and PDF are ungated.
    - Hours are flagged short at a hard-coded 8h.
11. **Minor UI bugs.** AttendanceSummaryPage empty-row colSpan is off by one. EmployeeAttendanceTab colours only present and absent.
12. **Store hygiene.** The regularisation store returns raw DB errors; stores perform no permission checks.
13. **Two geofence systems, not wired together.**
    - One: `work_locations` + policy flags, used by attendance-checkin.
    - The other: PostGIS `geofences`, used by workforce-checkin.
    - Recompute overwrites the legacy function's verdict on device-punch days.
    - `min_dwell_seconds` is unused; time windows use UTC.
14. **Sweep side effects.** The sweep charges stored rows only; fully derived absences are never charged. It sends no notification.
15. **Unused notification types.** `attendance_regularisation` / `shift_swap_request` exist in preferences but nothing emits them.
16. **Wrong permission on device setup.** `attendance-push` admin endpoints check `hrms.attendance.manage`, not `hrms.workforce_devices.manage`.

---

## 10. Feature checklist (acceptance)

**Register, filters and views**
- [ ] ATT-01 HR register route guarded by view; base tier.
- [ ] ATT-02 "Today" cards (Present/Absent/Late/Half Day/On Leave) from a daily-summary RPC scoped to visible employees.
- [ ] ATT-03 Table/Calendar view toggle; default range = current month.
- [ ] ATT-04 From/To range, employee select, client name search.
- [ ] ATT-05 Status chips with live counts for all ten statuses shown on the page.
- [ ] ATT-06 Load sequence: recompute punches in range, then stored rows, then derived register rows.
- [ ] ATT-07 Derived absent/on_leave rows get synthetic ids and a "Derived" badge, and are not editable or selectable.
- [ ] ATT-08 Hours column shows H:M, highlights short days (configurable threshold recommended), shows an overtime suffix.
- [ ] ATT-09 Expandable per-day punch timeline (time, state, source; first punch highlighted).
- [ ] ATT-10 Zone badge In/Out only when `within_geofence` is known (NULL renders nothing).
- [ ] ATT-11 Status colour map as in 1.1; unknown statuses gray.
- [ ] ATT-12 Calendar month grid: up to 3 names per day, "+N more", today highlight, legend, click-to-edit for manage.

**Add, edit and bulk**
- [ ] ATT-13 Add record (manage): employee\*, date\*, in/out, calculated hours, status + hint, notes.
- [ ] ATT-14 Edit record (manage): in/out, hours (blank = auto, step 0.5), overtime, status, notes.
- [ ] ATT-15 Live classifier preview drives the status until the user touches it; touched saves `status_source='manual'`.
- [ ] ATT-16 "Use auto status" link resets to engine-owned status.
- [ ] ATT-17 Block save on check-out before check-in (except night-shift policy wrap) and on blocked non-working days.
- [ ] ATT-18 Bulk select + "Set status" applies manual status to stored rows.
- [ ] ATT-19 Friendly error mapping for non-working-day, status CHECK, duplicate day.
- [ ] ATT-20 One record per employee per day enforced by a DB unique constraint.

**Exports and panels on the register**
- [ ] ATT-21 CSV export of the filtered range (Employee, Date, In, Out, Hours, Overtime, Status, Notes).
- [ ] ATT-22 Excel + PDF report with Employee No. and Zone columns and summary rows; export activity logged.
- [ ] ATT-23 Comments & approvals report panel (collapsible, hidden when empty) with leave-impact column and a formula-safe CSV.
- [ ] ATT-24 Open-attendance grants panel (manage): per-employee switch, search.
- [ ] ATT-25 Selfie review panel: thumbnail via short-lived signed URL, map link with accuracy, approve / reject with reason.

**Monthly summary**
- [ ] ATT-26 Month picker, per-employee counts (present/late/half/leave/absent/incomplete), days worked, total hours, overtime, avg/day, totals footer.
- [ ] ATT-27 Summary CSV gated on `reports.export`, activity-logged.

**Rules engine and policy**
- [ ] ATT-28 Policy singleton per org with every field in 4.1 and its defaults.
- [ ] ATT-29 Master switch `auto_status_enabled`; when off everything is present but hours are still computed.
- [ ] ATT-30 Arrival ladder: present ≤ start+grace (inclusive), late ≤ end, else `out_of_window_action` (late / absent / ignore).
- [ ] ATT-31 Half-day when hours < `half_day_hours` (not for absent).
- [ ] ATT-32 Late is an arrival judgement only (no short-day→late).
- [ ] ATT-33 Night-shift policy (end ≤ start) allows overnight hours.
- [ ] ATT-34 Working weekdays array (0=Sun..6=Sat).
- [ ] ATT-35 Missed-punch detection: lone check-out → incomplete immediately; lone check-in → incomplete after day close.
- [ ] ATT-36 Check-in / check-out windows decide the side of a single device punch; day close = check-out window end (+1 day if it wraps).
- [ ] ATT-37 Non-working-day handling: block / overtime / auto_label (holiday_work / weekly_off_work).
- [ ] ATT-38 Punch pairing mode first-in/last-out vs net-worked (sum of pairs, trailing odd = 0).
- [ ] ATT-39 Policy timezone (default Asia/Muscat) used for local dates.
- [ ] ATT-40 Server-side classifier + BEFORE trigger on non-device rows; TS mirror for preview only.
- [ ] ATT-41 `status_source` auto/manual; the engine never overwrites manual.
- [ ] ATT-42 Recompute never overwrites rows whose check-in/out source is manual.
- [ ] ATT-43 Derived register: holiday (default calendar) / on_leave (approved leave) / absent (past working days only) within hire/termination dates.
- [ ] ATT-44 Comp-off credit on non-working-day work (full/half thresholds, expiry, auto-approve setting, one per day).

**Punch ingestion and devices**
- [ ] ATT-45 Append-only `punch_events` with a dedup hash; the single source for device, portal and geo punches.
- [ ] ATT-46 Statement-level triggers recompute affected days after punch insert/update.
- [ ] ATT-47 Manual "Sync" recompute RPC (manage; service/cron allowed).
- [ ] ATT-48 Device registry: brand/model catalogue, integration method, site, timezone, serial (unique), enabled, status.
- [ ] ATT-49 Live device status from last_seen (online <5m, stale <60m, offline, never).
- [ ] ATT-50 Push-token provisioning + regenerate; per-method setup instructions and URLs.
- [ ] ATT-51 ZKTeco ADMS endpoint (handshake, ATTLOG ingest, OPERLOG/USERINFO raw store, command poll/ack, heartbeat).
- [ ] ATT-52 Generic HTTP push endpoint with vendor parsers (ADMS, Hikvision ISAPI, Dahua, multipart) tolerant of bad lines.
- [ ] ATT-53 Admin device probe/registration (Hikvision) and historical pull (Hikvision/Dahua) with digest auth; secrets never persisted.
- [ ] ATT-54 Agent/REST ingest endpoint authenticated by serial + token.
- [ ] ATT-55 Manual punch file import target with auto "MANUAL-IMPORT" device.
- [ ] ATT-56 PIN→employee mapping per device (unique), bulk mapping with collision detection, backfill of past punches.
- [ ] ATT-57 Unmapped-punch inbox grouped by device/PIN with count and last seen; assign employee.
- [ ] ATT-58 Punch log: date/device/status/employee filters, 50 per page, exact count, raw-payload viewer with copy.
- [ ] ATT-59 Legacy biometric device key/secret (sha256 at rest, shown once) + enrollments (optional; replicate only if needed).

**Geofencing and check-in**
- [ ] ATT-60 Circle / polygon geofences with enforcement hard_block / soft_warn / advisory_log.
- [ ] ATT-61 Tuning: accuracy threshold, grace radius, priority, require on check-in/out, active dates, weekly time windows.
- [ ] ATT-62 Wi-Fi SSID and IP CIDR co-validation; mock-location handling.
- [ ] ATT-63 Assignment scopes org / site / team / employee with precedence employee > team > site > org.
- [ ] ATT-64 Verdict precedence denied > flagged > logged > allowed; no fences = allowed (unknown).
- [ ] ATT-65 Denied punches not persisted; flagged accepted with warning.
- [ ] ATT-66 Map editor with draw tools, enable switch, preview check-in dry run.
- [ ] ATT-67 Truthful `within_geofence`: true only when a fence was evaluated and passed; NULL when unknown.
- [ ] ATT-68 Geo check-in endpoint accepting single or offline-batch punches (max 200) keeping original timestamps.
- [ ] ATT-69 Policy toggles for web/mobile check-in, geofence enforcement and IP restriction (legacy location model).

**Visibility**
- [ ] ATT-70 Visibility: own + direct reports (primary/secondary manager) unless view_all; super admin / service see all.
- [ ] ATT-71 RLS on attendance rows: select scoped; insert manage-or-own; update/delete manage.
- [ ] ATT-72 Punch visibility follows the same wall; punch writes manage-only.

**Reasons (attendance notes)**
- [ ] ATT-73 Employee reason per day with categories client_visit / field_work / late_reason / absence_reason / wfh / other.
- [ ] ATT-74 One active reason per employee-day; resubmission resets to pending.
- [ ] ATT-75 Submitting a reason reverses any earlier auto-deduction for that day.
- [ ] ATT-76 Manager notified in-app and by email on submission.
- [ ] ATT-77 Review queue "mine" (mapped reports only) and HR "all" oversight (manage or regularisation.approve).
- [ ] ATT-78 Queue rows show day status, excused-this-year count, oversight flag.
- [ ] ATT-79 Actions approve / excuse / ask info (comment required) / reject with required pay effect 0 / 0.5 / 1.
- [ ] ATT-80 No self-review; the reviewer's own notes are excluded from their queue.
- [ ] ATT-81 Approve and excuse restore deductions and clear loss_of_pay.
- [ ] ATT-82 Reject charges paid leave (ANNUAL > CASUAL > most remaining; special types excluded) or marks loss_of_pay.
- [ ] ATT-83 Pay-effect override limited to absent / late / incomplete; 0 means no charge.
- [ ] ATT-84 Never charge a day covered by approved leave.
- [ ] ATT-85 Employee notified of each decision with outcome-specific title and deduction/LOP text.
- [ ] ATT-86 The same approval list is rendered in the Approvals inbox and the employee portal; the badge counts pending reasons.

**Sweep and payroll**
- [ ] ATT-87 Opt-in nightly sweep auto-rejects unexplained absent/late/incomplete/one-sided days after N grace days.
- [ ] ATT-88 Sweep skips days with pending/approved/excused/info_requested notes, already-processed days, approved-leave days.
- [ ] ATT-89 Payroll read model: working days, LOP days, unpaid/paid leave days, claimable LOP note ids per active employee.
- [ ] ATT-90 LOP priced in payroll behind a preference, with a divisor choice; notes claimed per run and released on void.

**Regularisation**
- [ ] ATT-91 Request types missed_punch / wrong_punch / wfh_unmarked / system_downtime with expected in/out, reason\*, notes.
- [ ] ATT-92 Status pending / approved / rejected / cancelled with colours; cards and status chips.
- [ ] ATT-93 Submission through the approval engine with manager_chain routing and HR/owner fallback.
- [ ] ATT-94 Apply only after approval, idempotent via applied_at, sources marked "regularisation".
- [ ] ATT-95 Bulk approve (bulk_regularise) — replicate through the engine, not client-side.

**Selfie / open attendance**
- [ ] ATT-96 Per-employee open-attendance grant (HR or mapped manager).
- [ ] ATT-97 Private selfie bucket; employee uploads only to own folder; no direct read.
- [ ] ATT-98 Selfie submission requires a grant and a valid own path; manager notified.
- [ ] ATT-99 Manager/HR approve creates or fills the day's check-in (source selfie, present); reject with reason; employee notified.
- [ ] ATT-100 Optional advisory face-match result (write-once) behind a tenant toggle.
- [ ] ATT-101 Every selfie view is audit-logged; signed URL lasts 60 s.

**Holidays and shifts**
- [ ] ATT-102 Holiday calendars (name, year 2000-2100, state, default flag) with holidays typed public / restricted / company / regional / optional.
- [ ] ATT-103 The default holiday calendar drives derived holidays, the classifier and payroll working days.
- [ ] ATT-104 Shift master (type, times, grace, early-departure, break, weekly offs, night allowance, active; code upper-cased).
- [ ] ATT-105 Shift assignments with effective dates and department; monthly roster calendar with Off days.
- [ ] ATT-106 Shift swap requests (date, both employees and shifts, status) — add an approval step if replicating.

**Report sharing and schedules**
- [ ] ATT-107 Share now (manage): upload PDF to a private org-scoped bucket; deliver by in-app / email / WhatsApp with a 7-day link.
- [ ] ATT-108 Monthly schedules: run day 1-28; period previous month / month-to-date / custom offset; recipients each-own / specific / emails; channels; active toggle; next/last run.
- [ ] ATT-109 Daily 06:15 UTC scheduler sends per-employee HTML summaries (or org totals to addresses) and advances next_run.
- [ ] ATT-110 Schedule CRUD restricted to manage (RLS), activity-logged.

**Other surfaces**
- [ ] ATT-111 HR calendar feed URL with a regenerable token.
- [ ] ATT-112 Employee detail attendance tab with print-to-PDF.

**Permissions and platform**
- [ ] ATT-113 Permission catalogue as in 5.1, surfaced in the role editor; templates as in 5.2.
- [ ] ATT-114 HR Plus licence gate on shifts / workforce / devices / geofences / check-in routes and nav.
- [ ] ATT-115 Every mutation writes an activity-log row (entity types listed in section 2); SQL-side changes use a server logger.
- [ ] ATT-116 All SECURITY DEFINER functions lock search_path; internal helpers revoked from client roles.
- [ ] ATT-117 i18n namespaces: hrmsAttendance, hrmsLeave.holidayCalendar, hrmsShifts, hrmsOrgAnalytics.workforce, hrmsEmpDetailB, hrmsComponentsA.
