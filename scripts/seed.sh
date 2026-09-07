#!/usr/bin/env bash
# Loads .env and starts the seeder in the background inside the venv. Output goes
# to data/seed.log, reset at the start of each run (previous run kept as seed.log.prev).
#
#   scripts/seed.sh --limit 500          # returns at once, prints the pid
#   tail -f data/seed.log                # watch progress
#   pkill -f seed_music.py               # stop it
#
# If the seeder dies within its first seconds (bad flag, missing key, DB down),
# the log is printed and the script exits 1 instead of leaving you to find out later.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export SPOTIPY_CLIENT_ID=${SPOTIFY_CLIENT_ID:-} SPOTIPY_CLIENT_SECRET=${SPOTIFY_CLIENT_SECRET:-}
# spotipy caches its token here; keep it out of the project root
export SPOTIPY_CACHE_PATH=${SPOTIPY_CACHE_PATH:-data/.spotipy-cache}

[ -x .venv/bin/python ] || { echo "no .venv: python -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt" >&2; exit 1; }
pgrep -f "python -u scripts/seed_music.py" >/dev/null && { echo "seed_music.py is already running (pkill -f seed_music.py to stop it)" >&2; exit 1; }

LOG=${SEED_LOG:-data/seed.log}
mkdir -p "$(dirname "$LOG")"
[ -s "$LOG" ] && mv -f "$LOG" "$LOG.prev"      # keep the previous run, start clean

echo "=== $(date '+%F %T')  seed.sh $*" > "$LOG"
# -u: unbuffered, so tail -f updates live instead of in 8 KB bursts
nohup .venv/bin/python -u scripts/seed_music.py "$@" >> "$LOG" 2>&1 &
pid=$!
sleep 3
if ! kill -0 "$pid" 2>/dev/null; then
    cat "$LOG" >&2
    echo "seeder exited immediately, see above" >&2
    exit 1
fi
echo "seeding in background (pid $pid). Watch it with:  tail -f $LOG"
