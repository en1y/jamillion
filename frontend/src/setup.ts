// The first-run status and its checks, beside Setup.tsx like admin.ts beside Admin.tsx.
import { call } from './api'

export interface SetupStatus {
  admin: boolean
  configured: boolean
  seeding: boolean
  artists: number
  seed_target: number
}

export const getSetup = () => call<SetupStatus>('/api/setup')

/** Needs the setup page: nobody can administer it yet, or it has no catalog keys. */
export const needsSetup = (status: SetupStatus) => !status.admin || !status.configured

/** Last.fm answers CORS, so a mistyped key is caught here rather than in a log. */
export async function lastfmKeyWorks(key: string) {
  const url = `https://ws.audioscrobbler.com/2.0/?method=chart.gettopartists&limit=1&format=json&api_key=${encodeURIComponent(key)}`
  const body = await fetch(url).then(r => r.json()).catch(() => null)
  return body !== null && !body.error
}
