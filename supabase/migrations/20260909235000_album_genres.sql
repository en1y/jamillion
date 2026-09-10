-- Genres, per album -- which is the only level Deezer serves them at.
--
-- Until now an album's genres were flattened straight onto its artist, so the
-- one place the real data existed was thrown away: a jazz record by a pop singer
-- read "Pop". album_genres keeps it, artist_genres stays as the union over an
-- artist's albums, and a track's genres are its album's.
CREATE TABLE album_genres (
    album_id BIGINT REFERENCES albums(id) ON DELETE CASCADE,
    genre_id INT    REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (album_id, genre_id)
);
CREATE INDEX ON album_genres (genre_id);
CREATE INDEX ON artist_genres (genre_id);

ALTER TABLE album_genres ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_all ON album_genres FOR SELECT USING (true);

-- Deezer's genre id, which is the same number whatever language the name comes
-- back in: 152 is Rock, 85 is Alternative. Matching on the name alone let a
-- localised reply seed "Alternativna glazba" and "Džez" as genres of their own,
-- so the id is the upsert key from here on.
ALTER TABLE genres ADD COLUMN deezer_id BIGINT UNIQUE;

-- The existing rows have no id to match on and some are localised, so drop them;
-- the next seeder run rebuilds both link tables from the albums it re-reads.
TRUNCATE genres CASCADE;
