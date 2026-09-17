# Running Jamillion

**With Docker** (below) is how to run it: the images are on Docker Hub, one `compose.yaml` brings up Postgres, Auth, the backend and the site on one origin, and the first visit to the site sets it up. Prerequisite: Docker with the compose plugin. Nothing else — no checkout, no `.env`.

**Development** (sections 0–4) runs the same pieces loosely instead — the Supabase CLI stack, the backend from CMake, Vite with hot reload — for working on the code. Prerequisites there: Docker, Node, CMake and a C++20 compiler, Python 3.

## Run it with Docker

```bash
mkdir jamillion && cd jamillion
curl -fsSLO https://raw.githubusercontent.com/en1y/jamillion/main/compose.yaml
docker compose up -d
```

Then open **http://localhost:8000**. Plain HTTP, no certificate warning and no privileged port: a certificate for `localhost` would be Caddy's own CA, which every browser distrusts. `HTTP_PORT=9000 docker compose up -d` serves it somewhere else; *On a server*, below, is the HTTPS case.

### First visit: the setup page

Until the site has an admin and a catalog, every visitor gets the setup page instead of the game:

1. **Create the admin account.** Username, email, password. This is the only account that can ever be made admin by signing up — the first one — so do it before sharing the address.
2. **Fill the catalog.** Paste the keys and choose how many artists to seed:

   | field | |
   |---|---|
   | Last.fm API key | required — free at <https://www.last.fm/api/account/create>; it drives the artist chart and the listen counts. Checked against Last.fm before anything is saved. |
   | YouTube Data API key | optional — exact view counts |
   | Spotify client id / secret | optional — cross-reference ids; skipped when empty |
   | Artists to seed | biggest first, about 45 s each: 50 is ~40 minutes, 500 is ~6 hours |

3. **Launch.** The keys are saved and the seeder starts in the background; the page shows how far it has got and can be closed. The site works meanwhile, and the admin writes the first day's questions on the flight deck as soon as there are artists to write them from.

**Where the keys go.** They are sent once, to `POST /api/setup`, which only the admin may call, and written to `settings.json` in the `config` volume: mode `0600`, owned by the backend's user, mounted into the backend container and nothing else. No route returns them — the status the page reads says only whether a Last.fm key is set. They are not in any image, any `.env`, or the database, so `pg_dump` does not carry them either. The stack's own secrets — the JWT secret, the database password — are generated on first boot into the `secrets` volume and never need to be seen at all.

### Day to day

```bash
docker compose logs backend         # the startup summary, below
docker compose exec backend tail -f data/config/seed.log   # the seeder
docker compose pull && docker compose up -d                # update to the latest images
docker compose stop                 # stop everything, keep it all
docker compose down                 # remove the containers, keep the data
docker compose down -v              # wipe: database, secrets, keys, audio, certificates
```

An update pulls new images and restarts; the `migrate` one-shot applies whatever migrations the new database image carries, and the data, secrets and keys stay where they are. Pin a release with `JAMILLION_VERSION=1.0.2 docker compose up -d` instead of following `latest`.

The backend's startup summary is the first thing to read when something looks wrong:

```
jamillion 1.0.2 is up

    open         http://localhost:8000
    first run    nobody has set it up yet -- open http://localhost:8000 to create the admin account and start the catalog

    database     postgres@db:5432/postgres, 18 migrations, schema 20260910160000
    auth         tokens from http://localhost:8000/auth/v1
    accounts     0 (0 admin)
    catalog      0 artists, 0 tracks -- empty, the setup page seeds it
    quizzes      0 published, today's is not published yet

    ports        frontend  http://localhost:8000
                 backend   :8080, proxied at http://localhost:8000/api
                 supabase  http://localhost:8000 -- auth /auth/v1, rest /rest/v1
    rate limits  on
    body cap     256 kB, database timeout 5 s
```

The numbers come from the database, so a summary with numbers is also the proof the backend reached it. When it cannot, the same place says the database is not answering and why.

### More artists later

The setup route stays available to the admin. Adding artists, or replacing a key, is the same call with the admin's access token (from the browser's session, or a sign-in against `/auth/v1/token`):

```bash
curl http://localhost:8000/api/setup -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"artists": 200}'
```

It seeds the top 200 on the chart; artists already in the catalog are refreshed rather than duplicated, and only missing data is fetched. One seeder runs at a time (a second call answers 409), and it commits an artist at a time, so a restart of the backend container — which stops it — keeps everything it had done. Section 2 covers what it fetches.

### On a server

Point a DNS name at the machine, open ports 80 and 443, and put four lines in a `.env` beside `compose.yaml`:

```
SITE_ADDRESS=https://jamillion.example.com
HTTP_PORT=80
HTTPS_PORT=443
COOKIE_SECURE=true
```

Then `docker compose up -d`. `SITE_ADDRESS` is the whole address, scheme included: `https://` is what tells Caddy to get a Let's Encrypt certificate, and the ports have to be the standard pair because that is where the certificate authority comes looking. `COOKIE_SECURE=true` marks the guest cookie HTTPS-only — leave it off over plain HTTP, where the browser would drop it and every request would arrive as a new guest. The same `SITE_ADDRESS` is the token issuer GoTrue signs with and the backend checks, so changing it later signs everyone out.

Visit it before anyone else does: the first account created is the admin.

### What is running

It starts in this order, each step waiting for the previous one to be healthy or done:

| service | image | what it is |
|---|---|---|
| `setup` | `en1y/jamillion-backend` | one-shot: generates the JWT secret, the database password and the anon key into the `secrets` volume, once (`docker/setup.py`) |
| `db` | `en1y/jamillion-db` | Supabase's Postgres image, the tag the CLI runs, with the migrations baked in |
| `auth` | `supabase/gotrue` | sign-up and sign-in |
| `migrate` | `en1y/jamillion-db` | one-shot: applies the migrations that are not applied yet (`docker/migrate.sh`) |
| `rest` | `supabase/postgrest` | for the one RPC the browser makes (`quiz_ceilings()`) |
| `backend` | `en1y/jamillion-backend` | the Drogon server; it also runs the seeder the setup page starts |
| `web` | `en1y/jamillion-web` | Caddy: the site, `/api`, `/auth/v1` and `/rest/v1` on one origin, published on `HTTP_PORT` (8000) and `HTTPS_PORT` (8443) |

| volume | holds |
|---|---|
| `db` | Postgres |
| `secrets` | the generated JWT secret, database password and anon key |
| `config` | the keys from the setup page, and the seeder's log |
| `audio` | preview clips, a cache — a missing one is downloaded again |
| `caddy_data`, `caddy_config` | certificates |

- **Only the Supabase pieces the app calls.** The browser uses auth and one RPC, so
  there is no Kong, Studio, storage, realtime or mail server; Caddy does Kong's
  routing. Only Caddy publishes a port. To look inside the database:
  `docker compose exec db psql -U supabase_admin -h 127.0.0.1 -d postgres`.
- **Caddy listens on 80 and 443 inside the container whatever the deployment**, and
  the published ports are what change; it matches the site on the hostname and
  ignores the port the `Host` header carries, so `http://localhost` in the
  Caddyfile answers `http://localhost:8000`.
- **One origin for all of it**, which is what makes CORS unnecessary. supabase-js
  is pointed at the page's own origin, and the anon key reaches the browser at
  runtime through `/config.js`, which Caddy serves out of the `public/` corner of
  the secrets volume — nothing else in that volume is mounted into Caddy. So one
  web image serves every deployment.
- **The `secrets` and `db` volumes live and die together.** The passwords are
  written into the database once, at initdb (`docker/roles.sql`). Dropping one
  volume without the other leaves services that cannot log in: `down -v` removes
  both, which is the only way to start over.
- **There is no mail.** `GOTRUE_MAILER_AUTOCONFIRM` is on, matching
  `enable_confirmations = false` in `config.toml`, so sign-up works without SMTP.
  Password recovery does not until `GOTRUE_SMTP_*` is set on `auth`.
- The migrations are recorded in `supabase_migrations.schema_migrations`, the CLI's
  own table, so the two ways of applying them agree on what has been applied.
- `COOKIE_SECURE=true` is set for the backend, because Caddy terminates TLS in
  front of it. The backend is health checked over `/api/health`, so an unhealthy
  container is also the answer to "can it still see Postgres", and the site waits
  for it rather than answering 502.

### Backups

```bash
docker compose exec -T db pg_dump -U supabase_admin -h 127.0.0.1 -d postgres \
    -n public -n auth -Fc > jamillion-$(date -u +%Y%m%d).dump
docker compose exec -T db pg_restore -U supabase_admin -h 127.0.0.1 -d postgres \
    --clean --if-exists --no-owner < jamillion-20260913.dump
```

Section 4c explains the schema choice and why a restore into an empty database reports errors that are not data loss. The audio volume does not need backing up. The keys are not in the dump: re-enter them through `/api/setup` after restoring onto a new machine.

### Building and publishing the images

From a checkout, `compose.build.yaml` adds the build steps on top of `compose.yaml`:

```bash
# run what is checked out, built locally
docker compose -f compose.yaml -f compose.build.yaml up --build -d

# publish a release: the version from backend/CMakeLists.txt, and latest
docker login
for tag in 1.0.2 latest; do
  JAMILLION_VERSION=$tag docker compose -f compose.yaml -f compose.build.yaml build
  JAMILLION_VERSION=$tag docker compose -f compose.yaml -f compose.build.yaml push backend db web
done
```

The second build of the loop is all cache. Three images carry the project — `jamillion-backend`, `jamillion-db`, `jamillion-web` — and the other two services run Supabase's own images unchanged.

---

# Development

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

| What                                   | Where                                                     |
|----------------------------------------|-----------------------------------------------------------|
| Studio (table editor, SQL, auth users) | http://127.0.0.1:54323                                    |
| API / Auth                             | http://127.0.0.1:54321                                    |
| Postgres                               | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| Inbucket (catches signup emails)       | http://127.0.0.1:54324                                    |

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

Signed-in moderators and admins get a **catalog dashboard** at `/catalog` (the `catalog` chip in the dock, and a one-line link from the flight deck): catalog size, the state of the current or last run, and the gaps -- artists that failed, with the reason and how many attempts they have had, and artists whose row exists with no tracks under it. It refreshes every twenty seconds, every five while a run is moving. `GET /api/seeder` is the staff-only endpoint behind it and returns counts, run state, failures and empty artists, never catalog keys or raw logs.

From the dashboard, staff tick any of those gaps and retry them **in one run**, paste a list of names to run, or rerun the top-N chart. `POST /api/seeder` accepts either `{"artists":["Radiohead","Bjork"]}` (1-200 names) or `{"limit":500}`. A second run is refused while one is active. Artist runs leave chart rank unchanged. `DELETE /api/seeder/failures` with the same `artists` list drops failures nobody intends to chase; seeding one again puts it back if it fails again.

Failures live in `catalog_failures` (name, reason, attempts, last try), written by the seeder and deleted the moment that artist lands, so the list survives restarts and reruns instead of vanishing with the run that produced it.

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
| `--lastfm-cap 25` | tracks per artist that get listen counts |
| `--yt-albums 60` | albums + singles per artist read on YouTube Music |
| `--yt-refresh` | re-read play counts that are already stored |
| `--no-youtube`, `--no-spotify` | skip those sources |

Caps apply to the most popular tracks first. Every other track still gets title, album, release date, duration, rank and a preview clip.

Each artist prints as soon as it starts, so a quiet 40 seconds is normal, not a hang. Re-running the same command later fills in what is missing: every write is an upsert or a fill-where-null, so a re-run only fetches what is not there yet.

YouTube gives two different numbers and the seeder stores both. `tracks.ytmusic_plays` is the figure the YouTube Music app shows under a song -- plays summed over every upload of that recording, so 3 B for Smells Like Teen Spirit where its art track alone has 280 M views. Only the app's private API serves it, so `ytmusicapi` reads the artist's albums and singles pages (one search per artist, cached in `artists.ytmusic_id`, then one request per album, paced to about one a second) and the artist's monthly listeners land in `artists.ytmusic_listeners`. The app rounds what it shows ("3B", "282M"), and that is what gets stored: three significant digits at best, exact enough to rank by. `tracks.youtube_views` is then the exact view count of the video YouTube Music picked, from the official Data API at one quota unit per 50 videos, if `YOUTUBE_API_KEY` is set. When YouTube Music keeps refusing requests the seeder says so once, finishes the run without it, and a later run fills in what is NULL; artists that already have play counts are skipped, so a re-run moves forward instead of redoing the same names. `--yt-refresh` re-reads counts that are already stored.

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

Catalog search requires a moderator/admin access token. One route answers every question, by stacking filters and sorts:

```bash
curl -X POST localhost:8080/api/catalog -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "entity": "tracks",
    "filters": [{"field": "artist.name", "op": "eq", "value": "Adele"},
                {"field": "track.lastfm_listeners", "op": "gte", "value": 1000000}],
    "sorts": [{"field": "track.lastfm_listeners", "dir": "desc"}],
    "limit": 20}'
```

See [the catalog query](#the-catalog-query) below for the field list, the operators and the response shape.

## 4. Frontend

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the root `.env` to the same public URL and anon key as `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Vite reads this file via `envDir`; only `VITE_*` values reach the browser. Never prefix the JWT secret or service-role key with `VITE_`. Restart Vite after changing these values. Without public config, the page supports guests and explains that sign-in is unavailable.

```bash
cd frontend
npm install
npm run dev
```

Vite serves on http://localhost:5173 and proxies `/api` to the backend on 8080 (see `frontend/vite.config.ts`).

**Routing.** Real paths, on the History API: `/`, `/account`, `/flights`, `/editor`, `/editor/{date}`, `/admin/{tab}`. `frontend/src/routing.ts` is the whole router — one delegated click listener turns an ordinary left-click on any same-origin `<a href>` into a `pushState`, so links stay links and middle-click, ctrl-click and "open in a new tab" keep working; `navigate()` is for moves with no link behind them, like picking a date. **Whatever serves the built `dist/` must fall back to `index.html` for unknown paths**, or a reload on `/editor/2026-09-09` is a 404. `npm run dev` and `vite preview` both do this already.

**Playing.** The launchpad is the game, and the solar system behind it is always there: the rocket sits at your altitude and the planets scroll past as you climb. With a published quiz for the current game day it offers **BEGIN ASCENT**, and the seven questions arrive one at a time: the prompt in a card up top, and along the bottom a timer ring, the answer fields, ANSWER and skip. Song questions carry a play/pause button and a scrubber over the snippet window, which starts at the moderator's offset and stops at the end of the window; browsers that refuse autoplay leave the button to do it. Album questions show the cover. Song and album questions have one field per thing the moderator asked for, artist and/or title, and each field completes from the catalog as you type. Those fields are also checked against the catalog when you press ANSWER: a name that is not in it is refused once with a note, and pressing ANSWER again sends it anyway. When the timer reaches zero the client submits whatever is in the fields, and the backend's three-second grace covers the round trip. Each answer shows its tier and moves the rocket, and NEXT asks for the next question, which is when its timer starts.

On a fresh database there is no quiz to play. This writes a music quiz for the current game day, replacing whatever is there, so it is for local use only:

```bash
psql "$DATABASE_URL" -f scripts/demo_quiz.sql
```

A guest needs no account: the `jam_player` cookie is the passport. Reloading mid-flight returns to the current question with the time that is left, so the button reads **RESUME ASCENT**. Once the seventh is answered the day's results stand until the 04:00 UTC rollover: altitude in AU, one row per question, and a share text with one glyph per tier. Without a quiz for today the button is disabled and says so. **flight log** in the dock opens `/flights`: how many flights, the current streak, best and average altitude, and one expandable row per flight with its date, altitude and tier grid. It reads `/api/me/flights`, so it follows the account across browsers once signed in and sits on the guest passport otherwise; the logbook line on the results screen comes from the same place, and nothing is kept in localStorage.

The pure parts of the flight (points to AU, the linear track, the landmark order and passed-landmark label, and the share text) and of the editor (the draft to its payload, everything that still needs fixing, the snippet clamp and the seeded answers) have tests with no browser and no framework:

```bash
npm test
```

**The flight deck.** A moderator or admin sees a **flight deck** chip in the launchpad dock; it opens `/editor`, the quiz editor. The day list shows every day `GET /api/quizzes` reports — its questions, its flights, and whether it is published — and a native date field opens any date at all, written or not.

A day is seven cards. Each one takes a type (rarest, song or album), a prompt, and the accepted answers with an optional tier that beats the computed rarity. A song or album question searches the catalog by title and artist; picking a track shows its 30 s clip as a **waveform**, with the snippet window highlighted over it and two sliders for the start and the length. The window is clamped to fit the clip, so it can never be saved out of range. Play auditions the window, which also caches the clip — which is why the save afterwards is quick rather than spending a second or three on every uncached track.

Picking a track or album seeds the accepted answers: *Radiohead — Creep* starts as `Radiohead Creep` plus `Radiohead` at a lower tier, which is how partial credit is written. Both rows stay editable; delete them if the seed is wrong.

Anything still stopping the save is listed above the button, question by question, in the same words the backend would use. Work in progress is kept in `localStorage` under `jamillion-draft-<date>`, because `POST /api/quizzes` takes seven questions or nothing and a half-written day has nowhere on the server to live; a successful save clears it.

The calendar beside the day's heading **moves the draft to another date** — seven questions written against the wrong day are otherwise a retype. It re-files the draft under the new key and follows it there; it does not touch the server, so a day already saved on the old date stays exactly as it was, and the note says so. The target date is read first: if it already holds a day, or a draft of its own, the confirmation says what saving would replace. Frozen days have no calendar — their questions are fixed where people flew them.

**Once a day has been flown it freezes.** Points were fixed at answer time, so the questions go read-only and only the prompt can still be corrected, through `PATCH /api/questions/{id}`. What does stay live is the review queue under each question: every guess with its count, its verdict (accepted, rejected or awaiting) and its tier, plus merging one spelling into another. Each action reports how many flights it moved. This is the v0.4.0 moderation API with a face on it. An admin also gets a collapsed **▪ THE NUMBERS** block on a flown day, the same one described below.

**Ground control.** An admin sees a second chip in the dock, **ground control**, which opens `/admin` — four tabs, each its own path (`/admin/users`, `stats`, `tiers`, `tables`).

*users* lists everyone aboard: search runs across username and email, a filter narrows to one role, and all six columns are sortable headings. Each row carries a role select and a DELETE. A role change takes effect on the promoted account's very next request. The last admin cannot be demoted or deleted, and the backend's own sentence for that appears above the table. Changing **your own** role away from admin asks first and then reloads the page, because the role is read from `profiles` on every request and the dock would otherwise still be showing you a door you no longer have a key to. Deleting your own account is refused in the row; deleting anyone else's keeps their flights, without a name on them.

*stats* takes a date as `dd.mm.yyyy` and reads `GET /api/quizzes/{date}/stats`: how many finished, the day's scores as one bar per score somebody landed on, and each question with its answered / skipped / correct counts and its ten most-guessed answers with their verdicts and shares. The same block is the one on the editor's day screen, which appears only once the day has flights — before that every number in it is zero.

*tiers* edits the rarity ladder in place: name, points, and the largest share of players that still reaches the tier. One row saves at a time; a value the backend would refuse is refused beside the field first, and a duplicate name comes back as a 409 on that row. **An edit never re-scores** — points are frozen at answer time, so it decides what a future answer falls into and nothing that has already flown. The six steps cannot be added to, removed or reordered.

*tables* is the allowlisted dump of section 10: pick one of the sixteen tables and a page size. Neither list route returns a total, so the paging says only what is on screen (*rows 51–100*) and **next** stops at a short page; an empty page carries no column names either, so it says which table is empty instead of drawing an invented header.

## 4b. Rate limits

They apply the same way in Docker and in development.


Drogon's own `Hodor` plugin, configured from the environment in
`backend/src/ratelimit.cc` — no config file, the same rule the rest of the backend
follows. `RealIpResolver` sits in front of it so the caps see the client Caddy
forwarded rather than the bridge address.

| knob | default | what it covers |
|---|---|---|
| `RATE_IP` | 120/min | everything under `/api/` |
| `RATE_ME` | 10/min | `/api/me`, which inserts a `players` row on every cookieless call |
| `RATE_LOOKUP` | 60/min | `/api/suggest` and `/api/known`, unauthenticated catalog scans |
| `RATE_PLAY` | 40/min | `/api/attempts`, per player rather than per IP |
| `RATE_IDEAS` | 5/min | in front of the existing three-per-game-day rule |
| `RATE_CATALOG` | 60/min | `/api/catalog`, per moderator |
| `RATE_LIMIT=off` | — | disables all of it, for the integration suites |
| `TRUST_PROXY_IPS` | `127.0.0.1,172.16.0.0/12` | whose `X-Forwarded-For` is believed. **IPv4 only** |
| `MAX_BODY_BYTES` | 262144 | largest accepted request body |
| `DB_TIMEOUT_SEC` | 5 | how long a query may wait for a connection before failing (`0` = never) |

A throttled request is a 429 carrying the same `{"error": ...}` body as every
other refusal, so the frontend needed no change to render it.

`DB_TIMEOUT_SEC` is not a rate limit but it belongs to the same "fail instead of
waiting" idea, and it is the one that matters when the database is the thing that
is down: Drogon buffers a query with no ready connection and never calls it back,
so with a timeout of 0 — Drogon's own default — **every** route waits forever, the
health check included. Five seconds turns that into the same generic error each
route already reports.

## 4c. Backups

```bash
scripts/backup.sh
```

It dumps whatever `DATABASE_URL` in `.env` points at — the CLI stack, as written. For the Docker stack, whose database publishes no port, see *Backups* under *Run it with Docker*.

Writes `data/backup/jamillion-<date>.dump` (custom format) and
`data/backup/audio-<date>.tgz`, then deletes anything older than
`BACKUP_KEEP_DAYS` (14). Nightly, as a cron line:

```bash
0 5 * * * /path/to/jamillion/scripts/backup.sh >> /path/to/jamillion/data/backup.log 2>&1
```

Restore:

```bash
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" data/backup/jamillion-20260911.dump
```

- **The dump is `-n public -n auth`, not the whole database.** `public` is the
  game and `auth` is the accounts it hangs off; realtime's partitions, vault,
  storage and the extension grants belong to the Supabase stack, are recreated by
  it, and dumping them only produces errors on the way back in.
- **A restore into an empty database exits 1, and that is expected.** Drilled
  against a scratch database: 26 errors, none of them data — 19 are `DROP POLICY
  IF EXISTS ... ON public.<table>` from `--clean`, which needs the table to exist
  and cannot on an empty target (the policies are created again further down the
  same dump), 1 is the `auth.users` trigger and 6 are `ALTER DEFAULT PRIVILEGES`
  for Supabase's own roles. All 17 `public` tables then match the source row for
  row, both views keep `security_invoker = true`, and the answer key comes across
  whole. Read the error list, do not trust the exit code.
- **The audio tarball is a convenience, not a requirement.** A clip whose file is
  missing is re-downloaded on first use, so `data/audio/` is a cache. Restoring
  without it costs one Deezer round trip per track, not a broken quiz.

## 5. First admin

Open the frontend, follow **Sign in** in the top right (the launchpad is the home page; auth lives at `/account`) and choose **Create account**. Email and password go directly to Supabase Auth through `@supabase/supabase-js`; there is no backend password endpoint. The first account is admin, including when two people sign up concurrently. Later accounts are users; signup metadata cannot choose a role. Duplicate usernames receive a numeric suffix. Local email confirmations are disabled; if enabled, the UI asks the user to confirm their email before signing in.

## 6. Player identity and role checks

```bash
curl -c /tmp/jam.cookies localhost:8080/api/me
curl -b /tmp/jam.cookies -c /tmp/jam.cookies localhost:8080/api/me
curl -b /tmp/jam.cookies -c /tmp/jam.cookies \
  -H "Authorization: Bearer $ACCESS_TOKEN" localhost:8080/api/me
```

`GET /api/me` returns `player_id`, `authenticated`, `role`, and `profile` (null for guests; otherwise `{id, username, role}`). Responses are `Cache-Control: no-store`. A supplied invalid token returns 401, never a guest fallback. Verification requires HS256, the configured issuer, `authenticated` audience and token role, an unexpired `exp`, and a UUID subject with an existing profile. App permissions come from `profiles`, so promotion/demotion takes effect on the next request. The default issuer is `SUPABASE_URL/auth/v1`; `SUPABASE_JWT_ISSUER` overrides it when the public address differs from the token issuer.

The signed `jam_player` cookie lasts a year, is HttpOnly, SameSite=Lax, and scoped to `/`. Set `COOKIE_SECURE=true` when serving over HTTPS. A valid guest row is linked atomically on sign-in, preserving its existing attempts. Linked cookies grant no account access without a token: sign-out or switching accounts creates a fresh player row. Multiple browser player rows can belong to one profile; history can be collected through `players.user_id`. Since v0.3.0 the daily attempt is deduplicated across those rows, so a signed-in player gets one flight a day whichever browser they use.

Backend routes attach `auth::Optional` first, followed by `auth::User`, `auth::Moderator`, or `auth::Admin` as needed. User requires sign-in, Moderator admits moderators/admins, and Admin admits only admins. Anonymous access to guarded routes returns 401; insufficient roles return 403. `/api/me` admits guests; `/api/catalog` requires Moderator. `/api/health` stays public.

Sign-out ends the Supabase session on this browser. Like other locally verified JWTs, an already issued access token remains valid until expiry; deleting its profile makes the backend reject it immediately.

## 7. Auth regression checks

With the local Supabase stack and backend running, load `.env` as above and run:

```bash
cmake -S backend -B backend/build -DJAMILLION_BUILD_TESTS=ON
cmake --build backend/build -j 4
ctest --test-dir backend/build --output-on-failure
.venv/bin/python backend/tests/auth_integration.py
.venv/bin/python backend/tests/quiz_play.py
.venv/bin/python backend/tests/moderation.py
.venv/bin/python backend/tests/admin.py
cd frontend
npm test
npm run build
npm run lint
```

Those four python suites need the backend started with **`RATE_LIMIT=off`**: they
call the API in tight loops and would otherwise spend the v0.10.0 caps and start
reading 429s as failures. `hardening.py` is the opposite — it needs the caps on,
so restart the backend without the switch and run it on its own:

```bash
RATE_LIMIT=off ./backend/build/jamillion      # for the four suites above
```

```bash
./backend/build/jamillion                      # default caps
.venv/bin/python backend/tests/hardening.py
```

`hardening.py` covers what v0.10.0 added: that `/api/health` carries no database
message, that an oversized body is refused, that the user search term, the filter
and sort stacks, the filter value and the tier name are all bounded, and that
`/api/me` stops minting player rows once it is hammered — comparing the row count
before and after, so it is the limit that stopped it rather than luck. It burns
`/api/me`'s minute budget on purpose, so run it last or wait a minute afterwards.

All three scripts share their fixtures through `backend/tests/common.py`. Run them from the repository root, so a relative `AUDIO_DIR` resolves the same way it does for the backend. They use `psycopg` from `scripts/requirements.txt`, accept `TEST_API_URL` for another backend port, refuse non-local services, and create/delete only their own test accounts and player rows. `quiz_play.py` owns the current game day: it refuses to run if a quiz already exists for `game_today()`, and it needs at least one catalogue track with a preview. It covers quiz creation and its validation, one-at-a-time delivery, rarity tiering and moderator overrides, timeouts and skips, finishing, audio by question id, one flight per account across browsers, and that neither anonymous nor signed-in players can read the answer key, the question prompts and track ids, or call the scorer. Since v0.6.0 it also checks that answering never serves the next question (the attempt's `question_started_at` is null until the next `POST /api/attempts`) and that `/api/quiz/today` reports the flight's own answers with their tiers. Since v0.7.0 its quiz has an album question asking for the title only, and it checks the served fields, that no album or track id leaks, and `/api/suggest`. Since v0.8.1 it also checks `/api/known`: a real artist under any casing or punctuation, a made-up one, an empty query, a bad `kind`, and that an accepted answer which is not a catalog name still reads as unknown.

`npm test` in `frontend/` runs every `src/*.test.ts` on `node --test`, against the pure modules only — no component is tested, and none needs a browser or the backend. `flight.test.ts` covers the altitude conversion, the linear track, the landmark order, the landmark you have passed, the share text and the calendar arithmetic; `quizdraft.test.ts` the draft, its payload and its problem list; `catalog.test.ts` the field keys, the cell formatter and the tier spread; `admin.test.ts` the row-range label that stands in for a total the routes do not send, and the tier patch that mirrors the backend's checks; and `routing.test.ts` how a path reads as a screen and its argument. Note that a *value* import inside a module a test loads has to carry its `.ts` extension — Node resolves imports its own way, not Vite's.

`moderation.py` owns the current game day in the same way and must run after `quiz_play.py`, which deletes its own quiz on the way out. It covers the quiz preview with its answer list, publish and unpublish, a moderator fetching audio for an unpublished quiz, verdicts and tier overrides re-scoring only the players who gave that answer, merging a duplicate, player detail across the browsers of one account, and that the moderation functions are not callable through PostgREST. Since v0.8.0 it also covers `GET /api/me/flights`: the 401 without a passport, a guest seeing only its own flights, both browsers of an account reporting the same list with the tier and never the matched answer, a day owned twice collapsing to its best flight, and `limit` being clamped rather than rejected.

`admin.py` does not own the game day, so it runs in any order. It builds its own quiz 400 days out and writes finished attempts straight to the tables instead of playing them through the timer, because the timer is already `quiz_play.py`'s job. It covers the user listing with its filters and sorts, a role change taking effect on the next request, the last admin surviving both demotion and deletion, per-question stats with the height histogram, the allowlisted table dump refusing everything else, tier edits leaving already-awarded points alone, and an account deletion that keeps the flights and releases the quiz it created. It briefly demotes any other admin so it can test the last-admin rule, and restores them in its `finally` block.

The integration script uses `psycopg` from `scripts/requirements.txt`, accepts `TEST_API_URL` for another backend port, refuses non-local services, and creates/deletes only its own test accounts and player rows. It checks real signup/login, concurrent first-admin creation, guest persistence/linking, concurrent account isolation, role changes, malformed/expired/forged tokens, deleted profiles, and answer-key RLS. On an empty auth database it also verifies the first-signup admin rule. Local email confirmation must be disabled for these tests.

## 8. Quiz play

The game day rolls over at **04:00 UTC**, not midnight: `game_today()` in the database is the one definition of "today", used by every route here.

**Publish a day's quiz.** Moderator or admin only. Exactly seven questions, positions 1 to 7, each with at least one accepted answer. `tier_id` on an answer is a moderator override that beats the computed rarity; leave it out to let the share decide. `published` defaults to true. `qtype` is `rarest`, `song` (needs `track_id`, `snippet_start_sec`, `snippet_len_sec`) or `album` (needs `album_id`). Song and album questions take `ask_artist` and `ask_title` (both default true, at least one must stay true): the player gets one field per flag, and what they type is joined as `Artist — Title` before scoring, which normalises to the same key as an accepted answer written `Artist Title`. A player who fills only one field sends only that name, so an accepted answer of just the artist, with a lower fixed tier, is how partial credit works.

```bash
curl -X POST localhost:8080/api/quizzes -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{
  "quiz_date": "2026-09-08",
  "questions": [
    {"position": 1, "qtype": "rarest", "prompt": "Name a Radiohead album",
     "answers": [{"display": "OK Computer"}, {"display": "Kid A"}]},
    {"position": 2, "qtype": "song", "prompt": "Artist and title?", "track_id": 123,
     "snippet_start_sec": 12, "snippet_len_sec": 10, "time_limit_sec": 0, "ask_album": true,
     "answers": [{"display": "Radiohead Creep", "tier_id": 6}, {"display": "Radiohead", "tier_id": 2}]},
    {"position": 3, "qtype": "album", "prompt": "Whose album is this?", "album_id": 45,
     "ask_artist": true, "ask_title": false,
     "answers": [{"display": "Radiohead"}]}
  ]}'
```

Find `track_id` and `album_id` with `POST /api/catalog` (section 3).

`time_limit_sec` is **0 for no clock** or 5–60 seconds; it defaults to 20 when the key is absent. An untimed question is served with `deadline: null`, the player's ring is not drawn, and nothing is ever counted late. The editor defaults a song or an album question to no clock and a rarest question to 20 s.

`ask_artist`, `ask_title` and `ask_album` are the fields a song or album question puts in front of the player, in that order; their answer is those fields joined with `—`. At least one must be true. Each field is a separate input in the player's HUD with the catalog's completions listed under it (`/api/suggest`), so the three-field question is picked rather than typed.

The `answers` you POST are the key exactly as stored: the API knows nothing about fields and combinations. It is the **editor** that expands them — one row per field, plus every combination of those fields.

A combination is worth its fields **added up**. Each field carries a tier, a player scores every field they got right, and `full_tier_id` in the editor is an optional **bonus** on top for getting all of them — leave it at *no bonus* and a perfect answer is simply the whole sum. Because a sum is rarely a number any rarity tier names, each combination row carries an explicit `points` (0–700) that overrides its tier's own value; `tier_id` still rides along, so the player is shown a star as usual. Reopening a saved day folds the combinations back up, so the moderator edits fields, not a 2ⁿ list.

```json
{"display": "Lady Gaga — Poker Face — The Fame", "tier_id": 4, "points": 105}
```

Answers arrive on *by rarity*, and **spread the tiers** — beside `+ answer` in the accepted-answers list — hands the ladder out over that list as it stands: Nebula at the top, Supernova at the bottom, the rest stacked evenly between. It runs on the list, not on the query, so several searches and anything typed by hand can be tiered in one press, and pressing it again after adding more re-tiers everything. Since the list keeps the order things were added in, a catalog sorted by listeners descending makes the ladder read as popularity.

`points` is yours to set on any answer, not just a generated one, and **0 is a real choice**: accepted, counted as a guess, worth nothing. Every tier select in the editor and the review queue offers it as *0 pts · no score* beside *by rarity* and the six tiers. `PATCH /api/answers/{id}` takes `points` alongside `is_correct` and `tier_id`; `null` puts the answer back on its tier, and setting a `tier_id` by hand clears whatever override the answer carried, so the tier the moderator picked is what takes effect. `ask_album` — *which record is this song from* — is **song only**: on an album question the album title is what `ask_title` already means, and asking for it twice is rejected with 400. Saving a song question downloads its clip first, by running `scripts/fetch_audio.py` through `.venv/bin/python` if that exists and `python3` otherwise; a track with no reachable preview fails the whole save with 422 rather than storing an unplayable quiz. Re-posting the same date replaces a quiz nobody has played yet, and returns 409 once it has attempts.

**Play.** Every route below needs the `jam_player` cookie from `GET /api/me`, so fetch that first (section 6).

```bash
curl -c /tmp/jam.cookies localhost:8080/api/me
curl -b /tmp/jam.cookies localhost:8080/api/quiz/today
curl -b /tmp/jam.cookies -X POST localhost:8080/api/attempts
curl -b /tmp/jam.cookies -X POST localhost:8080/api/attempts/1/answers \
  -H 'Content-Type: application/json' -d '{"question_id": 40, "text": "kid a"}'
```

`GET /api/quiz/today` is metadata only: the date, how many questions, how many players have finished, the tier legend, and your own attempt if you have one. It never carries a prompt or an answer.

Since v0.6.0 that attempt also carries `answers`, your own results so far, one row per question you have answered: `position`, your `raw_text`, whether it was `correct`, the `tier` you were given and the `points`. That is what lets a reload mid-flight, or the results screen the next morning, show the tiers again without a second route. It is only ever your own flight, and it names the tier rather than the accepted answer you matched, so the answer key stays shut.

`POST /api/attempts` starts or resumes the day's flight and hands back the current question. Questions arrive one at a time, and the timer starts when the question is served, so `started_at` and `deadline` come with it. Repeating the call returns the same question with the same `started_at`: a refresh buys no extra time. Call it again after each answer to get the next question. One attempt per player per day, and for a signed-in player one attempt per account, however many browsers they use. Two of these arriving together hand back the same flight rather than colliding, which is what lets a client fire the call without debouncing it.

`POST /api/attempts/{id}/answers` accepts only the current question. An answer arriving more than three seconds past the limit is stored as a timeout: no points, and it does not count towards anyone's rarity. Empty text is a deliberate skip and works the same way. Answering twice returns 409.

**The response is the result and the running totals, never the next question** (`"question"` is always `null` here). Since v0.6.0 the next question is served only by the next `POST /api/attempts`, because that is what starts its timer: a player reading their result must not be spending the next question's twenty seconds.

```json
{"result": {"timed_out": false, "correct": true, "tier": "Main Sequence", "points": 30},
 "id": 9, "quiz_id": 5, "total_points": 30, "answered": 1, "finished": false, "question": null}
```

Rarity is read as the answer lands: an accepted answer given by a share of players at or below a tier's `max_share` takes the rarest tier that fits, and the points are then frozen. The first player to give a correct answer therefore scores Nebula, exactly as in Krillion. A guess nobody has approved is still stored, with `is_correct` null, waiting for the v0.4 moderator review.

**Flight history.** `GET /api/me/flights` is every flight this passport has flown, newest first. It needs no token: guests have flights too, and the `jam_player` cookie is the passport, so a request without one is 401 rather than an empty list. `limit` defaults to 60 and clamps to 1–365.

```bash
curl -b /tmp/jam.cookies localhost:8080/api/me/flights
curl -b /tmp/jam.cookies -H "Authorization: Bearer $ACCESS_TOKEN" localhost:8080/api/me/flights
```

```json
[{"quiz_date": "2026-09-08", "flight_no": 1, "total_points": 90, "height_au": 15.43,
  "finished": true,
  "answers": [{"position": 1, "raw_text": "Parachutes", "correct": true,
               "tier": "Nebula", "points": 10}]}]
```

Signed in, the list covers every player row of the account, the same fan-out `GET /api/players/{id}` uses, so a flight taken on another browser is in it. A guest row reports only itself. One row per day: `attempts` is unique per `(player_id, quiz_id)` rather than per account, so two browsers that each flew a day as guests and then signed into the same account own two attempts for it, and the history keeps the better one. `answers` names the tier you were given and never the accepted answer your guess matched: that is `/api/players/{id}`'s job, and it is a moderator route.

**Completions.** `GET /api/suggest?kind=artist|title|album&q=` returns up to eight catalog names for the answer fields: prefix matches first, then by popularity, nothing under two letters. It is public and reads only the catalog, never the answer key.

**Is that a real name?** `GET /api/known?kind=artist|title|album&q=` answers `{"known": true|false}` for one field's worth of text. It compares through `normalize_answer()`, the same collapse the scorer uses, so `radiohead` and `RADIOHEAD!` are both known. An empty `q` is `known`, because an empty field is a deliberate skip. Public and catalog-only for the same reason `/api/suggest` is: it says nothing about what is accepted for a question.

```bash
curl 'localhost:8080/api/known?kind=artist&q=Radiohed'
```

```json
{"known": false}
```

On a song or album question the client checks each filled field with this before spending the guess. An unrecognised name is refused every time, with the field outlined: pick a name from the list or skip. The answer route refuses it too (422). Names the moderator accepted for the box count as known, so a right answer the catalog lacks is still reachable. Rarest questions are never checked (there is nothing to check them against), an empty field is still a skip, and the timer is untouched: when it reaches zero whatever is typed is submitted, checked or not. If `/api/known` itself fails the answer goes through — a catalog hiccup must never eat a guess.

**Audio.** `GET /api/audio/{question_id}` streams the cached clip for a song question, and takes a question id rather than a track id on purpose: `tracks` is readable with the anon key, so publishing a track id would give the answer away. It serves the whole 30 s preview and the client plays the `snippet_start_sec` window. Seeking to that offset needs the clip's metadata first, so the frontend waits for `loadedmetadata` before it seeks and plays; setting `currentTime` earlier is silently dropped and the clip would start at zero and give the intro away. It answers 404 for anything that is not a published song question from today or earlier.

## 9. Moderation

Everything here needs a moderator or admin access token. Anonymous requests get 401, plain users 403.

The routes in this section are the quiz editor's whole contract: search the catalog, read the tier ids, see which days are filled, hear a clip before the quiz exists, write the day, then review the guesses it collects.

**Preview a day.** `GET /api/quizzes/{date}` is the whole quiz as a moderator sees it: prompts, the track behind each song question, the album behind each album question with `ask_artist` and `ask_title`, and every answer with its verdict, its guess count and any tier override. This is the one place a track or album id appears in a response; the player routes still never carry one.

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" localhost:8080/api/quizzes/2026-09-08
```

```json
{"id": 36, "quiz_date": "2026-09-08", "published": true, "created_by": "69a3374b-…",
 "attempts_started": 3, "attempts_finished": 0,
 "questions": [{"id": 220, "position": 1, "qtype": "rarest", "prompt": "Name a Radiohead album",
   "time_limit_sec": 20, "track": null, "audio": null,
   "snippet_start_sec": null, "snippet_len_sec": null,
   "answers": [{"id": 408, "display": "The Bends", "normalized": "the bends",
                "is_correct": null, "tier_id": null, "guess_count": 2}]}]}
```

The answers are the key the editor wrote; a player's guess outside it is never stored. A malformed date is 400, an unused one 404.

**Publish or unpublish.** Question edits still go through re-POSTing an unplayed quiz; this route only flips the switch.

```bash
curl -X PATCH localhost:8080/api/quizzes/2026-09-08 -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{"published": false}'
```

**Rule on an answer.** `is_correct` takes `true` or `false`, and `tier_id` sets or clears the override that beats the computed share. A key left out of the body keeps its current value, so `{"tier_id": 4}` alone does not disturb the verdict.

```bash
curl -X PATCH localhost:8080/api/answers/408 -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{"is_correct": true}'
```

```json
{"id": 408, "question_id": 220, "display": "The Bends", "normalized": "the bends",
 "is_correct": true, "tier_id": null, "guess_count": 2, "rescored": 2}
```

`rescored` counts the stored answers whose points moved. **Only the players who gave this very answer are re-scored.** Everyone else keeps the tier they were shown when they played, which is what v0.3.0 promised by freezing points at answer time. The share used for the recount is this answer's guess count over every answer stored for that question, so approving a guess late in the day scores it against the whole field rather than against the handful of players who were quickest.

**Merge duplicates.** The target keeps its display, verdict and tier; the source's guesses and the players who gave it move across, and those players are re-scored against the merged count.

```bash
curl -X POST localhost:8080/api/answers/420/merge -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{"into": 408}'
```

Answers that differ only in case, punctuation or accents never become separate rows in the first place: `normalize_answer()` collapses them as they land, so `The Bends!` is already counted as `the bends`. Merging is for the spellings normalisation cannot see, like `The Bends album`. Both ids must belong to the same question, or the answer is 400.

**The editor's routes.** All moderator or admin, and together they make a quiz authorable without an admin's table dump.

### The catalog query

`POST /api/catalog` replaced `GET /api/tracks` and `GET /api/albums` in v0.8.4. Those two took four fixed filters and one fixed sort each; the questions a moderator actually writes need more than that — *songs on this album in running order*, *British bands formed before 1980*, *this artist's tracks over a million listens* — so the route takes a **stack** of filters and a **stack** of sorts over an allowlist of columns instead.

```json
{"entity": "tracks",
 "filters": [{"field": "album.title", "op": "eq", "value": "Parachutes"}],
 "sorts": [{"field": "track.track_number", "dir": "asc"}],
 "limit": 50, "offset": 0}
```

- `entity` — `tracks`, `albums` or `artists`. It decides which fields exist and what a row is.
- `filters` — ANDed. `in` covers the common *either of these* case (`"value": "adele, coldplay"`), which is why there is no OR grouping.
- `sorts` — applied in order, always `NULLS LAST`. Empty means Deezer popularity for tracks, Deezer fans for albums, `global_rank` for artists.
- `limit` 1–500 (default 50), `offset` 0–1000000.

Operators are decided by the field's datatype:

| Datatype | Operators |
|----------|-----------|
| text     | `contains` `starts` `ends` `eq` `ne` `in` `null` `notnull` |
| number   | `eq` `ne` `lt` `lte` `gt` `gte` `in` `null` `notnull` |
| date     | `eq` `ne` `lt` `lte` `gt` `gte` `null` `notnull` (`YYYY-MM-DD`) |
| boolean  | `eq` `ne` `null` `notnull` (`"true"` / `"false"`) |

Text compares case-insensitively, and `ne` is `IS DISTINCT FROM`, so a null row counts as *not* the value rather than dropping out.

**When an artist started.** `artist.begin_year` is MusicBrainz's *begin*, which is a birth year for a person and a formation year for a group — so filtering it under 1980 sweeps up Eminem, born 1972 and not yet rapping. Three fields separate the meanings:

| Field | Is |
|-------|----|
| `artist.formed_year` | `begin_year` when `artist_type` is `Group`, else null — bands only |
| `artist.born_year` | `begin_year` when `artist_type` is `Person`, else null — people only |
| `artist.first_release` / `artist.first_release_year` | the earliest release date of anything by them **in this catalog** |

`first_release` is the one that answers "when did they start" for both kinds, but it is bounded by what the seeder holds: an artist known here only from a later compilation reads late (The Beatles come out as 1993). `formed_year` and `born_year` are only as good as `artist_type`, which Deezer/MusicBrainz sometimes gets wrong — Kanye West is filed as a `Group`.

**How big a song is.** Four counts, each meaning something different:

| Field | Is |
|-------|----|
| `track.ytmusic_plays` | the play count the YouTube Music app shows — plays over every upload of the recording, rounded to a few digits (`3000000000` for Smells Like Teen Spirit). The editor's track results show it by default |
| `album.ytmusic_plays` | the sum of the album's tracks, since YouTube Music counts songs and not records. Shown by default on album results |
| `track.youtube_views` | exact views of the one video YouTube Music plays for it |
| `track.lastfm_listeners` / `lastfm_playcount` | Last.fm scrobblers, a smaller and rockier crowd |
| `track.deezer_rank` | Deezer's 0–1 000 000 popularity score, the default sort |

`artist.ytmusic_listeners` is the artist's YouTube Music monthly listeners, shown by default on artist results. An album total is null until its tracks have play counts, and skips the tracks the seeder never matched, so a record missing a song reads a little low rather than not at all. All of them are `notnull`-filterable, so a seed that has not run YouTube yet can be told apart from a song nobody plays.

**Genres.** Deezer tags genres on the album and nowhere else, so that is where they are stored and the other two levels read from it:

| Field | Is |
|-------|----|
| `album.genres` | what Deezer tags the record — `Rock`, `Alternative, Indie Rock, Pop, Rock` |
| `track.genres` | its album's, since a recording has no tag of its own |
| `artist.genres` | the union over everything they released, so it is always the widest of the three |

All three are text, joined with `, ` and sorted, and all three are shown by default. `contains` is how a genre is asked for — `track.genres contains Rock` also catches `Indie Rock`, which is usually what you want; `eq` matches the whole list and is rarely what you mean. Genre names come back in whatever language Deezer decides, so `genres.deezer_id` is the upsert key (152 is Rock in every locale) and the seeder asks for English.

A row carries every column its entity has, keyed exactly as the field is, plus `id`:

```json
{"entity": "tracks", "total": 10,
 "rows": [{"id": 5, "total": 10, "track.title": "Yellow", "track.lastfm_listeners": 3650716,
           "album.title": "Parachutes", "artist.name": "Coldplay", "artist.country": "GB", "…": "…"}]}
```

`total` is the match count before `limit`, so the editor can say *16 matches, top 5*.

`GET /api/catalog/fields` describes the allowlist — every column, its datatype, the entities it belongs to, and the operator list per datatype. The editor's whole filter UI is built from this reply, so a column added to `kColumns` in `backend/src/catalog.cc` appears in the browser without a line of frontend changing. Each rule picks its column in two steps, group then field, and the group list is just the distinct prefixes in that reply — a new prefix makes a new group on its own.

```json
{"entities": [{"name": "tracks", "label": "songs"}, "…"],
 "operators": {"text": ["contains", "…"], "number": ["eq", "…"]},
 "fields": [{"key": "artist.lastfm_listeners", "type": "number",
             "entities": ["tracks", "albums", "artists"]}]}
```

**The allowlist is the security boundary.** No table name, column name or operator ever reaches the SQL from the request — only a key that matched a row in `kColumns` or `kOps`. Values are always bound parameters. An unknown field, or an operator the field's datatype does not offer, is 400 rather than a silently ignored clause.

`GET /api/tiers` is the tier list **with ids**, which an answer's `tier_id` override needs, and since v0.9.0 with `max_share` as well — as text, because the top step is `0.0020` and a JSON float hands that back as `0.002`. It is the one route the admin's tier editor reads. `/api/quiz/today` carries names and points only, and 404s on a day with no quiz, so the editor cannot read them there. `rarity_tiers` is world readable anyway; the guard only keeps the editor's surface in one place.

```json
[{"id": 1, "name": "Nebula", "points": 10, "sort_order": 1, "max_share": "1.0000"}]
```

`GET /api/quizzes?from=&to=` lists which days already have a quiz, so the editor can show a calendar rather than guess dates. Both bounds are optional and default to `game_today() - 30` … `game_today() + 60`; a malformed one is 400. `attempts_started` above zero is what marks a day frozen, before a save tries and collects a 409.

```json
[{"quiz_date": "2026-09-08", "published": true, "questions": 7,
  "attempts_started": 7, "attempts_finished": 7}]
```

**Why the snippet window is 30 seconds.** It is the clip, not a limit we chose. Deezer and the iTunes fallback serve a 30 s preview and nothing longer, and `CLAUDE.md` rules out full-track downloads, so 30 s is the whole of the audio that exists for a track. The schema says so too: `snippet_start_sec BETWEEN 0 AND 30` and the `snippet_in_clip` CHECK. The editor's waveform is that clip end to end, and the window on it is trimmed the way an audio editor trims: drag either **edge** to move that end alone, the **middle** to slide the whole window without resizing it, or bare waveform to draw a new one. The cursor says which. The start can never cross its own end (1 s minimum) and sliding to either end of the clip stops rather than shortening the window; the two sliders below stay, as the keyboard's way in and the only way to nudge by exactly a second.

`GET /api/tracks/{id}/audio` streams a track's clip **before any question uses it**, which `/api/audio/{question}` cannot do because it is keyed by question id on purpose. This is what lets the snippet picker audition a candidate. It is also why saving is quick: `fetch_audio.py` writes `tracks.audio_path`, so by the time the day is posted, `POST /api/quizzes`'s pre-cache loop finds every file already on disk instead of spending 1–3 s per track.

Finally, `GET /api/quizzes/{date}` now reports `album.cover` alongside `album.id/title/artist`, so a moderator can see the image players will be shown.

**Fix a live day.** `PATCH /api/questions/{id}` is the one edit that survives publication. Re-POSTing a quiz replaces it only while nobody has played, so once the day has attempts this is all that is left — and on a played day it is the prompt alone.

```bash
curl -X PATCH localhost:8080/api/questions/533 -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{"prompt": "Who sings this, and what is it called?"}'
```

While the day is unplayed it also takes `time_limit_sec` (5–60), `snippet_start_sec` and `snippet_len_sec` (song questions; the window must fit inside the 30 s clip), and `ask_artist` / `ask_title` (song and album; at least one must stay true). A key left out keeps its value. Any of those on a day that has attempts is **409 `Only the prompt can change once the day has been played`**: v0.3.0 froze points at answer time, and moving a track, a snippet or the answer key under people mid-flight would invalidate scores they have already been shown. `qtype`, `position`, `track_id` and `album_id` are never editable — a different track is a different question, and on an unplayed day re-POSTing the day already does it. The response is the question as `GET /api/quizzes/{date}` shapes it. Unknown id 404, empty body 400 `Nothing to change`.

**Player detail.** `GET /api/players/{id}` reports every flight of that player with its height, and each answer with the accepted answer it matched. A signed-in player has one row per browser, so a linked row reports the whole account rather than the one browser.

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" localhost:8080/api/players/98561bb1-7fcf-450b-a03a-f45cc7eb0550
```

```json
{"id": "98561bb1-…", "user_id": null, "username": null, "role": null, "created_at": "…",
 "attempts": [{"id": 136, "player_id": "98561bb1-…", "quiz_date": "2026-09-08",
   "total_points": 10, "height_au": 1.71, "started_at": "…", "finished_at": null,
   "answers": [{"position": 1, "raw_text": "The Bends album", "matched": "The Bends",
                "is_correct": true, "tier": "Nebula", "points": 10, "answered_at": "…"}]}]}
```

An empty `raw_text` is a skip or a timeout; the schema does not tell the two apart. `height_au` is `total_points × 0.1714`, a legacy figure: the game draws heights from `quiz_ceilings()` instead (see the README).

**Audio while previewing.** `GET /api/audio/{question_id}` normally serves only published quizzes dated today or earlier. A moderator's token lifts both conditions, so tomorrow's song question can be checked before anyone can play it. Without a token the route behaves exactly as it does for players.

## 10. Admin

The screen for all of this is **ground control** in section 4; what follows is the API it talks to.

Everything here needs an **admin** access token. Anonymous requests get 401, plain users and moderators get 403. The first account ever created is the admin (section 5).

**Users.** All filters are optional: `q` is a case-insensitive substring of the username or the email, `role` is one of `user`, `moderator`, `admin`, `limit` defaults to 50 and caps at 200, `offset` pages.

`sort` orders the page by `username`, `email`, `role`, `created_at`, `browsers` or `attempts`, and `dir` is `asc` (the default) or `desc`; anything else is a 400, because the sort key is interpolated into the statement and the allowlist is what makes that safe. `role` orders on the enum rather than its spelling, so ascending reads user → moderator → admin. The default stays oldest account first, and every sort falls back to the user id, so paging never shows one account twice while skipping another.

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" 'localhost:8080/api/users?q=ana&role=moderator&limit=20'
curl -H "Authorization: Bearer $ACCESS_TOKEN" 'localhost:8080/api/users?sort=attempts&dir=desc'
```

```json
[{"id": "69a3374b-…", "username": "ana", "email": "ana@example.com", "role": "moderator",
  "created_at": "2026-09-07 20:11:03.4+00", "browsers": 2, "attempts": 5}]
```

`browsers` is how many player rows the account has, `attempts` how many flights across all of them.

**Change a role.** Takes effect on the account's next request, because permissions are read from `profiles` every time.

```bash
curl -X PATCH localhost:8080/api/users/69a3374b-… -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{"role": "moderator"}'
```

**Delete a user.** The account goes, the flights stay.

```bash
curl -X DELETE localhost:8080/api/users/69a3374b-… -H "Authorization: Bearer $ACCESS_TOKEN"
```

The row is removed from `auth.users`, which cascades to `profiles` and to Supabase's own sessions and identities, so the account cannot sign in again and any access token it still holds is rejected on the next request. What survives: the player rows lose their `user_id` and keep their attempts and answers, so nobody else's rarity share moves, and any quiz the account created keeps its questions and loses only its `created_by`. Deleting a user is not a way to erase a day's scores.

**The last admin cannot be demoted or deleted**, either way a 409. Nothing else is protected: an admin may demote themselves while another admin exists.

**Per-question stats.** `top` defaults to 10 and caps at 100.

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" 'localhost:8080/api/quizzes/2026-09-08/stats?top=5'
```

```json
{"id": 36, "quiz_date": "2026-09-08", "published": true,
 "heights": [{"total_points": 0, "height_au": "0.00", "players": 1},
             {"total_points": 30, "height_au": "5.14", "players": 2}],
 "questions": [{"id": 220, "position": 1, "qtype": "rarest", "prompt": "Name a Radiohead album",
   "answered": 3, "skipped": 1, "correct": 2,
   "top_answers": [{"id": 408, "display": "OK Computer", "is_correct": true, "tier_id": null,
                    "guess_count": 2, "share": "0.6667"}]}]}
```

`heights` is the `quiz_heights` view: one row per distinct score among the finished flights, with `height_au` on the day's scale (`height_au()` in the DB: points over `quiz_max_points()`, times 39.5). `answered` counts every answer stored for the question, `skipped` the empty ones (a deliberate skip or a timeout), `correct` those that matched an approved answer. `share` divides an answer's `guess_count` by every answer stored for that question, skips included, which is the same denominator the scorer uses, so it is the share the tiers were computed against. A malformed date is 400, an unused one 404.

**Raw table view.** Read-only, over a fixed allowlist.

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" localhost:8080/api/tables
curl -H "Authorization: Bearer $ACCESS_TOKEN" 'localhost:8080/api/tables/rarity_tiers?limit=100&offset=0'
```

```json
{"table": "rarity_tiers",
 "rows": [{"id": 1, "name": "Nebula", "points": 10, "sort_order": 1, "max_share": 1.0000}]}
```

`GET /api/tables` returns the allowlist: `profiles`, `players`, `quizzes`, `questions`, `question_answers`, `attempts`, `attempt_answers`, `rarity_tiers`, `artists`, `albums`, `tracks`, `genres`, `artist_genres`, `track_artists`, and the two views `quiz_heights` and `question_top_answers`. Anything else is 404. **`auth.users` is deliberately absent**, because it holds the password hashes. Rows come back typed by Postgres rather than stringified, ordered by the first column, `limit` defaults to 100 and caps at 500. There is no `where` parameter and no free SQL: the allowlist is the whole security boundary, and it is a fixed list in the code rather than a query against the catalog.

**Edit the rarity tiers.** Any of `name`, `points` (0–32767) and `max_share` (greater than 0, at most 1). A key left out keeps its current value.

```bash
curl -X PATCH localhost:8080/api/tiers/6 -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{"points": 120, "max_share": 0.002}'
```

```json
{"id": 6, "name": "Supernova", "points": 120, "sort_order": 6, "max_share": "0.0020"}
```

`id` and `sort_order` are not editable, and tiers cannot be added or deleted: six tiers are the game, and both the answer key and every stored answer point at them. A duplicate name is 409, an unknown id 404.

**A tier edit does not re-score anything.** Points are frozen at answer time (v0.3.0), so an edit applies to answers landing after it and to any answer a moderator re-scores later. Changing `max_share` changes which tier a future answer falls into; the database now refuses a share outside `(0, 1]`, because the scorer takes the first tier whose `max_share` is at least the answer's share and a gap there would silently score a correct answer zero.
