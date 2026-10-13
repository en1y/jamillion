// The flight deck: where a moderator writes the day. Everything it talks to is in
// moderator.ts; everything it decides without a DOM is in quizdraft.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { ApiError } from './api'
import { QuizStats } from './Admin'
import { navigate } from './routing'
import { pause } from './query'
import {
  deleteQuiz, getFields, getQuiz, getTiers, listQuizzes, mergeAnswer, patchQuestion,
  reviewAnswer, runQuery, saveQuiz, setPublished, trackAudio,
} from './moderator'
import type { ModAnswer, ModQuestion, QuizDay, Tier } from './moderator'
import {
  NO_VALUE, OP_LABELS, answerText, cell, columnsFor, defaultOp, dirLabel, everyMatch, fieldGroups,
  fieldLabel, fieldType, fieldsFor, firstInGroup, groupOf, splitField, spreadTiers, toPick, usable,
} from './catalog'
import type {
  AnswerShape, CatalogField, CatalogSchema, Entity, Filter, Page, Query, Row, Sort,
} from './catalog'
import {
  CLIP_SEC, asksOf, clampSnippet, clearDraft, defaultTimeLimit, draftProblems, emptyDraft,
  fromQuiz, fullAnswerPoints, loadDraft, normalizeAnswer, onDate, playerBoxes, reseedAnswers,
  saveDraft, toPayload,
} from './quizdraft'
import type { AnswerField, Draft, DraftPick, DraftQuestion } from './quizdraft'
import type { Qtype } from './api'
import { formatDate, monthGrid, monthLabel, parseDate, shiftDay, shiftMonth, weekday } from './flight'
import { getSeeder } from './setup'
import type WaveSurfer from 'wavesurfer.js'
import type { Region } from 'wavesurfer.js/dist/plugins/regions.esm.js'

/** The fields a song question will take more than one name for. Not the artist:
 *  a song has one, and another name for that is a different act. */
const ALT_FIELDS: AnswerField[] = ['title', 'album']

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
function DatePicker({ value, onPick, label = 'Open the calendar' }:
  { value: string; onPick: (iso: string) => void; label?: string }) {
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
              aria-expanded={open} aria-label={label}>
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

/** The catalog has its own screen now; the deck keeps the one line that says
 *  whether it is worth going there. */
function CatalogLine({ token }: { token?: string }) {
  // The same key as the catalog screen, polled slower.
  const status = useQuery({ queryKey: ['seeder', token], queryFn: () => getSeeder(token), refetchInterval: 30_000 }).data
  const gaps = (status?.failures?.length ?? 0) + (status?.empty_artists?.length ?? 0)
  return (
    <aside className="catalog-line" aria-label="Music catalog">
      <span className="eyebrow">MUSIC CATALOG</span>
      <p role="status">{status
        ? <>{status.artists} artists{status.seeding
            ? <> · a run is in the air{status.progress?.artist ? ` (${status.progress.artist})` : ''}</>
            : gaps > 0 ? <> · {gaps} missing or empty</> : null}</>
        : 'Checking the catalog…'}</p>
      <a className="chip" href="/catalog">catalog dashboard</a>
    </aside>
  )
}

function DayList({ token, admin }: { token?: string; admin?: boolean }) {
  const list = useQuery({ queryKey: ['quizzes', token], queryFn: () => listQuizzes(token) })
  const days = list.error ? [] : list.data
  const [failed, setError] = useState('')
  const error = failed || (list.error ? wall(list.error) : '')
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
      await list.refetch()
      setError('')
    } catch (cause) {
      setError(wall(cause))
    } finally { setBusy('') }
  }

  return (
    <section className="editor" aria-labelledby="deck-heading">
      <p className="eyebrow">FLIGHT DECK</p>
      <h2 id="deck-heading">Which day are we writing?</h2>
      <CatalogLine token={token} />
      {error && <p className="notice" role="alert">{error}</p>}

      <div className="deck-open">
        <label>Open or start a date
          <input value={typed} onChange={e => setTyped(e.target.value)} inputMode="numeric"
                 placeholder="dd.mm.yyyy" maxLength={10} aria-invalid={date ? undefined : true} /></label>
        <DatePicker value={date} onPick={iso => setTyped(formatDate(iso))} />
        {date
          ? <a className="cta" href={`/editor/${date}`}>OPEN ▶</a>
          : <span className="cta off" role="status">dd.mm.yyyy</span>}
      </div>

      {list.isPending && <p role="status">Reading the schedule…</p>}
      {days?.length === 0 && !error && <p className="meta">No quizzes in this window yet.</p>}
      {days && days.length > 0 && (
        <ul className="days">
          {days.map(day => (
            <li key={day.quiz_date}>
              <a href={`/editor/${day.quiz_date}`}>
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

/** Group first, then field. One select of every column is forty options deep and
 *  says "track · title" on each of them; picking 'artist' first cuts the second
 *  select to that prefix's eleven and lets them read as plain words. Choosing a
 *  group moves the row to that group's first field, so the pair is never
 *  inconsistent -- which is why both selects go through one `onChange`. */
function FieldPicker({ fields, value, label, onChange }: {
  fields: CatalogField[]
  value: string
  label: string
  onChange: (key: string) => void
}) {
  const groups = fieldGroups(fields)
  const group = groupOf(value)
  const mine = groups.find(one => one.group === group)?.fields ?? []
  return (
    <>
      <select className="group" value={group} aria-label={`${label} group`}
              onChange={event => onChange(firstInGroup(fields, event.target.value))}>
        {groups.map(one =>
          <option key={one.group} value={one.group}>{one.group || 'other'}</option>)}
      </select>
      <select className="named" value={value} aria-label={`${label} field`}
              onChange={event => onChange(event.target.value)}>
        {mine.map(field =>
          <option key={field.key} value={field.key}>{splitField(field.key)[1]}</option>)}
      </select>
    </>
  )
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
function CatalogQuery({ schema, entities, token, onPick, onCollect, blocked }: {
  schema: CatalogSchema
  entities: Entity[]
  token?: string
  onPick?: (row: Row, entity: Entity) => void
  onCollect?: (texts: string[]) => void
  blocked?: (row: Row) => string | null
}) {
  const [entity, setEntity] = useState<Entity>(entities[0])
  const [filters, setFilters] = useState<Filter[]>([])
  const [sorts, setSorts] = useState<Sort[]>([])
  const [limit, setLimit] = useState(25)
  const [ticked, setTicked] = useState<number[]>([])
  const [shape, setShape] = useState<AnswerShape>('title')

  const fields = fieldsFor(schema, entity)
  const asked = usable(filters)
  const search: Query = { entity, filters: asked, sorts, limit }

  // Debounced like the answer completions in Play: one query per pause in typing.
  // The last page stays up while the next is asked for.
  const { data: page, error: failed, isFetching: busy } = useQuery<Page>({
    queryKey: ['catalog', search, token],
    queryFn: ({ signal }) => pause(250, signal).then(() => runQuery(search, token)),
    placeholderData: keepPreviousData,
  })
  const error = failed?.message ?? ''

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
  // Tiers are not decided here: they are handed out over the accepted answers
  // once they are all in, which is where the moderator can see the list.
  const collect = (picked: Row[]) => onCollect?.(picked.map(row => answerText(row, entity, shape)))

  const takeAll = useMutation({
    mutationFn: () => everyMatch(search, rows, page?.total ?? 0, next => runQuery(next, token)),
    onSuccess: collect,
  })

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
            <FieldPicker fields={fields} value={filter.field} label={label}
                         onChange={key => retype(index, key)} />
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
          <FieldPicker fields={fields} value={sort.field} label={`Sort ${index + 1}`}
                       onChange={key => setSorts(sorts.map((one, i) =>
                         i === index ? { ...one, field: key } : one))} />
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
            : takeAll.isPending ? 'taking every match…'
            : takeAll.error ? takeAll.error.message
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
          <button className="chip" type="button" disabled={ticked.length === 0}
                  onClick={() => { collect(rows.filter(row => ticked.includes(row.id))); setTicked([]) }}>
            + {ticked.length} ticked
          </button>
          <button className="chip" type="button" disabled={busy || takeAll.isPending}
                  onClick={() => takeAll.mutate()}>
            + all {(page?.total ?? rows.length).toLocaleString('en-US')}{page && page.total > rows.length ? ' matches' : ' shown'}
          </button>
        </div>
      )}
    </div>
  )
}

// --- the snippet picker ----------------------------------------------------

/** The window over the 30 s clip, on a wavesurfer waveform with one region. The
 *  clip route is moderator-guarded, so it comes in through fetch with the token
 *  rather than an <audio src>, and wavesurfer gets the blob. wavesurfer itself is
 *  imported here (the top takes only its types), so the player's bundle never carries it. */
function SnippetPicker({ trackId, start, len, token, onChange }: {
  trackId: number; start: number; len: number; token?: string
  onChange: (start: number, len: number) => void
}) {
  const wave = useRef<HTMLDivElement>(null)
  const region = useRef<Region | null>(null)
  const surfer = useRef<WaveSurfer | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)

  // The wavesurfer callbacks are set up once per clip, so they read the props here.
  const props = useRef({ start, len, onChange })
  useEffect(() => { props.current = { start, len, onChange } })
  // The sliders move the region; a drag on the region moves the sliders through onChange.
  useEffect(() => { region.current?.setOptions({ start, end: start + len }) }, [start, len])

  useEffect(() => {
    let live = true
    let ws: WaveSurfer | null = null
    Promise.all([
      fetch(trackAudio(trackId), {
        credentials: 'same-origin', headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).then(response => {
        if (!response.ok) throw new Error('No clip for that track')
        return response.blob()
      }),
      import('wavesurfer.js'),
      import('wavesurfer.js/dist/plugins/regions.esm.js'),
    ]).then(([clip, { default: Surfer }, { default: Regions }]) => {
      if (!live || !wave.current) return
      const regions = Regions.create()
      ws = surfer.current = Surfer.create({
        container: wave.current, height: 'auto', waveColor: '#2c4a72', progressColor: '#2c4a72',
        cursorWidth: 0, barWidth: 2, barGap: 1, interact: false, plugins: [regions],
      })
      // A tenth of a second is as fine as anyone hears, and the column keeps two decimals.
      const tenth = (second: number) => Math.round(second * 10) / 10
      const commit = (from: number, to: number) => {
        const fitted = clampSnippet(tenth(from), tenth(tenth(to) - tenth(from)))
        region.current?.setOptions({ start: fitted.start, end: fitted.start + fitted.len })
        props.current.onChange(fitted.start, fitted.len)
      }
      ws.on('ready', () => {
        const { start: from, len: length } = props.current
        region.current = regions.addRegion({
          start: from, end: from + length, color: 'transparent', minLength: 1,
        })
        // Bare waveform draws a fresh window, which replaces the one there was.
        regions.enableDragSelection({ color: 'transparent', minLength: 1 })
        setLoaded(true)
      })
      regions.on('region-created', drawn => {
        if (drawn === region.current) return
        region.current?.remove()
        region.current = drawn
        commit(drawn.start, drawn.end)
      })
      // wavesurfer trims a window slid into either end of the clip; a slide keeps its length.
      regions.on('region-update', (moved, side) => {
        const { len: length } = props.current
        if (side || moved.end - moved.start >= length) return
        moved.setOptions(moved.start === 0 ? { end: length } : { start: moved.end - length })
      })
      regions.on('region-updated', moved => commit(moved.start, moved.end))
      ws.on('play', () => setPlaying(true))
      ws.on('pause', () => setPlaying(false))
      return ws.loadBlob(clip)
    }).catch((cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : 'The clip would not load')
    })
    return () => { live = false; region.current = surfer.current = null; ws?.destroy() }
  }, [trackId, token])

  function audition() {
    if (playing) surfer.current?.pause()
    else region.current?.play(true)
  }
  const move = (nextStart: number, nextLen: number) => {
    const fitted = clampSnippet(nextStart, nextLen)
    onChange(fitted.start, fitted.len)
  }

  // The sliders stay -- they are the keyboard's way in, and the only way to nudge
  // by exactly a second.
  return (
    <div className="snip">
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="snip-wave" ref={wave} role="img" aria-label="Waveform of the 30 second clip">
        {!loaded && !error && <span className="meta">decoding the clip…</span>}
      </div>
      <p className="meta snip-hint">
        drag either edge to trim, the middle to slide it, or bare waveform to draw a
        new one — the whole clip is 30 s, which is all the preview a track has
      </p>
      <div className="snip-row">
        <button className="play" type="button" onClick={audition} disabled={!loaded}
                aria-label={playing ? 'Pause' : 'Play the window'}>
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

// --- the answers of a flown day ------------------------------------------------------

/** getQuiz already orders answers by guess_count, most given first. */
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
      {note && <p className="meta" role="status">{note}</p>}
      <ul className="answer-scroll">
        {answers.map(answer => (
          <li key={answer.id}>
            <span className="said">{answer.display}
              <small>{answer.guess_count} guess{answer.guess_count === 1 ? '' : 'es'} · {
                answer.is_correct ? 'accepted' : 'rejected'}</small>
            </span>
            <span className="verdicts">
              {([['✓', true], ['✗', false]] as const).map(([glyph, verdict]) => (
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
  const scroller = useRef<HTMLDivElement>(null)
  const filled = question.answers.filter(a => a.display.trim()).length
  // A song or album key is a handful of rows, worth seeing at once; a rarest list
  // or a long key stays folded. Decided per type, then the moderator's toggle wins,
  // so typing the tenth answer does not snap the list shut under the cursor.
  const few = question.qtype !== 'rarest' && question.answers.length < 10
  const [answersOpen, setAnswersOpen] = useState(few)
  const [openType, setOpenType] = useState(question.qtype)
  if (openType !== question.qtype) { setOpenType(question.qtype); setAnswersOpen(few) }
  const set = (patch: Partial<DraftQuestion>) => onChange({ ...question, ...patch })
  const pick = question.qtype === 'song' ? question.track : question.qtype === 'album' ? question.album : null
  const entity: Entity = question.qtype === 'album' ? 'albums' : 'tracks'
  const limits = LIMITS.includes(question.time_limit_sec)
    ? LIMITS : [...LIMITS, question.time_limit_sec].sort((a, b) => a - b)
  const asked = Object.values(asksOf(question)).filter(Boolean).length
  // The boxes the player is given, which is the asked-for fields the key answers.
  const boxes = playerBoxes(question)
  const total = fullAnswerPoints(question, tiers)
  const loose = question.answers.filter(answer => !answer.seeded && !answer.field).length

  /** Answers out of the catalog land beside whatever was typed by hand, and a
   *  name already in the table is not added twice -- normalised the way the
   *  UNIQUE (question_id, normalized) index will read it. */
  function collect(texts: string[]) {
    const rows = question.answers.filter(answer => answer.display.trim())
    const seen = new Set(rows.map(answer => normalizeAnswer(answer.display)))
    for (const text of texts) {
      const key = normalizeAnswer(text)
      if (!key || seen.has(key)) continue
      seen.add(key)
      rows.push({ display: text, tier_id: null })
    }
    set({ answers: rows })
  }

  /** Hand the ladder out down the answer list exactly as it stands: the top row
   *  is the answer everyone will give, the bottom is the deep cut, the rest stack
   *  evenly between. An action rather than a setting -- it is applied to the list
   *  on screen, whenever the moderator says so, and however it was assembled. */
  function spreadOverAnswers() {
    const ladder = spreadTiers(question.answers.length, tiers.map(tier => tier.id))
    set({ answers: question.answers.map((row, index) => {
      const next = { ...row, tier_id: ladder[index] ?? null }
      delete next.points          // a spread decides the score; an override would outrank it
      return next
    }) })
  }

  /** Anything that decides what a song or album question's answers should be goes
   *  through here, so the key is written for the moderator rather than by them.
   *  Rows typed by hand survive; see reseedAnswers. */
  const setAsked = (patch: Partial<DraftQuestion>) => {
    const next = { ...question, ...patch }
    onChange({ ...next, answers: reseedAnswers(next, tiers[1]?.id ?? null) })
  }

  /** Another right name for one of the fields: a title spelled a second way, or
   *  the other record a song sits on. It lands under the names that field already
   *  has, and scores what the field scores, so it carries no tier of its own. */
  function addName(field: AnswerField) {
    const rows = [...question.answers]
    const last = rows.map(row => row.field === field).lastIndexOf(true)
    rows.splice(last < 0 ? rows.length : last + 1, 0, { display: '', tier_id: null, field })
    set({ answers: rows })
  }

  /** The new row is at the bottom of its own scroller, so go and put the cursor in it. */
  function addAnswer() {
    set({ answers: [...question.answers, { display: '', tier_id: null }] })
    requestAnimationFrame(() => {
      const inputs = scroller.current?.querySelectorAll('input')
      inputs?.[inputs.length - 1]?.focus()
    })
  }

  const choose = (next: DraftPick) =>
    setAsked({ [question.qtype === 'song' ? 'track' : 'album']: next } as Partial<DraftQuestion>)

  return (
    <details className="qcard" open={slot === 0}>
      <summary>
        <span className="n">{slot + 1}</span>
        <span className="said">{question.prompt || <i>empty</i>}
          <small>{question.qtype}{pick ? ` · ${pick.artist} — ${pick.title}` : ''} · {filled} answers</small>
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

        {/* Four parts: the question above, then the pick, the answer key and the
            guesses, each folded on its own so a card opens on just the question. */}
        {question.qtype !== 'rarest' && !frozen && <details className="qpart">
          <summary>the {question.qtype === 'song' ? 'track' : 'album'} <span>{pick
            ? `${pick.artist} — ${pick.title}` : 'none picked yet'}</span></summary>
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
          {/* What the player is actually given. A field with no answer of its own in
              the key is not a box: "how is this artist's name spelled?" is answered
              "all caps", and an artist box would refuse that and everything else the
              question wants. The backend works this out the same way, from the key. */}
          {boxes.length === 0 ? (
            <p className="meta">no box: the player types one free answer, and the
              answers below are the whole of what counts</p>
          ) : boxes.length < asked ? (
            <p className="meta">the player only gets {boxes.join(' and ')}: the key has no
              answer for the {ASKS.filter(([flag]) => !boxes.includes(flag.slice(4) as AnswerField))
                .map(([, label]) => label.replace('ask for the ', '')).join(' or ')}</p>
          ) : null}

          {question.qtype === 'song' && question.track && (
            <SnippetPicker key={question.track.id} trackId={question.track.id} start={question.snippet_start_sec}
                           len={question.snippet_len_sec} token={token}
                           onChange={(start, len) => set({ snippet_start_sec: start, snippet_len_sec: len })} />
          )}
        </details>}

        {/* The completions under the player's boxes. On unless the moderator takes
            them away: three characters of a list of millions is a strong hint, and on
            some questions it is the whole question. A box with no catalog behind it --
            a rarest question, or one that asks for no field -- offers the accepted
            answers below instead, which is the only help there is when the key is
            the whole truth about what counts. */}
        {!frozen && (
          <div className="asks">
            <button className="chip" type="button" aria-pressed={question.hints}
                    onClick={() => set({ hints: !question.hints })}>
              {boxes.length === 0 ? 'suggest the accepted answers' : 'suggest names from the catalog'}
            </button>
            <span className="meta">{question.hints
              ? boxes.length === 0 ? 'players see matching answers from three characters in'
                            : 'players see matching names as they type'
              : 'players type it with no list'}</span>
          </div>
        )}

        {/* On a flown day the list below shows the same answers with
            controls that actually work, so this editor would only be a dead copy. */}
        {!frozen && <details className="qpart answers" open={answersOpen}
                             onToggle={e => setAnswersOpen(e.currentTarget.open)}>
          <summary>accepted answers · {filled} <span>{boxes.length === 0
            ? 'a tier here beats the rarity'
            : 'a player scores every field they get right, added up'}</span></summary>
          <div className="answer-tools">
            <button className="chip" type="button" onClick={addAnswer}>+ custom answer</button>
            {/* A song is one recording but not always one name: it can be titled two
                ways, and it can sit on a single, an album and a compilation. An album
                question is the record itself, so it has only the one. */}
            {question.qtype === 'song' && ALT_FIELDS.filter(field => asksOf(question)[field]).map(field => (
              <button key={field} className="chip" type="button" onClick={() => addName(field)}>
                + another {field}
              </button>
            ))}
            {/* Down the list as it reads: Nebula at the top, Supernova at the bottom.
                Only where a ladder means anything -- a song question's fields are
                three different questions, not one list from common to obscure. */}
            {boxes.length === 0 && question.answers.length > 1 && tiers.length > 0 && (
              <button className="chip" type="button" onClick={spreadOverAnswers}
                      title="Nebula at the top of the list, Supernova at the bottom, the rest evenly between">
                spread the tiers
              </button>
            )}
            {/* Twenty-five rows out of one query is one press; taking them back out
                should be too. The seeded field rows are not "added", so they stay. */}
            {loose > 0 && (
              <button className="chip scrub" type="button"
                      onClick={() => set({ answers: question.answers.filter(answer => answer.seeded || answer.field) })}>
                remove all {loose}
              </button>
            )}
          </div>
          {/* "Every Coldplay song over a million listens" is a query, not twenty
              lines of typing. Only on a rarest question: a song or album question
              writes its own key from the pick and the fields it asks for. */}
          {schema && boxes.length === 0 && (
            <details className="qquery">
              <summary>browse the catalog</summary>
              <CatalogQuery schema={schema} entities={['tracks', 'albums', 'artists']}
                            token={token} onCollect={collect} />
            </details>
          )}
          <div className="answer-scroll" ref={scroller}>
          {question.answers.length === 0 && <p className="meta">no answers yet</p>}
          {question.answers.map((answer, index) => {
            const alt = !answer.seeded && answer.field    // another name for a field
            return (
            <div className={alt ? 'answer-row alt' : 'answer-row'} key={index}>
              {alt && <span className="or">or</span>}
              <input value={answer.display} maxLength={300}
                     aria-label={alt ? `Another ${answer.field}` : `Answer ${index + 1}`}
                     onChange={e => set({ answers: question.answers.map((row, i) =>
                       i === index ? { ...row, display: e.target.value } : row) })} />
              {/* An alternative is the same answer said differently, so it is worth
                  what its field is worth and has nothing of its own to set. */}
              {!alt && (
                <select value={tierValue(answer)} aria-label={`Tier for answer ${index + 1}`}
                        onChange={e => set({ answers: question.answers.map((row, i) =>
                          i === index ? { ...row, ...tierChange(e.target.value) } : row) })}>
                  <TierOptions tiers={tiers} />
                </select>
              )}
              <button className="chip" type="button" aria-label={`Remove answer ${index + 1}`}
                      onClick={() => set({ answers: question.answers.filter((_, i) => i !== index) })}>×</button>
            </div>
          )})}
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
          </div>
        </details>}

        {saved && saved.answers.length > 0 && (
          <details className="qpart" open={frozen}>
            <summary>the answers · {saved.answers.length}</summary>
            <Review answers={saved.answers} tiers={tiers} token={token} onDone={onReviewed} />
          </details>
        )}
      </div>
    </details>
  )
}

// --- one day ---------------------------------------------------------------

const NO_TIERS: Tier[] = []    // one empty ladder, so the draft's problems are not rerun every render

function Day({ date, token, admin }: { date: string; token?: string; admin?: boolean }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // The same key as ground control's ladder, so an edit there shows here.
  const tiers = useQuery({ queryKey: ['tiers', token], queryFn: () => getTiers(token) }).data ?? NO_TIERS

  // The catalog's columns and operators. Static, so it is read once for the whole
  // day rather than by each of the seven cards.
  const schema = useQuery({ queryKey: ['fields', token], queryFn: () => getFields(token) }).data ?? null

  const day = useQuery({
    queryKey: ['quiz', date, token],
    queryFn: () => getQuiz(date, token).catch((cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 404) return null    // a day nobody has written yet
      throw cause
    }),
  })
  const quiz = day.data ?? null
  const error = day.error ? wall(day.error) : ''
  // Every read of the day, the first and each one after a save, starts the draft
  // over: from the one this browser kept, if it kept one. Set while rendering, the
  // way React adjusts state to a new prop, not in an effect a render late.
  const read = `${date}:${day.dataUpdatedAt}`
  const [seeded, setSeeded] = useState('')
  if (day.data !== undefined && seeded !== read) {
    setSeeded(read)
    setDraft(loadDraft(date) ?? (day.data ? fromQuiz(day.data) : emptyDraft(date)))
  }

  // Every keystroke is a draft: the server takes seven questions or nothing.
  const change = useCallback((next: Draft) => { setDraft(next); saveDraft(date, next) }, [date])

  // Expanding seven questions' keys is every spelling of every combination -- a
  // few thousand rows on a day with alternatives -- so it runs when the draft
  // changes, not on every render the seven cards cause.
  const problems = useMemo(() => draft ? draftProblems(draft, tiers) : [], [draft, tiers])

  if (error) return <section className="editor"><p className="notice" role="alert">{error}</p>
    <p><a className="chip" href="/editor">◀ all days</a></p></section>
  if (!draft) return <section className="editor"><p role="status">Opening {formatDate(date)}…</p></section>

  const frozen = (quiz?.attempts_started ?? 0) > 0

  async function save() {
    if (!draft || busy) return
    setBusy(true); setNote('Saving. A song whose clip has never been fetched adds a few seconds.')
    try {
      await saveQuiz(toPayload(draft, tiers), token)
      clearDraft(date)
      setNote('Saved.')
      void day.refetch()
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : 0
      const said = cause instanceof Error ? cause.message : 'The save did not land'
      setNote(status === 409 ? 'Someone flew this day while you were writing. Reload before editing.'
        : status === 422 ? `${said} — pick another track for that question.`
        : said)
    } finally { setBusy(false) }
  }

  /** Re-file the whole draft under another date: seven questions written against
   *  the wrong day are a retype otherwise. It moves the *draft*, never the server:
   *  a day already saved on the old date stays exactly as it is, which is why the
   *  note says so rather than leaving the moderator to find out.
   *
   *  The target is read first because saving replaces whatever sits on that date,
   *  and a silent overwrite of somebody else's day is the one outcome worth a
   *  round trip. 404 there means the date is free. */
  async function moveTo(iso: string) {
    if (!draft || iso === date || busy) return
    setBusy(true); setNote('')
    try {
      let taken = ''
      try {
        const there = await getQuiz(iso, token)
        taken = `${formatDate(iso)} already holds a ${there.published ? 'published' : 'draft'} day: ` +
                `${there.questions.length} questions, ${there.attempts_started} flights.`
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.status === 404)) throw cause
        if (loadDraft(iso)) taken = `${formatDate(iso)} has an unsaved draft of its own.`
      }
      if (taken && !confirm(`${taken}\n\nSaving here would replace it. Move anyway?`)) return
      saveDraft(iso, onDate(draft, iso))
      clearDraft(date)
      setNote(quiz
        ? `Now writing ${formatDate(iso)}. ${formatDate(date)} is still saved as it was.`
        : `Moved to ${formatDate(iso)}. Save to write it there.`)
      navigate(`/editor/${iso}`)
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : 'That date could not be read')
    } finally { setBusy(false) }
  }

  async function publish(next: boolean) {
    setBusy(true)
    try {
      await setPublished(date, next, token)
      setNote(next ? 'Published.' : 'Unpublished.')
      void day.refetch()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : 'The switch did not flip')
    } finally { setBusy(false) }
  }

  return (
    <section className="editor" aria-labelledby="day-heading">
      <p className="eyebrow"><a className="chip" href="/editor">◀ all days</a></p>
      <div className="day-head">
        <h2 id="day-heading">{formatDate(date)}</h2>
        {/* Frozen days are not moved: the questions are fixed where people flew them. */}
        {!frozen && <DatePicker value={date} label="Write this day on another date"
                                onPick={iso => void moveTo(iso)} />}
      </div>
      <p className="meta">{quiz
        ? `${quiz.published ? 'published' : 'draft'} · ${quiz.attempts_started} flights started`
        : 'nothing written for this day yet'}</p>
      {frozen && <p className="notice">People have flown this day, so the questions are frozen —
        points were fixed at answer time. The prompt can still be corrected, and the guesses below
        are yours to review.</p>}
      {/* Admin only, and only once somebody has flown: every number in it is zero
          until then, and on an unwritten day the route 404s. */}
      {admin && frozen && <details><summary>▪ THE NUMBERS</summary>
        <QuizStats date={date} token={token} /></details>}

      {draft.questions.map((question, slot) => (
        <QuestionCard key={slot} slot={slot} question={question} tiers={tiers} schema={schema}
                      token={token} frozen={frozen}
                      saved={quiz?.questions.find(q => q.position === slot + 1)}
                      onChange={next => change({ ...draft,
                        questions: draft.questions.map((q, i) => i === slot ? next : q) })}
                      onPrompt={async (id, prompt) => { await patchQuestion(id, { prompt }, token) }}
                      onReviewed={() => void day.refetch()} />
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
  return date ? <Day date={date} token={token} admin={admin} /> : <DayList token={token} admin={admin} />
}
