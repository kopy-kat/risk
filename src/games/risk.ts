import { BOTS } from '../bots'
import { TERRITORY_IDS } from '../engine/board'
import { RULES_VERSION, applyMove, createGame, legalMoves, territoriesOf } from '../engine/game'
import type { GameState, Move } from '../engine/types'
import type { GameDef, GameView } from './types'

const view = (s: GameState): GameView => {
  const held = s.players.map((p) => territoriesOf(s, p.id).length)
  return {
    current: s.current,
    turn: s.turn,
    winner: s.winner,
    over: s.phase === 'gameOver',
    players: s.players.map((p) => ({ id: p.id, name: p.name, bot: p.bot, alive: p.alive })),
    standing: held.map((n) => n / TERRITORY_IDS.length),
  }
}

export const risk: GameDef<GameState, Move> = {
  key: 'risk',
  name: 'Risk',
  blurb: 'The classic board. Dice, continents, and cards that outgrow the map.',
  rulesVersion: RULES_VERSION,
  create: createGame,
  apply: applyMove,
  // The engine derives whose turn it is from the state, so a request for anyone
  // else's moves is a question about a position that cannot arise.
  legalMoves: (s, p) => (s.current === p ? legalMoves(s) : []),
  view,
  bots: BOTS,
}
