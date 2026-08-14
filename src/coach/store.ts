/**
 * The commander's log, in `localStorage`.
 *
 * Deliberately not part of a game record. A record is a seed and a move list and
 * nothing else, which is what makes it replay exactly; what you *intended* is not
 * a fact about the game and would only be dead weight travelling with it. So
 * notes live under their own key, addressed by game and turn, and a game replays
 * identically whether or not anyone wrote a word.
 */
import type { PlayerId } from '../engine/types'
import type { Claim } from './claims'

const KEY = 'risk.coach.v1'
/** Bump when the note shape changes incompatibly. */
const SCHEMA = 1
/** Oldest notes are evicted past this — a long game logs perhaps forty. */
const MAX_NOTES = 600

export interface TurnNote {
  schema: number
  /** the `GameRecord` id this was written during */
  gameId: string
  player: PlayerId
  turn: number
  /** free text: what you meant to do */
  intent: string
  /** the scorable part, or null when only the intent was written down */
  claim: Claim | null
  /** percent, one of `CONFIDENCE_STEPS` */
  confidence: number
  at: number
}

function read(): TurnNote[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as TurnNote[]).filter((n) => n.schema === SCHEMA) : []
  } catch {
    // corrupt or unavailable storage — no log is a better outcome than no game
    return []
  }
}

function write(notes: TurnNote[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(notes))
  } catch {
    /* storage is unusable; play continues, the log doesn't */
  }
}

/** Oldest first, which is the order a trend is read in. */
export function allNotes(): TurnNote[] {
  return read().sort((a, b) => a.at - b.at)
}

export function notesFor(gameId: string): TurnNote[] {
  return allNotes().filter((n) => n.gameId === gameId)
}

export function noteAt(gameId: string, player: PlayerId, turn: number): TurnNote | null {
  return read().find((n) => n.gameId === gameId && n.player === player && n.turn === turn) ?? null
}

/** Insert or replace: one note per seat per turn, so a rewritten plan overwrites. */
export function saveNote(note: Omit<TurnNote, 'schema' | 'at'>): void {
  const full: TurnNote = { ...note, schema: SCHEMA, at: Date.now() }
  const rest = read().filter(
    (n) => !(n.gameId === full.gameId && n.player === full.player && n.turn === full.turn),
  )
  write([...rest, full].sort((a, b) => a.at - b.at).slice(-MAX_NOTES))
}

export function clearNotes(): void {
  write([])
}
