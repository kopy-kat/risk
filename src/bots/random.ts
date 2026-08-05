import { legalMoves } from '../engine/game'
import type { Bot } from './types'

/** Uniform over legal moves. The floor any other bot should beat. */
export const randomBot: Bot = {
  key: 'random',
  name: 'Coin-flip',
  blurb: 'Picks a legal move at random',
  decide(state, _me, rand) {
    const moves = legalMoves(state)
    return moves[Math.floor(rand() * moves.length)]
  },
}
