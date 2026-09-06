#!/usr/bin/env bash
# Project-local Postgres cluster. No sudo, no system service.
#   scripts/pg.sh start | stop | status | psql
set -euo pipefail
cd "$(dirname "$0")/.."
PGDATA=${PGDATA:-$PWD/data/pg}
PORT=${PGPORT:-5432}
export PGDATA

case "${1:-status}" in
start)
  if [ ! -d "$PGDATA" ]; then
    mkdir -p "$PGDATA" && chmod 700 "$PGDATA"
    pw=$(mktemp); printf 'jamillion' > "$pw"
    initdb -D "$PGDATA" -U jamillion --pwfile="$pw" \
           --auth-local=trust --auth-host=scram-sha-256 -E UTF8 >/dev/null
    rm -f "$pw"
  fi
  pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" \
         -o "-p $PORT -k $PGDATA -c listen_addresses=127.0.0.1" start
  until pg_isready -h 127.0.0.1 -p "$PORT" -q; do sleep 0.3; done
  createdb -h 127.0.0.1 -p "$PORT" -U jamillion jamillion 2>/dev/null || true
  ;;
stop)   pg_ctl -D "$PGDATA" stop ;;
status) pg_ctl -D "$PGDATA" status ;;
psql)   shift; psql -h 127.0.0.1 -p "$PORT" -U jamillion jamillion "$@" ;;
*) echo "usage: $0 {start|stop|status|psql}" >&2; exit 1 ;;
esac
