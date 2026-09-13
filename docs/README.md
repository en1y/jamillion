# Jamillion

A daily rare-answer trivia game, in the spirit of [Krillion](https://krillion.io), but instead of diving into the ocean you launch from the Sun and fly toward the edge of the solar system. Seven questions a day, on a clock or in your own time. The rarer your correct answer, the further you fly.

**Current: v0.11.0 — pull and run.** One `compose.yaml` and `docker compose up -d` bring the whole thing up from Docker Hub behind HTTPS, Supabase included, with no checkout and no `.env`: secrets generated on first boot, migrations applied on every boot, and a setup page on the first visit that creates the admin, takes the catalog keys — kept in a volume only the backend can read — and starts seeding as many artists as you ask for. Before that, v0.10.0 — hardening — rate limits per IP and per player, a body cap, bounded search terms and filter stacks, and a nightly `pg_dump` with a restore that has actually been run. Before that, v0.9.0 — ground control — an admin gets a fifth chip in the dock and the last screen the backend had been waiting for: everyone aboard, searchable across username and email, sortable by any of six columns, with a role select and a delete on each row and the last admin protected from both; how a day went, as its score distribution and every question's guesses with their shares, on its own tab and again on the editor's day once people have flown it; the six rarity tiers editable in place, name, points and the share that still reaches them; and a read-only window on sixteen tables. The rest is the flight deck of v0.8.7: pick a day, drag a snippet window over a decoded waveform, write the accepted answers out of the catalog rather than out of memory, publish. Once people have flown a day it freezes — points are fixed at answer time — and the screen turns into the review queue for the guesses that came in.

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
- **The cabin** — a gear beside the passport, and a mute next to it. The effects are synthesised in the browser (no audio files): a blip when a question arrives, a rising send, an arpeggio that climbs as far as the tier you hit, a buzz for the clock, a fanfare on landing. The same panel levels the snippets, and picks what the flight is drawn with: rendered planets, flat discs or a bare flight chart, and tier badges or glyphs. Shared results stay glyphs — a clipboard has no images.
- **Height** — a share of the day: the most every question can pay is Pluto, 39.5 AU, so a perfect run always lands there whatever the questions are worth. Landmarks on the way: Mercury, Venus, Earth, Mars, the asteroid belt, Jupiter, Saturn, Uranus, Neptune, Pluto and the Kuiper belt, Eris, Sedna, the termination shock, Voyager 2's crossing and the heliopause Voyager 1 crossed in 2012.

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
- Audio is never in the database. A track's preview clip is downloaded to `data/audio/` the first time it is used in a quiz, and re-downloaded if the file ever goes missing, so the directory is a cache rather than state a backup has to carry.

## Layout

```
backend/    Drogon server
frontend/   Vite React app
supabase/   migrations, seed, local database/auth configuration
scripts/    seed_music.py, fetch_audio.py, backup.sh
docker/     first-boot secrets, the db image, role passwords and the migration runner
compose.yaml        the whole stack from Docker Hub, Supabase included
compose.build.yaml  the same, built from this checkout
Caddyfile   one HTTPS origin for the site, /api, /auth/v1 and /rest/v1
docs/       RUNNING.md — how to run everything
docs/ROADMAP.md  what gets built in which order
```

See [docs/RUNNING.md](RUNNING.md) to get going and [ROADMAP.md](ROADMAP.md) for the plan.
