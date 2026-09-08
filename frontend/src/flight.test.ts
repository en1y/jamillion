// node --test src/*.test.ts  (npm test)
import assert from 'node:assert/strict'
import test from 'node:test'
import type { OwnAnswer, Tier } from './api.ts'
import { altitudeAu, formatDate, HELIOPAUSE_AU, LANDMARKS, passed, PX_PER_AU, shareText, trackPx } from './flight.ts'

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

test('share text is a date, an altitude and one glyph per question', () => {
  const answers = [flew(1, 'Main Sequence', 30), flew(2, null, 0), flew(3, 'Supernova', 100)]
  assert.equal(shareText('2026-09-08', 130, answers, TIERS, 'https://jamillion.test'),
    'JAMILLION 08.09.2026 · 22.3 AU\n⭐⬛💥\nhttps://jamillion.test')
})

test('quiz dates display as dd.mm.yyyy', () => {
  assert.equal(formatDate('2026-09-08'), '08.09.2026')
  assert.equal(formatDate('2026-12-01'), '01.12.2026')
  assert.equal(formatDate('already formatted'), 'already formatted')
})
