# Running Jamillion

Three moving parts: Postgres, the Drogon backend, the Vite frontend. Plus a one-off Python seed.

## 0. Environment

```bash
cp .env.example .env
```

Fill in `SPOTIFY_CLIENT_ID/SECRET` (Spotify developer dashboard), `LASTFM_API_KEY`, and `YOUTUBE_API_KEY` (Google Cloud, YouTube Data API v3). The backend reads standard `PG*` variables; the scripts read `DATABASE_URL`. Load it into your shell with:

```bash
set -a; source .env; set +a
```

## 1. Database

```bash
sudo -u postgres psql -c "CREATE USER jamillion WITH PASSWORD 'jamillion';" -c "CREATE DATABASE jamillion OWNER jamillion;"
psql "$DATABASE_URL" -f db/schema.sql
```

`db/schema.sql` is the schema's source of truth. The first row inserted into `users` becomes the admin (trigger), so register yourself first.

## 2. Seed the music catalog

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/seed_music.py --limit 20 --no-youtube     # smoke test, ~2 min
python scripts/seed_music.py --limit 500                  # the real thing, hours
```

Resumable: `--start 213` continues from rank 213. `--artists "Radiohead" "Björk"` seeds specific names. YouTube lookups are capped at `--youtube-cap` tracks per artist (default 60, most popular first) because the search is one request per track.

Audio is fetched lazily per quiz track:

```bash
python scripts/fetch_audio.py 12345      # -> data/audio/12345.m4a
```

## 3. Backend

Needs Drogon. On Arch: `yay -S drogon` (or build from source, see the Drogon README).

```bash
cd backend
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
./build/jamillion
```

```bash
curl localhost:8080/api/health
```

Should return `{"ok":true,"tiers":6}`.

## 4. Frontend

```bash
cd frontend
npm install
npm run dev
```

Vite serves on http://localhost:5173 and proxies `/api` to the backend on 8080 (see `frontend/vite.config.ts`).

## 5. First admin

Register through the UI (or `POST /api/auth/register` once Phase 1 lands). That first account is the admin. Everyone after is a plain user until an admin promotes them.
