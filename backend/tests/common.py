"""Shared fixtures for the local integration checks.

Both auth_integration.py and quiz_play.py talk to the running backend, the local
Supabase Auth server and Postgres directly. Nothing here touches a remote service:
the module refuses to load against anything but localhost.
"""
import base64
import hashlib
import hmac
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.cookies import SimpleCookie

BASE = os.environ.get('TEST_API_URL', 'http://127.0.0.1:8080')
AUTH = os.environ['SUPABASE_URL'].rstrip('/')
for _url in (BASE, AUTH, os.environ['DATABASE_URL']):
    if urllib.parse.urlparse(_url).hostname not in ('localhost', '127.0.0.1', '::1'):
        raise RuntimeError('This test only runs against local services')
ANON = os.environ['SUPABASE_ANON_KEY']
SERVICE = os.environ['SUPABASE_SERVICE_ROLE_KEY']
SECRET = os.environ['SUPABASE_JWT_SECRET']

# Everything the tests create, so the finally block can take it away again.
players, users = set(), []


def request(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers={'Content-Type': 'application/json', **(headers or {})}, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as failure:
        response = failure
    raw = response.read()
    return response.status, json.loads(raw) if raw else None, response.headers


def me(token=None, cookie=None, expected=200):
    """GET /api/me: hands out the jam_player passport and links it on sign-in."""
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
    """A real Supabase account. Returns (user id, access token)."""
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


def cleanup(db):
    """Remove only what these tests created."""
    if players:
        db.execute('DELETE FROM players WHERE id = ANY(%s::uuid[])', (list(players),))
    for uid in users:
        status, _, _ = request(AUTH + '/auth/v1/admin/users/' + uid,
                               headers={'apikey': SERVICE, 'Authorization': 'Bearer ' + SERVICE}, method='DELETE')
        if status != 200:
            raise RuntimeError('Could not clean up a test account')
