// Ground control: the admin screen. Everything it talks to is in admin.ts.
// QuizStats is exported because the editor's day screen shows it too -- the import
// runs Editor -> Admin and never back, so the two files do not circle each other.
import { useEffect, useState } from 'react'
import { ApiError } from './api'
import { cell } from './catalog'
import { formatDate, parseDate } from './flight'
import { getTiers } from './moderator'
import type { Tier } from './moderator'
import {
  getStats, listTables, listUsers, patchTier, readTable, removeUser, rowRange, seedEdit,
  setRole, tierPatch,
} from './admin'
import type { AdminUser, Role, Stats, TierEdit, UserSort } from './admin'

const TABS = ['users', 'stats', 'tiers', 'tables'] as const
const ROLES: Role[] = ['user', 'moderator', 'admin']
const PAGE = 50

/** A 403 here can only mean "signed in, not an admin": an expired token is 401. */
const wall = (cause: unknown) =>
  cause instanceof ApiError && cause.status === 403
    ? 'Ground control is for admins. Ask one for the keys.'
    : cause instanceof Error ? cause.message : 'Ground control is not answering.'

// --- paging ------------------------------------------------------------------

/** Neither list route counts, so Next dies on a short page rather than on a total
 *  the backend never sends. See rowRange in admin.ts. */
function Pager({ offset, count, limit, onMove }: {
  offset: number; count: number; limit: number; onMove: (next: number) => void
}) {
  return (
    <div className="query-head">
      <p className="meta">{rowRange(offset, count)}</p>
      <span>
        <button className="chip" type="button" disabled={offset === 0}
                onClick={() => onMove(Math.max(0, offset - limit))}>◀ prev</button>
        <button className="chip" type="button" disabled={count < limit}
                onClick={() => onMove(offset + limit)}>next ▶</button>
      </span>
    </div>
  )
}

// --- users -------------------------------------------------------------------

const USER_COLUMNS: { key: UserSort; label: string; down: boolean }[] = [
  { key: 'username', label: 'username', down: false },
  { key: 'email', label: 'email', down: false },
  { key: 'role', label: 'role', down: true },
  { key: 'created_at', label: 'joined', down: true },
  { key: 'browsers', label: 'browsers', down: true },
  { key: 'attempts', label: 'flights', down: true },
]

function Users({ token, me }: { token?: string; me?: string }) {
  const [q, setQ] = useState('')
  const [role, setRoleFilter] = useState('')
  const [sort, setSort] = useState<UserSort>('created_at')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [offset, setOffset] = useState(0)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState('')
  const [failed, setFailed] = useState('')
  const [result, setResult] = useState<{ key: string; rows: AdminUser[]; error: string } | null>(null)

  // The params and the effect's only dependency, the way the catalog query does it.
  const wire = JSON.stringify({ q, role, sort, dir, limit: PAGE, offset })
  const key = `${wire}:${reload}`

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      listUsers(JSON.parse(wire), token)
        .then(rows => { if (live) setResult({ key, rows, error: '' }) })
        .catch((cause: unknown) => { if (live) setResult({ key, rows: [], error: wall(cause) }) })
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [wire, key, token])

  const rows = result?.key === key ? result.rows : undefined
  const error = result?.key === key ? result.error : ''

  /** Every narrowing of the list starts at the first page. Forgetting this is how
   *  a filtered list comes back empty on page four. */
  function refine(change: () => void) { change(); setOffset(0) }

  function toggleSort(column: { key: UserSort; down: boolean }) {
    refine(() => {
      if (sort === column.key) setDir(dir === 'asc' ? 'desc' : 'asc')
      else { setSort(column.key); setDir(column.down ? 'desc' : 'asc') }
    })
  }

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id)
    setFailed('')
    try {
      await run()
      setReload(n => n + 1)
    } catch (cause) {
      setFailed(wall(cause))
    } finally { setBusy('') }
  }

  async function changeRole(user: AdminUser, next: Role) {
    if (user.id === me && next !== 'admin' &&
        !confirm('You are about to remove your own admin access.\n\n' +
                 'This screen closes and only another admin can give it back. Continue?'))
      return
    await act(user.id, async () => {
      await setRole(user.id, next, token)
      // ponytail: the role is read from profiles on every request, so the dock chip
      // and the route guard disagree the instant this lands. One reload, never stale.
      if (user.id === me) location.reload()
    })
  }

  function remove(user: AdminUser) {
    if (!confirm(`Delete ${user.username}?\n\n` +
                 'The account goes; the flights stay, without a name on them. This cannot be undone.'))
      return
    void act(user.id, () => removeUser(user.id, token))
  }

  return (<>
    <div className="rule">
      <label className="grow">Search
        <input value={q} onChange={e => refine(() => setQ(e.target.value))}
               placeholder="username or email" /></label>
      <label>Role
        <select value={role} onChange={e => refine(() => setRoleFilter(e.target.value))}>
          <option value="">any</option>
          {ROLES.map(one => <option key={one} value={one}>{one}</option>)}
        </select></label>
    </div>

    {error && <p className="notice" role="alert">{error}</p>}
    {failed && <p className="notice" role="alert">{failed}</p>}
    {rows === undefined && <p role="status">Reading the register…</p>}

    {rows && rows.length > 0 && (
      <div className="rows-scroll">
        <table className="rows">
          <thead>
            <tr>
              {USER_COLUMNS.map(column => (
                <th key={column.key}>
                  <button type="button" onClick={() => toggleSort(column)}
                          aria-label={`Sort by ${column.label}`}>
                    {column.label}
                    {sort === column.key && <b>{dir === 'asc' ? '▲' : '▼'}</b>}
                  </button>
                </th>
              ))}
              <th><span className="sr">delete</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(user => (
              <tr key={user.id}>
                <td>{user.username}{user.id === me && <b> · you</b>}</td>
                <td>{user.email ?? '—'}</td>
                <td>
                  <select value={user.role} disabled={busy === user.id}
                          aria-label={`Role of ${user.username}`}
                          onChange={e => void changeRole(user, e.target.value as Role)}>
                    {ROLES.map(one => <option key={one} value={one}>{one}</option>)}
                  </select>
                </td>
                {/* Postgres text with a space, not a T: sliced, never parsed. */}
                <td>{formatDate(user.created_at.slice(0, 10))}</td>
                <td>{user.browsers}</td>
                <td>{user.attempts}</td>
                <td>
                  <button className="scrub" type="button" disabled={busy === user.id || user.id === me}
                          aria-label={user.id === me ? 'You cannot delete your own account here'
                                                     : `Delete ${user.username}`}
                          onClick={() => remove(user)}>
                    {busy === user.id ? '…' : 'DELETE'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}

    {/* Only once a page has actually landed: "nothing here" under a spinner, or
        under "Sign in required", is the screen answering a question nobody asked. */}
    {rows && !error && <Pager offset={offset} count={rows.length} limit={PAGE} onMove={setOffset} />}
  </>)
}

// --- per-question stats (the editor's day screen shows this too) -------------

const VERDICT = (is_correct: boolean | null) =>
  is_correct === null ? 'awaiting' : is_correct ? 'accepted' : 'rejected'

export function QuizStats({ date, token }: { date: string; token?: string }) {
  const [result, setResult] = useState<{ key: string; stats: Stats | null; error: string } | null>(null)

  useEffect(() => {
    let live = true
    getStats(date, 10, token)
      .then(stats => { if (live) setResult({ key: date, stats, error: '' }) })
      .catch((cause: unknown) => { if (live) setResult({ key: date, stats: null, error: wall(cause) }) })
    return () => { live = false }
  }, [date, token])

  if (result?.key !== date) return <p role="status">Reading the flight recorder…</p>
  if (result.error) return <p className="notice" role="alert">{result.error}</p>
  const stats = result.stats
  if (!stats) return null

  const finished = stats.heights.reduce((sum, height) => sum + height.players, 0)
  const most = Math.max(1, ...stats.heights.map(height => height.players))

  return (<>
    <div className="stats logbook-stats">
      <span className="stat"><small>FINISHED</small>{finished}</span>
      <span className="stat"><small>QUESTIONS</small>{stats.questions.length}</span>
      <span className="stat"><small>STATUS</small>{stats.published ? 'live' : 'draft'}</span>
    </div>

    {stats.heights.length === 0
      ? <p className="meta">Nobody has finished this day yet.</p>
      : <ul className="heights">
          {stats.heights.map(height => (
            <li key={height.total_points}>
              <span className="said">{height.total_points} pts · {height.height_au} AU</span>
              <span className="bar"><i style={{ width: `${height.players / most * 100}%` }} /></span>
              <b>{height.players}</b>
            </li>
          ))}
        </ul>}

    {stats.questions.map(question => (
      <details className="qcard" key={question.id}>
        <summary>
          <span className="said">{question.position}. {question.prompt}
            <small>{question.answered} answered · {question.skipped} skipped
              · {question.correct} correct</small>
          </span>
          <span className="more" aria-hidden="true" />
        </summary>
        <div className="qbody">
          {question.top_answers.length === 0
            ? <p className="meta">No accepted answers on this question.</p>
            : <div className="rows-scroll">
                <table className="rows">
                  <thead><tr>
                    <th className="plain">answer</th><th className="plain">verdict</th>
                    <th className="plain">guesses</th><th className="plain">share</th>
                  </tr></thead>
                  <tbody>
                    {question.top_answers.map(answer => (
                      <tr key={answer.id}>
                        <td>{answer.display}</td>
                        <td>{VERDICT(answer.is_correct)}</td>
                        <td>{answer.guess_count}</td>
                        <td>{(Number(answer.share) * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
        </div>
      </details>
    ))}
  </>)
}

/** The admin screen's own way in: a typed date rather than the editor's calendar,
 *  which lives in Editor.tsx and would make the two files circle each other. */
function StatsTab({ token }: { token?: string }) {
  const [typed, setTyped] = useState('')
  const date = parseDate(typed)
  return (<>
    <div className="rule">
      <label className="grow">Which day
        <input value={typed} onChange={e => setTyped(e.target.value)} inputMode="numeric"
               placeholder="dd.mm.yyyy" maxLength={10}
               aria-invalid={!typed || date ? undefined : true} /></label>
    </div>
    {date ? <QuizStats date={date} token={token} />
          : <p className="meta">Type a date as dd.mm.yyyy to read its numbers.</p>}
  </>)
}

// --- the rarity ladder -------------------------------------------------------

function Tiers({ token }: { token?: string }) {
  const [tiers, setTiers] = useState<Tier[] | null>(null)
  const [edits, setEdits] = useState<Record<number, TierEdit>>({})
  const [busy, setBusy] = useState(0)
  const [failed, setFailed] = useState<Record<number, string>>({})
  const [error, setError] = useState('')

  function adopt(rows: Tier[]) {
    setTiers(rows)
    setEdits(Object.fromEntries(rows.map(tier => [tier.id, seedEdit(tier)])))
  }

  useEffect(() => {
    let live = true
    getTiers(token)
      .then(rows => { if (live) adopt(rows) })
      .catch((cause: unknown) => { if (live) { setTiers([]); setError(wall(cause)) } })
    return () => { live = false }
  }, [token])

  async function save(tier: Tier, body: Record<string, string | number>) {
    setBusy(tier.id)
    setFailed(rest => ({ ...rest, [tier.id]: '' }))
    try {
      const saved = await patchTier(tier.id, body, token)
      // From the response, so the field shows the canonical "0.0020" rather than
      // whatever was typed.
      setTiers(rows => (rows ?? []).map(one => one.id === saved.id ? saved : one))
      setEdits(rest => ({ ...rest, [saved.id]: seedEdit(saved) }))
    } catch (cause) {
      setFailed(rest => ({ ...rest, [tier.id]: wall(cause) }))
    } finally { setBusy(0) }
  }

  return (<>
    <p className="meta">An edit never re-scores. Points are frozen at answer time, so this
      applies to answers landing after it — and a share decides which tier a future answer
      falls into, not which one a past one already got.</p>
    {error && <p className="notice" role="alert">{error}</p>}
    {tiers === null && <p role="status">Reading the ladder…</p>}

    {tiers?.map(tier => {
      const edit = edits[tier.id] ?? seedEdit(tier)
      const { body, problems } = tierPatch(tier, edit)
      const change = (part: Partial<TierEdit>) =>
        setEdits(rest => ({ ...rest, [tier.id]: { ...edit, ...part } }))
      return (
        <div className="qcard tier-row" key={tier.id}>
          <p className="fathom"><span>STEP {tier.sort_order}</span><span>id {tier.id}</span></p>
          <div className="answer-row">
            <input value={edit.name} aria-label={`Name of tier ${tier.sort_order}`}
                   onChange={e => change({ name: e.target.value })} />
            <input value={edit.points} type="number" min={0} max={32767} className="narrow"
                   aria-label={`Points of ${tier.name}`}
                   onChange={e => change({ points: e.target.value })} />
            <input value={edit.max_share} type="number" step="0.0001" min={0.0001} max={1}
                   className="narrow" aria-label={`Top share of ${tier.name}`}
                   onChange={e => change({ max_share: e.target.value })} />
            <button className="chip" type="button"
                    disabled={busy === tier.id || problems.length > 0 || Object.keys(body).length === 0}
                    onClick={() => void save(tier, body)}>
              {busy === tier.id ? '…' : 'save'}
            </button>
          </div>
          {problems.map(problem => <p className="notice" key={problem}>{problem}</p>)}
          {failed[tier.id] && <p className="notice" role="alert">{failed[tier.id]}</p>}
        </div>
      )
    })}
    <p className="meta">Name, points, and the largest share of players that still reaches this
      tier. Six steps are the game: none can be added, removed or reordered.</p>
  </>)
}

// --- the raw tables ----------------------------------------------------------

function Tables({ token }: { token?: string }) {
  const [names, setNames] = useState<string[]>([])
  const [name, setName] = useState('')
  const [limit, setLimit] = useState(100)
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState<{ key: string; rows: Record<string, unknown>[]; error: string } | null>(null)

  useEffect(() => {
    let live = true
    listTables(token)
      .then(rows => { if (live) { setNames(rows); setName(current => current || rows[0] || '') } })
      .catch(() => { if (live) setNames([]) })
    return () => { live = false }
  }, [token])

  const key = `${name}:${limit}:${offset}`
  useEffect(() => {
    if (!name) return
    let live = true
    readTable(name, limit, offset, token)
      .then(dump => { if (live) setResult({ key, rows: dump.rows, error: '' }) })
      .catch((cause: unknown) => { if (live) setResult({ key, rows: [], error: wall(cause) }) })
    return () => { live = false }
  }, [key, name, limit, offset, token])

  const rows = result?.key === key ? result.rows : undefined
  const error = result?.key === key ? result.error : ''
  const columns = Object.keys(rows?.[0] ?? {})

  return (<>
    <div className="rule">
      <label className="grow">Table
        <select value={name} onChange={e => { setName(e.target.value); setOffset(0) }}>
          {names.map(one => <option key={one} value={one}>{one}</option>)}
        </select></label>
      <label className="cap">show
        <select value={limit} aria-label="How many rows"
                onChange={e => { setLimit(Number(e.target.value)); setOffset(0) }}>
          {[25, 50, 100, 250, 500].map(many => <option key={many} value={many}>{many}</option>)}
        </select></label>
    </div>

    {error && <p className="notice" role="alert">{error}</p>}
    {name && rows === undefined && !error && <p role="status">Reading {name}…</p>}

    {rows && rows.length > 0 && (
      <div className="rows-scroll">
        <table className="rows">
          <thead><tr>{columns.map(column =>
            <th className="plain" key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {/* No id to key on: join tables and views have none. */}
            {rows.map((row, at) => (
              <tr key={at}>{columns.map(column => <td key={column}>{cell(column, row[column])}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    )}

    {/* An empty page carries no column names either, so there is no header to draw. */}
    {rows?.length === 0 && !error &&
      <p className="meta">{offset === 0 ? `No rows in ${name}.` : `Past the end of ${name}.`}</p>}

    {rows && !error && <Pager offset={offset} count={rows.length} limit={limit} onMove={setOffset} />}
    {names.length > 0 && <p className="meta">Read-only, and only these {names.length} tables —
      the allowlist is the whole boundary. Rows come back ordered by their first column;
      auth.users is not here.</p>}
  </>)
}

// --- the screen --------------------------------------------------------------

/** No role gate here or in App: a 403 renders as its own sentence, which beats a
 *  "not for you" flash while /api/me is still in the air. */
export function Admin({ tab, token, me }: { tab: string; token?: string; me?: string }) {
  const on = (TABS as readonly string[]).includes(tab) ? tab : 'users'
  return (
    <section className="editor" aria-labelledby="admin-heading">
      <p className="eyebrow">GROUND CONTROL</p>
      <h2 id="admin-heading">{on === 'users' ? 'Who is aboard'
        : on === 'stats' ? 'How a day went'
        : on === 'tiers' ? 'What an answer is worth'
        : 'The tables, as they are'}</h2>

      <div className="switch" aria-label="Admin section">
        {TABS.map(one => (
          <button className="chip" type="button" key={one} aria-pressed={on === one}
                  onClick={() => { location.hash = `#/admin/${one}` }}>{one}</button>
        ))}
      </div>

      {on === 'users' ? <Users token={token} me={me} />
        : on === 'stats' ? <StatsTab token={token} />
        : on === 'tiers' ? <Tiers token={token} />
        : <Tables token={token} />}
    </section>
  )
}
