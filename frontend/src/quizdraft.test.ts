// node --test src/*.test.ts  (npm test)
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLIP_SEC, asksOf, clampSnippet, defaultTimeLimit, draftProblems, emptyDraft, expandAnswers,
  fromQuiz, fullAnswerPoints, normalizeAnswer, prefillAnswers, reseedAnswers, toPayload,
} from './quizdraft.ts'
import type { Draft, DraftQuestion } from './quizdraft.ts'
import type { ModQuiz } from './moderator.ts'

/** points only: enough to rank two tiers against each other. */
const TIERS = [{ id: 1, points: 10 }, { id: 2, points: 15 }, { id: 3, points: 30 },
               { id: 4, points: 60 }, { id: 5, points: 85 }, { id: 6, points: 100 }]

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
  const problems = draftProblems(emptyDraft('2026-09-10'), TIERS)
  assert.equal(problems.length, 14)                       // a prompt and an answer, seven times
  assert.ok(problems[0].startsWith('Question 1:'), problems[0])
  assert.ok(problems.at(-1)?.startsWith('Question 7:'), problems.at(-1))
})

test('each qtype carries only its own fields on the wire', () => {
  const draft = fillable()
  draft.questions[0] = { ...draft.questions[0], qtype: 'song', time_limit_sec: 0,
    track: { id: 42, title: 'Creep', artist: 'Radiohead', album: 'Pablo Honey' },
    snippet_start_sec: 8, snippet_len_sec: 12,
    ask_artist: true, ask_title: false, ask_album: true }
  draft.questions[1] = { ...draft.questions[1], qtype: 'album',
    album: { id: 7, title: 'Kid A', artist: 'Radiohead' }, ask_album: true }

  const [song, album, rarest] = toPayload(draft, TIERS).questions
  assert.deepEqual(song, { position: 1, qtype: 'song', prompt: 'Question 1',
    time_limit_sec: 0, answers: [{ display: 'Answer 1' }], track_id: 42,
    snippet_start_sec: 8, snippet_len_sec: 12,
    ask_artist: true, ask_title: false, ask_album: true })
  assert.equal(album.album_id, 7)
  assert.equal(album.track_id, undefined)
  assert.equal(album.ask_artist, true)
  // ask_album is a song question's field; the backend refuses it on an album one
  assert.equal(album.ask_album, undefined)
  // a rarest question never smuggles a track, an album or the ask flags
  for (const key of ['track_id', 'album_id', 'snippet_start_sec', 'ask_artist', 'ask_title', 'ask_album'])
    assert.equal(rarest[key], undefined, key)
})

test('a song needs a track and an album needs an album', () => {
  const draft = fillable()
  draft.questions[0] = { ...draft.questions[0], qtype: 'song' }
  draft.questions[1] = { ...draft.questions[1], qtype: 'album' }
  const problems = draftProblems(draft, TIERS)
  assert.ok(problems.includes('Question 1: needs a track'), problems)
  assert.ok(problems.includes('Question 2: needs an album'), problems)
})

test('a song or album question must ask for something', () => {
  const draft = fillable()
  draft.questions[0] = { ...draft.questions[0], qtype: 'album',
    album: { id: 7, title: 'Kid A', artist: 'Radiohead' }, ask_artist: false, ask_title: false }
  assert.ok(draftProblems(draft, TIERS).includes('Question 1: must ask for at least one field'))
  // ask_album does not rescue an album question: the backend refuses it there
  draft.questions[0] = { ...draft.questions[0], ask_album: true }
  assert.ok(draftProblems(draft, TIERS).includes('Question 1: must ask for at least one field'))
})

test('a song question defaults to no clock and a rarest one keeps the 20 s timer', () => {
  assert.equal(defaultTimeLimit('rarest'), 20)
  assert.equal(defaultTimeLimit('song'), 0)
  assert.equal(defaultTimeLimit('album'), 0)
  const draft = fillable()
  draft.questions[0] = { ...draft.questions[0], time_limit_sec: 3 }
  assert.ok(draftProblems(draft, TIERS).includes('Question 1: time limit must be off or between 5 and 60 seconds'))
  draft.questions[0] = { ...draft.questions[0], time_limit_sec: 0 }
  assert.equal(draftProblems(draft, TIERS).length, 0)
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
  const problems = draftProblems(draft, TIERS)
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
  assert.ok(draftProblems(draft, TIERS).includes(`Question 1: snippet does not fit inside the ${CLIP_SEC} second clip`))
})

const PICK = { id: 42, title: 'Creep', artist: 'Radiohead', album: 'Pablo Honey' }
const said = (rows: { display: string; tier_id: number | null }[]) =>
  rows.map(row => `${row.display}/${row.tier_id}`)

test('a pick seeds one row per field asked for, and nothing else', () => {
  assert.deepEqual(said(prefillAnswers(PICK, { artist: true, title: true, album: false }, 2)),
    ['Radiohead/2', 'Creep/2'])
  assert.deepEqual(said(prefillAnswers(PICK, { artist: true, title: true, album: true }, 2)),
    ['Radiohead/2', 'Creep/2', 'Pablo Honey/2'])
  assert.deepEqual(said(prefillAnswers(PICK, { artist: false, title: true, album: false }, 2)),
    ['Creep/2'])
  // What Play joins with an em dash reduces to the same key the combination does.
  assert.equal(normalizeAnswer('Radiohead — Creep'), normalizeAnswer('Radiohead Creep'))
})

const worth = (rows: { display: string; tier_id: number | null; points?: number }[]) =>
  rows.map(row => `${row.display}/${row.points ?? 'tier' + row.tier_id}`)

test('a combination is worth its fields added up', () => {
  const song = { ...emptyDraft('2026-09-10').questions[0], qtype: 'song' as const,
    track: PICK, ask_artist: true, ask_title: true, ask_album: true, full_tier_id: null,
    answers: prefillAnswers(PICK, { artist: true, title: true, album: true }, 2) }   // 15 pts each

  // No bonus: everything right is simply the three fields, 15 + 15 + 15.
  assert.deepEqual(worth(expandAnswers(song, TIERS)), [
    'Radiohead — Creep — Pablo Honey/45',
    'Creep — Pablo Honey/30', 'Radiohead — Pablo Honey/30', 'Pablo Honey/tier2',
    'Radiohead — Creep/30', 'Creep/tier2', 'Radiohead/tier2'])
  assert.equal(fullAnswerPoints(song, TIERS), 45)

  // A bonus is added on top of the sum, and only to the full set.
  const bonus = { ...song, full_tier_id: 3 }                       // Main Sequence, 30
  assert.equal(fullAnswerPoints(bonus, TIERS), 75)
  const rows = expandAnswers(bonus, TIERS)
  assert.equal(rows[0].points, 75)
  assert.equal(rows[0].tier_id, 3)                                  // the bonus names the star
  assert.equal(rows.find(row => row.display === 'Radiohead — Creep')?.points, 30)

  // Fields can be worth different amounts, and the sums follow.
  const uneven = { ...song, answers: song.answers.map((row, i) => i === 1 ? { ...row, tier_id: 4 } : row) }
  assert.equal(fullAnswerPoints(uneven, TIERS), 15 + 60 + 15)
  assert.equal(expandAnswers(uneven, TIERS).find(r => r.display === 'Radiohead — Creep')?.points, 75)

  // A single field is worth exactly its tier, so it carries no override -- the
  // review queue's tier select still works on those rows.
  assert.ok(expandAnswers(song, TIERS).filter(row => !row.display.includes(' — '))
    .every(row => row.points === undefined))

  // One field asked: no combination to make, and that row is the whole answer.
  const alone = { ...song, ask_title: false, ask_album: false,
                  answers: prefillAnswers(PICK, { artist: true, title: false, album: false }, 2) }
  assert.deepEqual(worth(expandAnswers(alone, TIERS)), ['Radiohead/tier2'])
  assert.equal(fullAnswerPoints(alone, TIERS), 15)

  // A field left "by rarity" has no fixed value, so any combination containing it
  // falls back to a tier -- while the combinations that avoid it still add up.
  const loose = { ...song, answers: song.answers.map((row, i) => i === 0 ? { ...row, tier_id: null } : row) }
  assert.equal(fullAnswerPoints(loose, TIERS), undefined)
  const byRarity = expandAnswers(loose, TIERS)
  assert.ok(byRarity.filter(row => row.display.includes('Radiohead'))
    .every(row => row.points === undefined && row.tier_id === null))
  assert.equal(byRarity.find(row => row.display === 'Creep — Pablo Honey')?.points, 30)

  // A field the moderator marked "worth nothing" contributes nothing, and the
  // single row keeps the 0 rather than falling back to its tier.
  const free = { ...song, answers: song.answers.map((row, i) => i === 2 ? { ...row, points: 0 } : row) }
  assert.equal(fullAnswerPoints(free, TIERS), 30)
  const freeRows = expandAnswers(free, TIERS)
  assert.equal(freeRows.find(row => row.display === 'Pablo Honey')?.points, 0)
  assert.equal(freeRows.find(row => row.display === 'Creep — Pablo Honey')?.points, 15)
  assert.equal(freeRows[0].points, 30)

  // Rows the moderator typed pass through, never folded into a combination.
  const withAlias = { ...song, answers: [...song.answers, { display: 'Radiohed', tier_id: 4 }] }
  assert.ok(worth(expandAnswers(withAlias, TIERS)).includes('Radiohed/tier4'))
  assert.ok(!expandAnswers(withAlias, TIERS).some(row => row.display.includes('Radiohed —')))
})

test('reseeding rewrites its own rows and leaves the moderator\'s alone', () => {
  const question = { ...emptyDraft('2026-09-10').questions[0], qtype: 'song' as const,
    track: { id: 42, title: 'Creep', artist: 'Radiohead', album: 'Pablo Honey' },
    answers: [{ display: 'stale seed', tier_id: null, seeded: true },
              { display: 'creep!', tier_id: 5 },                 // says the same as a seed
              { display: 'Radiohed', tier_id: 4 }] }             // a typo the moderator wants

  const rows = reseedAnswers(question, 2)
  assert.ok(!rows.some(row => row.display === 'stale seed'), rows)
  // the hand-typed duplicate loses to the seed rather than becoming a clash
  assert.equal(rows.filter(row => normalizeAnswer(row.display) === 'creep').length, 1)
  assert.deepEqual(rows.filter(row => !row.seeded), [{ display: 'Radiohed', tier_id: 4 }])
  assert.equal(draftProblems({ quiz_date: '2026-09-10', published: false,
    questions: [{ ...question, prompt: 'x', answers: rows },
                ...emptyDraft('2026-09-10').questions.slice(1)] }, TIERS)
    .filter(problem => problem.startsWith('Question 1:')).length, 0)
})

test('asking for an album a track has none of is caught before the save', () => {
  const draft = fillable()
  draft.questions[0] = { ...draft.questions[0], qtype: 'song', ask_album: true,
    track: { id: 42, title: 'Creep', artist: 'Radiohead' },        // no album recorded
    answers: [{ display: 'Creep', tier_id: null }] }
  assert.ok(draftProblems(draft, TIERS)
    .includes('Question 1: asks for the album, but the catalog has no album for that track'), draft)
})

test('a rarest question asks for no fields, so it has no all-of-them row', () => {
  const rarest = { ...emptyDraft('2026-09-10').questions[0], ask_artist: true, ask_title: true }
  assert.deepEqual(asksOf(rarest), { artist: false, title: false, album: false })
  assert.equal(asksOf({ ...rarest, qtype: 'song' }).artist, true)
})

test('a saved day reopens as fields and a full-answer tier, not the flat key', () => {
  const song = { ...emptyDraft('2026-09-10').questions[0], qtype: 'song' as const,
    track: PICK, ask_artist: true, ask_title: true, ask_album: true, full_tier_id: 6,
    answers: [...prefillAnswers(PICK, { artist: true, title: true, album: true }, 2),
              { display: 'Radiohed', tier_id: 4 }] }

  // What the backend stores, handed back the way getQuiz reports it: flat, and
  // with no idea which row was a field and which was a combination.
  const stored: ModQuiz = {
    id: 1, quiz_date: '2026-09-10', published: false, created_by: null,
    attempts_started: 0, attempts_finished: 0,
    questions: [{
      id: 10, position: 1, qtype: 'song', prompt: 'Which one?', time_limit_sec: 0,
      snippet_start_sec: 3, snippet_len_sec: 9,
      track: { id: PICK.id, title: PICK.title, artist: PICK.artist, album: PICK.album },
      audio: '/api/audio/10', album: null,
      ask_artist: true, ask_title: true, ask_album: true,
      answers: expandAnswers(song, TIERS).map((row, i) => ({
        id: i + 1, display: row.display, normalized: normalizeAnswer(row.display),
        is_correct: true, tier_id: row.tier_id, guess_count: 0,
      })),
    }],
  }

  const reopened = fromQuiz(stored).questions[0]
  assert.deepEqual(said(reopened.answers.filter(row => row.seeded)),
    ['Radiohead/2', 'Creep/2', 'Pablo Honey/2'])
  assert.equal(reopened.full_tier_id, 6)                        // "all three right"
  assert.deepEqual(said(reopened.answers.filter(row => !row.seeded)), ['Radiohed/4'])
  // and saving it again produces exactly what was stored
  assert.deepEqual(expandAnswers(reopened, TIERS), expandAnswers(song, TIERS))
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
      { id: 11, position: 3, qtype: 'song', prompt: 'This one?', time_limit_sec: 0,
        snippet_start_sec: 8, snippet_len_sec: 12,
        track: { id: 42, title: 'Creep', artist: 'Radiohead', album: 'Pablo Honey' },
        audio: '/api/audio/11', album: null,
        ask_artist: false, ask_title: true, ask_album: true, answers: [] },
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
  // the clock and the track's album come back too, so reopening a day can reseed
  assert.equal(draft.questions[2].ask_album, true)
  assert.equal(draft.questions[2].time_limit_sec, 0)
  assert.equal(draft.questions[2].track?.album, 'Pablo Honey')
})
