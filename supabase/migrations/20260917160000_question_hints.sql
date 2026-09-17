-- The catalog's completions under a song or album question's boxes are help the
-- moderator can withhold: a question whose whole point is remembering the name
-- gives it away in three characters. On by default -- typing a name out of a
-- catalog of millions with no list is the harder game, not the usual one.
-- Rarest questions have no completions to switch off; the column is inert there.
ALTER TABLE questions ADD COLUMN hints BOOLEAN NOT NULL DEFAULT true;
