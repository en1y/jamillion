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


MUSIC = {2: 'Name a Coldplay album', 3: 'Name a Queen song', 4: 'Name a member of The Beatles',
         5: 'Name a Nirvana album', 6: 'Name a Michael Jackson album', 7: 'Name a Radiohead song'}


def build_quiz(track_id):
    """Six rarest questions plus one song question, positions 1..7. Unpublished."""
    questions = [{
        'position': 1, 'qtype': 'rarest', 'prompt': 'Name a Radiohead album',
        'answers': [{'display': 'OK Computer'}, {'display': 'Kid A'}],
    }]
    for position in range(2, 7):
        questions.append({
            'position': position, 'qtype': 'rarest', 'prompt': MUSIC[position],
            'answers': [{'display': f'Answer {position}'}],
        })
    questions.append({
        'position': 7, 'qtype': 'song', 'prompt': 'Artist and title?', 'track_id': track_id,
        'snippet_start_sec': 12, 'snippet_len_sec': 10,
        'answers': [{'display': 'Radiohead Creep', 'tier_id': 6}],
    })
    return {'quiz_date': QUIZ_DATE, 'published': False, 'questions': questions}


def fetch_clip(path, token=None):
    """Audio is binary, so it does not go through the JSON helper."""
    req = urllib.request.Request(BASE + path)
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    try:
        response = urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as failure:
        return failure.status, b'', failure.headers
    return response.status, response.read(), response.headers


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
    quiz_id = spare_id = None
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

        # -------------------------------------------------- editing an unplayed day
        # Everything here is refused once the day has attempts; see the played-day
        # block further down. The song question is position 7.
        song_id = questions[7]
        status, edited, _ = api(f'/api/questions/{song_id}',
                                {'snippet_start_sec': 4, 'snippet_len_sec': 12}, token=TOKEN, method='PATCH')
        assert status == 200, (status, edited)
        assert edited['snippet_start_sec'] == 4 and edited['snippet_len_sec'] == 12, edited
        assert edited['quiz_date'] == QUIZ_DATE and edited['position'] == 7
        assert api(f'/api/questions/{song_id}', {'prompt': 'Name this one.'},
                   token=TOKEN, method='PATCH')[1]['prompt'] == 'Name this one.'
        assert api(f'/api/questions/{song_id}', {'time_limit_sec': 45},
                   token=TOKEN, method='PATCH')[1]['time_limit_sec'] == 45
        # the DB CHECKs are pre-empted, so a moderator never reads Postgres's words
        assert api(f'/api/questions/{song_id}', {'snippet_start_sec': 25, 'snippet_len_sec': 6},
                   token=TOKEN, method='PATCH')[0] == 400          # 31 s does not fit
        assert api(f'/api/questions/{song_id}', {'ask_artist': False, 'ask_title': False},
                   token=TOKEN, method='PATCH')[0] == 400
        assert api(f'/api/questions/{song_id}', {'time_limit_sec': 99}, token=TOKEN, method='PATCH')[0] == 400
        assert api(f'/api/questions/{song_id}', {'prompt': ''}, token=TOKEN, method='PATCH')[0] == 400
        assert api(f'/api/questions/{song_id}', {}, token=TOKEN, method='PATCH')[0] == 400
        # qtype decides which keys even apply
        assert api(f'/api/questions/{questions[1]}', {'snippet_start_sec': 1},
                   token=TOKEN, method='PATCH')[0] == 400          # rarest has no snippet
        assert api(f'/api/questions/{questions[1]}', {'ask_artist': True},
                   token=TOKEN, method='PATCH')[0] == 400
        assert api('/api/questions/99999999', {'prompt': 'x'}, token=TOKEN, method='PATCH')[0] == 404
        assert api(f'/api/questions/{song_id}', {'prompt': 'x'}, method='PATCH')[0] == 401

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

        # "accepted, and worth nothing" is a verdict of its own, and it survives a
        # verdict change; setting a tier by hand puts the answer back on the ladder.
        status, body, _ = api(f"/api/answers/{bends['id']}",
                              {'is_correct': True, 'points': 0}, token=TOKEN, method='PATCH')
        assert status == 200 and body['points'] == 0, (status, body)
        assert totals(bends_players) == [0, 0, 0], 'a scored answer worth nothing'
        status, body, _ = api(f"/api/answers/{bends['id']}", {'is_correct': True}, token=TOKEN, method='PATCH')
        assert body['points'] == 0, 'an absent key keeps it, like every other field'
        status, body, _ = api(f"/api/answers/{bends['id']}", {'tier_id': 4}, token=TOKEN, method='PATCH')
        assert body['points'] is None, 'a hand-set tier takes the override away'
        assert totals(bends_players) == [60, 60, 60]
        status, body, _ = api(f"/api/answers/{bends['id']}",
                              {'points': None, 'is_correct': None, 'tier_id': None},
                              token=TOKEN, method='PATCH')
        assert body['points'] is None and totals(bends_players) == [0, 0, 0]

        assert api(f"/api/answers/{bends['id']}", {}, token=TOKEN, method='PATCH')[0] == 400
        assert api(f"/api/answers/{bends['id']}", {'points': 701}, token=TOKEN, method='PATCH')[0] == 400
        assert api(f"/api/answers/{bends['id']}", {'points': -1}, token=TOKEN, method='PATCH')[0] == 400
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

        # -------------------------------------------------- the editor's routes
        # v0.8.2. Together these are what makes a quiz authorable by a moderator
        # rather than only by an admin with a table dump.
        status, tiers, _ = api('/api/tiers', token=TOKEN)
        assert status == 200 and len(tiers) == 6, (status, tiers)
        assert [t['sort_order'] for t in tiers] == sorted(t['sort_order'] for t in tiers)
        assert all(isinstance(t['id'], int) for t in tiers), tiers
        # the ids are the point: an override has to be expressible
        assert api(f"/api/answers/{okc['id']}", {'tier_id': tiers[-1]['id']},
                   token=TOKEN, method='PATCH')[0] == 200
        assert api(f"/api/answers/{okc['id']}", {'tier_id': None}, token=TOKEN, method='PATCH')[0] == 200

        status, days, _ = api('/api/quizzes', token=TOKEN)
        assert status == 200, (status, days)
        today_row = next(d for d in days if d['quiz_date'] == QUIZ_DATE)
        assert today_row['questions'] == 7 and today_row['published'] is True
        assert today_row['attempts_started'] >= 4, today_row      # the guesses above
        assert api('/api/quizzes?from=1999-01-01&to=1999-01-02', token=TOKEN)[1] == []
        assert api('/api/quizzes?from=nope', token=TOKEN)[0] == 400

        # A clip can be heard before any question uses it, which is what the
        # snippet picker needs and why the later save finds the file cached.
        db.execute('UPDATE tracks SET audio_path = NULL WHERE id = %s', (track[0],))
        status, clip, headers = fetch_clip(f'/api/tracks/{track[0]}/audio', TOKEN)
        assert status == 200 and headers['Content-Type'].startswith('audio/'), headers
        assert len(clip) > 10_000, len(clip)
        assert db.execute('SELECT audio_path FROM tracks WHERE id = %s', (track[0],)).fetchone()[0]
        assert fetch_clip(f'/api/tracks/{track[0]}/audio', TOKEN)[0] == 200      # idempotent
        assert fetch_clip('/api/tracks/99999999/audio', TOKEN)[0] == 404
        assert fetch_clip(f'/api/tracks/{track[0]}/audio')[0] == 401

        # The catalog, asked the way the editor asks it. /api/catalog/fields is the
        # allowlist the whole builder is drawn from, so a column the UI offers and
        # the backend does not accept cannot happen.
        status, fields, _ = api('/api/catalog/fields', token=TOKEN)
        assert status == 200, (status, fields)
        assert {'tracks', 'albums', 'artists'} == {one['name'] for one in fields['entities']}
        assert 'contains' in fields['operators']['text'] and 'gte' in fields['operators']['number']
        assert {'artist.name', 'track.lastfm_listeners', 'track.ytmusic_plays',
                'album.ytmusic_plays', 'artist.ytmusic_listeners', 'track.genres',
                'album.genres', 'artist.genres'} <= {one['key'] for one in fields['fields']}
        genre_on = {one['key']: set(one['entities']) for one in fields['fields']}
        assert genre_on['track.genres'] == {'tracks'}
        assert genre_on['album.genres'] == {'tracks', 'albums'}
        assert genre_on['artist.genres'] == {'tracks', 'albums', 'artists'}

        # An album question, authored end to end without an admin route. This is
        # the v0.7.0 gap: POST /api/quizzes needs an album_id and nothing a
        # moderator could reach handed one out.
        status, page, _ = api('/api/catalog', {'entity': 'albums', 'limit': 1}, token=TOKEN)
        assert status == 200 and page['rows'], (status, page)
        album = {'id': page['rows'][0]['id'], 'title': page['rows'][0]['album.title'],
                 'artist': page['rows'][0]['artist.name'],
                 'cover_url': page['rows'][0]['album.cover_url']}
        assert isinstance(album['id'], int) and album['title'] and album['artist']
        assert page['total'] >= len(page['rows']) == 1

        # Filters stack and sorts stack, which is the whole point: "every song by
        # this artist over N listens, biggest first" is one request. The artist and
        # the floor come out of the catalog so this holds on any seed.
        status, top, _ = api('/api/catalog', {
            'entity': 'tracks', 'sorts': [{'field': 'track.lastfm_listeners', 'dir': 'desc'}],
            'limit': 1}, token=TOKEN)
        assert status == 200 and top['rows'], (status, top)
        who = top['rows'][0]['artist.name']
        floor = (top['rows'][0]['track.lastfm_listeners'] or 0) // 2
        status, page, _ = api('/api/catalog', {
            'entity': 'tracks',
            'filters': [{'field': 'artist.name', 'op': 'eq', 'value': who},
                        {'field': 'track.lastfm_listeners', 'op': 'gte', 'value': floor}],
            'sorts': [{'field': 'track.lastfm_listeners', 'dir': 'desc'}], 'limit': 5}, token=TOKEN)
        assert status == 200 and page['rows'], (status, page)
        listens = [row['track.lastfm_listeners'] for row in page['rows']]
        assert all(row['artist.name'] == who for row in page['rows']), page['rows']
        assert all(count >= floor for count in listens), listens
        assert listens == sorted(listens, reverse=True), listens

        # The same shape on the YouTube Music play count, the number the editor's
        # results table shows by default; NULLS LAST, so a seed with no YouTube
        # run yet still answers rather than sorting the blanks to the top
        status, page, _ = api('/api/catalog', {
            'entity': 'tracks', 'filters': [{'field': 'track.ytmusic_plays', 'op': 'notnull', 'value': ''}],
            'sorts': [{'field': 'track.ytmusic_plays', 'dir': 'desc'}], 'limit': 5}, token=TOKEN)
        assert status == 200, (status, page)
        plays = [row['track.ytmusic_plays'] for row in page['rows']]
        assert plays == sorted(plays, reverse=True) and None not in plays, plays
        status, artists, _ = api('/api/catalog', {
            'entity': 'artists', 'sorts': [{'field': 'artist.ytmusic_listeners', 'dir': 'desc'}], 'limit': 3},
            token=TOKEN)
        assert status == 200 and artists['rows'], (status, artists)
        assert 'artist.ytmusic_listeners' in artists['rows'][0], artists['rows'][0]

        # An album has no play count of its own, so album.ytmusic_plays sums its
        # tracks'. Checked against the tracks it came from rather than a number
        # typed here, so it holds whatever the seeder has fetched so far.
        status, records, _ = api('/api/catalog', {
            'entity': 'albums', 'filters': [{'field': 'album.ytmusic_plays', 'op': 'notnull', 'value': ''}],
            'sorts': [{'field': 'album.ytmusic_plays', 'dir': 'desc'}], 'limit': 5}, token=TOKEN)
        assert status == 200 and records['rows'], (status, records)
        totals = [row['album.ytmusic_plays'] for row in records['rows']]
        assert totals == sorted(totals, reverse=True) and None not in totals, totals
        biggest = records['rows'][0]
        songs = db.execute('SELECT sum(ytmusic_plays) FROM tracks WHERE album_id = %s',
                           (biggest['id'],)).fetchone()[0]
        assert int(biggest['album.ytmusic_plays']) == int(songs), (biggest, songs)

        # Genres, which Deezer only tags on the album: a track reads its album's and
        # an artist the union over theirs, so "Rock" as a substring is how a genre
        # is asked for and the artist list is always the wider of the two.
        status, page, _ = api('/api/catalog', {
            'entity': 'tracks',
            'filters': [{'field': 'track.genres', 'op': 'contains', 'value': 'Rock'}],
            'limit': 5}, token=TOKEN)
        assert status == 200 and page['rows'], (status, page)
        assert all('rock' in row['track.genres'].lower() for row in page['rows']), page['rows']
        assert all(set(row['track.genres'].split(', ')) <= set(row['artist.genres'].split(', '))
                   for row in page['rows']), 'a track genre its artist does not have'
        status, records, _ = api('/api/catalog', {
            'entity': 'albums', 'filters': [{'field': 'album.genres', 'op': 'notnull', 'value': ''}],
            'sorts': [{'field': 'album.genres', 'dir': 'asc'}], 'limit': 3}, token=TOKEN)
        assert status == 200 and records['rows'], (status, records)
        assert all(row['album.genres'] for row in records['rows']), records['rows']
        # per album, not per artist: one artist's records do not all read the same
        status, spread, _ = api('/api/catalog', {
            'entity': 'albums', 'filters': [{'field': 'artist.name', 'op': 'eq', 'value': 'Arctic Monkeys'},
                                            {'field': 'album.genres', 'op': 'notnull', 'value': ''}],
            'limit': 200}, token=TOKEN)
        assert status == 200, (status, spread)
        if len(spread['rows']) > 1:
            assert len({row['album.genres'] for row in spread['rows']}) > 1, \
                'every album tagged alike means album_genres was not filled'

        # The allowlist is the security boundary: no table, column or operator
        # reaches the SQL from the request, only a key that matched a row in it.
        for bad in ({'entity': 'profiles'},
                    {'entity': 'tracks', 'filters': [
                        {'field': 'id FROM profiles --', 'op': 'eq', 'value': '1'}]},
                    {'entity': 'tracks', 'filters': [
                        {'field': 'artist.name', 'op': 'gte', 'value': 'x'}]},
                    {'entity': 'tracks', 'filters': [
                        {'field': 'artist.name', 'op': 'eq', 'value': ''}]},
                    {'entity': 'tracks', 'sorts': [{'field': 'profiles.role', 'dir': 'asc'}]}):
            assert api('/api/catalog', bad, token=TOKEN)[0] == 400, bad
        assert api('/api/catalog', {'entity': 'tracks'})[0] == 401

        spare_date = db.execute("SELECT (game_today() + 90)::text").fetchone()[0]
        payload = build_quiz(track[0])
        payload['quiz_date'] = spare_date
        payload['questions'][0] = {
            'position': 1, 'qtype': 'album', 'prompt': 'Whose album is this?',
            'album_id': album['id'], 'ask_artist': True, 'ask_title': False,
            'answers': [{'display': album['artist'], 'tier_id': tiers[0]['id']}],
        }
        status, spare, _ = api('/api/quizzes', payload, token=TOKEN)
        assert status == 201, (status, spare)
        spare_id = spare['id']
        spare_quiz = api(f'/api/quizzes/{spare_date}', token=TOKEN)[1]
        shown = spare_quiz['questions'][0]
        assert shown['album']['id'] == album['id'], shown
        assert shown['album']['cover'] == album['cover_url'], shown   # the moderator can see it too
        assert shown['ask_artist'] is True and shown['ask_title'] is False

        # -------------------------------------------------- editing a played day
        # v0.3.0 froze points at answer time, so once anyone has flown, the prompt
        # is the only thing left that can move.
        played = questions[7]
        status, fixed, _ = api(f'/api/questions/{played}', {'prompt': 'Artist and title, please?'},
                               token=TOKEN, method='PATCH')
        assert status == 200 and fixed['prompt'] == 'Artist and title, please?', (status, fixed)
        assert api(f'/api/quizzes/{QUIZ_DATE}', token=TOKEN)[1]['questions'][6]['prompt'] \
            == 'Artist and title, please?'
        for frozen in ({'time_limit_sec': 30}, {'snippet_start_sec': 2}, {'snippet_len_sec': 5},
                       {'ask_artist': False}, {'prompt': 'x', 'snippet_start_sec': 2}):
            assert api(f'/api/questions/{played}', frozen, token=TOKEN, method='PATCH')[0] == 409, frozen

        # -------------------------------------------------- own flight history
        # A passport is required: the cookie is it, so no cookie is 401 rather
        # than an empty list.
        assert api('/api/me/flights')[0] == 401
        assert api('/api/me/flights', token=TOKEN)[0] == 401

        # A guest sees only its own row; user_id is NULL and NULL matches nothing.
        _, guest_cookie = me()
        _, guest_attempt, _ = api('/api/attempts', {}, cookie=guest_cookie)
        api(f"/api/attempts/{guest_attempt['id']}/answers",
            {'question_id': questions[1], 'text': 'Kid A'}, cookie=guest_cookie)
        status, guest_flights, _ = api('/api/me/flights', cookie=guest_cookie)
        assert status == 200 and [f['quiz_date'] for f in guest_flights] == [QUIZ_DATE], guest_flights

        # Both browsers of the account report the one flight, with its tiers and
        # never the accepted answer the guess matched.
        for cookie in (cookie_a, cookie_b):
            status, flights, headers = api('/api/me/flights', cookie=cookie, token=TOKEN)
            assert status == 200 and headers['Cache-Control'] == 'no-store'
            assert [f['quiz_date'] for f in flights] == [QUIZ_DATE], flights
            row = flights[0]
            assert isinstance(row['flight_no'], int) and row['finished'] is False
            assert row['height_au'] == round(row['total_points'] * 0.1714, 2)
            for answer in row['answers']:
                assert set(answer) == {'position', 'raw_text', 'correct', 'tier', 'points'}, answer

        # attempts are unique per (player_id, quiz_id), not per account, so two
        # browsers that each flew a day as guests and then signed in own two rows
        # for it. The history collapses a day to its best flight.
        db.execute('INSERT INTO attempts (player_id, quiz_id, total_points, finished_at)'
                   ' VALUES (%s, %s, 999, now())', (player_b, quiz_id))
        status, flights, _ = api('/api/me/flights', cookie=cookie_a, token=TOKEN)
        assert status == 200 and len(flights) == 1, flights
        assert flights[0]['total_points'] == 999 and flights[0]['finished'] is True, flights[0]
        db.execute('DELETE FROM attempts WHERE player_id = %s AND total_points = 999', (player_b,))

        # limit is clamped, never rejected
        for value in ('0', 'abc', '99999', '-5'):
            assert api(f'/api/me/flights?limit={value}', cookie=cookie_a, token=TOKEN)[0] == 200

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
              ' player detail across an account, own flight history deduped per day,'
              ' the editor routes (tiers, day list, track audio, album search) and an album'
              ' question authored without an admin route, question edits frozen to the prompt'
              ' once a day is played,'
              ' moderation RPC locked out of PostgREST')
    finally:
        for made in (quiz_id, spare_id):
            if made:
                db.execute('DELETE FROM quizzes WHERE id = %s', (made,))
        cleanup(db)
