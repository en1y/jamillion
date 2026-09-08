// The moderator routes: everything the quiz editor talks to. The play routes are
// in api.ts and identity in supabase.ts -- one file per surface.
import { call } from './api'
import type { Qtype } from './api'

export interface Tier { id: number; name: string; points: number; sort_order: number }

export interface QuizDay {
  quiz_date: string
  published: boolean
  questions: number
  attempts_started: number
  attempts_finished: number
}

export interface TrackHit {
  id: number; title: string; artist: string; album: string
  global_rank: number | null; release_date: string | null; duration_ms: number | null
  deezer_rank: number | null; youtube_views: number | null; has_preview: boolean
}

export interface AlbumHit {
  id: number; title: string; artist: string
  global_rank: number | null; release_date: string | null; total_tracks: number | null
  cover_url: string | null; deezer_fans: number | null
}

/** One answer as the moderator sees it. `is_correct` is tri-state: null is the
 *  review queue -- a guess nobody has ruled on yet. */
export interface ModAnswer {
  id: number; display: string; normalized: string
  is_correct: boolean | null; tier_id: number | null; guess_count: number
}

/** Careful with the two asymmetries the backend has: ask_artist/ask_title are
 *  omitted entirely for a rarest question, while snippet_* are null rather than
 *  absent. */
export interface ModQuestion {
  id: number; position: number; qtype: Qtype; prompt: string; time_limit_sec: number
  snippet_start_sec: number | null
  snippet_len_sec: number | null
  track: { id: number; title: string; artist: string | null } | null
  audio: string | null
  album: { id: number; title: string; artist: string | null; cover: string | null } | null
  ask_artist?: boolean
  ask_title?: boolean
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

export interface CatalogQuery {
  q?: string; artist?: string; year?: string; min_rank?: string; limit?: number
}

export const getTiers = (token?: string) => call<Tier[]>('/api/tiers', token)

export const listQuizzes = (token?: string, from?: string, to?: string) =>
  call<QuizDay[]>('/api/quizzes' + query({ from, to }), token)

export const searchTracks = (params: CatalogQuery, token?: string) =>
  call<TrackHit[]>('/api/tracks' + query(params), token)

export const searchAlbums = (params: CatalogQuery, token?: string) =>
  call<AlbumHit[]>('/api/albums' + query(params), token)

export const getQuiz = (date: string, token?: string) =>
  call<ModQuiz>(`/api/quizzes/${date}`, token)

export const saveQuiz = (payload: unknown, token?: string) =>
  call<{ id: number; quiz_date: string }>('/api/quizzes', token,
    { method: 'POST', body: JSON.stringify(payload) })

export const setPublished = (date: string, published: boolean, token?: string) =>
  call<{ id: number; quiz_date: string; published: boolean }>(`/api/quizzes/${date}`, token,
    { method: 'PATCH', body: JSON.stringify({ published }) })

/** The prompt on any day; everything else only while the day is unplayed, else 409. */
export const patchQuestion = (id: number, body: Record<string, unknown>, token?: string) =>
  call<ModQuestion>(`/api/questions/${id}`, token, { method: 'PATCH', body: JSON.stringify(body) })

export const reviewAnswer = (id: number, body: { is_correct?: boolean | null; tier_id?: number | null },
                             token?: string) =>
  call<Reviewed>(`/api/answers/${id}`, token, { method: 'PATCH', body: JSON.stringify(body) })

export const mergeAnswer = (id: number, into: number, token?: string) =>
  call<Reviewed>(`/api/answers/${id}/merge`, token, { method: 'POST', body: JSON.stringify({ into }) })

/** Moderator-only, so it needs the token on a fetch: an <audio src> cannot carry one. */
export const trackAudio = (id: number) => `/api/tracks/${id}/audio`
