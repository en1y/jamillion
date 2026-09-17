# Roadmap

Semantic versioning. Minor bumps = a new capability that works end to end. Patch bumps = fixes and small additions inside a minor. `v1.0.0` = playable by strangers. Each version is a git tag.

Backend first (v0.1 – v0.5), frontend second (v0.6 – v0.9).

## v0.0.x — Foundation

- **v0.0.1** ✅ Repo, README, docs, schema, seed scripts, Drogon + Vite skeletons, `/api/health`.
- **v0.0.2** Supabase from the start: schema moved to `supabase/migrations/`, auth on Supabase Auth (`profiles` + first-signup-is-admin trigger), RLS on every table, Postgres in Docker.

## v0.1.0 — Music catalog

- [x] Supabase stack running, schema applied as a migration.
- [~] Seed top 500 artists: Deezer catalog (albums, tracks, labels, UPC/ISRC, BPM, fans, preview clips), Last.fm ranking + listen counts, MusicBrainz country/type/gender/years, YouTube video ids + views. Originals only. Running.
- [x] `GET /api/tracks?q=&artist=&year=&min_rank=` search for the quiz editor. Replaced by `POST /api/catalog` in v0.8.4.
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

- [x] Users: list (filtered and sorted), change role, delete. `GET /api/users`, `PATCH /api/users/{id}`, `DELETE /api/users/{id}`.
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

Login and register already shipped with v0.2.0's `/account` panel, so the unbuilt half of "accounts" was history. The quiz editor is its own tag below, because a minor bump should work end to end.

- [x] `GET /api/me/flights` — every flight this passport has flown, newest first, with the tier and points of each answer. Guests included: the passport is the `jam_player` cookie.
- [x] `/flights`, behind the dock's flight log button: flights, streak, best and average altitude, one expandable row per flight with its tier grid.
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

## v0.8.2 — The editor's backend

The quiz editor could not be started: six things it needs did not exist, and one of them meant a whole question type was unauthorable. Split from the UI so each tag works end to end and the contract can be exercised by curl before a component is written.

- [x] `GET /api/albums?q=&artist=&year=&min_rank=&limit=` — the other half of `/api/tracks`. Both replaced by `POST /api/catalog` in v0.8.4.
- [x] `GET /api/tiers` — the tiers **with ids**, which a `tier_id` override needs.
- [x] `GET /api/quizzes?from=&to=` — which days already have a quiz, and which are frozen.
- [x] `GET /api/tracks/{id}/audio` — a clip before any question uses it.
- [x] `album.cover` in `GET /api/quizzes/{date}`.
- [x] `PATCH /api/questions/{id}` — the prompt always, the rest only while the day is unplayed.

Decisions worth carrying forward:

- **Album questions had shipped unauthorable.** v0.7.0 added `qtype: album`, and `POST /api/quizzes` requires an `album_id` for one, but `/api/tracks` reports an album by title, `/api/suggest?kind=album` groups ids away, and the only route that yielded one was the **admin**-only table dump. A moderator could not write the question type built for them. `GET /api/albums` is the fix, and the integration test is an album question authored end to end without touching an admin route.
- **Tier ids were in the same position.** `/api/quiz/today` serves `{name, points}` and 404s when no quiz is scheduled, so nothing a moderator could reach said what to send as `tier_id`.
- **Auditioning a track is what makes saving fast.** `ensureAudio` is idempotent and writes `tracks.audio_path`, so the picker's preview leaves the clip cached and `createQuiz`'s blocking pre-cache loop (1–3 s per uncached track) finds every file already on disk. A measured save with a warm clip is 0.2 s. The editor gets this for free from the route it needed anyway.
- **One clip helper, two routes.** The filename-to-response sequence was inline in `audio` and is now `clip()`, so the content type and the cache header are decided in one place rather than copied.
- **A played day freezes at the prompt.** v0.3.0 froze points at answer time; moving a track, a snippet or the answer key under people mid-flight would invalidate scores already shown. So `PATCH /api/questions/{id}` takes the prompt on any day and everything else only while `attempts` is empty — 409 otherwise. `qtype`, `position`, `track_id` and `album_id` are never editable: a different track is a different question, and on an unplayed day re-POSTing the day already does it.
- **The DB CHECKs are pre-empted, not surfaced.** The snippet window and the ask-flag rule are checked in the handler so a moderator never reads Postgres's own words out of the editor — the same reason v0.4.0 stopped relying on `isUniqueViolation`.

## v0.8.3 — Frontend: quiz editor

Every quiz until now was written with curl or `scripts/demo_quiz.sql`. The moderator role has existed since v0.0.2 and its backend since v0.4.0; this is the face.

- [x] `/editor` day list and `/editor/{date}`, behind a **flight deck** chip only moderators and admins see.
- [x] Seven question cards: type, prompt, catalog search for song and album questions, accepted answers with tier overrides.
- [x] The snippet picker is a real decoded waveform with the window highlighted and clamped to the clip.
- [x] Picking a track seeds the accepted answers, including the artist-only row that gives partial credit.
- [x] A flown day freezes: read-only questions, a correctable prompt, and the review queue live under each one.
- [x] Work in progress survives a reload in `localStorage`; a save clears it.

Decisions worth carrying forward:

- **The pure half is a separate module.** `quizdraft.ts` holds the draft shape, the payload builder, the problem list, the snippet clamp and the seeding, with no JSX and no fetch, so `node --test` covers them the way it covers the flight maths. `Editor.tsx` is only what needs a DOM.
- **The problems list mirrors `validate()` rather than waiting for it.** The moderator reads what is wrong beside the field instead of after a round trip, in the same words. The backend still decides; the client is a courtesy, which is why `normalizeAnswer` only has to be close enough to spot a duplicate — `UNIQUE (question_id, normalized)` is the real boundary.
- **The clip is fetched once and used twice.** `/api/tracks/{id}/audio` is moderator-guarded, so an `<audio src>` cannot reach it; the bytes come in through `fetch` with the token, become a blob URL for playback **before** `decodeAudioData` gets them, because decoding detaches the buffer.
- **Auditioning is what makes the save fast.** The picker's preview caches the clip through `ensureAudio`, so `createQuiz`'s pre-cache loop finds the file on disk. Measured: 0.2 s to save a day whose track had been auditioned.
- **A frozen day shows one list of answers, not two.** The accepted-answer editor is hidden once the day has attempts, because the review queue below it lists the same answers with controls that actually do something. Two lists of the same thing, one inert, is how a moderator learns to distrust the screen.
- **Four routes, still no router.** The hash is split once into a screen and an argument. A dependency earns its place when a screen needs two segments.

## v0.8.4 — The catalog query

`/api/tracks` and `/api/albums` took four fixed filters and one fixed sort each, and the editor's picker was two text boxes over them. That answers *find me this song*; it does not answer the questions a moderator actually writes. "Name an Adele song over a million listens" and "name a song from Coldplay's Parachutes" are queries, and a moderator should not have to type out twenty answers the database already knows.

- [x] `POST /api/catalog` — one route over `tracks`, `albums` and `artists`, taking a **stack** of filters and a **stack** of sorts across 35 allowlisted columns.
- [x] `GET /api/catalog/fields` — the allowlist itself: every column, its datatype, and the operators that datatype offers.
- [x] `GET /api/tracks` and `GET /api/albums` deleted; nothing calls them any more.
- [x] The editor's query builder: entity switch, stacked filter rows, stacked sort rows, sortable column headings, and a results table with the numbers you sorted by in it.
- [x] Results become accepted answers in one press — all of them, or the ticked ones — as the title, `artist — title`, or the artist.
- [x] The same builder is the song and album picker, so one component and one route cover both jobs.
- [x] `artist.formed_year`, `artist.born_year` and `artist.first_release` — because `begin_year` alone is a trap.

Decisions worth carrying forward:

- **The allowlist is the whole security boundary.** No table name, column name or operator reaches the SQL from the request — only a key that matched a row in `kColumns` or `kOps`; values are always bound parameters. The same trade `/api/tables` makes, and the reason there is no `?where=` and no free SQL.
- **The datatype decides the operators, not the field.** `contains` is offered on text and refused on a number, `gte` the other way round, and the editor reads both lists off `/api/catalog/fields`. A column added to `kColumns` appears in the browser with no frontend change, which is the point of serving the schema rather than keeping a second copy in TypeScript.
- **AND only, with `in` for the common OR.** Stacked filters all have to match. Real OR needs grouping, which doubles the UI for a need that "one of: adele, coldplay" already covers.
- **Every column comes back, not a projection.** A row carries all 35 of its entity's fields, so the table can show whatever was filtered or sorted on without a second request describing what to select. `json_agg` in Postgres types the rows, so nothing is marshalled field by field in C++ either.
- **The answers are materialised, not a saved query.** A query becomes rows in `question_answers` at the moment the moderator presses the button. Tiers hang off individual answers, `submit_answer()` matches against them, and the review queue edits them — a live rule would have to fight all three.
- **`begin_year` means two different things.** MusicBrainz's artist *begin* is a birth year for a person and a formation year for a group, so "bands formed before 1980" on the raw column returns Eminem, born 1972. `formed_year` and `born_year` are that column split by `artist_type`, and `first_release` — the earliest record by them in the catalog — is the one that answers the question for both kinds. It is honest about its bound: an artist held here only from a later compilation reads late.
- **The derived date is a LATERAL, not a subquery in the select list.** The same artist repeats all the way down a page of tracks; as two correlated subqueries a 500-row page cost 86 ms, as a memoised `LEFT JOIN LATERAL` it costs 1 ms.
- **The counts are on screen.** The results table shows the row's identity plus every field filtered or sorted on, so "sorted by listens" is a number you can read rather than an ordering taken on trust.

## v0.8.5 — The question, as a moderator would want to write it

Four things the song question had been getting wrong: the moderator retyped an answer key the database already knew, there was no way to ask which record a song came from, and the 20 second clock -- written for a rarest question -- was being applied to one where you listen first and then remember.

- [x] `ask_album` on a song question: which record is this from. Song only, and rejected on an album question, where `ask_title` is already the album's title.
- [x] `time_limit_sec = 0` is no clock, in the schema, the handler and the served question (`deadline: null`). Song and album questions default to it; the editor sets it per question.
- [x] A song or album question writes its own answer key from the pick and the fields it asks for, and rewrites it whenever either changes.
- [x] The snippet window is trimmed on the waveform: either edge moves that end, the middle slides the whole thing, bare waveform draws a new one.
- [x] The moderator edits one row per field and one tier for "all of them right"; the combinations are generated on the way out and folded back up on the way in.
- [x] The player's fields complete against the catalog in a real dropdown, not a `<datalist>` the browser may or may not draw.
- [x] Points add up across the fields a player got right; `question_answers.points` carries a total no tier can name, and the all-correct bonus is optional.
- [x] One press spreads the rarity ladder over the accepted answers as they stand, and another takes the whole lot back out.
- [x] "0 pts · no score" in every tier select, in the editor and in the review queue.

Decisions worth carrying forward:

- **The key is every combination; the moderator is not.** A player who fills two of three fields typed something right, so all 2ⁿ−1 non-empty subsets have to be stored. But a 7-row list of concatenations is not something anyone should read, let alone edit: the editor shows one row per field plus a single "all three right → tier", and `expandAnswers` writes the rest on the way out. `absorb` folds them back up when a saved day reopens, and the round trip is exact.
- **A combination is worth its fields added up.** Each field carries a tier, a player scores every field they got right, and the "all of them" tier is an optional *bonus* on top rather than a replacement — leave it off and a perfect answer is simply the sum. A sum is rarely a number the fixed rarity ladder names, so `question_answers.points` was added to override the tier's own value; `tier_id` stays, and is still the star the player is shown. A field left "by rarity" has no fixed value, so combinations containing it fall back to a tier while the ones that avoid it still add up.
- **A verb belongs on a button, not a toggle.** "Spread the tiers" began as a chip in the query panel, on by default, so the one press that felt like switching it on switched it off and every answer landed on rarity. It is an action button on the accepted-answers list now: it does what it says, when pressed, to what is on screen. That is also where it belongs — a moderator assembles a list from several searches and a few hand-typed rows before deciding what any of it is worth, and tiering at add time could only ever see one query's worth.
- **The order of the list is the rarity.** Twenty-five answers all landing on "by rarity" is a question that scores everything the same until enough people have played. The spread hands the ladder out down the list as it reads — both ends getting a couple of rows and the middle dividing evenly (`Math.round(i * (T-1) / (N-1))`). The list keeps the order things were added in, so a catalog sorted by listeners descending reads as popularity; sorting by something else means something else, and that is the moderator's business.
- **Adding twenty-five rows in one press needs a way back.** "remove all N" drops everything the moderator or the catalog put in, and leaves the seeded field rows alone — those are generated from the pick, not added.
- **Worth nothing is a verdict, not an absence.** "0 pts · no score" sits in every tier select — the draft's answer rows, the fields of a song question, and the review queue on a played day — beside *by rarity* and the six tiers. It stores `points = 0`, so the answer is still accepted and still counted as a guess; it simply scores nothing, and a field set to it contributes nothing to the sums around it. The select value is the sentinel `'zero'` rather than `0`, which would read as a tier id.
- **A hand-set tier clears the generated sum.** `review_answer` takes the answer's `points` outright, and `PATCH /api/answers/{id}` sends none of its own when the body carried a `tier_id`. Without it, a moderator retiering a combination in the review queue would watch the override silently win and conclude the select was broken.
- **The draft key carries a shape version.** A draft written before `ask_album` and the track's album existed restored with those missing, and the symptom was silent: ticking "ask for the album" seeded nothing, because the saved pick had no album on it. `jamillion-draft-2-` drops a stale draft instead of half-reading it, and `restore()` fills in whatever a future shape adds.
- **A `<datalist>` is not a dropdown.** Browsers draw it their own way or not at all, and a three-field song question is exactly where a player needs to see what the catalog has. The replacement is a listbox that opens *upward*, because the fields live in the HUD along the bottom edge; `mousedown` is swallowed so a click lands on a list that is still open, and Enter takes the highlighted option instead of sending the guess.
- **Seeded rows are marked, so reseeding is not destructive.** `DraftAnswer.seeded` is draft-only (`toPayload` sends `display` and `tier_id`). Flipping an ask flag rebuilds the seeded rows and leaves anything typed by hand; a hand-typed row that normalises to a new seed loses to the seed rather than becoming a clash `draftProblems` has to report.
- **0 rather than a nullable column.** `time_limit_sec` is `NOT NULL DEFAULT 20` and every read multiplies it into an interval; a null would have meant touching each of those. 0 falls out naturally — the deadline is a `CASE`, and the late check gains one `time_limit_sec > 0`. The range moved into the schema at the same time, where it should have been.
- **The window is edited where it is drawn.** Dragging it around as a whole was half the job: a snippet is chosen by ear, one end at a time. A press is classified by where it lands — within 0.75 s of an edge trims that end, inside slides the window, outside draws a new one — and the cursor (`col-resize` / `grab` / `crosshair`) is written straight to the node rather than through a render, since it changes on every mouse move. The grab zone is in seconds, not pixels, so it does not shift with the width of the deck.
- **30 seconds is the clip, not a choice.** Deezer and the iTunes fallback serve a 30 s preview and CLAUDE.md rules out full tracks, so there is no more song to select from. The waveform is that clip end to end, and `snippet_in_clip` says the same thing in the schema.

## v0.9.0 — Ground control

The admin backend shipped in v0.5.0 and has had no face since. Roles, the day's numbers, the rarity ladder and the raw tables were four things an admin had to leave the app and pick up curl for. This is a frontend tag: the only backend change is two lines, because the tier editor cannot show a threshold the route does not report.

- [x] `/admin/{tab}`, behind a **ground control** chip only admins see: users, stats, tiers, tables.
- [x] Users: search across username and email, a role filter, six sortable columns, a role select per row and a delete, with the last-admin 409s read back as they are written.
- [x] Per-question stats in two places: its own tab with a typed date, and an admin-only **▪ THE NUMBERS** block on the editor's day screen once the day has flights.
- [x] The rarity ladder edited in place — name, points and the share that still reaches the tier — one row at a time, with the backend's own checks mirrored beside the field.
- [x] The allowlisted table dump: sixteen tables, a page size, and paging that is honest about not knowing the total.
- [x] `max_share` on `GET /api/tiers`, as text.

Decisions worth carrying forward:

- **No total, so the page says only what it can see.** Neither `/api/users` nor `/api/tables/{name}` counts its rows, and counting on every keystroke is a second query for a number nobody acts on. `rowRange` names the window that is on screen — *rows 51–100* — and Next dies on a short page. A last page that happens to be exactly full costs one request to an empty one that says *past the end*. That is a page cheaper than knowing, and it never lies.
- **A sparse list of scores is a bar chart, not a curve.** `quiz_heights` is already a histogram: one row per distinct score with a count. `curveGeom` wants a dense 36-bin array and marks where *you* landed, and there is no "you" on an admin screen — reusing it would have meant a binning function, the `.curve` SVG copied out of `Play.tsx`, the marker suppressed, and a confident Gaussian smoothed over the twelve people who actually flew.
- **One stats block, two homes, one direction of import.** It lives in `Admin.tsx`, because the route is admin-only, and `Editor.tsx` imports it. The reverse would have dragged an admin route into the moderator file. Importing `DatePicker` back the other way would have made the two files circle each other, which is why the stats tab types its date instead of picking it.
- **The editor's copy waits for flights.** `frozen` — `attempts_started > 0` — was already the boolean for it. Every number in the block is zero until somebody flies, and on an unwritten day the route 404s.
- **`max_share` came out of the moderator route, not a new one.** Two lines on `GET /api/tiers`, cast to text like every other numeric on the wire: the top step is `0.0020` and a JSON float hands that back as `0.002`. The admin table dump would have served the whole row for free and rounded it, and would have leaned on `id` order matching `sort_order`.
- **Demoting yourself reloads the page.** Permissions are read from `profiles` on every request, so the instant the PATCH lands the chip in the dock and the guard on the route disagree. A `confirm()` that says exactly what is about to happen, then `location.reload()`, is one line and cannot go stale. Deleting your own account is refused in the row rather than in the backend, which allows it while another admin exists: a table row is not where a sign-out flow belongs.
- **A tier edit warns where the edit is made.** Points are frozen at answer time, so the change is silent about everything already flown and only decides what a *future* answer falls into. That sentence sits above the ladder, not only in the docs.
- **The dump shows what came back and nothing else.** An empty page carries no column names, so the screen says which table is empty instead of inventing a header row, and its headings are plain text rather than buttons, because there is no sort parameter to give them. The same trade the allowlist makes: the route is deliberately dumb, and the screen does not pretend otherwise.
- **`node --test` resolves imports the way Node does.** `admin.ts` is the first module a test loads that has a *value* import of another source file, and extensionless `./api` is a Vite convenience Node does not share. The `.ts` goes on that one import; type-only imports are erased and need none.

## v0.10.0 — Hardening

Everything up to here was built to be run by one person on one laptop, and it
showed: no rate limiting anywhere, `/api/me` inserting a `players` row on every
cookieless request, two unauthenticated `ILIKE` scans, `/api/health` handing the
database's own words to anonymous callers, and the whole Drogon configuration in
one line. No container, no TLS, and a backup procedure that existed only as a
comment inside `supabase/seed.sql`.

- [x] Rate limits: Drogon's `Hodor` plugin, per-IP and per-user, with sub-limits
      on the routes that actually cost something. `RealIpResolver` in front of it.
- [x] Input limits: a request body cap, the user search term, the catalog filter
      and sort stacks, the filter value, the tier name.
- [x] `/api/health` stops reporting the database's own error.
- [x] HTTPS and one origin: Caddy serves the built SPA and proxies `/api`.
- [x] `docker compose up` — backend and frontend. **No db service**: Postgres and
      Auth stay in the Supabase stack.
- [x] `scripts/backup.sh`, and the `clip()` fix that makes a restore survivable.
- [x] `backend/tests/hardening.py`.

Decisions worth carrying forward:

- **Hodor's `trust_ips` and RealIpResolver's `trust_ips` are spelled the same and
  mean opposite things.** The resolver's list is the proxies whose forwarded
  address is believed; Hodor's is addresses **exempt from every limit**. Handing
  Hodor the proxy range — the obvious move, since the two configs sit next to each
  other — exempts whatever the proxy forwards for whenever the resolver comes up
  short, and the symptom is a rate limiter that silently does nothing. Caught
  because ten bursts from loopback all returned 200. Hodor gets no `trust_ips`.
- **RealIpResolver parses `trust_ips` as `in_addr_t`, so the list is IPv4 only.**
  An entry like `::1` throws out of `initAndStart` and takes the process down at
  startup, before the listener binds. The default is `127.0.0.1,172.16.0.0/12`.
- **The plugins are configured from a `Json::Value`, not a config file.**
  `app().addPlugin(name, dependencies, config)` takes the JSON in memory, so the
  "no config.json, everything from the environment" rule survives contact with a
  plugin system that documents itself entirely in terms of a config file.
- **The user-id getter has to read the cookie, not the identity.** Hodor registers
  a *pre-handling* advice, which runs before `auth::Optional` has inserted
  `"identity"` into the request's attributes; reading the attribute there throws.
  `auth::cookiePlayer(req)` is already a free function on the request.
- **A throttle is the same shape as every other refusal.** `setRejectResponseFactory`
  returns `auth::error(k429TooManyRequests, ...)`, so the body is `{"error": ...}`
  and `frontend/src/api.ts` renders it without learning a new response. Hodor's own
  default is a plain-text body, which would have read as a blank error to the app.
- **`/api/ideas` keeps its 200.** The three-per-game-day count is a game rule with
  a friendly message, not abuse protection, and the frontend reads that shape.
  Hodor sits in front of it for the abuse case.
- **CORS is not implemented, on purpose.** Caddy serves the SPA and proxies `/api`,
  so there is one origin and nothing to allow. If the SPA ever moves to its own
  host it is a pre-routing advice for `OPTIONS`, a post-handling advice for the
  headers, and moving the `jam_player` cookie to `SameSite=None; Secure`.
- **A client cannot forge its own IP through Caddy.** Caddy replaces
  `X-Forwarded-For` unless the peer is one of its own `trusted_proxies`, so an
  injected header never reaches the limiter. That is also why the resolver had to
  be proved against the backend directly, where loopback *is* a trusted proxy:
  two forwarded addresses, two budgets of ten.
- **Compose has no database service, and `DB_*` is not `PG*`.** *(Superseded in v0.11.0: compose brings its own Supabase.)* The roadmap line
  said "db + backend + frontend", but CLAUDE.md says Postgres only ever runs
  inside the Supabase stack, and a second Postgres would not carry GoTrue anyway —
  the backend's whole auth story is verifying tokens that `auth.users` issued. The
  env names are deliberately different because compose reads the same `.env` the
  host tools use, where `PGHOST=127.0.0.1` means the container.
- **The backend image is not a lone binary.** `ensureAudio` shells out to
  `scripts/fetch_audio.py`, so the runtime carries python and three packages, and
  needs `DATABASE_URL` the backend itself never reads. The dependency build gets
  its own layer by configuring against a stub source: the glob in `CMakeLists.txt`
  needs one file to configure at all, and configuring is what clones Drogon.
- **The dump is `-n public -n auth`.** A whole-database `pg_dump` of a Supabase
  instance restored with 56 errors — realtime's partitions, vault, the extension
  grants — none of them jamillion's. Narrowed to the two schemas the app owns, a
  restore into a scratch database reproduced every table's row count exactly.
- **`data/audio/` is a cache, and now behaves like one.** `clip()` re-fetched only
  when `tracks.audio_path` was *empty*, so a restored database meeting an empty
  audio volume 404'd every song question for good. It now also re-fetches when the
  column is set but the file is gone, which is what makes the audio tarball a
  convenience rather than load-bearing state.
- **The container had been up for eight minutes and logged nothing.** Trantor
  `fwrite`s every line to stdout and calls `fflush` *only at error level*, so with
  a pipe instead of a tty the startup line, the `RATE_LIMIT=off` warning and the
  shutdown warning all sat in a buffer until the process died; `docker compose
  logs -f backend` on a healthy stack showed an empty screen. `setvbuf(stdout,
  nullptr, _IOLBF, 0)` is the whole fix. A log line flush policy is not something
  you notice until you are looking at the logs on purpose, which is what the
  health check made somebody do.
- **`getDbClient()` is not a startup API.** Its doc comment says it must be called
  after the framework has run, and it means it: the manager is built inside
  `run()`, so a `getDbClient()->setTimeout()` in `main()` dereferences null and
  takes the process with it at startup. The query timeout is an argument to
  `createDbClient`, which is also the only place `DbClientManager` applies it.
- **A query with no ready connection is buffered and never called back.** With no
  timeout — Drogon's own default — a database that is down makes *every* route
  wait forever, the health route included, which is the opposite of what the route
  is for: pointed at a port with nothing on it, the request hung past two minutes
  while the process stayed alive and answered other routes. `DB_TIMEOUT_SEC` (5)
  turns it into the generic error each route already reports, and since the answer
  is a real one now, compose health checks `/api/health` and `web` starts on
  `service_healthy` instead of racing the backend into a 502.
- **A restore into an empty database exits 1, and none of it is data.** Drilled
  into a scratch database: 26 errors — 19 `DROP POLICY IF EXISTS` that `--clean`
  emits before the table `IF EXISTS` needs exists, one `auth.users` trigger and
  six Supabase default-privilege statements. All 17 `public` tables matched the
  live row counts afterwards and both views kept `security_invoker = true`. The
  dump is right; the exit code is not the check.
- **The SPA image refuses to be built without a Supabase project.** *(Superseded in v0.11.0: the anon key arrives at runtime.)* `VITE_*` is
  baked in at build time and vite inlines `undefined` for a missing one, so an
  image built from the local `.env` asks each *visitor's* `127.0.0.1:54321` for a
  token — a stack that works only on the machine it was built on, and only fails
  in the browser. The build now stops on an empty argument, and a deployment
  passes the hosted project's URL and anon key.

## v0.11.0 — Pull and run

v0.10.0's compose needed `npx supabase start` on the host, a checkout to build
from, and an `.env` of keys, which is a stack you cannot hand to anyone.

- [x] `db`, `auth` and `rest` from Supabase's own images, the tags the CLI runs.
- [x] Secrets generated on first boot; migrations applied by a one-shot on every boot.
- [x] Caddy routes `/auth/v1` and `/rest/v1`; the anon key reaches the browser at runtime.
- [x] Three published images, `en1y/jamillion-{backend,db,web}`: `compose.yaml` alone
      runs the stack, `compose.build.yaml` builds it.
- [x] A setup page on first visit: the admin account, the catalog keys, how many
      artists; the keys kept in a volume only the backend mounts; the seeder started
      by the backend.
- [x] A startup summary in the backend log: where to open it, whether setup is
      done, the schema version and what the database holds.

Decisions worth carrying forward:

- **Three Supabase services, not eleven.** The browser signs in and calls one RPC;
  nothing uses storage, realtime, Studio or edge functions, and Kong's job — routing
  and an `apikey` check on a key every visitor already has — is two `handle_path`
  lines in the Caddyfile.
- **The generated secrets live in a volume, and each image is handed them its own
  way.** Compose cannot read an env file out of a volume, so `db`, `auth` and
  `backend` source it in a `sh -c` entrypoint, and PostgREST — whose image has no
  shell — reads `@/secrets/jwt_secret` and `@/secrets/rest_db_uri`, its own
  from-file syntax. Only `public/` is mounted into Caddy, via a volume `subpath`.
- **Those secrets are bound to the database volume.** The Supabase postgres image
  runs `/etc/postgresql.schema.sql` once at the end of initdb, which is where the
  role passwords are set; a new `secrets` volume against an old `db` volume is a
  stack that cannot log in. They are removed together or not at all.
- **Migrations run after GoTrue is healthy**, because they hang a trigger on
  `auth.users` and that table is GoTrue's own first migration. They are recorded
  in the CLI's `supabase_migrations.schema_migrations`, so both ways agree.
- **The keys are entered in the browser, not a terminal.** `docker compose up -d`
  cannot ask a question, and a wizard in `docker compose run` is a second command
  that needs a TTY. The setup page is also where the admin account has to be made
  anyway. `POST /api/setup` is admin-only and write-only: no route returns a key.
- **The keys are a file in a volume, not a table.** `settings.json`, `0600`, in a
  `config` volume mounted into the backend alone. A table would be one RLS
  mistake away from PostgREST, which is on the public origin; a file there is
  unreachable from every other container. The cost is that `pg_dump` does not
  carry them, which is the right way round for credentials.
- **The backend runs the seeder, not a worker service.** It already shells out to
  `fetch_audio.py`, so the image already had python; it gained the seed script's
  packages in a venv. `fork` + `execvpe` with the environment built before the
  fork, `setsid`, and a thread that `waitpid`s the child, so a finished seeder is
  not a zombie that still reads as running. One at a time, under the same lock as
  the settings write. A restart of the container stops it; the seeder commits per
  artist, so calling setup again picks up.
- **`compose.yaml` has no `build:` at all.** A downloaded compose file with a build
  context that does not exist is a trap; `compose.build.yaml` layers the three
  builds on for a checkout. Tested by copying `compose.yaml` alone into an empty
  directory and running it with `--pull never` against the local images.
- **Plain HTTP on 8000 by default, HTTPS only with a hostname.** A certificate
  for `localhost` is Caddy's own CA: a warning on every browser that opens it, on
  ports 80 and 443 a desktop would rather keep. `SITE_ADDRESS` carries the scheme,
  `HTTP_PORT`/`HTTPS_PORT` what the container's 80 and 443 are published as, and
  the site address needs no port of its own because Caddy matches a site on the
  hostname and ignores the port in the `Host` header.
- **Development keeps `.env`.** A key in the environment counts as configured, so
  the setup page never shows for a developer whose `.env` has `LASTFM_API_KEY`
  and an admin.
- **The startup summary asks the database**, so a summary with numbers in it is
  also the proof that the backend is wired to the right one.
- **`src/limits.h` shadowed `<limits.h>`.** Any target with `src/` on its include
  path — `auth_guards_test` — lost `INT_MAX` inside OpenSSL's headers. The module
  is `ratelimit.{h,cc}` now.

## v1.0.0 — Public

Everything a stranger meets before the game: the repository, the images, the
first visit.

- [x] The README is the front door: what it is, three lines to run it, how it
      plays, the flight deck, the stack, with screenshots of a real flight.
- [x] CI on every push and pull request: frontend tests, lint and build; the
      backend built with its tests.
- [x] A `v*` tag publishes `en1y/jamillion-{backend,db,web}` to Docker Hub from
      CI, so a release is a tag and nothing else.
- [x] A bug report template behind the results screen's link.
- [x] Description and social meta on the page; description and topics on the
      repository.

Decisions worth carrying forward:

- **A release is a tag.** The version lives in `backend/CMakeLists.txt` and
  `frontend/package.json`; the tag's number is what the images are pushed as,
  and `latest` follows it. Publishing needs `DOCKERHUB_USERNAME` and
  `DOCKERHUB_TOKEN` as repository secrets, and without them the job says so
  and passes, so a fork's CI is not red for lack of a registry.
- **`docs/README.md` is gone.** GitHub shows the root README and nothing else,
  and two READMEs is two places for one sentence to go stale.

## v1.0.1 — Phones

The same flight, on a phone that can keep up with it.

- [x] The scene is `100lvh` tall instead of `inset: 0`: the URL bar showing and
      hiding on scroll no longer moves the Sun and the rocket or re-scatters the stars.
- [x] Mobile Firefox stops stuttering: the Sun breathes through the opacity of a
      second glow instead of an animated 700px shadow, the starfield paints at 1x on
      a touch screen and no longer measures the camera every frame, the prompt card
      and its exit lose their blurs, the flame flickers by scale instead of height.
- [x] Song questions fit a phone: the artist and title boxes take the whole row,
      and the snippet drops its volume knob (the phone has keys; the gear has the knob).
- [x] The distance to the planet behind and the one ahead sits under the header,
      not under the gauges.
- [x] A favicon: the ✦ from the header, in flare gold.

## Later

- Supabase migration (schema is plain Postgres; swap connection string + auth).
- Answer aliases / fuzzy matching.
- Archive and unlimited modes.
