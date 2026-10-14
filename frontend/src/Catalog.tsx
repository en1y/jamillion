// The catalog dashboard: what the seeder has built, the run in the air, the runs
// staff can start, the seeder's own log, and the gaps between what was asked for
// and what landed. Its own screen, because checking on the catalog is not the same
// job as writing a day's quiz -- the flight deck keeps one line of it and links here.
//
// Two kinds of gap are shown side by side, and both are retried the same way:
// an artist that failed outright (catalog_failures, written by the seeder and kept
// between runs) and an artist whose row exists with no tracks under it, which looks
// seeded everywhere else and is useless to the editor.
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { FormEvent } from 'react'
import { ApiError } from './api'
import { formatDate } from './flight'
import { namesFrom } from './catalog'
import { describeDuration, estimateSeconds, forgetFailures, getSeeder, getSeederLog, phaseLine, rerunSeeder,
         secondsLeft, stopSeeder, WIKIDATA_ARTISTS } from './setup'
import type { CatalogFailure, RunRequest, SetupStatus, Source } from './setup'

const wall = (cause: unknown) =>
  cause instanceof ApiError ? cause.message : 'The flight deck is not answering. Please retry.'

const count = (n: number) => n.toLocaleString('en-GB')

/** '2026-09-17T12:30:00Z' -> '17.09.2026'. The seeder writes whole timestamps. */
const day = (stamp: string) => (stamp ? formatDate(stamp.slice(0, 10)) : '—')

const SOURCES: Record<Source, { label: string; blurb: string }> = {
  lastfm: { label: "Last.fm's chart", blurb: 'the biggest artists by listeners, found on Deezer by name' },
  wikidata: { label: 'Wikidata → Deezer', blurb: `every artist Wikidata links to Deezer (~${count(WIKIDATA_ARTISTS)}), ranked by Deezer fans, with their MusicBrainz and Spotify ids and aliases` },
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return <label className="pick"><input type="checkbox" checked={on} onChange={onChange} /> {label}</label>
}

export function Catalog({ token }: { token?: string }) {
  const client = useQueryClient()
  // A run that is moving is worth a closer look than a catalog sitting still.
  const seeder = useQuery({ queryKey: ['seeder', token], queryFn: () => getSeeder(token),
                            refetchInterval: query => query.state.data?.seeding ? 5_000 : 20_000 })
  const status = seeder.data
  const setStatus = (next: SetupStatus) => client.setQueryData(['seeder', token], next)
  const [failed, setError] = useState('')
  const error = failed || (seeder.error ? wall(seeder.error) : '')
  const [picked, setPicked] = useState<string[]>([])
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [showLog, setShowLog] = useState(false)

  const running = Boolean(status?.seeding)
  const progress = status?.progress
  const failures = status?.failures ?? []
  const empty = status?.empty_artists ?? []
  const gaps = [...failures.map(f => f.name), ...empty]

  // The ranked-run form. Starts from what the last run asked for, once that is known.
  const [source, setSource] = useState<Source | null>(null)
  const [limit, setLimit] = useState<number | null>(null)
  const [full, setFull] = useState<number | null>(null)
  const [youtube, setYoutube] = useState(true)
  const run: Extract<RunRequest, { source: Source }> = {
    source: source ?? status?.seed_source ?? 'lastfm',
    limit: limit ?? (status?.seed_target || 500),
    full: full ?? status?.seed_full ?? 1000,
    youtube,
  }
  const estimate = status ? describeDuration(estimateSeconds(run, status.catalog?.wikidata_cached ?? false)) : ''

  // Time left is measured from this run's own pace: the first reading since the
  // phase began, against the latest one.
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(timer)
  }, [running])
  const sample = useRef<{ at: number; done: number; key: string } | null>(null)
  const phaseKey = progress ? `${progress.started}:${progress.phase}` : ''
  useEffect(() => {
    if (!running || !progress) { sample.current = null; return }
    if (sample.current?.key !== phaseKey) sample.current = { at: Date.now() / 1000, done: progress.done, key: phaseKey }
  }, [running, progress, phaseKey])
  const left = running && progress && sample.current && progress.total
    ? secondsLeft(sample.current, { at: now, done: progress.done }, progress.total) : null

  const log = useQuery({ queryKey: ['seeder-log', token], queryFn: () => getSeederLog(token, 120),
                         enabled: showLog, refetchInterval: running ? 5_000 : false })
  const logEnd = useRef<HTMLPreElement>(null)
  useEffect(() => { logEnd.current?.scrollTo({ top: logEnd.current.scrollHeight }) }, [log.data])

  const pick = (name: string) =>
    setPicked(rest => rest.includes(name) ? rest.filter(other => other !== name) : [...rest, name])

  async function start(request: RunRequest) {
    if (busy || running) return
    setBusy(true)
    setError('')
    try {
      setStatus(await rerunSeeder(request, token))
      if ('artists' in request) { setPicked([]); setTyped('') }
    } catch (cause) { setError(wall(cause)) } finally { setBusy(false) }
  }

  async function stop() {
    if (busy || !running) return
    setBusy(true)
    try { setStatus(await stopSeeder(token)) } catch (cause) { setError(wall(cause)) } finally { setBusy(false) }
  }

  async function forget() {
    const names = picked.filter(name => failures.some(one => one.name === name))
    if (!names.length || busy) return
    setBusy(true)
    try {
      setStatus(await forgetFailures(names, token))
      setPicked(rest => rest.filter(name => !names.includes(name)))
    } catch (cause) { setError(wall(cause)) } finally { setBusy(false) }
  }

  function submitNames(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const names = namesFrom(typed)
    if (names.length) void start({ artists: names })
  }

  function submitRanked(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (run.limit >= 1) void start(run)
  }

  const stalled = !status || !status.configured || running || busy
  const percent = progress?.total ? Math.min(100, Math.round(progress.done / progress.total * 100)) : 0
  const elapsed = progress && running ? Math.max(0, now - progress.started) : 0

  return (
    <section className="editor catalog-deck" aria-labelledby="catalog-heading">
      <p className="eyebrow">MUSIC CATALOG</p>
      <h2 id="catalog-heading">{running ? 'A catalog run is in the air' : 'What the catalog holds'}</h2>
      {!status && <p role="status">{error || 'Checking the catalog…'}</p>}
      {status && <>
        <dl className="catalog-counts">
          <div><dt>artists</dt><dd>{count(status.artists)}</dd>
            <small>{count(status.catalog?.full ?? 0)} full · {count(status.catalog?.skinny ?? 0)} skinny</small></div>
          <div><dt>albums</dt><dd>{count(status.catalog?.albums ?? 0)}</dd></div>
          <div><dt>tracks</dt><dd>{count(status.catalog?.tracks ?? 0)}</dd>
            <small>{count(status.catalog?.previews ?? 0)} with a clip</small></div>
          <div><dt>YouTube plays</dt><dd>{count(status.catalog?.plays ?? 0)}</dd><small>tracks with a count</small></div>
          <div><dt>aliases</dt><dd>{count(status.catalog?.aliases ?? 0)}</dd><small>other names, from Wikidata</small></div>
          <div><dt>last seeded</dt><dd>{day(status.catalog?.last_seeded ?? '')}</dd></div>
        </dl>

        {(running || progress) && progress && (
          <div className="seeder-progress">
            <div className="seeder-head">
              <p className="eyebrow">{running ? 'THIS RUN' : 'LAST RUN'} · {
                progress.source === 'named' ? 'named artists'
                  : progress.source === 'promote' ? `hourly promotion, ${count(progress.full)} skinny artists to full depth`
                  : `${SOURCES[progress.source].label}, ${count(progress.limit)} asked for`}</p>
              {running && <button className="chip chip-stop" type="button" disabled={busy} onClick={() => void stop()}>
                {busy ? 'Stopping…' : '■ Stop the run'}</button>}
            </div>
            <div className="seeder-count" role="status" aria-live="polite">
              <strong>{count(progress.done)} of {count(progress.total)}</strong>
              {progress.phase === 'ranking' ? ' artist pages ranked' : progress.phase === 'wikidata' ? ' artists listed' : ' artists processed'}
              {progress.failed > 0 && <> · <em>{count(progress.failed)} failed</em></>}
              <b>{progress.total ? `${percent}%` : ''}</b>
            </div>
            <progress max={progress.total || 1} value={progress.total ? progress.done : undefined} aria-label="Artists processed" />
            <p className="seeder-note">{phaseLine(progress, running)}</p>
            <dl className="seeder-facts">
              {progress.phase === 'seeding' && <div><dt>depth</dt><dd>{count(progress.full)} full · {count(progress.skinny)} skinny</dd></div>}
              {running && <div><dt>running for</dt><dd>{describeDuration(elapsed)}</dd></div>}
              {running && <div><dt>time left</dt><dd>{left === null ? 'measuring…' : describeDuration(left)}</dd></div>}
              {!running && <div><dt>started</dt><dd>{day(new Date(progress.started * 1000).toISOString())}</dd></div>}
            </dl>
          </div>
        )}

        <div className="seeder-actions">
          <form onSubmit={submitRanked} className="seeder-ranked">
            <h3>Start a ranked run</h3>
            <label>Artist list
              <select value={run.source} disabled={stalled} onChange={event => setSource(event.target.value as Source)}>
                {(Object.keys(SOURCES) as Source[]).map(key => <option key={key} value={key}>{SOURCES[key].label}</option>)}
              </select>
              <small>{SOURCES[run.source].blurb}</small></label>
            <div className="seeder-numbers">
              <label>Artists
                <input type="number" min="1" max="50000" required disabled={stalled} value={run.limit}
                       onChange={event => setLimit(Number(event.target.value))} /></label>
              <label>Full depth for the top
                <input type="number" min="0" max="50000" required disabled={stalled} value={run.full}
                       onChange={event => setFull(Number(event.target.value))} /></label>
            </div>
            <label className="pick"><input type="checkbox" checked={youtube} disabled={stalled}
                                           onChange={() => setYoutube(on => !on)} /> YouTube Music play counts <small>(full artists only; the slow part)</small></label>
            <p className="seeder-note">Full depth is every album, per-track detail, YouTube Music and Last.fm per track, about 45 s an artist.
              The rest are skinny: Deezer's artist page and top 50 tracks, under half a second each.
              Artists already at full depth are left alone{run.source === 'wikidata' && !status.catalog?.wikidata_cached
                ? '; a first Wikidata run also ranks the whole list by Deezer fans, about 80 minutes, once' : ''}.</p>
            <button className="chip" type="submit" disabled={stalled}>
              {busy ? 'Starting…' : `Run ${count(run.limit)} · ${estimate}`}</button>
          </form>
          <form onSubmit={submitNames}>
            <h3>Run named artists</h3>
            <label>Names <small>one per line, or comma-separated · always full depth · rank left unchanged</small>
              <textarea rows={8} value={typed} disabled={stalled} placeholder={'Radiohead\nBjörk'}
                        onChange={event => setTyped(event.target.value)} /></label>
            <button className="chip" type="submit" disabled={stalled || !namesFrom(typed).length}>
              {busy ? 'Starting…' : `Run ${namesFrom(typed).length || ''} named`.trim()}</button>
          </form>
        </div>
        <p className="seeder-note">One run at a time, every name in the same run. The seeder commits an artist at a time,
          so a stopped run keeps everything it had done; the next run refreshes rather than duplicates.</p>

        <details className="seeder-log" open={showLog} onToggle={event => setShowLog(event.currentTarget.open)}>
          <summary>The seeder's log {running && <small>· live</small>}</summary>
          {showLog && <pre ref={logEnd}>{log.data?.lines.length ? log.data.lines.join('\n') : log.isPending ? 'Reading…' : 'No run has written a log yet.'}</pre>}
        </details>

        <div className="catalog-gaps">
          <div className="seeder-head">
            <h3>The gaps <small>{failures.length} failed · {empty.length} with no tracks</small></h3>
            <span className="head-chips">
              <button className="chip" type="button" disabled={!gaps.length}
                      onClick={() => setPicked(picked.length ? [] : gaps)}>
                {picked.length ? 'Clear' : 'Select all'}</button>
              <button className="chip" type="button" disabled={stalled || !picked.length}
                      onClick={() => void start({ artists: picked })}>Retry {picked.length || ''}</button>
              <button className="chip" type="button" disabled={busy || !picked.some(name => failures.some(one => one.name === name))}
                      onClick={() => void forget()}>Forget</button>
            </span>
          </div>
          {!gaps.length && <p className="seeder-note">Nothing is missing. Every artist in the catalog has tracks under it.</p>}
          {failures.length > 0 && <ul className="catalog-list">
            {failures.map((one: CatalogFailure) => (
              <li key={one.name}>
                <Toggle on={picked.includes(one.name)} onChange={() => pick(one.name)} label={one.name} />
                <small>{one.reason}</small>
                <small className="tries">{one.attempts} attempt{one.attempts === 1 ? '' : 's'} · {day(one.last_try)}</small>
              </li>
            ))}
          </ul>}
          {empty.length > 0 && <>
            <p className="seeder-note">In the catalog with no tracks under them — the editor cannot ask about these:</p>
            <ul className="catalog-list">
              {empty.map(name => (
                <li key={`empty-${name}`}>
                  <Toggle on={picked.includes(name)} onChange={() => pick(name)} label={name} />
                  <small>no albums or tracks</small>
                </li>
              ))}
            </ul>
          </>}
        </div>
        {error && <p className="notice" role="alert">{error}</p>}
      </>}
    </section>
  )
}
