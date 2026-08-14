import type { PlayerId } from '../../engine/types'
import type { ProvinceId } from './map'

export type FormationId = number

export type UnitType = 'infantry' | 'armour' | 'recon'

/**
 * A corps. Strength is what it has, cohesion is what it can use today — splitting
 * them is what makes maneuver something other than faster attrition, because a
 * formation pushed off a province twice is still at full strength and can no
 * longer attack.
 */
export interface Formation {
  id: FormationId
  owner: PlayerId
  type: UnitType
  at: ProvinceId
  /** steps, 1–4. Lost slowly, and mostly to encirclement. */
  strength: number
  /** 0–100. Spent by fighting, regained in supply. */
  cohesion: number
  /**
   * Damage taken since the last step loss. Every 100 costs a step, with no roll —
   * attrition is meant to be predictable so that encirclement is the only fast way
   * to destroy an army.
   */
  wear: number
  /** turns spent holding, capped — feeds the defence multiplier */
  dug: number
  /** last resolved supply state, 0–3. Recomputed at the start of every turn. */
  supply: number
}

export type Order =
  | { type: 'hold' }
  | { type: 'move'; to: ProvinceId }
  | { type: 'attack'; to: ProvinceId }
  /** trade the turn for cohesion — the deliberate choice to stop attacking */
  | { type: 'refit' }

export type Phase = 'orders' | 'resolve' | 'terms' | 'gameOver'

export interface Side {
  id: PlayerId
  name: string
  color: number
  bot: string | null
  alive: boolean
  /**
   * 0–100. Falls with formations and objectives lost, rises with objectives
   * taken, and decays every turn regardless. Below `willFloor` the side must
   * offer terms, which is what stops the last third of a game being a grind.
   */
  will: number
  /** provinces this side is fighting for; scored at the peace, not at conquest */
  aims: ProvinceId[]
}

export interface KesselState {
  /** which map this game is on — looked up rather than imported, so scenarios can ship their own */
  mapId: string
  sides: Side[]
  owner: Record<ProvinceId, PlayerId>
  formations: Formation[]
  /** orders staged this turn, cleared on resolve */
  orders: Record<FormationId, Order>
  phase: Phase
  current: PlayerId
  turn: number
  log: LogEntry[]
  moves: Move[]
  record: boolean
  rngState: number
  winner: PlayerId | null
  nextFormationId: FormationId
}

export interface LogEntry {
  turn: number
  player: PlayerId | null
  text: string
  key?: string
}

export type Move =
  | { type: 'order'; formation: FormationId; order: Order }
  | { type: 'clearOrder'; formation: FormationId }
  /** resolve every staged order at once — the one button that ends a turn */
  | { type: 'commit' }
  | { type: 'offerTerms' }
  | { type: 'acceptTerms' }
  | { type: 'rejectTerms' }
