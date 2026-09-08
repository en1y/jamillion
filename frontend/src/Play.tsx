import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { getReveal, startAttempt, submitAnswer, suggest } from './api'
import type { Answered, Progress, Question, Result, RevealedQuestion, SuggestKind, Today } from './api'
import { altitudeAu, emojiFor, emojiForTier, formatDate, LANDMARKS, passed, shareText, trackPx } from './flight'

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

/** Drifting stars plus a comet whose tail always points opposite its velocity. */
function Starfield() {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const node = canvas.current
    if (!node) return
    const ctx = node.getContext('2d')
    if (!ctx) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 0, height = 0, far: Star[] = [], mid: Star[] = [], near: Star[] = []
    let comet: Comet | null = null, wait = rand(400, 1800), last = performance.now(), raf = 0

    function resize() {
      const dpr = Math.min(devicePixelRatio || 1, 2)
      width = node!.clientWidth
      height = node!.clientHeight
      node!.width = Math.max(1, Math.round(width * dpr))
      node!.height = Math.max(1, Math.round(height * dpr))
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      far = sprinkle(90, width, height, 0.18)
      mid = sprinkle(45, width, height, 0.38)
      near = sprinkle(18, width, height, 0.7)
      comet = null
      wait = rand(200, 1200)
      if (reduce) {
        ctx!.clearRect(0, 0, width, height)
        paint(far, 0); paint(mid, 0); paint(near, 0)
      }
    }

    function wrap(star: Star, dt: number) {
      star.x += star.vx * dt
      star.y += star.vy * dt
      if (star.x < 0) star.x += width; else if (star.x > width) star.x -= width
      if (star.y > height) star.y -= height; else if (star.y < 0) star.y += height
    }

    function paint(stars: Star[], now: number) {
      for (const star of stars) {
        const twinkle = 0.65 + 0.35 * Math.sin(now / 700 + star.tw)
        ctx!.fillStyle = `rgba(232,241,255,${star.a * twinkle})`
        ctx!.beginPath()
        ctx!.arc(star.x, star.y, star.r, 0, Math.PI * 2)
        ctx!.fill()
      }
    }

    function frame(now: number) {
      const dt = Math.min(3, (now - last) / 16.67)
      last = now
      ctx!.clearRect(0, 0, width, height)
      for (const star of far) wrap(star, dt)
      for (const star of mid) wrap(star, dt)
      for (const star of near) wrap(star, dt)
      paint(far, now)
      paint(mid, now)
      paint(near, now)

      if (!comet) {
        wait -= dt * 16.67
        if (wait <= 0) comet = throwComet(width, height)
      } else {
        comet.x += comet.vx * dt
        comet.y += comet.vy * dt
        const mag = Math.hypot(comet.vx, comet.vy) || 1
        const tx = comet.x - (comet.vx / mag) * comet.len
        const ty = comet.y - (comet.vy / mag) * comet.len
        const tail = ctx!.createLinearGradient(tx, ty, comet.x, comet.y)
        tail.addColorStop(0, '#fff0')
        tail.addColorStop(0.7, '#fff6')
        tail.addColorStop(1, '#ffff')
        ctx!.strokeStyle = tail
        ctx!.lineWidth = 2
        ctx!.beginPath()
        ctx!.moveTo(tx, ty)
        ctx!.lineTo(comet.x, comet.y)
        ctx!.stroke()
        ctx!.fillStyle = '#fff'
        ctx!.beginPath()
        ctx!.arc(comet.x, comet.y, 1.8, 0, Math.PI * 2)
        ctx!.fill()
        if (comet.x < -200 || comet.x > width + 200 || comet.y < -200 || comet.y > height + 200) {
          comet = null
          wait = rand(5000, 14000)
        }
      }
      raf = requestAnimationFrame(frame)
    }

    resize()
    if (reduce) {
      paint(far, 0); paint(mid, 0); paint(near, 0)
    } else {
      raf = requestAnimationFrame(frame)
    }
    const watch = new ResizeObserver(resize)
    watch.observe(node)
    return () => { cancelAnimationFrame(raf); watch.disconnect() }
  }, [])
  return <canvas className="starfield" ref={canvas} />
}

/** The solar system, always behind the page. The track slides down as you climb,
 *  so the rocket stays put and the landmarks drift past: the camera follows you. */
export function Scene({ au }: { au: number }) {
  return (
    <div className="scene" aria-hidden="true" style={{ '--y': `${trackPx(au)}px` } as CSSProperties}>
      <Starfield />
      <div className="track">
        <span className="sun" />
        {LANDMARKS.map((mark, i) => (
          <span key={mark.name}
                className={`landmark ${i % 2 ? 'left' : 'right'}${mark.size ? '' : ' tick'}`}
                style={{ '--px': `${trackPx(mark.au)}px`, '--size': `${mark.size ?? 0}px`,
                         '--color': mark.color ?? 'transparent' } as CSSProperties}>
            <i />{mark.name}
          </span>
        ))}
      </div>
      <span className="rocket">▲</span>
    </div>
  )
}

function Snippet({ question }: { question: Question }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const start = question.snippet_start_sec ?? 0
  const end = start + (question.snippet_len_sec ?? 30)
  const [at, setAt] = useState(start)

  // Seeking before the metadata lands is silently dropped, so the clip would start
  // at 0 and give away the intro. readyState >= 1 means the duration is known.
  function ready(then: (element: HTMLAudioElement) => void) {
    const element = audio.current
    if (!element) return
    if (element.readyState >= 1) then(element)
    else element.addEventListener('loadedmetadata', () => then(element), { once: true })
  }
  function play(from?: number) {
    ready(element => {
      if (from !== undefined) element.currentTime = from
      // Browsers may refuse a play() the player did not ask for; the button covers it.
      element.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    })
  }
  function toggle() {
    if (playing) audio.current?.pause()
    else play(at >= end - 0.25 ? start : undefined)   // at the end, start over
  }
  function scrub(to: number) {
    setAt(to)
    ready(element => { element.currentTime = to })
  }
  // One attempt at autoplay when the question arrives.
  useEffect(() => { play(start); return () => audio.current?.pause() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const shown = Math.min(Math.max(at, start), end)
  return (
    <div className="snippet">
      <audio ref={audio} src={question.audio} preload="auto"
             onPause={() => setPlaying(false)}
             onTimeUpdate={event => {
               const element = event.currentTarget
               setAt(element.currentTime)
               if (element.currentTime >= end) element.pause()   // the window, not the whole preview
             }} />
      <button className="play" type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <input type="range" min={start} max={end} step={0.1} value={shown}
             onChange={event => scrub(Number(event.target.value))} aria-label="Position in the snippet" />
      <span className="clock">{(shown - start).toFixed(0)}s / {(end - start).toFixed(0)}s</span>
    </div>
  )
}

/** The server owns the clock; this only reads its deadline. Its 3 s grace absorbs
 *  the round trip and any clock skew. */
function remaining(question: Question) {
  const left = Date.parse(question.deadline) - Date.now()
  return Math.max(0, Math.min(left, question.time_limit_sec * 1000))
}

function Countdown({ question, onExpire }: { question: Question; onExpire: () => void }) {
  const [left, setLeft] = useState(() => remaining(question))
  const expire = useRef(onExpire)
  useEffect(() => { expire.current = onExpire })

  useEffect(() => {
    const timer = setInterval(() => {
      const next = remaining(question)
      setLeft(next)
      if (next === 0) { clearInterval(timer); expire.current() }
    }, 250)
    return () => clearInterval(timer)
  }, [question])

  const seconds = Math.ceil(left / 1000)
  const style = { '--p': left / (question.time_limit_sec * 1000) } as CSSProperties
  return <span className={seconds <= 5 ? 'ring late' : 'ring'} role="timer" style={style}><span>{seconds}</span></span>
}

interface Field { key: string; kind: SuggestKind | null; label: string }

/** Rarest: one free field. Song and album: the fields the moderator asked for. */
function fieldsFor(question: Question): Field[] {
  if (question.qtype === 'rarest') return [{ key: 'text', kind: null, label: 'your answer' }]
  const fields: Field[] = []
  if (question.ask_artist !== false) fields.push({ key: 'artist', kind: 'artist', label: 'artist' })
  if (question.ask_title !== false) fields.push(question.qtype === 'song'
    ? { key: 'title', kind: 'title', label: 'song title' }
    : { key: 'title', kind: 'album', label: 'album title' })
  return fields
}

/** Catalog completions, debounced; the browser's own datalist draws them. */
function useSuggest(kind: SuggestKind | null, value: string) {
  const [options, setOptions] = useState<string[]>([])
  const q = value.trim()
  useEffect(() => {
    if (!kind || q.length < 2) return
    let live = true
    const timer = setTimeout(() => {
      suggest(kind, q).then(next => { if (live) setOptions(next) }).catch(() => { if (live) setOptions([]) })
    }, 150)
    return () => { live = false; clearTimeout(timer) }
  }, [kind, q])
  // Options from an earlier query linger until the next reply; the datalist only
  // shows the ones that match what is typed, so nothing stale is offered.
  return kind && q.length >= 2 ? options : []
}

function Input({ field, value, onChange, autoFocus }: {
  field: Field; value: string; onChange: (value: string) => void; autoFocus: boolean
}) {
  const options = useSuggest(field.kind, value)
  const list = field.kind ? `${field.key}-options` : undefined
  return (<>
    <input name={field.key} list={list} value={value} onChange={event => onChange(event.target.value)}
           autoFocus={autoFocus} autoComplete="off" autoCapitalize="off" spellCheck={false}
           enterKeyHint="send" maxLength={100} aria-label={field.label} placeholder={field.label} />
    {list && <datalist id={list}>{options.map(option => <option key={option} value={option} />)}</datalist>}
  </>)
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
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const sent = useRef(false)
  // Two fields become one answer, "Artist — Title", which normalises to the same
  // key as a moderator's "Artist Title"; a lone field matches the artist-only row.
  const joined = fields.map(field => (values[field.key] ?? '').trim()).filter(Boolean).join(' — ')
  const typed = useRef('')
  useEffect(() => { typed.current = joined })      // the timer submits whatever is typed

  async function send(value: string, expired = false) {
    if (sent.current) return
    sent.current = true
    try {
      onAnswered(await submitAnswer(attemptId, question.id, value, token), value, expired)
    } catch (cause) {
      sent.current = false
      // A refresh that raced the timer: the server has moved on, so ask it where we are.
      if (cause instanceof Error && cause.message.includes('current question')) return onLost()
      setError(cause instanceof Error ? cause.message : 'That answer did not reach the tower.')
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void send(joined)
  }

  return (<>
    <section className="card prompt">
      <p className="eyebrow">QUESTION {question.position} / 7 <Dots answered={answered} /></p>
      <h2>{question.prompt}</h2>
      {question.qtype === 'song' && <Snippet question={question} />}
      {question.qtype === 'album' && question.cover && <img className="cover" src={question.cover} alt="Album cover" />}
    </section>
    <div className="hud">
      <form onSubmit={submit}>
        <Countdown question={question} onExpire={() => void send(typed.current, true)} />
        <div className="fields">
          {fields.map((field, i) => (
            <Input key={field.key} field={field} value={values[field.key] ?? ''} autoFocus={i === 0}
                   onChange={value => setValues(prev => ({ ...prev, [field.key]: value }))} />
          ))}
        </div>
        <button className="cta" type="submit">ANSWER ▲</button>
        <button className="chip" type="button" onClick={() => void send('')}>skip</button>
      </form>
      {error && <p className="notice" role="alert">{error}</p>}
    </div>
  </>)
}

function Verdict({ result, raw, expired, points, last, onNext }: {
  result: Result; raw: string; expired: boolean; points: number; last: boolean; onNext: () => void
}) {
  // The client's timer fired, or the server counted it late: either way, the clock.
  const headline = result.timed_out || (expired && !result.correct) ? 'THE CLOCK BEAT YOU'
    : !raw.trim() ? 'SKIPPED'
    : result.correct ? `✓ ${result.tier}`
    : '✗ NOT ON THE LIST'
  return (
    <section className="card verdict">
      <p className={`eyebrow ${result.correct ? 'hit' : 'miss'}`}>{headline}</p>
      <p className={`points ${result.correct ? 'slam' : 'shake'}`}>
        {result.points > 0 ? `+${result.points}` : '+0'}
        <small>PTS · {points} TOTAL · {altitudeAu(points).toFixed(1)} AU</small>
      </p>
      {!result.correct && raw.trim() && <p className="meta">You said “{raw.trim()}”. A moderator may still accept it.</p>}
      <button className="cta" type="button" autoFocus onClick={onNext}>{last ? 'SEE RESULTS ▲' : 'NEXT ▲'}</button>
    </section>
  )
}

export function Play({ today, token, onPoints, onDone }: {
  today: Today; token?: string; onPoints: (points: number) => void; onDone: () => void
}) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [last, setLast] = useState<{ result: Result; raw: string; expired: boolean; points: number; last: boolean } | null>(null)
  const [error, setError] = useState('')

  // No question left means the flight has landed, so go straight to the results.
  function serve() {
    startAttempt(token).then(served => {
      onPoints(served.total_points)
      if (served.question) setProgress(served); else onDone()
    }).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'The flight deck is not answering.'))
  }
  function next() { setLast(null); serve() }
  useEffect(serve, [])   // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="notice" role="alert">{error}</p>
  if (last) return <Verdict {...last} onNext={last.last ? onDone : next} />
  if (!progress?.question) return <p className="card meta wait" role="status">Clearing the launch tower…</p>

  return (
    <Ask key={progress.question.id} question={progress.question} attemptId={progress.id}
         answered={progress.answered} token={token} onLost={next}
         onAnswered={(answered, raw, expired) => {
           onPoints(answered.total_points)
           setLast({ result: answered.result, raw, expired, points: answered.total_points,
                     last: answered.answered >= today.question_count })
         }} />
  )
}

export function Results({ today, token }: { today: Today; token?: string }) {
  const [shared, setShared] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const [sheet, setSheet] = useState<RevealedQuestion[] | null>(null)
  const attempt = today.attempt
  useEffect(() => {
    let live = true
    getReveal(token).then(next => { if (live) setSheet(next.questions) }).catch(() => { if (live) setSheet([]) })
    return () => { live = false }
  }, [token])
  if (!attempt) return null
  const { answers, total_points: points } = attempt
  const au = altitudeAu(points)

  async function share() {
    const text = shareText(today.quiz_date, points, answers, today.tiers, location.origin)
    try {
      if (navigator.share) await navigator.share({ text })
      else { await navigator.clipboard.writeText(text); setShared('Copied to your clipboard.') }
    } catch { setShared(text) }   // refused or unsupported: show it, they can select it
  }

  return (
    <section className="card results">
      <p className="eyebrow">FLIGHT {formatDate(today.quiz_date)} · COMPLETE</p>
      <h1 className="glitch wave" aria-label={`${au.toFixed(1)} AU`}>
        {`${au.toFixed(1)} AU`.split('').map((letter, i) =>
          <span key={`${letter}-${i}`} style={{ animationDelay: `${0.18 * i}s` }}>{letter === ' ' ? '\u00a0' : letter}</span>)}
      </h1>
      <p className="tagline">{points} POINTS · PAST {passed(au).toUpperCase()}</p>
      <p className="meta">{today.players_finished} {today.players_finished === 1 ? 'pilot has' : 'pilots have'} landed today</p>
      <button className="cta" type="button" onClick={() => void share()}>SHARE FLIGHT</button>
      {shared && <p className="notice" role="status">{shared}</p>}

      <div className="haul">
        <p className="eyebrow">THE HAUL <span>tap a question for every answer</span></p>
        <ul>
          {answers.map(answer => {
            const question = sheet?.find(row => row.position === answer.position)
            const expanded = open === answer.position
            return (
              <li key={answer.position}>
                <button type="button" className="round" onClick={() => setOpen(expanded ? null : answer.position)}
                        aria-expanded={expanded}>
                  <span className="n">{answer.position}</span>
                  <span className="said">
                    <small>{question?.prompt ?? `question ${answer.position}`}</small>
                    {emojiFor(answer, today.tiers)} {answer.raw_text.trim() || (answer.tier ?? 'skipped')}
                  </span>
                  <b>{answer.points}</b>
                  <span className="more" aria-hidden="true">{expanded ? '−' : '+'}</span>
                </button>
                {expanded && (
                  <ul className="sheet">
                    {sheet === null && <li className="meta">unsealing the star charts…</li>}
                    {sheet && !question && <li className="meta">no chart for this question</li>}
                    {question?.answers.map(option => (
                      <li key={option.display} className={option.yours ? 'yours' : undefined}>
                        <span>{emojiForTier(option.tier, today.tiers)} {option.display}
                          {option.yours && <i>you</i>}</span>
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
    </section>
  )
}
