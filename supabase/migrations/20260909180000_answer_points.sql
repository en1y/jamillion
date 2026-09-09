-- v0.8.6: a song question is scored field by field. The answer key holds one row
-- per combination of the fields it asks for, and a combination is worth its
-- fields added up, plus whatever the moderator set for getting all of them --
-- a number no single rarity tier can name, the tiers being a fixed ladder.
--
-- points overrides the tier's own value where it is set. tier_id stays, and is
-- still the star the player is shown; only the number changes.
ALTER TABLE question_answers
    ADD COLUMN points SMALLINT CHECK (points IS NULL OR points BETWEEN 0 AND 700);

-- Unchanged but for the one coalesce: the override wins over the tier's points.
CREATE OR REPLACE FUNCTION public.submit_answer(p_attempt bigint, p_question bigint, p_raw text)
RETURNS TABLE (points smallint, tier text, correct boolean, total_points smallint, finished boolean)
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    ans        public.question_answers%ROWTYPE;
    v_norm     TEXT;
    share      NUMERIC;
    v_points   SMALLINT := 0;
    v_tier_id  SMALLINT;
    v_tier     TEXT;
    v_total    SMALLINT;
    v_finished BOOLEAN;
BEGIN
    v_norm := normalize_answer(p_raw);
    IF v_norm <> '' THEN
        INSERT INTO question_answers (question_id, normalized, display, guess_count)
        VALUES (p_question, v_norm, left(btrim(p_raw), 100), 1)
        ON CONFLICT (question_id, normalized)
        DO UPDATE SET guess_count = question_answers.guess_count + 1
        RETURNING * INTO ans;

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

    RETURN QUERY SELECT v_points, v_tier, ans.is_correct, v_total, v_finished;
END $$;

CREATE OR REPLACE FUNCTION public.rescore_answer(p_answer bigint) RETURNS int
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    ans       question_answers%ROWTYPE;
    v_tier_id SMALLINT;
    v_points  SMALLINT := 0;
    changed   INT;
BEGIN
    SELECT * INTO ans FROM question_answers WHERE id = p_answer;
    IF ans.is_correct THEN
        IF ans.tier_id IS NOT NULL THEN
            SELECT rt.id, rt.points INTO v_tier_id, v_points FROM rarity_tiers rt WHERE rt.id = ans.tier_id;
        ELSE
            SELECT rt.id, rt.points INTO v_tier_id, v_points FROM rarity_tiers rt
            WHERE rt.max_share >= ans.guess_count::numeric /
                  greatest((SELECT count(*) FROM attempt_answers aa WHERE aa.question_id = ans.question_id), 1)
            ORDER BY rt.max_share LIMIT 1;
        END IF;
        v_points := coalesce(ans.points, v_points, 0);
    END IF;

    WITH before AS (
        SELECT aa.id, aa.attempt_id, aa.points AS old_points FROM attempt_answers aa
        WHERE aa.answer_id = p_answer AND (aa.points <> v_points OR aa.tier_id IS DISTINCT FROM v_tier_id)
    ), moved AS (
        UPDATE attempt_answers aa SET tier_id = v_tier_id, points = v_points
        FROM before b WHERE aa.id = b.id RETURNING b.attempt_id, v_points - b.old_points AS delta
    ), totals AS (
        UPDATE attempts a SET total_points = a.total_points + s.delta
        FROM (SELECT attempt_id, sum(delta) AS delta FROM moved GROUP BY attempt_id) s
        WHERE a.id = s.attempt_id
    )
    SELECT count(*) INTO changed FROM moved;
    RETURN changed;
END $$;

-- A moderator setting a tier by hand is taking the answer over, so the generated
-- sum gets out of the way -- otherwise the override would silently win and the
-- review queue's tier select would look broken. Ticking a verdict alone leaves it.
DROP FUNCTION public.review_answer(bigint, boolean, smallint);
CREATE FUNCTION public.review_answer(p_answer bigint, p_correct boolean, p_tier smallint,
                                     p_clear_points boolean DEFAULT false) RETURNS int
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    UPDATE question_answers
    SET is_correct = p_correct, tier_id = p_tier,
        points = CASE WHEN p_clear_points THEN NULL ELSE points END
    WHERE id = p_answer;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN rescore_answer(p_answer);
END $$;

REVOKE EXECUTE ON FUNCTION public.review_answer(bigint, boolean, smallint, boolean)
    FROM PUBLIC, anon, authenticated;
