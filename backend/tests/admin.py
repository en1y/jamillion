"""Admin checks for v0.5.0. Creates and removes only test-owned rows.

Load .env, run the backend and the local Supabase stack, then:
  .venv/bin/python backend/tests/admin.py

Unlike quiz_play.py and moderation.py this does not own the game day: it builds
its own quiz on a far-future date, fills in finished attempts with SQL instead of
playing them through the timer, and deletes the quiz on the way out.
"""
import os
import uuid

import psycopg

import common
from common import ANON, BASE, cleanup, me, request, signup

ADMIN = None          # admin access token
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


def build_quiz():
    """Seven rarest questions, positions 1..7. No song question, so no clip download."""
    questions = [{
        'position': 1, 'qtype': 'rarest', 'prompt': 'Name a Radiohead album',
        'answers': [{'display': 'OK Computer'}, {'display': 'Kid A'}],
    }]
    for position in range(2, 8):
        questions.append({
            'position': position, 'qtype': 'rarest', 'prompt': MUSIC[position],
            'answers': [{'display': f'Answer {position}'}],
        })
    return {'quiz_date': QUIZ_DATE, 'published': False, 'questions': questions}


def find_user(listing, user_id):
    return next((u for u in listing if u['id'] == user_id), None)


with psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as db:
    quiz_id, demoted = None, []
    try:
        # A date far enough out that it can never be the game day of another test.
        QUIZ_DATE = db.execute("SELECT (game_today() + 400)::text").fetchone()[0]
        if db.execute('SELECT 1 FROM quizzes WHERE quiz_date = %s', (QUIZ_DATE,)).fetchone():
            raise SystemExit(f'A quiz already exists for {QUIZ_DATE}. Remove it first.')

        admin_uid, ADMIN = signup('admin-test-' + uuid.uuid4().hex[:8])
        db.execute("UPDATE profiles SET role = 'admin' WHERE id = %s", (admin_uid,))
        plain_uid, PLAIN = signup('user-test-' + uuid.uuid4().hex[:8])
        mod_uid, MOD = signup('modgone-test-' + uuid.uuid4().hex[:8])
        db.execute("UPDATE profiles SET role = 'moderator' WHERE id = %s", (mod_uid,))

        # The moderator owns the quiz, so deleting them later proves quizzes.created_by
        # gives way instead of blocking the delete.
        status, created, _ = api('/api/quizzes', build_quiz(), token=MOD)
        assert status == 201, (status, created)
        quiz_id = created['id']

        questions = db.execute('SELECT id, position FROM questions WHERE quiz_id = %s ORDER BY position',
                               (quiz_id,)).fetchall()
        first_q = questions[0][0]
        okc, kid_a = (db.execute('SELECT id, display FROM question_answers WHERE question_id = %s '
                                 'ORDER BY display', (first_q,)).fetchall())
        assert okc[1] == 'Kid A' and kid_a[1] == 'OK Computer'
        kid_a, okc = okc[0], kid_a[0]          # (Kid A id, OK Computer id)

        # Three finished flights, written straight to the tables: this test is about
        # what admin reads back, not about the timer quiz_play.py already covers.
        _, cookie_a = me()
        _, cookie_b = me()
        _, cookie_mod = me(token=MOD)
        player_a, player_b, player_mod = (
            db.execute('SELECT id FROM players WHERE id = ANY(%s::uuid[]) ORDER BY created_at',
                       (list(common.players),)).fetchall())
        rows = db.execute(
            'INSERT INTO attempts (player_id, quiz_id, finished_at, total_points) '
            'SELECT unnest(%s::uuid[]), %s, now(), unnest(%s::smallint[]) RETURNING id, total_points',
            ([player_a[0], player_b[0], player_mod[0]], quiz_id, [30, 0, 30])).fetchall()
        by_points = {}
        for attempt_id, points in rows:
            by_points.setdefault(points, []).append(attempt_id)
        scored, skipped = by_points[30], by_points[0]
        for attempt_id in scored:
            db.execute('INSERT INTO attempt_answers (attempt_id, question_id, raw_text, answer_id, '
                       'tier_id, points) VALUES (%s, %s, %s, %s, 3, 30)',
                       (attempt_id, first_q, 'ok computer', okc))
        db.execute('INSERT INTO attempt_answers (attempt_id, question_id, raw_text, answer_id, points) '
                   'VALUES (%s, %s, %s, NULL, 0)', (skipped[0], first_q, ''))
        db.execute('UPDATE question_answers SET guess_count = 2 WHERE id = %s', (okc,))

        # -------------------------------------------------- users
        status, listing, _ = api('/api/users', token=ADMIN)
        assert status == 200, (status, listing)
        mine = find_user(listing, admin_uid)
        assert mine and mine['role'] == 'admin' and '@' in mine['email']
        assert mine['username'].startswith('admin-test-') and mine['created_at']
        moderator = find_user(listing, mod_uid)
        assert moderator['role'] == 'moderator' and moderator['browsers'] == 1
        assert moderator['attempts'] == 1, moderator

        _, filtered, _ = api(f"/api/users?q={find_user(listing, plain_uid)['username']}", token=ADMIN)
        assert [u['id'] for u in filtered] == [plain_uid], filtered
        _, by_role, _ = api('/api/users?role=moderator', token=ADMIN)
        assert all(u['role'] == 'moderator' for u in by_role) and find_user(by_role, mod_uid)
        assert api('/api/users?role=bogus', token=ADMIN)[0] == 400
        assert len(api('/api/users?limit=1', token=ADMIN)[1]) == 1

        # sorts: the listing comes back ordered, the reverse is the mirror image,
        # and role sorts on the enum so admins land at the top of a descending page
        # asc and desc are checked against each other, not against Python's sort:
        # Postgres orders text by the database collation, which is not codepoint order
        _, by_name, _ = api('/api/users?sort=username', token=ADMIN)
        names = [u['username'] for u in by_name]
        _, desc, _ = api('/api/users?sort=username&dir=desc', token=ADMIN)
        assert [u['username'] for u in desc] == names[::-1], names
        _, by_role_sort, _ = api('/api/users?sort=role&dir=desc', token=ADMIN)
        assert by_role_sort[0]['role'] == 'admin', by_role_sort[0]
        _, by_attempts, _ = api('/api/users?sort=attempts&dir=desc', token=ADMIN)
        counts = [u['attempts'] for u in by_attempts]
        assert counts == sorted(counts, reverse=True), counts
        assert api('/api/users?sort=p.id', token=ADMIN)[0] == 400, 'sort is allowlisted'
        assert api('/api/users?sort=created_at&dir=sideways', token=ADMIN)[0] == 400
        # a unique tiebreaker, so paging cannot show one user twice and skip another
        paged = [u['id'] for n in range(0, len(names))
                 for u in api(f'/api/users?sort=role&limit=1&offset={n}', token=ADMIN)[1]]
        assert len(paged) == len(set(paged)) == len(names), paged

        assert api('/api/users', token=PLAIN)[0] == 403
        assert api('/api/users')[0] == 401
        assert api('/api/users', token=MOD)[0] == 403, 'a moderator is not an admin'

        # -------------------------------------------------- role changes
        assert api(f'/api/quizzes/{QUIZ_DATE}', token=PLAIN)[0] == 403
        status, promoted, _ = api(f'/api/users/{plain_uid}', {'role': 'moderator'},
                                  token=ADMIN, method='PATCH')
        assert status == 200 and promoted['role'] == 'moderator', (status, promoted)
        assert api(f'/api/quizzes/{QUIZ_DATE}', token=PLAIN)[0] == 200, 'the new role takes effect at once'
        assert api(f'/api/users/{plain_uid}', {'role': 'user'}, token=ADMIN, method='PATCH')[0] == 200
        assert api(f'/api/users/{plain_uid}', {'role': 'wizard'}, token=ADMIN, method='PATCH')[0] == 400
        assert api(f'/api/users/{plain_uid}', {}, token=ADMIN, method='PATCH')[0] == 400
        assert api(f'/api/users/{uuid.uuid4()}', {'role': 'user'}, token=ADMIN, method='PATCH')[0] == 404
        assert api('/api/users/not-a-uuid', {'role': 'user'}, token=ADMIN, method='PATCH')[0] == 404
        assert api(f'/api/users/{plain_uid}', {'role': 'admin'}, token=PLAIN, method='PATCH')[0] == 403

        # -------------------------------------------------- the last admin stays
        demoted = [row[0] for row in db.execute(
            "SELECT id FROM profiles WHERE role = 'admin' AND id <> %s", (admin_uid,)).fetchall()]
        db.execute("UPDATE profiles SET role = 'user' WHERE id = ANY(%s::uuid[])", (demoted,))
        assert api(f'/api/users/{admin_uid}', {'role': 'user'}, token=ADMIN, method='PATCH')[0] == 409
        assert api(f'/api/users/{admin_uid}', token=ADMIN, method='DELETE')[0] == 409
        assert api(f'/api/users/{admin_uid}', {'role': 'admin'}, token=ADMIN, method='PATCH')[0] == 200
        db.execute("UPDATE profiles SET role = 'admin' WHERE id = ANY(%s::uuid[])", (demoted,))
        demoted = []
        assert db.execute('SELECT role FROM profiles WHERE id = %s', (admin_uid,)).fetchone()[0] == 'admin'

        # -------------------------------------------------- per-question stats
        status, stats, _ = api(f'/api/quizzes/{QUIZ_DATE}/stats', token=ADMIN)
        assert status == 200, (status, stats)
        assert stats['id'] == quiz_id and stats['published'] is False
        assert stats['heights'] == [{'total_points': 0, 'height_au': '0.00', 'players': 1},
                                    {'total_points': 30, 'height_au': '5.14', 'players': 2}], stats['heights']
        assert [q['position'] for q in stats['questions']] == [1, 2, 3, 4, 5, 6, 7]
        one = stats['questions'][0]
        assert (one['answered'], one['skipped'], one['correct']) == (3, 1, 2), one
        assert stats['questions'][1]['answered'] == 0
        top = one['top_answers']
        assert [a['display'] for a in top] == ['OK Computer', 'Kid A'], top
        assert top[0]['guess_count'] == 2 and top[0]['is_correct'] is True
        assert top[0]['share'] == '0.6667', top[0]        # 2 of the 3 answers stored
        assert top[1]['guess_count'] == 0 and top[1]['share'] == '0.0000'
        assert len(api(f'/api/quizzes/{QUIZ_DATE}/stats?top=1', token=ADMIN)[1]['questions'][0]['top_answers']) == 1
        assert api('/api/quizzes/nope/stats', token=ADMIN)[0] == 400
        assert api('/api/quizzes/1999-01-01/stats', token=ADMIN)[0] == 404
        assert api(f'/api/quizzes/{QUIZ_DATE}/stats', token=MOD)[0] == 403
        assert api(f'/api/quizzes/{QUIZ_DATE}/stats')[0] == 401

        # -------------------------------------------------- raw table view
        status, tables, _ = api('/api/tables', token=ADMIN)
        assert status == 200 and 'rarity_tiers' in tables and 'quiz_heights' in tables
        assert not [t for t in tables if 'auth' in t], tables
        status, dump, _ = api('/api/tables/rarity_tiers', token=ADMIN)
        assert status == 200 and dump['table'] == 'rarity_tiers'
        assert len(dump['rows']) == 6 and dump['rows'][0]['name'] == 'Nebula'
        assert dump['rows'][0]['points'] == 10, 'Postgres types the rows, they are not all strings'
        _, paged, _ = api('/api/tables/rarity_tiers?limit=2&offset=2', token=ADMIN)
        assert [r['id'] for r in paged['rows']] == [3, 4], paged['rows']
        _, empty, _ = api('/api/tables/quizzes?limit=1&offset=100000', token=ADMIN)
        assert empty['rows'] == []
        for blocked in ('auth.users', 'pg_shadow', 'users', 'profiles;drop'):
            assert api('/api/tables/' + blocked, token=ADMIN)[0] == 404, blocked
        assert api('/api/tables', token=MOD)[0] == 403
        assert api('/api/tables/rarity_tiers')[0] == 401

        # -------------------------------------------------- tier editing
        status, tier, _ = api('/api/tiers/1', {'points': 11}, token=ADMIN, method='PATCH')
        assert status == 200, (status, tier)
        assert tier['name'] == 'Nebula' and tier['points'] == 11 and tier['sort_order'] == 1
        assert api('/api/tables/rarity_tiers', token=ADMIN)[1]['rows'][0]['points'] == 11
        frozen = db.execute('SELECT points FROM attempt_answers WHERE answer_id = %s', (okc,)).fetchall()
        assert [p[0] for p in frozen] == [30, 30], 'a tier edit must not re-score what was already awarded'
        status, share, _ = api('/api/tiers/1', {'max_share': 0.9}, token=ADMIN, method='PATCH')
        assert status == 200 and share['max_share'] == '0.9000' and share['points'] == 11, share
        assert api('/api/tiers/1', {'name': 'Protostar'}, token=ADMIN, method='PATCH')[0] == 409
        assert api('/api/tiers/1', {'name': 'Nebula'}, token=ADMIN, method='PATCH')[0] == 200
        assert api('/api/tiers/1', {'max_share': 1.5}, token=ADMIN, method='PATCH')[0] == 400
        assert api('/api/tiers/1', {'max_share': 0}, token=ADMIN, method='PATCH')[0] == 400
        assert api('/api/tiers/1', {'points': -1}, token=ADMIN, method='PATCH')[0] == 400
        assert api('/api/tiers/1', {'name': ''}, token=ADMIN, method='PATCH')[0] == 400
        assert api('/api/tiers/1', {}, token=ADMIN, method='PATCH')[0] == 400
        assert api('/api/tiers/1', {'sort_order': 4}, token=ADMIN, method='PATCH')[0] == 400
        assert api('/api/tiers/99', {'points': 5}, token=ADMIN, method='PATCH')[0] == 404
        assert api('/api/tiers/1', {'points': 10}, token=MOD, method='PATCH')[0] == 403
        db.execute('UPDATE rarity_tiers SET points = 10, max_share = 1.0 WHERE id = 1')

        # -------------------------------------------------- deleting an account
        status, gone, _ = api(f'/api/users/{mod_uid}', token=ADMIN, method='DELETE')
        assert status == 200 and gone['deleted'] is True, (status, gone)
        common.users.remove(mod_uid)
        assert api(f'/api/users/{mod_uid}', token=ADMIN, method='DELETE')[0] == 404
        assert not db.execute('SELECT 1 FROM profiles WHERE id = %s', (mod_uid,)).fetchone()
        assert not db.execute('SELECT 1 FROM auth.users WHERE id = %s', (mod_uid,)).fetchone()
        me(token=MOD, expected=401)
        # The flight survives the account, de-identified, and so does the quiz.
        assert db.execute('SELECT user_id FROM players WHERE id = %s', (player_mod[0],)).fetchone()[0] is None
        assert db.execute('SELECT count(*) FROM attempts WHERE player_id = %s',
                          (player_mod[0],)).fetchone()[0] == 1
        assert db.execute('SELECT created_by FROM quizzes WHERE id = %s', (quiz_id,)).fetchone()[0] is None
        assert api(f'/api/quizzes/{QUIZ_DATE}/stats', token=ADMIN)[1]['heights'][1]['players'] == 2

        # -------------------------------------------------- deleting a day
        assert api(f'/api/quizzes/{QUIZ_DATE}', token=PLAIN, method='DELETE')[0] == 403
        assert api(f'/api/users/{plain_uid}', {'role': 'moderator'}, token=ADMIN, method='PATCH')[0] == 200
        assert api(f'/api/quizzes/{QUIZ_DATE}', token=PLAIN, method='DELETE')[0] == 403, \
            'a moderator writes a day but only an admin deletes one'
        assert api(f'/api/users/{plain_uid}', {'role': 'user'}, token=ADMIN, method='PATCH')[0] == 200
        assert api(f'/api/quizzes/{QUIZ_DATE}', method='DELETE')[0] == 401
        assert api('/api/quizzes/nope', token=ADMIN, method='DELETE')[0] == 400
        assert api('/api/quizzes/1999-01-01', token=ADMIN, method='DELETE')[0] == 404
        status, dropped, _ = api(f'/api/quizzes/{QUIZ_DATE}', token=ADMIN, method='DELETE')
        assert status == 200 and dropped['deleted'] is True, (status, dropped)
        assert api(f'/api/quizzes/{QUIZ_DATE}', token=ADMIN, method='DELETE')[0] == 404
        # The cascade takes the questions, the answer key and the flights with it.
        for table in ('questions', 'attempts'):
            assert db.execute(f'SELECT count(*) FROM {table} WHERE quiz_id = %s',
                              (quiz_id,)).fetchone()[0] == 0, table
        assert not db.execute('SELECT 1 FROM question_answers WHERE id = %s', (okc,)).fetchone()

        # -------------------------------------------------- PostgREST stays shut
        rest = os.environ['SUPABASE_URL'].rstrip('/')
        request(f'{rest}/rest/v1/rarity_tiers?id=eq.1', {'points': 99},
                {'apikey': ANON, 'Authorization': 'Bearer ' + PLAIN}, method='PATCH')
        assert db.execute('SELECT points FROM rarity_tiers WHERE id = 1').fetchone()[0] == 10, \
            'a plain user must not edit the tiers through PostgREST'
        request(f'{rest}/rest/v1/profiles?id=eq.{plain_uid}', {'role': 'admin'},
                {'apikey': ANON, 'Authorization': 'Bearer ' + PLAIN}, method='PATCH')
        assert db.execute('SELECT role FROM profiles WHERE id = %s', (plain_uid,)).fetchone()[0] == 'user', \
            'a plain user must not promote themselves through PostgREST'

        print('PASS: user listing with filters, role changes taking effect at once, the last admin'
              ' protected from demotion and deletion, per-question stats with the height histogram,'
              ' the allowlisted table dump, tier editing that leaves awarded points alone,'
              ' account deletion keeping the flights and releasing the quiz,'
              ' and an admin-only day deletion that cascades')
    finally:
        if demoted:
            db.execute("UPDATE profiles SET role = 'admin' WHERE id = ANY(%s::uuid[])", (demoted,))
        db.execute('UPDATE rarity_tiers SET points = 10, max_share = 1.0, name = %s WHERE id = 1', ('Nebula',))
        if quiz_id:
            db.execute('DELETE FROM quizzes WHERE id = %s', (quiz_id,))
        cleanup(db)
