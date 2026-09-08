"""Quiz play checks for v0.3.0. Creates and removes only test-owned rows.

Load .env, run the backend and the local Supabase stack, then:
  .venv/bin/python backend/tests/quiz_play.py

It owns today's quiz, so it refuses to run when one already exists.
"""
import os
import urllib.error
import urllib.parse
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


MUSIC = {2: 'Name a Coldplay album', 3: 'Name a Queen song', 4: 'Name a member of The Beatles',
         5: 'Name a Nirvana album', 6: 'Name a Michael Jackson album', 7: 'Name a Radiohead song'}


def build_quiz(track_id, album_id=None):
    """Five rarest questions, an album question (title only) and a song question."""
    questions = [{
        'position': 1, 'qtype': 'rarest', 'prompt': 'Name a Radiohead album',
        'answers': [{'display': 'OK Computer'}, {'display': 'Kid A'}],
    }]
    for position in range(2, 7):
        questions.append({
            'position': position, 'qtype': 'rarest', 'prompt': MUSIC[position],
            'answers': [{'display': f'Answer {position}'}],
        })
    if album_id:   # the album behind the track: its title is the only field asked for
        questions[5].update(qtype='album', prompt='Whose album is this?', album_id=album_id, ask_artist=False)
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


def serve(cookie, token=None):
    """POST /api/attempts hands over the current question and starts its timer."""
    status, body, _ = api('/api/attempts', {}, cookie=cookie, token=token)
    return status, body


def answer(cookie, attempt_id, question_id, text):
    """Serve the current question, then answer it. Since v0.6.0 the answer response
    carries the result and the totals but never the next question: that one is served
    by the next POST /api/attempts, so reading a result costs no time on the next."""
    serve(cookie)
    status, body, _ = api(f'/api/attempts/{attempt_id}/answers',
                          {'question_id': question_id, 'text': text}, cookie=cookie)
    assert status != 200 or body['question'] is None, body
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
        album_id, artist_name = db.execute(
            'SELECT t.album_id, ar.name FROM tracks t JOIN albums al ON al.id = t.album_id '
            'JOIN artists ar ON ar.id = al.artist_id WHERE t.id = %s', (track_id,)).fetchone()
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
                       lambda q: q['questions'][1].update(position=1),
                       lambda q: q['questions'][6].update(ask_artist=False, ask_title=False),
                       lambda q: q['questions'][5].update(qtype='album')):        # no album_id
            broken = build_quiz(track_id)
            mutate(broken)
            assert api('/api/quizzes', broken, token=TOKEN)[0] == 400, mutate
        bad_snippet = build_quiz(track_id)
        bad_snippet['questions'][6].update(snippet_start_sec=25, snippet_len_sec=10)
        assert api('/api/quizzes', bad_snippet, token=TOKEN)[0] == 400   # CHECK snippet_in_clip

        # -------------------------------------------------- create the quiz
        status, created, _ = api('/api/quizzes', build_quiz(track_id, album_id), token=TOKEN)
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
        assert today['flight_no'] >= 1
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
        # Answering does not serve the next question, so no timer is running while
        # the player reads the result; POST /api/attempts starts question 2's.
        assert db.execute('SELECT question_started_at FROM attempts WHERE id = %s',
                          (attempt_id,)).fetchone()[0] is None
        status, served = serve(cookie)
        assert status == 200 and served['question']['position'] == 2
        assert served['question']['started_at'] and served['question']['deadline'] > served['question']['started_at']
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
        status, served = serve(cookie)                                    # the album question
        assert served['question']['qtype'] == 'album' and served['question']['cover'], served['question']
        assert served['question']['ask_artist'] is False and served['question']['ask_title'] is True
        assert 'album_id' not in served['question'] and 'track_id' not in served['question']
        status, body = answer(cookie, attempt_id, questions[6], 'Answer 6')
        assert body['result']['points'] == 10 and body['total_points'] == 50
        song_id = questions[7]
        status, served = serve(cookie)
        assert served['question']['id'] == song_id and served['question']['qtype'] == 'song'
        assert served['question']['audio'] == f'/api/audio/{song_id}'
        assert served['question']['snippet_start_sec'] == 12 and served['question']['snippet_len_sec'] == 10
        assert served['question']['ask_artist'] is True and served['question']['ask_title'] is True
        status, body = answer(cookie, attempt_id, song_id, 'radiohead creep')  # moderator override wins
        assert body['result'] == {'timed_out': False, 'correct': True, 'tier': 'Supernova', 'points': 100}, body['result']
        assert body['finished'] is True and body['total_points'] == 150 and body['question'] is None
        assert db.execute('SELECT finished_at IS NOT NULL, total_points FROM attempts WHERE id = %s',
                          (attempt_id,)).fetchone() == (True, 150)
        assert answer(cookie, attempt_id, song_id, 'again')[0] == 409

        status, today, _ = api('/api/quiz/today', cookie=cookie)
        landed = today['attempt']
        assert {k: landed[k] for k in ('id', 'total_points', 'answered', 'finished')} == \
               {'id': attempt_id, 'total_points': 150, 'answered': 7, 'finished': True}, landed
        assert today['players_finished'] >= 1
        # The flight's own answers come back with it, so a refresh still shows the tiers.
        own = landed['answers']
        assert [a['position'] for a in own] == [1, 2, 3, 4, 5, 6, 7], own
        assert own[0] == {'position': 1, 'raw_text': '  KID-a! ', 'correct': True,
                          'tier': 'Main Sequence', 'points': 30}, own[0]
        assert own[2] == {'position': 3, 'raw_text': '', 'correct': False, 'tier': None, 'points': 0}, own[2]
        assert own[6]['tier'] == 'Supernova' and own[6]['points'] == 100, own[6]
        assert 'normalized' not in str(own) and 'OK Computer' not in str(own)

        # -------------------------------------------------- the haul, after landing
        assert api('/api/quiz/today/reveal')[0] == 401
        _, still_diving = me()
        api('/api/attempts', {}, cookie=still_diving)
        assert api('/api/quiz/today/reveal', cookie=still_diving)[0] == 403
        status, sheet, _ = api('/api/quiz/today/reveal', cookie=cookie)
        assert status == 200, (status, sheet)
        assert [q['position'] for q in sheet['questions']] == [1, 2, 3, 4, 5, 6, 7]
        q1 = sheet['questions'][0]
        assert q1['prompt'] == 'Name a Radiohead album'
        # Rarest first: Kid A (Main Sequence) above the crowd's OK Computer (Nebula).
        assert [a['display'] for a in q1['answers']] == ['Kid A', 'OK Computer'], q1['answers']
        assert q1['answers'][0]['yours'] is True and q1['answers'][1]['yours'] is False
        assert q1['answers'][0]['tier'] == 'Main Sequence' and q1['answers'][1]['tier'] == 'Nebula'
        song = sheet['questions'][6]
        assert [a['display'] for a in song['answers']] == ['Radiohead Creep', 'Radiohead'], song['answers']
        assert song['answers'][0]['tier'] == 'Supernova' and song['answers'][0]['yours'] is True
        assert 'normalized' not in str(sheet) and 'track_id' not in str(sheet)
        assert len(sheet['dist']) == 36 and sheet['better_than'] >= 0
        st, idea, _ = api('/api/ideas', {'text': 'name a dwarf planet'}, cookie=cookie)
        assert st == 200 and idea.get('ok') is True, (st, idea)
        assert api('/api/ideas', {'text': 'no'}, cookie=cookie)[0] == 400

        # -------------------------------------------------- completions
        status, names, _ = api('/api/suggest?kind=artist&q=' + urllib.parse.quote(artist_name[:3]))
        assert status == 200 and artist_name in names, (artist_name, names)
        assert api('/api/suggest?kind=artist&q=x')[1] == []                 # one letter: nothing scanned
        assert api('/api/suggest?kind=bogus&q=abc')[0] == 400
        assert 'OK Computer' not in str(api('/api/suggest?kind=album&q=ok%20co')[1]) or \
               db.execute("SELECT 1 FROM albums WHERE title = 'OK Computer'").fetchone()   # catalog only

        # -------------------------------------------------- catalog check
        # The answer fields ask whether a name is real before it costs the guess.
        # It compares through normalize_answer, so case and punctuation still pass,
        # and it reads the catalog only: nothing here can be used to probe the key.
        def known(kind, q):
            return api(f'/api/known?kind={kind}&q=' + urllib.parse.quote(q))

        assert known('artist', artist_name)[1] == {'known': True}, artist_name
        assert known('artist', artist_name.upper() + '!')[1] == {'known': True}
        assert known('artist', 'zzz not a real artist zzz')[1] == {'known': False}
        assert known('artist', '')[1] == {'known': True}          # empty is a skip, never unknown
        assert known('bogus', 'abc')[0] == 400
        # It answers about the catalog, not the answer key: 'Answer 2' is accepted
        # for question 2 and is not a track, so it must still come back unknown.
        assert known('title', 'Answer 2')[1] == {'known': False}

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

        # -------------------------------------------------- a played quiz stands
        assert api('/api/quizzes', build_quiz(track_id), token=TOKEN)[0] == 409

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
              ' timeout/skip, finish, audio by question, per-account dedupe, answer-key and questions RLS,'
              ' the answer response never serving the next question, own answers on /api/quiz/today,'
              ' and the post-flight reveal sorted by rarity')
    finally:
        if quiz_id:
            db.execute('DELETE FROM quizzes WHERE id = %s', (quiz_id,))
        if seeded:
            db.execute('DELETE FROM players WHERE id = ANY(%s::uuid[])', (seeded,))
        cleanup(db)
