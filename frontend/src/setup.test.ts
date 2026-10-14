import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { describeDuration, estimateSeconds, phaseLine, secondsLeft } from './setup.ts'
import type { SeedProgress } from './setup.ts'

test('a chart run is full artists until the cap, skinny after it', () => {
  assert.equal(estimateSeconds({ source: 'lastfm', limit: 50, full: 1000, youtube: true }, false), 50 * 45)
  assert.equal(estimateSeconds({ source: 'lastfm', limit: 50, full: 1000, youtube: false }, false), 50 * 15)
  assert.equal(estimateSeconds({ source: 'lastfm', limit: 1200, full: 1000, youtube: true }, true), 1000 * 45 + 200 * 0.4)
})

test('a first Wikidata run pays for the ranking pass once, and never counts past the list', () => {
  const cold = estimateSeconds({ source: 'wikidata', limit: 50000, full: 0, youtube: true }, false)
  const warm = estimateSeconds({ source: 'wikidata', limit: 50000, full: 0, youtube: true }, true)
  assert.equal(warm, 35_000 * 0.4)
  assert.equal(cold - warm, 80 * 60)
})

test('durations read like a person would say them', () => {
  assert.equal(describeDuration(40), 'under a minute')
  assert.equal(describeDuration(90), 'about 2 minutes')
  assert.equal(describeDuration(50 * 45), 'about 38 minutes')
  assert.equal(describeDuration(3600), 'about 1 hour')
  assert.equal(describeDuration(5400), 'about 1.5 hours')
  assert.equal(describeDuration(17 * 3600 + 1000), 'about 17 hours')
})

test('time left is measured from how fast this run moves', () => {
  assert.equal(secondsLeft({ at: 0, done: 0 }, { at: 60, done: 30 }, 90), 120)
  assert.equal(secondsLeft({ at: 0, done: 10 }, { at: 0, done: 10 }, 90), null)     // nothing measured yet
  assert.equal(secondsLeft({ at: 0, done: 0 }, { at: 60, done: 90 }, 90), null)     // done
})

const progress = (over: Partial<SeedProgress>): SeedProgress => ({
  state: 'running', phase: 'seeding', source: 'wikidata', started: 0, limit: 200, full_cap: 5,
  full: 5, skinny: 195, done: 3, total: 200, failed: 0, artist: '', ...over,
})

test('the phase line says what the seeder is doing right now', () => {
  assert.equal(phaseLine(progress({ artist: 'Beyoncé' }), true), 'Working on Beyoncé…')
  assert.match(phaseLine(progress({ state: 'preparing', phase: 'ranking', done: 1200, total: 34915 }), true), /^Ranking by Deezer fans: 1,200 of 34,915/)
  assert.match(phaseLine(progress({ state: 'preparing', phase: 'wikidata', done: 9983, total: 0 }), true), /Wikidata: 9,983 so far/)
  assert.equal(phaseLine(progress({ state: 'interrupted' }), false), 'The last run stopped early. Start it again to carry on: what landed stays, and is only refreshed.')
  assert.equal(phaseLine(progress({ state: 'finished', done: 200, failed: 4 }), false), 'Last run: 200 processed, 4 failed.')
})
