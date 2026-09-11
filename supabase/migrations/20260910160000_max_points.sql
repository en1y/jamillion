-- The flight ends at Pluto, 39.5 AU, and a perfect day lands there: the day's
-- ceiling is the most each question can pay, so the altitude scale is set per
-- quiz instead of the old flat 0.1714 AU a point. A rarest question tops out at
-- the highest tier; a song or album question at its best-paying accepted row
-- (the moderator's points, else the row's tier).
CREATE OR REPLACE FUNCTION public.quiz_max_points(p_quiz bigint) RETURNS int
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT coalesce(sum(best), 0)::int FROM (
        SELECT CASE WHEN q.qtype = 'rarest' THEN (SELECT max(rt.points) FROM rarity_tiers rt)
                    ELSE coalesce((SELECT max(coalesce(qa.points, rt.points))
                                   FROM question_answers qa
                                        LEFT JOIN rarity_tiers rt ON rt.id = qa.tier_id
                                   WHERE qa.question_id = q.id AND qa.is_correct), 0)
               END AS best
        FROM questions q WHERE q.quiz_id = p_quiz) s
$$;

CREATE OR REPLACE FUNCTION public.height_au(p_points int, p_quiz bigint) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT round(39.5 * p_points / greatest(quiz_max_points(p_quiz), 1), 2)
$$;

-- the height histogram, on the per-quiz scale
CREATE OR REPLACE VIEW quiz_heights WITH (security_invoker = true) AS
SELECT quiz_id, total_points, height_au(total_points, quiz_id) AS height_au, count(*) AS players
FROM attempts WHERE finished_at IS NOT NULL
GROUP BY quiz_id, total_points ORDER BY quiz_id, total_points;

-- The one thing the frontend needs from the key is this sum, per published day,
-- and it holds only the anon key, which cannot read question_answers. So this
-- function alone runs as its owner: it returns a number per date and nothing
-- else, and it stays inside published quizzes. The two above keep the caller's
-- rights and are not granted to players.
CREATE OR REPLACE FUNCTION public.quiz_ceilings()
RETURNS TABLE (quiz_date date, max_points int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT z.quiz_date, quiz_max_points(z.id) FROM quizzes z WHERE z.published ORDER BY z.quiz_date
$$;
REVOKE ALL ON FUNCTION public.quiz_max_points(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.height_au(int, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.quiz_ceilings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quiz_ceilings() TO anon, authenticated;
