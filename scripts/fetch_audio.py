#!/usr/bin/env python3
"""Fetch the audio for one track into AUDIO_DIR and record audio_path.

    python scripts/fetch_audio.py <track_id>

The backend calls this when a track is first used in a quiz. Only tracks in
quizzes ever get downloaded; the catalog itself holds metadata only.
"""
import os, subprocess, sys
import psycopg
from dotenv import load_dotenv

load_dotenv()
tid = int(sys.argv[1])
out_dir = os.environ.get("AUDIO_DIR", "./data/audio")
os.makedirs(out_dir, exist_ok=True)

with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
    cur.execute("SELECT youtube_video_id, audio_path FROM tracks WHERE id=%s", (tid,))
    vid, existing = cur.fetchone()
    if existing and os.path.exists(os.path.join(out_dir, existing)):
        print(existing); sys.exit(0)
    if not vid:
        sys.exit(f"track {tid} has no youtube_video_id; run seed_music.py with youtube enabled")
    name = f"{tid}.m4a"
    subprocess.run(["yt-dlp", "-f", "bestaudio[ext=m4a]/bestaudio", "-o", os.path.join(out_dir, name),
                    f"https://www.youtube.com/watch?v={vid}"], check=True)
    cur.execute("UPDATE tracks SET audio_path=%s WHERE id=%s", (name, tid))
    print(name)
