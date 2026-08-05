import { applyMove, legalMoves } from '../engine/game'
import type { GameState } from '../engine/types'
import type { Bot } from './types'

/**
 * Advance the game by one bot decision. A bot that returns an illegal move (or
 * throws) falls back to a random legal one, so an experimental agent can never
 * wedge a game — it just plays badly.
 */
export function stepBot(state: GameState, bot: Bot, rand: () => number): GameState {
  try {
    return applyMove(state, bot.decide(state, state.current, rand))
  } catch {
    const moves = legalMoves(state)
    if (!moves.length) throw new Error(`no legal moves in phase ${state.phase}`)
    return applyMove(state, moves[Math.floor(rand() * moves.length)])
  }
}
