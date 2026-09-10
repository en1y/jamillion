import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeOf } from './routing.ts'

test('a path reads as a screen and one argument', () => {
  assert.deepEqual(routeOf('/'), ['', ''])
  assert.deepEqual(routeOf('/account'), ['account', ''])
  assert.deepEqual(routeOf('/editor'), ['editor', ''])
  assert.deepEqual(routeOf('/editor/2026-09-09'), ['editor', '2026-09-09'])
  assert.deepEqual(routeOf('/admin/tiers'), ['admin', 'tiers'])
  // a trailing slash is the screen with no argument, not a screen called ''
  assert.deepEqual(routeOf('/editor/'), ['editor', ''])
  // anything past the second segment is ignored rather than throwing
  assert.deepEqual(routeOf('/editor/2026-09-09/extra'), ['editor', '2026-09-09'])
})
