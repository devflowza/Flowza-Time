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
echo "RLS tests passed"
