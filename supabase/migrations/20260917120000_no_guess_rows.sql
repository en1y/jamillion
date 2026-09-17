-- A guess the moderator did not put in the answer key is simply wrong: it no
-- longer lands in question_answers as an "awaiting review" row, so there is no
-- review queue of players' spellings. The key is only what the editor wrote, and
-- a guess only bumps the guess_count of a row that is already there.
UPDATE attempt_answers SET answer_id = NULL
WHERE answer_id IN (SELECT id FROM question_answers WHERE is_correct IS NULL);
DELETE FROM question_answers WHERE is_correct IS NULL;
ALTER TABLE question_answers ALTER COLUMN is_correct SET NOT NULL;

CREATE OR REPLACE FUNCTION public.submit_answer(p_attempt bigint, p_question bigint, p_raw text,
                                     p_parts text[] DEFAULT NULL)
RETURNS TABLE (points smallint, tier text, correct boolean, total_points smallint,
               finished boolean, parts_hit boolean[])
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    ans        public.question_answers%ROWTYPE;
    v_norm     TEXT;
    v_n        INT := coalesce(array_length(p_parts, 1), 0);
    v_mask     INT := 0;
    v_best     BIGINT;
    share      NUMERIC;
    v_points   SMALLINT := 0;
    v_tier_id  SMALLINT;
    v_tier     TEXT;
    v_total    SMALLINT;
    v_finished BOOLEAN;
BEGIN
    v_norm := normalize_answer(p_raw);
    IF v_norm <> '' THEN
        UPDATE question_answers SET guess_count = guess_count + 1
        WHERE question_id = p_question AND normalized = v_norm
        RETURNING * INTO ans;

        IF ans.is_correct THEN
            v_mask := (1 << v_n) - 1;            -- the whole answer: every box landed
        ELSIF v_n > 1 THEN
            -- Nothing matched whole, so the boxes that did still count: the key holds
            -- a row per combination, and the best-paying one the player's boxes can
            -- build is what they earned. Three fields is seven combinations.
            -- ponytail: the combination's guess_count is left alone -- these rows are
            -- scored by the moderator's tier and points, not by how many found them.
            SELECT c.mask, qa.id INTO v_mask, v_best
            FROM generate_series(1, (1 << least(v_n, 4)) - 1) AS mask
            CROSS JOIN LATERAL (
                SELECT mask, array_to_string(ARRAY(
                    SELECT p_parts[i] FROM generate_series(1, v_n) AS i
                    WHERE (mask >> (i - 1)) & 1 = 1), ' ') AS combo
            ) c
            JOIN question_answers qa
              ON qa.question_id = p_question AND qa.is_correct
             AND qa.normalized = normalize_answer(c.combo)
            ORDER BY coalesce(qa.points,
                              (SELECT rt.points FROM rarity_tiers rt WHERE rt.id = qa.tier_id), 0) DESC,
                     qa.id
            LIMIT 1;
            IF v_best IS NOT NULL THEN
                SELECT * INTO ans FROM question_answers WHERE id = v_best;
            ELSE
                v_mask := 0;
            END IF;
        END IF;

        IF ans.is_correct THEN
            IF ans.tier_id IS NOT NULL THEN          -- moderator override wins
                SELECT rt.id, rt.name, rt.points INTO v_tier_id, v_tier, v_points
                FROM rarity_tiers rt WHERE rt.id = ans.tier_id;
            ELSE
                share := ans.guess_count::numeric /
                         ((SELECT count(*) FROM attempt_answers aa WHERE aa.question_id = p_question) + 1);
                SELECT rt.id, rt.name, rt.points INTO v_tier_id, v_tier, v_points
                FROM rarity_tiers rt WHERE rt.max_share >= share ORDER BY rt.max_share LIMIT 1;
            END IF;
            v_points := coalesce(ans.points, v_points, 0);
        END IF;
    END IF;

    INSERT INTO attempt_answers (attempt_id, question_id, raw_text, answer_id, tier_id, points)
    VALUES (p_attempt, p_question, p_raw, ans.id, v_tier_id, v_points);

    UPDATE attempts a SET
        total_points = a.total_points + v_points,
        question_started_at = NULL,
        finished_at = CASE
            WHEN (SELECT count(*) FROM attempt_answers aa WHERE aa.attempt_id = p_attempt)
               = (SELECT count(*) FROM questions q WHERE q.quiz_id = a.quiz_id)
            THEN now() ELSE a.finished_at END
    WHERE a.id = p_attempt
    RETURNING a.total_points, a.finished_at IS NOT NULL INTO v_total, v_finished;

    RETURN QUERY SELECT v_points, v_tier, coalesce(ans.is_correct, false), v_total, v_finished,
                        ARRAY(SELECT (v_mask >> (i - 1)) & 1 = 1 FROM generate_series(1, v_n) AS i);
END $$;
