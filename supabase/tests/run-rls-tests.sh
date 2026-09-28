#!/usr/bin/env bash
# Runs the RLS suites against a freshly reset local database.
set -euo pipefail
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-54329}"
DB="${PGDATABASE:-flowza_test}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGDATABASE="$DB" bash "$ROOT/scripts/db-reset-local.sh" >/dev/null
psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls_isolation.sql"
# fixtures were committed; the superuser-created temp functions are session-local, so re-run system checks as the worker login role
psql -U flowza_worker -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls_system_context.sql"
# HR attendance workspace (commits report-schedule fixtures of its own)
psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls_hr_workspace.sql"
# employee portal attendance self-service (HR portal Prompt 4): commits fixtures of its own on top of the isolation ones
psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls_portal_attendance.sql"
# leave v2 (self-contained on top of the isolation fixtures; commits rows to the leave v2 tables only)
psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls_leave.sql"
# notifications & reminders (HR portal Prompt 8): self-contained, every block rolls back
psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls_notifications.sql"
# approval engine v2 (after the other suites: it commits fixtures of its own on top of the isolation ones)
psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls_approvals.sql"
# security gate (HR portal Prompt 10): the data API login (PostgREST / pg_graphql) reads and writes nothing
psql -U authenticator -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls_data_api.sql"
# security gate: catalogue-driven invariants and the generated cross-tenant probes (last: they read every suite's fixtures)
psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls_invariants.sql"
echo "RLS tests passed"
