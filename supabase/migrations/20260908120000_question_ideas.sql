-- v0.7.1: player-submitted prompt ideas from the post-flight screen.
-- The backend writes these as the service role; players have no direct policy.

CREATE TABLE question_ideas (
    id         BIGSERIAL PRIMARY KEY,
    player_id  UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 3 AND 160),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX question_ideas_player_day ON question_ideas (player_id, created_at);

ALTER TABLE question_ideas ENABLE ROW LEVEL SECURITY;
