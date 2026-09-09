// The flight deck: where a moderator writes the day. Everything it talks to is in
// moderator.ts; everything it decides without a DOM is in quizdraft.ts.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'
import {
  deleteQuiz, getFields, getQuiz, getTiers, listQuizzes, mergeAnswer, patchQuestion,
  reviewAnswer, runQuery, saveQuiz, setPublished, trackAudio,
} from './moderator'
import type { ModAnswer, ModQuestion, ModQuiz, QuizDay, Tier } from './moderator'
import {
  NO_VALUE, OP_LABELS, answerText, cell, columnsFor, defaultOp, dirLabel, fieldLabel,
  fieldType, fieldsFor, splitField, spreadTiers, toPick, usable,
} from './catalog'
import type {
  AnswerShape, CatalogField, CatalogSchema, Entity, Filter, Page, Query, Row, Sort,
} from './catalog'
import {
  CLIP_SEC, asksOf, clampSnippet, clearDraft, defaultTimeLimit, draftProblems, emptyDraft,
  fromQuiz, fullAnswerPoints, loadDraft, normalizeAnswer, reseedAnswers, saveDraft, toPayload,
} from './quizdraft'
import type { Draft, DraftPick, DraftQuestion } from './quizdraft'
import type { Qtype } from './api'
import { formatDate, monthGrid, monthLabel, parseDate, shiftDay, shiftMonth, weekday } from './flight'

const QTYPES: Qtype[] = ['rarest', 'song', 'album']

const ASKS = [
  ['ask_artist', 'ask for the artist'],
  ['ask_title', 'ask for the title'],
  ['ask_album', 'ask for the album'],
] as const

/** 0 is no clock. A saved question with some other limit keeps it in the list
 *  rather than being silently rounded to whichever option is nearest. */
const LIMITS = [0, 10, 15, 20, 30, 45, 60]

/** The select value for "accepted, and worth nothing". Not a tier id -- those
 *  start at 1 -- and not '' either, which is the by-rarity default. */
const NO_SCORE = 'zero'

/** What a press on the waveform has hold of. */
type Part = 'start' | 'end' | 'move' | 'draw'

/** Every tier select in the deck offers the same three kinds of answer: scored by
 *  how rare it turns out to be, pinned to a tier, or worth nothing at all. */
function TierOptions({ tiers }: { tiers: Tier[] }) {
  return (<>
    <option value="">by rarity</option>
    {tiers.map(tier => <option key={tier.id} value={tier.id}>{tier.name} · {tier.points} pts</option>)}
    <option value={NO_SCORE}>0 pts · no score</option>
  </>)
}

/** What that select shows for a row, and what a change to it means. */
const tierValue = (row: { tier_id: number | null; points?: number | null }) =>
  row.points === 0 ? NO_SCORE : String(row.tier_id ?? '')

const tierChange = (value: string) =>
  value === NO_SCORE ? { tier_id: null, points: 0 }
    : { tier_id: value ? Number(value) : null, points: undefined }
const today = () => new Date().toISOString().slice(0, 10)

/** A 403 can only mean "signed in, wrong role": an expired token is always 401. */
const wall = (cause: unknown) =>
  cause instanceof ApiError && cause.status === 403
    ? 'The flight deck is for moderators. Ask an admin for the keys.'
    : cause instanceof Error ? cause.message : 'The flight deck is not answering.'

const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

/** The date field's own calendar. A native <input type="date"> picks the browser's
 *  locale for its format and cannot be talked out of it, so the popup is ours and
 *  reads dd.mm.yyyy everywhere. The button is the only tabbable thing until it
 *  opens; inside, focus rides the cursor and the arrows move it. */
function DatePicker({ value, onPick }: { value: string; onPick: (iso: string) => void }) {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(value || today())
  const wrap = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => { setOpen(false); toggle.current?.focus() }, [])

  // Escape anywhere and a press outside both close it. mousedown rather than click,
  // so the toggle's own click does not reopen what this just closed.
  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    const outside = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', key)
    document.addEventListener('mousedown', outside)
    return () => {
      document.removeEventListener('keydown', key)
      document.removeEventListener('mousedown', outside)
    }
  }, [open, close])

  // The cursor is the only day with tabIndex 0, so moving it moves the focus ring.
  useEffect(() => {
    if (open) wrap.current?.querySelector<HTMLButtonElement>('[data-cursor="true"]')?.focus()
  }, [open, cursor])

  // Reopening lands on the day in the field, not on wherever the arrows last were.
  function show() {
    if (!open) setCursor(value || today())
    setOpen(!open)
  }

  function keys(event: React.KeyboardEvent) {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    const month: Record<string, number> = { PageUp: -1, PageDown: 1 }
    if (event.key in step) setCursor(shiftDay(cursor, step[event.key]))
    else if (event.key in month) setCursor(shiftMonth(cursor, month[event.key]))
    else if (event.key === 'Home') setCursor(shiftDay(cursor, -weekday(cursor)))
    else if (event.key === 'End') setCursor(shiftDay(cursor, 6 - weekday(cursor)))
    else return
    event.preventDefault()
  }

  const now = today()
  return (
    <div className="cal-wrap" ref={wrap}>
      <button type="button" ref={toggle} className="chip cal-open" onClick={show}
              aria-expanded={open} aria-label="Open the calendar">
        {/* Drawn rather than an emoji: currentColor keeps it in the deck's palette. */}
        <svg className="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="2" y="3" width="12" height="11" rx="1" />
          <path d="M2 7h12M5.5 1.5v3M10.5 1.5v3" />
        </svg>
      </button>
      {open && (
        <div className="cal" role="dialog" aria-label="Choose a date" onKeyDown={keys}>
          <div className="cal-head">
            <button type="button" className="chip" aria-label="Previous month"
                    onClick={() => setCursor(shiftMonth(cursor, -1))}>◀</button>
            <b aria-live="polite">{monthLabel(cursor)}</b>
            <button type="button" className="chip" aria-label="Next month"
                    onClick={() => setCursor(shiftMonth(cursor, 1))}>▶</button>
          </div>
          <div className="cal-grid">
            {DOW.map(day => <span key={day} className="cal-dow">{day}</span>)}
            {monthGrid(cursor).map((iso, cell) => iso === null
              ? <span key={`blank-${cell}`} />
              : <button key={iso} type="button" data-cursor={iso === cursor}
                        tabIndex={iso === cursor ? 0 : -1}
                        aria-label={formatDate(iso)}
                        aria-current={iso === value ? 'date' : undefined}
                        className={[iso === value ? 'on' : '', iso === now ? 'now' : ''].join(' ').trim()}
                        onClick={() => { onPick(iso); close() }}>
                  {Number(iso.slice(8))}
                </button>)}
          </div>
        </div>
      )}
    </div>
  )
}

// --- the day list ----------------------------------------------------------

function DayList({ token, admin }: { token?: string; admin?: boolean }) {
  const [days, setDays] = useState<QuizDay[] | null>(null)
  const [error, setError] = useState('')
  // Chromium renders <input type="date"> in the browser's own locale and ignores
  // lang, so the day is typed as text in the same dd.mm.yyyy the rest of the deck
  // prints. ponytail: no calendar popup; the list below is the way to browse.
  const [typed, setTyped] = useState(formatDate(today()))
  const [busy, setBusy] = useState('')
  const date = parseDate(typed)

  // Admin only, and irreversible: the cascade takes the questions, the answer key
  // and every flight with it, so the count goes in the confirmation.
  async function remove(day: QuizDay) {
    const said = `Delete ${formatDate(day.quiz_date)}?\n\n` +
      `${day.questions} questions and ${day.attempts_started} flights go with it. This cannot be undone.`
    if (!confirm(said)) return
    setBusy(day.quiz_date)
    try {
      await deleteQuiz(day.quiz_date, token)
      setDays(rest => (rest ?? []).filter(other => other.quiz_date !== day.quiz_date))
      setError('')
    } catch (cause) {
      setError(wall(cause))
    } finally { setBusy('') }
  }

  useEffect(() => {
    let live = true
    listQuizzes(token)
      .then(next => { if (live) setDays(next) })
      .catch((cause: unknown) => { if (live) { setDays([]); setError(wall(cause)) } })
    return () => { live = false }
  }, [token])

  return (
    <section className="editor" aria-labelledby="deck-heading">
      <p className="eyebrow">FLIGHT DECK</p>
      <h2 id="deck-heading">Which day are we writing?</h2>
      {error && <p className="notice" role="alert">{error}</p>}

      <div className="deck-open">
        <label>Open or start a date
          <input value={typed} onChange={e => setTyped(e.target.value)} inputMode="numeric"
                 placeholder="dd.mm.yyyy" maxLength={10} aria-invalid={date ? undefined : true} /></label>
        <DatePicker value={date} onPick={iso => setTyped(formatDate(iso))} />
        {date
          ? <a className="cta" href={`#/editor/${date}`}>OPEN ▶</a>
          : <span className="cta off" role="status">dd.mm.yyyy</span>}
      </div>

      {days === null && <p role="status">Reading the schedule…</p>}
      {days?.length === 0 && !error && <p className="meta">No quizzes in this window yet.</p>}
      {days && days.length > 0 && (
        <ul className="days">
          {days.map(day => (
            <li key={day.quiz_date}>
              <a href={`#/editor/${day.quiz_date}`}>
                <span className="said">
                  {formatDate(day.quiz_date)}
                  <small>{day.questions} questions · {day.attempts_started} flights
                    {day.attempts_started > 0 && ' · frozen'}</small>
                </span>
                <b className={day.published ? 'live' : undefined}>{day.published ? 'PUBLISHED' : 'draft'}</b>
              </a>
              {admin && (
                <button type="button" className="scrub" aria-label={`Delete ${day.quiz_date}`}
                        disabled={busy === day.quiz_date}
                        onClick={() => remove(day)}>
                  {busy === day.quiz_date ? '…' : 'DELETE'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// --- the catalog query builder ---------------------------------------------

/** Every column, named in full: a select shows only the chosen option once it is
 *  closed, and "title" alone does not say whether it is the track's or the
 *  album's. The repeated prefix groups the list well enough on its own. */
function FieldOptions({ fields }: { fields: CatalogField[] }) {
  return <>{fields.map(field =>
    <option key={field.key} value={field.key}>{fieldLabel(field.key)}</option>)}</>
}

const SHAPES: { value: AnswerShape; label: string }[] = [
  { value: 'title', label: 'the title' },
  { value: 'artist-title', label: 'artist — title' },
  { value: 'artist', label: 'the artist' },
]

/** Filters and sorts stacked over the catalog, and what came back. Two jobs, one
 *  component: with `onPick` it is how a song or album question chooses its track,
 *  with `onCollect` it is how a rarest question gets its accepted answers out of
 *  the database -- "every Coldplay song over a million listens" is a query, not
 *  twenty lines of typing. The whole UI is built from /api/catalog/fields, so a
 *  column added to the allowlist appears here without a line changing. */
function CatalogQuery({ schema, entities, ladder = [], token, onPick, onCollect, blocked }: {
  schema: CatalogSchema
  entities: Entity[]
  /** Tier ids, commonest first, for spreading over the results. */
  ladder?: number[]
  token?: string
  onPick?: (row: Row, entity: Entity) => void
  onCollect?: (rows: { display: string; tier_id: number | null }[]) => void
  blocked?: (row: Row) => string | null
}) {
  const [entity, setEntity] = useState<Entity>(entities[0])
  const [filters, setFilters] = useState<Filter[]>([])
  const [sorts, setSorts] = useState<Sort[]>([])
  const [limit, setLimit] = useState(25)
  const [page, setPage] = useState<Page | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ticked, setTicked] = useState<number[]>([])
  const [shape, setShape] = useState<AnswerShape>('title')
  const [spread, setSpread] = useState(true)

  const fields = fieldsFor(schema, entity)
  const asked = usable(filters)
  // The request body and the effect's only dependency at once: the arrays are new
  // objects on every render, the string they make is not.
  const wire = JSON.stringify({ entity, filters: asked, sorts, limit })

  // Debounced like the answer completions in Play: one query per pause in typing.
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      setBusy(true)
      runQuery(JSON.parse(wire) as Query, token)
        .then(next => { if (live) { setPage(next); setError('') } })
        .catch((cause: unknown) => {
          if (!live) return
          setPage(null)
          setError(cause instanceof Error ? cause.message : 'The catalog did not answer')
        })
        .finally(() => { if (live) setBusy(false) })
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [wire, token])

  const patch = (index: number, next: Partial<Filter>) =>
    setFilters(filters.map((filter, i) => i === index ? { ...filter, ...next } : filter))

  /** A new field means a new datatype, so the test and the value start over. */
  const retype = (index: number, key: string) =>
    patch(index, { field: key, op: defaultOp(fieldType(schema, key)), value: '' })

  /** A column heading cycles: unsorted, the useful way round, the other way,
   *  unsorted again. Clicking a second heading stacks under the first. */
  function toggleSort(key: string) {
    const first: Sort['dir'] = fieldType(schema, key) === 'text' ? 'asc' : 'desc'
    const at = sorts.findIndex(sort => sort.field === key)
    if (at < 0) setSorts([...sorts, { field: key, dir: first }])
    else if (sorts[at].dir === first)
      setSorts(sorts.map((sort, i) => i === at ? { ...sort, dir: first === 'asc' ? 'desc' : 'asc' } : sort))
    else setSorts(sorts.filter((_, i) => i !== at))
  }

  const rows = page?.rows ?? []
  const columns = columnsFor(entity, asked, sorts)
  const collect = (picked: Row[]) => {
    // The order on screen is the order the tiers are handed out in, so the sort
    // the moderator chose is what decides which answers are the rare ones.
    const tiers = spread ? spreadTiers(picked.length, ladder) : []
    onCollect?.(picked.map((row, index) => ({
      display: answerText(row, entity, shape),
      tier_id: tiers[index] ?? null,
    })))
  }

  return (
    <div className="query">
      {entities.length > 1 && (
        <div className="switch" aria-label="What to search">
          {entities.map(name => (
            <button key={name} className="chip" type="button" aria-pressed={entity === name}
                    onClick={() => { setEntity(name); setFilters([]); setSorts([]); setTicked([]) }}>
              {schema.entities.find(one => one.name === name)?.label ?? name}
            </button>
          ))}
        </div>
      )}

      <p className="fathom">filters <span>every one has to match</span></p>
      {filters.map((filter, index) => {
        const type = fieldType(schema, filter.field)
        const label = `Filter ${index + 1}`
        return (
          <div className="rule" key={index}>
            <select value={filter.field} aria-label={`${label} field`}
                    onChange={event => retype(index, event.target.value)}>
              <FieldOptions fields={fields} />
            </select>
            <select value={filter.op} aria-label={`${label} test`}
                    onChange={event => patch(index, { op: event.target.value })}>
              {schema.operators[type].map(op => <option key={op} value={op}>{OP_LABELS[op] ?? op}</option>)}
            </select>
            {NO_VALUE.has(filter.op)
              ? <span className="meta">no value needed</span>
              : type === 'boolean'
                ? <select value={filter.value || 'true'} aria-label={`${label} value`}
                          onChange={event => patch(index, { value: event.target.value })}>
                    <option value="true">yes</option>
                    <option value="false">no</option>
                  </select>
                : <input value={filter.value} aria-label={`${label} value`}
                         type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
                         placeholder={filter.op === 'in' ? 'adele, coldplay' : splitField(filter.field)[1]}
                         onChange={event => patch(index, { value: event.target.value })} />}
            <button className="chip" type="button" aria-label={`Remove ${label.toLowerCase()}`}
                    onClick={() => setFilters(filters.filter((_, i) => i !== index))}>×</button>
          </div>
        )
      })}
      <button className="chip" type="button" disabled={fields.length === 0}
              onClick={() => setFilters([...filters,
                { field: fields[0].key, op: defaultOp(fields[0].type), value: '' }])}>
        + filter
      </button>

      <p className="fathom">sort <span>the first one breaks ties for the rest</span></p>
      {sorts.map((sort, index) => (
        <div className="rule" key={index}>
          <select value={sort.field} aria-label={`Sort ${index + 1} field`}
                  onChange={event => setSorts(sorts.map((one, i) =>
                    i === index ? { ...one, field: event.target.value } : one))}>
            <FieldOptions fields={fields} />
          </select>
          <select value={sort.dir} aria-label={`Sort ${index + 1} direction`}
                  onChange={event => setSorts(sorts.map((one, i) =>
                    i === index ? { ...one, dir: event.target.value as Sort['dir'] } : one))}>
            {(['desc', 'asc'] as const).map(dir =>
              <option key={dir} value={dir}>{dirLabel(fieldType(schema, sort.field), dir)}</option>)}
          </select>
          <button className="chip" type="button" aria-label={`Remove sort ${index + 1}`}
                  onClick={() => setSorts(sorts.filter((_, i) => i !== index))}>×</button>
        </div>
      ))}
      <button className="chip" type="button" disabled={fields.length === 0}
              onClick={() => setSorts([...sorts, { field: fields[0].key, dir: 'desc' }])}>
        + sort
      </button>

      <div className="query-head">
        <span className="meta" role="status">
          {busy ? 'asking the catalog…'
            : error ? error
            : page ? `${page.total.toLocaleString('en-US')} match${page.total === 1 ? '' : 'es'}` +
                     (page.total > rows.length ? `, top ${rows.length}` : '')
            : ''}
        </span>
        <label className="cap">show
          <select value={limit} aria-label="How many rows"
                  onChange={event => setLimit(Number(event.target.value))}>
            {[10, 25, 50, 100, 250, 500].map(many => <option key={many} value={many}>{many}</option>)}
          </select>
        </label>
      </div>

      {rows.length > 0 && (
        <div className="rows-scroll">
          <table className="rows">
            <thead>
              <tr>
                <th><span className="sr">pick</span></th>
                {columns.map(key => {
                  const at = sorts.findIndex(sort => sort.field === key)
                  return (
                    <th key={key}>
                      {/* The whole key, not its second half: artist.name and
                          track.title would both read as one ambiguous word. */}
                      <button type="button" onClick={() => toggleSort(key)}
                              aria-label={`Sort by ${fieldLabel(key)}`}>
                        {fieldLabel(key)}
                        {at >= 0 && <b>{sorts[at].dir === 'asc' ? '▲' : '▼'}{sorts.length > 1 ? at + 1 : ''}</b>}
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const reason = blocked?.(row) ?? null
                return (
                  <tr key={row.id}>
                    <td>
                      {onCollect
                        ? <input type="checkbox" checked={ticked.includes(row.id)}
                                 aria-label={`Take ${answerText(row, entity, shape)}`}
                                 onChange={event => setTicked(event.target.checked
                                   ? [...ticked, row.id] : ticked.filter(id => id !== row.id))} />
                        : <button className="chip" type="button" disabled={Boolean(reason)}
                                  onClick={() => onPick?.(row, entity)}>{reason ?? 'pick'}</button>}
                    </td>
                    {columns.map(key => <td key={key}>{cell(key, row[key])}</td>)}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {onCollect && rows.length > 0 && (
        <div className="collect">
          {entity !== 'artists' && (
            <label>each answer is
              <select value={shape} onChange={event => setShape(event.target.value as AnswerShape)}>
                {SHAPES.map(one => <option key={one.value} value={one.value}>{one.label}</option>)}
              </select>
            </label>
          )}
          {/* A select rather than a toggle chip: "spread the tiers" reads as an
              instruction, so the one press that felt like switching it on was in
              fact switching it off, and the answers came out on rarity. What is
              on is now simply written in the control. */}
          {ladder.length > 0 && (
            <label>tiers
              <select value={spread ? 'spread' : 'rarity'} aria-label="How the added answers are tiered"
                      onChange={event => setSpread(event.target.value === 'spread')}>
                <option value="spread">spread down the sort</option>
                <option value="rarity">by rarity</option>
              </select>
            </label>
          )}
          <button className="chip" type="button" disabled={ticked.length === 0}
                  onClick={() => { collect(rows.filter(row => ticked.includes(row.id))); setTicked([]) }}>
            + {ticked.length} ticked
          </button>
          <button className="chip" type="button" onClick={() => collect(rows)}>
            + all {rows.length} shown
          </button>
        </div>
      )}
    </div>
  )
}

// --- the snippet picker ----------------------------------------------------

/** The window over the 30 s clip, drawn as a real waveform. The clip route is
 *  moderator-guarded, so it comes in through fetch with the token rather than an
 *  <audio src>; the bytes are used twice, once decoded and once as a blob URL. */
function SnippetPicker({ trackId, start, len, token, onChange }: {
  trackId: number; start: number; len: number; token?: string
  onChange: (start: number, len: number) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    let live = true
    let url = ''
    fetch(trackAudio(trackId), {
      credentials: 'same-origin', headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async response => {
      if (!response.ok) throw new Error('No clip for that track')
      const bytes = await response.arrayBuffer()
      // The blob first: decodeAudioData detaches the buffer it is handed.
      url = URL.createObjectURL(new Blob([bytes], { type: response.headers.get('Content-Type') ?? 'audio/mpeg' }))
      if (live) setSource(url)
      const context = new AudioContext()
      const decoded = await context.decodeAudioData(bytes)
      void context.close()
      const samples = decoded.getChannelData(0)
      const buckets = 240, width = Math.floor(samples.length / buckets)
      const next = Array.from({ length: buckets }, (_, bucket) => {
        let top = 0
        for (let i = bucket * width; i < (bucket + 1) * width; i++) top = Math.max(top, Math.abs(samples[i]))
        return top
      })
      if (live) setPeaks(next)
    }).catch((cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : 'The clip would not load')
    })
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [trackId, token])

  useEffect(() => {
    const element = canvas.current
    if (!element || !peaks) return
    const ratio = window.devicePixelRatio || 1
    const width = element.clientWidth, height = element.clientHeight
    element.width = width * ratio
    element.height = height * ratio
    const paint = element.getContext('2d')
    if (!paint) return
    paint.scale(ratio, ratio)
    paint.clearRect(0, 0, width, height)
    peaks.forEach((peak, i) => {
      const x = (i / peaks.length) * width
      const second = (i / peaks.length) * CLIP_SEC
      const inside = second >= start && second < start + len
      paint.fillStyle = inside ? '#ffc46b' : '#2c4a72'
      const bar = Math.max(1, peak * height * 0.9)
      paint.fillRect(x, (height - bar) / 2, Math.max(1, width / peaks.length - 1), bar)
    })
    // The handles: an edge you can trim is an edge you can see.
    paint.fillStyle = '#ffe7bd'
    for (const second of [start, start + len]) {
      const x = (second / CLIP_SEC) * width
      paint.fillRect(Math.min(Math.max(x - 1.5, 0), width - 3), 0, 3, height)
    }
  }, [peaks, start, len])

  // Seeking before the metadata lands is silently dropped, the same trap the
  // player's Snippet hit: readyState >= 1 means the duration is known.
  function ready(then: (element: HTMLAudioElement) => void) {
    const element = audio.current
    if (!element) return
    if (element.readyState >= 1) then(element)
    else element.addEventListener('loadedmetadata', () => then(element), { once: true })
  }
  function audition() {
    if (playing) { audio.current?.pause(); return }
    ready(element => {
      element.currentTime = start
      element.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    })
  }
  const move = (nextStart: number, nextLen: number) => {
    const fitted = clampSnippet(nextStart, nextLen)
    onChange(fitted.start, fitted.len)
  }

  // The window is drawn on the clip, so it is edited on the clip: take hold of an
  // edge to trim that end, the middle to slide the whole thing without resizing
  // it, or bare waveform to draw a fresh one. The sliders below stay -- they are
  // the keyboard's way in, and the only way to nudge by exactly a second.
  const drag = useRef<{ part: Part; from: number } | null>(null)
  const secondAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - box.left) / box.width
    return Math.round(Math.min(Math.max(ratio, 0), 1) * CLIP_SEC * 10) / 10
  }

  /** What a press at this second would take hold of. The grab zone is in seconds
   *  rather than pixels, so it does not change with the width of the deck. */
  function partAt(at: number): Part {
    const edge = CLIP_SEC / 40                                  // 0.75 s either side
    if (Math.abs(at - start) <= edge) return 'start'
    if (Math.abs(at - (start + len)) <= edge) return 'end'
    return at > start && at < start + len ? 'move' : 'draw'
  }

  function grab(event: React.PointerEvent<HTMLDivElement>) {
    if (!peaks) return
    // Capture only keeps a drag alive past the edge of the clip; a pointer id the
    // browser will not capture must not take the whole interaction down with it.
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* no capture, still draggable */ }
    const at = secondAt(event)
    const part = partAt(at)
    drag.current = { part, from: part === 'move' ? at - start : at }
    if (part === 'draw') move(at, len)
  }

  function sweep(event: React.PointerEvent<HTMLDivElement>) {
    const at = secondAt(event)
    if (!drag.current) {
      // The cursor is the only thing that says the edges are grabbable, so it is
      // written straight to the node rather than through a render.
      const part = peaks ? partAt(at) : 'draw'
      event.currentTarget.style.cursor =
        part === 'start' || part === 'end' ? 'col-resize' : part === 'move' ? 'grab' : 'crosshair'
      return
    }
    const { part, from } = drag.current
    const end = start + len
    if (part === 'start') {
      const from_ = Math.min(at, end - 1)                       // never past its own end
      move(from_, end - from_)
    } else if (part === 'end') {
      move(start, Math.max(at - start, 1))
    } else if (part === 'move') {
      // Slid to the far end it stops there; clampSnippet would otherwise trim it.
      move(Math.min(at - from, CLIP_SEC - len), len)
    } else if (Math.abs(at - from) >= 0.5) {
      // Under half a second is a press that wobbled, not a selection.
      move(Math.min(from, at), Math.abs(at - from))
    }
  }

  return (
    <div className="snip">
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="snip-wave" onPointerDown={grab} onPointerMove={sweep}
           onPointerUp={() => { drag.current = null }}
           onPointerCancel={() => { drag.current = null }}>
        <canvas ref={canvas} aria-label="Waveform of the 30 second clip" />
        {!peaks && !error && <span className="meta">decoding the clip…</span>}
      </div>
      <p className="meta snip-hint">
        drag either edge to trim, the middle to slide it, or bare waveform to draw a
        new one — the whole clip is 30 s, which is all the preview a track has
      </p>
      <audio ref={audio} src={source || undefined} preload="auto"
             onPause={() => setPlaying(false)}
             onTimeUpdate={e => { if (e.currentTarget.currentTime >= start + len) e.currentTarget.pause() }} />
      <div className="snip-row">
        <button className="play" type="button" onClick={audition} aria-label={playing ? 'Pause' : 'Play the window'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <label>start <b>{start.toFixed(0)}s</b>
          <input type="range" min={0} max={CLIP_SEC - 1} step={1} value={start}
                 onChange={e => move(Number(e.target.value), len)} /></label>
        <label>length <b>{len.toFixed(0)}s</b>
          <input type="range" min={1} max={CLIP_SEC} step={1} value={len}
                 onChange={e => move(start, Number(e.target.value))} /></label>
      </div>
    </div>
  )
}

// --- the review queue ------------------------------------------------------

/** getQuiz already orders answers by guess_count, so this list is the queue. */
function Review({ answers, tiers, token, onDone }: {
  answers: ModAnswer[]; tiers: Tier[]; token?: string; onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(0)

  async function act(run: () => Promise<{ rescored: number }>) {
    setBusy(n => n + 1)
    try {
      const { rescored } = await run()
      setNote(rescored ? `moved ${rescored} flight${rescored === 1 ? '' : 's'}` : 'no flights moved')
      onDone()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : 'That did not go through')
    } finally { setBusy(n => n - 1) }
  }

  return (
    <div className="review">
      <p className="fathom">the guesses <span>{note}</span></p>
      <ul>
        {answers.map(answer => (
          <li key={answer.id} className={answer.is_correct === null ? 'awaiting' : undefined}>
            <span className="said">{answer.display}
              <small>{answer.guess_count} guess{answer.guess_count === 1 ? '' : 'es'} · {
                answer.is_correct === null ? 'awaiting review'
                  : answer.is_correct ? 'accepted' : 'rejected'}</small>
            </span>
            <span className="verdicts">
              {([['✓', true], ['✗', false], ['?', null]] as const).map(([glyph, verdict]) => (
                <button key={glyph} className="chip" type="button" disabled={busy > 0}
                        aria-pressed={answer.is_correct === verdict}
                        onClick={() => void act(() => reviewAnswer(answer.id, { is_correct: verdict }, token))}>
                  {glyph}
                </button>
              ))}
              <select value={tierValue(answer)} disabled={busy > 0}
                      aria-label={`Tier for ${answer.display}`}
                      onChange={e => void act(() => reviewAnswer(answer.id,
                        e.target.value === NO_SCORE ? { tier_id: null, points: 0 }
                          : { tier_id: e.target.value ? Number(e.target.value) : null, points: null },
                        token))}>
                <TierOptions tiers={tiers} />
              </select>
              <select value="" disabled={busy > 0} aria-label={`Merge ${answer.display} into`}
                      onChange={e => { if (e.target.value) void act(() => mergeAnswer(answer.id, Number(e.target.value), token)) }}>
                <option value="">merge into…</option>
                {answers.filter(other => other.id !== answer.id)
                        .map(other => <option key={other.id} value={other.id}>{other.display}</option>)}
              </select>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- one question ----------------------------------------------------------

function QuestionCard({ slot, question, tiers, schema, token, frozen, saved,
                       onChange, onPrompt, onReviewed }: {
  slot: number; question: DraftQuestion; tiers: Tier[]; schema: CatalogSchema | null
  token?: string; frozen: boolean
  saved: ModQuestion | undefined
  onChange: (next: DraftQuestion) => void
  onPrompt: (id: number, prompt: string) => Promise<void>
  onReviewed: () => void
}) {
  const [promptNote, setPromptNote] = useState('')
  const set = (patch: Partial<DraftQuestion>) => onChange({ ...question, ...patch })
  const pick = question.qtype === 'song' ? question.track : question.qtype === 'album' ? question.album : null
  const entity: Entity = question.qtype === 'album' ? 'albums' : 'tracks'
  const limits = LIMITS.includes(question.time_limit_sec)
    ? LIMITS : [...LIMITS, question.time_limit_sec].sort((a, b) => a - b)
  const asked = Object.values(asksOf(question)).filter(Boolean).length
  const total = fullAnswerPoints(question, tiers)
  const loose = question.answers.filter(answer => !answer.seeded).length

  /** Answers out of the catalog land beside whatever was typed by hand, and a
   *  name already in the table is not added twice -- normalised the way the
   *  UNIQUE (question_id, normalized) index will read it. */
  function collect(added: { display: string; tier_id: number | null }[]) {
    const rows = question.answers.filter(answer => answer.display.trim())
    const seen = new Set(rows.map(answer => normalizeAnswer(answer.display)))
    for (const row of added) {
      const key = normalizeAnswer(row.display)
      if (!key || seen.has(key)) continue
      seen.add(key)
      rows.push({ display: row.display, tier_id: row.tier_id })
    }
    set({ answers: rows })
  }

  /** Anything that decides what a song or album question's answers should be goes
   *  through here, so the key is written for the moderator rather than by them.
   *  Rows typed by hand survive; see reseedAnswers. */
  const setAsked = (patch: Partial<DraftQuestion>) => {
    const next = { ...question, ...patch }
    onChange({ ...next, answers: reseedAnswers(next, tiers[1]?.id ?? null) })
  }

  const choose = (next: DraftPick) =>
    setAsked({ [question.qtype === 'song' ? 'track' : 'album']: next } as Partial<DraftQuestion>)

  return (
    <details className="qcard" open={slot === 0}>
      <summary>
        <span className="n">{slot + 1}</span>
        <span className="said">{question.prompt || <i>empty</i>}
          <small>{question.qtype}{pick ? ` · ${pick.artist} — ${pick.title}` : ''} · {
            question.answers.filter(a => a.display.trim()).length} answers</small>
        </span>
        <span className="more" aria-hidden="true" />
      </summary>

      <div className="qbody">
        <div className="switch" aria-label="Question type">
          {QTYPES.map(type => (
            <button key={type} className="chip" type="button" aria-pressed={question.qtype === type}
                    disabled={frozen}
                    onClick={() => setAsked({ qtype: type, time_limit_sec: defaultTimeLimit(type) })}>
              {type}
            </button>
          ))}
        </div>

        <label>Prompt
          <input value={question.prompt} maxLength={500}
                 onChange={e => set({ prompt: e.target.value })} /></label>

        {/* A played day freezes everything but the prompt, so the clock with it. */}
        <label className="limit">Time limit
          <select value={question.time_limit_sec} disabled={frozen} aria-label="Time limit"
                  onChange={e => set({ time_limit_sec: Number(e.target.value) })}>
            {limits.map(seconds => (
              <option key={seconds} value={seconds}>
                {seconds === 0 ? 'no clock — answer in your own time' : `${seconds} seconds`}
              </option>
            ))}
          </select>
        </label>
        {frozen && saved && (
          <p className="meta">
            <button className="chip" type="button"
                    onClick={() => { void onPrompt(saved.id, question.prompt).then(
                      () => setPromptNote('prompt saved'),
                      (cause: unknown) => setPromptNote(cause instanceof Error ? cause.message : 'not saved')) }}>
              save this prompt
            </button> {promptNote || 'the only edit a flown day allows'}
          </p>
        )}

        {question.qtype !== 'rarest' && !frozen && <>
          {pick
            ? <p className="chosen">
                {pick.cover && <img src={pick.cover} alt="" />}
                <span className="said">{pick.artist} — {pick.title}</span>
                <button className="chip" type="button"
                        onClick={() => setAsked({ track: null, album: null })}>change</button>
              </p>
            : schema
              ? <CatalogQuery key={question.qtype} schema={schema} entities={[entity]} token={token}
                              onPick={row => choose(toPick(row, entity))}
                              blocked={question.qtype === 'song'
                                ? row => row['track.has_preview'] ? null : 'no clip'
                                : undefined} />
              : <p className="meta" role="status">reading the catalog…</p>}

          {/* ask_album is a song question's third field -- which record is this
              from. On an album question the album title is what ask_title already
              means, so it is not offered. */}
          <div className="asks">
            {ASKS.filter(([flag]) => flag !== 'ask_album' || question.qtype === 'song')
              .map(([flag, label]) => (
                <button key={flag} className="chip" type="button" aria-pressed={question[flag]}
                        onClick={() => setAsked({ [flag]: !question[flag] } as Partial<DraftQuestion>)}>
                  {label}
                </button>
              ))}
          </div>

          {question.qtype === 'song' && question.track && (
            <SnippetPicker key={question.track.id} trackId={question.track.id} start={question.snippet_start_sec}
                           len={question.snippet_len_sec} token={token}
                           onChange={(start, len) => set({ snippet_start_sec: start, snippet_len_sec: len })} />
          )}
        </>}

        {/* On a flown day the review queue below lists the same answers with
            controls that actually work, so this editor would only be a dead copy. */}
        {!frozen && <div className="answers">
          <p className="fathom">accepted answers <span>{question.qtype === 'rarest'
            ? 'a tier here beats the rarity'
            : 'a player scores every field they get right, added up'}</span></p>
          {/* "Every Coldplay song over a million listens" is a query, not twenty
              lines of typing. Only on a rarest question: a song or album question
              writes its own key from the pick and the fields it asks for. */}
          {schema && question.qtype === 'rarest' && (
            <details className="qquery">
              <summary>ask the catalog</summary>
              <CatalogQuery schema={schema} entities={['tracks', 'albums', 'artists']}
                            ladder={tiers.map(tier => tier.id)} token={token} onCollect={collect} />
            </details>
          )}
          {question.answers.map((answer, index) => (
            <div className="answer-row" key={index}>
              <input value={answer.display} maxLength={100} aria-label={`Answer ${index + 1}`}
                     onChange={e => set({ answers: question.answers.map((row, i) =>
                       i === index ? { ...row, display: e.target.value } : row) })} />
              <select value={tierValue(answer)} aria-label={`Tier for answer ${index + 1}`}
                      onChange={e => set({ answers: question.answers.map((row, i) =>
                        i === index ? { ...row, ...tierChange(e.target.value) } : row) })}>
                <TierOptions tiers={tiers} />
              </select>
              <button className="chip" type="button" aria-label={`Remove answer ${index + 1}`}
                      onClick={() => set({ answers: question.answers.filter((_, i) => i !== index) })}>×</button>
            </div>
          ))}
          {/* One row instead of a combination per line: the moderator says what
              getting everything right is worth, and expandAnswers writes the rows
              that carry it. Only when there is more than one field -- with one,
              that field's own row is already the whole answer. */}
          {asked > 1 && (
            <div className="answer-row full">
              <span className="said">all {asked === 2 ? 'two' : 'three'} right</span>
              <select value={question.full_tier_id ?? ''} aria-label="Bonus for a fully correct answer"
                      onChange={e => set({ full_tier_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">no bonus</option>
                {tiers.map(tier =>
                  <option key={tier.id} value={tier.id}>+{tier.points} pts · {tier.name}</option>)}
              </select>
              {/* the whole point of the row: what a perfect answer is worth */}
              <b>{total === undefined ? '—' : `${total} pts`}</b>
            </div>
          )}
          <button className="chip" type="button"
                  onClick={() => set({ answers: [...question.answers, { display: '', tier_id: null }] })}>
            + answer
          </button>
          {/* Twenty-five rows out of one query is one press; taking them back out
              should be too. The seeded field rows are not "added", so they stay. */}
          {loose > 0 && (
            <button className="chip scrub" type="button"
                    onClick={() => set({ answers: question.answers.filter(answer => answer.seeded) })}>
              remove all {loose}
            </button>
          )}
        </div>}

        {saved && saved.answers.length > 0 && (
          <Review answers={saved.answers} tiers={tiers} token={token} onDone={onReviewed} />
        )}
      </div>
    </details>
  )
}

// --- one day ---------------------------------------------------------------

function Day({ date, token }: { date: string; token?: string }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [quiz, setQuiz] = useState<ModQuiz | null>(null)
  const [tiers, setTiers] = useState<Tier[]>([])
  const [schema, setSchema] = useState<CatalogSchema | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => { getTiers(token).then(setTiers).catch(() => setTiers([])) }, [token])

  // The catalog's columns and operators. Static, so it is read once for the whole
  // day rather than by each of the seven cards.
  useEffect(() => { getFields(token).then(setSchema).catch(() => setSchema(null)) }, [token])

  useEffect(() => {
    let live = true
    getQuiz(date, token)
      .then(next => { if (live) { setQuiz(next); setDraft(loadDraft(date) ?? fromQuiz(next)); setError('') } })
      .catch((cause: unknown) => {
        if (!live) return
        if (cause instanceof ApiError && cause.status === 404) {
          setQuiz(null)
          setDraft(loadDraft(date) ?? emptyDraft(date))    // a day nobody has written yet
          setError('')
        } else { setError(wall(cause)) }
      })
    return () => { live = false }
  }, [date, token, reload])

  // Every keystroke is a draft: the server takes seven questions or nothing.
  const change = useCallback((next: Draft) => { setDraft(next); saveDraft(date, next) }, [date])

  if (error) return <section className="editor"><p className="notice" role="alert">{error}</p>
    <p><a className="chip" href="#/editor">◀ all days</a></p></section>
  if (!draft) return <section className="editor"><p role="status">Opening {formatDate(date)}…</p></section>

  const frozen = (quiz?.attempts_started ?? 0) > 0
  const problems = draftProblems(draft, tiers)

  async function save() {
    if (!draft || busy) return
    setBusy(true); setNote('Saving. A song whose clip has never been fetched adds a few seconds.')
    try {
      await saveQuiz(toPayload(draft, tiers), token)
      clearDraft(date)
      setNote('Saved.')
      setReload(n => n + 1)
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : 0
      const said = cause instanceof Error ? cause.message : 'The save did not land'
      setNote(status === 409 ? 'Someone flew this day while you were writing. Reload before editing.'
        : status === 422 ? `${said} — pick another track for that question.`
        : said)
    } finally { setBusy(false) }
  }

  async function publish(next: boolean) {
    setBusy(true)
    try {
      await setPublished(date, next, token)
      setNote(next ? 'Published.' : 'Unpublished.')
      setReload(n => n + 1)
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : 'The switch did not flip')
    } finally { setBusy(false) }
  }

  return (
    <section className="editor" aria-labelledby="day-heading">
      <p className="eyebrow"><a className="chip" href="#/editor">◀ all days</a></p>
      <h2 id="day-heading">{formatDate(date)}</h2>
      <p className="meta">{quiz
        ? `${quiz.published ? 'published' : 'draft'} · ${quiz.attempts_started} flights started`
        : 'nothing written for this day yet'}</p>
      {frozen && <p className="notice">People have flown this day, so the questions are frozen —
        points were fixed at answer time. The prompt can still be corrected, and the guesses below
        are yours to review.</p>}

      {draft.questions.map((question, slot) => (
        <QuestionCard key={slot} slot={slot} question={question} tiers={tiers} schema={schema}
                      token={token} frozen={frozen}
                      saved={quiz?.questions.find(q => q.position === slot + 1)}
                      onChange={next => change({ ...draft,
                        questions: draft.questions.map((q, i) => i === slot ? next : q) })}
                      onPrompt={async (id, prompt) => { await patchQuestion(id, { prompt }, token) }}
                      onReviewed={() => setReload(n => n + 1)} />
      ))}

      {problems.length > 0 && !frozen && (
        <ul className="problems" aria-label="Still to fix">
          {problems.map(problem => <li key={problem}>{problem}</li>)}
        </ul>
      )}

      <div className="deck-actions">
        <button className="cta" type="button" disabled={busy || frozen || problems.length > 0}
                onClick={() => void save()}>
          {busy ? 'WORKING…' : frozen ? 'FROZEN' : '▲ SAVE THE DAY ▲'}
        </button>
        {quiz && (
          <button className="chip" type="button" disabled={busy}
                  onClick={() => void publish(!quiz.published)}>
            {quiz.published ? 'unpublish' : 'publish'}
          </button>
        )}
      </div>
      {note && <p className="notice" role="status">{note}</p>}
    </section>
  )
}

export function Editor({ date, token, admin }: { date: string; token?: string; admin?: boolean }) {
  return date ? <Day date={date} token={token} /> : <DayList token={token} admin={admin} />
}
