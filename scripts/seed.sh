#!/usr/bin/env bash
# Loads .env and runs the seeder in the venv. Everything printed is shown on the
# terminal AND written to data/seed.log, which is reset at the start of each run
# (the previous run is kept as data/seed.log.prev).
#
#   scripts/seed.sh --limit 500                       # foreground, still logged
#   nohup scripts/seed.sh --limit 500 >/dev/null 2>&1 &   # background, still logged
#
# Then watch it with:  tail -f data/seed.log
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export SPOTIPY_CLIENT_ID=${SPOTIFY_CLIENT_ID:-} SPOTIPY_CLIENT_SECRET=${SPOTIFY_CLIENT_SECRET:-}
# spotipy caches its token here; keep it out of the project root
export SPOTIPY_CACHE_PATH=${SPOTIPY_CACHE_PATH:-data/.spotipy-cache}

LOG=${SEED_LOG:-data/seed.log}
mkdir -p "$(dirname "$LOG")"
[ -s "$LOG" ] && mv -f "$LOG" "$LOG.prev"      # keep the previous run, start clean
exec > >(tee "$LOG") 2>&1                       # everything from here on is logged

echo "=== $(date '+%F %T')  seed.sh $*"
# -u: unbuffered, so the log and any tail -f update live instead of in 8 KB bursts
exec .venv/bin/python -u scripts/seed_music.py "$@"
