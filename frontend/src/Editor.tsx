// The flight deck: where a moderator writes the day. Everything it talks to is in
// moderator.ts; everything it decides without a DOM is in quizdraft.ts.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'
import {
  getQuiz, getTiers, listQuizzes, mergeAnswer, patchQuestion, reviewAnswer,
  saveQuiz, searchAlbums, searchTracks, setPublished, trackAudio,
} from './moderator'
import type { AlbumHit, ModAnswer, ModQuestion, ModQuiz, QuizDay, Tier, TrackHit } from './moderator'
import {
  CLIP_SEC, clampSnippet, clearDraft, draftProblems, emptyDraft, fromQuiz, loadDraft,
  prefillAnswers, saveDraft, toPayload,
} from './quizdraft'
import type { Draft, DraftPick, DraftQuestion } from './quizdraft'
import type { Qtype } from './api'
import { formatDate } from './flight'

const QTYPES: Qtype[] = ['rarest', 'song', 'album']
const today = () => new Date().toISOString().slice(0, 10)

/** A 403 can only mean "signed in, wrong role": an expired token is always 401. */
const wall = (cause: unknown) =>
  cause instanceof ApiError && cause.status === 403
    ? 'The flight deck is for moderators. Ask an admin for the keys.'
    : cause instanceof Error ? cause.message : 'The flight deck is not answering.'

// --- the day list ----------------------------------------------------------

function DayList({ token }: { token?: string }) {
  const [days, setDays] = useState<QuizDay[] | null>(null)
  const [error, setError] = useState('')
  const [date, setDate] = useState(today())

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
        <label>Open a date<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <a className="cta" href={`#/editor/${date}`}>OPEN ▶</a>
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
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// --- catalog search --------------------------------------------------------

function CatalogPicker({ kind, token, onPick }: {
  kind: 'song' | 'album'; token?: string; onPick: (pick: DraftPick) => void
}) {
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [hits, setHits] = useState<(TrackHit | AlbumHit)[]>([])
  const [busy, setBusy] = useState(false)

  // Debounced like the answer-field completions in Play: one query per pause.
  // Hits from an earlier query linger until the next reply; a query too short to
  // scan shows nothing, derived rather than reset inside the effect.
  const short = title.trim().length < 2 && artist.trim().length < 2
  useEffect(() => {
    if (short) return
    let live = true
    const timer = setTimeout(() => {
      setBusy(true)
      const params = { q: title.trim(), artist: artist.trim(), limit: 8 }
      const search = kind === 'song' ? searchTracks(params, token) : searchAlbums(params, token)
      search.then(next => { if (live) setHits(next) })
        .catch(() => { if (live) setHits([]) })
        .finally(() => { if (live) setBusy(false) })
    }, 200)
    return () => { live = false; clearTimeout(timer) }
  }, [kind, title, artist, token, short])
  const shown = short ? [] : hits

  return (
    <div className="picker">
      <div className="picker-fields">
        <label>{kind === 'song' ? 'Track title' : 'Album title'}
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="title" /></label>
        <label>Artist
          <input value={artist} onChange={e => setArtist(e.target.value)} placeholder="artist" /></label>
      </div>
      {busy && <p className="meta" role="status">searching the catalog…</p>}
      <ul className="hits">
        {shown.map(hit => {
          const track = 'has_preview' in hit ? hit : null
          return (
            <li key={hit.id}>
              <button type="button" disabled={Boolean(track && !track.has_preview)}
                      onClick={() => onPick({ id: hit.id, title: hit.title, artist: hit.artist,
                                              cover: 'cover_url' in hit ? hit.cover_url : null })}>
                <span className="said">{hit.artist} — {hit.title}
                  <small>{hit.release_date?.slice(0, 4) ?? '—'}
                    {track ? (track.has_preview ? ` · ${track.album}` : ' · no preview')
                           : ` · ${'total_tracks' in hit ? hit.total_tracks ?? '?' : '?'} tracks`}</small>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
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

  return (
    <div className="snip">
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="wave">
        <canvas ref={canvas} aria-label="Waveform of the 30 second clip" />
        {!peaks && !error && <span className="meta">decoding the clip…</span>}
      </div>
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
              <select value={answer.tier_id ?? ''} disabled={busy > 0}
                      aria-label={`Tier for ${answer.display}`}
                      onChange={e => void act(() => reviewAnswer(answer.id,
                        { tier_id: e.target.value ? Number(e.target.value) : null }, token))}>
                <option value="">by rarity</option>
                {tiers.map(tier => <option key={tier.id} value={tier.id}>{tier.name}</option>)}
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

function QuestionCard({ slot, question, tiers, token, frozen, saved, onChange, onPrompt, onReviewed }: {
  slot: number; question: DraftQuestion; tiers: Tier[]; token?: string; frozen: boolean
  saved: ModQuestion | undefined
  onChange: (next: DraftQuestion) => void
  onPrompt: (id: number, prompt: string) => Promise<void>
  onReviewed: () => void
}) {
  const [promptNote, setPromptNote] = useState('')
  const set = (patch: Partial<DraftQuestion>) => onChange({ ...question, ...patch })
  const pick = question.qtype === 'song' ? question.track : question.qtype === 'album' ? question.album : null

  function choose(next: DraftPick) {
    const seeded = prefillAnswers(next, question.ask_artist, question.ask_title, tiers[1]?.id ?? null)
    set({
      [question.qtype === 'song' ? 'track' : 'album']: next,
      // Only seed an empty table: a moderator who has typed already keeps their work.
      answers: question.answers.some(a => a.display.trim()) ? question.answers : seeded,
    } as Partial<DraftQuestion>)
  }

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
                    disabled={frozen} onClick={() => set({ qtype: type })}>{type}</button>
          ))}
        </div>

        <label>Prompt
          <input value={question.prompt} maxLength={500}
                 onChange={e => set({ prompt: e.target.value })} /></label>
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
                        onClick={() => set({ track: null, album: null })}>change</button>
              </p>
            : <CatalogPicker kind={question.qtype} token={token} onPick={choose} />}

          <div className="asks">
            {([['ask_artist', 'ask for the artist'], ['ask_title', 'ask for the title']] as const)
              .map(([flag, label]) => (
                <button key={flag} className="chip" type="button" aria-pressed={question[flag]}
                        onClick={() => set({ [flag]: !question[flag] } as Partial<DraftQuestion>)}>{label}</button>
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
          <p className="fathom">accepted answers <span>a tier here beats the rarity</span></p>
          {question.answers.map((answer, index) => (
            <div className="answer-row" key={index}>
              <input value={answer.display} maxLength={100} aria-label={`Answer ${index + 1}`}
                     onChange={e => set({ answers: question.answers.map((row, i) =>
                       i === index ? { ...row, display: e.target.value } : row) })} />
              <select value={answer.tier_id ?? ''} aria-label={`Tier for answer ${index + 1}`}
                      onChange={e => set({ answers: question.answers.map((row, i) =>
                        i === index ? { ...row, tier_id: e.target.value ? Number(e.target.value) : null } : row) })}>
                <option value="">by rarity</option>
                {tiers.map(tier => <option key={tier.id} value={tier.id}>{tier.name}</option>)}
              </select>
              <button className="chip" type="button" aria-label={`Remove answer ${index + 1}`}
                      onClick={() => set({ answers: question.answers.filter((_, i) => i !== index) })}>×</button>
            </div>
          ))}
          <button className="chip" type="button"
                  onClick={() => set({ answers: [...question.answers, { display: '', tier_id: null }] })}>
            + answer
          </button>
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
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => { getTiers(token).then(setTiers).catch(() => setTiers([])) }, [token])

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
  const problems = draftProblems(draft)

  async function save() {
    if (!draft || busy) return
    setBusy(true); setNote('Saving. A song whose clip has never been fetched adds a few seconds.')
    try {
      await saveQuiz(toPayload(draft), token)
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
        <QuestionCard key={slot} slot={slot} question={question} tiers={tiers} token={token}
                      frozen={frozen} saved={quiz?.questions.find(q => q.position === slot + 1)}
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

export function Editor({ date, token }: { date: string; token?: string }) {
  return date ? <Day date={date} token={token} /> : <DayList token={token} />
}
