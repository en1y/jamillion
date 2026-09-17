// The admin routes: users, the day's numbers, the rarity ladder and the raw
// tables. One file per surface, like api.ts (play) and moderator.ts (the deck).
//
// The two pure functions at the bottom sit here rather than in a sibling module
// the way quizdraft.ts and catalog.ts do: two of them is not a file.
//
// The .ts on the value import is for `node --test`, which resolves imports the way
// Node does rather than the way Vite does; tsconfig's allowImportingTsExtensions
// means Vite and tsc take it too. Type-only imports are erased, so they need none.
import { call, query } from './api.ts'
import type { Qtype } from './api'
import type { Tier } from './moderator'

export type Role = 'user' | 'moderator' | 'admin'

/** The six columns the list may be sorted by, which are also its six columns. */
export type UserSort = 'username' | 'email' | 'role' | 'created_at' | 'browsers' | 'attempts'

/** `created_at` is Postgres text -- "2026-09-07 20:11:03.4+00", a space rather
 *  than the T `new Date()` is promised. Slice the date off it, never parse it.
 *  `browsers` counts the player rows on the account, `attempts` their flights. */
export interface AdminUser {
  id: string; username: string; email: string | null; role: Role
  created_at: string; browsers: number; attempts: number
}

export interface UserQuery {
  q?: string; role?: string; sort?: UserSort; dir?: 'asc' | 'desc'
  limit?: number; offset?: number
}

/** One row of the quiz_heights view: a score somebody finished on, and how many
 *  did. `height_au` is text for the same reason max_share is. */
export interface Height { total_points: number; height_au: string; players: number }

export interface TopAnswer {
  id: number; display: string; is_correct: boolean
  tier_id: number | null; guess_count: number; share: string
}

export interface QuestionStat {
  id: number; position: number; qtype: Qtype; prompt: string
  answered: number; skipped: number; correct: number
  /** Over every answer stored, skips as 0; null before the first. Text, like height_au. */
  avg_points: string | null
  top_answers: TopAnswer[]
}

/** `heights` is empty until somebody finishes the day, which is most of a day. */
export interface Stats {
  id: number; quiz_date: string; published: boolean
  /** Flights begun, finished or not; avg_points is over finished ones only. */
  started: number; avg_points: string | null
  heights: Height[]; questions: QuestionStat[]
}

/** One quiz day inside a range. `best` and `avg_points` are null until someone lands. */
export interface DayStat {
  quiz_date: string; published: boolean; max_points: number
  started: number; finished: number; avg_points: string | null; best: number | null
}

/** One answer text across the range: `questions` it was given to, `accepted` on how many. */
export interface RangeAnswer { display: string; guesses: number; questions: number; accepted: number }

/** `players` counts browsers, `accounts` the signed-in people behind them. */
export interface RangeStats {
  from: string; to: string; days: number
  started: number; finished: number; players: number; accounts: number; avg_points: string | null
  per_day: DayStat[]; top_answers: RangeAnswer[]
}

/** Whatever columns the table has, typed by Postgres. An empty page carries no
 *  column names at all, which is why the screen says so instead of guessing. */
export interface TableDump { table: string; rows: Record<string, unknown>[] }

export const listUsers = (params: UserQuery, token?: string) =>
  call<AdminUser[]>('/api/users' + query(params), token)

export const setRole = (id: string, role: Role, token?: string) =>
  call<{ id: string; username: string; role: Role }>(`/api/users/${id}`, token,
    { method: 'PATCH', body: JSON.stringify({ role }) })

/** Deletes the account, not the history: the flights stay, de-identified. */
export const removeUser = (id: string, token?: string) =>
  call<{ id: string; deleted: boolean }>(`/api/users/${id}`, token, { method: 'DELETE' })

export const getStats = (date: string, top: number, token?: string) =>
  call<Stats>(`/api/quizzes/${date}/stats` + query({ top }), token)

/** At most 366 days apart; the backend refuses more. */
export const getRangeStats = (from: string, to: string, top: number, token?: string) =>
  call<RangeStats>('/api/stats' + query({ from, to, top }), token)

export const listTables = (token?: string) => call<string[]>('/api/tables', token)

export const readTable = (name: string, limit: number, offset: number, token?: string) =>
  call<TableDump>(`/api/tables/${name}` + query({ limit, offset }), token)

export const patchTier = (id: number, body: Record<string, string | number>, token?: string) =>
  call<Tier>(`/api/tiers/${id}`, token, { method: 'PATCH', body: JSON.stringify(body) })

// --- the pure half -----------------------------------------------------------

/** Neither list route counts its rows, and counting on every keystroke is a
 *  second query for a number nobody acts on. So the label names the window that
 *  is on screen and nothing more; the caller kills Next on a short page. A last
 *  page that happens to be exactly full costs one request to an empty one. */
export function rowRange(offset: number, count: number): string {
  if (count === 0) return offset === 0 ? 'nothing here' : 'past the end'
  return `rows ${offset + 1}–${offset + count}`
}

export interface TierEdit { name: string; points: string; max_share: string }

export const seedEdit = (tier: Tier): TierEdit =>
  ({ name: tier.name, points: String(tier.points), max_share: tier.max_share })

/** Only what changed, and only if the backend would take it. The checks mirror
 *  PATCH /api/tiers/{id} so a typo is refused beside the field instead of after a
 *  round trip; the backend still decides. An untouched share is never resent, so
 *  a stored 0.0020 cannot be rounded by a trip through a number input. */
export function tierPatch(tier: Tier, edit: TierEdit):
    { body: Record<string, string | number>; problems: string[] } {
  const body: Record<string, string | number> = {}
  const problems: string[] = []

  const name = edit.name.trim()
  if (name !== tier.name) {
    if (!name) problems.push('name cannot be empty')
    else body.name = name
  }
  if (edit.points !== String(tier.points)) {
    const points = Number(edit.points)
    if (edit.points.trim() === '' || !Number.isInteger(points) || points < 0 || points > 32767)
      problems.push('points must be a whole number from 0 to 32767')
    else body.points = points
  }
  if (edit.max_share !== tier.max_share) {
    const share = Number(edit.max_share)
    if (edit.max_share.trim() === '' || !Number.isFinite(share) || share <= 0 || share > 1)
      problems.push('share must be over 0 and at most 1')
    else body.max_share = share
  }
  return { body, problems }
}
