"""Hardening checks for v0.10.0: rate limits, input limits, no leaked errors.

Unlike the other four suites this one needs the limits ON. Run the backend with
its default caps (RATE_LIMIT unset or 'on') and then:
  .venv/bin/python backend/tests/hardening.py

It burns through /api/me's per-minute budget on purpose, so run it last, or wait
a minute before running anything else against the same backend.
"""
import os
import uuid

import psycopg

import common
from common import BASE, cleanup, request, signup


def api(path, data=None, token=None, method=None, headers=None):
    head = dict(headers or {})
    if token:
        head['Authorization'] = 'Bearer ' + token
    return request(BASE + path, data, head, method)


def main():
    db = psycopg.connect(os.environ['DATABASE_URL'], autocommit=True)
    try:
        # -------------------------------------------------- /api/health says only that it is up
        status, body, _ = api('/api/health')
        assert status == 200 and body['ok'], (status, body)
        assert 'error' not in body, 'health must never carry the database\'s own words'

        # -------------------------------------------------- the body cap
        # Well over MAX_BODY_BYTES, and unauthenticated: the parser refuses it
        # before any route or filter sees it.
        status, _, _ = api('/api/quizzes', {'date': '2030-01-01', 'pad': 'x' * 400_000})
        assert status in (413, 400), f'an oversized body must be refused, got {status}'

        # -------------------------------------------------- input caps
        # The first-signup-is-admin trigger already fired long ago, so the role
        # is set directly, the way admin.py does it.
        uid, token = signup('hardening-' + uuid.uuid4().hex[:8])
        db.execute("UPDATE profiles SET role = 'admin' WHERE id = %s", (uid,))

        status, body, _ = api('/api/users?q=' + 'a' * 300, token=token)
        assert status == 200, (status, body)   # truncated, not an error

        status, body, _ = api('/api/catalog', {
            'entity': 'tracks',
            'filters': [{'field': 'track.title', 'op': 'contains', 'value': 'a'}] * 20,
        }, token=token)
        assert status == 400 and 'filters' in body['error'], (status, body)

        status, body, _ = api('/api/catalog', {
            'entity': 'tracks',
            'sorts': [{'field': 'track.title', 'dir': 'asc'}] * 20,
        }, token=token)
        assert status == 400 and 'sorts' in body['error'], (status, body)

        status, body, _ = api('/api/catalog', {
            'entity': 'tracks',
            'filters': [{'field': 'track.title', 'op': 'contains', 'value': 'x' * 600}],
        }, token=token)
        assert status == 400 and 'too long' in body['error'], (status, body)

        tier = db.execute('SELECT id, name FROM rarity_tiers ORDER BY id LIMIT 1').fetchone()
        status, body, _ = api(f'/api/tiers/{tier[0]}', {'name': 'n' * 200}, token=token, method='PATCH')
        assert status == 400 and '40' in body['error'], (status, body)
        assert db.execute('SELECT name FROM rarity_tiers WHERE id = %s',
                          (tier[0],)).fetchone()[0] == tier[1], 'the refused name must not have landed'

        # -------------------------------------------------- the rate limit
        # Every cookieless /api/me INSERTs a players row, which is why it has the
        # tightest cap. Count the rows before and after to prove the limit is
        # what stopped it, not luck.
        before = db.execute('SELECT count(*) FROM players').fetchone()[0]
        throttled, minted = 0, 0
        for _ in range(40):
            status, body, headers = api('/api/me')
            if status == 429:
                throttled += 1
                assert body and body.get('error'), 'a throttle keeps the {"error": ...} shape'
            else:
                assert status == 200, (status, body)
                minted += 1
                common.players.add(body['player_id'])
        after = db.execute('SELECT count(*) FROM players').fetchone()[0]
        assert throttled > 0, 'forty calls to /api/me in a second must trip the limit'
        assert after - before == minted, (before, after, minted)
        print(f'  /api/me: {minted} served, {throttled} throttled, {after - before} rows created')

        print('PASS: health carries no database message, an oversized body is refused,'
              ' the search term, the filter and sort stacks, the filter value and the tier'
              ' name are all bounded, and /api/me stops minting player rows when it is'
              ' hammered -- with the throttle in the same shape as every other refusal')
    finally:
        cleanup(db)


main()
