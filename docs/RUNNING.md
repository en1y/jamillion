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

**Auth signing (v0.2.0).** The backend requires HS256 tokens signed with `SUPABASE_JWT_SECRET`. `auth.signing_keys_path` points to `legacy_signing_keys.json`, an intentionally empty list selecting legacy shared-secret signing instead of the CLI's default asymmetric key. This file contains no secret. For an existing local stack, restart Supabase after pulling this configuration (wait for any active catalog seeder to finish first). Do not reset the database. Sign in again after changing signing modes. A hosted Supabase project must also use the matching HS256 secret; ES256/RS256 verification is outside this milestone.

Apply additive migrations to an existing database without losing catalog data:

```bash
npx supabase migration up --local
```

**Auth.** Accounts live in Supabase Auth. A trigger on `auth.users` creates the matching `public.profiles` row, and the very first account becomes the admin. So sign yourself up first. Local signups do not send real email; confirmations land in Inbucket.

## 2. Seed the music catalog

```bash
python -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
scripts/seed.sh --artists Radiohead           # one artist, ~15 s, good smoke test
scripts/seed.sh --limit 500                    # the real thing, ~6 hours
```

The seeder writes straight to Postgres using `DATABASE_URL`, bypassing PostgREST and RLS.

`scripts/seed.sh` loads `.env` and starts the seeder in the background inside the venv, then returns straight away. Progress goes to `data/seed.log`, so watch it with:

```bash
tail -f data/seed.log
```

Each run starts a fresh log and keeps the previous one as `data/seed.log.prev`. If the seeder dies in its first seconds (bad flag, missing key, database down) the script prints the log and exits 1 instead of leaving it to be discovered later. It also refuses to start a second seeder while one is running:

```bash
pkill -f seed_music.py                                 # stop it
```

It commits one artist per transaction, so it is resumable and safe to interrupt:

| Flag | Meaning |
|------|---------|
| `--start 213` | resume at rank 213 |
| `--artists "Radiohead" "Bjork"` | seed specific names instead of the chart |
| `--detail-cap 120` | tracks per artist that get an ISRC/BPM lookup, one request each |
| `--youtube-cap 25` | tracks per artist looked up on YouTube |
| `--lastfm-cap 25` | tracks per artist that get listen counts |
| `--no-youtube`, `--no-spotify` | skip those sources |

Caps apply to the most popular tracks first. Every other track still gets title, album, release date, duration, rank and a preview clip.

Each artist prints as soon as it starts, so a quiet 40 seconds is normal, not a hang. If YouTube Music starts refusing requests, the seeder says so once and skips YouTube for the rest of the run; everything else still gets stored. Re-running the same command later fills in the missing video ids: every write is an upsert or a fill-where-null, so a re-run only fetches what is missing.

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

The backend reads the nearest `.env` above its working directory at startup, like the Python scripts do, so a CLion run configuration needs no environment setup. Variables already exported in the shell win over the file.

```bash
curl localhost:8080/api/health
```

Should return `{"ok":true,"tiers":6}`.

Track search requires a moderator/admin access token; all filters are optional:

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  'localhost:8080/api/tracks?q=love&artist=rihanna&year=2008&min_rank=50&limit=20'
```

`q` and `artist` are case-insensitive substrings, `year` is the release year, `min_rank` keeps only artists ranked at or above that position (`global_rank <= min_rank`), `limit` defaults to 50 and caps at 200. Results are ordered by Deezer popularity.

## 4. Frontend

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the root `.env` to the same public URL and anon key as `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Vite reads this file via `envDir`; only `VITE_*` values reach the browser. Never prefix the JWT secret or service-role key with `VITE_`. Restart Vite after changing these values. Without public config, the page supports guests and explains that sign-in is unavailable.

```bash
cd frontend
npm install
npm run dev
```

Vite serves on http://localhost:5173 and proxies `/api` to the backend on 8080 (see `frontend/vite.config.ts`).

## 5. First admin

Open the frontend, follow **Sign in** in the top right (the launchpad is the home page; auth lives at `/#/account`) and choose **Create account**. Email and password go directly to Supabase Auth through `@supabase/supabase-js`; there is no backend password endpoint. The first account is admin, including when two people sign up concurrently. Later accounts are users; signup metadata cannot choose a role. Duplicate usernames receive a numeric suffix. Local email confirmations are disabled; if enabled, the UI asks the user to confirm their email before signing in.

## 6. Player identity and role checks

```bash
curl -c /tmp/jam.cookies localhost:8080/api/me
curl -b /tmp/jam.cookies -c /tmp/jam.cookies localhost:8080/api/me
curl -b /tmp/jam.cookies -c /tmp/jam.cookies \
  -H "Authorization: Bearer $ACCESS_TOKEN" localhost:8080/api/me
```

`GET /api/me` returns `player_id`, `authenticated`, `role`, and `profile` (null for guests; otherwise `{id, username, role}`). Responses are `Cache-Control: no-store`. A supplied invalid token returns 401, never a guest fallback. Verification requires HS256, the configured issuer, `authenticated` audience and token role, an unexpired `exp`, and a UUID subject with an existing profile. App permissions come from `profiles`, so promotion/demotion takes effect on the next request. The default issuer is `SUPABASE_URL/auth/v1`; `SUPABASE_JWT_ISSUER` overrides it when the public address differs from the token issuer.

The signed `jam_player` cookie lasts a year, is HttpOnly, SameSite=Lax, and scoped to `/`. Set `COOKIE_SECURE=true` when serving over HTTPS. A valid guest row is linked atomically on sign-in, preserving its existing attempts. Linked cookies grant no account access without a token: sign-out or switching accounts creates a fresh player row. Multiple browser player rows can belong to one profile; history can be collected through `players.user_id`. Since v0.3.0 the daily attempt is deduplicated across those rows, so a signed-in player gets one flight a day whichever browser they use.

Backend routes attach `auth::Optional` first, followed by `auth::User`, `auth::Moderator`, or `auth::Admin` as needed. User requires sign-in, Moderator admits moderators/admins, and Admin admits only admins. Anonymous access to guarded routes returns 401; insufficient roles return 403. `/api/me` admits guests; `/api/tracks` requires Moderator. `/api/health` stays public.

Sign-out ends the Supabase session on this browser. Like other locally verified JWTs, an already issued access token remains valid until expiry; deleting its profile makes the backend reject it immediately.

## 7. Auth regression checks

With the local Supabase stack and backend running, load `.env` as above and run:

```bash
cmake -S backend -B backend/build -DJAMILLION_BUILD_TESTS=ON
cmake --build backend/build -j 4
ctest --test-dir backend/build --output-on-failure
.venv/bin/python backend/tests/auth_integration.py
.venv/bin/python backend/tests/quiz_play.py
cd frontend
npm run build
npm run lint
```

Both scripts share their fixtures through `backend/tests/common.py`. They use `psycopg` from `scripts/requirements.txt`, accept `TEST_API_URL` for another backend port, refuse non-local services, and create/delete only their own test accounts and player rows. `quiz_play.py` owns the current game day: it refuses to run if a quiz already exists for `game_today()`, and it needs at least one catalogue track with a preview. It covers quiz creation and its validation, one-at-a-time delivery, rarity tiering and moderator overrides, timeouts and skips, finishing, audio by question id, one flight per account across browsers, and that neither anonymous nor signed-in players can read the answer key, the question prompts and track ids, or call the scorer.

The integration script uses `psycopg` from `scripts/requirements.txt`, accepts `TEST_API_URL` for another backend port, refuses non-local services, and creates/deletes only its own test accounts and player rows. It checks real signup/login, concurrent first-admin creation, guest persistence/linking, concurrent account isolation, role changes, malformed/expired/forged tokens, deleted profiles, and answer-key RLS. On an empty auth database it also verifies the first-signup admin rule. Local email confirmation must be disabled for these tests.

## 8. Quiz play

The game day rolls over at **04:00 UTC**, not midnight: `game_today()` in the database is the one definition of "today", used by every route here.

**Publish a day's quiz.** Moderator or admin only. Exactly seven questions, positions 1 to 7, each with at least one accepted answer. `tier_id` on an answer is a moderator override that beats the computed rarity; leave it out to let the share decide. `published` defaults to true.

```bash
curl -X POST localhost:8080/api/quizzes -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{
  "quiz_date": "2026-09-08",
  "questions": [
    {"position": 1, "qtype": "rarest", "prompt": "Name a Radiohead album",
     "answers": [{"display": "OK Computer"}, {"display": "Kid A"}]},
    {"position": 2, "qtype": "song", "prompt": "Artist and title?", "track_id": 123,
     "snippet_start_sec": 12, "snippet_len_sec": 10,
     "answers": [{"display": "Radiohead Creep", "tier_id": 6}, {"display": "Radiohead", "tier_id": 2}]}
  ]}'
```

Find `track_id` with `/api/tracks` (section 3). Saving a song question downloads its clip first, by running `scripts/fetch_audio.py` through `.venv/bin/python` if that exists and `python3` otherwise; a track with no reachable preview fails the whole save with 422 rather than storing an unplayable quiz. Re-posting the same date replaces a quiz nobody has played yet, and returns 409 once it has attempts.

**Play.** Every route below needs the `jam_player` cookie from `GET /api/me`, so fetch that first (section 6).

```bash
curl -c /tmp/jam.cookies localhost:8080/api/me
curl -b /tmp/jam.cookies localhost:8080/api/quiz/today
curl -b /tmp/jam.cookies -X POST localhost:8080/api/attempts
curl -b /tmp/jam.cookies -X POST localhost:8080/api/attempts/1/answers \
  -H 'Content-Type: application/json' -d '{"question_id": 40, "text": "kid a"}'
```

`GET /api/quiz/today` is metadata only: the date, how many questions, how many players have finished, the tier legend, and your own attempt if you have one. It never carries a prompt or an answer.

`POST /api/attempts` starts or resumes the day's flight and hands back the current question. Questions arrive one at a time, and the timer starts when the question is served, so `started_at` and `deadline` come with it. Repeating the call returns the same question with the same `started_at`: a refresh buys no extra time. One attempt per player per day, and for a signed-in player one attempt per account, however many browsers they use.

`POST /api/attempts/{id}/answers` accepts only the current question. An answer arriving more than three seconds past the limit is stored as a timeout: no points, and it does not count towards anyone's rarity. Empty text is a deliberate skip and works the same way. Answering twice returns 409. The response carries the result and the next question, or `null` once the seventh is done.

```json
{"result": {"timed_out": false, "correct": true, "tier": "Main Sequence", "points": 30},
 "id": 9, "quiz_id": 5, "total_points": 30, "answered": 1, "finished": false,
 "question": {"id": 41, "position": 2, "...": "..."}}
```

Rarity is read as the answer lands: an accepted answer given by a share of players at or below a tier's `max_share` takes the rarest tier that fits, and the points are then frozen. The first player to give a correct answer therefore scores Nebula, exactly as in Krillion. A guess nobody has approved is still stored, with `is_correct` null, waiting for the v0.4 moderator review.

**Audio.** `GET /api/audio/{question_id}` streams the cached clip for a song question, and takes a question id rather than a track id on purpose: `tracks` is readable with the anon key, so publishing a track id would give the answer away. It serves the whole 30 s preview and the client plays the `snippet_start_sec` window. It answers 404 for anything that is not a published song question from today or earlier.
