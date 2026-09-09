# Jamillion

A daily rare-answer trivia game, in the spirit of [Krillion](https://krillion.io), but instead of diving into the ocean you launch from the Sun and fly toward the edge of the solar system. Seven questions a day, on a clock or in your own time. The rarer your correct answer, the further you fly.

**Current: v0.8.7 — the catalog query.** Moderators get a flight deck: pick a day, drag a snippet window over a decoded waveform, write the accepted answers with their tiers, publish. Answers come out of the catalog rather than out of memory — stack filters and sorts over songs, albums and artists (*this artist's tracks over a million listens, biggest first*; *the songs on this album, in running order*) and turn the results into accepted answers in one press. Once people have flown a day it freezes — points are fixed at answer time — and the screen turns into the review queue for the guesses that came in.

## The game

- **7 prompts per day**, the same for everyone, published at 04:00 UTC.
- **The clock is per question.** A rarest question runs 20 seconds by default; a song or an album question runs untimed, because listening to a snippet and pulling a name out of memory is not a reflex test. A moderator can set any question to no clock or to 5–60 seconds.
- **Three question types**
  - **Rarest** — open answer. Any correct answer counts, but rarity among all players decides the tier.
  - **Song** — a short audio snippet plays (moderator picks the start time). Guess the artist, the title, the album it came from, or any combination the moderator asks for — one field per input, each completing against the catalog. The answer key is written from the track rather than typed: the moderator sets what each field is worth and a player scores every field they got right, added up. Getting all of them can carry an optional bonus on top; without one, a perfect answer is simply the whole sum.
  - **Album** — the cover is shown. Same fields and scoring as a song question, minus the album field, which is what its title already is.
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
- **Height** — 1 point = 0.1714 AU. A perfect 700-point run reaches ~120 AU, the heliopause. Landmarks on the way: Mercury, Venus, Earth, Mars, the asteroid belt, Jupiter, Saturn, Uranus, Neptune, Pluto and the Kuiper belt, Eris, Sedna, the termination shock, Voyager 2's crossing and the heliopause Voyager 1 crossed in 2012.

## Roles

| Role      | Can                                                                                                   |
|-----------|-------------------------------------------------------------------------------------------------------|
| user      | Play without an account. Sign in to keep a history. The first account ever created becomes the admin. |
| moderator | Create the daily quiz, pick songs and snippet times, set answer tiers, see per-player detail.          |
| admin     | Everything above, plus manage users/roles, raw DB view, per-question stats (most guessed answers, most reached height). |

## Stack

- **Backend** — C++20, [Drogon](https://github.com/drogonframework/drogon) (pulled in by CMake FetchContent, nothing to install globally).
- **Database and auth** — [Supabase](https://supabase.com) from the start, running locally in Docker. Postgres holds everything, Supabase Auth handles accounts, and the schema lives in `supabase/migrations/` so it deploys to a hosted Supabase project unchanged. Row level security is on for every table.
- **Frontend** — React + Vite + TypeScript.
- **Music data** — Python seed script (`scripts/seed_music.py`). Deezer is the catalog backbone: artists, albums and tracks with labels, release dates, UPC/ISRC, BPM, fan counts and official 30 s preview clips, all without an API key. Last.fm supplies the candidate set of artists and real listen counts; the seeder re-sorts that set by listener count, so `global_rank` 1 is the biggest artist rather than the most-trending one. MusicBrainz adds country, artist type, gender and active years. YouTube Music adds the song play count the app shows (plays over every upload of a recording, rounded), the video it plays and the artist's monthly listeners; the YouTube Data API adds exact views and likes for those videos. Spotify contributes ids only, because in 2025 it stopped serving popularity, followers, genres, top tracks and audio features to new apps.
- Only original studio recordings are stored. Live versions, remixes, demos and acoustic cuts are skipped, and remaster or deluxe duplicates collapse into one row per song.
- Audio is never in the database. A track's preview clip is downloaded to `data/audio/` the first time it is used in a quiz.

## Layout

```
backend/    Drogon server
frontend/   Vite React app
supabase/   migrations, seed, local database/auth configuration
scripts/    seed_music.py and friends
docs/       RUNNING.md — how to run everything
docs/ROADMAP.md  what gets built in which order
```

See [docs/RUNNING.md](RUNNING.md) to get going and [ROADMAP.md](ROADMAP.md) for the plan.
