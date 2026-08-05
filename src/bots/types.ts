import type { GameState, Move, PlayerId } from '../engine/types'

/**
 * Everything a bot is allowed to see and do. `rand` is supplied by the caller so
 * bot decisions stay reproducible for a given seed — never use Math.random here.
 *
 * A bot returns one legal Move. If it returns something illegal the game loop
 * falls back to a random legal move rather than crashing, so a half-finished
 * experimental bot can't wedge a game.
 */
export interface Bot {
  key: string
  name: string
  blurb: string
  decide(state: GameState, me: PlayerId, rand: () => number): Move
}
