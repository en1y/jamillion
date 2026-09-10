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

**Playing.** The launchpad is the game, and the solar system behind it is always there: the rocket sits at your altitude and the planets scroll past as you climb. With a published quiz for the current game day it offers **BEGIN ASCENT**, and the seven questions arrive one at a time: the prompt in a card up top, and along the bottom a timer ring, the answer fields, ANSWER and skip. Song questions carry a play/pause button and a scrubber over the snippet window, which starts at the moderator's offset and stops at the end of the window; browsers that refuse autoplay leave the button to do it. Album questions show the cover. Song and album questions have one field per thing the moderator asked for, artist and/or title, and each field completes from the catalog as you type. Those fields are also checked against the catalog when you press ANSWER: a name that is not in it is refused once with a note, and pressing ANSWER again sends it anyway. When the timer reaches zero the client submits whatever is in the fields, and the backend's three-second grace covers the round trip. Each answer shows its tier and moves the rocket, and NEXT asks for the next question, which is when its timer starts.

On a fresh database there is no quiz to play. This writes a music quiz for the current game day, replacing whatever is there, so it is for local use only:

```bash
psql "$DATABASE_URL" -f scripts/demo_quiz.sql
```

A guest needs no account: the `jam_player` cookie is the passport. Reloading mid-flight returns to the current question with the time that is left, so the button reads **RESUME ASCENT**. Once the seventh is answered the day's results stand until the 04:00 UTC rollover: altitude in AU, one row per question, and a share text with one glyph per tier. Without a quiz for today the button is disabled and says so. **flight log** in the dock opens `/#/flights`: how many flights, the current streak, best and average altitude, and one expandable row per flight with its date, altitude and tier grid. It reads `/api/me/flights`, so it follows the account across browsers once signed in and sits on the guest passport otherwise; the logbook line on the results screen comes from the same place, and nothing is kept in localStorage.

The pure parts of the flight (points to AU, the linear track, the landmark order and passed-landmark label, and the share text) and of the editor (the draft to its payload, everything that still needs fixing, the snippet clamp and the seeded answers) have tests with no browser and no framework:

```bash
npm test
```

**The flight deck.** A moderator or admin sees a **flight deck** chip in the launchpad dock; it opens `/#/editor`, the quiz editor. The day list shows every day `GET /api/quizzes` reports — its questions, its flights, and whether it is published — and a native date field opens any date at all, written or not.

A day is seven cards. Each one takes a type (rarest, song or album), a prompt, and the accepted answers with an optional tier that beats the computed rarity. A song or album question searches the catalog by title and artist; picking a track shows its 30 s clip as a **waveform**, with the snippet window highlighted over it and two sliders for the start and the length. The window is clamped to fit the clip, so it can never be saved out of range. Play auditions the window, which also caches the clip — which is why the save afterwards is quick rather than spending a second or three on every uncached track.

Picking a track or album seeds the accepted answers: *Radiohead — Creep* starts as `Radiohead Creep` plus `Radiohead` at a lower tier, which is how partial credit is written. Both rows stay editable; delete them if the seed is wrong.

Anything still stopping the save is listed above the button, question by question, in the same words the backend would use. Work in progress is kept in `localStorage` under `jamillion-draft-<date>`, because `POST /api/quizzes` takes seven questions or nothing and a half-written day has nowhere on the server to live; a successful save clears it.

**Once a day has been flown it freezes.** Points were fixed at answer time, so the questions go read-only and only the prompt can still be corrected, through `PATCH /api/questions/{id}`. What does stay live is the review queue under each question: every guess with its count, its verdict (accepted, rejected or awaiting) and its tier, plus merging one spelling into another. Each action reports how many flights it moved. This is the v0.4.0 moderation API with a face on it.

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

All three scripts share their fixtures through `backend/tests/common.py`. Run them from the repository root, so a relative `AUDIO_DIR` resolves the same way it does for the backend. They use `psycopg` from `scripts/requirements.txt`, accept `TEST_API_URL` for another backend port, refuse non-local services, and create/delete only their own test accounts and player rows. `quiz_play.py` owns the current game day: it refuses to run if a quiz already exists for `game_today()`, and it needs at least one catalogue track with a preview. It covers quiz creation and its validation, one-at-a-time delivery, rarity tiering and moderator overrides, timeouts and skips, finishing, audio by question id, one flight per account across browsers, and that neither anonymous nor signed-in players can read the answer key, the question prompts and track ids, or call the scorer. Since v0.6.0 it also checks that answering never serves the next question (the attempt's `question_started_at` is null until the next `POST /api/attempts`) and that `/api/quiz/today` reports the flight's own answers with their tiers. Since v0.7.0 its quiz has an album question asking for the title only, and it checks the served fields, that no album or track id leaks, and `/api/suggest`. Since v0.8.1 it also checks `/api/known`: a real artist under any casing or punctuation, a made-up one, an empty query, a bad `kind`, and that an accepted answer which is not a catalog name still reads as unknown.

`npm test` in `frontend/` runs `flight.test.ts` on `node --test`: the altitude conversion, the linear track, the landmark order, the landmark you have passed and the share text. It needs neither a browser nor the backend.

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

In the editor, results collected from a catalog query can take their tiers from the sort they were found in. The **tiers** select beside the collect buttons chooses: *spread down the sort* puts Nebula at the top of the list and Supernova at the bottom with the rest stacked evenly between, so sorting by listeners descending makes the ladder read as popularity; *by rarity* leaves every added answer to score by how rare it turns out to be. Answers already in the table are never re-tiered by a later add — a repeat is skipped as a duplicate, so change the tiers in place or **remove all** first.

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

On a song or album question the client checks each filled field with this before spending the guess. An unrecognised name is refused once, with the field outlined and a line under the fields saying to check the spelling **or press ANSWER again to send it as is**. The second press goes through unchanged, because the catalog is the top artists rather than every recording and a correct answer it has never heard of must not be trapped; the guess still lands in the moderator review queue with `is_correct` null. Rarest questions are never checked (there is nothing to check them against), an empty field is still a skip, and the timer is untouched: when it reaches zero whatever is typed is submitted, checked or not. If `/api/known` itself fails the answer goes through — a catalog hiccup must never eat a guess.

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

`is_correct` is `null` for a guess nobody has ruled on yet, which is exactly the review queue. A malformed date is 400, an unused one 404.

**Publish or unpublish.** Question edits still go through re-POSTing an unplayed quiz; this route only flips the switch.

```bash
curl -X PATCH localhost:8080/api/quizzes/2026-09-08 -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{"published": false}'
```

**Rule on an answer.** `is_correct` takes `true`, `false` or `null` (back to awaiting review), and `tier_id` sets or clears the override that beats the computed share. A key left out of the body keeps its current value, so `{"tier_id": 4}` alone does not disturb the verdict.

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

`GET /api/tiers` is the tier list **with ids**, which an answer's `tier_id` override needs. `/api/quiz/today` carries names and points only, and 404s on a day with no quiz, so the editor cannot read them there. `rarity_tiers` is world readable anyway; the guard only keeps the editor's surface in one place.

```json
[{"id": 1, "name": "Nebula", "points": 10, "sort_order": 1}]
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

An empty `raw_text` is a skip or a timeout; the schema does not tell the two apart. `height_au` is `total_points × 0.1714`.

**Audio while previewing.** `GET /api/audio/{question_id}` normally serves only published quizzes dated today or earlier. A moderator's token lifts both conditions, so tomorrow's song question can be checked before anyone can play it. Without a token the route behaves exactly as it does for players.

## 10. Admin

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

`heights` is the `quiz_heights` view: one row per distinct score among the finished flights, with `height_au` = points × 0.1714. `answered` counts every answer stored for the question, `skipped` the empty ones (a deliberate skip or a timeout), `correct` those that matched an approved answer. `share` divides an answer's `guess_count` by every answer stored for that question, skips included, which is the same denominator the scorer uses, so it is the share the tiers were computed against. A malformed date is 400, an unused one 404.

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
