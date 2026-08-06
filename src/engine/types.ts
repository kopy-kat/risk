import type { TerritoryId } from './board'

export type PlayerId = number

export type Phase =
  /** initial placement — everyone drops one army at a time, in turn order */
  | 'setup'
  | 'deploy'
  | 'attack'
  /** a battle was won; the attacker must choose how many armies advance */
  | 'occupy'
  | 'fortify'
  | 'gameOver'

export type CardSuit = 'infantry' | 'cavalry' | 'artillery' | 'wild'

export interface Card {
  id: number
  suit: CardSuit
  /** null for the two wilds */
  territory: TerritoryId | null
}

export interface Player {
  id: PlayerId
  name: string
  /** index into the six-colour palette */
  color: number
  /** bot registry key, or null for a human seat */
  bot: string | null
  alive: boolean
  cards: Card[]
  /** armies still to place during initial setup */
  reserve: number
}

export interface BattleResult {
  from: TerritoryId
  to: TerritoryId
  attackerDice: number[]
  defenderDice: number[]
  attackerLoss: number
  defenderLoss: number
  captured: boolean
}

/**
 * Set after a capture. The attacker's dice count has *already* advanced into the
 * captured territory (so no territory is ever left holding zero armies); this
 * tracks how many *additional* armies may follow.
 */
/** Summary of a blitz — many rounds resolved as one move. */
export interface BlitzResult {
  from: TerritoryId
  to: TerritoryId
  rounds: number
  attackerLoss: number
  defenderLoss: number
  captured: boolean
}

export interface PendingOccupation {
  from: TerritoryId
  to: TerritoryId
  /** armies already moved in as part of the capture */
  moved: number
  min: number
  max: number
}

export interface LogEntry {
  turn: number
  player: PlayerId | null
  text: string
  /**
   * Consecutive entries sharing a key collapse into one line — six rolls against
   * the same territory read as one assault, not six.
   */
  key?: string
  /** running totals behind a collapsed line, so it can be rewritten as it grows */
  tally?: { rounds: number; attackerLoss: number; defenderLoss: number }
  /** who lost ground here — lets an agent remember who hit it, without parsing text */
  victim?: PlayerId
}

export interface GameState {
  players: Player[]
  owner: Record<TerritoryId, PlayerId>
  troops: Record<TerritoryId, number>
  phase: Phase
  current: PlayerId
  turn: number
  /** armies in hand during the deploy phase */
  toDeploy: number
  deck: Card[]
  discard: Card[]
  setsTraded: number
  /** drives the end-of-turn card award */
  conqueredThisTurn: boolean
  /** set to false once a fortify has been made this turn */
  canFortify: boolean
  pendingOccupation: PendingOccupation | null
  lastBattle: BattleResult | null
  /** set alongside lastBattle when the attack was a blitz, cleared otherwise */
  lastBlitz: BlitzResult | null
  log: LogEntry[]
  /**
   * Every move applied so far, in order. Together with the seed this *is* the
   * game: `createGame` plus this list replays it exactly, dice included, because
   * the generator state lives in here too.
   *
   * It lives in the state rather than beside it so undo stays correct for free —
   * undo restores an earlier state, which carries the earlier move list. A list
   * held next to the state would have to be rewound in lockstep, and wouldn't be.
   *
   * `clone` copies it, so `applyMove` is O(moves so far). Measured: 9.3 µs per
   * move on an empty list against 21.8 µs at eight thousand moves, which is
   * nothing across a real game (a long one is ~700 moves) and shows up only in
   * the soak test's stalled outliers. Worth it for a record that can't drift out
   * of step with the undo stack.
   */
  moves: Move[]
  rngState: number
  winner: PlayerId | null
}

export type Move =
  | { type: 'placeInitial'; territory: TerritoryId }
  | { type: 'tradeCards'; cards: number[] }
  | { type: 'deploy'; territory: TerritoryId; count: number }
  | { type: 'attack'; from: TerritoryId; to: TerritoryId; dice: number }
  /** roll repeatedly at full odds until the territory falls or the attack runs dry */
  | { type: 'blitz'; from: TerritoryId; to: TerritoryId }
  | { type: 'occupy'; count: number }
  | { type: 'endAttack' }
  | { type: 'fortify'; from: TerritoryId; to: TerritoryId; count: number }
  | { type: 'endTurn' }
