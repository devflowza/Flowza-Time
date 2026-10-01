#!/usr/bin/env bash
# Apply the repo's pending migrations to the hosted database, in file order, each in one transaction with its ledger row.
# Usage: DATABASE_URL_ADMIN=postgres://… scripts/db-migrate-hosted.sh [--check]
#   --check   list what is pending and exit 1 when anything is; writes nothing
# Env: MIGRATIONS_DIR (default supabase/migrations; tests point it elsewhere)
#
# The ledger is supabase_migrations.schema_migrations, matched by NAME — the file name without its timestamp and `.sql` —
# because that is how every hosted migration so far was recorded (Supabase MCP `apply_migration`: version = the time it ran,
# statements[1] = the file's exact text). The first 21 were recorded as `flowza_<last four digits of the version>_<name>`.
# `supabase db push` matches by version, which the hosted ledger does not share with the files, and would replay everything.
#
# Expand-first (AGENTS.md): every migration is additive and runs before the code that needs it, so the deploy applies them
# before the API and the workers. A file that fails is rolled back and nothing after it runs. A file with an uncommented
# `concurrently` cannot run inside a transaction: it runs statement by statement and is recorded after it completes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${MIGRATIONS_DIR:-$ROOT/supabase/migrations}"
URL="${DATABASE_URL_ADMIN:?DATABASE_URL_ADMIN is not set}"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1
PSQL=(psql "$URL" -X -q -v ON_ERROR_STOP=1)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! recorded="$("${PSQL[@]}" -At -c "select name from supabase_migrations.schema_migrations where name is not null")"; then
  echo "::error::Could not read supabase_migrations.schema_migrations (connection or ledger missing)."
  exit 1
fi

files=("$DIR"/*.sql)
pending=()
for f in "${files[@]}"; do
  base="$(basename "$f" .sql)"
  if ! [[ "$base" =~ ^([0-9]{14})_([a-z0-9_]+)$ ]]; then
    echo "::error::Unexpected migration file name: $base.sql (expected <14 digits>_<snake_case>.sql)."
    exit 1
  fi
  version="${BASH_REMATCH[1]}" name="${BASH_REMATCH[2]}"
  grep -qxF -e "$name" -e "flowza_${version: -4}_$name" <<<"$recorded" || pending+=("$f")
done

if [ "${#pending[@]}" -eq 0 ]; then
  echo "No pending migrations: the database has all ${#files[@]}."
  exit 0
fi
# A ledger without the very first file is not the ledger these migrations were applied with (wrong database, or a wiped
# ledger): applying "everything" there would replay the schema over live data.
if [ "${pending[0]}" = "${files[0]}" ]; then
  echo "::error::The ledger does not list the first migration ($(basename "${files[0]}")). Refusing to apply: check DATABASE_URL_ADMIN points at the production database."
  exit 1
fi

echo "Pending migrations (${#pending[@]} of ${#files[@]}):"
for f in "${pending[@]}"; do echo "  $(basename "$f")"; done
if [ "$CHECK" -eq 1 ]; then
  echo "::error::${#pending[@]} migration(s) not applied. Re-run the deploy with migrations: apply."
  exit 1
fi

for f in "${pending[@]}"; do
  base="$(basename "$f" .sql)"
  name="${base#*_}"
  # the file's exact bytes go into the ledger (byte parity with the repo), dollar-quoted under a tag the file cannot contain
  tag="m$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  if grep -qF "\$$tag\$" "$f"; then echo "::error::Quote tag collision in $base.sql; re-run."; exit 1; fi
  record="$TMP/$base.record.sql"
  {
    printf "insert into supabase_migrations.schema_migrations (version, name, statements, created_by)\n"
    printf "select greatest(coalesce(max(version::bigint) + 1, 0), to_char(clock_timestamp() at time zone 'utc', 'YYYYMMDDHH24MISS')::bigint)::text,\n"
    printf "  '%s', array[\$%s\$" "$name" "$tag"
    cat "$f"
    printf "\$%s\$], 'deploy-workflow'\n" "$tag"
    printf "from supabase_migrations.schema_migrations where version ~ '^[0-9]+\$';\n"
    # the repo migrator's own ledger (packages/database/src/tools/migrate.ts), kept in step where it exists
    printf "do \$do\$ begin if to_regclass('app.migrations') is not null then insert into app.migrations (name) values ('%s') on conflict do nothing; end if; end \$do\$;\n" "$base.sql"
  } >"$record"
  echo ">> $base.sql"
  if grep -qiE '^[^-]*\bconcurrently\b' "$f"; then
    "${PSQL[@]}" -f "$f" && "${PSQL[@]}" -1 -f "$record" || { echo "::error::$base.sql failed part-way (non-transactional file): inspect the database before re-running."; exit 1; }
  else
    "${PSQL[@]}" -1 -f "$f" -f "$record" || { echo "::error::$base.sql failed and was rolled back; the migrations after it did not run."; exit 1; }
  fi
  echo "   applied and recorded as '$name'"
done
echo "Applied ${#pending[@]} migration(s)."
