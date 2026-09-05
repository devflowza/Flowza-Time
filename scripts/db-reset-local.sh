#!/usr/bin/env bash
# Recreate the local `flowza` database: Supabase shim + all migrations (+ optional seed).
# Usage: scripts/db-reset-local.sh [--seed]   (env: PGHOST, PGPORT, PGUSER, PGDATABASE)
set -euo pipefail
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-54329}" PGUSER="${PGUSER:-postgres}"
DB="${PGDATABASE:-flowza}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
psql -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB with (force)" -c "create database $DB"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/00_local_supabase_shim.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo ">> $(basename "$f")"
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
done
# local passwords for the application roles (never used in hosted environments)
psql -d "$DB" -v ON_ERROR_STOP=1 -q -c "alter role flowza_api password 'flowza_api'; alter role flowza_worker password 'flowza_worker';"
if [ "${1:-}" = "--seed" ]; then
  echo ">> seed (deterministic TypeScript seed)"
  (cd "$ROOT" && DATABASE_URL_ADMIN="postgres://$PGUSER@$PGHOST:$PGPORT/$DB" pnpm --filter @flowza/database run seed:local)
fi
echo "database $DB ready"
