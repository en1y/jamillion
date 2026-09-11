import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { getCeilings, getPlayer, supabase } from './supabase'
import type { Player } from './supabase'
import { getToday } from './api'
import type { Today } from './api'
import { Play, Results, Scene } from './Play'
import type { Mood } from './Play'
import { useCountUp } from './count'
import { Flights } from './Flights'
import { Editor } from './Editor'
import { Admin } from './Admin'
import { altitudeAu, ceilingFor, legs, passed } from './flight'
import { setPrefs, sfx, usePrefs } from './prefs'
import { Settings } from './Settings'

/** The body just passed and the one coming up, with the gap in AU and in points. */
function Legs({ au, max }: { au: number; max: number }) {
  const { behind, ahead } = legs(au, max)
  return (
    <span className="legs">
      <span className="leg"><i>▼</i> {behind.name} <b>{behind.au.toFixed(1)} AU · {behind.points} pts</b></span>
      {ahead && <span className="leg ahead"><i>▲</i> {ahead.name} <b>{ahead.au.toFixed(1)} AU · {ahead.points} pts</b></span>}
    </span>
  )
}
import { navigate, useRoute } from './routing'
import './App.css'

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
  const [settings, setSettings] = useState(false)
  const { sfx: sound } = usePrefs()
  // Each day's ceiling in points, from the key, by date. Loaded once.
  const [ceilings, setCeilings] = useState<Record<string, number>>({})
  useEffect(() => { getCeilings().then(setCeilings).catch(() => {}) }, [])
  // What the scene behind the page shows: the flight's running total while flying,
  // else the day's attempt. Keyed to the identity so a sign-out does not keep it.
  const [flown, setFlown] = useState<{ who: string; points: number } | null>(null)
  // The rocket's reaction to the last verdict; it wears off on its own.
  const [mood, setMood] = useState<Mood>(null)
  useEffect(() => {
    if (!mood) return
    const timer = setTimeout(() => setMood(null), 1500)
    return () => clearTimeout(timer)
  }, [mood])
  const [screen, arg] = useRoute()
  const onAccount = screen === 'account'
  const onFlights = screen === 'flights'
  const onEditor = screen === 'editor'
  const onAdmin = screen === 'admin'
  const away = onAccount || onFlights || onEditor || onAdmin
  // The wheel over bare sky pulls the camera out, on the play page only, and only
  // when nothing of the page is under the cursor: cards, HUD, buttons and text
  // keep their scroll. The gauges are pointer-transparent, so they count as sky.
  const [zoom, setZoom] = useState(1)
  useEffect(() => {
    if (away) return
    const sky = (target: EventTarget | null) => target instanceof Element &&
      (target.tagName === 'MAIN' || target.tagName === 'HTML' || target.tagName === 'BODY' || target.id === 'root' ||
       target.classList.contains('launchpad') || target.classList.contains('spacer'))
    const wheel = (event: WheelEvent) => {
      if (!sky(event.target)) return
      event.preventDefault()
      setZoom(z => Math.min(1, Math.max(0.12, z * (event.deltaY > 0 ? 0.85 : 1.18))))
    }
    addEventListener('wheel', wheel, { passive: false })
    return () => removeEventListener('wheel', wheel)
  }, [away])

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
  const max = today ? ceilingFor(today, ceilings) : 0
  const au = altitudeAu(points, max)
  const ticking = useCountUp(points)      // the header's counters crank up to the new total

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
      if (result.data.session) navigate('/')
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
    <Scene au={au} mood={mood} zoom={zoom} />
    {today && !away && (
      // Krillion's depth and score gauges: pinned to the top corners, over everything.
      // Keyed on the total so the jolt replays on every new score.
      <div key={points} className={points ? 'gauges bump' : 'gauges'} role="status"
           aria-label={`${au.toFixed(1)} AU, past ${passed(au)}, ${points} points`}>
        <span className="gauge alt"><small>ALTITUDE</small><b>{altitudeAu(ticking, max).toFixed(1)} AU</b></span>
        <span className="gauge score"><small>SCORE</small><b>{ticking}</b></span>
        <Legs au={altitudeAu(ticking, max)} max={max} />
      </div>
    )}
    <main className={flying ? 'flying' : undefined}>
      <header>
        <a className="brand" href="/">✦ JAMILLION</a>
        <span className="head-chips">
          {/* the mute is one press, like Krillion's; the rest is behind the gear */}
          <button className="chip" type="button" aria-pressed={sound} title="Sound effects"
                  aria-label={sound ? 'Mute sound effects' : 'Unmute sound effects'}
                  onClick={() => { setPrefs({ sfx: !sound }); if (!sound) sfx('brief') }}>{sound ? '🔊' : '🔇'}</button>
          <button className="chip" type="button" aria-label="Settings" title="Settings"
                  onClick={() => { sfx('click'); setSettings(true) }}>⚙</button>
          {away
            ? <a className="chip" href="/">◀ launchpad</a>
            : <a className="chip" href="/account">{passport}</a>}
        </span>
      </header>
      <Settings open={settings} onClose={() => setSettings(false)} />

      {onEditor ? (
        <Editor date={arg} token={token} admin={player?.role === 'admin'} />
      ) : onAdmin ? (
        <Admin tab={arg} token={token} me={player?.profile?.id} />
      ) : onFlights ? (
        <Flights token={token} signedIn={Boolean(session)} tiers={today?.tiers} ceilings={ceilings} />
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
            <Play today={today!} max={max} token={token} onDone={() => { setFlying(false); setRetry(n => n + 1) }}
                  onPoints={(next, reaction) => { setFlown({ who, points: next }); if (reaction) setMood(reaction) }} />
          ) : landed ? (
            <Results today={today!} max={max} token={token} />
          ) : (<>
            <h1 className="glitch wave" aria-label="JAMILLION">
              {'JAMILLION'.split('').map((letter, i) =>
                <span key={i} style={{ animationDelay: `${0.18 * i}s` }}>{letter}</span>)}
            </h1>
            <p className="tagline">THE DAILY FLIGHT</p>
            {/* not "20 seconds each" any more: a song or album question runs untimed */}
            <p className="meta">7 questions a day · rarer answers fly further</p>

            <div className="spacer" />

            <details className="howto">
              <summary>▪ HOW TO PLAY</summary>
              <p>Seven questions a day, twenty seconds each. Every correct answer lifts you — and the fewer players who said it, the higher you climb.</p>
              <ol className="tiers">
                {today?.tiers.map(tier => <li key={tier.name}><span>{tier.name}</span><b>{tier.points}</b></li>)}
              </ol>
              <p className="meta">A perfect day{max ? `, ${max} points,` : ''} lands on Pluto, 39.5 AU out.</p>
            </details>

            <button className="cta big" disabled={!today || loading} onClick={() => { sfx('send'); setFlying(true) }}>
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
                <a className="chip" href="/account">passport</a>
                <a className="chip" href="/flights">flight log</a>
                {(player?.role === 'moderator' || player?.role === 'admin') &&
                  <a className="chip" href="/editor">flight deck</a>}
                {player?.role === 'admin' &&
                  <a className="chip" href="/admin">ground control</a>}
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
