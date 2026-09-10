// The catalog query builder: /api/catalog answers any question that can be asked
// by stacking filters and sorts over an allowlist of columns, and describes that
// allowlist on /api/catalog/fields -- so the whole UI is built from what the
// backend says exists rather than from a second copy of the schema kept here.
//
// The wire types and everything that needs no DOM, the way quizdraft.ts sits
// beside the editor; the two fetches are in moderator.ts with the other moderator
// routes. Pure, so catalog.test.ts can check it without a browser.
import type { DraftPick } from './quizdraft'

export type FieldType = 'text' | 'number' | 'date' | 'boolean'
export type Entity = 'tracks' | 'albums' | 'artists'

export interface CatalogField { key: string; type: FieldType; entities: Entity[] }

export interface CatalogSchema {
  entities: { name: Entity; label: string }[]
  operators: Record<FieldType, string[]>
  fields: CatalogField[]
}

export interface Filter { field: string; op: string; value: string }
export interface Sort { field: string; dir: 'asc' | 'desc' }

/** A row carries every column its entity has, keyed exactly as the field is. */
export type Row = Record<string, string | number | boolean | null> & { id: number }

export interface Page { entity: Entity; total: number; rows: Row[] }

export interface Query {
  entity: Entity; filters: Filter[]; sorts: Sort[]; limit?: number; offset?: number
}

// --- reading a field key ----------------------------------------------------

/** 'artist.lastfm_listeners' -> ['artist', 'lastfm listeners']. The group half
 *  becomes an <optgroup>, so the option itself reads as plain words. */
export function splitField(key: string): [string, string] {
  const dot = key.indexOf('.')
  return dot < 0 ? ['', key.replace(/_/g, ' ')]
                 : [key.slice(0, dot), key.slice(dot + 1).replace(/_/g, ' ')]
}

export const fieldLabel = (key: string) => splitField(key).join(' · ')

/** 'artist.country' -> 'artist'. The prefix a field is picked from. */
export const groupOf = (key: string) => splitField(key)[0]

/** The allowlist split by prefix, each group in the order the backend listed it:
 *  that order is `kColumns`, which reads track, then album, then artist. Forty
 *  columns in one select is a scroll; choosing 'artist' first leaves eleven. */
export function fieldGroups(fields: CatalogField[]): { group: string; fields: CatalogField[] }[] {
  const out: { group: string; fields: CatalogField[] }[] = []
  for (const field of fields) {
    const group = groupOf(field.key)
    const found = out.find(one => one.group === group)
    if (found) found.fields.push(field)
    else out.push({ group, fields: [field] })
  }
  return out
}

/** What choosing a group selects: its first field, so the row is never left
 *  naming a field the group above it does not contain. */
export const firstInGroup = (fields: CatalogField[], group: string) =>
  (fields.find(field => groupOf(field.key) === group) ?? fields[0])?.key ?? ''

export const OP_LABELS: Record<string, string> = {
  contains: 'contains', starts: 'starts with', ends: 'ends with',
  eq: 'is', ne: 'is not', in: 'one of',
  lt: 'is under', lte: 'is at most', gt: 'is over', gte: 'is at least',
  null: 'is empty', notnull: 'has a value',
}

/** The two operators that read a column rather than compare it. */
export const NO_VALUE = new Set(['null', 'notnull'])

export const defaultOp = (type: FieldType) =>
  type === 'text' ? 'contains' : type === 'boolean' ? 'eq' : 'gte'

export const fieldType = (schema: CatalogSchema, key: string): FieldType =>
  schema.fields.find(field => field.key === key)?.type ?? 'text'

export const fieldsFor = (schema: CatalogSchema, entity: Entity) =>
  schema.fields.filter(field => field.entities.includes(entity))

/** Half-typed filters are dropped rather than sent: the backend rejects a missing
 *  value with 400, and a moderator mid-keystroke has not made a mistake yet. */
export const usable = (filters: Filter[]) =>
  filters.filter(filter => NO_VALUE.has(filter.op) || filter.value.trim() !== '')

// --- a row, read as something else -------------------------------------------

const TITLE: Record<Entity, string> = {
  tracks: 'track.title', albums: 'album.title', artists: 'artist.name',
}

export type AnswerShape = 'title' | 'artist-title' | 'artist'

/** What the moderator gets when a result becomes an accepted answer. On an artist
 *  search all three shapes are the same name, which is why nothing branches on it. */
export function answerText(row: Row, entity: Entity, shape: AnswerShape): string {
  const title = String(row[TITLE[entity]] ?? '').trim()
  const artist = String(row['artist.name'] ?? '').trim()
  if (entity === 'artists') return title
  if (shape === 'title') return title
  if (shape === 'artist') return artist
  return [artist, title].filter(Boolean).join(' — ')
}

/** A result chosen as the track or album a question is built on. `album` is the
 *  record a track came from, which is what ask_album asks players for; on an
 *  album row it would just repeat the title, so it is left off. */
export const toPick = (row: Row, entity: Entity): DraftPick => ({
  id: row.id,
  title: String(row[TITLE[entity]] ?? ''),
  artist: String(row['artist.name'] ?? ''),
  cover: typeof row['album.cover_url'] === 'string' ? row['album.cover_url'] : null,
  album: entity === 'tracks' && typeof row['album.title'] === 'string' ? row['album.title'] : null,
})

// --- the results table -------------------------------------------------------

// ponytail: the play count rides along on every track and artist page, because
// "how big is this song" is the question behind most catalog searches.
const IDENTITY: Record<Entity, string[]> = {
  tracks: ['artist.name', 'track.title', 'album.title', 'track.genres', 'track.ytmusic_plays'],
  albums: ['artist.name', 'album.title', 'album.year', 'album.genres', 'album.ytmusic_plays'],
  artists: ['artist.name', 'artist.country', 'artist.genres', 'artist.global_rank',
            'artist.ytmusic_listeners'],
}

/** Who the row is, then whatever was filtered or sorted on -- so the listen count
 *  you sorted by is on screen beside the name instead of taken on trust. */
export function columnsFor(entity: Entity, filters: Filter[], sorts: Sort[]): string[] {
  const columns = new Set(IDENTITY[entity])
  for (const sort of sorts) columns.add(sort.field)
  for (const filter of filters) columns.add(filter.field)
  columns.delete('album.cover_url')
  columns.delete('artist.image_url')
  return [...columns]
}

/** Thousands separators on the big numbers, none on a year: 1,000,000 listens
 *  reads, "2,000" as a release year does not. */
export function cell(key: string, value: Row[string]): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number')
    return key.endsWith('year') ? String(value) : value.toLocaleString('en-US')
  return String(value)
}

/** What a sort direction means for the datatype in front of it: "biggest first"
 *  and "Z → A" are the same DESC, but only one of them reads. */
export const dirLabel = (type: FieldType, dir: 'asc' | 'desc') =>
  type === 'text' ? (dir === 'asc' ? 'A → Z' : 'Z → A')
    : type === 'date' ? (dir === 'asc' ? 'oldest first' : 'newest first')
    : (dir === 'asc' ? 'smallest first' : 'biggest first')

/** Tiers for a page of results, spread down the ladder in the order they are
 *  shown. The top of the sort is the answer everyone will give and takes the
 *  first tier; the bottom is the obscure one and takes the last; the rest stack
 *  evenly between, so both ends get a couple of rows and the middle divides up.
 *  What "common" means here is whatever the moderator sorted by, which is the
 *  point -- listeners descending makes the ladder read as popularity. */
export function spreadTiers(count: number, ladder: number[]): (number | null)[] {
  if (count <= 0 || ladder.length === 0) return Array.from({ length: Math.max(count, 0) }, () => null)
  const last = ladder.length - 1
  return Array.from({ length: count }, (_, i) =>
    ladder[count === 1 ? 0 : Math.round((i * last) / (count - 1))])
}
