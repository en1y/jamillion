#!/usr/bin/env python3
"""Seed the music catalog.

    pip install -r scripts/requirements.txt
    python scripts/seed_music.py --limit 500              # full run, resumable
    python scripts/seed_music.py --artists Radiohead      # one artist, for testing

Sources, and why:
  Last.fm  chart.getTopArtists -> the global top-500 ranking
           artist.getInfo      -> listeners + playcount (a real listen count)
  Deezer   -> the catalog itself: artist fans, every album (upc, label, release date,
              fans, genres) and every track (rank, duration, explicit, 30 s preview).
              Open API, no key. Track detail adds ISRC, BPM, track position.
  MusicBrainz -> mbid, artist type, country, gender, active years, disambiguation
  Spotify  -> ids only. As of 2025 Spotify no longer serves popularity, followers,
              genres, top tracks or audio features to new apps, so it is a
              cross-reference, not a data source.
  YouTube  -> video id (YouTube Music search) + views, likes, publish date (Data API)

Only original studio recordings are kept: live versions, remixes, demos and acoustic
cuts are skipped, and remaster/deluxe duplicates collapse into one row per song.

Everything upserts on platform ids, so re-running refreshes instead of duplicating.
A failed artist is rolled back and the run continues; --start N resumes at rank N.
"""
import argparse, os, re, sys, time
import psycopg
import requests
from dotenv import load_dotenv

load_dotenv()
DB = os.environ["DATABASE_URL"]
HTTP = requests.Session()

# ---------------------------------------------------------------- http

_last = [0.0]

def deezer(path, **params):
    """Deezer allows 50 requests / 5 s per IP. Throttle to ~8/s and never raise."""
    gap = time.monotonic() - _last[0]
    if gap < 0.125: time.sleep(0.125 - gap)
    _last[0] = time.monotonic()
    try:
        r = HTTP.get(f"https://api.deezer.com/{path}", params=params, timeout=25)
        d = r.json()
    except Exception as e:
        print(f"  ! deezer {path}: {e}"); return {}
    if isinstance(d, dict) and d.get("error"):
        code = d["error"].get("code")
        if code in (4, 700):            # quota exceeded, back off and retry once
            time.sleep(5)
            return deezer(path, **params)
        return {}
    return d

def lastfm(method, **params):
    try:
        r = HTTP.get("https://ws.audioscrobbler.com/2.0/", timeout=30, params=dict(
            method=method, api_key=os.environ["LASTFM_API_KEY"], format="json", **params))
        return r.json() if r.ok else {}
    except Exception as e:
        print(f"  ! lastfm {method}: {e}"); return {}

def spotify():
    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials
    return spotipy.Spotify(auth_manager=SpotifyClientCredentials(), retries=3)

def musicbrainz():
    import musicbrainzngs as mb
    mb.set_useragent("jamillion-seed", "0.1", "https://github.com/en1y/jamillion")
    mb.set_rate_limit(1.0, 1)   # their rule: 1 req/s
    return mb

# ---------------------------------------------------------------- helpers

def upsert(cur, table, key, row):
    cols = list(row)
    sets = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols if c != key)
    cur.execute(
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('%s' for _ in cols)}) "
        f"ON CONFLICT ({key}) DO UPDATE SET {sets}, updated_at=now() RETURNING id",
        [row[c] for c in cols])
    return cur.fetchone()[0]

def year(s):
    m = re.match(r"\d{4}", s or "")
    return int(m.group()) if m else None

def date_or_none(s):
    return s if s and not s.startswith("0000") else None

# ponytail: title-suffix regex, no audio fingerprinting. Version info lives after
# " - " or inside brackets ("Creep - Live", "Creep (Acoustic)"), so only that part
# is tested; a song genuinely called "Live Forever" survives.
VERSION_WORDS = re.compile(r"\b(live|remix|remixes|acoustic|unplugged|demo|instrumental|karaoke|"
                           r"edit|mix|version|sped up|slowed|reprise|rehearsal|session|commentary|"
                           r"a cappella|acapella|dub|extended|orchestral|mono|stereo|remaster\w*)\b", re.I)
SUFFIX = re.compile(r"\s+-\s+(.*)$|[(\[]([^)\]]*)[)\]]")

def is_original(title, version=None):
    if version and VERSION_WORDS.search(version): return False   # Deezer's title_version field
    if re.search(r"\blive (at|in|from|on)\b", title, re.I): return False
    return not any(VERSION_WORDS.search(p) for m in SUFFIX.finditer(title) for p in m.groups() if p)

def norm_title(t):
    """'Creep - Remastered 2009' -> 'creep'. Also what the game matches answers against."""
    t = re.sub(r"\s+-\s+.*$|\s*[(\[].*$", "", t)
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()

# ---------------------------------------------------------------- steps

def top_artists(limit):
    """The 500 biggest artists, largest first.

    chart.getTopArtists is Last.fm's *trending* chart, ordered by recent listening,
    not by size: it puts Ariana Grande (4.7 M listeners) above Radiohead (8.4 M).
    So take the chart as the candidate set and re-sort it by listener count, which
    is what "top 500" should mean and what global_rank now stores.
    """
    rows, page = [], 1
    while len(rows) < limit:
        r = lastfm("chart.gettopartists", limit=100, page=page)
        batch = r.get("artists", {}).get("artist", [])
        if not batch: break
        rows += [(a["name"], int(a.get("listeners") or 0)) for a in batch]
        page += 1
    rows.sort(key=lambda nl: -nl[1])
    return [name for name, _ in rows[:limit]]

def seed_artist(cur, sp, mb, name, rank):
    hits = deezer("search/artist", q=name, limit=10).get("data") or []
    # tribute and cover acts share the exact name, so among exact matches take the
    # one with the most fans; that is the real artist by a wide margin
    exact = [h for h in hits if h["name"].lower() == name.lower()]
    d = max(exact or hits, key=lambda h: h.get("nb_fan") or 0, default=None)
    if not d:
        print(f"  ! not on deezer: {name}"); return None

    row = dict(name=d["name"], deezer_id=d["id"], deezer_fans=d.get("nb_fan"),
               image_url=d.get("picture_xl"))
    # rank comes from the chart position; --artists runs have no chart, so leave
    # whatever rank the artist already had rather than overwriting it with 1, 2, 3...
    if rank is not None:
        row["global_rank"] = rank

    st = lastfm("artist.getinfo", artist=d["name"]).get("artist", {}).get("stats", {})
    if st:
        row.update(lastfm_listeners=int(st.get("listeners") or 0),
                   lastfm_playcount=int(st.get("playcount") or 0))
    try:
        m = mb.search_artists(artist=d["name"], limit=1)["artist-list"]
        if m and int(m[0].get("ext:score", 0)) >= 90:
            m = m[0]
            row.update(mbid=m["id"], sort_name=m.get("sort-name"), artist_type=m.get("type"),
                       country=m.get("country"), gender=m.get("gender"),
                       disambiguation=m.get("disambiguation") or None,
                       begin_year=year(m.get("life-span", {}).get("begin")),
                       end_year=year(m.get("life-span", {}).get("end")))
    except Exception as e:
        print(f"  ! musicbrainz {name}: {e}")
    if sp:
        try:
            r = sp.search(q=f'artist:"{d["name"]}"', type="artist", limit=1)["artists"]["items"]
            if r: row["spotify_id"] = r[0]["id"]
        except Exception as e:
            print(f"  ! spotify {name}: {e}")
    return upsert(cur, "artists", "deezer_id", row), d["id"]

def artist_albums(deezer_artist_id):
    out, url = [], f"artist/{deezer_artist_id}/albums"
    params = {"limit": 100}
    while url:
        page = deezer(url, **params)
        out += page.get("data", [])
        nxt = page.get("next")
        if not nxt: break
        url, params = nxt.split("api.deezer.com/", 1)[1].split("?")[0], \
                      dict(p.split("=") for p in nxt.split("?", 1)[1].split("&"))
    return out

def seed_albums(cur, aid, deezer_artist_id, detail_cap):
    """Deezer albums + embedded tracklists. -> [(track_id, artist, title, deezer_track_id)]"""
    out, seen, seen_titles = [], set(), set()
    albums = artist_albums(deezer_artist_id)
    # studio albums before singles, oldest first, plain title before "(Bonus Edition)" /
    # "Meteora: ..." variants of the same day, so the original release wins the dedupe
    albums.sort(key=lambda a: (a.get("record_type") != "album", a.get("release_date") or "",
                               bool(SUFFIX.search(a["title"])) or ":" in a["title"]))
    for al in albums:
        key = al["title"].lower()
        if key in seen or not is_original(al["title"]): continue
        if al.get("record_type") in ("compilation",): continue
        seen.add(key)
        full = deezer(f"album/{al['id']}")
        if not full: continue

        album_id = upsert(cur, "albums", "deezer_id", dict(
            artist_id=aid, title=full["title"], deezer_id=full["id"],
            album_type=full.get("record_type"), release_date=date_or_none(full.get("release_date")),
            release_precision="day", total_tracks=full.get("nb_tracks"), label=full.get("label"),
            upc=full.get("upc"), deezer_fans=full.get("fans"), duration_sec=full.get("duration"),
            cover_url=full.get("cover_xl")))

        for g in (full.get("genres") or {}).get("data", []):
            cur.execute("INSERT INTO genres(name) VALUES (%s) ON CONFLICT (name) "
                        "DO UPDATE SET name=EXCLUDED.name RETURNING id", (g["name"],))
            cur.execute("INSERT INTO artist_genres VALUES (%s,%s) ON CONFLICT DO NOTHING",
                        (aid, cur.fetchone()[0]))

        for pos, t in enumerate((full.get("tracks") or {}).get("data", []), 1):
            if not is_original(t["title"], t.get("title_version")): continue
            nt = norm_title(t["title"])
            if nt in seen_titles: continue      # remaster / deluxe duplicate
            seen_titles.add(nt)
            tid = upsert(cur, "tracks", "deezer_id", dict(
                album_id=album_id, title=t["title"], norm_title=nt, deezer_id=t["id"],
                deezer_rank=t.get("rank"), duration_ms=(t.get("duration") or 0) * 1000,
                explicit=t.get("explicit_lyrics"), track_number=pos,
                release_date=date_or_none(full.get("release_date")),
                preview_url=t.get("preview"), preview_source="deezer" if t.get("preview") else None))
            cur.execute("INSERT INTO track_artists VALUES (%s,%s,'main') ON CONFLICT DO NOTHING", (tid, aid))
            out.append((tid, full["artist"]["name"], t["title"], t["id"]))

    # ISRC / BPM / disc number need a per-track call, so only the most popular get it
    if detail_cap:
        cur.execute("SELECT id, deezer_id FROM tracks WHERE id = ANY(%s) AND isrc IS NULL "
                    "ORDER BY deezer_rank DESC NULLS LAST LIMIT %s", ([t[0] for t in out], detail_cap))
        for tid, dzid in cur.fetchall():
            d = deezer(f"track/{dzid}")
            if not d: continue
            cur.execute("UPDATE tracks SET isrc=%s, bpm=%s, gain=%s, disc_number=%s, "
                        "release_date=least(%s, release_date) WHERE id=%s",  # per-track date is often a re-release; least() skips NULL
                        (d.get("isrc"), d.get("bpm") or None, d.get("gain"), d.get("disk_number"),
                         date_or_none(d.get("release_date")), tid))
    # live sets, a cappella and anniversary editions survive the title filter but
    # contribute no tracks once dedupe has run; drop the empty shells
    cur.execute("DELETE FROM albums WHERE artist_id=%s AND NOT EXISTS "
                "(SELECT 1 FROM tracks WHERE album_id=albums.id)", (aid,))
    return out

def pick(cur, tracks, column, cap):
    if not tracks or not cap: return []
    cur.execute(f"SELECT id FROM tracks WHERE id = ANY(%s) AND {column} IS NULL "
                f"ORDER BY deezer_rank DESC NULLS LAST LIMIT %s", ([t[0] for t in tracks], cap))
    keep = {r[0] for r in cur.fetchall()}
    return [t for t in tracks if t[0] in keep]

def seed_youtube(cur, yt, tracks, cap):
    ids, misses = {}, 0
    for tid, artist, title, _ in pick(cur, tracks, "youtube_video_id", cap):
        try:
            hit = yt.search(f"{artist} {title}", filter="songs", limit=1)
            if hit: ids[tid] = hit[0]["videoId"]
        except Exception as e:
            misses += 1
            if misses in (1, 10):      # say it once, then once more if it keeps up
                print(f"  ! ytmusic {title}: {e}")
            if misses > 20:            # clearly throttled; give up on this artist
                print("\n  ! ytmusic throttling, skipping youtube for this artist")
                break
            time.sleep(min(2 * misses, 10))
    for tid, vid in ids.items():
        cur.execute("UPDATE tracks SET youtube_video_id=%s WHERE id=%s", (vid, tid))

    key = os.environ.get("YOUTUBE_API_KEY")
    if not key: return
    vids = list(ids.items())
    for i in range(0, len(vids), 50):
        chunk = vids[i:i+50]
        try:
            r = HTTP.get("https://www.googleapis.com/youtube/v3/videos", timeout=30, params=dict(
                part="statistics,snippet", id=",".join(v for _, v in chunk), key=key)).json()
        except Exception as e:
            print(f"  ! youtube api: {e}"); continue
        info = {it["id"]: it for it in r.get("items", [])}
        for tid, vid in chunk:
            it = info.get(vid)
            if not it: continue
            s = it.get("statistics", {})
            cur.execute("UPDATE tracks SET youtube_views=%s, youtube_likes=%s, youtube_published_at=%s WHERE id=%s",
                        (s.get("viewCount"), s.get("likeCount"),
                         (it.get("snippet", {}).get("publishedAt") or "")[:10] or None, tid))

def seed_lastfm_tracks(cur, tracks, cap):
    for tid, artist, title, _ in pick(cur, tracks, "lastfm_playcount", cap):
        t = lastfm("track.getinfo", artist=artist, track=title).get("track", {})
        if t:
            cur.execute("UPDATE tracks SET lastfm_listeners=%s, lastfm_playcount=%s WHERE id=%s",
                        (t.get("listeners"), t.get("playcount"), tid))

# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--start", type=int, default=1, help="resume from this rank")
    ap.add_argument("--artists", nargs="*", help="seed these names instead of the Last.fm chart")
    ap.add_argument("--no-youtube", action="store_true")
    ap.add_argument("--no-spotify", action="store_true")
    ap.add_argument("--detail-cap", type=int, default=120, help="tracks per artist to fetch ISRC/BPM for")
    ap.add_argument("--youtube-cap", type=int, default=30, help="tracks per artist to look up on YouTube")
    ap.add_argument("--lastfm-cap", type=int, default=30, help="tracks per artist to fetch Last.fm listens for")
    args = ap.parse_args()

    mb = musicbrainz()
    sp = None if args.no_spotify else spotify()
    yt = None
    if not args.no_youtube:
        from ytmusicapi import YTMusic
        yt = YTMusic()

    names = args.artists or top_artists(args.limit)
    ranked = not args.artists      # only a chart run knows the global ranking
    print(f"seeding {len(names)} artists" + (f" from rank {args.start}" if ranked else " (rank left unchanged)"), flush=True)

    with psycopg.connect(DB) as conn, conn.cursor() as cur:
        for rank, name in enumerate(names, 1):
            if rank < args.start: continue
            t0 = time.time()
            print(f"[{rank}/{len(names)}] {name}", flush=True)
            try:
                got = seed_artist(cur, sp, mb, name, rank if ranked else None)
                if not got:
                    conn.commit(); continue
                aid, dzid = got
                tracks = seed_albums(cur, aid, dzid, args.detail_cap)
                if yt: seed_youtube(cur, yt, tracks, args.youtube_cap)
                seed_lastfm_tracks(cur, tracks, args.lastfm_cap)
                conn.commit()          # per artist, so --start resumes cleanly
                print(f"      {len(tracks)} tracks in {time.time()-t0:.0f}s", flush=True)
            except Exception as e:
                conn.rollback()        # an aborted tx would poison every later artist
                print(f"      FAILED {type(e).__name__}: {e}", flush=True)

if __name__ == "__main__":
    main()
