import type { GameDef } from '../types'
import { KESSEL_BOTS } from './bot'
import { RULES_VERSION, applyMove, createGame, legalMoves, view } from './game'
import type { KesselOptions } from './game'
import { MISSIONS } from './missions'
import type { KesselState, Move } from './types'

export const kessel: GameDef<KesselState, Move> = {
  key: 'kessel',
  name: 'Kessel',
  blurb: 'Historical battles, one at a time. Cut the supply, break the cohesion, close the ring.',
  rulesVersion: RULES_VERSION,
  create: (opts) => createGame(opts as KesselOptions),
  apply: applyMove,
  legalMoves,
  view,
  bots: KESSEL_BOTS,
  scenarios: MISSIONS.map((m) => m.id),
}

export type { KesselState, Move }
