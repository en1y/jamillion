# Roadmap

Backend first, frontend second. Each phase ends with something runnable.

## Phase 0 — Foundation (done)

- [x] Repo, README, docs, `.env.example`
- [x] Postgres schema (`db/schema.sql`) with first-user-is-admin trigger and star tiers seeded
- [x] Music seed script (`scripts/seed_music.py`)
- [x] Drogon skeleton with `/api/health`
- [x] Vite React skeleton

## Phase 1 — Backend: data + auth

- [ ] Seed the music DB (top 500 artists, all albums/tracks, Spotify popularity, YouTube views)
- [ ] `POST /api/auth/register`, `/login` — JWT, first user becomes admin (trigger)
- [ ] Anonymous players: `jam_player` cookie (uuid) so logged-out users still get scored and can later link to an account
- [ ] Role middleware (user / moderator / admin)

## Phase 2 — Backend: quizzes + play

- [ ] Moderator: create quiz for a date, add 7 questions (rarest / song), pick track + snippet start/len, seed accepted answers with tiers
- [ ] `GET /api/quiz/today` — questions without answers; song questions stream the cached snippet
- [ ] `POST /api/attempt` + `/api/attempt/:id/answer` — 20 s server-side timer, answer normalisation, tier lookup
- [ ] Rarest-type tiering: tier from answer frequency across all attempts (thresholds in `rarity_tiers`), moderator override wins
- [ ] Audio fetch job: `yt-dlp` the track on first use, cache under `data/audio/`
- [ ] Daily rollover at 04:00 UTC, one attempt per player per day

## Phase 3 — Backend: moderation + admin

- [ ] Moderator: per-question answer list, merge duplicates, change tiers, player detail
- [ ] Admin: user list, role changes, per-question stats (most guessed answers, height histogram), raw table view
- [ ] Track search endpoint for the quiz editor (by artist / title / year / popularity)

## Phase 4 — Frontend

- [ ] Launch screen, 7-question flow with timer
- [ ] Solar-system flight: altitude grows with points, landmarks scroll past (Mercury … Neptune … Kuiper belt … heliopause)
- [ ] Results: tiers per answer, share text
- [ ] Login / history
- [ ] Moderator quiz editor with waveform + snippet picker
- [ ] Admin dashboard

## Later / maybe

- Supabase migration (schema is plain Postgres, so mostly connection string + auth swap)
- Answer alias table / fuzzy matching
- Unlimited / archive mode
