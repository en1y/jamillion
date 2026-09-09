# scripts/

Python data-gathering only; nothing here serves requests. Install once with
`python -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt`.
Both scripts read `.env` (`DATABASE_URL`, `LASTFM_API_KEY`, `AUDIO_DIR`, ...).

## seed_music.py (run it through seed.sh)

Builds the artist / album / track catalog in Postgres.

- Last.fm `chart.getTopArtists` gives the candidate set, re-sorted by listener
  count to become `global_rank`; `artist.getInfo` gives listens.
- Deezer is the source of truth: artist, every album and track, 30 s preview URL.
  `deezer_id` is the upsert key, so re-running refreshes rather than duplicates.
- MusicBrainz adds mbid, type, country, gender, active years. Spotify adds only
  the id. YouTube Music (`ytmusicapi`, unofficial, paced) adds the song play
  count the app shows, the video id it plays, and the artist's monthly
  listeners: the artist's albums and singles pages are read once and matched to
  tracks by `norm_title`, most-played copy wins. The YouTube Data API then adds
  exact views and likes for those videos if `YOUTUBE_API_KEY` is set.
- Only originals are kept: `is_original` drops live / remix / demo / acoustic
  titles, `norm_title` collapses remaster and deluxe duplicates into one row.
- One commit per artist, a failure rolls back that artist and the run continues.

`seed.sh` loads `.env`, starts the seeder in the background inside `.venv`,
and returns at once. Output goes to `data/seed.log` (previous run kept as
`seed.log.prev`). If the seeder dies within its first seconds the script prints
the log and exits 1; it also refuses to start while another seeder is running.

```bash
scripts/seed.sh --artists Radiohead        # one artist, ~20 s smoke test
scripts/seed.sh --limit 500                # full chart, hours; --start N resumes
tail -f data/seed.log                      # watch progress
pkill -f seed_music.py                     # stop it
```

Flags: `--start`, `--artists`, `--detail-cap`, `--lastfm-cap`, `--yt-albums`,
`--yt-refresh`, `--no-youtube`, `--no-spotify`. Caps apply to the
most popular tracks first. `--selftest` runs the pure-logic checks and exits.
`--artists` runs leave `global_rank` untouched; only a chart run knows the ranking.

## fetch_audio.py

Caches one track's official 30 s preview into `AUDIO_DIR` and records the file
name in `tracks.audio_path`. The backend calls it the first time a track is used.

```bash
.venv/bin/python scripts/fetch_audio.py <track_id>     # prints 123.mp3
```

Deezer preview URLs expire after about a day, so the stored URL is only a hint:
if it fails the script re-resolves from `deezer_id`, then falls back to iTunes by
ISRC (`.m4a`, marked `preview_source='itunes'`), and stores whichever fresh URL
worked. Already-cached tracks return immediately. Exit code 1 with a message when
the track is missing or no preview exists anywhere.
