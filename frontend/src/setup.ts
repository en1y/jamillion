// The first-run status and its checks, beside Setup.tsx like admin.ts beside Admin.tsx.
import { call } from './api.ts'

export type Source = 'lastfm' | 'wikidata'

export interface SetupStatus {
  admin: boolean
  configured: boolean
  seeding: boolean
  artists: number
  seed_target: number
  seed_source?: Source
  seed_full?: number
  progress?: SeedProgress
  // /api/seeder only: what the catalog holds and what it is still missing.
  catalog?: {
    albums: number; tracks: number; previews: number; plays: number
    full: number; skinny: number; aliases: number
    wikidata_cached: boolean; last_seeded: string
  }
  empty_artists?: string[]
  failures?: CatalogFailure[]
}

/** The seeder's progress file, as it writes it: the run, then the moment. */
export interface SeedProgress {
  state: 'preparing' | 'running' | 'finished' | 'interrupted'
  // preparing: fetching the Wikidata list, or ranking it by Deezer fans (a first run only)
  phase: 'preparing' | 'wikidata' | 'ranking' | 'seeding'
  source: Source | 'named' | 'promote'   // promote: the hourly skinny-to-full batch
  started: number           // epoch seconds
  limit: number
  full_cap: number
  full: number              // artists of each depth in this run
  skinny: number
  done: number
  total: number
  failed: number
  artist: string
}

/** What the dashboard or the setup page asks for: a ranked list, or names. */
export type RunRequest =
  | { artists: string[] }
  | { source: Source; limit: number; full: number; youtube: boolean }

/** An artist the seeder could not add, kept in the DB between runs. */
export interface CatalogFailure {
  name: string
  reason: string
  attempts: number
  last_try: string
}

export const getSetup = () => call<SetupStatus>('/api/setup')

/** The staff-only counterpart to the first-run status. It deliberately returns
 * counts and state only; catalog keys never leave the server. */
export const getSeeder = (token?: string) => call<SetupStatus>('/api/seeder', token)

/** A list of names in one run, not one run per name: the seeder takes one job at a
 *  time, so retrying forty artists one press at a time would take forty presses. */
export const rerunSeeder = (request: RunRequest, token?: string) =>
  call<SetupStatus>('/api/seeder', token, { method: 'POST', body: JSON.stringify(request) })

/** Stop the run. Artists already committed stay; the progress reads "interrupted". */
export const stopSeeder = (token?: string) => call<SetupStatus>('/api/seeder', token, { method: 'DELETE' })

/** The tail of the seeder's log, for the dashboard. */
export const getSeederLog = (token?: string, lines = 80) =>
  call<{ lines: string[]; seeding: boolean }>(`/api/seeder/log?lines=${lines}`, token)

// What a run costs, measured on a real one (docs/RUNNING.md, section 2): a full
// artist is ~45 s with YouTube Music, ~15 s without; a skinny one ~0.4 s; a first
// Wikidata run also pulls the list (~5 min) and reads 35 000 Deezer pages to rank
// them (~75 min), both cached after that.
export const WIKIDATA_ARTISTS = 35_000
export const FULL_SECONDS = 45
export const FULL_SECONDS_NO_YOUTUBE = 15
export const SKINNY_SECONDS = 0.4
export const WIKIDATA_FIRST_RUN_SECONDS = 80 * 60

export function estimateSeconds(run: { source: Source; limit: number; full: number; youtube: boolean }, cached: boolean) {
  const limit = run.source === 'wikidata' ? Math.min(run.limit, WIKIDATA_ARTISTS) : run.limit
  const full = Math.min(limit, Math.max(0, run.full))
  const perFull = run.youtube ? FULL_SECONDS : FULL_SECONDS_NO_YOUTUBE
  const warmup = run.source === 'wikidata' && !cached ? WIKIDATA_FIRST_RUN_SECONDS : 0
  return warmup + full * perFull + (limit - full) * SKINNY_SECONDS
}

/** 90 -> 'about 2 minutes', 5400 -> 'about 1.5 hours', 40 -> 'under a minute'. */
export function describeDuration(seconds: number) {
  if (seconds < 60) return 'under a minute'
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes`
  const hours = seconds / 3600
  const shown = hours < 10 ? Math.round(hours * 2) / 2 : Math.round(hours)
  return `about ${shown} ${shown === 1 ? 'hour' : 'hours'}`
}

/** Seconds left in a run from two readings of its progress, or null before the
 *  second reading moves. Rate is measured, not assumed: a run of full artists and
 *  a run of skinny ones differ a hundredfold. */
export function secondsLeft(first: { at: number; done: number }, now: { at: number; done: number }, total: number) {
  const elapsed = now.at - first.at, moved = now.done - first.done
  if (elapsed <= 0 || moved <= 0 || total <= now.done) return null
  return (total - now.done) * elapsed / moved
}

/** A line about the moment: 'Ranking 12,300 of 34,915 Deezer pages', 'Working on Beyoncé…'. */
export function phaseLine(p: SeedProgress, running: boolean) {
  if (!running) {
    if (p.state === 'interrupted') return 'The last run stopped early. Start it again to carry on: what landed stays, and is only refreshed.'
    return `Last run: ${p.done.toLocaleString('en-GB')} processed, ${p.failed.toLocaleString('en-GB')} failed.`
  }
  if (p.phase === 'wikidata') return `Fetching the artist list from Wikidata: ${p.done.toLocaleString('en-GB')} so far…`
  if (p.phase === 'ranking') return `Ranking by Deezer fans: ${p.done.toLocaleString('en-GB')} of ${p.total.toLocaleString('en-GB')} artist pages read. A first Wikidata run only; it is cached after this.`
  if (p.artist) return `Working on ${p.artist}…`
  return p.phase === 'seeding' ? 'Writing…' : 'Preparing the artist list…'
}

/** Drop failures nobody intends to chase; seeding one again puts it back. */
export const forgetFailures = (artists: string[], token?: string) =>
  call<SetupStatus>('/api/seeder/failures', token, { method: 'DELETE', body: JSON.stringify({ artists }) })

/** Needs the setup page: nobody can administer it yet, or it has no catalog keys. */
export const needsSetup = (status: SetupStatus) => !status.admin || !status.configured

/** Last.fm answers CORS, so a mistyped key is caught here rather than in a log. */
export async function lastfmKeyWorks(key: string) {
  const url = `https://ws.audioscrobbler.com/2.0/?method=chart.gettopartists&limit=1&format=json&api_key=${encodeURIComponent(key)}`
  const body = await fetch(url).then(r => r.json()).catch(() => null)
  return body !== null && !body.error
}
