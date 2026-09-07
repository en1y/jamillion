"""Local Supabase integration checks; creates and removes only test-owned rows.

Load .env, run the backend, then:
  .venv/bin/python backend/tests/auth_integration.py
Requires the existing scripts/requirements.txt environment (psycopg).
"""
import concurrent.futures
import os
import time
import uuid

import psycopg

from common import ANON, AUTH, BASE, SECRET, SERVICE, cleanup, me, request, signed, signup, users


with psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as db:
    try:
        before = db.execute('SELECT count(*) FROM profiles').fetchone()[0]
        guest, cookie = me()
        assert not guest['authenticated'] and guest['profile'] is None
        assert me(cookie=cookie)[0]['player_id'] == guest['player_id']
        assert request(BASE + '/api/tracks')[0] == 401
        assert request(BASE + '/api/me', method='POST')[0] == 405
        for value in ('broken', '', 'a.b.c'):
            me(value, cookie, expected=401)
        assert me(cookie='forged')[0]['player_id'] != guest['player_id']
        assert me(cookie=guest['player_id'])[0]['player_id'] != guest['player_id']
        name = 'test-' + uuid.uuid4().hex[:12]
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            accounts = list(pool.map(signup, [name, name]))
        uid, token = accounts[0]
        other_uid, other_token = accounts[1]
        roles = db.execute('SELECT role::text FROM profiles WHERE id = ANY(%s::uuid[])', (users,)).fetchall()
        assert sum(role[0] == 'admin' for role in roles) == (1 if before == 0 else 0)
        names = db.execute('SELECT username FROM profiles WHERE id = ANY(%s::uuid[])', (users,)).fetchall()
        assert len(set(n[0] for n in names)) == 2
        # Metadata cannot elevate permissions; make both fixtures users before role checks.
        db.execute("UPDATE profiles SET role = 'user' WHERE id = ANY(%s::uuid[])", (users,))
        linked, linked_cookie = me(token, cookie)
        assert linked['player_id'] == guest['player_id'] and linked['profile']['id'] == uid
        assert db.execute('SELECT user_id::text FROM players WHERE id = %s', (guest['player_id'],)).fetchone()[0] == uid
        assert me(token, linked_cookie)[0]['player_id'] == guest['player_id']
        assert me(cookie=linked_cookie)[0]['player_id'] != guest['player_id']
        assert me(other_token, linked_cookie)[0]['player_id'] != guest['player_id']
        for role, status in [('user', 403), ('moderator', 200), ('admin', 200), ('user', 403)]:
            db.execute('UPDATE profiles SET role = %s WHERE id = %s', (role, uid))
            assert me(token, linked_cookie)[0]['role'] == role
            assert request(BASE + '/api/tracks?limit=1', headers={'Authorization': 'Bearer ' + token})[0] == status
        claims = {'sub': uid, 'iss': os.environ.get('SUPABASE_JWT_ISSUER') or AUTH + '/auth/v1',
                  'aud': 'authenticated', 'role': 'authenticated', 'exp': int(time.time()) + 3600}
        for changes in ({'exp': 1}, {'nbf': int(time.time()) + 3600}, {'aud': 'anon'},
                        {'iss': 'wrong'}, {'sub': 'not-a-uuid'}, {'sub': str(uuid.uuid4())}, {'role': 'service_role'}):
            me(signed({**claims, **changes}), cookie, expected=401)
        me(signed({k: v for k, v in claims.items() if k != 'exp'}), cookie, expected=401)
        me(signed(claims, secret='wrong'), cookie, expected=401)
        me(signed(claims, algorithm='none'), cookie, expected=401)
        me(linked_cookie, expected=401)
        for key, value in [('apikey', ANON), ('Authorization', 'Bearer ' + token)]:
            headers = {'apikey': ANON, key: value}
            status, rows, _ = request(AUTH + '/rest/v1/question_answers?select=*', headers=headers)
            assert status == 200 and rows == []
            status, rows, _ = request(AUTH + '/rest/v1/question_top_answers?select=*', headers=headers)
            assert status == 200 and rows == []
        race_guest, race_cookie = me()
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            outcomes = list(pool.map(lambda tok: me(tok, race_cookie)[0], [token, other_token]))
        assert len({row['player_id'] for row in outcomes}) == 2
        assert sum(row['player_id'] == race_guest['player_id'] for row in outcomes) == 1
        # Deleted profiles cannot keep using an otherwise valid token.
        status, _, _ = request(AUTH + '/auth/v1/admin/users/' + uid,
                               headers={'apikey': SERVICE, 'Authorization': 'Bearer ' + SERVICE}, method='DELETE')
        assert status == 200
        me(token, linked_cookie, expected=401)
        users.remove(uid)
        print('PASS: signup/login, concurrent bootstrap, guest persistence/linking, account isolation, roles, JWT rejection, RLS')
    finally:
        cleanup(db)
