#!/usr/bin/env bash
# Nightly backup: the whole database, plus the audio cache.
#
#   0 5 * * *  /path/to/jamillion/scripts/backup.sh >> /path/to/jamillion/data/backup.log 2>&1
#
# Restore:
#   pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" data/backup/jamillion-20260911.dump
#
# The audio tarball is a convenience, not a requirement: a clip whose file is
# missing is re-downloaded on first use (see clip() in backend/src/quiz.cc).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

: "${DATABASE_URL:?DATABASE_URL is required}"
keep_days="${BACKUP_KEEP_DAYS:-14}"
stamp="$(date -u +%Y%m%d)"
mkdir -p data/backup

# public is the whole game, auth is the accounts it hangs off. Everything else
# in a Supabase database -- realtime's partitions, vault, storage, the extension
# grants -- belongs to the stack, is recreated by it, and only produces errors
# on the way back in.
pg_dump "$DATABASE_URL" --no-owner --format=custom -n public -n auth \
        --file="data/backup/jamillion-$stamp.dump"
[ -d data/audio ] && tar czf "data/backup/audio-$stamp.tgz" -C data audio

find data/backup -name 'jamillion-*.dump' -mtime "+$keep_days" -delete
find data/backup -name 'audio-*.tgz'      -mtime "+$keep_days" -delete

echo "$(date -u +%FT%TZ) backed up to data/backup/jamillion-$stamp.dump"
