# Running Jamillion

Three moving parts: Postgres, the Drogon backend, the Vite frontend. Plus a one-off Python seed.

## 0. Environment

```bash
cp .env.example .env
```

`LASTFM_API_KEY` is the only key the catalog genuinely needs: it drives the top-500 ranking and the listen counts. `YOUTUBE_API_KEY` adds view counts. `SPOTIFY_CLIENT_ID/SECRET` now only fill in cross-reference ids. Deezer, MusicBrainz and iTunes need no key at all. The backend reads standard `PG*` variables; the scripts read `DATABASE_URL`. Load it into your shell with:

```bash
set -a; source .env; set +a
```

## 1. Database

Postgres runs as a project-local cluster in `data/pg`. No sudo, no system service, nothing to clash with an existing install:

```bash
scripts/pg.sh start
```

That initialises the cluster on first run, starts it on port 5432 and creates the `jamillion` database. `scripts/pg.sh stop` shuts it down and `scripts/pg.sh psql` opens a shell. Then load the schema:

```bash
scripts/pg.sh psql -f db/schema.sql
```

`db/schema.sql` is the schema's source of truth. The first row inserted into `users` becomes the admin (trigger), so register yourself first.

## 2. Seed the music catalog

```bash
python -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
scripts/seed.sh --artists Radiohead           # one artist, ~15 s, good smoke test
scripts/seed.sh --limit 500                    # the real thing, ~6 hours
```

`scripts/seed.sh` loads `.env` and runs the seeder inside the venv. It commits one artist per transaction, so it is resumable and safe to interrupt:

| Flag | Meaning |
|------|---------|
| `--start 213` | resume at rank 213 |
| `--artists "Radiohead" "Bjork"` | seed specific names instead of the chart |
| `--detail-cap 120` | tracks per artist that get an ISRC/BPM lookup, one request each |
| `--youtube-cap 25` | tracks per artist looked up on YouTube |
| `--lastfm-cap 25` | tracks per artist that get listen counts |
| `--no-youtube`, `--no-spotify` | skip those sources |

Caps apply to the most popular tracks first. Every other track still gets title, album, release date, duration, rank and a preview clip.

A full run is best backgrounded:

```bash
nohup scripts/seed.sh --limit 500 > data/seed.log 2>&1 &
```

Audio: the seed stores a preview URL per track. Deezer's links expire after about a day, so the downloader re-resolves a fresh one from the stored Deezer id. The clip is cached locally the first time a track is used in a quiz:

```bash
.venv/bin/python scripts/fetch_audio.py 12345      # -> data/audio/12345.mp3
```

## 3. Backend

Drogon is declared in `backend/CMakeLists.txt` and fetched into `backend/build/_deps` on first configure, so nothing framework-specific is installed system-wide. System packages needed: `cmake`, `gcc`, `postgresql-libs`, `openssl`, `zlib`, `jsoncpp`, `util-linux-libs` (uuid). On Arch:

```bash
sudo pacman -S --needed cmake gcc postgresql-libs openssl zlib jsoncpp util-linux-libs
```

```bash
cd backend
cmake -B build -DCMAKE_BUILD_TYPE=Release   # first run clones + builds Drogon, a few minutes
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
