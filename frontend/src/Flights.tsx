// The flight log: every flight this passport has flown. Signed in, that is the
// whole account; as a guest, this browser's cookie.
import { useQuery } from '@tanstack/react-query'
import { ApiError, getFlights } from './api'
import type { Today } from './api'
import { altitudeAu, emojiFor, formatDate, summarize } from './flight'

export function Flights({ token, signedIn, tiers, ceilings }: {
  ceilings: Record<string, number>
  token?: string
  signedIn: boolean
  tiers: Today['tiers'] | undefined
}) {
  // The same key Results reads its logbook from, so the two share one request.
  // An empty list covers both "no flights yet" and the 401 a passport-less
  // browser gets, which read the same to a player.
  const recorder = useQuery({ queryKey: ['flights', token], queryFn: () => getFlights(token) })
  const flights = recorder.error ? [] : recorder.data
  const error = recorder.error instanceof ApiError && recorder.error.status === 401 ? '' : recorder.error?.message ?? ''

  const log = summarize(flights ?? [])
  // Heights on each day's own scale, so they are averaged as heights, not points.
  const heights = (flights ?? []).map(flight => altitudeAu(flight.total_points, ceilings[flight.quiz_date] ?? 0))
  const bestAu = Math.max(0, ...heights)
  const avgAu = heights.length ? heights.reduce((sum, au) => sum + au, 0) / heights.length : 0

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
          <span className="stat"><small>BEST</small>{bestAu.toFixed(1)} AU</span>
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
                  <b>{altitudeAu(flight.total_points, ceilings[flight.quiz_date] ?? 0).toFixed(1)} AU</b>
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
