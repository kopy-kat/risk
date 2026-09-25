import europe from '../../../data/maps/europe.json'
import type { GameDef } from '../types'
import { KESSEL_BOTS } from './bot'
import { RULES_VERSION, applyMove, createGame, legalMoves, view } from './game'
import { registerMap } from './map'
import { MISSIONS } from './missions'
import type { MapData } from './map'
import type { KesselState, Move } from './types'

export const EUROPE = registerMap(europe as unknown as MapData)

export const kessel: GameDef<KesselState, Move> = {
  key: 'kessel',
  name: 'Kessel',
  blurb: 'Historical battles, one at a time. Cut the supply, break the cohesion, close the ring.',
  rulesVersion: `${RULES_VERSION}|map:${EUROPE.id}:${EUROPE.provinces.length}`,
  create: (opts) => createGame(opts),
  apply: applyMove,
  legalMoves,
  view,
  bots: KESSEL_BOTS,
  scenarios: MISSIONS.map((m) => m.id),
}

export type { KesselState, Move }
