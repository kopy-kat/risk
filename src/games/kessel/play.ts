import type { PlayerId } from '../../engine/types'
import type { GameBot } from '../types'
import { applyMove, legalMoves } from './game'
import type { KesselState, Move } from './types'

/** Counts of bots that returned something illegal, keyed by bot. */
export const fallbacks: Record<string, number> = {}

/**
 * Advance the war by one bot decision, with the same bargain Risk's loop makes: a
 * bot that returns an illegal move falls back to a random legal one, so a
 * half-finished agent plays badly rather than wedging a run — and every fallback
 * is counted, because silently playing at random would otherwise look like a bot
 * that merely loses.
 */
export function stepBot(
  state: KesselState,
  bot: GameBot<KesselState, Move>,
  rand: () => number,
  opts: { strict?: boolean } = {},
): KesselState {
  const me = state.current as PlayerId
  try {
    return applyMove(state, bot.decide(state, me, rand))
  } catch (e) {
    fallbacks[bot.key] = (fallbacks[bot.key] ?? 0) + 1
    if (opts.strict) {
      throw new Error(
        `${bot.key} produced an illegal move in phase ${state.phase}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    const moves = legalMoves(state, me)
    if (!moves.length) throw new Error(`no legal moves in phase ${state.phase}`)
    return applyMove(state, moves[Math.floor(rand() * moves.length)])
  }
}

export const resetFallbacks = () => {
  for (const k of Object.keys(fallbacks)) delete fallbacks[k]
}
