-- v0.4.0 moderation: review an answer, merge a duplicate into it. Both re-score
-- only the attempt rows that pointed at the reviewed answer; everyone else keeps
-- the points they were shown (docs/ROADMAP.md, v0.3 decisions).

-- Recompute points for every attempt answer that resolved to p_answer and move
-- each attempt's total by the difference. Returns how many rows changed.
-- Old points are read in a CTE first: UPDATE ... RETURNING shows the new value.
CREATE FUNCTION public.rescore_answer(p_answer bigint) RETURNS int
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
        v_points := coalesce(v_points, 0);
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

-- Moderator verdict on one answer. NULL p_correct = back to "awaiting review".
CREATE FUNCTION public.review_answer(p_answer bigint, p_correct boolean, p_tier smallint) RETURNS int
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    UPDATE question_answers SET is_correct = p_correct, tier_id = p_tier WHERE id = p_answer;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN rescore_answer(p_answer);
END $$;

-- Fold a duplicate ("kid a", "Kid A!") into the canonical answer. The target keeps
-- its display, verdict and tier; the source's guesses and player rows move over.
CREATE FUNCTION public.merge_answer(p_from bigint, p_into bigint) RETURNS int
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF p_from = p_into OR (SELECT question_id FROM question_answers WHERE id = p_from)
                          IS DISTINCT FROM (SELECT question_id FROM question_answers WHERE id = p_into) THEN
        RETURN NULL;   -- the route turns NULL into 400
    END IF;
    UPDATE attempt_answers SET answer_id = p_into WHERE answer_id = p_from;
    UPDATE question_answers t SET guess_count = t.guess_count + f.guess_count
    FROM question_answers f WHERE t.id = p_into AND f.id = p_from;
    DELETE FROM question_answers WHERE id = p_from;
    RETURN rescore_answer(p_into);
END $$;

-- Backend only, like submit_answer: PostgREST would otherwise publish these as RPC.
REVOKE EXECUTE ON FUNCTION public.rescore_answer(bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.review_answer(bigint, boolean, smallint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.merge_answer(bigint, bigint) FROM PUBLIC, anon, authenticated;
