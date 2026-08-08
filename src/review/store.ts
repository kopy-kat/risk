/**
 * Saved games, in `localStorage`.
 *
 * A game is stored as its seed and its move list — never as boards. `applyMove`
 * is pure and the generator state lives inside `GameState`, so those two things
 * replay the whole game exactly, dice and all. A 300-move game is about 20 kB of
 * JSON; the same game as 300 board snapshots would be several megabytes.
 */
import { rulesFor } from '../engine/game'
import type { SeatConfig } from '../engine/game'
import type { GameMode, Move, PlayerId } from '../engine/types'

const KEY = 'risk.games.v1'
/** Bump when the record shape changes incompatibly. */
const SCHEMA = 1
/** Oldest games are evicted past this. 5 MB of quota is roughly 150 games. */
const MAX_GAMES = 40

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

/** Stable id for a game, so repeated saves overwrite one entry instead of piling up. */
export const newGameId = (seed: number): string => `${seed}-${Date.now().toString(36)}`
