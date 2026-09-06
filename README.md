# Jamillion

A daily rare-answer trivia game, in the spirit of [Krillion](https://krillion.io), but instead of diving into the ocean you launch from the Sun and fly toward the edge of the solar system. Seven questions a day, ~20 seconds each. The rarer your correct answer, the further you fly.

## The game

- **7 prompts per day**, the same for everyone, published at 04:00 UTC.
- **Two question types**
  - **Rarest** — open answer. Any correct answer counts, but rarity among all players decides the tier.
  - **Song** — a short audio snippet plays (moderator picks the start time). Guess the artist and the title. Moderators assign a tier to each accepted answer (artist only, title only, both, …).
- **Rarity tiers** follow the life of a star, newborn to supernova:

  | Tier          | Points | Krillion equivalent |
  |---------------|-------:|---------------------|
  | Nebula        |     10 | Plankton            |
  | Protostar     |     15 | Too Clever          |
  | Main Sequence |     30 | Schooler            |
  | Red Giant     |     60 | Rare                |
  | Supergiant    |     85 | Deep Cut            |
  | Supernova     |    100 | One in a Krillion   |

  Moderators and admins can override the tier of any accepted answer.
- **Height** — 1 point = 0.1714 AU. A perfect 700-point run reaches ~120 AU, the heliopause. Landmarks on the way: Mercury, Venus, Earth, Mars, the asteroid belt, Jupiter, Saturn, Uranus, Neptune, the Kuiper belt, Voyager 1.

## Roles

| Role      | Can                                                                                                   |
|-----------|-------------------------------------------------------------------------------------------------------|
| user      | Play without an account. Log in to keep a history. The first account ever created becomes the admin.  |
| moderator | Create the daily quiz, pick songs and snippet times, set answer tiers, see per-player detail.          |
| admin     | Everything above, plus manage users/roles, raw DB view, per-question stats (most guessed answers, most reached height). |

## Stack

- **Backend** — C++20, [Drogon](https://github.com/drogonframework/drogon) (pulled in by CMake FetchContent, nothing to install globally), PostgreSQL. JWT auth.
- **Frontend** — React + Vite + TypeScript.
- **Music data** — Python seed script pulling from Last.fm (artist ranking), Spotify (catalog, popularity, ISRC), MusicBrainz (ids, dates, countries), Deezer / iTunes (official 30 s preview clips by ISRC), YouTube Music + YouTube Data API (video ids, view counts). Only original studio songs are stored: live versions, remixes, demos and remaster duplicates are skipped. Audio is never in the DB; a track's preview clip is downloaded to `data/audio/` when it is first used in a quiz.

## Layout

```
backend/    Drogon server
frontend/   Vite React app
db/         schema.sql (source of truth for the schema)
scripts/    seed_music.py and friends
docs/       RUNNING.md — how to run everything
ROADMAP.md  what gets built in which order
```

See [docs/RUNNING.md](docs/RUNNING.md) to get going and [ROADMAP.md](ROADMAP.md) for the plan.
