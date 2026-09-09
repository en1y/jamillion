// The editor's state and the rules that need no DOM: what a day looks like while
// it is being written, what it turns into on the wire, and what is still wrong
// with it. Pure, so quizdraft.test.ts can check it without a browser.
import type { Qtype } from './api'
import type { ModQuiz } from './moderator'

export const QUESTIONS = 7
export const CLIP_SEC = 30              // the preview clip every snippet lives inside

/** `seeded` marks a row this file wrote from the picked track or album, so a
 *  later change can replace it without touching what the moderator typed. It is
 *  draft-only: toPayload sends display and tier_id and nothing else. */
export interface DraftAnswer {
  display: string
  tier_id: number | null
  /** What this answer is worth, when that is not its tier's own number: the sum
   *  expandAnswers works out for a combination of fields, or a 0 the moderator
   *  chose to say "accepted, but worth nothing". */
  points?: number
  seeded?: boolean
}

/** A track or an album the moderator picked, flattened to what the card shows.
 *  `album` is the record a *track* came from, which ask_album asks players for. */
export interface DraftPick {
  id: number; title: string; artist: string; cover?: string | null; album?: string | null
}

export interface DraftQuestion {
  qtype: Qtype
  prompt: string
  track: DraftPick | null
  album: DraftPick | null
  snippet_start_sec: number
  snippet_len_sec: number
  ask_artist: boolean
  ask_title: boolean
  ask_album: boolean
  time_limit_sec: number
  /** A bonus on top of the fields, for getting every one of them right. null is
   *  no bonus, and is the default: a player who gets everything simply scores
   *  what the fields add up to. Ignored when only one field is asked for, which
   *  is then just that field's own row. */
  full_tier_id: number | null
  answers: DraftAnswer[]
}

/** 0 = no clock. A song is a snippet and then a name pulled out of memory, and an
 *  album cover is read rather than raced; 20 seconds makes both a reflex test.
 *  A rarest question is the one the timer is actually for. */
export const defaultTimeLimit = (qtype: Qtype) => qtype === 'rarest' ? 20 : 0

export interface Draft { quiz_date: string; published: boolean; questions: DraftQuestion[] }

export const emptyQuestion = (): DraftQuestion => ({
  qtype: 'rarest', prompt: '', track: null, album: null,
  snippet_start_sec: 0, snippet_len_sec: 10,
  ask_artist: true, ask_title: true, ask_album: false,
  time_limit_sec: defaultTimeLimit('rarest'), full_tier_id: null, answers: [],
})

export const emptyDraft = (quiz_date: string): Draft => ({
  quiz_date, published: false,
  questions: Array.from({ length: QUESTIONS }, emptyQuestion),
})

/** A saved day comes back as the flat key that was actually stored. Turn it back
 *  into what the editor edits: one row per field, the full-answer tier on its own,
 *  and the combinations dropped -- expandAnswers writes those again on the way
 *  out. Anything that is none of those was typed by hand and stays. */
function absorb(question: DraftQuestion): DraftQuestion {
  const pick = question.qtype === 'song' ? question.track
             : question.qtype === 'album' ? question.album : null
  const fields = pick ? prefillAnswers(pick, asksOf(question), null).map(row => row.display) : []
  if (fields.length <= 1) return question

  const full = (1 << fields.length) - 1
  const fullKey = normalizeAnswer(fields.join(' — '))
  const wanted = new Set(fields.map(normalizeAnswer))
  const combos = new Set(Array.from({ length: full }, (_, i) => full - i)
    .map(mask => fields.filter((_, bit) => mask & (1 << bit)))
    .filter(parts => parts.length > 1)
    .map(parts => normalizeAnswer(parts.join(' — '))))

  const typed: DraftAnswer[] = []
  const stored = new Map<string, DraftAnswer>()
  let fullTier: number | null = null
  for (const answer of question.answers) {
    const key = normalizeAnswer(answer.display)
    if (key === fullKey) fullTier = answer.tier_id
    else if (combos.has(key)) continue
    else if (wanted.has(key) && !stored.has(key)) stored.set(key, answer)
    else typed.push(answer)
  }
  const seeded = fields.map(display => {
    const was = stored.get(normalizeAnswer(display))
    return {
      display, tier_id: was?.tier_id ?? null, seeded: true,
      ...(was?.points === undefined ? {} : { points: was.points }),
    }
  })
  return { ...question, full_tier_id: fullTier, answers: [...seeded, ...typed] }
}

/** A saved day, opened for editing. Positions are 1..7 and the backend orders by
 *  them, but a missing one still lands on an empty card rather than shifting the rest. */
export function fromQuiz(quiz: ModQuiz): Draft {
  const draft = emptyDraft(quiz.quiz_date)
  draft.published = quiz.published
  for (const question of quiz.questions) {
    const slot = question.position - 1
    if (slot < 0 || slot >= QUESTIONS) continue
    draft.questions[slot] = absorb({
      qtype: question.qtype,
      prompt: question.prompt,
      track: question.track
        ? { id: question.track.id, title: question.track.title,
            artist: question.track.artist ?? '', album: question.track.album }
        : null,
      album: question.album
        ? { id: question.album.id, title: question.album.title,
            artist: question.album.artist ?? '', cover: question.album.cover }
        : null,
      snippet_start_sec: question.snippet_start_sec ?? 0,
      snippet_len_sec: question.snippet_len_sec ?? 10,
      // omitted rather than null on a rarest question, so default them
      ask_artist: question.ask_artist ?? true,
      ask_title: question.ask_title ?? true,
      ask_album: question.ask_album ?? false,
      time_limit_sec: question.time_limit_sec,
      full_tier_id: null,
      // The key is left off rather than set to undefined: a row that carries no
      // override should not look different from one that never had the field.
      answers: question.answers.map(answer => ({
        display: answer.display, tier_id: answer.tier_id,
        ...(answer.points === null || answer.points === undefined ? {} : { points: answer.points }),
      })),
    })
  }
  return draft
}

/** The POST /api/quizzes body. Each qtype carries only its own fields; extra keys
 *  would be ignored by jsonb_to_recordset anyway, but a rarest question that
 *  smuggled a track_id would still store it. */
export function toPayload(draft: Draft, tiers: TierPoints[] = []) {
  return {
    quiz_date: draft.quiz_date,
    published: draft.published,
    questions: draft.questions.map((question, slot) => {
      const out: Record<string, unknown> = {
        position: slot + 1,
        qtype: question.qtype,
        prompt: question.prompt.trim(),
        time_limit_sec: question.time_limit_sec,
        answers: expandAnswers(question, tiers)
          .filter(answer => answer.display.trim())
          .map(({ display, tier_id, points }) => ({
            display: display.trim(),
            ...(tier_id === null ? {} : { tier_id }),
            ...(points === undefined ? {} : { points }),
          })),
      }
      if (question.qtype === 'song') {
        out.track_id = question.track?.id
        out.snippet_start_sec = question.snippet_start_sec
        out.snippet_len_sec = question.snippet_len_sec
      }
      if (question.qtype === 'album') out.album_id = question.album?.id
      if (question.qtype !== 'rarest') {
        out.ask_artist = question.ask_artist
        out.ask_title = question.ask_title
        // ask_album is a song question's third field; on an album question the
        // album title is what ask_title already means, and the backend rejects it.
        if (question.qtype === 'song') out.ask_album = question.ask_album
      }
      return out
    }),
  }
}

/** btrim(regexp_replace(lower(unaccent(txt)), '[^a-z0-9]+', ' ', 'g')) in JS.
 *  ponytail: NFD plus stripping combining marks stands in for unaccent. Close
 *  enough to warn about a duplicate here; the UNIQUE (question_id, normalized)
 *  index is still the one that decides. */
export const normalizeAnswer = (text: string) =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').trim()

/** start >= 0, len >= 1, and the window inside the 30 s clip -- the same bounds
 *  the DB CHECKs and PATCH /api/questions/{id} enforce. */
export function clampSnippet(start: number, len: number): { start: number; len: number } {
  const from = Math.min(Math.max(Number.isFinite(start) ? start : 0, 0), CLIP_SEC - 1)
  const length = Math.min(Math.max(Number.isFinite(len) ? len : 1, 1), CLIP_SEC - from)
  return { start: from, len: length }
}

/** The fields a song or album question puts in front of a player, in the order
 *  Play.tsx lays them out -- which is also the order their answer is joined in. */
export const asksOf = (question: DraftQuestion) => ({
  // A rarest question asks for one free answer and keeps its ask flags at their
  // defaults, so they are read here as the nothing they mean.
  artist: question.qtype !== 'rarest' && question.ask_artist,
  title: question.qtype !== 'rarest' && question.ask_title,
  album: question.qtype === 'song' && question.ask_album,
})

/** Just enough of a rarity tier to rank two of them. */
export interface TierPoints { id: number; points: number }

/** One row per field the question asks for, in the order Play lays the fields
 *  out. Only the fields: what a player scores for getting *everything* right is
 *  the question's full_tier_id, and the combinations that carry it are written
 *  by expandAnswers rather than listed for the moderator to read past. */
export function prefillAnswers(pick: DraftPick, asks: ReturnType<typeof asksOf>,
                               partialTier: number | null = null): DraftAnswer[] {
  return [
    asks.artist ? pick.artist : '',
    asks.title ? pick.title : '',
    asks.album ? pick.album ?? '' : '',
  ].map(part => part.trim())
   .filter(Boolean)
   .map(display => ({ display, tier_id: partialTier, seeded: true }))
}

/** The question's answers after a pick or an asked-for field changed. Seeded rows
 *  are rebuilt; anything typed by hand survives, unless it says the same thing as
 *  a new seed -- in which case the seed wins rather than the two becoming a clash
 *  that draftProblems has to report. */
export function reseedAnswers(question: DraftQuestion, partialTier: number | null): DraftAnswer[] {
  const typed = question.answers.filter(answer => !answer.seeded && answer.display.trim())
  const pick = question.qtype === 'song' ? question.track
             : question.qtype === 'album' ? question.album : null
  if (!pick) return typed
  const seeds = prefillAnswers(pick, asksOf(question), partialTier)
  const taken = new Set(seeds.map(seed => normalizeAnswer(seed.display)))
  return [...seeds, ...typed.filter(answer => !taken.has(normalizeAnswer(answer.display)))]
}

/** What actually goes in the answer key. A player answers a song question field
 *  by field and the fields arrive joined, so every combination of them needs a
 *  row -- but only the fields themselves are worth a moderator's attention, so
 *  the rest are written here.
 *
 *  A combination is worth its fields **added up**: get two of three right and you
 *  score both of them. full_tier_id is a bonus on top for getting every field,
 *  and it is optional -- with none, all of them right is simply the whole sum.
 *  That total rides on the row as `points`, because it is rarely a number any one
 *  rarity tier names; tier_id stays too, so the player is still shown a star.
 *
 *  With a single field asked there is no combination: that row is the answer, at
 *  its own tier and with no override. Rows the moderator typed pass through. */
export function expandAnswers(question: DraftQuestion, tiers: TierPoints[]): DraftAnswer[] {
  const typed = question.answers.filter(answer => !answer.seeded && answer.display.trim())
  const fields = question.answers.filter(answer => answer.seeded && answer.display.trim())
  if (question.qtype === 'rarest' || fields.length <= 1)
    return [...fields.map(({ display, tier_id, points }) => ({ display, tier_id, points })), ...typed]

  const worth = (row: DraftAnswer) => row.points ?? tiers.find(tier => tier.id === row.tier_id)?.points
  // "by rarity" is null and can reach any tier, so a combination holding one keeps
  // the label and cannot be added up.
  const best = (rows: DraftAnswer[]) =>
    rows.some(row => row.tier_id === null && row.points === undefined) ? null
      : rows.reduce((top, row) => (worth(row) ?? 0) > (worth(top) ?? 0) ? row : top).tier_id

  const full = (1 << fields.length) - 1
  // Counting down puts the whole answer first and the single fields last.
  const rows = Array.from({ length: full }, (_, i) => full - i).map(mask => {
    const parts = fields.filter((_, bit) => mask & (1 << bit))
    const whole = mask === full
    const each = parts.map(worth)
    // A field left "by rarity", or a tier list that has not loaded yet, means
    // there is nothing to add up: the row falls back to a tier and scores as one.
    const sum = each.every(points => points !== undefined)
      ? each.reduce((total, points) => total + (points ?? 0), 0) +
        (whole ? tiers.find(tier => tier.id === question.full_tier_id)?.points ?? 0 : 0)
      : undefined
    const row: DraftAnswer = {
      display: parts.map(part => part.display.trim()).join(' — '),
      tier_id: whole && question.full_tier_id !== null ? question.full_tier_id : best(parts),
    }
    // A single field is left on its tier so the review queue's select still works
    // on it -- unless the moderator set its points by hand, which has to survive.
    if (sum !== undefined && (parts.length > 1 || parts[0].points !== undefined))
      row.points = Math.min(sum, 700)
    return row
  })
  return [...rows, ...typed]
}

/** What a fully correct answer scores, for the editor to print beside the bonus.
 *  undefined while a field is still "by rarity" and there is nothing to add up. */
export function fullAnswerPoints(question: DraftQuestion, tiers: TierPoints[]): number | undefined {
  const fields = question.answers.filter(answer => answer.seeded && answer.display.trim())
  if (fields.length === 0) return undefined
  const each = fields.map(field =>
    field.points ?? tiers.find(tier => tier.id === field.tier_id)?.points)
  if (!each.every(points => points !== undefined)) return undefined
  const bonus = fields.length > 1
    ? tiers.find(tier => tier.id === question.full_tier_id)?.points ?? 0 : 0
  return Math.min(each.reduce((total, points) => total + (points ?? 0), 0) + bonus, 700)
}


/** What is still stopping a save, in the words validate() would use. Checked here
 *  so the moderator reads it beside the field rather than after a round trip;
 *  the backend still decides. */
export function draftProblems(draft: Draft, tiers: TierPoints[] = []): string[] {
  const problems: string[] = []
  draft.questions.forEach((question, slot) => {
    const at = (what: string) => problems.push(`Question ${slot + 1}: ${what}`)
    const prompt = question.prompt.trim()
    if (!prompt) at('needs a prompt')
    else if (prompt.length > 500) at('prompt is over 500 characters')
    if (question.qtype === 'song' && !question.track) at('needs a track')
    if (question.qtype === 'album' && !question.album) at('needs an album')
    if (question.qtype === 'song') {
      const fitted = clampSnippet(question.snippet_start_sec, question.snippet_len_sec)
      if (fitted.start !== question.snippet_start_sec || fitted.len !== question.snippet_len_sec)
        at(`snippet does not fit inside the ${CLIP_SEC} second clip`)
    }
    if (question.qtype !== 'rarest' && !question.ask_artist && !question.ask_title &&
        !(question.qtype === 'song' && question.ask_album))
      at('must ask for at least one field')
    // A track with no album row in the catalog cannot answer "which record",
    // and the field would otherwise just go quietly missing from the key.
    if (question.qtype === 'song' && question.ask_album && question.track &&
        !question.track.album?.trim())
      at('asks for the album, but the catalog has no album for that track')
    const limit = question.time_limit_sec
    if (!Number.isInteger(limit) || (limit !== 0 && (limit < 5 || limit > 60)))
      at('time limit must be off or between 5 and 60 seconds')

    // The expanded key, not the rows on screen: the combinations are what the
    // UNIQUE (question_id, normalized) index will actually see.
    const displays = expandAnswers(question, tiers).map(answer => answer.display.trim()).filter(Boolean)
    if (displays.length === 0) at('needs at least one accepted answer')
    if (displays.some(display => display.length > 100)) at('an answer is over 100 characters')
    const seen = new Set<string>()
    for (const display of displays) {
      const key = normalizeAnswer(display)
      if (seen.has(key)) { at(`two answers both count as “${key}”`); break }
      seen.add(key)
    }
  })
  return problems
}

// --- the draft on this browser ---------------------------------------------
// POST /api/quizzes takes seven questions or nothing, so a half-built day has
// nowhere on the server to live. It is cleared once the day saves.

// The 2 is the shape, not the day. v0.8.5 added ask_album, time_limit_sec,
// full_tier_id and the album a track came from; a draft written before that
// restores with those missing, and the symptom is silent -- ticking "ask for the
// album" seeds nothing, because the saved pick has no album to seed from. A
// stale draft is dropped rather than half-read.
export const draftKey = (date: string) => `jamillion-draft-2-${date}`

/** A restored draft is data from another run of another version of this file, so
 *  the fields added since are filled in rather than trusted to be there. */
const restore = (question: Partial<DraftQuestion>): DraftQuestion => ({
  ...emptyQuestion(),
  ...question,
  time_limit_sec: question.time_limit_sec ?? defaultTimeLimit(question.qtype ?? 'rarest'),
  answers: Array.isArray(question.answers) ? question.answers : [],
})

export function loadDraft(date: string): Draft | null {
  try {
    const raw = JSON.parse(localStorage.getItem(draftKey(date)) ?? '')
    if (raw && Array.isArray(raw.questions) && raw.questions.length === QUESTIONS)
      return { ...raw, questions: raw.questions.map(restore) } as Draft
  } catch { /* no draft yet, or a leftover from an older shape */ }
  return null
}

export function saveDraft(date: string, draft: Draft) {
  try { localStorage.setItem(draftKey(date), JSON.stringify(draft)) } catch { /* private mode */ }
}

export function clearDraft(date: string) {
  try { localStorage.removeItem(draftKey(date)) } catch { /* nothing to clear */ }
}
