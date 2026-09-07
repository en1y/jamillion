"""Local Supabase integration checks; creates and removes only test-owned rows.

Load .env, run the backend, then:
  .venv/bin/python backend/tests/auth_integration.py
Requires the existing scripts/requirements.txt environment (psycopg).
"""
import base64
import concurrent.futures
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.cookies import SimpleCookie

import psycopg

BASE = os.environ.get('TEST_API_URL', 'http://127.0.0.1:8080')
AUTH = os.environ['SUPABASE_URL'].rstrip('/')
for url in (BASE, AUTH, os.environ['DATABASE_URL']):
    if urllib.parse.urlparse(url).hostname not in ('localhost', '127.0.0.1', '::1'):
        raise RuntimeError('This test only runs against local services')
ANON = os.environ['SUPABASE_ANON_KEY']
SERVICE = os.environ['SUPABASE_SERVICE_ROLE_KEY']
SECRET = os.environ['SUPABASE_JWT_SECRET']
players, users = set(), []


def request(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers={'Content-Type': 'application/json', **(headers or {})}, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as failure:
        response = failure
    raw = response.read()
    return response.status, json.loads(raw) if raw else None, response.headers


def me(token=None, cookie=None, expected=200):
    headers = {}
    if token is not None:
        headers['Authorization'] = 'Bearer ' + token
    if cookie:
        headers['Cookie'] = 'jam_player=' + cookie
    status, body, response_headers = request(BASE + '/api/me', headers=headers)
    assert status == expected, (status, body)
    assert response_headers['Cache-Control'] == 'no-store'
    if expected != 200:
        assert not response_headers.get('Set-Cookie')
        return
    players.add(body['player_id'])
    jar = SimpleCookie(response_headers['Set-Cookie'])
    assert jar['jam_player']['httponly'] and jar['jam_player']['samesite'] == 'Lax'
    assert jar['jam_player']['path'] == '/' and int(jar['jam_player']['max-age']) > 0
    return body, jar['jam_player'].value


def signed(claims, secret=SECRET, algorithm='HS256'):
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=')
    data = encode({'alg': algorithm, 'typ': 'JWT'}) + b'.' + encode(claims)
    signature = hmac.new(secret.encode(), data, hashlib.sha256).digest()
    return (data + b'.' + base64.urlsafe_b64encode(signature).rstrip(b'=')).decode()


def signup(name):
    email = f'jam-test-{uuid.uuid4()}@example.com'
    password = 'Local-test-' + str(uuid.uuid4())
    status, body, _ = request(AUTH + '/auth/v1/signup',
                              {'email': email, 'password': password, 'data': {'username': name, 'role': 'admin'}},
                              {'apikey': ANON})
    assert status == 200, (status, body)
    users.append(body['user']['id'])
    assert body.get('access_token'), 'Local email confirmations must be disabled for this test'
    status, login, _ = request(AUTH + '/auth/v1/token?grant_type=password',
                               {'email': email, 'password': password}, {'apikey': ANON})
    assert status == 200 and login.get('access_token')
    return body['user']['id'], login['access_token']


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
        if players:
            db.execute('DELETE FROM players WHERE id = ANY(%s::uuid[])', (list(players),))
        for uid in users:
            status, _, _ = request(AUTH + '/auth/v1/admin/users/' + uid,
                                   headers={'apikey': SERVICE, 'Authorization': 'Bearer ' + SERVICE}, method='DELETE')
            if status != 200:
                raise RuntimeError('Could not clean up a test account')
