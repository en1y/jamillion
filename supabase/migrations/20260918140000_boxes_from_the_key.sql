-- v1.0.6: the boxes a question puts in front of a player come from its answer key,
-- not from the three flags alone. A moderator who writes "how is this artist's name
-- spelled?" over a cover leaves the flags at their defaults and answers "all caps":
-- the artist and album title boxes would then refuse every answer the question is
-- asking for. So a flag only becomes a box when the key holds an answer for it.
-- Which boxes a question actually puts in front of a player. The flags say which
-- ones the moderator ticked; the key says which ones they wrote an answer for, and
-- the key wins. A question about the record rather than its credits -- "how is this
-- artist's name spelled?" over a cover -- keeps the flags at their defaults and has
-- a key holding neither name, so its two boxes would refuse every answer the
-- question is actually asking for. A box is asked for only when the key holds
-- something it could contribute to: a row tagged with that field, or any row whose
-- text contains the catalog's name for it -- a name of its own, or as part of a
-- combination. Nothing at all means one free box, the same as a rarest question.
-- ponytail: a containment test over one question's key, a handful of rows. It is
-- generous on purpose: a box is dropped only when nothing in the key mentions it.
CREATE OR REPLACE FUNCTION public.question_boxes(p_question bigint) RETURNS text[]
LANGUAGE sql STABLE SET search_path = public AS $$
    WITH q AS (
        SELECT qq.id, qq.qtype::text AS qtype, qq.ask_artist, qq.ask_title, qq.ask_album,
               ar.name AS artist_name,
               coalesce(t.title, al.title) AS title_name,
               talb.title AS album_name
        FROM questions qq
        LEFT JOIN tracks t   ON t.id = qq.track_id
        LEFT JOIN albums talb ON talb.id = t.album_id
        LEFT JOIN albums al  ON al.id = qq.album_id
        LEFT JOIN artists ar ON ar.id = coalesce(talb.artist_id, al.artist_id)
        WHERE qq.id = p_question
    ), asked AS (
        SELECT b.field, b.ord,
               CASE b.field WHEN 'artist' THEN q.artist_name
                            WHEN 'title'  THEN q.title_name
                            ELSE q.album_name END AS name
        FROM q, (VALUES ('artist', 1), ('title', 2), ('album', 3)) AS b(field, ord)
        WHERE q.qtype <> 'rarest'
          AND CASE b.field WHEN 'artist' THEN q.ask_artist
                           WHEN 'title'  THEN q.ask_title
                           ELSE q.qtype = 'song' AND q.ask_album END
    )
    SELECT coalesce(array_agg(a.field ORDER BY a.ord), '{}')
    FROM asked a
    WHERE EXISTS (
        SELECT 1 FROM question_answers qa
        WHERE qa.question_id = p_question AND qa.is_correct
          AND (qa.field = a.field
               OR (normalize_answer(coalesce(a.name, '')) <> ''
                   -- whole words, padded: "Madvillain" must not be found inside
                   -- "Madvillainy". normalize_answer() leaves single spaces between
                   -- words, so a pad on both ends is the whole of the boundary check.
                   AND position(' ' || normalize_answer(a.name) || ' '
                                IN ' ' || qa.normalized || ' ') > 0)))
$$;

REVOKE ALL ON FUNCTION public.question_boxes(bigint) FROM PUBLIC, anon, authenticated;
