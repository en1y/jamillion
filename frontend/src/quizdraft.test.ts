// node --test src/*.test.ts  (npm test)
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLIP_SEC, clampSnippet, draftProblems, emptyDraft, fromQuiz, normalizeAnswer,
  prefillAnswers, toPayload,
} from './quizdraft.ts'
import type { Draft, DraftQuestion } from './quizdraft.ts'
import type { ModQuiz } from './moderator.ts'

/** A day that would save: seven rarest questions, one answer each. */
function fillable(): Draft {
  const draft = emptyDraft('2026-09-10')
  draft.questions = draft.questions.map((question, i): DraftQuestion => ({
    ...question, prompt: `Question ${i + 1}`, answers: [{ display: `Answer ${i + 1}`, tier_id: null }],
  }))
  return draft
}

test('a filled day has nothing left to fix', () => {
  assert.deepEqual(draftProblems(fillable()), [])
})

test('an empty day names every missing piece against its own question', () => {
  const problems = draftProblems(emptyDraft('2026-09-10'))
  assert.equal(problems.length, 14)                       // a prompt and an answer, seven times
  assert.ok(problems[0].startsWith('Question 1:'), problems[0])
  assert.ok(problems.at(-1)?.startsWith('Question 7:'), problems.at(-1))
})

test('each qtype carries only its own fields on the wire', () => {
  const draft = fillable()
  draft.questions[0] = { ...draft.questions[0], qtype: 'song',
    track: { id: 42, title: 'Creep', artist: 'Radiohead' },
    snippet_start_sec: 8, snippet_len_sec: 12, ask_artist: true, ask_title: false }
  draft.questions[1] = { ...draft.questions[1], qtype: 'album',
    album: { id: 7, title: 'Kid A', artist: 'Radiohead' } }

  const [song, album, rarest] = toPayload(draft).questions
  assert.deepEqual(song, { position: 1, qtype: 'song', prompt: 'Question 1',
    answers: [{ display: 'Answer 1' }], track_id: 42, snippet_start_sec: 8,
    snippet_len_sec: 12, ask_artist: true, ask_title: false })
  assert.equal(album.album_id, 7)
  assert.equal(album.track_id, undefined)
  assert.equal(album.ask_artist, true)
  // a rarest question never smuggles a track, an album or the ask flags
  for (const key of ['track_id', 'album_id', 'snippet_start_sec', 'ask_artist', 'ask_title'])
    assert.equal(rarest[key], undefined, key)
})

test('a song needs a track and an album needs an album', () => {
  const draft = fillable()
  draft.questions[0] = { ...draft.questions[0], qtype: 'song' }
  draft.questions[1] = { ...draft.questions[1], qtype: 'album' }
  const problems = draftProblems(draft)
  assert.ok(problems.includes('Question 1: needs a track'), problems)
  assert.ok(problems.includes('Question 2: needs an album'), problems)
})

test('a song or album question must ask for something', () => {
  const draft = fillable()
  draft.questions[0] = { ...draft.questions[0], qtype: 'album',
    album: { id: 7, title: 'Kid A', artist: 'Radiohead' }, ask_artist: false, ask_title: false }
  assert.ok(draftProblems(draft).includes('Question 1: must ask for the artist, the title or both'))
})

test('two answers that normalise alike are caught before the unique index does', () => {
  const draft = fillable()
  draft.questions[2] = { ...draft.questions[2],
    answers: [{ display: 'The Bends', tier_id: null }, { display: 'the  bends!', tier_id: null }] }
  assert.ok(draftProblems(draft).some(p => p.startsWith('Question 3: two answers both count as')),
            draftProblems(draft))
})

test('blank answer rows are dropped, not sent', () => {
  const draft = fillable()
  draft.questions[0] = { ...draft.questions[0],
    answers: [{ display: '  Kid A  ', tier_id: 4 }, { display: '   ', tier_id: null }] }
  assert.deepEqual(toPayload(draft).questions[0].answers, [{ display: 'Kid A', tier_id: 4 }])
  assert.deepEqual(draftProblems(draft), [])
})

test('an over-long prompt or answer is refused', () => {
  const draft = fillable()
  draft.questions[0] = { ...draft.questions[0], prompt: 'x'.repeat(501) }
  draft.questions[1] = { ...draft.questions[1], answers: [{ display: 'y'.repeat(101), tier_id: null }] }
  const problems = draftProblems(draft)
  assert.ok(problems.includes('Question 1: prompt is over 500 characters'), problems)
  assert.ok(problems.includes('Question 2: an answer is over 100 characters'), problems)
})

test('the snippet window is clamped inside the clip', () => {
  assert.deepEqual(clampSnippet(8, 12), { start: 8, len: 12 })
  assert.deepEqual(clampSnippet(25, 10), { start: 25, len: 5 })   // 35 would not fit
  assert.deepEqual(clampSnippet(0, 0), { start: 0, len: 1 })      // a window has to exist
  assert.deepEqual(clampSnippet(-1, 10), { start: 0, len: 10 })
  assert.deepEqual(clampSnippet(99, 10), { start: CLIP_SEC - 1, len: 1 })
  assert.deepEqual(clampSnippet(NaN, NaN), { start: 0, len: 1 })
})

test('a snippet that does not fit is reported before the save', () => {
  const draft = fillable()
  draft.questions[0] = { ...draft.questions[0], qtype: 'song',
    track: { id: 42, title: 'Creep', artist: 'Radiohead' },
    snippet_start_sec: 25, snippet_len_sec: 10 }
  assert.ok(draftProblems(draft).includes(`Question 1: snippet does not fit inside the ${CLIP_SEC} second clip`))
})

test('picking a track seeds the answers the moderator would have typed', () => {
  const pick = { id: 42, title: 'Creep', artist: 'Radiohead' }
  // both fields: the full name, plus the artist alone at a lower tier
  assert.deepEqual(prefillAnswers(pick, true, true, 2),
    [{ display: 'Radiohead Creep', tier_id: null }, { display: 'Radiohead', tier_id: 2 }])
  assert.deepEqual(prefillAnswers(pick, true, false), [{ display: 'Radiohead', tier_id: null }])
  assert.deepEqual(prefillAnswers(pick, false, true), [{ display: 'Creep', tier_id: null }])
  // what the client joins as "Artist — Title" reduces to the seeded key
  assert.equal(normalizeAnswer('Radiohead — Creep'), normalizeAnswer('Radiohead Creep'))
})

test('normalising matches the database: lowercase, unaccented, punctuation to spaces', () => {
  assert.equal(normalizeAnswer('The Bends!'), 'the bends')
  assert.equal(normalizeAnswer('Björk'), 'bjork')
  assert.equal(normalizeAnswer('  Sgt.  Pepper’s  '), 'sgt pepper s')
})

test('a saved day opens with its answers, and a rarest question keeps its defaults', () => {
  const quiz: ModQuiz = {
    id: 1, quiz_date: '2026-09-10', published: true, created_by: null,
    attempts_started: 0, attempts_finished: 0,
    questions: [
      { id: 10, position: 1, qtype: 'rarest', prompt: 'Name a band', time_limit_sec: 20,
        snippet_start_sec: null, snippet_len_sec: null, track: null, audio: null, album: null,
        answers: [{ id: 1, display: 'Pixies', normalized: 'pixies', is_correct: true,
                    tier_id: 3, guess_count: 4 }] },
      { id: 11, position: 3, qtype: 'song', prompt: 'This one?', time_limit_sec: 20,
        snippet_start_sec: 8, snippet_len_sec: 12,
        track: { id: 42, title: 'Creep', artist: 'Radiohead' }, audio: '/api/audio/11',
        album: null, ask_artist: false, ask_title: true, answers: [] },
    ],
  }
  const draft = fromQuiz(quiz)
  assert.equal(draft.published, true)
  assert.equal(draft.questions.length, 7)
  assert.deepEqual(draft.questions[0].answers, [{ display: 'Pixies', tier_id: 3 }])
  assert.equal(draft.questions[0].ask_artist, true)          // omitted for rarest, so defaulted
  // position 3, not the second in the array: a gap leaves an empty card behind
  assert.equal(draft.questions[1].qtype, 'rarest')
  assert.equal(draft.questions[1].prompt, '')
  assert.equal(draft.questions[2].track?.id, 42)
  assert.equal(draft.questions[2].snippet_start_sec, 8)
  assert.equal(draft.questions[2].ask_artist, false)
})
