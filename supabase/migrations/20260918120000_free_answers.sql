-- v1.0.5: not every song or album question asks for the artist and the title.
-- "How is this artist's name spelled?" over a cover is answered "all caps", and
-- with both boxes on, the catalog refuses every answer the question actually
-- wants. Asking for no field is now a question with one free box, scored against
-- the typed key exactly as a rarest question is.
ALTER TABLE questions DROP CONSTRAINT asks_something;

-- The nearest answer the key holds to what was typed, as it is displayed, or
-- NULL when nothing is close. Looser than match_answer, which corrects a slip
-- silently: this one is for asking "did you mean X?" before the guess lands as
-- nothing. One slip per three characters, and never under three.
-- ponytail: levenshtein over one question's key -- a handful of rows. No index.
CREATE FUNCTION public.near_answer(p_question bigint, p_raw text) RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
    WITH said AS (SELECT normalize_answer(p_raw) AS norm)
    SELECT qa.display FROM question_answers qa, said
    WHERE qa.question_id = p_question AND qa.is_correct AND length(said.norm) >= 3
      AND levenshtein(said.norm, qa.normalized) <= greatest(1, length(said.norm) / 3)
    ORDER BY levenshtein(said.norm, qa.normalized), length(qa.normalized), qa.id
    LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.near_answer(bigint, text) FROM PUBLIC, anon, authenticated;
