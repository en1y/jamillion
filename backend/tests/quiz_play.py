"""Quiz play checks for v0.3.0. Creates and removes only test-owned rows.

Load .env, run the backend and the local Supabase stack, then:
  .venv/bin/python backend/tests/quiz_play.py

It owns today's quiz, so it refuses to run when one already exists.
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
    """Six rarest questions plus one song question, positions 1..7."""
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
        'answers': [{'display': 'Radiohead Creep', 'tier_id': 6}, {'display': 'Radiohead', 'tier_id': 2}],
    })
    return {'quiz_date': QUIZ_DATE, 'published': True, 'questions': questions}


def fetch_audio(path):
    """Audio is binary, so it does not go through the JSON helper."""
    try:
        response = urllib.request.urlopen(BASE + path, timeout=30)
    except urllib.error.HTTPError as failure:
        return failure.status, b'', failure.headers
    return response.status, response.read(), response.headers


def answer(cookie, attempt_id, question_id, text):
    status, body, _ = api(f'/api/attempts/{attempt_id}/answers',
                          {'question_id': question_id, 'text': text}, cookie=cookie)
    return status, body


with psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as db:
    quiz_id = None
    seeded = []
    try:
        QUIZ_DATE = db.execute('SELECT game_today()::text').fetchone()[0]
        if db.execute('SELECT 1 FROM quizzes WHERE quiz_date = %s', (QUIZ_DATE,)).fetchone():
            raise SystemExit(f'A quiz already exists for {QUIZ_DATE}; this test owns today. Remove it first.')

        # -------------------------------------------------- normalisation
        norm = db.execute("SELECT normalize_answer('Bjork - Joga!'), normalize_answer('  OK-Computer! '),"
                          " normalize_answer('Creep - Radiohead')").fetchone()
        assert norm == ('bjork joga', 'ok computer', 'creep radiohead'), norm
        accented = db.execute("SELECT normalize_answer(%s)", ('Björk – Jóga!',)).fetchone()[0]
        assert accented == 'bjork joga', accented

        # -------------------------------------------------- moderator guard
        uid, TOKEN = signup('quiz-test-' + uuid.uuid4().hex[:8])
        db.execute("UPDATE profiles SET role = 'user' WHERE id = %s", (uid,))
        track = db.execute('SELECT id FROM tracks WHERE preview_url IS NOT NULL '
                           'ORDER BY deezer_rank DESC NULLS LAST LIMIT 1').fetchone()
        assert track, 'The catalog has no track with a preview; seed one first'
        track_id = track[0]
        assert api('/api/quizzes', build_quiz(track_id), token=TOKEN)[0] == 403
        assert api('/api/quizzes', build_quiz(track_id))[0] == 401
        db.execute("UPDATE profiles SET role = 'moderator' WHERE id = %s", (uid,))

        # -------------------------------------------------- validation
        short = build_quiz(track_id)
        short['questions'] = short['questions'][:6]
        assert api('/api/quizzes', short, token=TOKEN)[0] == 400
        for mutate in (lambda q: q['questions'][0].update(qtype='trivia'),
                       lambda q: q['questions'][0].update(answers=[]),
                       lambda q: q['questions'][0].update(prompt=''),
                       lambda q: q['questions'][0].update(time_limit_sec=600),
                       lambda q: q['questions'][1].update(position=1)):
            broken = build_quiz(track_id)
            mutate(broken)
            assert api('/api/quizzes', broken, token=TOKEN)[0] == 400, mutate
        bad_snippet = build_quiz(track_id)
        bad_snippet['questions'][6].update(snippet_start_sec=25, snippet_len_sec=10)
        assert api('/api/quizzes', bad_snippet, token=TOKEN)[0] == 400   # CHECK snippet_in_clip

        # -------------------------------------------------- create the quiz
        status, created, _ = api('/api/quizzes', build_quiz(track_id), token=TOKEN)
        assert status == 201, (status, created)
        quiz_id = created['id']
        audio_path = db.execute('SELECT audio_path FROM tracks WHERE id = %s', (track_id,)).fetchone()[0]
        assert audio_path, 'the quiz save should have cached the preview clip'
        audio_dir = os.environ.get('AUDIO_DIR', './data/audio')
        assert os.path.exists(os.path.join(audio_dir, audio_path)), audio_path
        questions = dict(db.execute('SELECT position, id FROM questions WHERE quiz_id = %s', (quiz_id,)).fetchall())
        assert len(questions) == 7

        # -------------------------------------------------- today, without answers
        status, today, _ = api('/api/quiz/today')
        assert status == 200 and today['id'] == quiz_id and today['question_count'] == 7
        assert today['attempt'] is None and len(today['tiers']) == 6
        blob = str(today)
        for leak in ('OK Computer', 'answers', 'track_id', 'normalized'):
            assert leak not in blob, leak

        # -------------------------------------------------- attempts
        assert api('/api/attempts', {}, method='POST')[0] == 401
        _, cookie = me()
        status, attempt, _ = api('/api/attempts', {}, cookie=cookie)
        assert status == 201, (status, attempt)
        attempt_id, first = attempt['id'], attempt['question']
        assert first['position'] == 1 and attempt['answered'] == 0 and attempt['total_points'] == 0
        assert first['time_limit_sec'] == 20 and first['deadline'] > first['started_at']
        assert 'track_id' not in str(attempt)
        status, again, _ = api('/api/attempts', {}, cookie=cookie)      # a refresh grants no extra time
        assert status == 200 and again['id'] == attempt_id
        assert again['question']['started_at'] == first['started_at']

        # -------------------------------------------------- rarity
        # Eight other players give the common answer, straight through the scorer.
        for _ in range(8):
            pid = db.execute('INSERT INTO players DEFAULT VALUES RETURNING id').fetchone()[0]
            seeded.append(pid)
            aid = db.execute('INSERT INTO attempts (player_id, quiz_id) VALUES (%s, %s) RETURNING id',
                             (pid, quiz_id)).fetchone()[0]
            db.execute('SELECT submit_answer(%s, %s, %s)', (aid, questions[1], 'OK Computer'))
        assert api(f'/api/attempts/{attempt_id}/answers',
                   {'question_id': questions[2], 'text': 'x'}, cookie=cookie)[0] == 409  # not current

        # 1 in 9 lands two tiers above the crowd's answer.
        status, body = answer(cookie, attempt_id, questions[1], '  KID-a! ')
        assert status == 200, (status, body)
        assert body['result'] == {'timed_out': False, 'correct': True, 'tier': 'Main Sequence', 'points': 30}, body['result']
        assert body['total_points'] == 30 and body['answered'] == 1
        assert body['question']['position'] == 2
        assert answer(cookie, attempt_id, questions[1], 'Kid A')[0] == 409     # already answered

        # -------------------------------------------------- unknown, skip, timeout
        status, body = answer(cookie, attempt_id, questions[2], 'Something nobody wrote')
        assert body['result']['points'] == 0 and body['result']['correct'] is False, body
        row = db.execute('SELECT is_correct, guess_count FROM question_answers WHERE question_id = %s'
                         ' AND normalized = %s', (questions[2], 'something nobody wrote')).fetchone()
        assert row == (None, 1), row

        status, body = answer(cookie, attempt_id, questions[3], '')            # deliberate skip
        assert body['result']['points'] == 0 and body['result']['timed_out'] is False

        db.execute("UPDATE attempts SET question_started_at = now() - interval '60 seconds' WHERE id = %s",
                   (attempt_id,))
        status, body = answer(cookie, attempt_id, questions[4], 'Answer 4')    # correct, but too late
        assert body['result'] == {'timed_out': True, 'correct': False, 'tier': None, 'points': 0}, body['result']
        assert db.execute('SELECT guess_count FROM question_answers WHERE question_id = %s AND normalized = %s',
                          (questions[4], 'answer 4')).fetchone()[0] == 0, 'a timeout must not count as a guess'
        assert body['total_points'] == 30

        # -------------------------------------------------- finish, with the song
        status, body = answer(cookie, attempt_id, questions[5], 'Answer 5')
        assert body['result']['points'] == 10 and body['total_points'] == 40
        status, body = answer(cookie, attempt_id, questions[6], 'Answer 6')
        assert body['result']['points'] == 10 and body['total_points'] == 50
        song_id = questions[7]
        assert body['question']['id'] == song_id and body['question']['qtype'] == 'song'
        assert body['question']['audio'] == f'/api/audio/{song_id}'
        assert body['question']['snippet_start_sec'] == 12 and body['question']['snippet_len_sec'] == 10
        status, body = answer(cookie, attempt_id, song_id, 'radiohead creep')  # moderator override wins
        assert body['result'] == {'timed_out': False, 'correct': True, 'tier': 'Supernova', 'points': 100}, body['result']
        assert body['finished'] is True and body['total_points'] == 150 and body['question'] is None
        assert db.execute('SELECT finished_at IS NOT NULL, total_points FROM attempts WHERE id = %s',
                          (attempt_id,)).fetchone() == (True, 150)
        assert answer(cookie, attempt_id, song_id, 'again')[0] == 409

        status, today, _ = api('/api/quiz/today', cookie=cookie)
        assert today['attempt'] == {'id': attempt_id, 'total_points': 150, 'answered': 7, 'finished': True}, today['attempt']
        assert today['players_finished'] >= 1

        # -------------------------------------------------- audio
        status, clip, headers = fetch_audio(f'/api/audio/{song_id}')
        assert status == 200 and headers['Content-Type'].startswith('audio/'), headers.get('Content-Type')
        assert len(clip) > 10_000, len(clip)
        assert fetch_audio(f'/api/audio/{questions[1]}')[0] == 404   # a rarest question has no clip
        assert fetch_audio('/api/audio/999999999')[0] == 404

        # -------------------------------------------------- the crowd's answer stays common
        _, cookie2 = me()
        _, second, _ = api('/api/attempts', {}, cookie=cookie2)
        status, body = answer(cookie2, second['id'], questions[1], 'OK Computer')
        assert body['result']['tier'] == 'Nebula' and body['result']['points'] == 10, body['result']

        # -------------------------------------------------- one flight per account
        _, cookie_a = me(TOKEN)                                  # two browsers, one account
        _, cookie_b = me(TOKEN)
        status_a, attempt_a, _ = api('/api/attempts', {}, cookie=cookie_a, token=TOKEN)
        status_b, attempt_b, _ = api('/api/attempts', {}, cookie=cookie_b, token=TOKEN)
        assert attempt_a['id'] == attempt_b['id'], (attempt_a['id'], attempt_b['id'])
        assert (status_a, status_b) == (201, 200)

        # -------------------------------------------------- the answer key stays shut
        # Moderators are allowed to read it, so check as a player: anon, and signed in.
        db.execute("UPDATE profiles SET role = 'user' WHERE id = %s", (uid,))
        rest = os.environ['SUPABASE_URL'].rstrip('/')
        for key, value in [('apikey', ANON), ('Authorization', 'Bearer ' + TOKEN)]:
            status, rows, _ = request(rest + '/rest/v1/question_answers?select=*',
                                      headers={'apikey': ANON, key: value})
            assert status == 200 and rows == [], (status, rows)
            status, rows, _ = request(rest + '/rest/v1/question_top_answers?select=*',
                                      headers={'apikey': ANON, key: value})
            assert status == 200 and rows == [], (status, rows)
            # Prompts and track ids too: the backend hands them out one question at a time.
            status, rows, _ = request(rest + '/rest/v1/questions?select=prompt,track_id',
                                      headers={'apikey': ANON, key: value})
            assert status == 200 and rows == [], (status, rows)
        status, _, _ = request(rest + '/rest/v1/rpc/submit_answer',
                               {'p_attempt': attempt_id, 'p_question': questions[1], 'p_raw': 'hack'},
                               {'apikey': ANON})
        assert status != 200, 'anon must not be able to call the scorer'

        print('PASS: quiz create/validation, one-at-a-time delivery, rarity tiers, overrides,'
              ' timeout/skip, finish, audio by question, per-account dedupe, answer-key and questions RLS')
    finally:
        if quiz_id:
            db.execute('DELETE FROM quizzes WHERE id = %s', (quiz_id,))
        if seeded:
            db.execute('DELETE FROM players WHERE id = ANY(%s::uuid[])', (seeded,))
        cleanup(db)
