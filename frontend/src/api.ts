// The play routes. Identity (/api/me) lives in supabase.ts, next to the client
// that issues the token.

export interface Tier { name: string; points: number }

/** One answer of your own flight, as /api/quiz/today reports it back.
 *  An empty raw_text is a skip or a timeout; the schema does not tell them apart. */
export interface OwnAnswer {
  position: number
  raw_text: string
  correct: boolean
  tier: string | null
  points: number
}

export interface Attempt {
  id: number
  total_points: number
  answered: number
  finished: boolean
  answers: OwnAnswer[]
}

export interface Today {
  id: number
  quiz_date: string
  question_count: number
  players_finished: number
  tiers: Tier[]
  attempt: Attempt | null
}

export type Qtype = 'rarest' | 'song' | 'album'

/** Never carries a track or album id: the clip is fetched by question id and the
 *  cover URL is a content hash. */
export interface Question {
  id: number
  position: number
  qtype: Qtype
  prompt: string
  time_limit_sec: number
  started_at: string
  deadline: string
  ask_artist?: boolean          // song and album: which fields the moderator asks for
  ask_title?: boolean
  snippet_start_sec?: number    // song
  snippet_len_sec?: number
  audio?: string
  cover?: string | null         // album
}

export interface Progress {
  id: number
  quiz_id: number
  total_points: number
  answered: number
  finished: boolean
  question: Question | null
}

export interface Result { timed_out: boolean; correct: boolean; tier: string | null; points: number }
export interface Answered extends Progress { result: Result }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function call<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(response.status, body.error || 'The flight deck is not answering. Please retry.')
  return body as T
}

/** null when no quiz is published for today, which is a normal state, not an error. */
export async function getToday(token?: string): Promise<Today | null> {
  try {
    return await call<Today>('/api/quiz/today', token)
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return null
    throw cause
  }
}

/** Starts or resumes the day's flight AND serves the current question, which is
 *  what starts its timer. Called again for every next question. */
export const startAttempt = (token?: string) =>
  call<Progress>('/api/attempts', token, { method: 'POST' })

export const submitAnswer = (attemptId: number, question_id: number, text: string, token?: string) =>
  call<Answered>(`/api/attempts/${attemptId}/answers`, token,
    { method: 'POST', body: JSON.stringify({ question_id, text }) })

export type SuggestKind = 'artist' | 'title' | 'album'

/** Catalog completions for the artist, song title and album title fields. */
export const suggest = (kind: SuggestKind, q: string) =>
  call<string[]>(`/api/suggest?kind=${kind}&q=${encodeURIComponent(q)}`)

export interface RevealedAnswer { display: string; tier: string | null; points: number; yours: boolean }
export interface RevealedQuestion { position: number; prompt: string; answers: RevealedAnswer[] }

/** Accepted answers for today, rarest first. 403 until this player has landed. */
export const getReveal = (token?: string) =>
  call<{ questions: RevealedQuestion[] }>('/api/quiz/today/reveal', token)
