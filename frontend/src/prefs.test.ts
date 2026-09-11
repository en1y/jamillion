// node --test src/*.test.ts  (npm test)
import assert from 'node:assert/strict'
import test from 'node:test'
import { readPrefs, voicesFor } from './prefs.ts'
import { tierSlug } from './flight.ts'

test('a missing or broken settings row falls back to the defaults', () => {
  for (const raw of [null, '', 'not json', '{', '[]']) {
    const prefs = readPrefs(raw)
    assert.equal(prefs.sfx, true)
    assert.equal(prefs.tiers, 'art')
    assert.equal(prefs.planets, 'render')
  }
})

test('junk values are dropped key by key, the rest is kept', () => {
  const prefs = readPrefs(JSON.stringify({ sfx: 'yes', sfxVolume: 4, music: 0.2, planets: 'martian', tiers: 'emoji' }))
  assert.equal(prefs.sfx, true)          // not a boolean
  assert.equal(prefs.sfxVolume, 0.5)     // out of range
  assert.equal(prefs.music, 0.2)         // kept
  assert.equal(prefs.planets, 'render')  // not a skin
  assert.equal(prefs.tiers, 'emoji')     // kept
})

test('a hit climbs the arpeggio with the tier, a Nebula gets two notes', () => {
  const notes = (rank: number) => voicesFor('hit', rank).map(voice => voice.from)
  assert.equal(notes(0).length, 2)
  assert.equal(notes(5).length, 6)
  assert.deepEqual(notes(5), [...notes(5)].sort((a, b) => a - b))   // it climbs
  assert.equal(notes(99).length, 6)                                 // and never past the top
})

test('every cue makes at least one note', () => {
  for (const cue of ['brief', 'type', 'send', 'hit', 'miss', 'tick', 'expire', 'click', 'land'] as const)
    assert.ok(voicesFor(cue).length > 0, cue)
})

test('a tier badge is its file in public/tiers', () => {
  assert.equal(tierSlug('Main Sequence'), 'main-sequence')
  assert.equal(tierSlug('Red Giant'), 'red-giant')
  assert.equal(tierSlug('Nebula'), 'nebula')
})
