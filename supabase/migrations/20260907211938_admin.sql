-- v0.5.0 admin.

-- Deleting an account must not be blocked by the quizzes it created. The row
-- keeps its questions and its history; only the authorship is forgotten.
ALTER TABLE quizzes DROP CONSTRAINT quizzes_created_by_fkey,
    ADD CONSTRAINT quizzes_created_by_fkey FOREIGN KEY (created_by)
        REFERENCES profiles(id) ON DELETE SET NULL;

-- Tiers become editable in v0.5.0. submit_answer() and rescore_answer() take the
-- first tier whose max_share >= the answer's share, so a share outside (0, 1]
-- would silently stop matching and score a correct answer 0.
ALTER TABLE rarity_tiers
    ADD CONSTRAINT rarity_tiers_points_check CHECK (points >= 0),
    ADD CONSTRAINT rarity_tiers_max_share_check CHECK (max_share > 0 AND max_share <= 1);
