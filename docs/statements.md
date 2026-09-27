# Monthly attendance statements

Every month each employee receives their sign-in/sign-out statement by email as a personal review link: they check
the days, may comment on sign-in/out discrepancies (one comment per day), and digitally sign. A signature without
comments finalises the statement immediately; comments route it to the reporting manager, whose approval finalises
it. The statement body is an immutable snapshot of the daily records at issue time — what was signed can never drift
when records are recomputed later. Correcting a month = void the statement, fix the records, issue again.

## Lifecycle

```
ISSUE_MONTHLY_STATEMENTS (worker) ──▶ attendance_statements (ISSUED) ── email with link ──▶ employee reviews
                                                                                                │
                                              signs, no comments ───────────────▶ FINALIZED (EMPLOYEE_CONFIRMED)
                                              signs + comments ──▶ PENDING_APPROVAL ──▶ manager approves
                                                                       │                        │
                                                       notification to the resolved      FINALIZED (MANAGER_APPROVED)
                                                       approver (user or hr_admin role)
              HR void (before finalisation) ──▶ VOID (reissue allowed; the partial unique index ignores VOID)
```

- **Issue** — `POST /orgs/:orgId/statements/issue {month}` (`statement.issue`) enqueues `ISSUE_MONTHLY_STATEMENTS`
  on the `processing` queue, or the scheduler's hourly `statements-monthly-sweep` enqueues it automatically for
  organisations with `settings.reports.monthlyStatements.enabled` once their local calendar reaches `sendDay`
  (dedupe key `statements:<org>:<month>`). The handler builds one snapshot per employee with daily records in the
  month (reusing the report engine's context/roster/records loaders + `buildStatementSnapshot` in
  `packages/domain/src/statements/`), skips employees whose live statement already exists (idempotent, so re-runs
  and targeted `employeeIds` re-issues fill gaps), and emails each link. Per-employee email failures land on the row
  (`email_error`), never fail the job; `NO_EMAIL` marks employees without an address.
- **Token** — invitations pattern: the link carries `<organization_id>.<secret>`, only `sha256(secret)` is stored
  (`token_hash`), compared with `timingSafeEqual`. Validity = `linkValidityDays` (default 45). **Resend rotates the
  secret** (`SEND_STATEMENT_EMAIL`) because the plaintext cannot be recovered — the old link dies with the old hash.
- **Review** — `/statements/review?token=…` (web, outside the app shell; no account). The API endpoints are
  `POST /api/portal/statements/{view,submit}`: unauthenticated, POST-only so tokens stay out of access logs, their
  own tight IP rate bucket, and running in **system-for-org** context parsed from the token. `view` stamps
  `first_viewed_at`; `submit` validates comments against the snapshot's `commentable` days, writes the signature
  (typed name + time + IP + user agent) and transitions the status. The page renders the snapshot's prebuilt display
  strings in the statement's own locale — the page is the document.
- **Approval** — the approver is resolved like correction approvals: the manager's active membership
  (`org_memberships.employee_id = employees.manager_employee_id`), else the `hr_admin` system role. The outbox routes
  `statement.approval_pending` to the resolved user (`statement.approval_pending_role` to `statement.approve`
  holders for the fallback). Approving needs to be possible for a manager who holds **no** statement permission:
  the service accepts the assigned approver or a `statement.approve` holder, and RLS agrees (assignee policies).

## Snapshot

`snapshot` (jsonb, `statementSnapshotSchema` in `@flowza/contracts`) carries one row per **calendar day** — days the
engine has not produced render as pending rather than silently missing — with raw minutes/instants *and* the display
strings (clock, date, hours notation) fixed at build time, plus the totals block: required vs worked minutes with
signed difference, total delay (late minutes + late days), overtime, day counts, and every leave type taken
(comp-off, sick, … — whatever `leave_types` the tenant defines). `record_versions` pins the daily-record calculation
versions the snapshot was built from. DB triggers enforce: snapshot immutable, signature fields immutable once
signed, `FINALIZED`/`VOID` terminal, comments append-only.

## Authorization

| Action | Who |
|---|---|
| See statements | `statement.view` (branch-scoped), the employee (own rows), the assigned approver (theirs) |
| Issue / resend / void | `statement.issue` (owner, org_admin, hr_admin) |
| Approve | the assigned approver, or `statement.approve` within branch scope (owner, org_admin, hr_admin, branch_manager) |
| Employee submit/sign | the emailed token only (system-for-org context) |

RLS suites: `supabase/tests/rls_isolation.sql` (statements section) and `rls_system_context.sql`. The platform
context may read `organization_settings` (the sweep's only need) and still cannot read statements.

## Operations

- Jobs: `ISSUE_MONTHLY_STATEMENTS` (15 min timeout), `SEND_STATEMENT_EMAIL`; both on `processing`.
- Logs: `statements_issued` (created/skipped/emailed counts), `statement_email_failed`, `statements_sweep`.
- Settings: `reports.monthlyStatements {enabled, sendDay 1–28, linkValidityDays 7–90}` — Settings → Reports.
- Email: worker mailer (`EMAIL_PROVIDER`/`RESEND_API_KEY`, `WEB_PUBLIC_URL` builds the link). Console provider logs
  instead of sending — fine for development, invisible to employees in production.
- The month must be finished (and ≤ 24 months back) before it can be issued; the running month is refused.
