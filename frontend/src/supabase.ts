import { createClient } from '@supabase/supabase-js'

// The compose stack's Caddy serves /config.js with the anon key generated on its
// first boot, and Supabase on this same origin. `npm run dev` gets the empty
// public/config.js and falls back to the VITE_ values in .env.
const runtime = (globalThis as { JAM?: { anonKey: string } }).JAM
const url = runtime ? globalThis.location.origin : import.meta.env.VITE_SUPABASE_URL
const key = runtime?.anonKey ?? import.meta.env.VITE_SUPABASE_ANON_KEY
export const supabase = url && key ? createClient(url, key) : null

/** Each published day's ceiling in points, by date: the quiz_ceilings() RPC, the
 *  one number the frontend reads from the answer key. Empty without Supabase
 *  configured or when the call fails; callers fall back to a rough ceiling. */
export async function getCeilings(): Promise<Record<string, number>> {
  if (!supabase) return {}
  const { data } = await supabase.rpc('quiz_ceilings')
  return Object.fromEntries(((data ?? []) as { quiz_date: string; max_points: number }[])
    .map(row => [row.quiz_date, row.max_points]))
}

export interface Player {
  player_id: string
  authenticated: boolean
  role: 'user' | 'moderator' | 'admin'
  profile: { id: string; username: string; role: Player['role'] } | null
}

// Serialize identity requests so a late response cannot overwrite a newer cookie.
let pending: Promise<unknown> = Promise.resolve()
export function getPlayer(token: string | undefined, signal: AbortSignal): Promise<Player> {
  const request = pending.catch(() => {}).then(async () => {
    signal.throwIfAborted()
    const response = await fetch('/api/me', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    // Guarded like api.ts's call(): a backend that is down or restarting answers
    // through the proxy with an empty body, and a bare .json() puts the browser's
    // own "unexpected end of data" in front of the player.
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Unable to load your player. Please retry.')
    return body as Player
  })
  pending = request
  return request
}
