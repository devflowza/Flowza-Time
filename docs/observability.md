# Observability, SLOs and Alerting

## Logging
pino JSON with mandatory correlation fields (`requestId`, `jobId`, `correlationId`, `organizationId`, `deviceId` where relevant) and
redaction (`packages/shared/src/logging/logger.ts`). Key events: `http_request`, `request_error`, `unhandled_error`, `job_completed`,
`job_failed`, `dequeue_failed`, `scheduler_*`, `device_attendance_sync_completed`, `device_offline`, `provider_circuit_opened`,
`raw_quarantined`, `partition_created`, `retention_purged`.

## SLIs → SLOs (initial targets)
| SLI | Definition | SLO |
|---|---|---|
| Ingestion lag | now − min(`received_at`) of raw rows with `processing_status='pending'` per org | p95 < 2 min |
| Sync freshness | now − `devices.last_successful_communication_at` for active online devices | 99% < 3 × interval |
| Processing lag | time from event insert to daily-record `computed_at` | p95 < 60 s |
| API availability | non-5xx / total on `/api/v1/*` | 99.9% monthly |
| API latency | p95 per route class (list / detail / mutation) | < 400 ms / 150 ms / 300 ms |
| Job success | completed / (completed + dead) per job type | > 99% (excluding vendor outages) |
| Queue depth | pending jobs older than 60 s per queue | < 100 sustained |
| Dead letters | new `dead` rows per hour | 0 without an open incident |

## Alert catalogue
| Alert | Condition | Severity |
|---|---|---|
| Ingestion lag high | any org lag > 30 min (SEV2), > 2 h (SEV1) | SEV2/SEV1 |
| Default partition receiving rows | `attendance_raw_transactions_default` or `attendance_events_default` count > 0 | SEV2 |
| Partitions ahead < 6 months | maintenance job report | SEV3 |
| Circuit open for a vendor account > 15 min | `provider_circuit_states.state='open'` | SEV3 (SEV2 if > 25% of devices) |
| Device offline storm | > 20% of an org's devices offline within 10 min | SEV2 |
| Dead-letter burst | > 10 dead jobs / 10 min | SEV2 |
| Scheduler leader missing | no `scheduler_leader_acquired` heartbeat in 2 ticks | SEV1 |
| Clock skew | device skew > 5 min (warn) / > 60 min (quarantine) | SEV3 |
| Auth anomalies | > 20 failed logins / user / 10 min; platform grant created | Security channel |
| Queue bloat | `jobs.queue` dead tuples > 50% | SEV3 |

## Metrics export
Expose Prometheus-style metrics from the API/worker (`/metrics`, private network) or push OpenTelemetry: request counts/latency,
dequeue latency, jobs by type/outcome, raw rows ingested, records computed, provider call latency/error by provider, circuit states.
`/api/ready` already reports DB latency and queue depth for uptime checks.

## Connection budget (Supabase Small/Medium tiers)
API: 10 per instance × N instances (transaction pooler). Worker: 10 per process + 1 scheduler session connection (session pooler or
direct). Migrations/CI: 2. Keep the sum ≤ 70% of the tier's pooler limit; raise the tier before adding worker processes.
