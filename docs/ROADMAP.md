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

- Frontend signs up and logs in through `@supabase/supabase-js`; Supabase issues the access token. No password ever reaches our backend.
- Drogon verifies that token with `SUPABASE_JWT_SECRET` (jwt-cpp, HS256, added via FetchContent) and reads the role from `profiles`.
- `jam_player` cookie for anonymous players; signing in links the player row to the profile.
- Role guard: user / moderator / admin. `GET /api/me`.
- Later, free from Supabase: OAuth providers, password reset, email confirmation.

## v0.3.0 — Quiz play

- Moderator: `POST /api/quizzes` for a date, 7 questions (`rarest` or `song`), track + snippet start/len, accepted answers with tiers.
- `GET /api/quiz/today` (no answers), `GET /api/audio/:track` streams the cached preview clip.
- `POST /api/attempts`, `POST /api/attempts/:id/answers` — 20 s server-side timer, answer normalisation, one attempt per player per day.
- Rarest tiering by answer share (`rarity_tiers.max_share`), moderator override wins.
- 04:00 UTC rollover.

## v0.4.0 — Moderation

- Per-question answer list: mark correct/incorrect, merge duplicates, set tier.
- Player detail: attempts, answers, heights.
- Quiz preview / unpublish.

## v0.5.0 — Admin

- Users: list, change role, delete.
- Per-question stats: most guessed answers, height histogram (`quiz_heights` view).
- Raw table view (read-only SQL over an allowlist of tables).
- Edit `rarity_tiers` (names, points, shares).

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
