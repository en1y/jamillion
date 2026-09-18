import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { ApiError, getFlights, getReveal, isKnown, sendIdea, startAttempt, submitAnswer, submitField, suggest } from './api'
import type { Answered, OwnAnswer, Progress, Question, Result, RevealedQuestion, SuggestKind, Today } from './api'
import {
  altitudeAu, bandFor, countdown, curveGeom, EMPTY_LOG,
  LANDMARKS, logDepth, nextRollover, passed, PLUTO_AU, scoreBands, shareText,
  slug, summarize, TIER_META, trackPx,
} from './flight'
import { useCountUp } from './count'
import { setPrefs, sfx, usePrefs } from './prefs'
import { TierIcon } from './Settings'

interface Star { x: number; y: number; r: number; vx: number; vy: number; a: number; tw: number }
interface Comet { x: number; y: number; vx: number; vy: number; len: number }

function rand(min: number, max: number) { return min + Math.random() * (max - min) }

function sprinkle(count: number, width: number, height: number, speed: number): Star[] {
  // Random positions, not a grid: a repeating tile looked like wallpaper.
  return Array.from({ length: count }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    r: rand(0.4, 1.8),
    vx: rand(-speed * 0.55, speed * 0.55),
    vy: speed * rand(0.45, 1.25),
    a: rand(0.35, 0.95),
    tw: Math.random() * Math.PI * 2,
  }))
}

function throwComet(width: number, height: number): Comet {
  const edge = Math.floor(Math.random() * 4)
  const speed = rand(5.5, 11)
  const angle = rand(18, 52) * Math.PI / 180
  let x: number
  let y: number
  let vx: number
  let vy: number

  if (edge === 0) { // left, heading right
    x = -30
    y = rand(0, height)
    vx = Math.cos(angle) * speed
    vy = Math.sin(angle) * speed
  } else if (edge === 1) { // right, heading left
    x = width + 30
    y = rand(0, height)
    vx = -Math.cos(angle) * speed
    vy = Math.sin(angle) * speed
  } else if (edge === 2) { // top, heading down
    x = rand(0, width)
    y = -30
    vx = Math.sin(angle) * speed
    vy = Math.cos(angle) * speed
  } else { // bottom, heading up
    x = rand(0, width)
    y = height + 30
    vx = Math.sin(angle) * speed
    vy = -Math.cos(angle) * speed
  }

  return {
    x,
    y,
    vx,
    vy,
    len: rand(70, 160),
  }
}

const WARP_MS = 4200   // how long the stars stream after a climb: the trip, zoom out to zoom in

/** Drifting stars plus a comet whose tail always points opposite its velocity.
 *  When the altitude changes the stars streak downward past the rocket and
 *  settle again over WARP_MS: the rocket is flying away, the sky says so. */
function Starfield({ au }: { au: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const warpAt = useRef(-Infinity)   // when the last climb began; the rush is read off the clock
  const was = useRef(au)
  useEffect(() => { if (au > was.current) warpAt.current = performance.now(); was.current = au }, [au])
  useEffect(() => {
    const node = canvas.current
    if (!node) return
    const ctx = node.getContext('2d')
    if (!ctx) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 0, height = 0, far: Star[] = [], mid: Star[] = [], near: Star[] = []
    let comet: Comet | null = null, wait = rand(400, 1800), last = performance.now(), raf = 0

    // A phone paints the sky at 1x: a canvas redrawn every frame at 2-3x is what
    // made mobile Firefox stutter, and a star is a dot either way.
    const touch = matchMedia('(pointer: coarse)').matches
    const dpr = touch ? 1 : Math.min(devicePixelRatio || 1, 2)
    function resize() {
      if (node!.clientWidth === width && node!.clientHeight === height) return
      width = node!.clientWidth
      height = node!.clientHeight
      node!.width = Math.max(1, Math.round(width * dpr))
      node!.height = Math.max(1, Math.round(height * dpr))
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Dense enough that a zoomed-out sky still reads as a sky: ~one star per 1500 px².
      const per = width * height / 1500
      far = sprinkle(Math.round(per * 0.62), width, height, 0.18)
      mid = sprinkle(Math.round(per * 0.28), width, height, 0.38)
      near = sprinkle(Math.round(per * 0.1), width, height, 0.7)
      comet = null
      wait = rand(200, 1200)
      if (reduce) { ctx!.clearRect(0, 0, width, height); sky(0, 0) }
    }

    // Ease-in-out on the rush so the streaks build and fade rather than switch.
    // Clock-based, not frame-based: a throttled tab still settles on time.
    const surge = (now: number) => { const r = Math.max(0, 1 - (now - warpAt.current) / WARP_MS); return r * r * (3 - 2 * r) }

    function wrap(star: Star, dt: number, boost: number) {
      star.x += star.vx * dt
      star.y += star.vy * dt * (1 + boost)
      if (star.x < 0) star.x += width; else if (star.x > width) star.x -= width
      if (star.y > height) star.y -= height; else if (star.y < 0) star.y += height
    }

    // One fill per brightness bucket instead of one per star: a few hundred stars
    // cost four path fills a frame. Twinkle rides on the bucket, phase by bucket.
    const BUCKETS = 4
    // The sky zooms with the camera: read its live scale (wheel or trip), paint
    // the field once at that scale into a tile and repeat the tile across the
    // screen, anchored at the rocket point, so a zoomed-out sky is still full.
    const cam = node.parentElement?.querySelector<HTMLElement>('.camera')
    const tile = document.createElement('canvas')
    const tctx = tile.getContext('2d')!
    let s = 1, cx = 0, cy = 0
    // The camera sits at a fixed point of the scene (CSS: left 50%, bottom --pin),
    // so its position is arithmetic; measuring it forced a layout every frame. Its
    // scale is only read while a zoom or the trip is running, plus once after:
    // getComputedStyle every frame was a style recalc a phone paid 60 times a second.
    let moving = 0, settle = true
    const start = () => { moving++ }
    const stop = () => { moving = Math.max(0, moving - 1); settle = true }
    const events = ['transitionrun', 'animationstart'] as const, ends = ['transitionend', 'transitioncancel', 'animationend', 'animationcancel'] as const
    for (const e of events) cam?.addEventListener(e, start)
    for (const e of ends) cam?.addEventListener(e, stop)
    function lens() {
      if (moving || settle) { s = Math.min(1, (cam && parseFloat(getComputedStyle(cam).scale)) || 1); settle = false }
      cx = width / 2
      cy = height * 0.48
    }
    function paint(g: CanvasRenderingContext2D, stars: Star[], now: number, boost: number) {
      const floor = 0.4 / s   // a star never paints under 0.4 screen px
      for (let b = 0; b < BUCKETS; b++) {
        const twinkle = 0.65 + 0.35 * Math.sin(now / 700 + b * 1.7)
        g.fillStyle = `rgba(232,241,255,${(0.35 + 0.6 * (b + 0.5) / BUCKETS) * twinkle})`
        g.beginPath()
        for (const star of stars) {
          if (Math.floor((star.a - 0.35) / 0.6 * BUCKETS) % BUCKETS !== b) continue
          const r = Math.max(floor, star.r)
          g.moveTo(star.x + r, star.y)
          g.arc(star.x, star.y, r, 0, Math.PI * 2)
        }
        g.fill()
      }
      if (boost <= 1) return
      // streaks behind the stars, as long as the distance each just flew
      g.strokeStyle = 'rgba(232,241,255,0.4)'
      g.lineWidth = 1 / s
      g.beginPath()
      for (const star of stars) {
        const tail = star.vy * boost * 2
        if (tail > 2) { g.moveTo(star.x, star.y - tail); g.lineTo(star.x, star.y) }
      }
      g.stroke()
    }
    // Every layer, through the lens: straight onto the screen at 1:1, else via the tile.
    function sky(now: number, boost: number) {
      lens()
      if (s > 0.999) { paint(ctx!, far, now, boost); paint(ctx!, mid, now, boost); paint(ctx!, near, now, boost); return }
      const tw = Math.max(1, Math.round(width * s * dpr)), th = Math.max(1, Math.round(height * s * dpr))
      if (tile.width !== tw || tile.height !== th) { tile.width = tw; tile.height = th }
      tctx.setTransform(tw / width, 0, 0, th / height, 0, 0)
      tctx.clearRect(0, 0, width, height)   // in field units, under the transform, so the whole tile clears
      paint(tctx, far, now, boost); paint(tctx, mid, now, boost); paint(tctx, near, now, boost)
      const pattern = ctx!.createPattern(tile, 'repeat')!
      pattern.setTransform(new DOMMatrix().translate(cx - cx * s, cy - cy * s).scale(1 / dpr))
      ctx!.fillStyle = pattern
      ctx!.fillRect(0, 0, width, height)
    }

    function frame(now: number) {
      raf = requestAnimationFrame(frame)
      // ponytail: a phone drifts the sky at ~30 fps, and at the full rate only while
      // it streams or zooms. A full-screen canvas every frame fought the keyboard and
      // the page's own animations for the main thread; a drifting dot needs half that.
      if (touch && now - last < 30 && !moving && surge(now) === 0) return
      const dt = Math.min(3, (now - last) / 16.67)
      last = now
      const boost = surge(now) * 70   // near stars fly ~50 px a frame at full rush
      ctx!.clearRect(0, 0, width, height)
      for (const star of far) wrap(star, dt, boost)
      for (const star of mid) wrap(star, dt, boost)
      for (const star of near) wrap(star, dt, boost)
      sky(now, boost)

      if (!comet) {
        wait -= dt * 16.67
        if (wait <= 0) comet = throwComet(width, height)
      } else {
        comet.x += comet.vx * dt
        comet.y += comet.vy * dt
        const mag = Math.hypot(comet.vx, comet.vy) || 1
        const tx = comet.x - (comet.vx / mag) * comet.len
        const ty = comet.y - (comet.vy / mag) * comet.len
        // The comet lives in the home field: through the lens it shrinks with the
        // zoom and flies on across the neighbouring fields until it leaves its own.
        ctx!.save()
        ctx!.translate(cx - cx * s, cy - cy * s)
        ctx!.scale(s, s)
        const tail = ctx!.createLinearGradient(tx, ty, comet.x, comet.y)
        tail.addColorStop(0, '#fff0')
        tail.addColorStop(0.7, '#fff6')
        tail.addColorStop(1, '#ffff')
        ctx!.strokeStyle = tail
        ctx!.lineWidth = Math.max(2, 1 / s)   // never thinner than a screen pixel
        ctx!.beginPath()
        ctx!.moveTo(tx, ty)
        ctx!.lineTo(comet.x, comet.y)
        ctx!.stroke()
        ctx!.fillStyle = '#fff'
        ctx!.beginPath()
        ctx!.arc(comet.x, comet.y, Math.max(1.8, 0.6 / s), 0, Math.PI * 2)
        ctx!.fill()
        ctx!.restore()
        // gone only once it is off the screen, not off its own field: zoomed out
        // it keeps flying across the neighbouring tiles
        const left = cx - cx / s, top = cy - cy / s
        if (comet.x < left - 200 || comet.x > left + width / s + 200 || comet.y < top - 200 || comet.y > top + height / s + 200) {
          comet = null
          wait = rand(5000, 14000)
        }
      }
    }

    resize()
    if (reduce) {
      sky(0, 0)
    } else {
      raf = requestAnimationFrame(frame)
    }
    const watch = new ResizeObserver(resize)
    watch.observe(node)
    return () => {
      cancelAnimationFrame(raf); watch.disconnect()
      for (const e of events) cam?.removeEventListener(e, start)
      for (const e of ends) cam?.removeEventListener(e, stop)
    }
  }, [])
  return <canvas className="starfield" ref={canvas} />
}

/** The solar system, always behind the page. The track slides down as you climb,
 *  so the rocket stays put and the landmarks drift past: the camera follows you. */
export type Mood = 'boost' | 'tumble' | null

/** `zoom` is the player's own, from the wheel; a climb plays the trip on top of
 *  it: the camera pulls out until both planets fit, flies the leg, and pushes
 *  back in, so the progress between the planets is seen rather than implied. */
export function Scene({ au, mood, zoom = 1 }: { au: number; mood?: Mood; zoom?: number }) {
  const skin = usePrefs().planets   // rendered spheres, flat discs, or a bare chart
  const camera = useRef<HTMLDivElement>(null)
  const scene = useRef<HTMLDivElement>(null)
  // The keyboard takes height, never width: the sky's height is measured again only
  // when the width changes (a rotation), so opening the keyboard moves nothing behind
  // the HUD -- no Sun jump, no canvas realloc, no re-scattered stars.
  useEffect(() => {
    const root = document.documentElement
    let width = 0
    function pin() {
      if (innerWidth === width || !scene.current) return
      width = innerWidth
      root.style.removeProperty('--sky')
      root.style.setProperty('--sky', `${scene.current.offsetHeight}px`)
    }
    pin()
    addEventListener('resize', pin)
    return () => removeEventListener('resize', pin)
  }, [])
  const was = useRef(au)
  useEffect(() => {
    if (au > was.current && camera.current) {
      const node = camera.current
      node.classList.remove('trip')
      void node.offsetWidth                  // restart the animation on a back-to-back climb
      node.classList.add('trip')
    }
    was.current = au
  }, [au])
  return (
    <div ref={scene} className={`scene planets-${skin} ${mood ?? ''}`} aria-hidden="true" style={{ '--y': `${trackPx(au)}px`, '--zoom': zoom } as CSSProperties}>
      <Starfield au={au} />
      <div className="camera" ref={camera}>
      <div className="track" style={{ height: `${trackPx(PLUTO_AU) + 300}px` }}>
        <span className="sun" />
        {LANDMARKS.map((mark, i) => (
          <span key={mark.name}
                className={`landmark ${i % 2 ? 'left' : 'right'}${mark.size ? ` planet-${slug(mark.name)}` : ' tick'}`}
                style={{ '--px': `${trackPx(mark.au)}px`, '--size': `${mark.size ?? 0}px`,
                         '--color': mark.color ?? 'transparent' } as CSSProperties}>
            <i />{mark.name}
          </span>
        ))}
      </div>
      </div>
      <span className={`rocket ${mood ?? ''}`}>▲</span>
    </div>
  )
}

const LEAD_IN = 1000        // the page settles before the music starts
/** Ramp at each edge of the clip, as a share of it: sqrt keeps it proportional but
 *  ever thinner -- 15% of a 4 s window, 5% of a 30 s one, so a long snippet is not
 *  spent fading. Capped at 2 s, floored at 0.2 so a degenerate window still ramps. */
const edgeOf = (len: number) => Math.min(2, Math.max(0.2, 0.3 * Math.sqrt(len)))

function Snippet({ question }: { question: Question }) {
  const audio = useRef<HTMLAudioElement>(null)
  const fade = useRef(0)
  const fadeTo = useRef(1)
  const [playing, setPlaying] = useState(false)
  // Snippet remounts per question, so the level lives in the cabin settings, not
  // here: it outlives the question, and the gear in the header moves the same knob.
  const volume = usePrefs().music
  const start = question.snippet_start_sec ?? 0
  const end = start + (question.snippet_len_sec ?? 30)
  const [at, setAt] = useState(start)
  const edge = edgeOf(end - start)

  // Seeking before the metadata lands is silently dropped, so the clip would start
  // at 0 and give away the intro. readyState >= 1 means the duration is known.
  function ready(then: (element: HTMLAudioElement) => void) {
    const element = audio.current
    if (!element) return
    if (element.readyState >= 1) then(element)
    else element.addEventListener('loadedmetadata', () => then(element), { once: true })
  }
  // ponytail: a 50 ms setInterval on element.volume, not a Web Audio gain node --
  // no AudioContext to unlock, and the step is well under what an ear hears.
  function ramp(element: HTMLAudioElement, to: number, then?: () => void) {
    clearInterval(fade.current)
    fadeTo.current = to
    const step = (to - element.volume) / (edge * 20)
    fade.current = setInterval(() => {
      const next = element.volume + step
      if (step === 0 || (step > 0 ? next >= to : next <= to)) {
        element.volume = to
        clearInterval(fade.current)
        then?.()
      } else element.volume = next
    }, 50) as unknown as number
  }
  function play(from?: number) {
    ready(element => {
      if (from !== undefined) element.currentTime = from
      element.volume = 0
      // Browsers may refuse a play() the player did not ask for; the button covers it.
      element.play().then(() => { setPlaying(true); ramp(element, volume) }).catch(() => setPlaying(false))
    })
  }
  function stop(element: HTMLAudioElement) {
    if (fadeTo.current === 0) return   // timeupdate fires four times a second; one ramp is enough
    ramp(element, 0, () => element.pause())
  }
  function toggle() {
    if (playing) { const element = audio.current; if (element) stop(element) }
    else play(at >= end - 0.25 ? start : undefined)   // at the end, start over
  }
  function scrub(to: number) {
    setAt(to)
    ready(element => { element.currentTime = to })
  }
  function level(to: number) {
    setPrefs({ music: to })
    const element = audio.current
    if (element) { clearInterval(fade.current); fadeTo.current = to; element.volume = to }   // the hand on the knob wins over a ramp
  }
  // One attempt at autoplay when the question arrives, a beat after the page lands.
  useEffect(() => {
    const element = audio.current
    const timer = setTimeout(() => play(start), LEAD_IN)
    return () => { clearTimeout(timer); clearInterval(fade.current); element?.pause() }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const shown = Math.min(Math.max(at, start), end)
  return (
    <div className="snippet">
      <audio ref={audio} src={question.audio} preload="auto"
             onPause={() => setPlaying(false)}
             onTimeUpdate={event => {
               const element = event.currentTarget
               setAt(element.currentTime)
               // the window, not the whole preview -- and it dies down into the end of it.
               // The ramp does the pausing; the hard stop is only there if it never lands.
               if (element.currentTime >= end - edge) stop(element)
               if (element.currentTime >= end + 0.5) element.pause()
             }} />
      <button className="play" type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <input type="range" min={start} max={end} step={0.1} value={shown}
             onChange={event => scrub(Number(event.target.value))} aria-label="Position in the snippet" />
      <span className="clock">{(shown - start).toFixed(0)}s / {(end - start).toFixed(0)}s</span>
      <span className="volume">
        <span aria-hidden="true">{volume === 0 ? '♪̸' : '♪'}</span>
        <input type="range" min={0} max={1} step={0.01} value={volume}
               onChange={event => level(Number(event.target.value))} aria-label="Volume" />
      </span>
    </div>
  )
}

/** The server owns the clock; this only reads its deadline. Its 3 s grace absorbs
 *  the round trip and any clock skew. */
function remaining(question: Question) {
  if (!question.deadline) return Infinity
  const left = Date.parse(question.deadline) - Date.now()
  return Math.max(0, Math.min(left, question.time_limit_sec * 1000))
}

function Countdown({ question, onExpire }: { question: Question; onExpire: () => void }) {
  const [left, setLeft] = useState(() => remaining(question))
  const expire = useRef(onExpire)
  useEffect(() => { expire.current = onExpire })

  // No deadline is an untimed question: nothing to count, and nothing to submit
  // on the player's behalf. The hooks above still run, so the ring can come and
  // go between questions without changing how many hooks this renders.
  const untimed = !question.deadline
  useEffect(() => {
    if (untimed) return
    const timer = setInterval(() => {
      const next = remaining(question)
      setLeft(next)
      if (next === 0) { clearInterval(timer); expire.current() }
    }, 250)
    return () => clearInterval(timer)
  }, [question, untimed])

  const seconds = Math.ceil(left / 1000)
  const late = seconds <= 5
  // One blip a second over the last five: the clock, heard. Above the early
  // return, like the rest, so an untimed question renders the same hooks.
  useEffect(() => { if (!untimed && late && seconds > 0) sfx('tick') }, [seconds, late, untimed])
  if (untimed) return null
  const style = { '--p': left / (question.time_limit_sec * 1000) } as CSSProperties
  return (<>
    <span className={late ? 'ring late' : 'ring'} role="timer" style={style}><span>{seconds}</span></span>
    {late && <i className="edge" aria-hidden="true" />}   {/* the screen's edges throb with the last seconds */}
  </>)
}

interface Field { key: string; kind: SuggestKind | null; label: string }

/** The one box of a question that asks for no catalog name: whatever the key says
 *  is the answer, typed free. */
const FREE: Field = { key: 'text', kind: null, label: 'your answer' }

/** Rarest: one free field. Song and album: the fields the moderator asked for --
 *  and when they asked for none of them, the question is about the cover or the
 *  clip rather than the names on it, so it is one free field too. */
function fieldsFor(question: Question): Field[] {
  if (question.qtype === 'rarest') return [FREE]
  const fields: Field[] = []
  if (question.ask_artist !== false) fields.push({ key: 'artist', kind: 'artist', label: 'artist' })
  if (question.ask_title !== false) fields.push(question.qtype === 'song'
    ? { key: 'title', kind: 'title', label: 'song title' }
    : { key: 'title', kind: 'album', label: 'album title' })
  // Song only: which record it came from. Order matters -- the answer is these
  // fields joined, and the moderator's key was seeded in the same order.
  if (question.qtype === 'song' && question.ask_album)
    fields.push({ key: 'album', kind: 'album', label: 'album' })
  return fields.length > 0 ? fields : [FREE]
}

/** Catalog names, and the moderator's for this box, starting with what is typed,
 *  from the third character, debounced. A free box has no catalog kind: what it
 *  offers is the question's own accepted answers, which is the only help there is
 *  when the key is the whole truth about what counts. */
function useSuggest(kind: SuggestKind | null, on: boolean, value: string, question: number, field: string) {
  const [options, setOptions] = useState<string[]>([])
  const q = value.trim()
  const long = [...q].length >= 3     // characters, not UTF-16 units
  useEffect(() => {
    if (!on || !long) return
    let live = true
    const timer = setTimeout(() => {
      // A free box names no field: the key is the whole question's, not one box of it.
      suggest(kind, q, kind ? { question, field } : { question }).then(next => { if (live) setOptions(next) }).catch(() => { if (live) setOptions([]) })
    }, 150)
    return () => { live = false; clearTimeout(timer) }
  }, [kind, on, q, long, question, field])
  // Options from an earlier query linger until the next reply; only the ones that
  // still start with what is typed are offered, so nothing stale shows.
  const prefix = q.toLocaleLowerCase()
  return on && long ? options.filter(option => option.toLocaleLowerCase().startsWith(prefix)) : []
}

/** One field, with the catalog's completions under it. A <datalist> was doing
 *  this job, but browsers draw that one their own way or not at all, and on a
 *  three-field song question the player needs to see what is on offer. The list
 *  opens *upward*: these inputs live in the HUD along the bottom of the screen. */
function Input({ question, field, value, onChange, autoFocus, invalid, hint, help, onLeave }: {
  question: number; field: Field; value: string; onChange: (value: string) => void; autoFocus: boolean; invalid: boolean
  hint?: 'next' | 'send'; help?: boolean; onLeave?: (direction: -1 | 1) => void
}) {
  // help === false: the moderator wants this one typed from memory. The typo check
  // stays -- only catalog names are accepted, and being told so beats a refusal.
  const options = useSuggest(field.kind, help !== false, value, question, field.key)
  const [open, setOpen] = useState(true)
  const [cursor, setCursor] = useState(-1)

  // Nothing left to offer once the field already says what an option says.
  const shown = open && !options.includes(value.trim()) ? options.slice(0, 6) : []
  // Typing resets the highlight; this only catches completions that arrive from
  // the debounce while one is up, and keeps it inside the list that is drawn.
  const at = Math.min(cursor, shown.length - 1)

  // The list gets the room between the question card and this box, so with a phone
  // keyboard up it neither covers the question nor runs off the top. Measured again
  // on resize: the keyboard slides in after the focus.
  const list = useRef<HTMLUListElement>(null)
  const listed = shown.length > 0
  useLayoutEffect(() => {
    const ul = list.current
    if (!ul) return
    function fit() {
      const card = document.querySelector('.prompt')?.getBoundingClientRect().bottom ?? 0
      const room = (ul!.offsetParent ?? ul!.parentElement!).getBoundingClientRect().top - Math.max(0, card) - 10
      ul!.style.setProperty('--room', `${Math.max(96, room)}px`)
    }
    fit()
    addEventListener('resize', fit)
    return () => removeEventListener('resize', fit)
  }, [listed])

  function pick(option: string) {
    onChange(option)
    setOpen(false)
  }

  function keys(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // The arrows always mean the list: they bring back one that Escape dismissed,
      // and they wrap through what was typed instead of stopping dead at either end.
      const reopen = !open && options.length > 0 && !options.includes(value.trim())
      if (shown.length === 0 && !reopen) {
        // Nothing to browse: on a question with several boxes the arrows step
        // between them instead, which is all up and down mean in a one-line field.
        if (!onLeave) return                       // one box: the caret keeps the key
        event.preventDefault()
        return onLeave(event.key === 'ArrowDown' ? 1 : -1)
      }
      event.preventDefault()
      if (reopen) { setOpen(true); setCursor(-1); return }
      const to = at + (event.key === 'ArrowDown' ? 1 : -1)
      return setCursor(to < -1 ? shown.length - 1 : to > shown.length - 1 ? -1 : to)
    }
    if (shown.length === 0) return
    if (event.key === 'Tab') {
      // Tab walks the list like the arrows do, and only leaves the field once it
      // runs off the end of it -- the hands stay on the keys the guess is typed with.
      const step = event.shiftKey ? -1 : 1
      const to = at + step
      if (to < -1 || to > shown.length - 1) return   // off the list: Tab does its usual job
      setCursor(to)
      event.preventDefault()
    } else if (event.key === 'Enter' && at >= 0) {
      pick(shown[at])
      event.preventDefault()      // taking a suggestion must not also send the guess
    } else if (event.key === 'Escape' && open) {
      setOpen(false)
      event.stopPropagation()
    }
  }

  return (
    <div className="field">
      <input name={field.key} value={value} role="combobox" aria-expanded={shown.length > 0}
             aria-controls={`${field.key}-picks`} aria-autocomplete="list"
             aria-activedescendant={at >= 0 ? `${field.key}-pick-${at}` : undefined}
             onChange={event => { setOpen(true); setCursor(-1); onChange(event.target.value) }}
             onKeyDown={keys}
             // a phone: the question is at the top of the page, keep it on screen
             onFocus={() => { if (matchMedia('(pointer: coarse)').matches) scrollTo(0, 0) }}
             autoFocus={autoFocus} autoComplete="off" autoCapitalize="off" spellCheck={false}
             enterKeyHint={hint ?? 'send'} maxLength={300} aria-label={field.label} placeholder={field.label}
             aria-invalid={invalid || undefined} />
      {shown.length > 0 && (
        <ul className="picks" ref={list} id={`${field.key}-picks`} role="listbox" aria-label={`${field.label} from the catalog`}>
          {shown.map((option, index) => (
            // mousedown is swallowed so the input keeps focus and the click lands
            // on a list that is still open.
            <li key={option} id={`${field.key}-pick-${index}`} role="option" aria-selected={index === at}
                className={index === at ? 'on' : undefined}
                onMouseDown={event => event.preventDefault()}
                onClick={() => pick(option)}>{option}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Dots({ answered }: { answered: number }) {
  return (
    <span className="dots" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => <i key={i} className={i < answered ? 'done' : i === answered ? 'cur' : ''} />)}
    </span>
  )
}

function Ask({ question, attemptId, answered, token, onAnswered, onLost }: {
  question: Question; attemptId: number; answered: number; token?: string
  onAnswered: (answered: Answered, text: string, expired: boolean) => void; onLost: () => void
}) {
  const fields = fieldsFor(question)
  // One box with no catalog kind: a rarest question, or a song or album question
  // asking something the names on the record do not answer. It is scored against
  // the key in one request rather than box by box.
  const free = !fields[0].kind
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [unknown, setUnknown] = useState('')   // what the tower would not take, in its own words
  const [meant, setMeant] = useState('')       // the key's nearest answer to what was typed
  const [leaving, setLeaving] = useState(false)   // the card drifts off and the HUD sinks while the tower answers
  const sent = useRef(false)
  // The fields are asked one at a time: three boxes at once was three questions
  // wearing one coat, and the catalog can only vet the box in front of you.
  const [step, setStep] = useState(0)
  const field = fields[Math.min(step, fields.length - 1)]
  const finale = step >= fields.length - 1
  // Two fields become one answer, "Artist — Title", which normalises to the same
  // key as a moderator's "Artist Title"; a lone field matches the artist-only row.
  const join = (all: Record<string, string>) =>
    fields.map(field => (all[field.key] ?? '').trim()).filter(Boolean).join(' — ')
  const joined = join(values)
  const typed = useRef('')
  useEffect(() => { typed.current = joined })      // the timer submits whatever is typed
  useEffect(() => { sfx('brief') }, [])            // the tower opens the channel

  /** Posts the box in front of the player: a song or album question is answered a
   *  box at a time, each its own request, and the tower keeps them until the last
   *  press settles the question. A rarest question is that one press. Answers true
   *  when the box was parked and the next one is due. */
  async function post(all: Record<string, string>, settle: boolean, expired = false): Promise<boolean> {
    if (sent.current) return false
    if (settle) sent.current = true          // one press settles it; the rest bounce off
    sfx(settle ? 'send' : 'type')
    const value = (all[field.key] ?? '').trim()
    try {
      const reply = free
        ? await submitAnswer(attemptId, question.id, join(all), token, expired)
        : await submitField(attemptId, question.id, field.key, value, settle, token)
      // The card leaves once the answer is in, never before: an answer the tower
      // will not take has to find the question and the box still there. The exit
      // then takes its half second, whether or not the tower was quicker.
      if ('result' in reply) {
        setLeaving(true)
        await new Promise(done => setTimeout(done, 500))
        onAnswered(reply, join(all), expired)
        return false
      }
      setUnknown('')          // the box got through: nothing is refused any more
      return true
    } catch (cause) {
      sent.current = false
      // Not a catalog name, or a free answer the key nearly holds. The clock does
      // not wait for a fix: past it the box goes blank, or goes as it stands.
      if (cause instanceof ApiError && cause.status === 422) {
        if (expired) return post({ ...all, [field.key]: '' }, settle, expired)
        if (cause.meant) setMeant(cause.meant); else setUnknown(cause.message)
        return false
      }
      // A refresh that raced the timer: the server has moved on, so ask it where we are.
      if (cause instanceof Error && cause.message.includes('current question')) { onLost(); return false }
      setError(cause instanceof Error ? cause.message : 'That answer did not reach the tower.')
      return false
    }
  }

  /** The clock: the box being typed goes as it stands and the question settles,
   *  late. The boxes already parked keep whatever they earned. */
  function expire() {
    void post(free ? { [field.key]: typed.current } : values, true, true)
  }

  /** True when this field holds something the music catalog does not know. False on
   *  a rarest question (no kind to check), on an empty field (a deliberate skip), and
   *  whenever the check itself fails -- the server checks again on the way in. */
  const unknownName = `No ${field.label} by that name in the catalog — pick one from the list, or skip.`

  async function unrecognised(value: string): Promise<boolean> {
    if (!field.kind || !value) return false
    try { return !(await isKnown(field.kind, value, { question: question.id, field: field.key })).known } catch { return false }
  }

  /** Move to another box of the same question, parking the one being left. Nothing
   *  is scored: the question settles only on the last press, so a player can walk up
   *  and down the boxes as often as they like. */
  async function go(to: number) {
    if (fields.length < 2 || to === step || to < 0 || to >= fields.length) return
    const all = { ...values, [field.key]: (values[field.key] ?? '').trim() }
    setValues(all)
    if (await unrecognised(all[field.key])) return setUnknown(unknownName)
    if (await post(all, false)) setStep(to)
  }

  /** This field is settled: park it, then on to the next one or off to the verdict. */
  async function advance(all: Record<string, string>) {
    setValues(all)
    if (await post(all, finale) && !finale) setStep(step + 1)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sent.current) return
    const value = (values[field.key] ?? '').trim()
    // Only catalog names go: pick one from the list. The server refuses the rest too.
    if (await unrecognised(value)) return setUnknown(unknownName)
    void advance({ ...values, [field.key]: value })
  }

  return (<>
    <section className={leaving ? 'card prompt gone' : 'card prompt'}>
      <p className="eyebrow">QUESTION {question.position} / 7 <Dots answered={answered} /></p>
      <h2>{question.prompt}</h2>
      {question.qtype === 'song' && <Snippet question={question} />}
      {question.qtype === 'album' && question.cover && <img className="cover" src={question.cover} alt="Album cover" />}
    </section>
    <div className={leaving ? 'hud sunk' : 'hud'}>
      {/* A press on a button would take the focus from the box, and on a phone that
          drops the keyboard only for the next box to raise it again: the buttons
          still click, the focus stays put. */}
      <form onSubmit={submit} onMouseDown={event => { if ((event.target as Element).closest('button')) event.preventDefault() }}>
        <Countdown question={question} onExpire={expire} />
        {/* Every box of the question at once, the one being typed open and the rest
            waiting under it: a single box gave no sign that two more were coming,
            and Enter read as "send the lot". */}
        {fields.length > 1 ? (
          <div className="reel">
            <span className="reel-nav">
              <button type="button" onClick={() => void go(step - 1)}
                      disabled={step === 0} aria-label="Previous field">▲</button>
              <button type="button" onClick={() => void go(step + 1)}
                      disabled={finale} aria-label="Next field">▼</button>
            </span>
            <ul className="slots">
              {fields.map((slot, i) => {
                const said = (values[slot.key] ?? '').trim()
                return (
                  <li key={slot.key} className={i === step ? 'here' : said ? 'filled' : undefined}>
                    <span className="slot-n" aria-hidden="true">{i + 1}</span>
                    <span className="slot-label">{slot.label}</span>
                    {i === step ? (
                      <Input key={slot.key} question={question.id} field={slot} value={values[slot.key] ?? ''} autoFocus
                             invalid={!!unknown} hint={finale ? 'send' : 'next'} help={question.hints}
                             onLeave={direction => void go(step + direction)}
                             onChange={value => { setUnknown(''); setMeant(''); setValues(prev => ({ ...prev, [slot.key]: value })) }} />
                    ) : (
                      <button type="button" className="slot-said" onClick={() => void go(i)}>
                        {said || <i>empty</i>}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
          <div className="fields">
            <Input key={field.key} question={question.id} field={field} value={values[field.key] ?? ''} autoFocus
                   invalid={!!unknown} help={question.hints}
                   onChange={value => { setUnknown(''); setMeant(''); setValues(prev => ({ ...prev, [field.key]: value })) }} />
          </div>
        )}
        <button className="cta" type="submit">{finale ? 'ANSWER ▲' : 'NEXT ▼'}</button>
        <button className="chip" type="button"
                onClick={() => void advance({ ...values, [field.key]: '' })}>skip</button>
      </form>
      {fields.length > 1 && !unknown && (
        <p className="reel-hint">
          box {step + 1} of {fields.length} · ↑↓ or ▲▼ to move
          {finale ? ' · ANSWER sends the question' : ` · ${fields.length - step - 1} more before it is sent`}
        </p>
      )}
      {/* The box was refused, but the key holds something close to what was typed, so
          the tower asks instead of just saying no: take it, or go back to the box and
          fix it. Only the clock can send an answer the key cannot place. */}
      {meant && (
        <p className="notice meant" role="alert">
          Did you mean <b>{meant}</b>?
          <button className="chip" type="button"
                  onClick={() => { setMeant(''); void advance({ ...values, [field.key]: meant }) }}>
            yes, {meant}
          </button>
          <button className="chip" type="button" onClick={() => setMeant('')}>no, let me fix it</button>
        </p>
      )}
      {unknown && <p className="notice" role="alert">{unknown}</p>}
      {error && <p className="notice" role="alert">{error}</p>}
    </div>
  </>)
}

/** The verdict reads out a beat after it lands; behind it the rocket boosts and
 *  the stars stream past, which is what says "you climbed". */
function Verdict({ result, raw, expired, points, max, tiers, qtype, last, leaving, onNext }: {
  result: Result; raw: string; expired: boolean; points: number; max: number; tiers: Today['tiers']
  qtype: Question['qtype']; last: boolean; leaving: boolean; onNext: () => void
}) {
  // The client's timer fired, or the server counted it late: either way, the clock.
  const headline = (result.timed_out || expired) && !result.correct ? 'THE CLOCK BEAT YOU'
    : !raw.trim() ? 'SKIPPED'
    : result.correct ? `✓ ${result.tier}`
    : '✗ NOT ON THE LIST'
  const said = raw.trim()
  // The verdict, heard: the arpeggio climbs as far as the tier goes, so a
  // Supernova is audibly further than a Nebula, and the clock has its own buzz.
  useEffect(() => {
    if (result.correct) sfx('hit', Math.max(0, tiers.findIndex(row => row.name === result.tier)))
    else sfx((result.timed_out || expired) ? 'expire' : 'miss')
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  // A flick of the scanlines as the verdict lands, like a CRT taking a hit.
  useEffect(() => {
    document.body.classList.add('zap')
    const timer = setTimeout(() => document.body.classList.remove('zap'), 300)
    return () => { clearTimeout(timer); document.body.classList.remove('zap') }
  }, [])
  return (
    <section className={leaving ? 'card verdict gone' : 'card verdict'}>
      <div className="after">
        <p className={`eyebrow ${result.correct ? 'hit' : 'miss'}`}>
          {result.correct && <span className="glyph"><TierIcon tier={result.tier} tiers={tiers} /></span>}
          {headline}</p>
        <p className={`points ${result.correct ? 'slam' : 'shake'}`}>
          {result.points > 0 ? `+${result.points}` : '+0'}
          <small>PTS · {points} TOTAL · {altitudeAu(points, max).toFixed(1)} AU</small>
        </p>
        {/* Box by box: a song or album question is several answers, and one number
            for all of them says nothing about which ones landed. */}
        {result.fields && (
          <ul className="boxes">
            {result.fields.map(box => (
              <li key={box.field} className={box.correct ? 'hit' : 'miss'}>
                <span>{box.field}</span>
                <b>{box.text || '—'}</b>
                <em>{box.points > 0 ? `+${box.points}` : '+0'}</em>
                <i>{box.correct ? box.tier ?? 'landed' : 'miss'}</i>
              </li>
            ))}
          </ul>
        )}
        {!result.correct && said && <p className="meta">A moderator may still accept it.</p>}
        {/* The question is over, so the key can be read: every answer that would
            have counted, what tier it sits in and what it was worth. Waiting for
            the whole flight to say so left a player with no idea what they missed. */}
        {result.answers && result.answers.length > 0 && (
          <div className="key">
            <p className="fathom">what counted <span>{result.answers.length} answers</span></p>
            <ul className="sheet">
              {result.answers.filter(option => option.points > 0 || option.yours).map(option => (
                <li key={option.display} className={option.yours ? 'yours' : undefined}>
                  {qtype === 'rarest' && <span className="glyph"><TierIcon tier={option.tier} tiers={tiers} /></span>}
                  <span className="said">
                    {option.display}{option.yours && <i>you</i>}
                    {option.tier && <small>{option.tier}</small>}
                  </span>
                  <b>+{option.points}</b>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button className="cta" type="button" autoFocus onClick={() => { sfx('click'); onNext() }}>{last ? 'SEE RESULTS ▲' : 'NEXT ▲'}</button>
      </div>
    </section>
  )
}

export function Play({ today, max, token, onPoints, onDone }: {
  today: Today; max: number; token?: string; onPoints: (points: number, mood?: Mood) => void; onDone: () => void
}) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [last, setLast] = useState<{ result: Result; raw: string; expired: boolean; points: number
                                     qtype: Question['qtype']; last: boolean } | null>(null)
  const [error, setError] = useState('')
  const [leaving, setLeaving] = useState(false)   // the verdict drifts off while the next question loads

  // No question left means the flight has landed, so go straight to the results.
  // The verdict stays on screen, fading, until the next question is in hand: no
  // blank beat between them, and the exit gets its half second whatever the server does.
  function serve(gently = false) {
    const exit = new Promise(done => setTimeout(done, gently ? 550 : 0))
    Promise.all([startAttempt(token), exit]).then(([served]) => {
      setLeaving(false)
      setLast(null)
      onPoints(served.total_points)
      if (served.question) setProgress(served); else onDone()
    }).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'The flight deck is not answering.'))
  }
  function next() { setLeaving(true); serve(true) }
  useEffect(() => serve(), [])   // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="notice" role="alert">{error}</p>
  if (last) return <Verdict {...last} max={max} tiers={today.tiers} leaving={leaving} onNext={last.last ? onDone : next} />
  if (!progress?.question) return <p className="card meta wait" role="status">Clearing the launch tower…</p>

  return (
    <Ask key={progress.question.id} question={progress.question} attemptId={progress.id}
         answered={progress.answered} token={token} onLost={next}
         onAnswered={(answered, raw, expired) => {
           onPoints(answered.total_points, answered.result.correct ? 'boost' : 'tumble')
           setLast({ result: answered.result, raw, expired, points: answered.total_points,
                     qtype: progress.question!.qtype,
                     last: answered.answered >= today.question_count })
         }} />
  )
}

const BUGS = 'https://github.com/en1y/jamillion/issues/new?labels=bug'

function Curve({ dist, score, max, better }: { dist: number[]; score: number; max: number; better: number }) {
  const geom = curveGeom(dist, score, max)
  if (!geom) return better ? <p className="better">better than {better}% of today's pilots</p> : null
  const youLabel = Math.min(Math.max(geom.youX, 14), 306)
  return (
    <div className="curve">
      <svg viewBox="0 0 320 96" role="img"
           aria-label={`Score distribution of today's pilots; your score beats ${better}% of them`}>
        <defs>
          <linearGradient id="curve-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ion)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--ion)" stopOpacity="0.02" />
          </linearGradient>
          <clipPath id="curve-beaten"><rect x="0" y="0" width={geom.youX} height="96" /></clipPath>
        </defs>
        <path d={geom.fill} fill="url(#curve-fill)" opacity="0.28" />
        <path d={geom.fill} fill="url(#curve-fill)" clipPath="url(#curve-beaten)" />
        <path d={geom.line} fill="none" stroke="var(--ion)" strokeWidth="1.4" strokeOpacity="0.75" />
        <line x1="0" y1={geom.base} x2={geom.width} y2={geom.base} stroke="var(--line)" />
        {[0.25, 0.5, 0.75].map(share => Math.round(share * max)).map(tick => {
          const x = tick / max * geom.width
          const hide = Math.abs(x - geom.youX) < 18
          return (
            <g key={tick}>
              <line x1={x} y1={geom.base} x2={x} y2={geom.base + 3.5} stroke="var(--mute)" strokeOpacity="0.5" />
              {!hide && <text x={x} y="90" textAnchor="middle" fill="var(--mute)" opacity="0.55">{tick}</text>}
            </g>
          )
        })}
        <line x1={geom.youX} y1={Math.min(geom.youY, 74) - 3} x2={geom.youX} y2={geom.base} stroke="var(--pink)" strokeWidth="1.2" />
        <circle cx={geom.youX} cy={geom.youY} r="2.6" fill="var(--pink)" />
        <text x={youLabel} y="90" textAnchor="middle" fill="var(--pink)" letterSpacing="0.12em">YOU</text>
        <text x="0" y="90" fill="var(--mute)" opacity="0.6">0</text>
        <text x={geom.width} y="90" textAnchor="end" fill="var(--mute)" opacity="0.6">{max}</text>
      </svg>
      <p className="better">better than {better}% of today's pilots</p>
    </div>
  )
}

function FlightLog({ answers, tiers }: { answers: OwnAnswer[]; tiers: Today['tiers'] }) {
  return (
    <section className="flog">
      <p className="fathom">flight log <span>further = rarer</span></p>
      <div className="flog-chart">
        {[0, 0.25, 0.5, 0.75, 1].map(step => (
          <div key={step} className="flog-rule" style={{ top: `${step * 100}%`, opacity: step === 0 ? 1 : 0.5 }}>
            <span>{step === 0 ? '0 AU' : Math.round(step * PLUTO_AU)}</span>
          </div>
        ))}
        <div className="flog-cols">
          {answers.map((answer, i) => {
            const meta = answer.correct && answer.tier ? TIER_META[answer.tier] : null
            const depth = logDepth(answer.tier, answer.correct)
            const color = meta?.color ?? 'var(--mute)'
            return (
              <div key={answer.position} className="flog-col">
                {/* the line grows and the mark drops down it, one question after the next */}
                <div className="flog-line" aria-hidden="true"
                     style={{ height: `calc(${depth * 100}% - 8px)`, animationDelay: `${90 * i}ms`,
                              background: `linear-gradient(180deg, transparent, ${color})` }} />
                <div className="flog-dot" style={{ top: `${depth * 100}%`, '--d': depth, animationDelay: `${90 * i}ms` } as CSSProperties}
                     title={`Question ${answer.position}: ${answer.raw_text.trim() || 'miss'}, ${answer.points} pts`}>
                  <span className={meta ? 'flog-chip' : 'flog-miss'}
                        style={meta ? { background: color, boxShadow: `0 0 10px ${color}`, animationDelay: `${90 * i}ms` }
                                    : { animationDelay: `${90 * i}ms` }}>
                    {meta ? <TierIcon tier={answer.tier} tiers={tiers} /> : null}
                  </span>
                </div>
                <span className="flog-n">{answer.position}</span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="flog-pad" />
    </section>
  )
}

function Ideas({ token }: { token?: string }) {
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'throttled' | 'error'>('idle')
  async function submit(event: FormEvent) {
    event.preventDefault()
    const idea = text.trim()
    if (idea.length < 3 || state === 'sending') return
    setState('sending')
    try {
      const next = await sendIdea(idea, token)
      setState(next.reason === 'throttled' ? 'throttled' : next.ok ? 'sent' : 'error')
    } catch { setState('error') }
  }
  if (state === 'sent') return <p className="meta">logged — it might surface in a future flight.</p>
  if (state === 'throttled') return <p className="meta">that's plenty for today — come back tomorrow.</p>
  return (
    <form className="idea" onSubmit={submit}>
      <label htmlFor="idea">got an idea for a question? tell us what to ask</label>
      <div>
        <input id="idea" value={text} maxLength={160} placeholder="name a moon of Saturn…"
               onChange={event => { setText(event.target.value); if (state === 'error') setState('idle') }} />
        <button className="chip" type="submit" disabled={text.trim().length < 3 || state === 'sending'}>
          {state === 'sending' ? 'sending…' : 'submit'}
        </button>
      </div>
      {state === 'error' && <p className="meta">couldn't send — try again in a moment.</p>}
    </form>
  )
}

export function Results({ today, max, token }: { today: Today; max: number; token?: string }) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [sheet, setSheet] = useState<RevealedQuestion[] | null>(null)
  const [dist, setDist] = useState<number[] | null>(null)
  const [better, setBetter] = useState(0)
  const [left, setLeft] = useState(() => countdown(nextRollover()))
  const [log, setLog] = useState(EMPTY_LOG)
  const attempt = today.attempt
  const shown = useCountUp(attempt?.total_points ?? 0, 1200)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  useEffect(() => {
    let live = true
    getReveal(token).then(next => {
      if (!live) return
      setSheet(next.questions)
      setDist(next.dist)
      setBetter(next.better_than)
    }).catch(() => { if (live) setSheet([]) })
    // The logbook is the server's flights now, not a localStorage counter.
    getFlights(token).then(flights => { if (live) setLog(summarize(flights)) }).catch(() => {})
    return () => { live = false }
  }, [token])
  useEffect(() => {
    const tick = () => setLeft(countdown(nextRollover()))
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => { sfx('land') }, [])   // touchdown: the whole ladder, once
  if (!attempt) return null
  const { answers, total_points: points } = attempt
  const au = altitudeAu(points, max)
  const band = bandFor(points, max)
  const text = shareText(today.flight_no, points, answers, today.tiers, max)
  const avg = log.played ? Math.round(log.total / log.played) : 0

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setCopied(false) }
  }

  return (
    <section className="results">
      <header className="results-head">
        <span className="brand-mark">JAMILLION</span>
        <span className="meta">Flight #{today.flight_no} complete</span>
      </header>
      <p className="results-score">
        <b>{shown}<i>pts</i></b>
        <span>{au.toFixed(1)} AU · past {passed(au)}</span>
      </p>
      {dist && <Curve dist={dist} score={points} max={max} better={better} />}

      <FlightLog answers={answers} tiers={today.tiers} />

      <section className="bearing">
        <p className="fathom">the bearing</p>
        <ul>
          {scoreBands(max).map(row => (
            <li key={row.tier} className={band.tier === row.tier ? 'here' : undefined}>
              <span className="bearing-icon"><TierIcon tier={row.tier} tiers={today.tiers} /></span>
              <span className="bearing-range">{row.range}</span>
              <span className="bearing-verdict">{row.verdict}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="copy-row">
        <button className="cta" type="button" onClick={() => { sfx('click'); void copy() }}>{copied ? 'Copied ✓' : 'Copy result'}</button>
        {canShare && <button className="chip" type="button" onClick={() => void navigator.share({ text })}>Share…</button>}
      </div>

      <div className="haul">
        <p className="fathom">the haul <span>tap a question for every answer</span></p>
        <ul>
          {answers.map(answer => {
            const question = sheet?.find(row => row.position === answer.position)
            const expanded = open === answer.position
            return (
              <li key={answer.position}>
                <button type="button" className="round" onClick={() => setOpen(expanded ? null : answer.position)}
                        aria-expanded={expanded}>
                  <span className="n">{answer.position}</span>
                  <span className="glyph"><TierIcon tier={answer.tier} tiers={today.tiers} correct={answer.correct} /></span>
                  <span className="said">
                    <small>{question?.prompt ?? `question ${answer.position}`}</small>
                    {answer.raw_text.trim() ? answer.raw_text.trim() : (answer.tier ?? 'skipped')}
                  </span>
                  <b>{answer.points}</b>
                  <span className="more" aria-hidden="true">{expanded ? '−' : '+'}</span>
                </button>
                {expanded && (
                  <ul className="sheet">
                    {sheet === null && <li className="meta">unsealing the star charts…</li>}
                    {sheet && !question && <li className="meta">no chart for this question</li>}
                    {/* A song or album key is a ladder of how much of the answer you named,
                        not a rarity ladder: the tier glyph and its blurb say nothing there,
                        the points do. Answers worth nothing are left off either way. */}
                    {question?.answers.filter(option => option.points > 0 || option.yours).map(option => (
                      <li key={option.display} className={option.yours ? 'yours' : undefined}>
                        {question.qtype === 'rarest' &&
                          <span className="glyph"><TierIcon tier={option.tier} tiers={today.tiers} /></span>}
                        <span className="said">
                          {option.display}{option.yours && <i>you</i>}
                          {question.qtype === 'rarest' && option.tier && TIER_META[option.tier] &&
                            <small>{TIER_META[option.tier].blurb}</small>}
                        </span>
                        <b>+{option.points}</b>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      {log.played > 0 && (
        <section className="logbook">
          <p className="fathom">logbook</p>
          <p className="meta">streak <b>{log.streak}</b> · played <b>{log.played}</b> · avg <b>{avg}</b> · best <b>{log.best}</b></p>
        </section>
      )}

      <p className="next-flight">next flight in <span>{left}</span>
        {left === 'ready' && <button className="chip" type="button" onClick={() => location.reload()}>refresh</button>}</p>

      <p className="bugs">found a bug?{' '}
        <a href={`${BUGS}&title=${encodeURIComponent(`Bug on flight #${today.flight_no}`)}`}
           target="_blank" rel="noreferrer">open an issue on GitHub</a></p>
      <Ideas token={token} />
    </section>
  )
}
