#!/usr/bin/env bash
# Apply the migrations a branch adds to a database that already holds data, the way production receives them.
#
# CI and db-reset-local.sh apply every migration to an empty database, where a backfill touches no row. Production is
# never empty: on 2026-10-13 the location hierarchy migration passed CI and then failed on the first production apply
# ("cannot ALTER TABLE ... because it has pending trigger events" — its backfill queued deferred checks only when
# organisations existed). This script reproduces the production order:
#   1. a fresh database with every migration the base branch already has,
#   2. the deterministic seed (organisations, branches, employees, devices, attendance…),
#   3. each migration the branch adds, in file order, in one transaction (`psql -1`) as scripts/db-migrate-hosted.sh does.
#
# Usage: bash scripts/db-migrate-populated-check.sh <base ref>   (e.g. origin/main; needs the merge base in history)
# Needs the workspace packages the seed imports built (pnpm --filter "@flowza/database^..." run build).
set -euo pipefail
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-54329}" PGUSER="${PGUSER:-postgres}"
DB="${PGDATABASE_POPULATED:-flowza_populated}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${1:?usage: db-migrate-populated-check.sh <base ref>}"

mapfile -t added < <(cd "$ROOT" && git diff --name-only --diff-filter=A "$BASE"...HEAD -- 'supabase/migrations/*.sql' | xargs -r -n1 basename | sort)
if [ "${#added[@]}" -eq 0 ]; then
  echo "No migration added since $BASE: nothing to apply on a populated database."
  exit 0
fi
is_added() { local f; for f in "${added[@]}"; do [ "$f" = "$1" ] && return 0; done; return 1; }

psql -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB with (force)" -c "create database $DB"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/00_local_supabase_shim.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do
  is_added "$(basename "$f")" && continue
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
done
psql -d "$DB" -v ON_ERROR_STOP=1 -q -c "alter role flowza_api password 'flowza_api'; alter role flowza_worker password 'flowza_worker';"

echo ">> seed (deterministic TypeScript seed, on the base branch's schema)"
(cd "$ROOT" && DATABASE_URL_ADMIN="postgres://$PGUSER@$PGHOST:$PGPORT/$DB" pnpm --filter @flowza/database run seed:local >/dev/null)
psql -d "$DB" -At -c "select 'populated: ' || (select count(*) from public.organizations) || ' organisations, ' || (select count(*) from public.branches) || ' branches, ' || (select count(*) from public.employees) || ' employees, ' || (select count(*) from public.devices) || ' devices'"

for name in "${added[@]}"; do
  echo ">> $name (one transaction, as the Deploy workflow applies it)"
  if grep -qiE '^[^-]*\bconcurrently\b' "$ROOT/supabase/migrations/$name"; then
    psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/migrations/$name" >/dev/null
  else
    psql -d "$DB" -1 -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/migrations/$name" >/dev/null
  fi
done
echo "The ${#added[@]} added migration(s) apply on a populated database."
