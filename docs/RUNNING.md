# Running Jamillion

Three moving parts: the Supabase stack (Postgres, Auth, Studio, all in Docker), the Drogon backend, the Vite frontend. Plus a one-off Python seed.

Prerequisites: Docker running, Node, CMake and a C++20 compiler, Python 3.

## 0. Environment

```bash
cp .env.example .env
```

`LASTFM_API_KEY` is the only key the catalog genuinely needs: it drives the top-500 ranking and the listen counts. `YOUTUBE_API_KEY` adds view counts. `SPOTIFY_CLIENT_ID/SECRET` now only fill in cross-reference ids. Deezer, MusicBrainz and iTunes need no key at all.

The `SUPABASE_*` values are printed by `npx supabase start` and by `npx supabase status`; paste them in after step 1. Load the file into your shell with:

```bash
set -a; source .env; set +a
```

## 1. Database

Postgres, Auth and Studio all run as Supabase's own Docker containers. No sudo, no system service:

```bash
npx supabase start
```

First run pulls a few GB of images and takes several minutes; after that it is seconds. It applies everything in `supabase/migrations/` automatically and prints your keys.

| What | Where |
|------|-------|
| Studio (table editor, SQL, auth users) | http://127.0.0.1:54323 |
| API / Auth | http://127.0.0.1:54321 |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| Inbucket (catches signup emails) | http://127.0.0.1:54324 |

```bash
npx supabase stop        # shut down, keeps data
npx supabase status      # reprint keys and ports
npx supabase db reset    # rebuild from migrations, then run supabase/seed.sql
```

`supabase/migrations/` is the schema's source of truth. Change it with `npx supabase migration new <name>`, never by editing the database by hand.

**Auth.** Accounts live in Supabase Auth. A trigger on `auth.users` creates the matching `public.profiles` row, and the very first account becomes the admin. So sign yourself up first. Local signups do not send real email; confirmations land in Inbucket.

## 2. Seed the music catalog

```bash
python -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
scripts/seed.sh --artists Radiohead           # one artist, ~15 s, good smoke test
scripts/seed.sh --limit 500                    # the real thing, ~6 hours
```

The seeder writes straight to Postgres using `DATABASE_URL`, bypassing PostgREST and RLS.

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

`seed.sh` always writes `data/seed.log` as well as printing to the terminal. Each run starts a fresh log and keeps the previous one as `data/seed.log.prev`, so no redirection is needed:

```bash
nohup scripts/seed.sh --limit 500 >/dev/null 2>&1 &   # background
tail -f data/seed.log                                  # watch it
pkill -f seed_music.py                                 # stop it
```

Each artist prints as soon as it starts, so a quiet 40 seconds is normal, not a hang. Occasional `! ytmusic ...` lines are YouTube Music throttling; the seeder backs off and skips YouTube for that artist after 20 refusals. Everything else still gets stored.

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
