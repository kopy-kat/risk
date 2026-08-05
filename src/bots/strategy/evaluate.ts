/**
 * Position evaluation — scoring a whole board rather than a single target.
 *
 * Colonel gets by on per-target heuristics. Anything that wants to compare plans
 * ("is breaking their Africa worth more than finishing my Europe?") needs one
 * number for a position, and it has to be in comparable units. Everything here is
 * denominated in **armies**, with per-turn income converted at `INCOME_HORIZON`.
 */
import { ADJACENCY } from '../../engine/board'
import type { TerritoryId } from '../../engine/board'
import { cashValue, findSets } from '../../engine/cards'
import { HAND_LIMIT, territoriesOf } from '../../engine/game'
import type { GameState, PlayerId } from '../../engine/types'
import { incomeOf, isBorder, pressure } from './board-sense'

/**
 * How many turns of income an army is worth. Risk games run 15–40 turns and income
 * compounds, so a short horizon under-rates it; this is the knob that decides how
 * greedy expansion looks.
 */
export const INCOME_HORIZON = 6

/** Expected armies sitting in a hand, including partial progress toward a set. */
export function handValue(s: GameState, p: PlayerId): number {
  const cards = s.players[p].cards
  if (!cards.length) return 0
  const next = cashValue(s.setsTraded)
  if (findSets(cards).length) return next
  return (cards.length / 3) * next * 0.6
}

/**
 * Armies we'd need to add to feel safe everywhere. High exposure means the
 * position looks bigger than it is — the classic overextended sprawl.
 */
export function exposure(s: GameState, p: PlayerId): number {
  let need = 0
  for (const t of territoriesOf(s, p)) {
    if (!isBorder(s, p, t)) continue
    const want = pressure(s, p, t) * 0.6
    if (want > s.troops[t]) need += want - s.troops[t]
  }
  return need
}

export interface Assessment {
  territories: number
  armies: number
  income: number
  cards: number
  handValue: number
  exposure: number
  /** everything above, folded into one number in army units */
  score: number
}

export function assess(s: GameState, p: PlayerId): Assessment {
  const mine = territoriesOf(s, p)
  const armies = mine.reduce((n, t) => n + s.troops[t], 0)
  return {
    territories: mine.length,
    armies,
    income: incomeOf(s, p),
    cards: s.players[p].cards.length,
    handValue: handValue(s, p),
    exposure: exposure(s, p),
    // exposure is discounted: defending every border is never actually correct
    score:
      incomeOf(s, p) * INCOME_HORIZON + armies + handValue(s, p) - exposure(s, p) * 0.5,
  }
}

/** Our score minus the strongest rival's — negative means we're behind. */
export function relativeStanding(s: GameState, me: PlayerId): number {
  let best = 0
  for (const p of s.players) {
    if (p.id === me || !p.alive) continue
    best = Math.max(best, assess(s, p.id).score)
  }
  return assess(s, me).score - best
}

export interface Rival {
  id: PlayerId
  income: number
  cards: number
  score: number
  /** shares a border with us — a distant leader is someone else's problem */
  adjacent: boolean
  /** forced to cash soon, so expect a surge of armies */
  cashingSoon: boolean
}

/** What we know about everyone else. All of it is public information in Risk. */
export function rivals(s: GameState, me: PlayerId): Rival[] {
  const mine = new Set<TerritoryId>(territoriesOf(s, me))
  return s.players
    .filter((p) => p.alive && p.id !== me)
    .map((p) => ({
      id: p.id,
      income: incomeOf(s, p.id),
      cards: p.cards.length,
      score: assess(s, p.id).score,
      adjacent: territoriesOf(s, p.id).some((t) => ADJACENCY[t].some((n) => mine.has(n))),
      cashingSoon: p.cards.length >= HAND_LIMIT - 1,
    }))
}

/** The rival most worth hurting: strong, and close enough to matter. */
export function primaryThreat(s: GameState, me: PlayerId): Rival | null {
  const rs = rivals(s, me)
  if (!rs.length) return null
  const weight = (x: Rival) => x.score * (x.adjacent ? 1 : 0.55)
  return rs.reduce((best, r) => (weight(r) > weight(best) ? r : best))
}
