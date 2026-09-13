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
    failed_artists?: string[]
  }
}

export const getSetup = () => call<SetupStatus>('/api/setup')

/** The staff-only counterpart to the first-run status. It deliberately returns
 * counts and state only; catalog keys never leave the server. */
export const getSeeder = (token?: string) => call<SetupStatus>('/api/seeder', token)

export const rerunSeeder = (request: { artist: string } | { limit: number }, token?: string) =>
  call<SetupStatus>('/api/seeder', token, { method: 'POST', body: JSON.stringify(request) })

/** Needs the setup page: nobody can administer it yet, or it has no catalog keys. */
export const needsSetup = (status: SetupStatus) => !status.admin || !status.configured

/** Last.fm answers CORS, so a mistyped key is caught here rather than in a log. */
export async function lastfmKeyWorks(key: string) {
  const url = `https://ws.audioscrobbler.com/2.0/?method=chart.gettopartists&limit=1&format=json&api_key=${encodeURIComponent(key)}`
  const body = await fetch(url).then(r => r.json()).catch(() => null)
  return body !== null && !body.error
}
