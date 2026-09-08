// node --test src/*.test.ts  (npm test)
import assert from 'node:assert/strict'
import test from 'node:test'
import type { OwnAnswer, Tier } from './api.ts'
import {
  altitudeAu, bandFor, countdown, EMPTY_LOG, formatDate, HELIOPAUSE_AU, LANDMARKS,
  logDepth, nextIsoDate, nextRollover, passed, PX_PER_AU, shareText, summarize, trackPx,
} from './flight.ts'

const TIERS: Tier[] = [
  { name: 'Nebula', points: 10 }, { name: 'Protostar', points: 15 },
  { name: 'Main Sequence', points: 30 }, { name: 'Red Giant', points: 60 },
  { name: 'Supergiant', points: 85 }, { name: 'Supernova', points: 100 },
]
const flew = (position: number, tier: string | null, points: number): OwnAnswer =>
  ({ position, raw_text: 'x', correct: tier !== null, tier, points })

test('a perfect run reaches the heliopause', () => {
  assert.equal(altitudeAu(0), 0)
  assert.ok(Math.abs(altitudeAu(700) - HELIOPAUSE_AU) < 0.1, String(altitudeAu(700)))
})

test('the track is linear and clamped', () => {
  assert.equal(trackPx(0), 0)
  assert.equal(trackPx(HELIOPAUSE_AU), HELIOPAUSE_AU * PX_PER_AU)
  assert.equal(trackPx(500), HELIOPAUSE_AU * PX_PER_AU)
  assert.equal(trackPx(-3), 0)
  // The same points move the same distance wherever you are.
  const step = (from: number) => trackPx(altitudeAu(from + 10)) - trackPx(altitudeAu(from))
  assert.ok(Math.abs(step(0) - step(600)) < 1e-9, `${step(0)} vs ${step(600)}`)
})

test('landmarks climb in order and end at the heliopause', () => {
  for (let i = 1; i < LANDMARKS.length; i++) assert.ok(LANDMARKS[i].au > LANDMARKS[i - 1].au, LANDMARKS[i].name)
  assert.equal(LANDMARKS.at(-1)?.au, HELIOPAUSE_AU)
})

test('the last landmark below you', () => {
  assert.equal(passed(0.1), 'the Sun')
  assert.equal(passed(1), 'Earth')
  assert.equal(passed(6), 'Jupiter')
  assert.equal(passed(999), 'Heliopause')
})

test('share text is a flight id, an altitude and one glyph per question', () => {
  const answers = [flew(1, 'Main Sequence', 30), flew(2, null, 0), flew(3, 'Supernova', 100)]
  assert.equal(shareText(12, 130, answers, TIERS),
    'JAMILLION #12\n22.3 AU\n\n⭐⬛💥')
})

test('quiz dates display as dd.mm.yyyy', () => {
  assert.equal(formatDate('2026-09-08'), '08.09.2026')
  assert.equal(formatDate('2026-12-01'), '01.12.2026')
  assert.equal(formatDate('already formatted'), 'already formatted')
})

test('the flight log drops rarer tiers further, a miss stays at the sun', () => {
  assert.equal(logDepth(null, false), 0.03)
  assert.equal(logDepth('Nebula', true), 0.08)
  assert.equal(logDepth('Main Sequence', true), 0.36)
  assert.equal(logDepth('Supernova', true), 0.97)
  assert.ok(logDepth('Nebula', true) < logDepth('Supernova', true))
})

test('the bearing picks the rarest band the score still reaches', () => {
  assert.equal(bandFor(0).tier, 'Nebula')
  assert.equal(bandFor(150).tier, 'Nebula')
  assert.equal(bandFor(151).tier, 'Main Sequence')
  assert.equal(bandFor(449).tier, 'Supergiant')
  assert.equal(bandFor(450).tier, 'Supernova')
  assert.equal(bandFor(700).tier, 'Supernova')
})

test('the logbook is derived from the flights the server reports, newest first', () => {
  // ponytail: a plain object per flight; only the two fields summarize() reads.
  const flown = (quiz_date: string, total_points: number) =>
    ({ quiz_date, total_points, flight_no: 1, height_au: 0, finished: true, answers: [] })

  assert.deepEqual(summarize([]), EMPTY_LOG)

  const one = summarize([flown('2026-09-08', 40)])
  assert.equal(one.played, 1)
  assert.equal(one.streak, 1)
  assert.equal(one.best, 40)
  assert.equal(one.lastDate, '2026-09-08')

  const run = summarize([flown('2026-09-10', 10), flown('2026-09-09', 40), flown('2026-09-08', 30)])
  assert.equal(run.streak, 3)
  assert.equal(run.played, 3)
  assert.equal(run.total, 80)
  assert.equal(run.best, 40)

  // a missing day breaks the streak but not the totals
  const gap = summarize([flown('2026-09-11', 80), flown('2026-09-09', 40), flown('2026-09-08', 30)])
  assert.equal(gap.streak, 1)
  assert.equal(gap.played, 3)
  assert.equal(gap.best, 80)

  // an unfinished flight still counts: it is a day you showed up
  const today = summarize([{ ...flown('2026-09-12', 0), finished: false }, flown('2026-09-11', 60)])
  assert.equal(today.streak, 2)
  assert.equal(today.played, 2)
})

test('iso dates step in UTC so a streak does not depend on the browser timezone', () => {
  assert.equal(nextIsoDate('2026-09-08'), '2026-09-09')
  assert.equal(nextIsoDate('2026-12-31'), '2027-01-01')
})

test('the next flight is the coming 04:00 UTC rollover', () => {
  const before = Date.UTC(2026, 8, 8, 3, 59, 0)
  const after = Date.UTC(2026, 8, 8, 4, 0, 0)
  assert.equal(nextRollover(before).toISOString(), '2026-09-08T04:00:00.000Z')
  assert.equal(nextRollover(after).toISOString(), '2026-09-09T04:00:00.000Z')
  assert.equal(countdown(new Date(before + 65_000), before), '00:01:05')
  assert.equal(countdown(new Date(before), before), 'ready')
})
