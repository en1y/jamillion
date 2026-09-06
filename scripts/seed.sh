#!/usr/bin/env bash
# Loads .env and runs the seeder with the venv python.
#   scripts/seed.sh --limit 500
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export SPOTIPY_CLIENT_ID=${SPOTIFY_CLIENT_ID:-} SPOTIPY_CLIENT_SECRET=${SPOTIFY_CLIENT_SECRET:-}
# spotipy caches its token here; keep it out of the project root
export SPOTIPY_CACHE_PATH=${SPOTIPY_CACHE_PATH:-data/.spotipy-cache}
exec .venv/bin/python scripts/seed_music.py "$@"
