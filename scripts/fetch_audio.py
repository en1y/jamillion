#!/usr/bin/env python3
"""Cache the official 30 s preview clip of one track into AUDIO_DIR and record audio_path.

    python scripts/fetch_audio.py <track_id>

Called by the backend when a track is first used in a quiz. The catalog holds
metadata only; only quiz tracks get a file on disk.
"""
import os, sys
import psycopg, requests
from dotenv import load_dotenv

load_dotenv()
tid = int(sys.argv[1])
out_dir = os.environ.get("AUDIO_DIR", "./data/audio")
os.makedirs(out_dir, exist_ok=True)

with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
    cur.execute("SELECT preview_url, audio_path FROM tracks WHERE id=%s", (tid,))
    url, existing = cur.fetchone()
    if existing and os.path.exists(os.path.join(out_dir, existing)):
        print(existing); sys.exit(0)
    if not url:
        sys.exit(f"track {tid} has no preview_url (no ISRC match on Deezer/iTunes); pick another track")
    name = f"{tid}.{'m4a' if 'itunes' in url or url.endswith('.m4a') else 'mp3'}"
    with open(os.path.join(out_dir, name), "wb") as f:
        f.write(requests.get(url, timeout=60).content)
    cur.execute("UPDATE tracks SET audio_path=%s WHERE id=%s", (name, tid))
    print(name)
