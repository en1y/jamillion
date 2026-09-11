// The cockpit settings: what the flight sounds like and what it is drawn with.
// One localStorage row, one subscribe, and the sounds themselves -- synthesised,
// so the repo carries no audio files and a mute is a boolean, not a stopped fetch.
import { useEffect, useState } from 'react'

// node --test imports this for the pure halves below, and node has no storage.
const store: Pick<Storage, 'getItem' | 'setItem'> | null =
  typeof localStorage === 'undefined' ? null : localStorage

export type TierSkin = 'emoji' | 'art'
export type PlanetSkin = 'render' | 'disc' | 'ticks'

export interface Prefs {
  sfx: boolean
  sfxVolume: number
  music: number          // the snippet player's level, the old jam_volume
  tiers: TierSkin
  planets: PlanetSkin
}

const KEY = 'jam_prefs'
const DEFAULTS: Prefs = {
  sfx: true,
  sfxVolume: 0.5,
  music: Number(store?.getItem('jam_volume') ?? 0.35),
  tiers: 'art',
  planets: 'render',
}

/** Unknown keys and junk values fall back to the default: a hand-edited row, or
 *  one written by an older build, must never leave the game silent or unstyled. */
export function readPrefs(raw: string | null): Prefs {
  let saved: Record<string, unknown> = {}
  try { saved = { ...(JSON.parse(raw ?? '{}') as object) } } catch { /* keep the defaults */ }
  const pick = <K extends keyof Prefs>(key: K, ok: (value: unknown) => boolean): Prefs[K] =>
    ok(saved[key]) ? saved[key] as Prefs[K] : DEFAULTS[key]
  const level = (value: unknown) => typeof value === 'number' && value >= 0 && value <= 1
  return {
    sfx: pick('sfx', value => typeof value === 'boolean'),
    sfxVolume: pick('sfxVolume', level),
    music: pick('music', level),
    tiers: pick('tiers', value => value === 'emoji' || value === 'art'),
    planets: pick('planets', value => value === 'render' || value === 'disc' || value === 'ticks'),
  }
}

let prefs = readPrefs(store?.getItem(KEY) ?? null)
const listeners = new Set<(next: Prefs) => void>()

export const getPrefs = () => prefs

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch }
  store?.setItem(KEY, JSON.stringify(prefs))
  for (const listen of listeners) listen(prefs)
}

/** ponytail: a Set of setState calls, not a context -- the tree has one App. */
export function usePrefs(): Prefs {
  const [snapshot, setSnapshot] = useState(prefs)
  useEffect(() => { listeners.add(setSnapshot); return () => { listeners.delete(setSnapshot) } }, [])
  return snapshot
}

// --- the sounds ----------------------------------------------------------

/** A voice is a note: a wave, a pitch (or a slide between two), when it starts
 *  and how long it rings. Every effect is a handful of these, which is why there
 *  is no audio directory. */
interface Voice { wave?: OscillatorType; from: number; to?: number; at: number; len: number; gain?: number }

const ARPEGGIO = [523, 659, 784, 1047, 1319, 1568]   // C E G C E G, one rung per tier

/** The cue sheet. `rank` is the tier's index for a hit, so a Nebula gets two
 *  notes off the bottom of the arpeggio and a Supernova the whole ladder. */
export function voicesFor(cue: Cue, rank = 0): Voice[] {
  switch (cue) {
    case 'brief':   // a question arrives
      return [{ from: 880, at: 0, len: 0.09, gain: 0.5 }, { from: 1320, at: 0.08, len: 0.12, gain: 0.4 }]
    case 'type':    // a box is parked, the next one is due
      return [{ wave: 'square', from: 660, at: 0, len: 0.05, gain: 0.3 }]
    case 'send':    // the answer leaves for the tower
      return [{ from: 420, to: 1200, at: 0, len: 0.22, gain: 0.5 }]
    case 'hit':     // correct: the ladder climbed as far as the tier goes
      return ARPEGGIO.slice(0, Math.max(2, Math.min(rank + 2, ARPEGGIO.length)))
        .map((from, i) => ({ from, at: i * 0.075, len: 0.22, gain: 0.55 }))
    case 'miss':
      return [{ wave: 'sawtooth', from: 300, to: 150, at: 0, len: 0.3, gain: 0.35 }]
    case 'tick':    // the last seconds on the clock
      return [{ wave: 'square', from: 1500, at: 0, len: 0.04, gain: 0.35 }]
    case 'expire':
      return [{ wave: 'sawtooth', from: 220, to: 90, at: 0, len: 0.55, gain: 0.4 }]
    case 'click':
      return [{ wave: 'square', from: 520, at: 0, len: 0.04, gain: 0.25 }]
    case 'land':    // the results: the whole ladder, held
      return ARPEGGIO.map((from, i) => ({ from, at: i * 0.1, len: 0.5, gain: 0.45 }))
        .concat([{ from: ARPEGGIO[0] * 2, at: 0.7, len: 1.1, gain: 0.5 }])
  }
}

export type Cue = 'brief' | 'type' | 'send' | 'hit' | 'miss' | 'tick' | 'expire' | 'click' | 'land'

let ctx: AudioContext | null = null

/** Plays a cue, unless muted, the tab is silent, or the browser has not let us
 *  make noise yet. Never throws: a missing AudioContext must not stop a verdict. */
export function sfx(cue: Cue, rank = 0) {
  if (!prefs.sfx || prefs.sfxVolume <= 0) return
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  try {
    ctx ??= new AudioContext()
    void ctx.resume()                        // the first gesture unlocks it
    const now = ctx.currentTime + 0.01
    for (const voice of voicesFor(cue, rank)) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = voice.wave ?? 'triangle'
      osc.frequency.setValueAtTime(voice.from, now + voice.at)
      if (voice.to) osc.frequency.exponentialRampToValueAtTime(voice.to, now + voice.at + voice.len)
      // A short attack and an exponential tail: a square wave switched on and off
      // clicks, and the tail is what makes it a blip rather than a beep.
      const peak = Math.max(0.0001, (voice.gain ?? 0.5) * prefs.sfxVolume * 0.35)
      gain.gain.setValueAtTime(0.0001, now + voice.at)
      gain.gain.exponentialRampToValueAtTime(peak, now + voice.at + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + voice.at + voice.len)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + voice.at)
      osc.stop(now + voice.at + voice.len + 0.02)
    }
  } catch { /* no audio on this browser; the game is still playable */ }
}
