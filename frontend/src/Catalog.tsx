// The catalog dashboard: what the seeder has built, what it failed to build, and
// the reruns aimed at the gap between the two. Its own screen, because checking on
// the catalog is not the same job as writing a day's quiz -- the flight deck keeps
// one line of it and links here.
//
// Two kinds of gap are shown side by side, and both are retried the same way:
// an artist that failed outright (catalog_failures, written by the seeder and kept
// between runs) and an artist whose row exists with no tracks under it, which looks
// seeded everywhere else and is useless to the editor.
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError } from './api'
import { formatDate } from './flight'
import { namesFrom } from './catalog'
import { forgetFailures, getSeeder, rerunSeeder } from './setup'
import type { CatalogFailure, SetupStatus } from './setup'

const wall = (cause: unknown) =>
  cause instanceof ApiError ? cause.message : 'The flight deck is not answering. Please retry.'

const count = (n: number) => n.toLocaleString('en-GB')

/** '2026-09-17T12:30:00Z' -> '17.09.2026'. The seeder writes whole timestamps. */
const day = (stamp: string) => (stamp ? formatDate(stamp.slice(0, 10)) : '—')

function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return <label className="pick"><input type="checkbox" checked={on} onChange={onChange} /> {label}</label>
}

export function Catalog({ token }: { token?: string }) {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [picked, setPicked] = useState<string[]>([])
  const [typed, setTyped] = useState('')
  const [limit, setLimit] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const running = Boolean(status?.seeding)
  const progress = status?.progress
  const failures = status?.failures ?? []
  const empty = status?.empty_artists ?? []
  const gaps = [...failures.map(f => f.name), ...empty]

  // A run that is moving is worth a closer look than a catalog sitting still.
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      getSeeder(token)
        .then(next => { if (live) { setStatus(next); setError('') } })
        .catch((cause: unknown) => { if (live) setError(wall(cause)) })
        .finally(() => { if (live) timer = setTimeout(check, running ? 5_000 : 20_000) })
    }
    check()
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [token, reload, running])

  const pick = (name: string) =>
    setPicked(rest => rest.includes(name) ? rest.filter(other => other !== name) : [...rest, name])

  async function run(request: { artists: string[] } | { limit: number }) {
    if (busy || running) return
    setBusy(true)
    setError('')
    try {
      setStatus(await rerunSeeder(request, token))
      if ('artists' in request) { setPicked([]); setTyped('') }
      setReload(n => n + 1)
    } catch (cause) { setError(wall(cause)) } finally { setBusy(false) }
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
    if (names.length) void run({ artists: names })
  }

  function submitChart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const size = limit ?? status?.seed_target ?? 500
    if (size >= 1 && size <= 2000) void run({ limit: size })
  }

  const stalled = !status || !status.configured || running || busy
  const percent = progress?.total ? Math.min(100, Math.round(progress.done / progress.total * 100)) : 0

  return (
    <section className="editor catalog-deck" aria-labelledby="catalog-heading">
      <p className="eyebrow">MUSIC CATALOG</p>
      <h2 id="catalog-heading">{running ? 'A catalog run is in the air' : 'What the catalog holds'}</h2>
      {!status && <p role="status">{error || 'Checking the catalog…'}</p>}
      {status && <>
        <dl className="catalog-counts">
          <div><dt>artists</dt><dd>{count(status.artists)}</dd></div>
          <div><dt>albums</dt><dd>{count(status.catalog?.albums ?? 0)}</dd></div>
          <div><dt>tracks</dt><dd>{count(status.catalog?.tracks ?? 0)}</dd></div>
          <div><dt>with a clip</dt><dd>{count(status.catalog?.previews ?? 0)}</dd></div>
          <div><dt>last seeded</dt><dd>{day(status.catalog?.last_seeded ?? '')}</dd></div>
        </dl>

        {(running || progress) && (
          <div className="seeder-progress">
            <div className="seeder-count" role="status" aria-live="polite">
              <strong>{progress?.done ?? 0} of {progress?.total ?? 0}</strong> artists processed
              <b>{percent}%</b>
            </div>
            <progress max={progress?.total || 1} value={progress?.done ?? 0} aria-label="Artists processed" />
            <p className="seeder-note">{
              running && progress?.artist ? `Working on ${progress.artist}…`
                : running ? 'Preparing the artist list…'
                : progress?.state === 'interrupted' ? 'The last run stopped early. Its artists are in the gaps below.'
                : `Last run: ${progress?.done ?? 0} processed, ${progress?.failed ?? 0} failed.`}</p>
          </div>
        )}

        <div className="seeder-actions">
          <form onSubmit={submitNames}>
            <label>Run these artists
              <textarea rows={3} value={typed} disabled={stalled} placeholder="One name per line"
                        onChange={event => setTyped(event.target.value)} /></label>
            <button className="chip" type="submit" disabled={stalled || !namesFrom(typed).length}>
              {busy ? 'Starting…' : `Run ${namesFrom(typed).length || ''} named`.trim()}</button>
          </form>
          <form onSubmit={submitChart}>
            <label>Rerun the chart
              <input type="number" min="1" max="2000" required disabled={stalled}
                     value={limit ?? (status.seed_target || 500)}
                     onChange={event => setLimit(Number(event.target.value))} /></label>
            <button className="chip" type="submit" disabled={stalled}>
              {busy ? 'Starting…' : 'Run top artists'}</button>
          </form>
        </div>
        <p className="seeder-note">One run at a time, every name in the same run. A chart rerun takes hours;
          artists already in the catalog are refreshed, not duplicated.</p>

        <div className="catalog-gaps">
          <div className="seeder-head">
            <h3>The gaps <small>{failures.length} failed · {empty.length} with no tracks</small></h3>
            <span className="head-chips">
              <button className="chip" type="button" disabled={!gaps.length}
                      onClick={() => setPicked(picked.length ? [] : gaps)}>
                {picked.length ? 'Clear' : 'Select all'}</button>
              <button className="chip" type="button" disabled={stalled || !picked.length}
                      onClick={() => void run({ artists: picked })}>Retry {picked.length || ''}</button>
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
