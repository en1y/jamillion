#!/usr/bin/env python3
"""Seed the music catalog.

    pip install -r scripts/requirements.txt
    python scripts/seed_music.py --limit 500            # full run, resumable
    python scripts/seed_music.py --limit 20 --no-youtube  # quick smoke run

Pipeline per artist:
  Last.fm chart.getTopArtists -> ranking (global_rank)
  Spotify   -> artist, every album/single, every track (popularity, isrc, duration)
  MusicBrainz -> artist mbid, type, country, begin/end year
  YouTube Music search -> video id per track; YouTube Data API -> view/like counts

Everything upserts on the platform ids, so re-running refreshes instead of duplicating.
"""
import argparse, os, re, sys, time
import psycopg
from dotenv import load_dotenv

load_dotenv()
DB = os.environ["DATABASE_URL"]

# ---------------------------------------------------------------- clients

def spotify():
    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials
    return spotipy.Spotify(auth_manager=SpotifyClientCredentials(), retries=5)

def musicbrainz():
    import musicbrainzngs as mb
    mb.set_useragent("jamillion-seed", "0.1", "https://github.com/en1y/jamillion")
    mb.set_rate_limit(1.0, 1)  # 1 req/s, their rule
    return mb

def ytmusic():
    from ytmusicapi import YTMusic
    return YTMusic()

# ---------------------------------------------------------------- helpers

def upsert(cur, table, key, row):
    """INSERT ... ON CONFLICT (key) DO UPDATE, returns id."""
    cols = list(row)
    sets = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols if c != key)
    cur.execute(
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('%s' for _ in cols)}) "
        f"ON CONFLICT ({key}) DO UPDATE SET {sets}, updated_at=now() RETURNING id",
        [row[c] for c in cols])
    return cur.fetchone()[0]

def parse_date(s, precision):
    if not s: return None
    return {"year": f"{s}-01-01", "month": f"{s}-01"}.get(precision, s)

def year(s):
    m = re.match(r"\d{4}", s or "")
    return int(m.group()) if m else None

# ---------------------------------------------------------------- steps

def top_artists(limit):
    """Last.fm chart.getTopArtists, 100 per page."""
    import requests
    names, page = [], 1
    while len(names) < limit:
        r = requests.get("https://ws.audioscrobbler.com/2.0/", timeout=30, params=dict(
            method="chart.gettopartists", api_key=os.environ["LASTFM_API_KEY"],
            format="json", limit=100, page=page)).json()
        batch = [a["name"] for a in r["artists"]["artist"]]
        if not batch: break
        names += batch
        page += 1
    return names[:limit]

def seed_artist(cur, sp, mb, name, rank):
    res = sp.search(q=f'artist:"{name}"', type="artist", limit=1)["artists"]["items"]
    if not res:
        print(f"  ! no spotify match for {name}"); return None
    a = res[0]
    row = dict(name=a["name"], spotify_id=a["id"], global_rank=rank,
               spotify_followers=a["followers"]["total"], spotify_popularity=a["popularity"],
               image_url=(a["images"] or [{}])[0].get("url"))
    try:
        m = mb.search_artists(artist=a["name"], limit=1)["artist-list"]
        if m and int(m[0].get("ext:score", 0)) >= 90:
            m = m[0]
            row.update(mbid=m["id"], sort_name=m.get("sort-name"), artist_type=m.get("type"),
                       country=m.get("country"),
                       begin_year=year(m.get("life-span", {}).get("begin")),
                       end_year=year(m.get("life-span", {}).get("end")))
    except Exception as e:
        print(f"  ! musicbrainz: {e}")
    aid = upsert(cur, "artists", "spotify_id", row)
    for g in a["genres"]:
        cur.execute("INSERT INTO genres(name) VALUES (%s) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id", (g,))
        cur.execute("INSERT INTO artist_genres VALUES (%s,%s) ON CONFLICT DO NOTHING", (aid, cur.fetchone()[0]))
    return aid, a["id"]

def seed_albums(cur, sp, aid, spotify_artist_id):
    """Every album + single, every track. Returns [(track_id, artist, title, spotify_track_id)]."""
    out = []
    albums = []
    page = sp.artist_albums(spotify_artist_id, include_groups="album,single", limit=50)
    while page:
        albums += page["items"]
        page = sp.next(page) if page["next"] else None
    seen = set()
    for al in albums:
        key = (al["name"].lower(), al["album_type"])
        if key in seen: continue  # same album re-released per market
        seen.add(key)
        full = sp.album(al["id"])
        album_id = upsert(cur, "albums", "spotify_id", dict(
            artist_id=aid, title=full["name"], spotify_id=full["id"], album_type=full["album_type"],
            release_date=parse_date(full["release_date"], full["release_date_precision"]),
            release_precision=full["release_date_precision"], total_tracks=full["total_tracks"],
            label=full.get("label"), cover_url=(full["images"] or [{}])[0].get("url")))
        tracks, page = [], full["tracks"]
        while page:
            tracks += page["items"]
            page = sp.next(page) if page["next"] else None
        for i in range(0, len(tracks), 50):  # sp.tracks gives popularity + isrc, 50 per call
            for t in sp.tracks([t["id"] for t in tracks[i:i+50]])["tracks"]:
                if not t: continue
                tid = upsert(cur, "tracks", "spotify_id", dict(
                    album_id=album_id, title=t["name"], spotify_id=t["id"],
                    isrc=t.get("external_ids", {}).get("isrc"),
                    disc_number=t["disc_number"], track_number=t["track_number"],
                    duration_ms=t["duration_ms"], explicit=t["explicit"],
                    release_date=parse_date(full["release_date"], full["release_date_precision"]),
                    spotify_popularity=t["popularity"]))
                for j, ta in enumerate(t["artists"]):
                    cur.execute("SELECT id FROM artists WHERE spotify_id=%s", (ta["id"],))
                    r = cur.fetchone()
                    if r:
                        cur.execute("INSERT INTO track_artists VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                                    (tid, r[0], "main" if j == 0 else "feature"))
                out.append((tid, t["artists"][0]["name"], t["name"]))
    return out

def seed_youtube(cur, yt, tracks, cap):
    """Video id via YouTube Music search, views via Data API (50 ids / request)."""
    import requests
    key = os.environ.get("YOUTUBE_API_KEY")
    # highest-popularity tracks first, cap per artist to keep the run sane
    cur.execute("SELECT id FROM tracks WHERE id = ANY(%s) AND youtube_video_id IS NULL ORDER BY spotify_popularity DESC NULLS LAST LIMIT %s",
                ([t[0] for t in tracks], cap))
    todo = {r[0] for r in cur.fetchall()}
    ids = {}
    for tid, artist, title in tracks:
        if tid not in todo: continue
        try:
            hit = yt.search(f"{artist} {title}", filter="songs", limit=1)
            if hit: ids[tid] = hit[0]["videoId"]
        except Exception as e:
            print(f"  ! ytmusic {title}: {e}")
    for tid, vid in ids.items():
        cur.execute("UPDATE tracks SET youtube_video_id=%s WHERE id=%s", (vid, tid))
    if not key: return
    vids = list(ids.items())
    for i in range(0, len(vids), 50):
        chunk = vids[i:i+50]
        r = requests.get("https://www.googleapis.com/youtube/v3/videos",
                         params=dict(part="statistics", id=",".join(v for _, v in chunk), key=key), timeout=30).json()
        stats = {it["id"]: it["statistics"] for it in r.get("items", [])}
        for tid, vid in chunk:
            s = stats.get(vid)
            if s:
                cur.execute("UPDATE tracks SET youtube_views=%s, youtube_likes=%s WHERE id=%s",
                            (s.get("viewCount"), s.get("likeCount"), tid))

# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--start", type=int, default=1, help="resume from this rank")
    ap.add_argument("--no-youtube", action="store_true")
    ap.add_argument("--youtube-cap", type=int, default=60, help="tracks per artist to look up on YouTube")
    ap.add_argument("--artists", nargs="*", help="seed just these names instead of the Last.fm chart")
    args = ap.parse_args()

    sp, mb = spotify(), musicbrainz()
    yt = None if args.no_youtube else ytmusic()
    names = args.artists or top_artists(args.limit)

    with psycopg.connect(DB) as conn, conn.cursor() as cur:
        for rank, name in enumerate(names, 1):
            if rank < args.start: continue
            print(f"[{rank}/{len(names)}] {name}")
            t0 = time.time()
            got = seed_artist(cur, sp, mb, name, rank)
            if not got: continue
            aid, sid = got
            tracks = seed_albums(cur, sp, aid, sid)
            if yt: seed_youtube(cur, yt, tracks, args.youtube_cap)
            conn.commit()  # per artist -> resumable with --start
            print(f"    {len(tracks)} tracks in {time.time()-t0:.0f}s")

if __name__ == "__main__":
    main()
