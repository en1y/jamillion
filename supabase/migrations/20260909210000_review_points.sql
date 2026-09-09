-- v0.8.7: "worth nothing" is a verdict a moderator can reach about any answer,
-- so the points override is settable from the review queue as well as written by
-- the editor's expansion. review_answer takes the value instead of a flag that
-- could only clear it.
DROP FUNCTION public.review_answer(bigint, boolean, smallint, boolean);

CREATE FUNCTION public.review_answer(p_answer bigint, p_correct boolean, p_tier smallint,
                                     p_points smallint) RETURNS int
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    UPDATE question_answers
    SET is_correct = p_correct, tier_id = p_tier, points = p_points
    WHERE id = p_answer;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN rescore_answer(p_answer);
END $$;

REVOKE EXECUTE ON FUNCTION public.review_answer(bigint, boolean, smallint, smallint)
    FROM PUBLIC, anon, authenticated;
