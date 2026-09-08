// The flight log: every flight this passport has flown. Signed in, that is the
// whole account; as a guest, this browser's cookie.
import { useEffect, useState } from 'react'
import { ApiError, getFlights } from './api'
import type { Flight, Today } from './api'
import { altitudeAu, emojiFor, formatDate, summarize } from './flight'

export function Flights({ token, signedIn, tiers }: {
  token?: string
  signedIn: boolean
  tiers: Today['tiers'] | undefined
}) {
  // Keyed to the identity, like App does: a result for an older token is simply
  // not this key's, so loading is derived rather than reset inside the effect.
  // An empty list covers both "no flights yet" and the 401 a passport-less
  // browser gets, which read the same to a player.
  const key = token ?? 'guest'
  const [result, setResult] = useState<{ key: string; flights: Flight[]; error: string } | null>(null)

  useEffect(() => {
    let live = true
    getFlights(token)
      .then(next => { if (live) setResult({ key, flights: next, error: '' }) })
      .catch((cause: unknown) => {
        if (!live) return
        const fatal = !(cause instanceof ApiError && cause.status === 401)
        setResult({ key, flights: [], error: fatal && cause instanceof Error ? cause.message : '' })
      })
    return () => { live = false }
  }, [token, key])

  const flights = result?.key === key ? result.flights : undefined
  const error = result?.key === key ? result.error : ''

  const log = summarize(flights ?? [])
  const avgAu = log.played ? altitudeAu(log.total / log.played) : 0

  return (
    <section className="panel" aria-labelledby="flights-heading">
      <p className="eyebrow">FLIGHT LOG</p>
      <h2 id="flights-heading">Where you have been</h2>

      {flights === undefined && <p role="status">Reading the flight recorder…</p>}
      {error && <p className="notice" role="alert">{error}</p>}

      {flights && flights.length > 0 && <>
        <div className="stats logbook-stats">
          <span className="stat"><small>FLIGHTS</small>{log.played}</span>
          <span className="stat"><small>STREAK</small>{log.streak}</span>
          <span className="stat"><small>BEST</small>{altitudeAu(log.best).toFixed(1)} AU</span>
          <span className="stat"><small>AVERAGE</small>{avgAu.toFixed(1)} AU</span>
        </div>

        <ul className="flights">
          {flights.map(flight => (
            <li key={flight.quiz_date}>
              <details>
                <summary>
                  <span className="n">#{flight.flight_no}</span>
                  <span className="said">
                    <small>{formatDate(flight.quiz_date)}{flight.finished ? '' : ' · in flight'}</small>
                    <span className="grid" aria-hidden="true">
                      {tiers
                        ? flight.answers.map(answer => emojiFor(answer, tiers)).join('')
                        : `${flight.answers.length} answered`}
                    </span>
                  </span>
                  <b>{flight.height_au.toFixed(1)} AU</b>
                  <span className="more" aria-hidden="true" />
                </summary>
                <ul className="sheet">
                  {flight.answers.map(answer => (
                    <li key={answer.position}>
                      <span className="glyph">{tiers ? emojiFor(answer, tiers) : answer.position}</span>
                      <span className="said">
                        {answer.raw_text.trim() || 'skipped'}
                        <small>{answer.correct ? answer.tier : 'no points'}</small>
                      </span>
                      <b>+{answer.points}</b>
                    </li>
                  ))}
                  {flight.answers.length === 0 && <li className="meta">nothing logged for this flight</li>}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </>}

      {flights?.length === 0 && !error && <p>No flights logged yet. The launchpad is that way.</p>}

      <p className="meta">{signedIn
        ? 'Your flights follow your account, whichever browser you fly from.'
        : 'This log lives on your guest passport. Sign in to carry it to another browser.'}</p>
    </section>
  )
}
