-- Today's demo flight: seven music questions against the seeded catalog, so the
-- game can be tried without a moderator. Replaces the current game day's quiz,
-- attempts and all, so it is for a local database only.
--
--   psql "$DATABASE_URL" -f scripts/demo_quiz.sql
--
-- The song is the most popular track with a preview (a cached clip first), the
-- album the most followed one with a cover. Both ask for artist and title; the
-- artist alone or the title alone still scores, at a fixed lower tier.
BEGIN;
DELETE FROM quizzes WHERE quiz_date = game_today();

WITH song AS (
    SELECT t.id, t.title, ar.name AS artist
    FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = al.artist_id
    WHERE t.preview_url IS NOT NULL
    ORDER BY t.audio_path IS NULL, t.deezer_rank DESC NULLS LAST, t.id LIMIT 1),
disc AS (
    SELECT al.id, al.title, ar.name AS artist
    FROM albums al JOIN artists ar ON ar.id = al.artist_id
    WHERE al.album_type = 'album' AND al.cover_url IS NOT NULL AND al.title NOT ILIKE '%deluxe%'
    ORDER BY al.deezer_fans DESC NULLS LAST, al.id LIMIT 1),
qz AS (INSERT INTO quizzes (quiz_date, published) VALUES (game_today(), true) RETURNING id),
qs AS (
    INSERT INTO questions (quiz_id, position, qtype, prompt, track_id, snippet_start_sec, snippet_len_sec, album_id)
    SELECT qz.id, v.position, v.qtype::question_type, v.prompt, v.track_id, v.start_sec, v.len_sec, v.album_id
    FROM qz, (VALUES
        (1, 'rarest', 'Name a Coldplay album',                      NULL::bigint, NULL::numeric, NULL::numeric, NULL::bigint),
        (2, 'rarest', 'Name a member of The Beatles',               NULL, NULL, NULL, NULL),
        (3, 'rarest', 'Name a Queen song',                          NULL, NULL, NULL, NULL),
        (4, 'rarest', 'Name a Nirvana album',                       NULL, NULL, NULL, NULL),
        (5, 'rarest', 'Name a Michael Jackson album',               NULL, NULL, NULL, NULL),
        (6, 'song',   'Who sings this, and what is it called?',     (SELECT id FROM song), 10, 12, NULL),
        (7, 'album',  'Whose album is this, and what is it called?', NULL, NULL, NULL, (SELECT id FROM disc))
    ) AS v(position, qtype, prompt, track_id, start_sec, len_sec, album_id)
    RETURNING id, position),
ans AS (
    SELECT * FROM (VALUES
        (1, 'Parachutes', NULL::smallint), (1, 'A Rush of Blood to the Head', NULL), (1, 'X&Y', NULL),
        (1, 'Viva la Vida or Death and All His Friends', NULL), (1, 'Viva la Vida', NULL), (1, 'Mylo Xyloto', NULL),
        (1, 'Ghost Stories', NULL), (1, 'A Head Full of Dreams', NULL), (1, 'Everyday Life', NULL),
        (1, 'Music of the Spheres', NULL), (1, 'Moon Music', NULL),
        (2, 'John Lennon', NULL), (2, 'Paul McCartney', NULL), (2, 'George Harrison', NULL), (2, 'Ringo Starr', NULL),
        (2, 'Lennon', NULL), (2, 'McCartney', NULL), (2, 'Harrison', NULL), (2, 'Ringo', NULL),
        (3, 'Bohemian Rhapsody', NULL), (3, 'We Will Rock You', NULL), (3, 'We Are the Champions', NULL),
        (3, 'Another One Bites the Dust', NULL), (3, 'Don''t Stop Me Now', NULL), (3, 'Somebody to Love', NULL),
        (3, 'Under Pressure', NULL), (3, 'Radio Ga Ga', NULL), (3, 'Killer Queen', NULL), (3, 'I Want to Break Free', NULL),
        (3, 'The Show Must Go On', NULL), (3, 'Crazy Little Thing Called Love', NULL), (3, 'Who Wants to Live Forever', NULL),
        (3, 'Fat Bottomed Girls', NULL), (3, 'Bicycle Race', NULL), (3, 'Love of My Life', NULL), (3, 'A Kind of Magic', NULL),
        (4, 'Bleach', NULL), (4, 'Nevermind', NULL), (4, 'In Utero', NULL), (4, 'MTV Unplugged in New York', NULL),
        (5, 'Off the Wall', NULL), (5, 'Thriller', NULL), (5, 'Bad', NULL), (5, 'Dangerous', NULL),
        (5, 'HIStory', NULL), (5, 'Invincible', NULL), (5, 'Got to Be There', NULL), (5, 'Ben', NULL)
    ) AS v(position, display, tier)
    UNION ALL SELECT 6, artist || ' — ' || title, NULL FROM song
    UNION ALL SELECT 6, artist, 2 FROM song            -- Protostar for the artist alone
    UNION ALL SELECT 6, title, 3 FROM song             -- Main Sequence for the title alone
    UNION ALL SELECT 7, artist || ' — ' || title, NULL FROM disc
    UNION ALL SELECT 7, artist, 2 FROM disc
    UNION ALL SELECT 7, title, 3 FROM disc)
INSERT INTO question_answers (question_id, normalized, display, is_correct, tier_id)
SELECT qs.id, normalize_answer(a.display), a.display, true, a.tier
FROM qs JOIN ans a ON a.position = qs.position
ON CONFLICT DO NOTHING;
COMMIT;

SELECT q.position, q.qtype, q.prompt, count(qa.id) AS answers
FROM questions q JOIN quizzes z ON z.id = q.quiz_id LEFT JOIN question_answers qa ON qa.question_id = q.id
WHERE z.quiz_date = game_today() GROUP BY q.id ORDER BY q.position;
