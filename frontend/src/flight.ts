// The flight: points to altitude, altitude to a position on the track, and the
// share text. Pure, so flight.test.ts can check it without a browser.
import type { OwnAnswer, Tier } from './api'

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

export function shareText(date: string, points: number, answers: OwnAnswer[],
                          tiers: Tier[], origin: string): string {
  const grid = answers.map(answer => emojiFor(answer, tiers)).join('')
  return `JAMILLION ${formatDate(date)} · ${altitudeAu(points).toFixed(1)} AU\n${grid}\n${origin}`
}
