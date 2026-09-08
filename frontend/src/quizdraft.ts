// The editor's state and the rules that need no DOM: what a day looks like while
// it is being written, what it turns into on the wire, and what is still wrong
// with it. Pure, so quizdraft.test.ts can check it without a browser.
import type { Qtype } from './api'
import type { ModQuiz } from './moderator'

export const QUESTIONS = 7
export const CLIP_SEC = 30              // the preview clip every snippet lives inside

export interface DraftAnswer { display: string; tier_id: number | null }

/** A track or an album the moderator picked, flattened to what the card shows. */
export interface DraftPick { id: number; title: string; artist: string; cover?: string | null }

export interface DraftQuestion {
  qtype: Qtype
  prompt: string
  track: DraftPick | null
  album: DraftPick | null
  snippet_start_sec: number
  snippet_len_sec: number
  ask_artist: boolean
  ask_title: boolean
  answers: DraftAnswer[]
}

export interface Draft { quiz_date: string; published: boolean; questions: DraftQuestion[] }

export const emptyQuestion = (): DraftQuestion => ({
  qtype: 'rarest', prompt: '', track: null, album: null,
  snippet_start_sec: 0, snippet_len_sec: 10, ask_artist: true, ask_title: true, answers: [],
})

export const emptyDraft = (quiz_date: string): Draft => ({
  quiz_date, published: false,
  questions: Array.from({ length: QUESTIONS }, emptyQuestion),
})

/** A saved day, opened for editing. Positions are 1..7 and the backend orders by
 *  them, but a missing one still lands on an empty card rather than shifting the rest. */
export function fromQuiz(quiz: ModQuiz): Draft {
  const draft = emptyDraft(quiz.quiz_date)
  draft.published = quiz.published
  for (const question of quiz.questions) {
    const slot = question.position - 1
    if (slot < 0 || slot >= QUESTIONS) continue
    draft.questions[slot] = {
      qtype: question.qtype,
      prompt: question.prompt,
      track: question.track
        ? { id: question.track.id, title: question.track.title, artist: question.track.artist ?? '' }
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
      answers: question.answers.map(answer => ({ display: answer.display, tier_id: answer.tier_id })),
    }
  }
  return draft
}

/** The POST /api/quizzes body. Each qtype carries only its own fields; extra keys
 *  would be ignored by jsonb_to_recordset anyway, but a rarest question that
 *  smuggled a track_id would still store it. */
export function toPayload(draft: Draft) {
  return {
    quiz_date: draft.quiz_date,
    published: draft.published,
    questions: draft.questions.map((question, slot) => {
      const out: Record<string, unknown> = {
        position: slot + 1,
        qtype: question.qtype,
        prompt: question.prompt.trim(),
        answers: question.answers
          .filter(answer => answer.display.trim())
          .map(({ display, tier_id }) => tier_id === null
            ? { display: display.trim() }
            : { display: display.trim(), tier_id }),
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

/** Picking a track seeds the answers instead of making the moderator retype what
 *  they just chose. Both fields asked for means the full name plus the artist
 *  alone at a lower tier, which is how v0.7.0 does partial credit. Every row
 *  stays editable, so this is a starting point rather than a decision. */
export function prefillAnswers(pick: DraftPick, askArtist: boolean, askTitle: boolean,
                               artistTier: number | null = null): DraftAnswer[] {
  const rows: DraftAnswer[] = []
  if (askArtist && askTitle) rows.push({ display: `${pick.artist} ${pick.title}`.trim(), tier_id: null })
  else if (askTitle) rows.push({ display: pick.title, tier_id: null })
  if (askArtist) rows.push({ display: pick.artist, tier_id: askTitle ? artistTier : null })
  return rows.filter(row => row.display)
}

/** What is still stopping a save, in the words validate() would use. Checked here
 *  so the moderator reads it beside the field rather than after a round trip;
 *  the backend still decides. */
export function draftProblems(draft: Draft): string[] {
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
    if (question.qtype !== 'rarest' && !question.ask_artist && !question.ask_title)
      at('must ask for the artist, the title or both')

    const displays = question.answers.map(answer => answer.display.trim()).filter(Boolean)
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

export const draftKey = (date: string) => `jamillion-draft-${date}`

export function loadDraft(date: string): Draft | null {
  try {
    const raw = JSON.parse(localStorage.getItem(draftKey(date)) ?? '')
    if (raw && Array.isArray(raw.questions) && raw.questions.length === QUESTIONS) return raw as Draft
  } catch { /* no draft yet, or a leftover from an older shape */ }
  return null
}

export function saveDraft(date: string, draft: Draft) {
  try { localStorage.setItem(draftKey(date), JSON.stringify(draft)) } catch { /* private mode */ }
}

export function clearDraft(date: string) {
  try { localStorage.removeItem(draftKey(date)) } catch { /* nothing to clear */ }
}
