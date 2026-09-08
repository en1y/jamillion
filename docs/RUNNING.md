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

**Playing.** The launchpad is the game, and the solar system behind it is always there: the rocket sits at your altitude and the planets scroll past as you climb. With a published quiz for the current game day it offers **BEGIN ASCENT**, and the seven questions arrive one at a time: the prompt in a card up top, and along the bottom a timer ring, the answer fields, ANSWER and skip. Song questions carry a play/pause button and a scrubber over the snippet window, which starts at the moderator's offset and stops at the end of the window; browsers that refuse autoplay leave the button to do it. Album questions show the cover. Song and album questions have one field per thing the moderator asked for, artist and/or title, and each field completes from the catalog as you type. When the timer reaches zero the client submits whatever is in the fields, and the backend's three-second grace covers the round trip. Each answer shows its tier and moves the rocket, and NEXT asks for the next question, which is when its timer starts.

On a fresh database there is no quiz to play. This writes a music quiz for the current game day, replacing whatever is there, so it is for local use only:

```bash
psql "$DATABASE_URL" -f scripts/demo_quiz.sql
```

A guest needs no account: the `jam_player` cookie is the passport. Reloading mid-flight returns to the current question with the time that is left, so the button reads **RESUME ASCENT**. Once the seventh is answered the day's results stand until the 04:00 UTC rollover: altitude in AU, one row per question, and a share text with one glyph per tier. Without a quiz for today the button is disabled and says so.

The pure part of the flight (points to AU, the log-scaled track, the share text) has a test with no browser and no framework:

```bash
npm test
```

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
.venv/bin/python backend/tests/moderation.py
.venv/bin/python backend/tests/admin.py
cd frontend
npm test
npm run build
npm run lint
```

All three scripts share their fixtures through `backend/tests/common.py`. Run them from the repository root, so a relative `AUDIO_DIR` resolves the same way it does for the backend. They use `psycopg` from `scripts/requirements.txt`, accept `TEST_API_URL` for another backend port, refuse non-local services, and create/delete only their own test accounts and player rows. `quiz_play.py` owns the current game day: it refuses to run if a quiz already exists for `game_today()`, and it needs at least one catalogue track with a preview. It covers quiz creation and its validation, one-at-a-time delivery, rarity tiering and moderator overrides, timeouts and skips, finishing, audio by question id, one flight per account across browsers, and that neither anonymous nor signed-in players can read the answer key, the question prompts and track ids, or call the scorer. Since v0.6.0 it also checks that answering never serves the next question (the attempt's `question_started_at` is null until the next `POST /api/attempts`) and that `/api/quiz/today` reports the flight's own answers with their tiers. Since v0.7.0 its quiz has an album question asking for the title only, and it checks the served fields, that no album or track id leaks, and `/api/suggest`.

`npm test` in `frontend/` runs `flight.test.ts` on `node --test`: the altitude conversion, the linear track, the landmark order, the landmark you have passed and the share text. It needs neither a browser nor the backend.

`moderation.py` owns the current game day in the same way and must run after `quiz_play.py`, which deletes its own quiz on the way out. It covers the quiz preview with its answer list, publish and unpublish, a moderator fetching audio for an unpublished quiz, verdicts and tier overrides re-scoring only the players who gave that answer, merging a duplicate, player detail across the browsers of one account, and that the moderation functions are not callable through PostgREST.

`admin.py` does not own the game day, so it runs in any order. It builds its own quiz 400 days out and writes finished attempts straight to the tables instead of playing them through the timer, because the timer is already `quiz_play.py`'s job. It covers the user listing and its filters, a role change taking effect on the next request, the last admin surviving both demotion and deletion, per-question stats with the height histogram, the allowlisted table dump refusing everything else, tier edits leaving already-awarded points alone, and an account deletion that keeps the flights and releases the quiz it created. It briefly demotes any other admin so it can test the last-admin rule, and restores them in its `finally` block.

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
     "snippet_start_sec": 12, "snippet_len_sec": 10,
     "answers": [{"display": "Radiohead Creep", "tier_id": 6}, {"display": "Radiohead", "tier_id": 2}]},
    {"position": 3, "qtype": "album", "prompt": "Whose album is this?", "album_id": 45,
     "ask_artist": true, "ask_title": false,
     "answers": [{"display": "Radiohead"}]}
  ]}'
```

Find `track_id` with `/api/tracks` (section 3) and `album_id` in the `albums` table (Studio, or `GET /api/tables/albums` as an admin). Saving a song question downloads its clip first, by running `scripts/fetch_audio.py` through `.venv/bin/python` if that exists and `python3` otherwise; a track with no reachable preview fails the whole save with 422 rather than storing an unplayable quiz. Re-posting the same date replaces a quiz nobody has played yet, and returns 409 once it has attempts.

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

**Completions.** `GET /api/suggest?kind=artist|title|album&q=` returns up to eight catalog names for the answer fields: prefix matches first, then by popularity, nothing under two letters. It is public and reads only the catalog, never the answer key.

**Audio.** `GET /api/audio/{question_id}` streams the cached clip for a song question, and takes a question id rather than a track id on purpose: `tracks` is readable with the anon key, so publishing a track id would give the answer away. It serves the whole 30 s preview and the client plays the `snippet_start_sec` window. Seeking to that offset needs the clip's metadata first, so the frontend waits for `loadedmetadata` before it seeks and plays; setting `currentTime` earlier is silently dropped and the clip would start at zero and give the intro away. It answers 404 for anything that is not a published song question from today or earlier.

## 9. Moderation

Everything here needs a moderator or admin access token. Anonymous requests get 401, plain users 403.

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

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" 'localhost:8080/api/users?q=ana&role=moderator&limit=20'
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
