/**
 * Saved games, in `localStorage`.
 *
 * A game is stored as its seed and its move list — never as boards. `applyMove`
 * is pure and the generator state lives inside `GameState`, so those two things
 * replay the whole game exactly, dice and all. A 300-move game is about 20 kB of
 * JSON; the same game as 300 board snapshots would be several megabytes.
 */
import { applyMove, createGame, rulesFor } from '../engine/game'
import type { SeatConfig } from '../engine/game'
import { TERRITORY_IDS } from '../engine/board'
import type { TerritoryId } from '../engine/board'
import type { GameMode, Move, PlayerId } from '../engine/types'

const KEY = 'risk.games.v1'
/** Bump when the record shape changes incompatibly. */
const SCHEMA = 1
/** Oldest games are evicted past this. 5 MB of quota is roughly 150 games. */
const MAX_GAMES = 40
/** Keep parsing and replay validation bounded on the browser's UI thread. */
const MAX_IMPORT_CHARS = 10 * 1024 * 1024
// A long real game is roughly 700 moves; three times that still admits generous
// outliers without letting one replay retain hundreds of megabytes of snapshots.
const MAX_IMPORTED_MOVES_PER_GAME = 2_000
const MAX_TOTAL_IMPORTED_MOVES = 50_000
const TERRITORIES = new Set<string>(TERRITORY_IDS)

export interface GameRecord {
  id: string
  schema: number
  /** `RULES_VERSION` at the time it was played — see `isReplayable` */
  rules: string
  seed: number
  /**
   * The bots run off a second generator, seeded from the first. Replay doesn't
   * need it — bot *moves* are recorded like everyone else's — but keeping it is
   * free and it's what would let a game be re-run with the seats changed.
   */
  botSeed: number
  seats: SeatConfig[]
  /** Rule set the game was played under. Absent on records that predate modes: classic. */
  mode?: GameMode
  moves: Move[]
  /**
   * Indices of moves the app played on a human's behalf, i.e. "auto-place rest".
   * Reviewing someone for a move they didn't make is worse than not reviewing it.
   */
  assisted: number[]
  winner: PlayerId | null
  turns: number
  finished: boolean
  savedAt: number
}

export interface ImportGamesResult {
  /** New records actually added to storage. */
  imported: number
  /** Records whose id was already present locally or earlier in the file. */
  duplicates: number
  /** Entries that were malformed, incompatible, or did not replay cleanly. */
  rejected: number
  /** Valid new entries not added because local history is already at its limit. */
  atCapacity: number
}

/**
 * Whether this record can be replayed against the engine as it stands now.
 *
 * Rules drift is the one thing that silently corrupts a replay: change the
 * cash-in table and an old move list desyncs part way through, leaving a board
 * that looks plausible and is wrong.
 */
export const isReplayable = (r: GameRecord): boolean =>
  r.schema === SCHEMA && r.rules === rulesFor(r.mode)

function read(): GameRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as GameRecord[]) : []
  } catch {
    // corrupt or unavailable (private browsing, disabled storage) — no history
    // is a better outcome than a crashed app
    return []
  }
}

function write(games: GameRecord[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(games))
  } catch {
    // over quota: drop the oldest half and try once more rather than losing the
    // game currently being played
    try {
      localStorage.setItem(KEY, JSON.stringify(games.slice(0, Math.floor(games.length / 2))))
    } catch {
      /* storage is unusable; play continues, history doesn't */
    }
  }
}

/** Newest first. */
export function listGames(): GameRecord[] {
  return read().sort((a, b) => b.savedAt - a.savedAt)
}

export function getGame(id: string): GameRecord | null {
  return read().find((g) => g.id === id) ?? null
}

/**
 * Insert or replace by id. The app saves after every move, so a game abandoned
 * mid-turn is still reviewable — and an undone move disappears from the record,
 * which is correct, because it didn't happen.
 */
export function saveGame(record: Omit<GameRecord, 'schema' | 'rules' | 'savedAt'>): void {
  const full: GameRecord = {
    ...record,
    schema: SCHEMA,
    rules: rulesFor(record.mode),
    savedAt: Date.now(),
  }
  const rest = read().filter((g) => g.id !== full.id)
  write([full, ...rest].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_GAMES))
}

export function deleteGame(id: string): void {
  write(read().filter((g) => g.id !== id))
}

export function clearGames(): void {
  write([])
}

/**
 * Merge a shared export into local history without replacing anything already here.
 *
 * Both the all-games export (an array) and a per-game export (one object) are
 * accepted. Every candidate is structurally checked and replayed before it can
 * reach storage: a plausible-looking but corrupt move list is worse than a clear
 * import error, because its review would stop halfway through the game.
 */
export function importGames(json: string): ImportGamesResult {
  if (json.length > MAX_IMPORT_CHARS)
    throw new Error('That file is too large to import safely.')

  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error('That file is not valid JSON.')
  }

  const values = Array.isArray(value) ? value : [value]
  if (!values.length) throw new Error('That file contains no games.')
  if (values.length > MAX_GAMES)
    throw new Error(`That file contains more than ${MAX_GAMES} games.`)

  // Do this before replaying anything. Per-record limits alone still allow an
  // all-games file to make the setup screen validate an unreasonable amount of
  // work synchronously.
  let totalMoves = 0
  for (const candidate of values) {
    if (isObject(candidate) && Array.isArray(candidate.moves))
      totalMoves += candidate.moves.length
    if (totalMoves > MAX_TOTAL_IMPORTED_MOVES)
      throw new Error('That file contains too many moves to import safely.')
  }

  const importedAt = Date.now()
  const valid: GameRecord[] = []
  const problems: string[] = []
  values.forEach((candidate, i) => {
    const parsed = parseRecord(candidate, importedAt)
    if (typeof parsed === 'string') problems.push(`game ${i + 1}: ${parsed}`)
    else valid.push(parsed)
  })

  if (!valid.length) {
    const detail = problems[0] ? ` ${problems[0]}` : ''
    throw new Error(`No usable games were found.${detail}`)
  }

  // Sort first so, if an exported file somehow contains two saves with one id,
  // its newest copy is the one considered. A local copy still always wins.
  valid.sort((a, b) => b.savedAt - a.savedAt)
  const existing = listGames()
  const seen = new Set(existing.map((g) => g.id))
  const newRecords: GameRecord[] = []
  let duplicates = 0
  for (const record of valid) {
    if (seen.has(record.id)) {
      duplicates++
      continue
    }
    seen.add(record.id)
    newRecords.push(record)
  }

  // Imports never evict somebody's own history. When the 40-game shelf is full,
  // report the overflow and leave those records in the file rather than silently
  // trading local games for shared ones.
  const room = Math.max(0, MAX_GAMES - existing.length)
  const accepted = newRecords.slice(0, room)
  const atCapacity = newRecords.length - accepted.length
  if (accepted.length) {
    const merged = [...existing, ...accepted].sort((a, b) => b.savedAt - a.savedAt)
    try {
      // Unlike live-game saves, this is transactional: a quota failure must not
      // invoke write()'s eviction fallback and discard an existing local game.
      localStorage.setItem(KEY, JSON.stringify(merged))
    } catch {
      throw new Error('The games are valid, but browser storage could not save them.')
    }
  }

  return {
    imported: accepted.length,
    duplicates,
    rejected: problems.length,
    atCapacity,
  }
}

function parseRecord(value: unknown, importedAt: number): GameRecord | string {
  if (!isObject(value)) return 'not a game record'
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200)
    return 'missing or invalid id'
  if (value.schema !== SCHEMA) return `unsupported schema (expected ${SCHEMA})`

  const mode = value.mode === undefined ? undefined : parseMode(value.mode)
  if (mode === null) return 'invalid game mode'
  if (typeof value.rules !== 'string' || value.rules !== rulesFor(mode ?? undefined))
    return 'played under different rules'
  if (!integer(value.seed)) return 'invalid seed'
  if (!integer(value.botSeed)) return 'invalid bot seed'
  if (!Array.isArray(value.seats) || value.seats.length < 2 || value.seats.length > 6)
    return 'must have 2–6 seats'

  const seats: SeatConfig[] = []
  for (const seat of value.seats) {
    if (!isObject(seat)) return 'invalid seat'
    if (typeof seat.name !== 'string' || !seat.name.trim() || seat.name.length > 100)
      return 'invalid seat name'
    if (seat.bot !== null && (typeof seat.bot !== 'string' || seat.bot.length > 100))
      return 'invalid seat controller'
    if (seat.color !== undefined && (!integer(seat.color) || seat.color < 0 || seat.color > 5))
      return 'invalid seat colour'
    seats.push({
      name: seat.name,
      bot: seat.bot,
      ...(seat.color === undefined ? {} : { color: seat.color }),
    })
  }

  if (!Array.isArray(value.moves) || value.moves.length > MAX_IMPORTED_MOVES_PER_GAME)
    return 'invalid or unreasonably long move list'
  const moves: Move[] = []
  for (const candidate of value.moves) {
    const move = parseMove(candidate)
    if (!move) return 'invalid move'
    moves.push(move)
  }

  if (!Array.isArray(value.assisted) || value.assisted.length > MAX_IMPORTED_MOVES_PER_GAME)
    return 'invalid assisted-move list'
  const assisted = new Set<number>()
  for (const index of value.assisted) {
    if (!integer(index) || index < 0 || index >= moves.length)
      return 'invalid assisted-move index'
    assisted.add(index)
  }
  if (value.winner !== null && (!integer(value.winner) || value.winner < 0 || value.winner >= seats.length))
    return 'invalid winner'
  if (!integer(value.turns) || value.turns < 0) return 'invalid turn count'
  if (typeof value.finished !== 'boolean') return 'invalid finished flag'
  if (!integer(value.savedAt) || value.savedAt < 0) return 'invalid saved date'

  const record: GameRecord = {
    id: value.id,
    schema: SCHEMA,
    rules: value.rules,
    seed: value.seed,
    botSeed: value.botSeed,
    seats,
    ...(mode === undefined ? {} : { mode }),
    moves,
    assisted: [...assisted],
    winner: value.winner,
    turns: value.turns,
    finished: value.finished,
    // A shared file must not be able to keep every future local save behind a
    // far-future timestamp and make the 40-game shelf discard those new games.
    savedAt: Math.min(value.savedAt, importedAt),
  }

  // Structural validation catches bad JSON shapes; actually applying the moves
  // catches legal-looking but impossible histories and metadata that does not
  // describe the replay friends would see.
  try {
    let state = createGame({
      seats: record.seats,
      seed: record.seed,
      mode: record.mode,
      // Validation needs boards, not a second copy of the imported move list.
      // Keeping recording on would clone an ever-growing array on every move.
      record: false,
    })
    for (const move of record.moves) {
      state = applyMove(state, move)
      // Logs do not participate in move legality. Validation retains no prior
      // boards, so discarding them keeps this pass linear even for an all-games
      // import; the real replay reconstructs its own history when the game opens.
      state.log.length = 0
    }
    if (state.turn !== record.turns) return 'turn count does not match its replay'
    if (state.winner !== record.winner) return 'winner does not match its replay'
    if ((state.phase === 'gameOver') !== record.finished)
      return 'finished flag does not match its replay'
  } catch {
    return 'move list does not replay under these rules'
  }
  return record
}

function parseMove(value: unknown): Move | null {
  if (!isObject(value) || typeof value.type !== 'string') return null
  const territory = (key: string): TerritoryId | null =>
    typeof value[key] === 'string' && TERRITORIES.has(value[key] as string)
      ? (value[key] as TerritoryId)
      : null
  switch (value.type) {
    case 'placeInitial': {
      const at = territory('territory')
      return at ? { type: 'placeInitial', territory: at } : null
    }
    case 'tradeCards': {
      const cards = value.cards
      return Array.isArray(cards) && cards.length === 3 && cards.every(integer) && new Set(cards).size === 3
        ? { type: 'tradeCards', cards }
        : null
    }
    case 'deploy': {
      const at = territory('territory')
      return at && positiveInteger(value.count) ? { type: 'deploy', territory: at, count: value.count } : null
    }
    case 'attack': {
      const from = territory('from')
      const to = territory('to')
      return from && to && integer(value.dice) && value.dice >= 1 && value.dice <= 3
        ? { type: 'attack', from, to, dice: value.dice }
        : null
    }
    case 'blitz': {
      const from = territory('from')
      const to = territory('to')
      return from && to ? { type: 'blitz', from, to } : null
    }
    case 'occupy':
      // A one-die capture has already advanced its required army, so zero extra
      // occupation is both legal and common.
      return nonnegativeInteger(value.count) ? { type: 'occupy', count: value.count } : null
    case 'endAttack':
      return { type: 'endAttack' }
    case 'fortify': {
      const from = territory('from')
      const to = territory('to')
      return from && to && positiveInteger(value.count)
        ? { type: 'fortify', from, to, count: value.count }
        : null
    }
    case 'endTurn':
      return { type: 'endTurn' }
    default:
      return null
  }
}

function parseMode(value: unknown): GameMode | null {
  return value === 'classic' || value === 'capitals' || value === 'supply' ? value : null
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const integer = (value: unknown): value is number => Number.isSafeInteger(value)
const nonnegativeInteger = (value: unknown): value is number => integer(value) && value >= 0
const positiveInteger = (value: unknown): value is number => integer(value) && value > 0

/** Stable id for a game, so repeated saves overwrite one entry instead of piling up. */
export const newGameId = (seed: number): string => `${seed}-${Date.now().toString(36)}`
