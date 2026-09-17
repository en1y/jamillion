// The first-run status and its checks, beside Setup.tsx like admin.ts beside Admin.tsx.
import { call } from './api'

export interface SetupStatus {
  admin: boolean
  configured: boolean
  seeding: boolean
  artists: number
  seed_target: number
  progress?: {
    state: 'preparing' | 'running' | 'finished' | 'interrupted'
    done: number
    total: number
    failed: number
    artist: string
  }
  // /api/seeder only: what the catalog holds and what it is still missing.
  catalog?: { albums: number; tracks: number; previews: number; last_seeded: string }
  empty_artists?: string[]
  failures?: CatalogFailure[]
}

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
export const rerunSeeder = (request: { artists: string[] } | { limit: number }, token?: string) =>
  call<SetupStatus>('/api/seeder', token, { method: 'POST', body: JSON.stringify(request) })

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
