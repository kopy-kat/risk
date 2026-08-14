/**
 * Turning a stored game back into boards.
 *
 * This is the whole reason games are stored as move lists: `createGame` from the
 * seed, then `applyMove` down the list, and every board the game ever had comes
 * back — the same deal, the same dice, the same bot decisions. Nothing about the
 * replay is approximate.
 */
import { applyMove, createGame } from '../engine/game'
import type { GameState } from '../engine/types'
import { isReplayable } from './store'
import type { GameRecord } from './store'

export interface Replay {
  record: GameRecord
  /**
   * `states[i]` is the board *before* `record.moves[i]`, so it's the position the
   * player was actually looking at when they chose. There is one more state than
   * there are moves: the last is the final board.
   */
  states: GameState[]
  /**
   * Set when the move list stopped applying — a rules change, or a record written
   * by a newer version. The states up to that point are still valid, so a partial
   * replay is shown rather than nothing.
   */
  error: string | null
}

export function replay(record: GameRecord): Replay {
  if (!isReplayable(record)) {
    return {
      record,
      states: [],
      error: 'Played under different rules — the move list no longer applies.',
    }
  }

  const states: GameState[] = []
  let s: GameState
  try {
    s = createGame({ seats: record.seats, seed: record.seed })
  } catch (e) {
    return { record, states: [], error: message(e) }
  }

  for (const move of record.moves) {
    states.push(s)
    try {
      s = applyMove(s, move)
    } catch (e) {
      // A desync means the replay and the recording disagree about the rules.
      // Stopping here is the point: silently continuing would render a board that
      // looks plausible and never happened.
      return { record, states, error: `Replay stopped at move ${states.length}: ${message(e)}` }
    }
  }
  states.push(s)
  return { record, states, error: null }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
