// The flight: points to altitude, altitude to a position on the track, and the
// share text. Pure, so flight.test.ts can check it without a browser.
import type { Flight, OwnAnswer, Tier } from './api'

export const AU_PER_POINT = 0.1714
export const HELIOPAUSE_AU = 120          // 700 points, a perfect run
/** Linear on purpose: the same points always move the rocket the same distance.
 *  The inner planets sit close together at the bottom, as they do in the sky;
 *  alternating the labels left and right keeps them readable. */
export const PX_PER_AU = 60

export interface Landmark { name: string; au: number; size?: number; color?: string }

/** Bodies get a dot; the rest is a tick with a caption. Voyager 1 (~167 AU) is
 *  past the top of the track, so the heliopause it crossed in 2012 is the summit. */
export const LANDMARKS: Landmark[] = [
  { name: 'Mercury', au: 0.39, size: 4, color: '#b9b1a6' },
  { name: 'Venus', au: 0.72, size: 7, color: '#e8c48a' },
  { name: 'Earth', au: 1, size: 7, color: '#6fb5ff' },
  { name: 'Mars', au: 1.52, size: 5, color: '#e0714a' },
  { name: 'Asteroid belt', au: 2.7 },
  { name: 'Jupiter', au: 5.2, size: 22, color: '#d9a877' },
  { name: 'Saturn', au: 9.5, size: 18, color: '#e6cf9a' },
  { name: 'Uranus', au: 19.2, size: 12, color: '#9fe3e8' },
  { name: 'Neptune', au: 30.1, size: 12, color: '#5b7cff' },
  { name: 'Pluto · Kuiper belt', au: 39.5, size: 4, color: '#cbb8a8' },
  { name: 'Eris', au: 68, size: 4, color: '#dfe6f0' },
  { name: 'Sedna', au: 76, size: 3, color: '#d98a6b' },
  { name: 'Termination shock · the solar wind stalls', au: 90 },
  { name: 'Voyager 2 crossed here, 2018', au: 119 },
  { name: 'Heliopause · Voyager 1, 2012', au: HELIOPAUSE_AU },
]

export const altitudeAu = (points: number) => points * AU_PER_POINT

/** Pixels up the track, 0 at the Sun, clamped to the heliopause. */
export const trackPx = (au: number) => Math.max(0, Math.min(au, HELIOPAUSE_AU)) * PX_PER_AU

/** The last landmark below you, for "past Jupiter". */
export const passed = (au: number) =>
  LANDMARKS.filter(mark => mark.au <= au).at(-1)?.name.split(' · ')[0] ?? 'the Sun'

/** One glyph per tier, in tier order, so renaming a tier does not break the grid. */
export const TIER_EMOJI = ['☁️', '✨', '⭐', '🔴', '🌟', '💥']
export const MISS_EMOJI = '⬛'

export const emojiForTier = (tier: string | null, tiers: Tier[]) => {
  const rank = tiers.findIndex(row => row.name === tier)
  return rank >= 0 ? TIER_EMOJI[rank] ?? MISS_EMOJI : MISS_EMOJI
}

export const emojiFor = (answer: OwnAnswer, tiers: Tier[]) =>
  answer.correct ? emojiForTier(answer.tier, tiers) : MISS_EMOJI

/** Quiz dates arrive as YYYY-MM-DD; show them as dd.mm.yyyy. */
export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return match ? `${match[3]}.${match[2]}.${match[1]}` : iso
}

/** The inverse: dd.mm.yyyy in, ISO out, '' if that is not a real day. The round
 *  trip is what rejects 31.02.2026 without a calendar table. */
export function parseDate(typed: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(typed.trim())
  if (!match) return ''
  const iso = `${match[3]}-${match[2]}-${match[1]}`
  const stamp = Date.parse(iso + 'T00:00:00Z')
  return !Number.isNaN(stamp) && new Date(stamp).toISOString().slice(0, 10) === iso ? iso : ''
}

/** Month arithmetic for the flight deck's calendar. UTC throughout: a local-time
 *  Date west of Greenwich rolls a midnight ISO string back to the day before. */
const pad = (n: number) => String(n).padStart(2, '0')
const utc = (iso: string) => new Date(iso + 'T00:00:00Z')
const isoOf = (d: Date) => d.toISOString().slice(0, 10)

/** Monday-first, so Sunday's 0 becomes 6. */
export const weekday = (iso: string) => (utc(iso).getUTCDay() + 6) % 7

export function shiftDay(iso: string, days: number): string {
  const d = utc(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return isoOf(d)
}

/** Clamped, so a month back from the 31st lands on the 30th, not on the 1st. */
export function shiftMonth(iso: string, months: number): string {
  const d = utc(iso)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return isoOf(d)
}

/** One month of cells, Monday-first: leading blanks, then every day as ISO. */
export function monthGrid(iso: string): (string | null)[] {
  const d = utc(iso)
  const year = d.getUTCFullYear(), month = d.getUTCMonth()
  const first = `${year}-${pad(month + 1)}-01`
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return [...Array<null>(weekday(first)).fill(null),
          ...Array.from({ length }, (_, i) => `${year}-${pad(month + 1)}-${pad(i + 1)}`)]
}

/** en-GB so the heading reads the same everywhere, like the dd.mm.yyyy below it. */
export const monthLabel = (iso: string) =>
  utc(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export function shareText(flight: number, points: number, answers: OwnAnswer[],
                          tiers: Tier[]): string {
  const grid = answers.map(answer => emojiFor(answer, tiers)).join('')
  return `JAMILLION #${flight}\n${altitudeAu(points).toFixed(1)} AU\n\n${grid}`
}

export const MAX_POINTS = 700
export const DIST_BINS = 36

export interface TierMeta { height: number; color: string; blurb: string }

/** Height is 0 at the Sun, 1 at the heliopause, matching Krillion's dive-log depths. */
export const TIER_META: Record<string, TierMeta> = {
  Nebula:          { height: 0.08, color: '#8fa3c4', blurb: 'The answer everyone blurts out.' },
  Protostar:       { height: 0.18, color: '#ff9f43', blurb: 'A famously “obscure” pick. Everyone reaches for it.' },
  'Main Sequence': { height: 0.36, color: '#7fe9ff', blurb: 'Solid — flying with the field.' },
  'Red Giant':     { height: 0.60, color: '#e0714a', blurb: 'Genuinely uncommon. Nice pull.' },
  Supergiant:      { height: 0.82, color: '#9d7bff', blurb: 'True obscurity. Few go this far.' },
  Supernova:       { height: 0.97, color: '#ffc46b', blurb: 'The designated gem. Edge of the system.' },
}

export interface ScoreBand { min: number; tier: string; range: string; verdict: string }

export const SCORE_BANDS: ScoreBand[] = [
  { min: 0,   tier: 'Nebula',        range: '0–150',   verdict: 'Nebula. Still among the inner planets.' },
  { min: 151, tier: 'Main Sequence', range: '151–250', verdict: 'Main sequence. Past the asteroid belt.' },
  { min: 251, tier: 'Red Giant',     range: '251–350', verdict: 'Red giant. Out among the giants.' },
  { min: 351, tier: 'Supergiant',    range: '351–449', verdict: 'Supergiant. The Kuiper belt is in the rear view.' },
  { min: 450, tier: 'Supernova',     range: '450+',    verdict: 'Supernova. Heliopause. Absurd.' },
]

export const bandFor = (points: number) =>
  [...SCORE_BANDS].reverse().find(band => points >= band.min) ?? SCORE_BANDS[0]

/** How far down the flight log a mark sits: 0 at the Sun, ~1 at the heliopause.
 *  Same depths Krillion uses, so a miss hugs the top and a Supernova lands at the bottom. */
export function logDepth(tier: string | null, correct: boolean) {
  if (!correct || !tier) return 0.03
  return TIER_META[tier]?.height ?? 0.03
}

export function smoothDist(dist: number[]): number[] {
  const kernel = [0.06, 0.24, 0.4, 0.24, 0.06]
  return dist.map((_, i) => {
    let n = 0, a = 0
    for (let t = -2; t <= 2; t++) {
      const s = i + t
      if (s < 0 || s >= dist.length) continue
      n += dist[s] * kernel[t + 2]
      a += kernel[t + 2]
    }
    return a > 0 ? n / a : 0
  })
}

function catmull(points: [number, number][]): string {
  if (points.length < 2) return ''
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let r = 0; r < points.length - 1; r++) {
    const prev = points[Math.max(0, r - 1)]
    const a = points[r]
    const b = points[r + 1]
    const next = points[Math.min(points.length - 1, r + 2)]
    d += ` C ${a[0] + (b[0] - prev[0]) / 6} ${a[1] + (b[1] - prev[1]) / 6},`
      + ` ${b[0] - (next[0] - a[0]) / 6} ${b[1] - (next[1] - a[1]) / 6},`
      + ` ${b[0]} ${b[1]}`
  }
  return d
}

export function curveGeom(dist: number[], score: number) {
  const smooth = smoothDist(dist)
  const peak = Math.max(...smooth)
  if (!(peak > 0)) return null
  const width = 320, base = 78, rise = 68
  const pts: [number, number][] = [[0, base]]
  smooth.forEach((v, i) => pts.push([((i + 0.5) / smooth.length) * width, base - v / peak * rise]))
  pts.push([width, base])
  const line = catmull(pts)
  const youX = Math.min(Math.max(score, 0), MAX_POINTS) / MAX_POINTS * width
  let youY = base
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1]
    if (youX >= x0 && youX <= x1) {
      youY = y0 + (y1 - y0) * (x1 === x0 ? 0 : (youX - x0) / (x1 - x0))
      break
    }
  }
  return { line, fill: `${line} L ${width} ${base} L 0 ${base} Z`, youX, youY, width, base }
}

/** The quiz day rolls at 04:00 UTC, same as game_today() in the database. */
export function nextRollover(now = Date.now()): Date {
  const date = new Date(now)
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 4, 0, 0)
  return new Date(now < next ? next : next + 86_400_000)
}

export function countdown(to: Date, now = Date.now()): string {
  const left = to.getTime() - now
  if (left <= 0) return 'ready'
  const s = Math.floor(left / 1000)
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export function nextIsoDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return iso
  return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3] + 1)).toISOString().slice(0, 10)
}

export interface Logbook { streak: number; played: number; total: number; best: number; lastDate: string | null }

export const EMPTY_LOG: Logbook = { streak: 0, played: 0, total: 0, best: 0, lastDate: null }

/** The logbook, derived from the flights the server reports rather than kept in
 *  localStorage: it follows the account across browsers, and there is one place
 *  a streak can be wrong. Flights arrive newest first; the streak walks back
 *  while each older row is exactly one game day earlier. */
export function summarize(flights: Flight[]): Logbook {
  if (flights.length === 0) return { ...EMPTY_LOG }
  let streak = 1
  while (streak < flights.length &&
         nextIsoDate(flights[streak].quiz_date) === flights[streak - 1].quiz_date) streak++
  return {
    streak,
    played: flights.length,
    total: flights.reduce((sum, flight) => sum + flight.total_points, 0),
    best: flights.reduce((top, flight) => Math.max(top, flight.total_points), 0),
    lastDate: flights[0].quiz_date,
  }
}
