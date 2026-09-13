"""First boot of the compose stack: generate its secrets, once.

The catalog keys are not here: those are entered on the setup page and kept by
the backend in its own `config` volume (backend/src/setup.cc).

Runs as a one-shot before the database. Everything lands in the `secrets` volume:
  env               JWT_SECRET and DB_PASSWORD, sourced by the containers' entrypoints
  jwt_secret        read by PostgREST as @/secrets/jwt_secret (its image has no shell)
  rest_db_uri       likewise
  public/config.js  the anon key, served by Caddy to the browser

The anon key is public by design -- every browser gets it -- so it is the only
file Caddy can see. There is no service-role key: nothing in the app uses one.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time

OUT = '/secrets'


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def sign(claims, key):
    body = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode()) + '.' + b64(json.dumps(claims).encode())
    return body + '.' + b64(hmac.new(key.encode(), body.encode(), hashlib.sha256).digest())


if os.path.exists(f'{OUT}/env'):
    print('setup: secrets already generated, reusing them')
    raise SystemExit

jwt_secret = secrets.token_hex(32)
db_password = secrets.token_hex(24)
now = int(time.time())
anon = sign({'role': 'anon', 'iss': 'supabase', 'iat': now, 'exp': now + 10 * 365 * 86400}, jwt_secret)

os.makedirs(f'{OUT}/public', exist_ok=True)
files = {
    'jwt_secret': jwt_secret,
    'rest_db_uri': f'postgresql://authenticator:{db_password}@db:5432/postgres',
    'public/config.js': f'window.JAM = {{ anonKey: "{anon}" }}\n',
    # Last on purpose: its existence is what says the rest were written.
    'env': f'JWT_SECRET={jwt_secret}\nDB_PASSWORD={db_password}\n',
}
for name, text in files.items():
    with open(f'{OUT}/{name}', 'w') as f:
        f.write(text)
print('setup: generated a JWT secret, a database password and an anon key into the secrets volume')
