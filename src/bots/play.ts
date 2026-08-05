import { applyMove, legalMoves } from '../engine/game'
import type { GameState } from '../engine/types'
import type { Bot } from './types'

/** Counts of bots that returned something illegal, keyed by bot. */
export const fallbacks: Record<string, number> = {}

/**
 * Advance the game by one bot decision. A bot that returns an illegal move (or
 * throws) falls back to a random legal one, so an experimental agent can never
 * wedge a game — it just plays badly.
 *
 * That fallback also hides bugs: a bot throwing on every turn would quietly play
 * at random and still finish games. So every fallback is counted, and `strict`
 * turns them into errors for tests and benchmarks.
 */
export function stepBot(
  state: GameState,
  bot: Bot,
  rand: () => number,
  opts: { strict?: boolean } = {},
): GameState {
  try {
    return applyMove(state, bot.decide(state, state.current, rand))
  } catch (e) {
    fallbacks[bot.key] = (fallbacks[bot.key] ?? 0) + 1
    if (opts.strict) {
      throw new Error(
        `${bot.key} produced an illegal move in phase ${state.phase}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    const moves = legalMoves(state)
    if (!moves.length) throw new Error(`no legal moves in phase ${state.phase}`)
    return applyMove(state, moves[Math.floor(rand() * moves.length)])
  }
}

export const resetFallbacks = () => {
  for (const k of Object.keys(fallbacks)) delete fallbacks[k]
}
