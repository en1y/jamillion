#!/usr/bin/env python3
"""Cache the official 30 s preview clip of one track into AUDIO_DIR.

    python scripts/fetch_audio.py <track_id>

The backend calls this when a track is first used in a quiz. Deezer preview URLs
carry an expiry token and go stale in about a day, so the stored URL is only a
hint: this always re-resolves from deezer_id (or ISRC via iTunes) before giving up.
The downloaded file itself never expires.
"""
import os, sys
import psycopg, requests
from dotenv import load_dotenv

load_dotenv()
tid = int(sys.argv[1])
out_dir = os.environ.get("AUDIO_DIR", "./data/audio")
os.makedirs(out_dir, exist_ok=True)


def download(url, path):
    r = requests.get(url, timeout=60)
    if not r.ok or len(r.content) < 10_000:      # an expired link returns a tiny error body
        return False
    with open(path, "wb") as f:
        f.write(r.content)
    return True


with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
    cur.execute("SELECT preview_url, audio_path, deezer_id, isrc, title FROM tracks WHERE id=%s", (tid,))
    row = cur.fetchone()
    if not row:
        sys.exit(f"no track {tid}")
    url, existing, dzid, isrc, title = row

    if existing and os.path.exists(os.path.join(out_dir, existing)):
        print(existing); sys.exit(0)

    name = f"{tid}.mp3"
    path = os.path.join(out_dir, name)

    ok = bool(url) and download(url, path)
    if not ok and dzid:                          # stored link expired, ask Deezer for a fresh one
        d = requests.get(f"https://api.deezer.com/track/{dzid}", timeout=25).json()
        if d.get("preview"):
            ok = download(d["preview"], path)
            if ok:
                cur.execute("UPDATE tracks SET preview_url=%s WHERE id=%s", (d["preview"], tid))
    if not ok and isrc:                          # last resort: iTunes, whose links do not expire
        it = requests.get("https://itunes.apple.com/lookup", params={"isrc": isrc}, timeout=25).json()
        r = (it.get("results") or [{}])[0]
        if r.get("previewUrl"):
            name = f"{tid}.m4a"
            path = os.path.join(out_dir, name)
            ok = download(r["previewUrl"], path)
            if ok:
                cur.execute("UPDATE tracks SET preview_url=%s, preview_source='itunes' WHERE id=%s",
                            (r["previewUrl"], tid))
    if not ok:
        sys.exit(f"no preview available for track {tid} ({title})")

    cur.execute("UPDATE tracks SET audio_path=%s WHERE id=%s", (name, tid))
    print(name)
