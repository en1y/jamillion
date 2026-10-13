-- Two depths of artist, and the other names an artist goes by.
--
-- The catalog is heading for tens of thousands of artists, and the full pipeline
-- (every album, per-track detail, YouTube Music, Last.fm per track) costs tens of
-- seconds each. So the seeder keeps that for the top slice and gives everyone
-- else a skinny pass: Deezer's artist page and its top 50 tracks, two requests.
-- `depth` says which an artist got, so a later run with a larger top slice knows
-- whom to promote and whom to leave alone.
ALTER TABLE artists ADD COLUMN depth TEXT CHECK (depth IN ('skinny', 'full'));
UPDATE artists SET depth = 'full';      -- everything seeded before this ran the full pipeline

-- Wikidata's English aliases ("Jennifer Lynn Connelly", "The Fab Four"), plus the
-- Wikidata label when Deezer spells the name differently. Read by the frontend
-- later for answer matching, so anon may read it; the seeder writes it.
CREATE TABLE artist_aliases (
    artist_id BIGINT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    alias     TEXT   NOT NULL,
    PRIMARY KEY (artist_id, alias)
);
CREATE INDEX ON artist_aliases (lower(alias));
ALTER TABLE artist_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON artist_aliases FOR SELECT USING (true);
