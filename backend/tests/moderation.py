"""Moderation checks for v0.4.0. Creates and removes only test-owned rows.

Load .env, run the backend and the local Supabase stack, then:
  .venv/bin/python backend/tests/moderation.py

It owns today's quiz, so it refuses to run when one already exists. Run it after
quiz_play.py, which owns the same day and deletes its quiz on the way out.
"""
import os
import urllib.error
import urllib.request
import uuid

import psycopg

from common import ANON, BASE, cleanup, me, request, signup

TOKEN = None          # moderator access token
QUIZ_DATE = None


def api(path, data=None, cookie=None, token=None, method=None):
    headers = {}
    if cookie:
        headers['Cookie'] = 'jam_player=' + cookie
    if token:
        headers['Authorization'] = 'Bearer ' + token
    return request(BASE + path, data, headers, method)


def build_quiz(track_id):
    """Six rarest questions plus one song question, positions 1..7. Unpublished."""
    questions = [{
        'position': 1, 'qtype': 'rarest', 'prompt': 'Name a Radiohead album',
        'answers': [{'display': 'OK Computer'}, {'display': 'Kid A'}],
    }]
    for position in range(2, 7):
        questions.append({
            'position': position, 'qtype': 'rarest', 'prompt': f'Question {position}',
            'answers': [{'display': f'Answer {position}'}],
        })
    questions.append({
        'position': 7, 'qtype': 'song', 'prompt': 'Artist and title?', 'track_id': track_id,
        'snippet_start_sec': 12, 'snippet_len_sec': 10,
        'answers': [{'display': 'Radiohead Creep', 'tier_id': 6}],
    })
    return {'quiz_date': QUIZ_DATE, 'published': False, 'questions': questions}


def audio_status(path, token=None):
    """Audio is binary, so it does not go through the JSON helper."""
    req = urllib.request.Request(BASE + path)
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    try:
        return urllib.request.urlopen(req, timeout=30).status
    except urllib.error.HTTPError as failure:
        return failure.status


def guess(text, question_id):
    """A fresh guest plays one question and answers it. Returns (player id, attempt id)."""
    body, cookie = me()
    _, attempt, _ = api('/api/attempts', {}, cookie=cookie)
    status, result, _ = api(f"/api/attempts/{attempt['id']}/answers",
                            {'question_id': question_id, 'text': text}, cookie=cookie)
    assert status == 200, (status, result)
    return body['player_id'], attempt['id']


def answers_of(preview, position):
    return {a['display']: a for a in preview['questions'][position - 1]['answers']}


with psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as db:
    quiz_id = None
    try:
        QUIZ_DATE = db.execute('SELECT game_today()::text').fetchone()[0]
        if db.execute('SELECT 1 FROM quizzes WHERE quiz_date = %s', (QUIZ_DATE,)).fetchone():
            raise SystemExit(f'A quiz already exists for {QUIZ_DATE}; this test owns today. Remove it first.')

        uid, TOKEN = signup('mod-test-' + uuid.uuid4().hex[:8])
        db.execute("UPDATE profiles SET role = 'moderator' WHERE id = %s", (uid,))
        track = db.execute('SELECT id FROM tracks WHERE preview_url IS NOT NULL '
                           'ORDER BY deezer_rank DESC NULLS LAST LIMIT 1').fetchone()
        assert track, 'The catalog has no track with a preview; seed one first'
        status, created, _ = api('/api/quizzes', build_quiz(track[0]), token=TOKEN)
        assert status == 201, (status, created)
        quiz_id = created['id']

        # -------------------------------------------------- preview
        status, preview, _ = api(f'/api/quizzes/{QUIZ_DATE}', token=TOKEN)
        assert status == 200, (status, preview)
        assert preview['id'] == quiz_id and preview['published'] is False
        assert preview['attempts_started'] == 0 and preview['attempts_finished'] == 0
        assert [q['position'] for q in preview['questions']] == [1, 2, 3, 4, 5, 6, 7]
        song = preview['questions'][6]
        assert song['track']['id'] == track[0] and song['track']['title']
        assert song['audio'] == f"/api/audio/{song['id']}"
        assert preview['questions'][0]['track'] is None and preview['questions'][0]['audio'] is None
        first = answers_of(preview, 1)
        assert set(first) == {'OK Computer', 'Kid A'}
        assert first['OK Computer']['is_correct'] is True and first['OK Computer']['guess_count'] == 0
        assert first['OK Computer']['normalized'] == 'ok computer'

        db.execute("UPDATE profiles SET role = 'user' WHERE id = %s", (uid,))
        assert api(f'/api/quizzes/{QUIZ_DATE}', token=TOKEN)[0] == 403
        db.execute("UPDATE profiles SET role = 'moderator' WHERE id = %s", (uid,))
        assert api(f'/api/quizzes/{QUIZ_DATE}')[0] == 401
        assert api('/api/quizzes/nope', token=TOKEN)[0] == 400
        assert api('/api/quizzes/1999-01-01', token=TOKEN)[0] == 404

        # -------------------------------------------------- audio before publishing
        assert audio_status(f"/api/audio/{song['id']}", token=TOKEN) == 200
        assert audio_status(f"/api/audio/{song['id']}") == 404

        # -------------------------------------------------- publish / unpublish
        assert api('/api/quiz/today')[0] == 404
        status, published, _ = api(f'/api/quizzes/{QUIZ_DATE}', {'published': True}, token=TOKEN, method='PATCH')
        assert status == 200 and published['published'] is True, (status, published)
        assert api('/api/quiz/today')[0] == 200
        assert api(f'/api/quizzes/{QUIZ_DATE}', {'published': 'yes'}, token=TOKEN, method='PATCH')[0] == 400
        assert api('/api/quizzes/1999-01-01', {'published': True}, token=TOKEN, method='PATCH')[0] == 404

        questions = dict(db.execute('SELECT position, id FROM questions WHERE quiz_id = %s',
                                    (quiz_id,)).fetchall())

        # -------------------------------------------------- guesses to review
        # Three guests give an answer the moderator never approved, one gives a known one.
        bends_players = [guess('The Bends', questions[1]) for _ in range(3)]
        okc_player, okc_attempt = guess('OK Computer', questions[1])
        assert db.execute('SELECT total_points FROM attempts WHERE id = %s',
                          (okc_attempt,)).fetchone()[0] == 15       # 1 guess in 4 -> Protostar

        preview = api(f'/api/quizzes/{QUIZ_DATE}', token=TOKEN)[1]
        first = answers_of(preview, 1)
        bends, okc = first['The Bends'], first['OK Computer']
        assert bends['is_correct'] is None and bends['guess_count'] == 3
        assert preview['attempts_started'] == 4

        def totals(players):
            return [db.execute('SELECT total_points FROM attempts WHERE id = %s', (a,)).fetchone()[0]
                    for _, a in players]

        # -------------------------------------------------- verdict and re-scoring
        status, body, _ = api(f"/api/answers/{bends['id']}", {'is_correct': True}, token=TOKEN, method='PATCH')
        assert status == 200 and body['rescored'] == 3, (status, body)
        assert body['is_correct'] is True and body['guess_count'] == 3
        assert totals(bends_players) == [10, 10, 10]      # share 3/4 -> Nebula
        assert totals([(None, okc_attempt)]) == [15], 'only the reviewed answer re-scores'

        status, body, _ = api(f"/api/answers/{bends['id']}", {'tier_id': 4}, token=TOKEN, method='PATCH')
        assert status == 200 and body['rescored'] == 3 and body['tier_id'] == 4
        assert totals(bends_players) == [60, 60, 60]      # Red Giant override

        status, body, _ = api(f"/api/answers/{bends['id']}", {'is_correct': False}, token=TOKEN, method='PATCH')
        assert status == 200 and body['rescored'] == 3
        assert body['is_correct'] is False and body['tier_id'] == 4, 'an absent key keeps its value'
        assert totals(bends_players) == [0, 0, 0]

        status, body, _ = api(f"/api/answers/{bends['id']}", {'is_correct': None, 'tier_id': None},
                              token=TOKEN, method='PATCH')
        assert status == 200 and body['rescored'] == 0, (status, body)
        assert body['is_correct'] is None and body['tier_id'] is None
        assert totals(bends_players) == [0, 0, 0]

        assert api(f"/api/answers/{bends['id']}", {}, token=TOKEN, method='PATCH')[0] == 400
        assert api(f"/api/answers/{bends['id']}", {'tier_id': 99}, token=TOKEN, method='PATCH')[0] == 400
        assert api(f"/api/answers/{bends['id']}", {'tier_id': 'red'}, token=TOKEN, method='PATCH')[0] == 400
        assert api('/api/answers/999999999', {'is_correct': True}, token=TOKEN, method='PATCH')[0] == 404
        assert api(f"/api/answers/{bends['id']}", {'is_correct': True}, method='PATCH')[0] == 401

        # -------------------------------------------------- merge duplicates
        album_player, album_attempt = guess('OK Computer album', questions[1])
        assert totals([(None, album_attempt)]) == [0]
        preview = api(f'/api/quizzes/{QUIZ_DATE}', token=TOKEN)[1]
        album = answers_of(preview, 1)['OK Computer album']

        # Both players who now hold this answer re-score: 2 guesses in 5 -> Nebula.
        status, body, _ = api(f"/api/answers/{album['id']}/merge", {'into': okc['id']}, token=TOKEN)
        assert status == 200 and body['rescored'] == 2, (status, body)
        assert body['id'] == okc['id'] and body['display'] == 'OK Computer' and body['guess_count'] == 2
        assert totals([(None, album_attempt), (None, okc_attempt)]) == [10, 10]
        assert not db.execute('SELECT 1 FROM question_answers WHERE id = %s', (album['id'],)).fetchone()

        second = answers_of(api(f'/api/quizzes/{QUIZ_DATE}', token=TOKEN)[1], 2)['Answer 2']
        assert api(f"/api/answers/{okc['id']}/merge", {'into': second['id']}, token=TOKEN)[0] == 400
        assert api(f"/api/answers/{okc['id']}/merge", {'into': okc['id']}, token=TOKEN)[0] == 400
        assert api(f"/api/answers/{okc['id']}/merge", {'into': 999999999}, token=TOKEN)[0] == 400
        assert api(f"/api/answers/{okc['id']}/merge", {}, token=TOKEN)[0] == 400

        # -------------------------------------------------- player detail
        status, player, _ = api(f'/api/players/{album_player}', token=TOKEN)
        assert status == 200 and player['id'] == album_player and player['user_id'] is None
        assert player['username'] is None and len(player['attempts']) == 1
        flight = player['attempts'][0]
        assert flight['id'] == album_attempt and flight['quiz_date'] == QUIZ_DATE
        assert flight['total_points'] == 10 and flight['height_au'] == 1.71
        assert flight['finished_at'] is None and len(flight['answers']) == 1
        answered = flight['answers'][0]
        assert answered['position'] == 1 and answered['raw_text'] == 'OK Computer album'
        assert answered['matched'] == 'OK Computer' and answered['is_correct'] is True
        assert answered['tier'] == 'Nebula' and answered['points'] == 10

        # Two browsers of one account report the same flights.
        _, cookie_a = me(TOKEN)
        _, cookie_b = me(TOKEN)
        player_a = api('/api/me', cookie=cookie_a, token=TOKEN)[1]['player_id']
        player_b = api('/api/me', cookie=cookie_b, token=TOKEN)[1]['player_id']
        assert player_a != player_b
        _, mine, _ = api('/api/attempts', {}, cookie=cookie_a, token=TOKEN)
        for pid in (player_a, player_b):
            status, detail, _ = api(f'/api/players/{pid}', token=TOKEN)
            assert status == 200 and detail['username'], (status, detail)
            assert [a['id'] for a in detail['attempts']] == [mine['id']], detail['attempts']

        assert api('/api/players/not-a-uuid', token=TOKEN)[0] == 404
        assert api(f'/api/players/{uuid.uuid4()}', token=TOKEN)[0] == 404
        assert api(f'/api/players/{album_player}')[0] == 401

        # -------------------------------------------------- the new scorers stay shut
        rest = os.environ['SUPABASE_URL'].rstrip('/')
        for key, value in [('apikey', ANON), ('Authorization', 'Bearer ' + TOKEN)]:
            for rpc, payload in [('review_answer', {'p_answer': bends['id'], 'p_correct': True, 'p_tier': 6}),
                                 ('merge_answer', {'p_from': bends['id'], 'p_into': okc['id']}),
                                 ('rescore_answer', {'p_answer': bends['id']})]:
                status, _, _ = request(f'{rest}/rest/v1/rpc/{rpc}', payload,
                                       {'apikey': ANON, key: value})
                assert status != 200, f'{rpc} must not be callable through PostgREST'

        print('PASS: quiz preview with answer list, publish/unpublish, moderator audio for an unpublished'
              ' quiz, verdict and tier overrides re-scoring only their own players, duplicate merge,'
              ' player detail across an account, moderation RPC locked out of PostgREST')
    finally:
        if quiz_id:
            db.execute('DELETE FROM quizzes WHERE id = %s', (quiz_id,))
        cleanup(db)
