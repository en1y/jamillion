// The moderator routes: everything the quiz editor talks to. The play routes are
// in api.ts and identity in supabase.ts -- one file per surface.
import { call } from './api'
import type { Qtype } from './api'
import type { CatalogSchema, Page, Query } from './catalog'

export interface Tier { id: number; name: string; points: number; sort_order: number }

export interface QuizDay {
  quiz_date: string
  published: boolean
  questions: number
  attempts_started: number
  attempts_finished: number
}

/** One answer as the moderator sees it. `is_correct` is tri-state: null is the
 *  review queue -- a guess nobody has ruled on yet. */
export interface ModAnswer {
  id: number; display: string; normalized: string
  is_correct: boolean | null; tier_id: number | null; guess_count: number
  /** Set, this is what the answer scores instead of its tier's own number: the
   *  sum of a combination of fields, or a 0 meaning accepted but worth nothing. */
  points: number | null
}

/** Careful with the two asymmetries the backend has: ask_artist/ask_title are
 *  omitted entirely for a rarest question, while snippet_* are null rather than
 *  absent. */
export interface ModQuestion {
  id: number; position: number; qtype: Qtype; prompt: string; time_limit_sec: number
  snippet_start_sec: number | null
  snippet_len_sec: number | null
  track: { id: number; title: string; artist: string | null; album: string | null } | null
  audio: string | null
  album: { id: number; title: string; artist: string | null; cover: string | null } | null
  ask_artist?: boolean
  ask_title?: boolean
  ask_album?: boolean
  answers: ModAnswer[]
}

export interface ModQuiz {
  id: number; quiz_date: string; published: boolean; created_by: string | null
  attempts_started: number; attempts_finished: number
  questions: ModQuestion[]
}

export interface Reviewed extends ModAnswer { question_id: number; rescored: number }

/** Only the params that were actually given reach the query string. */
const query = (params: object) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') search.set(key, String(value))
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const getTiers = (token?: string) => call<Tier[]>('/api/tiers', token)

export const listQuizzes = (token?: string, from?: string, to?: string) =>
  call<QuizDay[]>('/api/quizzes' + query({ from, to }), token)

/** The columns the catalog can be filtered and sorted on, and the operators each
 *  datatype offers. Fetched once and handed down: it never changes at runtime. */
export const getFields = (token?: string) => call<CatalogSchema>('/api/catalog/fields', token)

/** One stacked query. POST rather than GET because a query string cannot carry a
 *  repeated filter without inventing an escaping scheme for its values. */
export const runQuery = (search: Query, token?: string) =>
  call<Page>('/api/catalog', token, { method: 'POST', body: JSON.stringify(search) })

export const getQuiz = (date: string, token?: string) =>
  call<ModQuiz>(`/api/quizzes/${date}`, token)

export const saveQuiz = (payload: unknown, token?: string) =>
  call<{ id: number; quiz_date: string }>('/api/quizzes', token,
    { method: 'POST', body: JSON.stringify(payload) })

export const setPublished = (date: string, published: boolean, token?: string) =>
  call<{ id: number; quiz_date: string; published: boolean }>(`/api/quizzes/${date}`, token,
    { method: 'PATCH', body: JSON.stringify({ published }) })

/** Admin only: the day, its questions, its answer key and its flights, all at once. */
export const deleteQuiz = (date: string, token?: string) =>
  call<{ quiz_date: string; deleted: boolean }>(`/api/quizzes/${date}`, token, { method: 'DELETE' })

/** The prompt on any day; everything else only while the day is unplayed, else 409. */
export const patchQuestion = (id: number, body: Record<string, unknown>, token?: string) =>
  call<ModQuestion>(`/api/questions/${id}`, token, { method: 'PATCH', body: JSON.stringify(body) })

export const reviewAnswer = (id: number,
                             body: { is_correct?: boolean | null; tier_id?: number | null
                                     points?: number | null },
                             token?: string) =>
  call<Reviewed>(`/api/answers/${id}`, token, { method: 'PATCH', body: JSON.stringify(body) })

export const mergeAnswer = (id: number, into: number, token?: string) =>
  call<Reviewed>(`/api/answers/${id}/merge`, token, { method: 'POST', body: JSON.stringify({ into }) })

/** Moderator-only, so it needs the token on a fetch: an <audio src> cannot carry one. */
export const trackAudio = (id: number) => `/api/tracks/${id}/audio`
