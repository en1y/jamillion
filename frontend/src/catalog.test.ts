// node --test src/*.test.ts  (npm test)
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  answerText, cell, columnsFor, defaultOp, fieldLabel, splitField, spreadTiers, toPick, usable,
} from './catalog.ts'
import type { Row } from './catalog.ts'

const yellow = {
  id: 5, 'track.title': 'Yellow', 'artist.name': 'Coldplay', 'album.title': 'Parachutes',
  'album.cover_url': 'https://cover', 'track.lastfm_listeners': 3650716, 'track.year': 2000,
} as unknown as Row

test('a field key reads as a group and plain words', () => {
  assert.deepEqual(splitField('artist.lastfm_listeners'), ['artist', 'lastfm listeners'])
  assert.equal(fieldLabel('track.has_preview'), 'track · has preview')
})

test('a text field starts on contains, a number on at least', () => {
  assert.equal(defaultOp('text'), 'contains')
  assert.equal(defaultOp('number'), 'gte')
})

test('a filter still being typed is not sent, one that reads a column is', () => {
  assert.deepEqual(usable([
    { field: 'artist.name', op: 'eq', value: '' },
    { field: 'artist.name', op: 'eq', value: 'Adele' },
    { field: 'track.bpm', op: 'notnull', value: '' },
  ]).map(filter => filter.op + ':' + filter.value), ['eq:Adele', 'notnull:'])
})

test('a row becomes the answer the moderator asked for', () => {
  assert.equal(answerText(yellow, 'tracks', 'title'), 'Yellow')
  assert.equal(answerText(yellow, 'tracks', 'artist'), 'Coldplay')
  assert.equal(answerText(yellow, 'tracks', 'artist-title'), 'Coldplay — Yellow')
  // An artist search has one name, whichever shape is selected.
  assert.equal(answerText(yellow, 'artists', 'artist-title'), 'Coldplay')
})

test('a row becomes the pick a song or album question is built on', () => {
  // album rides along: a song question that asks which record it is from seeds
  // its answer key from this without a second request.
  assert.deepEqual(toPick(yellow, 'tracks'),
    { id: 5, title: 'Yellow', artist: 'Coldplay', cover: 'https://cover', album: 'Parachutes' })
  assert.equal(toPick(yellow, 'albums').album, null)
})

test('the columns shown are the identity plus whatever was filtered or sorted on', () => {
  assert.deepEqual(
    columnsFor('tracks', [{ field: 'artist.name', op: 'eq', value: 'Coldplay' }],
               [{ field: 'track.lastfm_listeners', dir: 'desc' }]),
    ['artist.name', 'track.title', 'album.title', 'track.ytmusic_plays', 'track.lastfm_listeners'])
  assert.deepEqual(columnsFor('tracks', [], [{ field: 'track.ytmusic_plays', dir: 'desc' }]),
    ['artist.name', 'track.title', 'album.title', 'track.ytmusic_plays'], 'a sort on a default column adds nothing')
})

test('big numbers group, years do not, and nothing is blank', () => {
  assert.equal(cell('track.lastfm_listeners', 3650716), '3,650,716')
  assert.equal(cell('track.year', 2000), '2000')
  assert.equal(cell('track.has_preview', false), 'no')
  assert.equal(cell('artist.country', null), '—')
})

test('tiers spread down the ladder in the order the results are shown', () => {
  const ladder = [1, 2, 3, 4, 5, 6]                      // Nebula .. Supernova
  const spread = spreadTiers(25, ladder)
  assert.equal(spread[0], 1)                             // the top of the sort is the common one
  assert.equal(spread[24], 6)                            // the bottom is the rare one
  assert.deepEqual([...spread].sort((a, b) => (a as number) - (b as number)), spread)   // never goes back up
  // a couple at each end, the rest divided evenly
  const sizes = ladder.map(id => spread.filter(one => one === id).length)
  assert.deepEqual(sizes, [3, 5, 4, 5, 5, 3], String(sizes))

  // fewer results than tiers still reaches both ends
  assert.deepEqual(spreadTiers(3, ladder), [1, 4, 6])
  assert.deepEqual(spreadTiers(1, ladder), [1])
  assert.deepEqual(spreadTiers(0, ladder), [])
  // no tiers loaded yet: everything stays on rarity
  assert.deepEqual(spreadTiers(2, []), [null, null])
})
