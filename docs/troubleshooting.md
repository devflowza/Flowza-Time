# Troubleshooting & Support Runbook

Every API response carries `x-request-id`; every log line carries `requestId`, and job logs carry `jobId`/`correlationId`
(sync jobs expose `correlation_id`). Start from the id the customer gives you.

## "Attendance did not arrive"
1. **Device → FlowZa path.** `devices.connection_status`, `last_heartbeat_at`, `last_attendance_sync_at`, `last_error*`.
   Offline beyond `offline_threshold_minutes` → check network/vendor cloud; for push devices confirm the device's server URL
   and that its serial appears in `pending_devices` (unclaimed) or `devices`.
2. **Sync jobs.** `sync_jobs` / `sync_job_items` for the device: status, `last_error_code`, attempts; `sync_attempts` gives
   per-attempt timing/errors; `jobs.queue_archive` shows dead letters (`status = 'dead'`).
3. **Raw layer.** `attendance_raw_transactions` for the device/time range. Present but `processing_status = 'unmatched'` →
   the device user id is not mapped: fix `device_employee_states`/`employee_provider_identities` and re-run normalisation.
4. **Events → records.** `attendance_events` exist but `attendance_daily_records` missing/old → check the processing
   queue (`jobs.queue` job_type `RECOMPUTE_DAILY`) and period locks (`attendance_period_locks`).
5. **Cursor.** `sync_cursors` for the device — a cursor far in the future skips data; reset it and run a full re-sync.

## "Why is this employee late/absent?"
Open the daily record → `trace` (JSON): inputs (shift, rule set, timezone, holiday/leave), every punch with its
attribution role, and every rule step with values. Compare against `attendance_events` (voided ones are listed as IGNORED).

## "Employee did not sync to the device"
`device_employee_states` row for (device, employee): `sync_status`, `last_error`. `UNSUPPORTED` → provider capability is
false (see `docs/device-integrations.md`); `OFFLINE` → device unreachable; `FAILED` → vendor error text. Retry creates a
new `PUSH_EMPLOYEE` sync job.

## Common errors
| Symptom | Cause | Fix |
|---|---|---|
| `permission denied for table …` in API logs | A query ran outside `withContext()` (login roles are `noinherit`) | Wrap the call in `withContext` |
| Empty results although data exists | Caller lacks the permission or branch scope; RLS filtered it | Check membership role/branches; the service layer should have thrown FORBIDDEN first |
| `new row violates row-level security policy` | Write targets another tenant/branch or lacks the write permission | Verify `organization_id`/`branch_id` and permission |
| `P0002 attendance period is locked` | Period lock active | Unlock with reason (audited) or exclude the range |
| `LOCK_EXPIRED` requeues | Worker crashed/hung beyond `lock_timeout_seconds` | Check worker logs; raise the timeout for long pulls |
| Job `dead` with `NO_HANDLER` | Worker version does not know the job type | Deploy the matching worker version |
| Realtime progress not updating | Missing `SUPABASE_SERVICE_ROLE_KEY` on API/worker (publish is a no-op) or private channel policy | Set the key; UI falls back to polling |
| Migrations fail with `table … has no RLS` | New tenant table without policies | Add `app.apply_tenant_policies(...)` |

## Disaster recovery runbook
1. Declare incident, freeze deploys, note the last known-good time.
2. Database: Supabase dashboard → Backups → PITR restore to the timestamp (new project or in place per Supabase guidance).
3. Update `DATABASE_URL_*` / Supabase keys in the API/worker/web configuration if the project reference changed;
   set application role passwords again (`alter role flowza_api password …`).
4. Re-deploy API/worker; verify `/api/ready`; run the RLS suites against the restored database.
5. Re-sync attendance for the gap: run "Sync attendance" for all devices with `fullResync` — raw ingestion is idempotent.
6. Rotate credentials master keys only if compromise is suspected (re-encryption job).

## Useful queries
```sql
select * from jobs.stats();                                      -- queue depth by status
select * from jobs.queue_archive where status = 'dead' order by completed_at desc limit 50;
select device_id, connection_status, last_error from devices where connection_status <> 'online';
select processing_status, count(*) from attendance_raw_transactions where organization_id = $1 group by 1;
```
