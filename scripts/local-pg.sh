#!/usr/bin/env bash
# Local PostgreSQL 16 cluster for FlowZa Time development/tests when Docker/Supabase local stack is unavailable.
# Usage: scripts/local-pg.sh start|stop|reset|status   (env: PGROOT, PGPORT)
set -euo pipefail
PGROOT="${PGROOT:-${HOME}/.flowza-pg}"
PGPORT="${PGPORT:-54329}"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA="$PGROOT/data"
RUN_AS=""
if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then RUN_AS="su postgres -c"; fi
run() { if [ -n "$RUN_AS" ]; then $RUN_AS "$*"; else bash -c "$*"; fi; }
init() {
  mkdir -p "$PGROOT"; [ -n "$RUN_AS" ] && chown postgres:postgres "$PGROOT"
  if [ ! -f "$DATA/PG_VERSION" ]; then
    run "$PGBIN/initdb -D $DATA -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null"
    echo "port = $PGPORT" | run "tee -a $DATA/postgresql.conf >/dev/null"
    echo "max_connections = 200" | run "tee -a $DATA/postgresql.conf >/dev/null"
  fi
}
case "${1:-status}" in
  start)
    init
    run "$PGBIN/pg_ctl -D $DATA -l $PGROOT/pg.log -w start" || true
    psql -h 127.0.0.1 -p "$PGPORT" -U postgres -tc "select 1 from pg_database where datname='flowza'" | grep -q 1 || \
      psql -h 127.0.0.1 -p "$PGPORT" -U postgres -c "create database flowza"
    echo "Postgres ready on 127.0.0.1:$PGPORT (db: flowza)";;
  stop) run "$PGBIN/pg_ctl -D $DATA -w stop" ;;
  reset)
    psql -h 127.0.0.1 -p "$PGPORT" -U postgres -c "drop database if exists flowza with (force)" -c "create database flowza";;
  status) run "$PGBIN/pg_ctl -D $DATA status" ;;
  *) echo "usage: $0 start|stop|reset|status"; exit 1;;
esac
