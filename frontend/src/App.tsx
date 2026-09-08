import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { getPlayer, supabase } from './supabase'
import type { Player } from './supabase'
import { getToday } from './api'
import type { Today } from './api'
import { Play, Results, Scene } from './Play'
import { Flights } from './Flights'
import { Editor } from './Editor'
import { altitudeAu, passed } from './flight'
import './App.css'

// ponytail: hash routing, no router dependency. Four screens and one path segment
// is still cheaper than a router; revisit when a screen needs two.
function useHash() {
  const [hash, setHash] = useState(() => location.hash)
  useEffect(() => {
    const onChange = () => setHash(location.hash)
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

function App() {
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null)
  const [result, setResult] = useState<{ key: string; player: Player | null; error: string } | null>(null)
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [retry, setRetry] = useState(0)
  const [quiz, setQuiz] = useState<{ key: string; today: Today | null } | null>(null)
  const [flying, setFlying] = useState(false)
  // What the scene behind the page shows: the flight's running total while flying,
  // else the day's attempt. Keyed to the identity so a sign-out does not keep it.
  const [flown, setFlown] = useState<{ who: string; points: number } | null>(null)
  const hash = useHash()
  const [, screen = '', arg = ''] = hash.split('/')      // '#/editor/2026-09-10'
  const onAccount = screen === 'account'
  const onFlights = screen === 'flights'
  const onEditor = screen === 'editor'
  const away = onAccount || onFlights || onEditor

  useEffect(() => {
    if (!supabase) return
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })
    return () => subscription.unsubscribe()
  }, [])

  const token = session?.access_token
  const initialized = session !== undefined
  const requestKey = `${token ?? 'guest'}:${retry}`
  const loading = !initialized || result?.key !== requestKey
  const player = loading ? null : result?.player
  const playerError = loading ? '' : result?.error
  // The day's quiz, keyed like the player above: undefined while it loads for the
  // current identity, null when nothing is scheduled today.
  useEffect(() => {
    if (!initialized) return
    let live = true
    getToday(token)
      .then(next => { if (live) setQuiz({ key: requestKey, today: next }) })
      .catch(() => { if (live) setQuiz({ key: requestKey, today: null }) })
    return () => { live = false }
  }, [token, initialized, requestKey])
  const today = quiz?.key === requestKey ? quiz.today : undefined
  const who = token ?? 'guest'
  const points = flown?.who === who ? flown.points : today?.attempt?.total_points ?? 0
  const au = altitudeAu(points)

  useEffect(() => {
    if (!initialized) return
    const controller = new AbortController()
    getPlayer(token, controller.signal).then(next => {
      if (!controller.signal.aborted) setResult({ key: requestKey, player: next, error: '' })
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setResult({ key: requestKey, player: null, error: cause instanceof Error ? cause.message : 'Unable to load your player.' })
    })
    return () => controller.abort()
  }, [token, initialized, requestKey])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || busy) return
    const form = event.currentTarget
    const values = new FormData(form)
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const credentials = { email: String(values.get('email')).trim(), password: String(values.get('password')) }
      const result = mode === 'signup'
        ? await supabase.auth.signUp({ ...credentials, options: { data: { username: String(values.get('display_name')).trim() } } })
        : await supabase.auth.signInWithPassword(credentials)
      if (result.error) throw result.error
      form.reset()
      if (result.data.session) location.hash = '#/'
      else if (mode === 'signup') setMessage('Check your email to confirm your account, then sign in.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed. Please try again.')
    } finally { setBusy(false) }
  }

  async function signOut() {
    if (!supabase || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const { error: failure } = await supabase.auth.signOut({ scope: 'local' })
      if (failure) throw failure
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-out failed. Please try again.')
    } finally { setBusy(false) }
  }

  const landed = Boolean(today?.attempt?.finished)
  const passport = loading ? 'passport ⟳' : session ? (player?.profile?.username ?? 'account') : 'sign in'

  return (<>
    <Scene au={au} />
    <main className={flying ? 'flying' : undefined}>
      <header>
        <a className="brand" href="#/">✦ JAMILLION</a>
        {today && !away && (
          <span className="stats" role="status" aria-label={`${au.toFixed(1)} AU, past ${passed(au)}, ${points} points`}>
            <span className="stat"><small>ALT</small>{au.toFixed(1)} AU</span>
            <span className="stat"><small>SCORE</small>{points}</span>
          </span>
        )}
        {away
          ? <a className="chip" href="#/">◀ launchpad</a>
          : <a className="chip" href="#/account">{passport}</a>}
      </header>

      {onEditor ? (
        <Editor date={arg} token={token} />
      ) : onFlights ? (
        <Flights token={token} signedIn={Boolean(session)} tiers={today?.tiers} />
      ) : onAccount ? (
        <section className="panel" aria-labelledby="account-heading">
          <p className="eyebrow">FLIGHT PASSPORT</p>
          <h2 id="account-heading">{session ? (player?.profile ? `Welcome, ${player.profile.username}` : 'Your account') : 'Make yourself at home'}</h2>
          {loading && <p role="status">Preparing your passport…</p>}
          {playerError && <div role="alert"><p>{playerError}</p><button className="chip" type="button" onClick={() => setRetry(n => n + 1)}>Retry</button></div>}
          {player && <p className="identity">{player.authenticated ? `Signed in · ${player.role}` : 'Guest passport ready · no account needed'}</p>}
          {session ? <>
            <p>Your linked flights stay with your account. Signing out creates a fresh guest passport on this browser.</p>
            <button className="cta" disabled={busy || loading} onClick={signOut}>{busy ? 'Signing out…' : 'Sign out'}</button>
          </> : <>
            <p>Sign in to keep your flight history across visits, or stay a guest. Daily flights are coming next.</p>
            {supabase ? <>
              <div className="switch" aria-label="Account action">
                <button className="chip" type="button" aria-pressed={mode === 'login'} disabled={busy} onClick={() => { setMode('login'); setError(''); setMessage('') }}>Sign in</button>
                <button className="chip" type="button" aria-pressed={mode === 'signup'} disabled={busy} onClick={() => { setMode('signup'); setError(''); setMessage('') }}>Create account</button>
              </div>
              <form onSubmit={submit}>
                <fieldset disabled={busy || loading || !player}>
                  {mode === 'signup' && <label>Username<input name="display_name" autoComplete="nickname" required maxLength={40} pattern=".*\S.*" /></label>}
                  <label>Email<input name="email" type="email" autoComplete="username" required /></label>
                  <label>Password<input name="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={mode === 'signup' ? 6 : undefined} required /></label>
                  <button className="cta" type="submit">{busy ? 'One moment…' : mode === 'signup' ? '▲ create passport ▲' : '▲ sign in ▲'}</button>
                </fieldset>
              </form>
            </> : <p className="notice">Account sign-in is not configured yet. Guest passports are still available.</p>}
          </>}
          {error && <p className="notice" role="alert">{error}</p>}
          {message && <p className="notice" role="status">{message}</p>}
        </section>
      ) : (
        <section className={landed ? 'launchpad landed' : 'launchpad'}>
          {flying ? (
            <Play today={today!} token={token} onPoints={next => setFlown({ who, points: next })} onDone={() => { setFlying(false); setRetry(n => n + 1) }} />
          ) : landed ? (
            <Results today={today!} token={token} />
          ) : (<>
            <h1 className="glitch wave" aria-label="JAMILLION">
              {'JAMILLION'.split('').map((letter, i) =>
                <span key={i} style={{ animationDelay: `${0.18 * i}s` }}>{letter}</span>)}
            </h1>
            <p className="tagline">THE DAILY FLIGHT</p>
            <p className="meta">7 questions · 20 seconds each · rarer answers fly further</p>

            <div className="spacer" />

            <details className="howto">
              <summary>▪ HOW TO PLAY</summary>
              <p>Seven questions a day, twenty seconds each. Every correct answer lifts you — and the fewer players who said it, the higher you climb.</p>
              <ol className="tiers">
                {today?.tiers.map(tier => <li key={tier.name}><span>{tier.name}</span><b>{tier.points}</b></li>)}
              </ol>
              <p className="meta">700 points ≈ 120 AU: the heliopause, the edge of the Sun's reach.</p>
            </details>

            <button className="cta big" disabled={!today || loading} onClick={() => setFlying(true)}>
              {today?.attempt ? '▲ RESUME ASCENT ▲' : '▲ BEGIN ASCENT ▲'}
            </button>
            <p className="preflight" role="status">{
              loading || today === undefined ? 'Checking your passport…'
                : today === null ? 'No flight scheduled today · come back after 04:00 UTC'
                : player?.authenticated ? `Cleared for launch · ${player.profile?.username ?? player.role}`
                : 'Guest passport ready · no account needed'}</p>
            {playerError && <p className="notice" role="alert">{playerError} <button className="chip" type="button" onClick={() => setRetry(n => n + 1)}>Retry</button></p>}
          </>)}

          {!flying && (
            <nav className="dock">
              <span className="flight">{today ? `FLIGHT #${today.flight_no}` : 'FLIGHT —'}</span>
              <span>
                <a className="chip" href="#/account">passport</a>
                <a className="chip" href="#/flights">flight log</a>
                {(player?.role === 'moderator' || player?.role === 'admin') &&
                  <a className="chip" href="#/editor">flight deck</a>}
                <button className="chip" type="button" disabled>archive</button>
              </span>
            </nav>
          )}
        </section>
      )}
    </main>
  </>)
}
export default App
