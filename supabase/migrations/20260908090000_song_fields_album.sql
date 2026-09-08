-- v0.7.0: a song question asks for the artist, the title, or both; an album
-- question shows the cover and asks the same. ask_* is ignored on rarest questions.
ALTER TYPE question_type ADD VALUE IF NOT EXISTS 'album';

ALTER TABLE questions
    ADD COLUMN album_id   BIGINT REFERENCES albums(id),
    ADD COLUMN ask_artist BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN ask_title  BOOLEAN NOT NULL DEFAULT true;

-- qtype::text on purpose: an enum value added in this transaction cannot be
-- named as an enum literal until it commits.
ALTER TABLE questions
    ADD CONSTRAINT album_has_album CHECK (qtype::text <> 'album' OR album_id IS NOT NULL),
    ADD CONSTRAINT asks_something  CHECK (qtype::text = 'rarest' OR ask_artist OR ask_title);
