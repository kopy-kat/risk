import type { PlayerId, SeatConfig } from '../engine/types'

/**
 * The slice of any game's state the harness reads without knowing its rules.
 * Store, replay, bench, the parallel workers and the exploitability search all
 * work off this and nothing else, which is what lets a second game reuse them.
 */
export interface GameView {
  current: PlayerId
  turn: number
  winner: PlayerId | null
  over: boolean
  players: { id: PlayerId; name: string; bot: string | null; alive: boolean }[]
  /**
   * Each seat's share of the win condition, 0–1, summing to 1. Territory count in
   * Risk, war aims met in Kessel. The benchmark and the exploitability search
   * report on this, so a game only has to say what "ahead" means once.
   */
  standing: number[]
}

export interface GameBot<S, M> {
  key: string
  name: string
  blurb: string
  /** `rand` is supplied so decisions stay reproducible — never Math.random. */
  decide(state: S, me: PlayerId, rand: () => number): M
}

export interface CreateOptions {
  seats: SeatConfig[]
  seed?: number
  record?: boolean
  /** a scenario the game ships, by id, in place of its default setup */
  scenario?: string
  /** how much harder the scenario is set, where the game has such a thing */
  level?: number
}

/**
 * One game's rules, as everything outside it needs them.
 *
 * `create` plus a move list must reproduce a game exactly, generator state
 * included — that requirement is what makes saving, undo, replay and review a
 * single mechanism rather than four.
 */
export interface GameDef<S, M> {
  key: string
  name: string
  blurb: string
  /**
   * Bumped when a rules change would desync an existing move list. Stored with
   * every record; a mismatch makes the record unreplayable rather than replaying
   * it into a board that looks plausible and never happened.
   */
  rulesVersion: string
  create(opts: CreateOptions): S
  apply(s: S, m: M): S
  legalMoves(s: S, p: PlayerId): M[]
  view(s: S): GameView
  bots: GameBot<S, M>[]
  /** the scenarios it can set up, by id — a record of one it no longer has cannot be replayed */
  scenarios?: string[]
}
