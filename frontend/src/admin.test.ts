import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { rowRange, seedEdit, tierPatch } from './admin.ts'
import type { TierEdit } from './admin.ts'
import type { Tier } from './moderator.ts'

const NEBULA: Tier = { id: 1, name: 'Nebula', points: 10, sort_order: 1, max_share: '1.0000' }
const edit = (over: Partial<TierEdit> = {}): TierEdit => ({ ...seedEdit(NEBULA), ...over })

test('rowRange names the window on screen, never a total', () => {
  assert.equal(rowRange(0, 0), 'nothing here')
  assert.equal(rowRange(100, 0), 'past the end')
  assert.equal(rowRange(0, 50), 'rows 1–50')
  assert.equal(rowRange(50, 50), 'rows 51–100')
  assert.equal(rowRange(50, 7), 'rows 51–57')      // a short page, the last one
})

test('an untouched row patches nothing', () => {
  assert.deepEqual(tierPatch(NEBULA, edit()), { body: {}, problems: [] })
})

test('only the changed field is sent', () => {
  assert.deepEqual(tierPatch(NEBULA, edit({ name: 'Nebulae' })).body, { name: 'Nebulae' })
  assert.deepEqual(tierPatch(NEBULA, edit({ points: '12' })).body, { points: 12 })
  assert.deepEqual(tierPatch(NEBULA, edit({ max_share: '0.5' })).body, { max_share: 0.5 })
})

test('an unchanged share never goes through a float', () => {
  const top: Tier = { ...NEBULA, id: 6, name: 'Supernova', max_share: '0.0020' }
  const { body } = tierPatch(top, { ...seedEdit(top), name: 'Nova' })
  assert.deepEqual(body, { name: 'Nova' })
  assert.equal('max_share' in body, false)
})

test('points take the backend range, and only whole numbers', () => {
  assert.deepEqual(tierPatch(NEBULA, edit({ points: '0' })).body, { points: 0 })
  assert.deepEqual(tierPatch(NEBULA, edit({ points: '010' })).body, { points: 10 })
  for (const bad of ['-1', '32768', '1.5', '', 'abc'])
    assert.deepEqual(tierPatch(NEBULA, edit({ points: bad })).problems,
                     ['points must be a whole number from 0 to 32767'], bad)
})

test('the share is (0, 1]', () => {
  assert.deepEqual(tierPatch(NEBULA, edit({ max_share: '0.0001' })).body, { max_share: 0.0001 })
  const one: Tier = { ...NEBULA, max_share: '0.5000' }
  assert.deepEqual(tierPatch(one, { ...seedEdit(one), max_share: '1' }).body, { max_share: 1 })
  for (const bad of ['0', '1.5', '-0.2', '', 'abc'])
    assert.deepEqual(tierPatch(NEBULA, edit({ max_share: bad })).problems,
                     ['share must be over 0 and at most 1'], bad)
})

test('an emptied name is a problem, not a patch', () => {
  const { body, problems } = tierPatch(NEBULA, edit({ name: '   ' }))
  assert.deepEqual(body, {})
  assert.deepEqual(problems, ['name cannot be empty'])
})
