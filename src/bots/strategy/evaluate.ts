/**
 * Position evaluation — scoring a whole board rather than a single target.
 *
 * Colonel gets by on per-target heuristics. Anything that wants to compare plans
 * ("is breaking their Africa worth more than finishing my Europe?") needs one
 * number for a position, and it has to be in comparable units. Everything here is
 * denominated in **armies**, with per-turn income converted at `INCOME_HORIZON`.
 */
import { ADJACENCY, TERRITORY_IDS } from '../../engine/board'
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

/**
 * How far clear of the **runner-up** the leader has to be before the table turns.
 *
 * Against the runner-up, deliberately, not against the average of the field. The
 * average version reads as a coalition and behaves as a standing policy of
 * attacking whoever is nominally ahead: eliminations and ground-down players drag
 * the mean down, so the ratio only ever climbs. Measured, it was live on 83% of
 * turns at a mean 2.64x — which is lookahead attempt 1 from BOTS.md wearing a
 * different hat, and it cost General 8 points at four seats.
 */
export const GANG_UP_LEAD = 1.4

/**
 * ...and how much of the board the leader must hold for the lead to be worth
 * answering.
 *
 * Set high on purpose. Cutting the leader down is a public good — it costs you
 * armies and relieves everyone still standing — so at 30% of the board the correct
 * individual play is to free-ride, and a bot that goes in anyway just loses. Near
 * half the map that inverts: nobody who lets the leader through wins at all, so
 * joining stops being generous and starts being survival. Which is also when a
 * human table actually turns, rather than when someone merely edges ahead.
 */
export const GANG_UP_SHARE = 0.45

export interface Coalition {
  /** who the table should be hitting */
  target: PlayerId
  /** the leader's score as a multiple of the runner-up's */
  lead: number
  /** the coalition is against *us* — three people want our ground */
  againstMe: boolean
  /** whether we share a border with the target, so we can actually join in */
  canReach: boolean
  /**
   * Whether it's *our* fight yet. Cutting the leader down relieves everyone still
   * standing, so going first is a gift to the bystanders — measured at −6 points at
   * four seats when every General did it unprompted. So a bot joins only once the
   * pile-on exists, or once the leader has come for it. Both mean the armies are
   * already committed, which is what makes joining rational rather than generous —
   * and it's how a real table works: the leader's victims start it, everyone else
   * piles on afterwards.
   */
  joined: boolean
}

/**
 * Whether the table should be ganging up, and on whom.
 *
 * Human games are decided by this as much as by any tactic: the moment somebody is
 * clearly winning, everyone else stops fighting each other and turns on them, and
 * the truce dissolves the moment the leader is back in the pack. None of it needs
 * negotiating — the position is public, so every player reads the same board and
 * reaches the same conclusion independently, which is exactly what a bot can do.
 *
 * Nothing here applies to a duel: with one opponent, "gang up on the leader" and
 * "play the game" are the same sentence.
 */
export function coalition(s: GameState, me: PlayerId): Coalition | null {
  const live = s.players.filter((p) => p.alive)
  if (live.length < 3) return null
  const scored = live
    .map((p) => ({ id: p.id, score: assess(s, p.id).score }))
    .sort((a, b) => b.score - a.score)
  const [leader, runnerUp] = scored
  const lead = leader.score / Math.max(1, runnerUp.score)
  if (lead < GANG_UP_LEAD) return null
  const theirs = territoriesOf(s, leader.id)
  if (theirs.length / TERRITORY_IDS.length < GANG_UP_SHARE) return null
  const mine = new Set<TerritoryId>(territoriesOf(s, me))
  const joined = s.log.some(
    (e) =>
      s.turn - e.turn <= 2 &&
      // somebody else is already taking ground off them...
      ((e.victim === leader.id && e.player !== null && e.player !== me && e.player !== leader.id) ||
        // ...or they came for us, in which case hitting back *is* joining
        (e.victim === me && e.player === leader.id)),
  )
  return {
    target: leader.id,
    lead,
    againstMe: leader.id === me,
    canReach: leader.id !== me && theirs.some((t) => ADJACENCY[t].some((n) => mine.has(n))),
    joined,
  }
}
