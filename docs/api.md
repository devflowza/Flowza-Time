# FlowZa Time — API reference (`/api/v1`)

Conventions (blueprint §J): every org-scoped route carries `/orgs/:orgId/…` and the caller's membership is verified per
request; list responses are `{ data, meta: { page, pageSize, total, totalPages } }` (cursor lists: `meta.nextCursor`);
errors are `{ code, message, requestId, details? }`; long-running work answers **202** with `{ jobId, status: 'QUEUED', … }`;
job-creating POSTs accept an `Idempotency-Key` header (identical replay → same response + `idempotency-replayed: true`,
different body → `409 IDEMPOTENCY_CONFLICT`). Zod contracts live in `@flowza/contracts` (feature DTOs in
`packages/contracts/src/dto-features`, re-exported from the package root — the API and the web app import the same schemas;
PATCH bodies use `updateSchemaOf(...)` so no `.default()` is re-applied on partial updates).

> Core modules (me, organisations, members, roles, structure, employees, imports, search, audit, dashboard, platform) are
> documented by their own route files; this document covers the feature modules and the inbound device routes.

## Devices (`device.*` permissions)

| Method & path | Permission | Notes |
|---|---|---|
| `GET /device-providers?orgId=` | member | Registry definitions with `configSchema` (secret flags), `secretFields`, `throttling`, `supportsWebhook`, `pushProtocolKey`. Deprecated providers hidden; `provider_<x>` feature flags filter per organisation. |
| `GET /device-models?providerKey=` | member | `device_models` reference rows. |
| `GET /orgs/:orgId/devices` | `device.view` | Filters `branchId, status, connectionStatus, providerKey, tag, groupId, search, includeDecommissioned`; `employeeCount` from `device_employee_states`. |
| `POST /orgs/:orgId/devices` | `device.create` + branch | `createDeviceSchema`. Config is split by the provider definition: non-secret → `devices.config`, secrets → `DeviceCredentialsStore` (system context, second transaction). Plan/entitlement limit `devices` → `402 ENTITLEMENT_EXCEEDED`. Cloud providers cannot target private hosts. DEVICE_PUSH providers require a serial. Response (once): `{ device, pushToken, pushUrl, webhookUrl, credentialsStored, credentialsError, testConnectionJobId }`; non-push providers get a `TEST_CONNECTION` sync job. Audit `device.created` never contains secrets. |
| `GET /orgs/:orgId/devices/:id` | `device.view` | Includes `maskedCredentials`, `hasPushToken`, `groupIds`, `pushProtocolKey`. |
| `PATCH /orgs/:orgId/devices/:id` | `device.update` (`status` needs `device.manage`) | Changing `endpointUrl` deletes stored credentials (audit `device.credentials_invalidated`) and returns `credentialsRequired: true`. |
| `POST /orgs/:orgId/devices/:id/credentials` | `device.manage` | Body = record of the provider's secret fields only; stored encrypted, audit `device.credentials_changed`, event `device.credentials_changed`. Returns `{ version, masked }`. |
| `POST /orgs/:orgId/devices/:id/push-token/rotate` | `device.manage` | New token returned once; `push_token_hash`/`push_token_rotated_at` updated. |
| `DELETE /orgs/:orgId/devices/:id?decommission=` | `device.manage` | Disable (default) or decommission (expires pending commands, deletes credentials). |
| `POST /orgs/:orgId/devices/test-connection` | `device.create`/`update`/`manage` | `testConnectionSchema`; new device → in-memory config/credentials; `deviceId` → stored credentials only when the endpoint fields are unchanged; 10 s abort signal + provider throttler. Never returns secrets. |
| `GET /orgs/:orgId/devices/:id/logs` · `/employees` · `/commands` | `device.view` | Paginated `device_logs` (`level, event, from, to`), `device_employee_states` (+ employee), `device_commands` (`status`). |
| `POST /orgs/:orgId/devices/:id/actions/{sync-attendance\|sync-employees\|health-check\|reconcile\|restart}` | `device.sync` | 202 → sync job (capability-checked: `attendancePull`, `employeePush`, `remoteRestart` → 422 `DEVICE_UNSUPPORTED_OPERATION`; `sync-employees` fans out one `PUSH_EMPLOYEE` item per active employee of the device branch; `restart` is deduped per device, so a second reboot while one is pending answers `itemsSkipped: 1`). Audited as `device.action_<action>`. Same 202 body as the sync endpoints. |
| `GET/POST /orgs/:orgId/device-groups`, `GET/PATCH/DELETE …/:id`, `POST/DELETE …/:id/members` | `device.view` / `device.manage` | Groups may be branch-bound; members must belong to that branch. |
| `GET /orgs/:orgId/devices/summary?branchId=&includeDecommissioned=` | `device.view` | Fleet counts for the caller's branch scope: `total`, `byConnectionStatus`, `byStatus`, `staleHeartbeats` (active devices silent for 24 h). |
| `GET /orgs/:orgId/devices/pending?serialNumber=` | `device.create` | Unclaimed push devices attributed to the org, plus an exact-serial lookup for unattributed rows. |
| `POST /orgs/:orgId/devices/pending/:id/claim` | `device.create` + branch | `{ branchId, name, code, timezone?, modelId?, tags? }` → creates the device (provider/serial from the pending row, `integrationType = DEVICE_PUSH`), links `claimed_device_id`, returns the push token once. |

## Sync (`device.sync` to create, `device.view` to read)

| Method & path | Notes |
|---|---|
| `POST /orgs/:orgId/sync/attendance` | `syncAttendanceRequestSchema` (`deviceIds\|branchId\|groupId\|all`, `fullResync`) → one `PULL_ATTENDANCE` sync job, one item + queue job per pull-capable device in the caller's branch scope. 202 `{ jobId, status: 'QUEUED'\|'SUCCESS', itemsTotal, itemsQueued, itemsSkipped, deviceCount }` — an item whose pull is already pending (dedupe key `pull:<device>`) is `SKIPPED`, never polled twice; when every item was skipped the job is already `SUCCESS`. |
| `POST /orgs/:orgId/sync/employees` | `syncEmployeesRequestSchema` → `PUSH_EMPLOYEES` job with one `PUSH_EMPLOYEE` item per (device, employee); devices = explicit ids or all employee-push devices of each employee's branch; > 50 000 items → `400`. |
| `POST /orgs/:orgId/sync/health-check` · `/reconcile` | Device scope body; reconcile accepts `repair`. Both audited (`sync.health_check_requested`, `sync.reconciliation_requested`). |
| `GET /orgs/:orgId/sync/jobs` | `syncJobListQuerySchema` (`status, jobType, deviceId, branchId`, default newest first). |
| `GET /orgs/:orgId/sync/jobs/:id?status=&page=` · `GET …/:id/items` | Job + paginated items (`meta.items`). |
| `POST /orgs/:orgId/sync/jobs/:id/cancel` | PENDING/QUEUED items → CANCELLED, their queue jobs cancelled (`jobs.cancel`); job → CANCELLED when nothing is running. |
| `POST /orgs/:orgId/sync/jobs/:id/retry-failed` | New job (`parent_job_id`) with the FAILED/OFFLINE items of active devices. |
| `GET /orgs/:orgId/sync/reconciliation?branchId=&deviceId=` | Latest RECONCILIATION item/summary per device. |

Queue payload contract (queue `sync`): `{ syncJobId, syncJobItemId, organizationId, deviceId, employeeId, operation, options }`
— produced by the shared `createSyncJob` in `@flowza/database` (`packages/database/src/sync-jobs.ts`; the API wrapper
`apps/api/src/services/features/sync-jobs.ts` adds validation and runs it as a system step in the caller's transaction; dedupe
keys and per-operation options are documented in `apps/worker/src/handlers/sync/api.ts`).

## Attendance

| Method & path | Permission | Notes |
|---|---|---|
| `GET /orgs/:orgId/attendance/daily?date=` | `attendance.view` (or `attendance.view_own` → own rows) | `dailyAttendanceQuerySchema` + pagination + `sort` (`status, firstInAt, lateMinutes, workedMinutes`); `meta.byStatus`. |
| `GET /orgs/:orgId/attendance/monthly?month=` | same | Per-employee day grid + totals; `pageSize ≤ 100`; `meta.days`. |
| `GET /orgs/:orgId/attendance/records/:id` | same | Record + `trace`, attributed `events`, `history`, `corrections`. |
| `GET /orgs/:orgId/attendance/events?employeeId&from&to` | same | ≤ 62 days, branch timezone. |
| `GET /orgs/:orgId/attendance/raw` | `attendance.view_raw` | Cursor pagination (`cursor, limit`), filters `deviceId, branchId, from, to, processingStatus, deviceEmployeeId`. |
| `POST /orgs/:orgId/attendance/raw/:id/requeue` | `attendance.correct` + `view_raw` | unmatched/quarantined/held/error → pending + `NORMALIZE_RAW` (dedupe `normalize:<orgId>`). |
| `POST /orgs/:orgId/attendance/corrections` | own record: `attendance.request_correction` or `attendance.correct` (self-service types only, never auto-approved); anyone else: `attendance.correct` + (`attendance.view` in branch scope, or a direct report) | `createCorrectionSchema`; locked period → `409 PERIOD_LOCKED`; equivalent pending/approved → `409`. Submitted to the approval engine v2 (see Approvals): a matching workflow routes it; without one, an organisation-wide `attendance.view` + `attendance.approve` holder is auto-approved (the request row still exists), everyone else is routed to `attendance.approve` holders in reach (never the requester or the subject). Returns the correction + `approval: 'PENDING'\|'AUTO_APPROVED'` + `approvalRequestId`. |
| `GET /orgs/:orgId/attendance/corrections` | view | Filters `status, employeeId, branchId, from, to`. |
| `POST /orgs/:orgId/attendance/corrections/:id/cancel` | requester or `attendance.approve` | Pending only. |
| `GET /orgs/:orgId/approvals` (alias `/approvals/inbox`), `/approvals/history` | member (`scope=team` needs a team key, `scope=all` an organisation-wide key) | Approval engine v2 inbox: `approvalInboxQuerySchema` — `view` pending\|history, `scope` mine (my pending seats on the current level, or of an approver who delegates to me today — the organisation's date; the same definition as the dashboard count and `/me` `approvals.actionable`; not narrowed by my branch scope) \| team (direct reports) \| all, `entityType`, `status`, `employeeId`, `branchId`, `from`, `to`, `search` (employee name / number). Rows under the caller's RLS (current memberships only); names resolved in the organisation's system scope. Each row carries levels — actors in a deterministic order (written-at, then user id) and `pendingSeats`, the seats still waiting in SEAT ORDER (when the seat was first written, then the approver's user id) — actors (`onBehalfOfUserId` names the seat an override / escalated approver filled), context and `abilities` (`decideVia`: actor \| delegate \| escalated \| override; `mustChooseSeat`: the caller's override / escalated decision must name its seat). |
| `GET /orgs/:orgId/approvals/history/export` | `report.export` | The History view as CSV (same filters, ≤ 5000 rows, per-level audit cell, formula-escaped, UTF-8 BOM); audited with the row count. |
| `GET /orgs/:orgId/approvals/mine` | member | Requests I filed or that are about me. |
| `GET /orgs/:orgId/approvals/:requestId` | RLS (assignee, delegate, subject, requester, team, organisation-wide) | One request with its timeline. |
| `POST /orgs/:orgId/approvals/:requestId/decide` (aliases `/approve`, `/reject`) | one seat per call: a seated actor of the current level or their active delegate (their own seat); an escalated approver (one pending seat); an organisation-wide holder of the entity's approve key (with its organisation-wide view key, branch scope applies) or the owner — an override of ONE pending seat, only naming the level. A line manager (team-scoped key) never overrides. | `approvalDecideSchema`: `stepNo` REQUIRED (the level the caller saw; a non-current level or closed request → `409`), `decision`, `comment` (required to reject), `onBehalfOfUserId?` (the seat an override / escalated decision fills — REQUIRED on an ALL or QUORUM level with more than one seat waiting, else `400` "Choose which approver you are deciding for" with issue path `onBehalfOfUserId`; on an ANY level or a single waiting seat it defaults to the first of `pendingSeats`; a seat that is not waiting → `400`). The aliases take `{ comment?, stepNo? }`; without `stepNo` they decide only a seat the caller holds (an override → `400`). The level is then evaluated by its mode (ANY settles, ALL / QUORUM count one). The subject (current membership link or submit snapshot) never decides; the requester only in their own seat; the owner is the one exception (`sod_owner_bypass` event + audit). Repeating a decision on a seat already decided → no-op. Terminal outcome runs the entity hook. |
| `POST /orgs/:orgId/approvals/bulk-decide` | per request, as `decide` | `approvalBulkDecideSchema`: `items` (1–100 `{ requestId, stepNo, onBehalfOfUserId? }`, each request once) — each decided in its own transaction with every rule of `decide` (a line whose override needs a named seat and lacks one fails on its own with the same `400` message); one result line per request. |
| `POST /orgs/:orgId/approvals/:requestId/{cancel\|reassign\|bypass\|request-info\|answer-info}` | cancel: the requester, `approval.manage`/owner, or the entity's manage key with its organisation-wide view key (`leave.manage` / `attendance.correct`; branch scope applies) — never an approver who is only seated, never the subject of somebody else's filing (owner excepted, logged); reassign / bypass: `approval.manage` or owner, never on a request they filed or that is about them (owner excepted, logged); request-info: an approver, never the subject; answer-info: requester or subject, only while a question is outstanding (`409` otherwise) | `cancel` `{ reason }` (3–500 chars, required); `reassign` `{ userId, reason }` replaces the level's pending seats and lowers the requirement to min(required, approvals given + 1) — never onto the requester or the subject (`400`), nor somebody who already decided at the level (`409`); `bypass` `{ reason }` approves as an exception (open levels skipped, waiting approvers told); ask/answer keep the request pending. |
| `POST /orgs/:orgId/approvals/email-action` | the token's recipient | `{ token, action, comment? }` — single-use sha256-stored token from an e-mail, 7-day expiry, never acts on GET; decides the seat it was minted for (never an override). Rate-limited to 20/min per IP and per user; failed attempts are audited (`approval.email_token_failed`, an 8-character prefix of the token's hash, never the token). |
| `POST /orgs/:orgId/approvals/email-action/preview` | the token's recipient | `{ token, action }` — READ-ONLY summary of what a one-click link is about (entity type, person, day or leave dates and type, level, `actionable`), shown by the landing page BEFORE the approver confirms (notifications review 8-P0-1). The token must be the caller's own, unused, unexpired and for that action; it is never spent. Read from the request under the caller's own access (a request they cannot read is 404). Its own 20/min per-IP and per-user limit; failed previews are audited (`approval.email_token_preview_failed`, hash prefix only). |
| `GET/POST /orgs/:orgId/approval-workflows`, `PATCH/DELETE …/:id` | read: `attendance.view` / `leave.view` / `approval.manage` / `organization.manage`; write: `approval.manage` or `organization.manage` | `approvalWorkflowInputSchema` v2: 1–5 levels (`MANAGER`, `SECONDARY_MANAGER`, `MANAGER_CHAIN`+`chainLevel`, `HR_ADMIN`, `DEPARTMENT_HEAD`, `BRANCH_MANAGER`, `ROLE`+`permission`\|`roleId`, `USER`+`userId`), `mode` ANY\|ALL\|QUORUM (+`requiredCount`), `escalateAfterHours`+`escalateTo`, `appliesTo` (stored canonical: sorted, de-duplicated, lower-cased ids; a reordered copy of an active default → `409`), `minUnits` tiers. QUORUM > 1 (or ALL with a count > 1) is refused on single-seat approver types (`MANAGER`, `SECONDARY_MANAGER`, `MANAGER_CHAIN`, `DEPARTMENT_HEAD`, `USER`). No self-approval switch (`allowSelfApproval` is always `false` in the DTO). DELETE archives. |
| `GET/POST /orgs/:orgId/approval-delegations`, `DELETE …/:id`, `GET …/candidates` | own: `approval.delegate`; on somebody's behalf / all: `approval.manage` | Date window (the organisation's calendar date, `activeOnly` included) + optional entity types; the delegate acts alongside the approver, in the approver's seat, while the delegator is an active member. |
| `POST /orgs/:orgId/attendance/recalculate` | `attendance.recalculate` | `recalculateSchema` → `attendance_recalculation_requests` + `RECALCULATE_RANGE` (`processing`, `{ organizationId, requestId }`) → 202. |
| `GET /orgs/:orgId/attendance/recalculations` | `attendance.view` | Paginated requests. |
| `GET /orgs/:orgId/attendance/periods` | `attendance.view` | Locks (`branchId, includeUnlocked, year`). |
| `POST /orgs/:orgId/attendance/periods/lock` | `attendance.lock_period` | `periodLockSchema`; refuses when corrections are pending in the range; overlap → 409. |
| `POST /orgs/:orgId/attendance/periods/:id/unlock` | `attendance.lock_period` | `{ reason }` (≥ 3 chars), audited. Organisation-wide locks can only be released by unrestricted users (403 for branch-scoped callers, symmetric with lock). |

## Schedule

| Resource | Permissions | Notes |
|---|---|---|
| `/orgs/:orgId/shifts` (+ `/:id`) | `shift.view` / `shift.manage` | `shiftInputSchema`; delete refused (409) while assigned or referenced by a pattern; timing changes recompute from the earliest assignment. |
| `GET /orgs/:orgId/shifts/resolve?employeeId&date` | `shift.view` | `resolveShift` + `resolveRuleSet` from `@flowza/domain` over the org's assignments/patterns (employment history on the date, team memberships). |
| `/orgs/:orgId/shift-patterns` | `shift.view` / `shift.manage` | Sequence validated (known shifts, days < cycle, unique). |
| `/orgs/:orgId/shift-assignments` | `shift.view` / `shift.assign` | Branch resolved from the target (EMPLOYEE → employee branch, BRANCH → itself, DEPARTMENT/TEAM → their branch, ORGANIZATION → all-branch users only); overlap → `409 CONFLICT` (exclusion constraint); past-dated changes enqueue `RECALCULATE_RANGE` from `effectiveFrom` to today (`recalculationJobId` in the response). `PATCH` sets `effectiveTo`. |
| `/orgs/:orgId/holiday-calendars`, `/orgs/:orgId/holidays` | `holiday.view` / `holiday.manage` | Past holidays recompute the affected branches. Branch-scoped users can only create/change/delete holidays restricted to branches in their scope (organisation-wide holidays → 403). `POST /holidays` without `calendarId` adds the holiday to the organisation's default calendar, created ("Public holidays") when there is none; the organisation's first calendar is always its default. Calendars list their `branchCount`. |
| `/orgs/:orgId/leave-types`, `/orgs/:orgId/leave-records` | `leave.view` / `leave.manage` | Leave is APPROVED on create; overlap → 409; locked period → `PERIOD_LOCKED`; changes recompute the employee's range. `DELETE` cancels. |
| `/orgs/:orgId/attendance-rule-sets` | `attendance.view` / `attendance.manage_rules` | Effective-dated; overlap → 409; `version` bumps on update; changes recompute the branch/org from `effectiveFrom` (ranges over 366 days are split into several recalculation requests). Branch-scoped users cannot create, edit or delete the org-wide set (403). |

## Reports & payroll

| Method & path | Permission | Notes |
|---|---|---|
| `GET /report-types?orgId=` | member | Catalogue (`REPORT_TYPE_DEFINITIONS`, `status: 'available'` only — planned types are hidden and refused) with required/optional parameters, permissions, formats, orientation, default format and `allowed` for the org. Generation: `docs/reports.md`. |
| `POST /orgs/:orgId/leave-types/seed-defaults` | `leave.manage` | Adds the default GCC leave-type set (AL, CL, SL, EL, SPL, ML, NP unpaid, SD counts-as-present) for codes the organisation lacks; idempotent. New organisations get it automatically. |
| `POST /orgs/:orgId/reports` | `report.view` + type permissions | `createReportRequestSchema`; branch scope injected for restricted callers (`parameters.branchId` / `branchScope`); quota 20/hour/org via `usage_quotas` → `429 RATE_LIMITED`; `report_requests` QUEUED + `GENERATE_REPORT` (`reports`, `{ organizationId, reportRequestId }`) → 202. |
| `GET /orgs/:orgId/reports`, `GET …/:id` | `report.view` (own) / `report.manage` (all) | `report.manage` never widens beyond the caller's branch scope: other people's organisation-wide or foreign-branch reports are 404 for branch-scoped managers (list, detail, download, cancel). |
| `GET /orgs/:orgId/reports/:id/download?disposition=attachment\|inline` | same (or: the caller's own self-scoped copy with `attendance.view_own`) | COMPLETED only → `{ url, expiresInSeconds: 300, fileName, disposition }` via storage signed URL — `attachment` (default) downloads under `fileName`, `inline` is for the viewer; audit `report.exported` with row count and disposition. |
| `GET /orgs/:orgId/me/reports` | `attendance.view_own` + a linked employee | The reports about the caller that were shared with them (each employee's own copy, docs/reports.md), newest first. |
| `POST /orgs/:orgId/reports/:id/cancel` | same | QUEUED only. |
| `GET /orgs/:orgId/payroll/periods?year=&branchId=` | `payroll.view` | Periods from `settings.attendance.payrollPeriod` (`calendar_month` or `custom_cutoff` day) with lock status and summary counts. |
| `POST /orgs/:orgId/payroll/periods/build` | `payroll.view` | `{ periodStart, periodEnd, branchId?, employeeIds? }` → `BUILD_PERIOD_SUMMARY` (`processing`, `{ organizationId, periodStart, periodEnd, employeeIds?, branchId?, finalize: false, requestedBy }`) → 202. |
| `POST /orgs/:orgId/payroll/periods/finalize` | `payroll.finalize` | Requires an active lock covering the period (else 409) → same job with `finalize: true`. |
| `GET /orgs/:orgId/payroll/summaries?periodStart&periodEnd&branchId&status&search` | `payroll.view` | Paginated `attendance_period_summaries` with employee info. |

## Inbound (no JWT; device / vendor authentication)

### `ANY /device-push/:protocolKey/*`
1. `protocolKey` → `registry.pushProtocol()` (404 if unknown). Path passed to the handler is relative to `/device-push`
   (`/mock/<serial>/attendance`, `/iclock/cdata`). An optional path segment `~<token>` right after the protocol key carries
   the device push token for terminals that cannot set headers (`pushUrl` returned at registration); `x-device-token`,
   `?token=` and `Authorization: Bearer` are also accepted. Bodies above 2 MB → 413.
2. `identifyDevice` → 400 when no serial. Per-serial limit 60 req/min (429) in addition to the IP limiter.
3. Device lookup in platform context (`serial_number`, `integration_type = DEVICE_PUSH`, `status = active`, provider among
   those exposing this protocol). Unknown → `pending_devices` upsert (provider = first provider exposing the handler, 6-char
   claim code, remote IP, device info); handshakes/heartbeats get the protocol's own answer so the terminal keeps polling, but
   data uploads (punches, users, command results) are answered `401 unauthorized` — an `OK` would make the device discard
   punches nobody stored.
4. Known device → serial **and** push token required (`timingSafeEqual` on sha256; several candidates → the one whose token
   matches). A DEVICE_PUSH row without `push_token_hash` is refused (401, `device_push_no_token_configured`), never trusted on
   serial alone.
5. System-for-org transaction: `parseInbound(req, { timezone, serialNumber, stamps })` (stamps from `sync_cursors`
   stream `attendance`); data-bearing posts stored in `provider_webhook_events` (`device_push:<kind>`, status `processed`
   because ingestion is inline, `payload_hash = sha256(rawBody|path|query)`, payload = body sha256/size + protocol meta —
   never the body itself, which may carry biometric templates; duplicate → no re-ingestion, `device_logs` `push.duplicate`,
   still OK); pending commands are rendered one by one so an unrenderable command fails alone and only rendered commands are
   marked `sent`;
   heartbeat/liveness (`last_heartbeat_at`, `connection_status = online`, `config.lastSeenAt`, firmware/device info on
   handshake); stamps persisted; transactions ingested synchronously (`services/features/ingest.ts`: dedupe hash with device
   generation, `assumed_timezone`, `source = DEVICE_PUSH`, future punches → `quarantined`, locked period → `held`) and
   `NORMALIZE_RAW` enqueued; `heartbeat` polls receive up to 20 pending `device_commands` rendered by the handler (marked
   `sent`); command results → `acked`/`failed`, linked `sync_job_items` → SUCCESS/FAILED with job counters, and
   `device_employee_states` → IN_SYNC (`device_hash = payload.cloudHash`) / REMOVED / FAILED; OPERLOG user data → device-only
   `device_employee_states` rows.
6. Protocol errors answer the handler's HTTP status with the text `ERROR`; nothing internal leaks.

### `POST /webhooks/providers/:providerKey/:deviceId/:token`
Provider must implement `handleWebhook` (404 otherwise); device looked up in platform context; token checked against
`push_token_hash` (401); secrets loaded in system context; `provider.handleWebhook(req, secrets)` verifies the vendor signature
over the raw bytes **exactly once**; invalid signature → row `rejected` (body hash only) + 401; replay (same `event_id` or
`payload_hash = sha256(rawBody)`) → 200 `{ duplicate: true }`; accepted → row `queued` whose `payload` is the verified
normalised result `{ vendorDeviceId, eventType, transactions, rawBodySha256, rawBodyBytes, verifiedAt }` (never the raw body) +
`WEBHOOK_EVENT` (`sync`, `{ organizationId, webhookEventId, deviceId }`) and the provider's response. The worker ingests the
stored transactions and never re-parses or re-verifies (docs/sync-engine.md).

## Follow-ups for the integrator
- ZKTeco terminals post to `/iclock/*` at the root of the configured server URL: a reverse-proxy rewrite
  `/iclock/* → /device-push/iclock/~<token>/iclock/*` (per device) or a firmware that accepts a path in the server URL is required.
