import europe from '../../../data/maps/europe.json'
import type { GameDef } from '../types'
import { KESSEL_BOTS } from './bot'
import { RULES_VERSION, applyMove, createGame, legalMoves, view } from './game'
import { registerMap } from './map'
import type { MapData } from './map'
import type { KesselState, Move } from './types'

export const EUROPE = registerMap(europe as unknown as MapData)

export const kessel: GameDef<KesselState, Move> = {
  key: 'kessel',
  name: 'Kessel',
  blurb: 'Operational war in Europe. Cut the supply, break the cohesion, close the ring.',
  rulesVersion: `${RULES_VERSION}|map:${EUROPE.id}:${EUROPE.provinces.length}`,
  create: (opts) => createGame(opts),
  apply: applyMove,
  legalMoves,
  view,
  bots: KESSEL_BOTS,
}

export type { KesselState, Move }
