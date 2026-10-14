// First run. Until an admin exists and the catalog keys are saved, the site is
// this page: create the admin account, paste the keys, pick how many artists.
// The keys go to the backend once and never come back to a browser.
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { call } from './api'
import { describeDuration, estimateSeconds, getSetup, lastfmKeyWorks, WIKIDATA_ARTISTS } from './setup'
import type { SetupStatus, Source } from './setup'
import { supabase } from './supabase'
import type { Player } from './supabase'

export function Setup({ token, player, onDone }: { token?: string; player: Player | null; onDone: () => void }) {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [launched, setLaunched] = useState(false)
  // the launch form, for the estimate under the button
  const [source, setSource] = useState<Source>('lastfm')
  const [limit, setLimit] = useState(50)
  const [full, setFull] = useState(1000)
  const estimate = describeDuration(estimateSeconds({ source, limit, full, youtube: true }, false))

  const refresh = () => getSetup().then(setStatus).catch(cause => setError(cause.message))
  useEffect(() => { refresh() }, [token])
  // While seeding, the count climbs; check on it every ten seconds.
  useEffect(() => {
    if (!launched) return
    const timer = setInterval(refresh, 10_000)
    return () => clearInterval(timer)
  }, [launched])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Something went wrong. Please retry.') }
    finally { setBusy(false) }
  }

  function createAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    run(async () => {
      if (!supabase) throw new Error('Sign-in is not available: the page has no Supabase configuration.')
      const { error: failure } = await supabase.auth.signUp({
        email: String(values.get('email')).trim(),
        password: String(values.get('password')),
        options: { data: { username: String(values.get('username')).trim() } },
      })
      if (failure) throw failure
      // The session arrives through onAuthStateChange; the new token refreshes the status.
    })
  }

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    run(async () => {
      if (!supabase) throw new Error('Sign-in is not available: the page has no Supabase configuration.')
      const { error: failure } = await supabase.auth.signInWithPassword({
        email: String(values.get('email')).trim(), password: String(values.get('password')),
      })
      if (failure) throw failure
    })
  }

  function saveKeys(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const text = (name: string) => String(values.get(name) ?? '').trim()
    run(async () => {
      if (!await lastfmKeyWorks(text('lastfm_api_key')))
        throw new Error('Last.fm does not accept that API key. Check it and try again.')
      const next = await call<SetupStatus>('/api/setup', token, {
        method: 'POST',
        body: JSON.stringify({
          lastfm_api_key: text('lastfm_api_key'),
          youtube_api_key: text('youtube_api_key'),
          spotify_client_id: text('spotify_client_id'),
          spotify_client_secret: text('spotify_client_secret'),
          source, limit, full,
        }),
      })
      setStatus(next)
      setLaunched(true)
    })
  }

  const isAdmin = player?.role === 'admin'
  return (
    <section className="panel setup" aria-labelledby="setup-heading">
      <p className="eyebrow">PRE-FLIGHT CHECKLIST</p>
      {!status ? (
        <p role="status">{error || 'Checking the launch site…'}</p>
      ) : launched ? (<>
        <h2 id="setup-heading">Cleared for launch</h2>
        <p>{status.seeding
          ? `Seeding the catalog in the background: ${status.artists.toLocaleString('en-GB')} artists in the catalog so far, ${status.seed_target.toLocaleString('en-GB')} asked for. The catalog page follows the run; you can close this one.`
          : `The seeder has finished: ${status.artists} artists in the catalog.`}</p>
        <p>Next, write the first day's questions on the flight deck.</p>
        <button className="cta" type="button" onClick={onDone}>▲ to the launchpad ▲</button>
      </>) : !status.admin ? (<>
        <h2 id="setup-heading">Set up Jamillion</h2>
        <p>Nobody runs this launch site yet. The account you create now is the admin.</p>
        <form onSubmit={createAdmin}>
          <fieldset disabled={busy}>
            <label>Username<input name="username" autoComplete="nickname" required maxLength={40} pattern=".*\S.*" /></label>
            <label>Email<input name="email" type="email" autoComplete="username" required /></label>
            <label>Password<input name="password" type="password" autoComplete="new-password" minLength={6} required /></label>
            <button className="cta" type="submit">{busy ? 'One moment…' : '▲ create the admin account ▲'}</button>
          </fieldset>
        </form>
      </>) : !isAdmin ? (<>
        <h2 id="setup-heading">Setup is not finished</h2>
        <p>Sign in as the admin to finish it.</p>
        <form onSubmit={signIn}>
          <fieldset disabled={busy}>
            <label>Email<input name="email" type="email" autoComplete="username" required /></label>
            <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
            <button className="cta" type="submit">{busy ? 'One moment…' : '▲ sign in ▲'}</button>
          </fieldset>
        </form>
      </>) : (<>
        <h2 id="setup-heading">Fill the catalog</h2>
        <p>Every question is written out of a music catalog, biggest artists first. The keys are stored on the server and never shown again.</p>
        <form onSubmit={saveKeys}>
          <fieldset disabled={busy}>
            <label>Last.fm API key <small>required · free at <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer">last.fm/api</a></small>
              <input name="lastfm_api_key" required autoComplete="off" spellCheck={false} /></label>
            <label>YouTube Data API key <small>optional · exact view counts</small>
              <input name="youtube_api_key" autoComplete="off" spellCheck={false} /></label>
            <label>Spotify client id <small>optional · cross-reference ids</small>
              <input name="spotify_client_id" autoComplete="off" spellCheck={false} /></label>
            <label>Spotify client secret
              <input name="spotify_client_secret" type="password" autoComplete="off" /></label>
            <label>Artist list
              <select value={source} onChange={event => setSource(event.target.value as Source)}>
                <option value="lastfm">Last.fm's chart — the biggest artists by listeners</option>
                <option value="wikidata">Wikidata → Deezer — every artist Wikidata links to Deezer, ~{WIKIDATA_ARTISTS.toLocaleString('en-GB')}</option>
              </select></label>
            <label>Artists to seed <small>the top {full.toLocaleString('en-GB')} at full depth (~45 s each: every album, YouTube and Last.fm counts), the rest skinny (Deezer's top 50, under a second)</small>
              <input type="number" min={0} max={50000} value={limit} required onChange={event => setLimit(Number(event.target.value))} /></label>
            <label>Full depth for the top
              <input type="number" min={0} max={50000} value={full} required onChange={event => setFull(Number(event.target.value))} /></label>
            <button className="cta" type="submit">{busy ? 'Checking the key…' : limit > 0 ? `▲ launch · ${estimate}${source === 'wikidata' ? ' after an 80-minute ranking pass' : ''} ▲` : '▲ save the keys ▲'}</button>
          </fieldset>
        </form>
      </>)}
      {status && error && <p className="notice" role="alert">{error}</p>}
    </section>
  )
}
