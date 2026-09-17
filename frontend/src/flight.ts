// The flight: points to altitude, altitude to a position on the track, and the
// share text. Pure, so flight.test.ts can check it without a browser.
import type { Flight, OwnAnswer, Tier } from './api'

/** The summit. A perfect day -- every question at its best -- lands on Pluto, so
 *  the scale is set by the quiz: `max` is that day's ceiling in points. */
export const PLUTO_AU = 39.5
/** The Sun is a disc this many px across, centred on the foot of the track, so at
 *  0 AU it fills the bottom of the screen and the rocket sits on its rim. */
export const SUN_RADIUS = 320
/** Spacing is by leg, not by AU: every planet-to-planet leg is at least LEG_MIN px,
 *  more than a tall screen, so one body is ever in view at a time, plus a little
 *  per AU so the outer legs still read as the long ones. */
export const LEG_MIN = 1500
export const LEG_PER_AU = 140

export interface Landmark { name: string; au: number; size?: number; color?: string }

/** Bodies get a planet; the rest is a tick with a caption. Pluto is the summit. */
export const LANDMARKS: Landmark[] = [
  { name: 'Mercury', au: 0.39, size: 30, color: '#b9b1a6' },
  { name: 'Venus', au: 0.72, size: 64, color: '#e8c48a' },
  { name: 'Earth', au: 1, size: 68, color: '#6fb5ff' },
  { name: 'Mars', au: 1.52, size: 44, color: '#e0714a' },
  { name: 'Asteroid belt', au: 2.7 },
  { name: 'Jupiter', au: 5.2, size: 220, color: '#d9a877' },
  { name: 'Saturn', au: 9.5, size: 180, color: '#e6cf9a' },
  { name: 'Uranus', au: 19.2, size: 120, color: '#9fe3e8' },
  { name: 'Neptune', au: 30.1, size: 116, color: '#5b7cff' },
  { name: 'Pluto · Kuiper belt', au: PLUTO_AU, size: 34, color: '#cbb8a8' },
]

/** The day's ceiling: the key's sum when the RPC delivered it, else a rough one,
 *  every question at the top tier, so the rocket still flies before it loads. */
export const ceilingFor = (today: { quiz_date: string; question_count: number; tiers: Tier[] },
                           ceilings: Record<string, number>) =>
  ceilings[today.quiz_date] ?? today.question_count * Math.max(0, ...today.tiers.map(tier => tier.points))

/** Points to altitude on the day's scale: `max` points is Pluto. */
export const altitudeAu = (points: number, max: number) => max > 0 ? points / max * PLUTO_AU : 0

/** The bodies the legs run between: the Sun, then every planet, each with the px
 *  the track has climbed to reach it. Ticks fall wherever their AU lands in a leg. */
const STOPS = [{ au: 0 }, ...LANDMARKS.filter(mark => mark.size)].map(mark => ({ au: mark.au, px: 0 }))
for (let i = 1; i < STOPS.length; i++)
  STOPS[i].px = STOPS[i - 1].px + LEG_MIN + LEG_PER_AU * (STOPS[i].au - STOPS[i - 1].au)

/** Pixels up the track: the Sun's rim at 0 AU, straight within a leg, clamped to Pluto. */
export function trackPx(au: number): number {
  const at = Math.max(0, Math.min(au, PLUTO_AU))
  const i = Math.max(1, STOPS.findIndex(stop => stop.au >= at))
  const from = STOPS[i - 1], to = STOPS[i]
  return SUN_RADIUS + from.px + (to.px - from.px) * (at - from.au) / (to.au - from.au)
}

export interface Leg { name: string; au: number; points: number }

/** What is behind and what is ahead: the last body passed (the Sun at the start)
 *  and the next one coming, each with the gap in AU and in the points it takes to
 *  cover it on the day's scale. */
export function legs(au: number, max: number): { behind: Leg; ahead: Leg | null } {
  const bodies = [{ name: 'the Sun', au: 0 }, ...LANDMARKS.filter(mark => mark.size)]
  const gap = (mark: { name: string; au: number }): Leg => {
    const distance = Math.abs(mark.au - au)
    return { name: mark.name.split(' · ')[0], au: distance, points: Math.ceil(distance / PLUTO_AU * max - 1e-9) }
  }
  const behind = bodies.filter(mark => mark.au <= au).at(-1) ?? bodies[0]
  const ahead = bodies.find(mark => mark.au > au) ?? null
  return { behind: gap(behind), ahead: ahead && gap(ahead) }
}

/** The one-word class a landmark's planet is drawn with: 'pluto' for 'Pluto · Kuiper belt'. */
export const slug = (name: string) => name.toLowerCase().split(/[^a-z]/)[0]

/** The last landmark below you, for "past Jupiter". */
export const passed = (au: number) =>
  LANDMARKS.filter(mark => mark.au <= au).at(-1)?.name.split(' · ')[0] ?? 'the Sun'

/** A tier's badge in public/tiers: 'Main Sequence' is main-sequence.png. */
export const tierSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

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
                          tiers: Tier[], max: number): string {
  const grid = answers.map(answer => emojiFor(answer, tiers)).join('')
  return `Jamillion #${flight}\n${points} pts · ${altitudeAu(points, max).toFixed(1)} AU\n\n${grid}`
}

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

/** The bearing's bands as shares of a perfect day: the old 151/251/351/450 of 700. */
const BAND_SHARES = [
  { share: 0,         tier: 'Nebula',        verdict: 'Nebula. Still among the inner planets.' },
  { share: 151 / 700, tier: 'Main Sequence', verdict: 'Main sequence. Past the asteroid belt.' },
  { share: 251 / 700, tier: 'Red Giant',     verdict: 'Red giant. Out among the giants.' },
  { share: 351 / 700, tier: 'Supergiant',    verdict: 'Supergiant. Neptune is in the rear view.' },
  { share: 450 / 700, tier: 'Supernova',     verdict: 'Supernova. Pluto. Absurd.' },
]

/** The bands for a day whose ceiling is `max` points, ranges included. */
export function scoreBands(max: number): ScoreBand[] {
  const floor = (share: number) => Math.ceil(share * max - 1e-9)
  return BAND_SHARES.map((band, i) => {
    const min = floor(band.share)
    const next = BAND_SHARES[i + 1]
    return { min, tier: band.tier, verdict: band.verdict, range: next ? `${min}–${floor(next.share) - 1}` : `${min}+` }
  })
}

export const bandFor = (points: number, max: number) => {
  const bands = scoreBands(max)
  return [...bands].reverse().find(band => points >= band.min) ?? bands[0]
}

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

export function curveGeom(dist: number[], score: number, max: number) {
  const smooth = smoothDist(dist)
  const peak = Math.max(...smooth)
  if (!(peak > 0)) return null
  const width = 320, base = 78, rise = 68
  const pts: [number, number][] = [[0, base]]
  smooth.forEach((v, i) => pts.push([((i + 0.5) / smooth.length) * width, base - v / peak * rise]))
  pts.push([width, base])
  const line = catmull(pts)
  const youX = max > 0 ? Math.min(Math.max(score, 0), max) / max * width : 0
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
