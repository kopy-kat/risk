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

/**
 * Weights on the non-income terms.
 *
 * Armies are a *means*, not an end: counting them 1:1 against income made the
 * evaluation treat every trade of armies for ground as a loss. Measured on 2,309
 * clearly-favourable captures (>= 70% win probability), 58% scored *negative* —
 * which is why both attempts at a position lookahead talked the bot out of
 * attacking. Exposure had the same problem from the other side, since every
 * capture creates a fresh under-garrisoned border.
 */
export const ARMY_WEIGHT = 0.5
export const EXPOSURE_WEIGHT = 0.25

/**
 * Territory income *without* the floor, for scoring only.
 *
 * Real income is `floor(territories / 3)`, which means two captures in three
 * change it by nothing at all. As an optimisation target that step function is
 * hopeless — most individual captures look worthless, so anything scoring moves by
 * position learns not to attack. The marginal value of a territory is a third of an
 * army per turn, and that is what a smooth objective should see.
 */
function smoothIncome(s: GameState, p: PlayerId): number {
  const base = territoriesOf(s, p).length / 3
  const bonus = incomeOf(s, p) - Math.max(3, Math.floor(territoriesOf(s, p).length / 3))
  return base + bonus
}

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
      smoothIncome(s, p) * INCOME_HORIZON +
      armies * ARMY_WEIGHT +
      handValue(s, p) -
      exposure(s, p) * EXPOSURE_WEIGHT,
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

/**
 * A rival we could plausibly wipe out this turn, taking their whole hand with them.
 *
 * Elimination is the biggest single swing in Risk: their cards become ours, and
 * with an escalating cash-in a captured hand is often worth more than the
 * territory. The estimate is deliberately rough — it compares total defence
 * against the force we have adjacent — because the real check is whether the
 * attacks actually succeed, and the bot finds that out by trying.
 */
export function killableRival(s: GameState, me: PlayerId, reach = 2.2): Rival | null {
  const mine = territoriesOf(s, me)
  for (const r of rivals(s, me)) {
    const theirs = territoriesOf(s, r.id)
    // a sweep of more than a handful of territories in one turn is fantasy
    if (!theirs.length || theirs.length > 5) continue
    const defence = theirs.reduce((n, t) => n + s.troops[t], 0)
    const theirSet = new Set(theirs)
    const force = mine
      .filter((t) => ADJACENCY[t].some((n) => theirSet.has(n)))
      .reduce((n, t) => n + Math.max(0, s.troops[t] - 1), 0)
    if (force > defence * reach) return r
  }
  return null
}

/** The rival most worth hurting: strong, and close enough to matter. */
export function primaryThreat(s: GameState, me: PlayerId): Rival | null {
  const rs = rivals(s, me)
  if (!rs.length) return null
  const weight = (x: Rival) => x.score * (x.adjacent ? 1 : 0.55)
  return rs.reduce((best, r) => (weight(r) > weight(best) ? r : best))
}
