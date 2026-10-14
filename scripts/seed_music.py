#!/usr/bin/env python3
"""Seed the music catalog.

    pip install -r scripts/requirements.txt
    python scripts/seed_music.py --limit 500                      # Last.fm chart, resumable
    python scripts/seed_music.py --source wikidata --limit 30000  # everyone Wikidata links to Deezer
    python scripts/seed_music.py --artists Radiohead              # one artist, for testing

Sources, and why:
  Wikidata -> the big candidate list: every item with a Deezer artist id (P2722), with
           its MusicBrainz and Spotify ids, country, kind, gender, years and English
           aliases in one paged SPARQL query, so no source is searched by name.
  Last.fm  chart.getTopArtists -> the global top-500 ranking (--source lastfm, the default)
           artist.getInfo      -> listeners + playcount (a real listen count)
  Deezer   -> the catalog itself: artist fans, every album (upc, label, release date,
              fans, genres) and every track (rank, duration, explicit, 30 s preview).
              Genres are tagged per album; the artist gets the union, a track its album's.
              Open API, no key. Track detail adds ISRC, BPM, track position.
  MusicBrainz -> mbid, artist type, country, gender, active years, disambiguation,
              only for names Wikidata did not supply
  Spotify  -> ids only. As of 2025 Spotify no longer serves popularity, followers,
              genres, top tracks or audio features to new apps, so it is a
              cross-reference, not a data source.
  YouTube Music -> the song play count and video id the app shows for every track
              on the artist's albums and singles, plus the artist's monthly listeners
              (ytmusicapi, unofficial, paced). YouTube Data API -> exact views, likes
              and publish date for those videos, if YOUTUBE_API_KEY is set.

Two depths. The top --full artists (by rank) get the full pipeline above; everyone
else is skinny: Deezer's artist page and top 50 tracks, two requests, nothing else.
artists.depth remembers which, and a later run with a larger --full promotes the
skinny ones without touching those already full.

Each source runs in its own thread fed from a queue, so their rate limits overlap
instead of adding up; one writer thread commits an artist at a time, in rank order,
so --start N still resumes at rank N.

Only original studio recordings are kept: live versions, remixes, demos and acoustic
cuts are skipped, and remaster/deluxe duplicates collapse into one row per song.

Everything upserts on platform ids, so re-running refreshes instead of duplicating.
A failed artist is rolled back and the run continues.
"""
import argparse, heapq, html, json, os, queue, re, sys, threading, time, unicodedata
from collections import defaultdict
import psycopg
import requests
from dotenv import load_dotenv

load_dotenv()
DB = os.environ["DATABASE_URL"]
HTTP = requests.Session()
# Deezer localises genre names to whoever is asking ("Alternativna glazba"), and
# the catalog is English. The ids are the same either way, but the names are what
# a moderator reads.
HTTP.headers["Accept-Language"] = "en"
HTTP.headers["User-Agent"] = "jamillion-seed/0.2 (https://github.com/en1y/jamillion)"

# ---------------------------------------------------------------- http

class Pace:
    """At most one request every `gap` seconds, whichever thread asks."""
    def __init__(self, gap): self.gap, self.last, self.lock = gap, 0.0, threading.Lock()
    def wait(self):
        with self.lock:
            now = time.monotonic()
            if now - self.last < self.gap: time.sleep(self.last + self.gap - now)
            self.last = time.monotonic()

DEEZER_PACE = Pace(0.125)    # Deezer allows 50 requests / 5 s per IP: ~8/s, one thread
LASTFM_PACE = Pace(0.2)      # Last.fm asks for 5/s on average
YTM_PACE = Pace(0.8)

def deezer(path, **params):
    """Throttled, never raises: {} on any failure."""
    DEEZER_PACE.wait()
    try:
        r = HTTP.get(f"https://api.deezer.com/{path}", params=params, timeout=25)
        d = r.json()
    except Exception as e:
        print(f"  ! deezer {path}: {e}", flush=True); return {}
    if isinstance(d, dict) and d.get("error"):
        code = d["error"].get("code")
        if code in (4, 700):            # quota exceeded, back off and retry once
            time.sleep(5)
            return deezer(path, **params)
        return {}
    return d

def lastfm(method, **params):
    key = os.environ.get("LASTFM_API_KEY")
    if not key: return {}
    LASTFM_PACE.wait()
    try:
        r = HTTP.get("https://ws.audioscrobbler.com/2.0/", timeout=30, params=dict(
            method=method, api_key=key, format="json", **params))
        return r.json() if r.ok else {}
    except Exception as e:
        print(f"  ! lastfm {method}: {type(e).__name__}", flush=True); return {}   # the URL in e carries the key

def spotify():
    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials
    return spotipy.Spotify(auth_manager=SpotifyClientCredentials(), retries=3)

def musicbrainz():
    import musicbrainzngs as mb
    mb.set_useragent("jamillion-seed", "0.2", "https://github.com/en1y/jamillion")
    mb.set_rate_limit(1.0, 1)   # their rule: 1 req/s
    return mb

# ---------------------------------------------------------------- wikidata

WIKIDATA = "https://query.wikidata.org/sparql"
# One page of items with a Deezer artist id, everything else OPTIONAL and SAMPLEd,
# so an artist with three citizenships is still one row. ~40 s per 5000.
SPARQL = """
SELECT ?item ?dz ?label (SAMPLE(?mbid) AS ?mbid) (SAMPLE(?sp) AS ?sp) (SAMPLE(?cc) AS ?cc)
       (SAMPLE(?kind) AS ?kind) (SAMPLE(?sex) AS ?sex) (SAMPLE(?start) AS ?start) (SAMPLE(?end) AS ?end)
       (GROUP_CONCAT(DISTINCT ?alias; separator="|") AS ?aliases) WHERE {
  { SELECT ?item ?dz WHERE { ?item wdt:P2722 ?dz } ORDER BY ?item LIMIT %d OFFSET %d }
  OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label)="en") }
  OPTIONAL { ?item wdt:P434 ?mbid }
  OPTIONAL { ?item wdt:P1902 ?sp }
  OPTIONAL { ?item wdt:P31 ?kind }
  OPTIONAL { ?item wdt:P21 ?sex }
  OPTIONAL { ?item wdt:P27 ?c1 . ?c1 wdt:P297 ?cc1 }
  OPTIONAL { ?item wdt:P495 ?c2 . ?c2 wdt:P297 ?cc2 }
  BIND(COALESCE(?cc1, ?cc2) AS ?cc)
  OPTIONAL { ?item wdt:P2031 ?began } OPTIONAL { ?item wdt:P569 ?born } OPTIONAL { ?item wdt:P571 ?formed }
  BIND(YEAR(COALESCE(?began, ?born, ?formed)) AS ?start)
  OPTIONAL { ?item wdt:P2032 ?ended } OPTIONAL { ?item wdt:P570 ?died } OPTIONAL { ?item wdt:P576 ?dissolved }
  BIND(YEAR(COALESCE(?ended, ?died, ?dissolved)) AS ?end)
  OPTIONAL { ?item skos:altLabel ?alias FILTER(LANG(?alias)="en") }
} GROUP BY ?item ?dz ?label
"""
WD_GENDER = {"Q6581097": "male", "Q6581072": "female", "Q48270": "non-binary"}

def wikidata_row(b):
    """One SPARQL binding -> candidate, or None when the Deezer id is not a number."""
    # some imported labels arrive as "Simone &amp; Simaria": entities are undone here
    v = lambda k: html.unescape((b.get(k) or {}).get("value") or "") or None
    q = lambda k: (v(k) or "").rsplit("/", 1)[-1]         # entity URI -> Q-id
    dz = v("dz")
    if not dz or not dz.isdigit(): return None
    aliases = {a.strip() for a in (v("aliases") or "").split("|") if a.strip()}
    return dict(deezer_id=int(dz), name=v("label"), mbid=v("mbid"), spotify_id=v("sp"), country=v("cc"),
                # ponytail: human or not; every other P31 (band, duo, orchestra) reads Group
                artist_type=("Person" if q("kind") == "Q5" else "Group") if v("kind") else None,
                gender=WD_GENDER.get(q("sex")),
                begin_year=int(v("start")) if v("start") else None,
                end_year=int(v("end")) if v("end") else None, aliases=sorted(aliases))

def wikidata_candidates(cache, refresh=False, page=5000, report=lambda n: None):
    """Every candidate, kept in `cache` (seven 40 s pages otherwise, every run)."""
    if not refresh:
        try: return json.load(open(cache))
        except (OSError, ValueError): pass
    out, offset = {}, 0
    while True:
        for attempt in range(6):
            r = HTTP.get(WIKIDATA, timeout=180, params=dict(query=SPARQL % (page, offset), format="json"))
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(int(r.headers.get("Retry-After") or 15) * (attempt + 1)); continue
            r.raise_for_status(); break
        else:
            raise RuntimeError(f"wikidata keeps answering {r.status_code}")
        rows = r.json()["results"]["bindings"]
        for b in rows:
            c = wikidata_row(b)
            if c and c["deezer_id"] not in out: out[c["deezer_id"]] = c
        print(f"  wikidata: {len(out)} artists so far", flush=True)
        report(len(out))
        if len(rows) < page: break
        offset += page
    os.makedirs(os.path.dirname(cache) or ".", exist_ok=True)
    json.dump(list(out.values()), open(cache, "w"))
    return list(out.values())

def rank_by_fans(cands, cache, refresh=False, report=lambda i, n: None):
    """Deezer's artist page for every candidate -- the fans to rank by, and the name
    and picture the catalog stores. One request each, kept in `cache` so a rerun
    pays only for new ids; ids Deezer no longer knows are dropped."""
    try: known = json.load(open(cache))
    except (OSError, ValueError): known = {}
    if refresh: known = {k: v for k, v in known.items() if v}      # give the ids Deezer refused another go
    todo = [c for c in cands if str(c["deezer_id"]) not in known]
    if todo: print(f"  deezer: {len(todo)} artist pages to rank by fans, ~{len(todo) / 8 / 60:.0f} min", flush=True)
    for i, c in enumerate(todo, 1):
        d = deezer(f"artist/{c['deezer_id']}")
        # an id Deezer no longer knows is cached as None, so it is not asked for again
        known[str(c["deezer_id"])] = {k: d.get(k) for k in ("name", "nb_fan", "picture_xl")} if d.get("id") else None
        if i % 100 == 0 or i == len(todo): report(i, len(todo))
        if i % 1000 == 0 or i == len(todo):
            print(f"  deezer: {i}/{len(todo)}", flush=True)
            os.makedirs(os.path.dirname(cache) or ".", exist_ok=True)
            json.dump(known, open(cache, "w"))
    out = [{**c, "deezer": known[str(c["deezer_id"])]} for c in cands if known.get(str(c["deezer_id"]))]
    out.sort(key=lambda c: -(c["deezer"]["nb_fan"] or 0))
    return out

# ---------------------------------------------------------------- helpers

def upsert_sql(table, key, cols):
    sets = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols if c != key)
    return (f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('%s' for _ in cols)}) "
            f"ON CONFLICT ({key}) DO UPDATE SET {sets}, updated_at=now()")

def upsert(cur, table, key, row):
    cols = list(row)
    cur.execute(upsert_sql(table, key, cols) + " RETURNING id", [row[c] for c in cols])
    return cur.fetchone()[0]

def upsert_many(cur, table, key, rows):
    """Same statement, one executemany; every row must carry the same columns."""
    if not rows: return
    cols = list(rows[0])
    cur.executemany(upsert_sql(table, key, cols), [[r[c] for c in cols] for r in rows])

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

def is_original(title, version=None, remaster_ok=False):
    if remaster_ok and version: version = re.sub(r"remaster\w*", "", version, flags=re.I)
    if version and VERSION_WORDS.search(version): return False   # Deezer's title_version field
    if re.search(r"\blive (at|in|from|on)\b", title, re.I): return False
    parts = [p for m in SUFFIX.finditer(title) for p in m.groups() if p]
    # YouTube Music often carries only the remastered edition of an old record, and
    # "Serve The Servants (2023 Remaster)" is the same song; the catalog side keeps
    # the default, where the plain Deezer title always exists and wins the dedupe
    if remaster_ok: parts = [re.sub(r"remaster\w*", "", p, flags=re.I) for p in parts]
    return not any(VERSION_WORDS.search(p) for p in parts)

def norm_title(t):
    """'Creep - Remastered 2009' -> 'creep'. Also what the game matches answers against."""
    t = re.sub(r"\s+-\s+.*$|\s*[(\[].*$", "", t)
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()

def same_name(a, b):
    """'Tyler, The Creator' == 'tyler the creator', 'JAŸ-Z' == 'JAY Z'. Punctuation, case and accents only."""
    fold = lambda n: unicodedata.normalize("NFKD", n or "").encode("ascii", "ignore").decode().lower()
    strip = lambda n: re.sub(r"[^a-z0-9]+", "", fold(n))
    return bool(strip(a)) and strip(a) == strip(b)

def depth_for(rank, full):
    """Named (--artists) runs are always full; a chart rank is full inside the top --full."""
    return "full" if rank is None or rank <= full else "skinny"

# Worker threads read the DB to skip what is already filled; each gets its own
# autocommit connection, the writer thread the only one that commits.
_local = threading.local()

def db():
    if not hasattr(_local, "conn"): _local.conn = psycopg.connect(DB, autocommit=True)
    return _local.conn

def have(column, deezer_track_ids):
    """Which of these tracks already carry `column`, so a rerun only fetches the gaps."""
    if not deezer_track_ids: return set()
    with db().cursor() as cur:
        cur.execute(f"SELECT deezer_id FROM tracks WHERE deezer_id = ANY(%s) AND {column} IS NOT NULL",
                    (deezer_track_ids,))
        return {r[0] for r in cur.fetchall()}

def pick(job, column, cap):
    """The most popular `cap` tracks of the job that still lack `column`."""
    if not cap: return []
    done = have(column, [t["deezer_id"] for t in job.tracks])
    want = [t for t in job.tracks if t["deezer_id"] not in done]
    want.sort(key=lambda t: -(t["deezer_rank"] or 0))
    return want[:cap]

# ---------------------------------------------------------------- failures

def note_failure(conn, name, reason):
    """Kept in the DB, not in the progress file: a failure has to still be there
    next week, when someone opens the catalog dashboard to aim a rerun at it."""
    try:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO catalog_failures (name, reason) VALUES (%s, %s) "
                        "ON CONFLICT (name) DO UPDATE SET reason = EXCLUDED.reason, "
                        "attempts = catalog_failures.attempts + 1, last_try = now()",
                        (name[:120], reason[:400]))
        conn.commit()
    except Exception as e:      # a dead connection must not end a run three hours in
        conn.rollback()
        print(f"  ! could not record the failure of {name}: {e}", flush=True)

def clear_failure(cur, name):
    cur.execute("DELETE FROM catalog_failures WHERE lower(name) = lower(%s)", (name,))

# ---------------------------------------------------------------- the job

class Job:
    """One artist on its way through the stages: rows pile up here, the writer
    stores them in one transaction. Tracks and albums are keyed by Deezer id, so
    no stage needs a database id before the write."""
    def __init__(self, cand, order, rank, depth):
        self.cand, self.order, self.rank, self.depth = cand, order, rank, depth
        self.name = cand.get("name") or (cand.get("deezer") or {}).get("name") or f"deezer:{cand.get('deezer_id')}"
        self.artist = {}                    # the artists row
        self.albums = {}                    # deezer album id -> row
        self.tracks = []                    # rows, album_deezer_id in place of album_id
        self.genres = {}                    # deezer genre id -> name
        self.album_genres = set()           # (album deezer id, genre deezer id)
        self.sql = defaultdict(list)        # UPDATE statement -> parameter rows
        self.error = None
        self.t0 = time.time()
        self.pending, self.lock = 0, threading.Lock()

    def stage_done(self):
        with self.lock:
            self.pending -= 1
            return self.pending == 0

DETAIL_SQL = ("UPDATE tracks SET isrc=%s, bpm=%s, gain=%s, disc_number=%s, release_date=least(%s, release_date) "
              "WHERE deezer_id=%s")     # per-track date is often a re-release; least() skips NULL
LASTFM_SQL = "UPDATE tracks SET lastfm_listeners=%s, lastfm_playcount=%s WHERE deezer_id=%s"
YTM_SQL = "UPDATE tracks SET ytmusic_plays=%s, youtube_video_id=%s WHERE deezer_id=%s"
VIEWS_SQL = "UPDATE tracks SET youtube_views=%s, youtube_likes=%s, youtube_published_at=%s WHERE deezer_id=%s"

# ---------------------------------------------------------------- deezer stage

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

def find_artist(name):
    """search/artist, only for names without a Deezer id (--artists, the Last.fm chart)."""
    hits = deezer("search/artist", q=name, limit=10).get("data") or []
    # tribute and cover acts share the exact name, so among exact matches take the
    # one with the most fans; that is the real artist by a wide margin. Accents and
    # punctuation do not count: Deezer's real entry is "Ludwig Goransson" and "JAY Z",
    # and the accented spelling is a zero-fan stub with no albums
    exact = [h for h in hits if same_name(h["name"], name)]
    return max(exact or hits, key=lambda h: h.get("nb_fan") or 0, default=None)

WD_FIELDS = ("mbid", "spotify_id", "country", "artist_type", "gender", "begin_year", "end_year")

def seed_deezer(job, detail_cap):
    c = job.cand
    d = c.get("deezer")
    if not d and c.get("deezer_id"): d = deezer(f"artist/{c['deezer_id']}")
    if not d: d = find_artist(c["name"])
    if not d or not (d.get("id") or c.get("deezer_id")): raise RuntimeError("no Deezer artist found")
    # Deezer spells it its own way ("JAY-Z" for "JAŸ-Z", "che" for "Che"), and that
    # spelling is what the catalog stores: say so, or the artist looks missing.
    if c.get("name") and d["name"].casefold() != c["name"].casefold():
        print(f"      {c['name']} stored as {d['name']}", flush=True)
    dzid = d.get("id") or c["deezer_id"]
    job.artist = dict(name=d["name"], deezer_id=dzid, deezer_fans=d.get("nb_fan"),
                      image_url=d.get("picture_xl"), depth=job.depth)
    job.artist.update({k: c[k] for k in WD_FIELDS if c.get(k) is not None})
    # rank comes from the chart position; --artists runs have no chart, so leave
    # whatever rank the artist already had rather than overwriting it with 1, 2, 3...
    if job.rank is not None: job.artist["global_rank"] = job.rank
    if job.depth == "full": full_albums(job, dzid, detail_cap)
    else: top_tracks(job, dzid)
    # Tally Hall, Peter, Paul and Mary: Deezer lists no albums under the artist (nb_album 0)
    # yet serves a top list, whose entries carry their album stubs
    if not job.tracks and job.depth == "full": top_tracks(job, dzid)
    if not job.tracks: raise RuntimeError("Deezer has the artist but no original tracks")

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

def track_row(t, album_id, **more):
    return dict(album_deezer_id=album_id, title=t["title"], norm_title=norm_title(t["title"]), deezer_id=t["id"],
                deezer_rank=t.get("rank"), duration_ms=(t.get("duration") or 0) * 1000,
                explicit=t.get("explicit_lyrics"), preview_url=t.get("preview"),
                preview_source="deezer" if t.get("preview") else None, **more)

def top_tracks(job, dzid):
    """Skinny: the top 50 with the album stubs they came with."""
    seen = set()
    for t in deezer(f"artist/{dzid}/top", limit=50).get("data") or []:
        # ponytail: a feature credited to someone else would hang their album on this
        # artist; the full pipeline reads the artist's own albums and never sees it
        if (t.get("artist") or {}).get("id") != dzid or not t.get("album"): continue
        # Led Zeppelin's top 50 are all "(1990 Remaster)" on Deezer: for a top list that
        # is the recording, so keep it under its short title, as the full pipeline would
        if not is_original(t["title"], t.get("title_version"), remaster_ok=True): continue
        t = {**t, "title": t.get("title_short") or t["title"]}
        nt = norm_title(t["title"])
        if nt in seen: continue
        seen.add(nt)
        al = t["album"]
        job.albums.setdefault(al["id"], dict(title=al["title"], deezer_id=al["id"], cover_url=al.get("cover_xl")))
        job.tracks.append(track_row(t, al["id"]))
    # no top list (some Brazilian and gospel acts), or every entry a feature on someone
    # else's record (Naps): the artist's own three biggest albums instead, a few requests
    if not job.tracks: full_albums(job, dzid, 0, album_cap=3)

def full_albums(job, dzid, detail_cap, album_cap=None):
    """Deezer albums + embedded tracklists, then per-track detail for the most popular."""
    seen, seen_titles = set(), set()
    albums = artist_albums(dzid)
    if album_cap: albums = sorted(albums, key=lambda a: -(a.get("fans") or 0))[:album_cap]
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
        rows = []
        for pos, t in enumerate((full.get("tracks") or {}).get("data", []), 1):
            if not is_original(t["title"], t.get("title_version")): continue
            nt = norm_title(t["title"])
            if nt in seen_titles: continue      # remaster / deluxe duplicate
            seen_titles.add(nt)
            rows.append(track_row(t, full["id"], track_number=pos, release_date=date_or_none(full.get("release_date"))))
        # live sets, a cappella and anniversary editions survive the title filter but
        # contribute no tracks once dedupe has run; never write the empty shell
        if not rows: continue
        job.tracks += rows
        job.albums[full["id"]] = dict(
            title=full["title"], deezer_id=full["id"], album_type=full.get("record_type"),
            release_date=date_or_none(full.get("release_date")), release_precision="day",
            total_tracks=full.get("nb_tracks"), label=full.get("label"), upc=full.get("upc"),
            deezer_fans=full.get("fans"), duration_sec=full.get("duration"), cover_url=full.get("cover_xl"))
        # Deezer only tags genres on the album, so that is where they are kept; the
        # artist gets the union of theirs, and a track inherits its album's.
        for g in (full.get("genres") or {}).get("data", []):
            if g.get("id") in (None, -1) or not g.get("name"): continue   # Deezer's "unknown"
            job.genres[g["id"]] = g["name"]
            job.album_genres.add((full["id"], g["id"]))
    # ISRC / BPM / disc number need a per-track call, so only the most popular get it
    for t in pick(job, "isrc", detail_cap):
        d = deezer(f"track/{t['deezer_id']}")
        if d: job.sql[DETAIL_SQL].append((d.get("isrc"), d.get("bpm") or None, d.get("gain"), d.get("disk_number"),
                                          date_or_none(d.get("release_date")), t["deezer_id"]))

# ---------------------------------------------------------------- lookup stage: musicbrainz + spotify, by name

def lookup_stage(job, mb, sp):
    name = job.artist["name"]
    if mb and not job.cand.get("mbid"):
        try:
            m = mb.search_artists(artist=name, limit=1)["artist-list"]
            if m and int(m[0].get("ext:score", 0)) >= 90:
                m = m[0]
                job.artist.update(mbid=m["id"], sort_name=m.get("sort-name"), artist_type=m.get("type"),
                                  country=m.get("country"), gender=m.get("gender"),
                                  disambiguation=m.get("disambiguation") or None,
                                  begin_year=year(m.get("life-span", {}).get("begin")),
                                  end_year=year(m.get("life-span", {}).get("end")))
        except Exception as e:
            print(f"  ! musicbrainz {name}: {e}", flush=True)
    if sp and not job.cand.get("spotify_id"):
        try:
            r = sp.search(q=f'artist:"{name}"', type="artist", limit=1)["artists"]["items"]
            # Spotify always answers something: "Che" comes back as My Chemical Romance,
            # "XG" as RAC, "¥$" as Arctic Monkeys. spotify_id is UNIQUE, so storing a
            # stolen id makes its real owner fail on a unique violation for good -- the
            # artist is rolled back and every rerun repeats it. The id is a
            # cross-reference, not data: when the name does not match, go without it.
            if r and same_name(r[0]["name"], name): job.artist["spotify_id"] = r[0]["id"]
        except Exception as e:
            print(f"  ! spotify {name}: {e}", flush=True)

# ---------------------------------------------------------------- last.fm stage

def lastfm_stage(job, cap):
    name = job.artist["name"]
    st = lastfm("artist.getinfo", artist=name).get("artist", {}).get("stats", {})
    if st:
        job.artist.update(lastfm_listeners=int(st.get("listeners") or 0),
                          lastfm_playcount=int(st.get("playcount") or 0))
    if job.depth != "full": return
    for t in pick(job, "lastfm_playcount", cap):
        r = lastfm("track.getinfo", artist=name, track=t["title"]).get("track", {})
        if r: job.sql[LASTFM_SQL].append((r.get("listeners"), r.get("playcount"), t["deezer_id"]))

# ---------------------------------------------------------------- youtube stage
#
# Two different numbers come out of YouTube, and the game wants the second:
#   youtube_views   one video's view count, exact, from the official Data API
#   ytmusic_plays   the song figure YouTube Music shows -- plays over every upload
#                   of the recording (official video + art track + lyric video ...),
#                   rounded to a few digits, and only served by the app's own
#                   private API. ytmusicapi speaks that API; album pages carry the
#                   plays per track, so one artist costs one search (cached in
#                   artists.ytmusic_id), one artist page and one page per album.
# The Data API then prices the exact views for the video ids YouTube Music picked,
# at 1 quota unit per 50 videos, if YOUTUBE_API_KEY is set.
#
# ponytail: ytmusicapi is an unofficial client of a private API. It is paced to
# about one request a second and backs off on refusal; when YouTube Music keeps
# refusing, the run carries on without it and a later run fills in what is NULL.

YTM_DOWN = [False]

class YTMusicDown(Exception): pass

def ytm(fn, *args, **kw):
    """One YouTube Music request, paced and retried; YTMusicDown once it gives up."""
    for attempt in range(4):
        YTM_PACE.wait()
        try:
            return fn(*args, **kw)
        except Exception as e:      # throttling arrives as an HTML page the JSON parser rejects
            err = e
            time.sleep(5 * 3 ** attempt)      # 5, 15, 45 s
    raise YTMusicDown(err)

def plays_to_int(text):
    """'3B plays' -> 3000000000, '58.9M' -> 58900000, '1,234 plays' -> 1234, None -> None."""
    m = re.match(r"\s*([\d.,]+)\s*([KMB])?", text or "")
    if not m: return None
    n = float(m.group(1).replace(",", ""))
    return int(round(n * {"K": 1e3, "M": 1e6, "B": 1e9}.get(m.group(2), 1)))

def ytm_artist(job, yt):
    """YouTube Music's page id for the artist, cached in the DB. '-' = searched, none found."""
    with db().cursor() as cur:
        cur.execute("SELECT ytmusic_id FROM artists WHERE deezer_id=%s", (job.artist["deezer_id"],))
        got = cur.fetchone()
    if got and got[0]: return None if got[0] == "-" else got[0]
    name = job.artist["name"]
    hits = ytm(yt.search, name, filter="artists", limit=5)
    # tribute acts share the name; YouTube Music ranks the real one first among exact matches
    hit = next((h for h in hits if (h.get("artist") or "").lower() == name.lower()), hits[0] if hits else None)
    bid = hit["browseId"] if hit else "-"
    job.artist["ytmusic_id"] = bid
    return None if bid == "-" else bid

def ytm_section(yt, page, key):
    """Every entry of an artist page's albums / singles shelf, not just the ten shown."""
    s = page.get(key) or {}
    if s.get("browseId") and s.get("params"):
        return ytm(yt.get_artist_albums, s["browseId"], s["params"], limit=None)
    return s.get("results") or []

def song_table(album_tracks):
    """Album-page tracks -> {norm_title: (plays, video_id)}.

    A song sits on the album, the deluxe edition and its single; the same
    recording shows the same plays everywhere, a remaster or a live cut shows
    its own. Keep the most-played copy: the studio recording, and the same
    answer on every run whatever order the albums came in.
    """
    best = {}
    for t in album_tracks:
        plays, vid = plays_to_int(t.get("views")), t.get("videoId")
        if plays is None or not vid or not is_original(t.get("title") or "", remaster_ok=True): continue
        nt = norm_title(t["title"])
        if plays > best.get(nt, (-1,))[0]: best[nt] = (plays, vid)
    return best

def youtube_stage(job, yt, album_cap, refresh=False):
    if YTM_DOWN[0] or job.depth != "full": return
    if not refresh and have("ytmusic_plays", [t["deezer_id"] for t in job.tracks]):
        return      # a full re-run should move on to artists that have nothing yet
    try:
        bid = ytm_artist(job, yt)
        if not bid: return
        page = ytm(yt.get_artist, bid)
        job.artist["ytmusic_listeners"] = plays_to_int(page.get("monthlyListeners"))
        albums = [a for a in ytm_section(yt, page, "albums") + ytm_section(yt, page, "singles")
                  if is_original(a.get("title") or "", remaster_ok=True)][:album_cap]
        found = []
        for al in albums:
            found += ytm(yt.get_album, al["browseId"]).get("tracks") or []
    except YTMusicDown as e:
        YTM_DOWN[0] = True
        print(f"  ! YouTube Music keeps refusing ({e}); skipping it for the rest of this run. "
              f"Re-run later, it fills in what is NULL.", flush=True)
        return
    songs = song_table(found)
    vids = {}
    for t in job.tracks:
        hit = songs.get(t["norm_title"])
        if not hit: continue
        job.sql[YTM_SQL].append((hit[0], hit[1], t["deezer_id"]))
        vids[hit[1]] = t["deezer_id"]

    # exact views for the videos YouTube Music chose, from the official API
    if not os.environ.get("YOUTUBE_API_KEY") or not vids: return
    for i in range(0, len(vids), 50):
        chunk = list(vids)[i:i+50]
        r = yt_api("videos", part="statistics,snippet", id=",".join(chunk))
        for it in r.get("items", []):
            s = it.get("statistics") or {}
            job.sql[VIEWS_SQL].append((s.get("viewCount"), s.get("likeCount"),
                                       ((it.get("snippet") or {}).get("publishedAt") or "")[:10] or None, vids[it["id"]]))

YT_BUDGET = [10000]      # Data API units this run may spend; the daily allowance

def yt_api(path, **params):
    """One Data API call, retried on transport errors. {} once the quota is gone."""
    if YT_BUDGET[0] <= 0: return {}
    YT_BUDGET[0] -= 1
    for attempt in range(4):
        try:
            r = HTTP.get(f"https://www.googleapis.com/youtube/v3/{path}", timeout=30,
                         params=dict(key=os.environ["YOUTUBE_API_KEY"], **params))
        except Exception:
            time.sleep(2 ** attempt); continue      # transport hiccup, not a refusal
        if r.ok: return r.json()
        try:    reason = (r.json()["error"]["errors"] or [{}])[0].get("reason", "")
        except Exception: reason = r.text[:80]
        if reason in ("quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"):
            YT_BUDGET[0] = 0
            print("  ! youtube data api quota spent; views wait for tomorrow's run", flush=True)
            return {}
        if r.status_code < 500:
            print(f"  ! youtube {path}: {r.status_code} {reason}", flush=True); return {}
        time.sleep(2 ** attempt)        # 5xx: Google's side, back off and retry
    return {}

# ---------------------------------------------------------------- threads

def deezer_thread(in_q, outs, writer_q, detail_cap):
    """The head of the pipeline: builds the job's rows, then fans it out to every
    other stage. A job that fails here goes straight to the writer as a failure."""
    while (job := in_q.get()) is not None:
        job.t0 = time.time()
        try:
            seed_deezer(job, detail_cap)
        except Exception as e:
            job.error = f"{type(e).__name__}: {e}"
        if job.error or not outs:
            writer_q.put(job); continue
        job.pending = len(outs)
        for q in outs: q.put(job)
    for q in outs: q.put(None)

def stage_thread(in_q, fn, writer_q):
    """One source: run fn on every job, hand the job to the writer once every stage has."""
    while (job := in_q.get()) is not None:
        try:
            fn(job)
        except Exception as e:
            job.error = f"{type(e).__name__}: {e}"
        if job.stage_done(): writer_q.put(job)

def write(cur, job):
    """Every row of one artist, one transaction. Albums and tracks are matched by
    Deezer id, so the stages never needed a database id."""
    # spotify_id is UNIQUE and Spotify has one entry where Deezer has two ("Bob Marley"
    # and "Bob Marley & The Wailers"): the id is a cross-reference, the first owner keeps it
    if job.artist.get("spotify_id"):
        cur.execute("SELECT 1 FROM artists WHERE spotify_id=%s AND deezer_id<>%s",
                    (job.artist["spotify_id"], job.artist["deezer_id"]))
        if cur.fetchone(): job.artist.pop("spotify_id")
    aid = upsert(cur, "artists", "deezer_id", job.artist)
    for al in job.albums.values(): al["artist_id"] = aid
    upsert_many(cur, "albums", "deezer_id", list(job.albums.values()))
    if job.genres:
        cur.executemany("INSERT INTO genres(deezer_id, name) VALUES (%s,%s) "
                        "ON CONFLICT (deezer_id) DO UPDATE SET name=EXCLUDED.name", list(job.genres.items()))
        cur.executemany("INSERT INTO album_genres SELECT a.id, g.id FROM albums a, genres g "
                        "WHERE a.deezer_id=%s AND g.deezer_id=%s ON CONFLICT DO NOTHING", list(job.album_genres))
        cur.executemany("INSERT INTO artist_genres SELECT %s, id FROM genres WHERE deezer_id=%s ON CONFLICT DO NOTHING",
                        [(aid, g) for g in job.genres])
    cur.execute("SELECT deezer_id, id FROM albums WHERE deezer_id = ANY(%s)", (list(job.albums),))
    album_ids = dict(cur.fetchall())
    for t in job.tracks: t["album_id"] = album_ids[t.pop("album_deezer_id")]
    upsert_many(cur, "tracks", "deezer_id", job.tracks)
    cur.execute("INSERT INTO track_artists SELECT id, %s, 'main' FROM tracks WHERE deezer_id = ANY(%s) "
                "ON CONFLICT DO NOTHING", (aid, [t["deezer_id"] for t in job.tracks]))
    for sql, rows in job.sql.items(): cur.executemany(sql, rows)
    aliases = set(job.cand.get("aliases") or [])
    if job.cand.get("name") and job.cand["name"] != job.artist["name"]: aliases.add(job.cand["name"])
    if aliases:
        cur.executemany("INSERT INTO artist_aliases VALUES (%s,%s) ON CONFLICT DO NOTHING",
                        [(aid, a) for a in sorted(aliases) if a.casefold() != job.artist["name"].casefold()])
    cur.execute("DELETE FROM albums WHERE artist_id=%s AND NOT EXISTS "
                "(SELECT 1 FROM tracks WHERE album_id=albums.id)", (aid,))

def writer_thread(writer_q, total, label, progress):
    """Commits artists in run order, one transaction each, so --start resumes cleanly.
    Jobs finish out of order (a full artist is on YouTube Music for a while, the
    skinny ones behind it are not), so they wait in a heap for their turn."""
    done = failed = 0
    waiting, nxt = [], 0
    with psycopg.connect(DB) as conn, conn.cursor() as cur:
        while done < total:
            job = writer_q.get()
            heapq.heappush(waiting, (job.order, job))
            while waiting and waiting[0][0] == nxt:
                _, job = heapq.heappop(waiting)
                nxt += 1
                progress(state="running", done=done, total=total, failed=failed, artist=job.name)
                try:
                    if job.error: raise RuntimeError(job.error)
                    write(cur, job)
                    clear_failure(cur, job.name)
                    conn.commit()
                    print(f"[{label(job)}] {job.artist['name']}: {len(job.tracks)} tracks, {job.depth}, "
                          f"{time.time() - job.t0:.1f}s", flush=True)
                except Exception as e:
                    conn.rollback()        # an aborted tx would poison every later artist
                    failed += 1
                    reason = job.error or f"{type(e).__name__}: {e}"
                    note_failure(conn, job.name, reason)
                    print(f"[{label(job)}] {job.name}: FAILED {reason}", flush=True)
                done += 1
                progress(state="running", done=done, total=total, failed=failed, artist="")
    progress(state="finished", done=done, total=total, failed=failed, artist="")

# ---------------------------------------------------------------- main

def selftest():
    """The branchy bits: a rounded count, one copy per song, a Wikidata row, the depth cut."""
    assert plays_to_int("3B plays") == 3_000_000_000
    assert plays_to_int("58.9M") == 58_900_000 and plays_to_int("1,234 plays") == 1234
    assert plays_to_int("12K plays") == 12_000 and plays_to_int(None) is None and plays_to_int("") is None
    t = song_table([
        {"title": "Creep", "views": "1B plays", "videoId": "a"},
        {"title": "Creep (Deluxe)", "views": "1.2B plays", "videoId": "b"},      # another edition, same song
        {"title": "Creep (2009 Remaster)", "views": "1.5B plays", "videoId": "r"},  # same recording, often the only copy
        {"title": "Creep (Live)", "views": "9B plays", "videoId": "c"},           # live cut, not the song
        {"title": "Just", "views": None, "videoId": "d"},                          # no count shown
        {"title": "Karma Police", "views": "300M plays", "videoId": None}])       # unavailable
    assert t == {"creep": (1_500_000_000, "r")}, t
    assert is_original("In Utero (20th Anniversary Remaster)", remaster_ok=True)
    assert not is_original("In Utero (20th Anniversary Remaster)")            # the catalog side is unchanged
    assert not is_original("Creep (Remastered Live)", remaster_ok=True)
    assert is_original("Whole Lotta Love (1990 Remaster)", "1990 Remaster", remaster_ok=True)
    assert not is_original("Whole Lotta Love (1990 Remaster)", "1990 Remaster")
    assert not is_original("Whole Lotta Love (Live)", "Live", remaster_ok=True)
    assert song_table([]) == {}
    # the guard that keeps one artist's Spotify id off another's row
    assert same_name("Tyler, The Creator", "tyler the creator") and same_name("blink-182", "Blink 182")
    assert not same_name("Che", "My Chemical Romance") and not same_name("", "")
    assert same_name("JAŸ-Z", "JAY Z") and same_name("Ludwig Göransson", "Ludwig Goransson")
    # a Wikidata binding, as the SPARQL endpoint serialises it
    lit = lambda v: {"type": "literal", "value": v}
    ent = lambda q: {"type": "uri", "value": f"http://www.wikidata.org/entity/{q}"}
    row = wikidata_row({"dz": lit("399"), "label": lit("Radiohead"), "mbid": lit("a74b1b7f-71a5-4011-9441-d0b5e4122711"),
                        "sp": lit("4Z8W4fKeB5YxbusRsdQVPb"), "cc": lit("GB"), "kind": ent("Q215380"),
                        "start": lit("1985"), "aliases": lit("On a Friday|Radiohead|")})
    assert row["deezer_id"] == 399 and row["artist_type"] == "Group" and row["gender"] is None, row
    assert row["country"] == "GB" and row["begin_year"] == 1985 and row["end_year"] is None
    assert row["aliases"] == ["On a Friday", "Radiohead"] and row["spotify_id"] == "4Z8W4fKeB5YxbusRsdQVPb"
    assert wikidata_row({"dz": lit("399"), "kind": ent("Q5"), "sex": ent("Q6581072"), "end": lit("2016")}) \
        | {} == dict(deezer_id=399, name=None, mbid=None, spotify_id=None, country=None, artist_type="Person",
                     gender="female", begin_year=None, end_year=2016, aliases=[])
    assert wikidata_row({"dz": lit("not-a-number")}) is None and wikidata_row({}) is None
    assert wikidata_row({"dz": lit("1"), "label": lit("Simone &amp; Simaria")})["name"] == "Simone & Simaria"
    # who gets the full pipeline
    assert depth_for(1000, 1000) == "full" and depth_for(1001, 1000) == "skinny"
    assert depth_for(None, 1000) == "full" and depth_for(1, 0) == "skinny"
    print("ok")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["lastfm", "wikidata"], default="lastfm",
                    help="lastfm: the chart, searched by name; wikidata: every artist with a Deezer id, ranked by fans")
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--full", type=int, default=1000, help="ranks up to this get the full pipeline, the rest skinny")
    ap.add_argument("--start", type=int, default=1, help="resume from this rank")
    ap.add_argument("--artists", nargs="*", help="seed these names instead of a chart (always full)")
    ap.add_argument("--promote", type=int, help="seed this many skinny artists at full depth, biggest first; what the backend runs hourly")
    ap.add_argument("--no-youtube", action="store_true")
    ap.add_argument("--no-spotify", action="store_true")
    ap.add_argument("--detail-cap", type=int, default=120, help="tracks per artist to fetch ISRC/BPM for")
    ap.add_argument("--yt-albums", type=int, default=60, help="albums + singles per artist read on YouTube Music")
    ap.add_argument("--yt-refresh", action="store_true", help="re-read play counts already stored")
    ap.add_argument("--lastfm-cap", type=int, default=30, help="tracks per artist to fetch Last.fm listens for")
    ap.add_argument("--cache", default="data", help="where --source wikidata keeps the candidate list and Deezer's artist pages")
    ap.add_argument("--refresh-wikidata", action="store_true", help="re-run the SPARQL query and retry the ids Deezer refused, instead of the cached list")
    ap.add_argument("--selftest", action="store_true", help="run the pure-logic checks and exit")
    ap.add_argument("--progress-file", help="write a small status file for the moderator UI")
    args = ap.parse_args()
    if args.selftest: return selftest()

    # what the catalog dashboard reads: `base` is the run, the fields are the moment
    base = dict(source="named" if args.artists else "promote" if args.promote else args.source, started=int(time.time()),
                limit=args.limit, full_cap=args.full, phase="preparing", full=0, skinny=0)
    def progress(**fields):
        if not args.progress_file: return
        path = args.progress_file + ".next"
        with open(path, "w") as out:
            json.dump({**base, **fields}, out)
        os.replace(path, args.progress_file)

    progress(state="preparing", done=0, total=0, failed=0, artist="")

    wikidata = args.source == "wikidata" and not args.artists and not args.promote
    # ponytail: Wikidata already carries the ids, and a name search per artist on
    # MusicBrainz (1/s) or Spotify would be the slowest thing in a 30 000-artist run;
    # an artist Wikidata knows no mbid for simply has none.
    mb = None if wikidata else musicbrainz()
    sp = None if wikidata or args.no_spotify else spotify()
    yt = None
    if not args.no_youtube:
        from ytmusicapi import YTMusic
        yt = YTMusic(language="en")       # "3B plays", whatever the machine's locale
        if not os.environ.get("YOUTUBE_API_KEY"):
            print("! YOUTUBE_API_KEY is not set; play counts still come, exact views do not", flush=True)

    if args.artists:
        # a rerun of hand-picked names is easy to paste twice
        names = list({n.lower(): n for n in reversed(args.artists)}.values())[::-1]
        cands, ranked = [dict(name=n) for n in names], False
    elif args.promote:
        # the ids a Wikidata run stored come along, so nothing is searched by name
        with psycopg.connect(DB) as conn:
            rows = conn.execute("SELECT deezer_id, name, mbid, spotify_id FROM artists WHERE depth = 'skinny' "
                                "ORDER BY global_rank NULLS LAST, deezer_fans DESC NULLS LAST LIMIT %s", (args.promote,)).fetchall()
        cands, ranked = [dict(deezer_id=d, name=n, mbid=m, spotify_id=sp_id) for d, n, m, sp_id in rows], False
        if not cands:
            print("nothing to promote: every artist is already at full depth", flush=True)
            return progress(state="finished", done=0, total=0, failed=0, artist="")
    elif wikidata:
        base["phase"] = "wikidata"
        cands = wikidata_candidates(os.path.join(args.cache, "wikidata.json"), args.refresh_wikidata,
                                    report=lambda n: progress(state="preparing", done=n, total=0, failed=0, artist=""))
        base["phase"] = "ranking"
        cands = rank_by_fans(cands, os.path.join(args.cache, "deezer-fans.json"), args.refresh_wikidata,
                             report=lambda i, n: progress(state="preparing", done=i, total=n, failed=0, artist=""))[:args.limit]
        ranked = True
    else:
        # The Last.fm chart repeats a name now and then (The Cranberries sits at 69 and 70)
        names = list({n.lower(): n for n in reversed(top_artists(args.limit))}.values())[::-1]
        cands, ranked = [dict(name=n) for n in names], True

    already_full = set()
    if wikidata:
        with psycopg.connect(DB) as conn:
            # the whole ranking in one statement, so artists this run skips keep up too
            conn.execute("UPDATE artists a SET global_rank = r.rank FROM unnest(%s::bigint[], %s::int[]) AS r(deezer_id, rank) "
                         "WHERE a.deezer_id = r.deezer_id", ([c["deezer_id"] for c in cands], list(range(1, len(cands) + 1))))
            already_full = {r[0] for r in conn.execute("SELECT deezer_id FROM artists WHERE depth = 'full'")}
            conn.commit()

    jobs = []
    for rank, c in enumerate(cands, 1):
        if rank < args.start or c.get("deezer_id") in already_full: continue
        jobs.append(Job(c, len(jobs), rank if ranked else None,
                        "full" if args.promote else depth_for(rank if ranked else None, args.full)))
    full = sum(j.depth == "full" for j in jobs)
    base.update(phase="seeding", full=full, skinny=len(jobs) - full)
    print(f"seeding {len(jobs)} of {len(cands)} artists: {full} full, {len(jobs) - full} skinny"
          + (f", from rank {args.start}" if ranked else " (rank left unchanged)")
          + (f", {sum(c.get('deezer_id') in already_full for c in cands)} already full and left alone" if wikidata else ""), flush=True)
    progress(state="running", done=0, total=len(jobs), failed=0, artist="")

    stages = [lambda j: lastfm_stage(j, args.lastfm_cap)]
    if mb or sp: stages.append(lambda j: lookup_stage(j, mb, sp))
    if yt: stages.append(lambda j: youtube_stage(j, yt, args.yt_albums, args.yt_refresh))
    # ponytail: bounded queues are the back-pressure; the slowest stage sets the pace
    # and nothing piles up in memory
    deezer_q, writer_q = queue.Queue(8), queue.Queue()
    stage_qs = [queue.Queue(16) for _ in stages]
    threads = [threading.Thread(target=deezer_thread, args=(deezer_q, stage_qs, writer_q, args.detail_cap), daemon=True)]
    threads += [threading.Thread(target=stage_thread, args=(q, fn, writer_q), daemon=True) for q, fn in zip(stage_qs, stages)]
    label = (lambda j: f"{j.rank}/{len(cands)}") if ranked else (lambda j: f"{j.order + 1}/{len(jobs)}")
    writer = threading.Thread(target=writer_thread, args=(writer_q, len(jobs), label, progress), daemon=True)
    for t in threads + [writer]: t.start()
    for j in jobs: deezer_q.put(j)
    deezer_q.put(None)
    writer.join()

if __name__ == "__main__":
    main()
