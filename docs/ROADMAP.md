# Roadmap

Semantic versioning. Minor bumps = a new capability that works end to end. Patch bumps = fixes and small additions inside a minor. `v1.0.0` = playable by strangers. Each version is a git tag.

Backend first (v0.1 – v0.5), frontend second (v0.6 – v0.9).

## v0.0.x — Foundation

- **v0.0.1** ✅ Repo, README, docs, schema, seed scripts, Drogon + Vite skeletons, `/api/health`.
- **v0.0.2** Supabase from the start: schema moved to `supabase/migrations/`, auth on Supabase Auth (`profiles` + first-signup-is-admin trigger), RLS on every table, Postgres in Docker.

## v0.1.0 — Music catalog

- [x] Supabase stack running, schema applied as a migration.
- [~] Seed top 500 artists: Deezer catalog (albums, tracks, labels, UPC/ISRC, BPM, fans, preview clips), Last.fm ranking + listen counts, MusicBrainz country/type/gender/years, YouTube video ids + views. Originals only. Running.
- [x] `GET /api/tracks?q=&artist=&year=&min_rank=` search for the quiz editor.
- Patch ideas: raise `--detail-cap` for full ISRC coverage, album-level genres, MusicBrainz writer credits.

## v0.2.0 — Auth and players

Implemented and locally verified; release tag pending.

- [x] Frontend signs up and logs in through `@supabase/supabase-js`; Supabase issues the access token. No password ever reaches our backend.
- [x] Drogon verifies that token with `SUPABASE_JWT_SECRET` (jwt-cpp, HS256, added via FetchContent) and reads the role from `profiles`.
- [x] `jam_player` cookie for anonymous players; signing in links the player row to the profile.
- [x] Role guard: user / moderator / admin. `GET /api/me`.
- Later, free from Supabase: OAuth providers, password reset, email confirmation.

## v0.3.0 — Quiz play

Implemented and locally verified; release tag pending.

- [x] Moderator: `POST /api/quizzes` for a date, 7 questions (`rarest` or `song`), track + snippet start/len, accepted answers with tiers. Saving caches every clip first, so an unplayable quiz is never stored.
- [x] `GET /api/quiz/today` (no answers), `GET /api/audio/:question` streams the cached preview clip.
- [x] `POST /api/attempts`, `POST /api/attempts/:id/answers` — 20 s server-side timer, answer normalisation, one attempt per player per day.
- [x] Rarest tiering by answer share (`rarity_tiers.max_share`), moderator override wins.
- [x] 04:00 UTC rollover, as `game_today()` in the database.

Decisions worth carrying forward:

- **Audio is keyed by question, not track.** `tracks` is world readable through the anon key, so a track id in a question payload would give the song away. `/api/audio/:question` is the only handle a player gets.
- **Questions are served one at a time.** `/api/quiz/today` carries no prompts; each question's timer starts when the attempt hands it over, so nobody reads all seven before playing.
- **Both hold at the database too.** `questions` has no player read policy: the first migration's `read_published` let the anon key pull every prompt and `track_id` for a published quiz straight from PostgREST, bypassing the two rules above. Players only ever see questions through the backend; moderators keep `mod_write`.
- **Points are frozen at answer time.** The rarity share is read as the answer lands. v0.4 reviews answers and may re-score.

## v0.4.0 — Moderation

Implemented and locally verified; release tag pending.

- [x] Per-question answer list: mark correct/incorrect, merge duplicates, set tier. `GET /api/quizzes/{date}`, `PATCH /api/answers/{id}`, `POST /api/answers/{id}/merge`.
- [x] Player detail: attempts, answers, heights. `GET /api/players/{id}`.
- [x] Quiz preview / unpublish. `PATCH /api/quizzes/{date}`.

Decisions worth carrying forward:

- **Re-scoring is scoped to the reviewed answer.** Approving a guess, overriding its tier or merging a duplicate moves only the players who gave that answer. Everyone else keeps the tier they were shown, which is what v0.3.0 promised by freezing points at answer time. Re-scoring a whole question would rewrite scores players had already seen.
- **The re-score lives in the database**, next to `submit_answer`: `review_answer()` and `merge_answer()` both call `rescore_answer()`, so the verdict, the stored answers and the attempt totals move as one unit. Like the scorer, all three are revoked from `anon` and `authenticated` so PostgREST cannot publish them as RPC.
- **Moderators hear any quiz.** `/api/audio/{question}` drops its published-and-not-in-the-future conditions for a moderator token, because previewing tomorrow's song question needs the clip before anyone may play it.
- **Drogon's PostgreSQL driver reports every failure as a plain `orm::Failure`**, with no SQLSTATE and none of the typed subclasses in `orm/Exception.h` (only the SQLite driver raises those). Bad input is therefore checked before it reaches a query: the date shape, the uuid shape, and `tier_id` in the same round trip that reads the answer. `isUniqueViolation()` in `quiz.cc` never matches for the same reason, which is why re-POSTing a quiz that already has attempts answered 400 with a raw Postgres message instead of the documented 409 until v0.4.0 asked the database directly instead. Its one remaining use, in the double-answer path, is a fallback behind a position check that already returns 409.

## v0.5.0 — Admin

Implemented and locally verified; release tag pending.

- [x] Users: list, change role, delete. `GET /api/users`, `PATCH /api/users/{id}`, `DELETE /api/users/{id}`.
- [x] Per-question stats: most guessed answers with their share, height histogram (`quiz_heights` view). `GET /api/quizzes/{date}/stats`.
- [x] Raw table view (read-only, over an allowlist of tables). `GET /api/tables`, `GET /api/tables/{name}`.
- [x] Edit `rarity_tiers` (names, points, shares). `PATCH /api/tiers/{id}`.

Decisions worth carrying forward:

- **Deleting a user deletes the account, not the history.** The route deletes the `auth.users` row over the backend's own connection, which cascades to `profiles` and to Supabase's sessions and identities. `players.user_id` becomes null, so the flights, the stored answers and everyone's rarity shares stay exactly as they were. `quizzes.created_by` needed an `ON DELETE SET NULL` for this: without it the foreign key blocked deleting any moderator who had ever created a quiz.
- **The last admin is protected in the route, not in the database.** A check-then-write refuses to demote or delete the only remaining admin. A constraint cannot express it, since "one admin left" is a property of the table rather than of a row, and a trigger would also fire on the `handle_new_user` path. Two admins demoting each other in the same instant could still leave none; that wants an advisory lock if it ever matters.
- **Editing a tier does not re-score.** Points are frozen at answer time (v0.3.0), and a tier edit is not a verdict on any particular answer, so nothing moves. Only `review_answer` and `merge_answer` re-score, and only the players who gave the reviewed answer. The migration adds the CHECKs the scorer always assumed: `points >= 0` and `max_share` inside `(0, 1]`, because the scorer takes the first tier whose `max_share` covers the share and a gap would silently award zero.
- **The raw table view is an allowlisted dump, never free SQL.** A fixed array in `admin.cc` is the security boundary, so the table name reaches the statement only after it matched. `auth.users` is not on it. Rows are typed by Postgres through `json_agg` rather than serialised column by column, which is also why the route is a handful of lines.
- **Binding an integer to a `::smallint` cast fails.** Drogon sends an `int` as four bytes of binary, Postgres infers `int2` from the cast and rejects the width, reporting the usual untyped failure. Cast to `::int` instead and let Postgres narrow it on assignment. This is the same class of trap as the missing SQLSTATE in v0.4.0: the driver's typing has to be worked out in advance, not diagnosed from the error.

## v0.6.0 — Frontend: play

Implemented and locally verified; release tag pending.

- [x] Launch screen, 7-question flow, timer, audio player for song questions.
- [x] Solar-system flight: altitude = points × 0.1714 AU, landmarks scroll past (Mercury … Neptune, Kuiper belt, heliopause).
- [x] Results screen with tiers and share text.

Decisions worth carrying forward:

- **Answering no longer serves the next question.** `progress()` took a `serve` flag: the answer route passes false, so its response is the result and the totals with `question: null`. v0.3.0 said the timer starts when the question is served, and the old response served the next one in the same round trip, which spent that question's seconds on the result screen. The client now asks for the next question with `POST /api/attempts`, the same call that starts the flight. That also made the start route idempotent under a race: `ON CONFLICT (player_id, quiz_id)` with `xmax = 0` as the created flag, because a client firing the call twice (React's StrictMode does exactly this) otherwise hit the unique constraint and got a 503.
- **`/api/quiz/today` carries the player's own answers.** One extra query on the route already fetching the attempt, rather than a history route the frontend does not have yet. It reports the tier the player was shown, never the accepted answer their guess matched, so the answer key stays shut. This is what makes a reload mid-flight and the day's results screen work without client storage.
- **The flight track was log scaled** in v0.6.0, `log1p(au) / log1p(120)`, so that the inner planets were visible at all. v0.7.0 made it linear again: see there.
- **The share grid is keyed by tier order, not tier name.** `TIER_EMOJI[index of the tier in today.tiers]`, so an admin renaming a tier (v0.5.0 allows it) does not silently turn every glyph into the miss square.
- **The countdown reads the server's deadline, it does not own a clock.** It ticks four times a second off `deadline - now`, and submits whatever is typed when it reaches zero; the backend's three-second grace absorbs the round trip and any clock skew. Nothing about the timer is persisted, so a reload just re-reads the deadline from `POST /api/attempts`.
- **Seeking an `<audio>` element before its metadata arrives is dropped silently.** Setting `currentTime = snippet_start_sec` on mount left the clip playing from zero and giving the intro away. The seek waits for `loadedmetadata` (`readyState >= 1`).

## v0.7.0 — Play, polished

Implemented and locally verified; release tag pending.

- [x] The scene is the page: a persistent, animated solar system behind everything (drifting star layers, a breathing Sun, a comet, a bobbing rocket with a flame), the camera following the rocket as it climbs. Krillion's layout: title up top, the prompt in a card, a fixed HUD along the bottom with a timer ring, the fields, ANSWER and skip; springy buttons, cards that slide in, a score slam on a hit and a shake on a miss, ALT and SCORE chips in the header.
- [x] Song questions: play/pause and a scrubber over the snippet window instead of one button.
- [x] Song and album questions ask for the artist, the title or both (`ask_artist`, `ask_title`, moderator's choice), one field each, with catalog completions from `GET /api/suggest`.
- [x] Album questions (`qtype: album`, `album_id`): the cover is shown, the same fields and scoring apply.
- [x] `scripts/demo_quiz.sql` writes a music quiz for the current game day; the test fixtures ask music questions too.

Decisions worth carrying forward:

- **The track is linear, 60 px per AU.** The log scale moved the rocket 20 % of the track for the first Nebula and 3 % for a closing Supernova, which read as broken. Now the same points always move the same distance; the inner planets sit close together at the bottom, as they do in the sky, and alternating the labels left and right keeps them readable. The track is a 7200 px column translated by the altitude, so nothing is recomputed per frame.
- **Two fields, one answer.** The client joins what was typed as `Artist — Title`, which `normalize_answer` reduces to the same key as a moderator's `Artist Title`. A lone field sends just that name, so an "artist only" row with a fixed tier still matches. No schema change to the answer key, no second scorer.
- **Completions come from the catalog, not the answer key.** `/api/suggest` reads artists, distinct track titles and album titles with an ILIKE scan, prefix matches first, eight rows, nothing under two letters. It is public: the catalog already is through the anon key.
- **The album cover URL goes to the player as is.** Deezer cover URLs are content hashes and name nothing. The album id still never leaves the moderator routes.
- **`ALTER TYPE … ADD VALUE` and the same transaction.** The migration adds `album` to `question_type` and then writes CHECK constraints in the same file. The new value cannot appear as an enum literal until the transaction commits, so the constraints compare `qtype::text`.
- **Derive, do not sync.** oxlint's `set-state-in-effect` flagged two effects that only copied props into state. The rocket's altitude is now derived: the flight's running total while flying, keyed to the identity, else the day's attempt.

## v0.7.1 — Results, Krillion-shaped

- [x] Post-flight screen matches Krillion's landing: score curve of today's pilots, a 7-question flight log, the bearing (what the total points mean), copy result by flight number not date, the haul with every accepted answer and its rarity blurb, a local logbook, a countdown to the 04:00 UTC next flight, a GitHub bug link, and a prompt-idea field.
- [x] Long answers wrap; the page never scrolls sideways.
- [x] `GET /api/quiz/today` carries `flight_no` (count of published quizzes up to today). Share text is `JAMILLION #N`.
- [x] Reveal adds the day's score histogram (`dist`, 36 bins of 20 points) and `better_than`.
- [x] `POST /api/ideas` stores a prompt idea (3–160 characters, three per game day). `question_ideas` is service-role only.

Decisions worth carrying forward:

- **The bearing is total-score bands, not per-answer tiers.** A 150-point flight is still a Nebula even if one answer was a Supernova, the same way Krillion's 0–150 is still Plankton. Protostar is skipped as a band, as Too Clever is on Krillion.
- **The logbook lived in localStorage** until account history existed. v0.8.0 derives it from the server instead: see there.
- **Bugs go to GitHub**, `en1y/jamillion` issues, not a mailbox. Ideas go through the backend so they sit next to the quiz they might become.

## v0.8.0 — Frontend: flight history

Login and register already shipped with v0.2.0's `#/account` panel, so the unbuilt half of "accounts" was history. The quiz editor is its own tag below, because a minor bump should work end to end.

- [x] `GET /api/me/flights` — every flight this passport has flown, newest first, with the tier and points of each answer. Guests included: the passport is the `jam_player` cookie.
- [x] `#/flights`, behind the dock's flight log button: flights, streak, best and average altitude, one expandable row per flight with its tier grid.
- [x] The logbook on the results screen is derived from those flights; the localStorage one is gone.

Decisions worth carrying forward:

- **History is a route, not a client cache.** The query is `getPlayer`'s, with the same account fan-out (`p.user_id = (SELECT user_id FROM players WHERE id = $1)`), so a signed-in player sees one history whichever browser they fly from. A guest row matches only itself, because its `user_id` is NULL and NULL matches nothing.
- **It names the tier, never the accepted answer.** `/api/players/{id}` reports the `matched` display because it is a moderator route; this one keeps v0.6.0's rule that your own results carry the tier you were shown. The answers come back in exactly the shape `/api/quiz/today` uses, so the frontend needed no new type.
- **One source for the streak.** The localStorage logbook was deleted rather than kept beside the server's, because two counters for one streak is a bug that only shows up on someone else's browser. `summarize()` walks the flights newest-first with the same `nextIsoDate` step the old `recordFlight` used.
- **One row per day, the best one.** `attempts` is unique per `(player_id, quiz_id)`, not per account, so two browsers that each flew a day as guests and then signed into the same account own two attempts for it. `DISTINCT ON (quiz_date)` collapses them; without it the streak stopped at 1 and React saw a duplicate key.
- **A 401 renders as an empty log.** A browser that has never called `/api/me` has no passport, which to a player is the same thing as no flights.

## v0.8.1 — Answer fields check the catalog

- [x] `GET /api/known?kind=artist|title|album&q=` — is this a real catalog name? Compared through `normalize_answer()`, so casing and punctuation still pass.
- [x] Song and album questions check each filled field on ANSWER. An unrecognised name is refused once with the field flagged; pressing ANSWER again sends it as is.

Decisions worth carrying forward:

- **The check is against the catalog, never the answer key.** Refusing anything not in `question_answers` would turn every question into an oracle: a player types until the game says yes, which hands out the key, removes the rarity mechanic and starves the v0.4 review queue. The catalog is already public through the anon key and `/api/suggest`, so asking it whether a name exists reveals nothing new.
- **It refuses once, not forever.** The catalog is the top artists, not every recording, and a moderator may accept an answer that is not a catalog name at all. A second press on the unchanged text sends it, so the nudge can never trap a correct answer. The guess still lands with `is_correct` null for review.
- **The clock is untouched.** At zero the client submits whatever is typed, checked or not, and a failing `/api/known` fails open. A validation step must not cost a player their guess.
- **Rarest questions are never checked.** There is no catalog kind for a free-text answer, and inventing one would be the answer-key oracle by another route.


## v0.9.0 — Frontend: admin

- Users, stats, tier editor, table view.

## v0.10.0 — Hardening

- Rate limits, input limits, CORS, HTTPS config, backups.
- Docker compose for db + backend + frontend.

## v1.0.0 — Public

## Later

- Supabase migration (schema is plain Postgres; swap connection string + auth).
- Answer aliases / fuzzy matching.
- Archive and unlimited modes.
