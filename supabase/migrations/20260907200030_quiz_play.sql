-- v0.3.0 quiz play: game day, answer normalisation, the 20 s timer column and
-- the scoring function. Scoring lives here rather than in C++ so that upserting
-- the guess, computing its share, writing the answer and updating the running
-- total are one statement-level atomic unit.

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- The quiz day rolls over at 04:00 UTC, so "today" is not the calendar date.
CREATE FUNCTION public.game_today() RETURNS date
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT ((now() AT TIME ZONE 'UTC') - interval '4 hours')::date;
$$;

-- What both the moderator's answer key and a player's guess are compared as.
-- Unlike the seeder's norm_title this keeps " - suffix" and "(...)": a player
-- typing 'Creep - Radiohead' must not collapse to 'creep'.
-- search_path includes extensions so unaccent() finds its own dictionary.
CREATE FUNCTION public.normalize_answer(txt text) RETURNS text
LANGUAGE sql STABLE SET search_path = public, extensions AS $$
    SELECT btrim(regexp_replace(lower(unaccent(coalesce(txt, ''))), '[^a-z0-9]+', ' ', 'g'));
$$;

-- When the current unanswered question was first served. NULL = nothing pending.
ALTER TABLE attempts ADD COLUMN question_started_at TIMESTAMPTZ;

-- The snippet window has to fit inside the 30 s preview clip.
ALTER TABLE questions ADD CONSTRAINT snippet_in_clip
    CHECK (coalesce(snippet_start_sec, 0) + coalesce(snippet_len_sec, 0) <= 30);

-- One player answer: count the guess, tier it, store it, move the attempt on.
-- p_raw = '' means a timeout or a deliberate skip: 0 points, nothing counted.
--
-- ponytail: the share is read live at answer time and the points are frozen.
-- v0.4 reviews answers and may re-score; recomputing on every read is not worth it.
CREATE FUNCTION public.submit_answer(p_attempt bigint, p_question bigint, p_raw text)
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
        -- ON CONFLICT keeps the moderator's display, is_correct and tier_id.
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
            v_points := coalesce(v_points, 0);
        END IF;
    END IF;

    -- UNIQUE (attempt_id, question_id): a double submit raises unique_violation,
    -- which the backend turns into 409.
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

-- PostgREST publishes every public function as /rest/v1/rpc/<name>, so the anon
-- key could otherwise call the scorer directly. The backend connects as the
-- owner and is unaffected.
REVOKE EXECUTE ON FUNCTION public.submit_answer(bigint, bigint, text) FROM PUBLIC, anon, authenticated;
