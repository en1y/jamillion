// node --test src/*.test.ts  (npm test)
import assert from 'node:assert/strict'
import test from 'node:test'
import type { OwnAnswer, Tier } from './api.ts'
import {
  altitudeAu, bandFor, ceilingFor, countdown, EMPTY_LOG, formatDate, LANDMARKS,
  LEG_MIN, LEG_PER_AU, legs, logDepth, monthGrid, monthLabel, nextIsoDate, nextRollover, parseDate, passed, PLUTO_AU, scoreBands, slug, SUN_RADIUS,
  shareText, shiftDay, shiftMonth, summarize, trackPx, weekday,
} from './flight.ts'

const TIERS: Tier[] = [
  { name: 'Nebula', points: 10 }, { name: 'Protostar', points: 15 },
  { name: 'Main Sequence', points: 30 }, { name: 'Red Giant', points: 60 },
  { name: 'Supergiant', points: 85 }, { name: 'Supernova', points: 100 },
]
const flew = (position: number, tier: string | null, points: number): OwnAnswer =>
  ({ position, raw_text: 'x', correct: tier !== null, tier, points })

test('the ceiling is the key\'s sum for the day, else every question at the top tier', () => {
  const today = { quiz_date: '2026-09-10', question_count: 7, tiers: TIERS }
  assert.equal(ceilingFor(today, { '2026-09-10': 515 }), 515)
  assert.equal(ceilingFor(today, { '2026-09-09': 515 }), 700)   // another day's number is not today's
  assert.equal(ceilingFor(today, {}), 700)
})

test('a perfect day lands on Pluto', () => {
  assert.equal(altitudeAu(0, 700), 0)
  assert.equal(altitudeAu(700, 700), PLUTO_AU)        // a perfect day lands on Pluto
  assert.equal(altitudeAu(250, 500), PLUTO_AU / 2)   // whatever the day's ceiling
  assert.equal(altitudeAu(10, 0), 0)                 // a quiz with no key yet
})

test('the track starts on the Sun\'s rim, climbs monotonically and is clamped', () => {
  assert.equal(trackPx(0), SUN_RADIUS)
  assert.equal(trackPx(-3), SUN_RADIUS)
  assert.equal(trackPx(0.39), SUN_RADIUS + LEG_MIN + LEG_PER_AU * 0.39)   // Mercury, one leg up
  assert.equal(trackPx(500), trackPx(PLUTO_AU))
  for (let au = 0; au < PLUTO_AU; au += 0.5) assert.ok(trackPx(au + 0.5) > trackPx(au))
  // One body on screen at a time: every planet-to-planet leg clears a tall
  // screen with both planets' radii to spare.
  const planets = LANDMARKS.filter(mark => mark.size)
  for (let i = 1; i < planets.length; i++) {
    const gap = trackPx(planets[i].au) - trackPx(planets[i - 1].au)
    assert.ok(gap - (planets[i].size! + planets[i - 1].size!) / 2 >= 1300, planets[i].name)
  }
  assert.ok(trackPx(0.39) - SUN_RADIUS >= 1300, 'Mercury clears the Sun')
  assert.equal(slug('Pluto · Kuiper belt'), 'pluto')
})

test('legs report the body behind and the one ahead, in AU and points', () => {
  const start = legs(0, 700)
  assert.equal(start.behind.name, 'the Sun')
  assert.equal(start.ahead?.name, 'Mercury')
  assert.equal(start.ahead?.points, Math.ceil(0.39 / PLUTO_AU * 700))
  assert.equal(legs(0, 350).ahead?.points, Math.ceil(0.39 / PLUTO_AU * 350))   // a smaller day, fewer points per AU
  const mid = legs(7, 700)
  assert.equal(mid.behind.name, 'Jupiter')
  assert.ok(Math.abs(mid.behind.au - 1.8) < 1e-9)
  assert.equal(mid.ahead?.name, 'Saturn')
  assert.ok(Math.abs(mid.ahead!.au - 2.5) < 1e-9)
  assert.equal(legs(30.1, 700).ahead?.name, 'Pluto')    // the last leg ends at the summit
  assert.equal(legs(PLUTO_AU, 700).ahead, null)
})

test('landmarks climb in order and end at Pluto', () => {
  for (let i = 1; i < LANDMARKS.length; i++) assert.ok(LANDMARKS[i].au > LANDMARKS[i - 1].au, LANDMARKS[i].name)
  assert.equal(LANDMARKS.at(-1)?.au, PLUTO_AU)
})

test('the last landmark below you', () => {
  assert.equal(passed(0.1), 'the Sun')
  assert.equal(passed(1), 'Earth')
  assert.equal(passed(6), 'Jupiter')
  assert.equal(passed(999), 'Pluto')
})

test('share text is a flight id, points, an altitude and one glyph per question', () => {
  const answers = [flew(1, 'Main Sequence', 30), flew(2, null, 0), flew(3, 'Supernova', 100)]
  assert.equal(shareText(12, 130, answers, TIERS, 700),
    'Jamillion #12\n130 pts · 7.3 AU\n\n⭐⬛💥')
})

test('quiz dates display as dd.mm.yyyy', () => {
  assert.equal(formatDate('2026-09-08'), '08.09.2026')
  assert.equal(formatDate('2026-12-01'), '01.12.2026')
  assert.equal(formatDate('already formatted'), 'already formatted')
  assert.equal(parseDate('08.09.2026'), '2026-09-08')
  assert.equal(parseDate(' 01.12.2026 '), '2026-12-01')
  assert.equal(parseDate(formatDate('2026-02-28')), '2026-02-28')
  for (const bad of ['31.02.2026', '00.09.2026', '08.13.2026', '8.9.2026', '2026-09-08', ''])
    assert.equal(parseDate(bad), '', bad)
})

test('the calendar grid lines every month up under a Monday-first week', () => {
  // September 2026 opens on a Tuesday and runs 30 days: one blank, then the month.
  const september = monthGrid('2026-09-08')
  assert.equal(september.length, 31)
  assert.deepEqual(september.slice(0, 3), [null, '2026-09-01', '2026-09-02'])
  assert.equal(september.at(-1), '2026-09-30')
  // February 2026 opens on a Sunday: six blanks. February 2027 opens on a Monday: none.
  assert.equal(monthGrid('2026-02-14').filter(cell => cell === null).length, 6)
  assert.equal(monthGrid('2027-02-14')[0], '2027-02-01')
  assert.equal(monthGrid('2028-02-01').at(-1), '2028-02-29', 'a leap day is a day')
  assert.equal(weekday('2026-09-07'), 0, 'Monday is 0')
  assert.equal(weekday('2026-09-13'), 6, 'Sunday is 6')
  assert.equal(monthLabel('2026-09-08'), 'September 2026')
})

test('the calendar cursor steps over month and year edges without drifting', () => {
  assert.equal(shiftDay('2026-09-08', 1), '2026-09-09')
  assert.equal(shiftDay('2026-09-30', 1), '2026-10-01')
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31')
  assert.equal(shiftDay('2026-09-08', 7), '2026-09-15')
  assert.equal(shiftMonth('2026-09-08', 1), '2026-10-08')
  assert.equal(shiftMonth('2026-01-15', -1), '2025-12-15')
  assert.equal(shiftMonth('2026-03-31', -1), '2026-02-28', 'a short month clamps, it does not roll')
  assert.equal(shiftMonth('2028-01-31', 1), '2028-02-29')
})

test('the flight log drops rarer tiers further, a miss stays at the sun', () => {
  assert.equal(logDepth(null, false), 0.03)
  assert.equal(logDepth('Nebula', true), 0.08)
  assert.equal(logDepth('Main Sequence', true), 0.36)
  assert.equal(logDepth('Supernova', true), 0.97)
  assert.ok(logDepth('Nebula', true) < logDepth('Supernova', true))
})

test('the bearing picks the rarest band the score still reaches', () => {
  assert.equal(bandFor(0, 700).tier, 'Nebula')
  assert.equal(bandFor(150, 700).tier, 'Nebula')
  assert.equal(bandFor(151, 700).tier, 'Main Sequence')
  assert.equal(bandFor(449, 700).tier, 'Supergiant')
  assert.equal(bandFor(450, 700).tier, 'Supernova')
  assert.equal(bandFor(700, 700).tier, 'Supernova')
  // the bands scale with the day: half the ceiling, half the thresholds
  assert.equal(bandFor(225, 350).tier, 'Supernova')
  assert.equal(bandFor(224, 350).tier, 'Supergiant')
  assert.deepEqual(scoreBands(700).map(band => band.range), ['0–150', '151–250', '251–350', '351–449', '450+'])
  assert.equal(scoreBands(350)[4].range, '225+')
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
