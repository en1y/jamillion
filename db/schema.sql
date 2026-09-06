-- Jamillion schema. Apply with: psql "$DATABASE_URL" -f db/schema.sql
-- Plain Postgres on purpose so it moves to Supabase later.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid

-- ---------------------------------------------------------------- users / players

CREATE TYPE user_role AS ENUM ('user', 'moderator', 'admin');

CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          user_role NOT NULL DEFAULT 'user',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The very first account is the admin. DB-level so the app can't forget.
CREATE FUNCTION first_user_is_admin() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users) THEN
        NEW.role := 'admin';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER users_first_is_admin
    BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION first_user_is_admin();

-- A player is whoever holds the jam_player cookie. Logged-out players still get
-- scored; logging in links the player row to a user.
CREATE TABLE players (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON players(user_id);

-- ---------------------------------------------------------------- music catalog

CREATE TABLE artists (
    id                 BIGSERIAL PRIMARY KEY,
    name               TEXT NOT NULL,
    sort_name          TEXT,
    mbid               UUID,                -- not unique: fuzzy MB matching can collide
    spotify_id         TEXT UNIQUE,
    ytmusic_id         TEXT,
    lastfm_url         TEXT,
    artist_type        TEXT,                -- Person / Group / Orchestra ...
    country            TEXT,                -- ISO 3166-1 alpha-2
    begin_year         INT,
    end_year           INT,
    global_rank        INT,                 -- position in the seed ranking (Last.fm top artists)
    spotify_followers  BIGINT,
    spotify_popularity SMALLINT,            -- dead: no longer served to new apps
    lastfm_listeners   BIGINT,
    lastfm_playcount   BIGINT,
    deezer_id          BIGINT UNIQUE,
    deezer_fans        BIGINT,
    disambiguation     TEXT,                -- MusicBrainz: "Nirvana (US grunge band)"
    gender             TEXT,                -- MusicBrainz, solo artists only
    image_url          TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON artists (lower(name));
CREATE INDEX ON artists (mbid);
CREATE INDEX ON artists (global_rank);

CREATE TABLE genres (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE artist_genres (
    artist_id BIGINT REFERENCES artists(id) ON DELETE CASCADE,
    genre_id  INT    REFERENCES genres(id)  ON DELETE CASCADE,
    PRIMARY KEY (artist_id, genre_id)
);

CREATE TABLE albums (
    id             BIGSERIAL PRIMARY KEY,
    artist_id      BIGINT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    mbid           UUID,
    spotify_id     TEXT UNIQUE,
    album_type     TEXT,                    -- album / single / compilation
    release_date   DATE,
    release_precision TEXT,                 -- year / month / day (Spotify)
    total_tracks   INT,
    label          TEXT,
    upc            TEXT,
    deezer_id      BIGINT UNIQUE,
    deezer_fans    BIGINT,
    duration_sec   INT,
    cover_url      TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON albums(artist_id);
CREATE INDEX ON albums(release_date);

CREATE TABLE tracks (
    id                 BIGSERIAL PRIMARY KEY,
    album_id           BIGINT REFERENCES albums(id) ON DELETE CASCADE,
    title              TEXT NOT NULL,
    norm_title         TEXT NOT NULL,       -- 'Creep - Remastered' -> 'creep'; answer matching + dedupe
    mbid               UUID,
    isrc               TEXT,
    spotify_id         TEXT UNIQUE,
    youtube_video_id   TEXT,
    disc_number        SMALLINT,
    track_number       SMALLINT,
    duration_ms        INT,
    explicit           BOOLEAN,
    release_date       DATE,
    spotify_popularity SMALLINT,            -- dead: Spotify stopped serving this to new apps (2025)
    spotify_playcount  BIGINT,              -- reserved: needs unofficial scraping
    youtube_views      BIGINT,
    youtube_likes      BIGINT,
    youtube_published_at DATE,
    deezer_id          BIGINT UNIQUE,
    deezer_rank        INT,                 -- Deezer popularity, 0..1000000
    gain               NUMERIC(6,2),
    bpm                NUMERIC(6,2),
    lastfm_listeners   BIGINT,
    lastfm_playcount   BIGINT,
    preview_url        TEXT,                -- official 30 s clip; Deezer URLs expire ~daily, re-resolve from deezer_id
    preview_source     TEXT,                -- deezer / itunes
    audio_path         TEXT,                -- set once the clip is cached locally (relative to AUDIO_DIR)
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON tracks(album_id);
CREATE INDEX ON tracks (lower(title));
CREATE INDEX ON tracks (norm_title);
CREATE INDEX ON tracks(deezer_rank DESC);
CREATE INDEX ON tracks(youtube_views DESC);

-- Main artist + features. Lets "guess the band" accept any credited artist.
CREATE TABLE track_artists (
    track_id  BIGINT REFERENCES tracks(id)  ON DELETE CASCADE,
    artist_id BIGINT REFERENCES artists(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'main', -- main / feature
    PRIMARY KEY (track_id, artist_id)
);
CREATE INDEX ON track_artists(artist_id);

-- ---------------------------------------------------------------- quiz

-- Life of a star, newborn to supernova. Admin-editable.
-- max_share: for 'rarest' questions, an answer given by <= this fraction of players
-- lands in this tier (lowest matching tier wins). Overrides ignore it.
CREATE TABLE rarity_tiers (
    id         SMALLSERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    points     SMALLINT NOT NULL,
    sort_order SMALLINT NOT NULL UNIQUE,
    max_share  NUMERIC(5,4) NOT NULL       -- 1.0 = everyone
);
INSERT INTO rarity_tiers (name, points, sort_order, max_share) VALUES
    ('Nebula',        10, 1, 1.0000),
    ('Protostar',     15, 2, 0.3000),
    ('Main Sequence', 30, 3, 0.1500),
    ('Red Giant',     60, 4, 0.0500),
    ('Supergiant',    85, 5, 0.0100),
    ('Supernova',    100, 6, 0.0010);

CREATE TYPE question_type AS ENUM ('rarest', 'song');

CREATE TABLE quizzes (
    id         BIGSERIAL PRIMARY KEY,
    quiz_date  DATE NOT NULL UNIQUE,
    published  BOOLEAN NOT NULL DEFAULT false,
    created_by BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE questions (
    id                BIGSERIAL PRIMARY KEY,
    quiz_id           BIGINT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    position          SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 7),
    qtype             question_type NOT NULL,
    prompt            TEXT NOT NULL,
    time_limit_sec    SMALLINT NOT NULL DEFAULT 20,
    -- song questions only
    track_id          BIGINT REFERENCES tracks(id),
    snippet_start_sec NUMERIC(5,2) CHECK (snippet_start_sec BETWEEN 0 AND 30),  -- offset inside the 30 s preview
    snippet_len_sec   NUMERIC(5,2) DEFAULT 10 CHECK (snippet_len_sec BETWEEN 1 AND 30),
    UNIQUE (quiz_id, position),
    CHECK (qtype <> 'song' OR (track_id IS NOT NULL AND snippet_start_sec IS NOT NULL))
);

-- Accepted answers. For 'rarest' questions moderators pre-seed a few and the
-- rest get added as players submit (is_correct = null until reviewed).
-- For 'song' questions moderators list e.g. "artist", "title", "artist - title"
-- each with its own tier.
CREATE TABLE question_answers (
    id          BIGSERIAL PRIMARY KEY,
    question_id BIGINT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    normalized  TEXT NOT NULL,              -- lowercase, no punctuation/diacritics
    display     TEXT NOT NULL,
    is_correct  BOOLEAN,                    -- null = awaiting moderator review
    tier_id     SMALLINT REFERENCES rarity_tiers(id),  -- override; null = computed from share
    guess_count INT NOT NULL DEFAULT 0,
    UNIQUE (question_id, normalized)
);

CREATE TABLE attempts (
    id           BIGSERIAL PRIMARY KEY,
    player_id    UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    quiz_id      BIGINT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    total_points SMALLINT NOT NULL DEFAULT 0,
    UNIQUE (player_id, quiz_id)             -- one dive per day
);

CREATE TABLE attempt_answers (
    id          BIGSERIAL PRIMARY KEY,
    attempt_id  BIGINT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id BIGINT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    raw_text    TEXT NOT NULL,
    answer_id   BIGINT REFERENCES question_answers(id),
    tier_id     SMALLINT REFERENCES rarity_tiers(id),
    points      SMALLINT NOT NULL DEFAULT 0,
    answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (attempt_id, question_id)
);
CREATE INDEX ON attempt_answers(question_id);

-- ---------------------------------------------------------------- stats views (admin)

CREATE VIEW question_top_answers AS
SELECT qa.question_id, qa.display, qa.is_correct, qa.guess_count,
       coalesce(t.name, 'computed') AS tier
FROM question_answers qa LEFT JOIN rarity_tiers t ON t.id = qa.tier_id
ORDER BY qa.question_id, qa.guess_count DESC;

-- height histogram per quiz: points * 0.1714 AU
CREATE VIEW quiz_heights AS
SELECT quiz_id, total_points, round(total_points * 0.1714, 2) AS height_au, count(*) AS players
FROM attempts WHERE finished_at IS NOT NULL
GROUP BY quiz_id, total_points ORDER BY quiz_id, total_points;
