# Roadmap

Semantic versioning. Minor bumps = a new capability that works end to end. Patch bumps = fixes and small additions inside a minor. `v1.0.0` = playable by strangers. Each version is a git tag.

Backend first (v0.1 – v0.5), frontend second (v0.6 – v0.8).

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

- Launch screen, 7-question flow, timer, audio player for song questions.
- Solar-system flight: altitude = points × 0.1714 AU, landmarks scroll past (Mercury … Neptune, Kuiper belt, Voyager 1, heliopause).
- Results screen with tiers and share text.

## v0.7.0 — Frontend: accounts and moderator

- Login / register / history.
- Quiz editor: track search, waveform + snippet picker, answer/tier table.

## v0.8.0 — Frontend: admin

- Users, stats, tier editor, table view.

## v0.9.0 — Hardening

- Rate limits, input limits, CORS, HTTPS config, backups.
- Docker compose for db + backend + frontend.

## v1.0.0 — Public

## Later

- Supabase migration (schema is plain Postgres; swap connection string + auth).
- Answer aliases / fuzzy matching.
- Archive and unlimited modes.
