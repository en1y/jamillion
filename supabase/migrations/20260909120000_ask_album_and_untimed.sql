-- v0.8.5: a song question can also ask which album it came from, and any question
-- can run without a clock.

-- ask_album is song-only. On an album question the album title is what ask_title
-- already means, and two flags for one field is a trap rather than a feature.
ALTER TABLE questions ADD COLUMN ask_album BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE questions
    DROP CONSTRAINT asks_something,
    ADD CONSTRAINT asks_something
        CHECK (qtype::text = 'rarest' OR ask_artist OR ask_title OR ask_album),
    ADD CONSTRAINT album_asks_no_album
        CHECK (qtype::text <> 'album' OR NOT ask_album);

-- 0 = no clock. A song question is a snippet, then a name pulled out of memory;
-- 20 seconds turns that into a reflex test. The range had only ever been checked
-- in the handler, so it lands in the schema in the same breath.
ALTER TABLE questions ADD CONSTRAINT time_limit_range
    CHECK (time_limit_sec = 0 OR time_limit_sec BETWEEN 5 AND 60);
