-- Why an artist is missing from the catalog.
--
-- The seeder's progress file only ever held the last twenty names of the run that
-- is on screen, so a failure from three runs ago was invisible and a rerun had
-- nothing to aim at. This table outlives the run: seed_music.py writes a row when
-- an artist cannot be seeded and deletes it the moment that artist lands.
CREATE TABLE catalog_failures (
    name     TEXT PRIMARY KEY,           -- as it was asked for, not as Deezer spells it
    reason   TEXT NOT NULL,
    attempts INT NOT NULL DEFAULT 1,
    last_try TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Staff read this through the backend, which holds the service role. No policy,
-- so the anon key sees nothing, like question_answers.
ALTER TABLE catalog_failures ENABLE ROW LEVEL SECURITY;
