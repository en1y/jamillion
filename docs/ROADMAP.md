# Roadmap

Semantic versioning. Minor bumps = a new capability that works end to end. Patch bumps = fixes and small additions inside a minor. `v1.0.0` = playable by strangers. Each version is a git tag.

Backend first (v0.1 – v0.5), frontend second (v0.6 – v0.8).

## v0.0.x — Foundation

- **v0.0.1** ✅ Repo, README, docs, schema, seed scripts, Drogon + Vite skeletons, `/api/health`.

## v0.1.0 — Music catalog

- Seed top 500 artists from Last.fm chart, all original songs (no live/remix/demo), Spotify popularity, ISRC, 30 s preview URLs (Deezer/iTunes), YouTube video ids + view counts.
- `GET /api/tracks?q=&artist=&year=&min_popularity=` search for the quiz editor.
- Patch ideas: MusicBrainz release-date backfill, Last.fm per-track listeners.

## v0.2.0 — Auth and players

- `POST /api/auth/register`, `POST /api/auth/login` → JWT (jwt-cpp, HS256, `JWT_SECRET`). First user is admin (DB trigger).
- `jam_player` cookie for anonymous players; login links the player row to the user.
- Role guard: user / moderator / admin. `GET /api/me`.

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
