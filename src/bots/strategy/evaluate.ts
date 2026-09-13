/**
 * Position evaluation — scoring a whole board rather than a single target.
 *
 * Colonel gets by on per-target heuristics. Anything that wants to compare plans
 * ("is breaking their Africa worth more than finishing my Europe?") needs one
 * number for a position, and it has to be in comparable units. Everything here is
 * denominated in **armies**, with per-turn income converted at `INCOME_HORIZON`.
 */
import { ADJACENCY, CONTINENTS, TERRITORY_IDS } from '../../engine/board'
import type { TerritoryId } from '../../engine/board'
import { cashValue, findSets } from '../../engine/cards'
import { HAND_LIMIT, continentsHeldBy, territoriesOf } from '../../engine/game'
import type { GameState, PlayerId } from '../../engine/types'
import { incomeOf } from './board-sense'

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
 *
 * Takes the counts rather than the board because `assess` has already walked it.
 */
const smoothIncome = (territories: number, bonus: number): number => territories / 3 + bonus

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
export const exposure = (s: GameState, p: PlayerId): number =>
  exposureOver(s, p, territoriesOf(s, p), Infinity).total

/** Exposure both ways: as it stands, and with each territory's share bounded. */
interface Exposed {
  total: number
  /** `total` with no territory contributing more than the cap — see `assess` */
  capped: number
}

/**
 * `exposure` over holdings the caller already has, so `assess` walks once.
 *
 * Being a border and the pressure on it are the same scan — a border *is* a
 * territory with an enemy neighbour — so they're read together rather than by
 * calling `isBorder` and then `pressure` over the same list twice.
 */
function exposureOver(s: GameState, p: PlayerId, mine: TerritoryId[], cap: number): Exposed {
  let total = 0
  let capped = 0
  for (const t of mine) {
    let enemies = 0
    let bearing = 0
    for (const n of ADJACENCY[t]) {
      if (s.owner[n] === p) continue
      enemies++
      bearing += s.troops[n]
    }
    if (!enemies) continue
    const want = bearing * 0.6
    if (want > s.troops[t]) {
      const short = want - s.troops[t]
      total += short
      capped += Math.min(short, cap)
    }
  }
  return { total, capped }
}

export interface Assessment {
  territories: number
  armies: number
  income: number
  cards: number
  handValue: number
  exposure: number
  /**
   * `exposure` with each territory's shortfall bounded by the `exposureCap`
   * argument, which defaults to no bound at all. Only the reviewer passes one, and
   * only the reviewer reads this — the reason and the number are both in
   * `src/review/price.ts`.
   */
  cappedExposure: number
  /** everything above, folded into one number in army units */
  score: number
}

/**
 * Every term computed exactly once.
 *
 * This is the innermost call of every rollout the reviewer does — hundreds of
 * thousands of times for one game — so the spelling that reads best is not
 * affordable: naming `handValue`, `exposure` and the income pair in both the
 * fields and the score walks the board seven times for four distinct answers.
 */
export function assess(s: GameState, p: PlayerId, exposureCap = Infinity): Assessment {
  const mine = territoriesOf(s, p)
  let armies = 0
  for (const t of mine) armies += s.troops[t]
  let bonus = 0
  for (const c of continentsHeldBy(s, p)) bonus += CONTINENTS[c].bonus
  const hand = handValue(s, p)
  const exposed = exposureOver(s, p, mine, exposureCap)
  return {
    territories: mine.length,
    armies,
    income: Math.max(3, Math.floor(mine.length / 3)) + bonus,
    cards: s.players[p].cards.length,
    handValue: hand,
    exposure: exposed.total,
    cappedExposure: exposed.capped,
    // exposure is discounted: defending every border is never actually correct
    score:
      smoothIncome(mine.length, bonus) * INCOME_HORIZON +
      armies * ARMY_WEIGHT +
      hand -
      exposed.total * EXPOSURE_WEIGHT,
  }
}

/** Ground income of everyone still alive — what the whole map pays per turn. */
export function tableIncome(s: GameState): number {
  return s.players.filter((p) => p.alive).reduce((n, p) => n + incomeOf(s, p.id), 0)
}

/**
 * True once the next set is worth more than everything the table's ground pays.
 * Past this point the game's economy has left the map: holding territory decides
 * who is ahead *this* turn, but the cash-in ladder decides who wins. The recorded
 * human games all turn on this line being crossed unnoticed — see BOTS.md.
 */
export const setsDominate = (s: GameState): boolean => cashValue(s.setsTraded) >= tableIncome(s)

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
export function killableRival(s: GameState, me: PlayerId, reach = 2.2, extra = 0): Rival | null {
  const mine = territoriesOf(s, me)
  for (const r of rivals(s, me)) {
    const theirs = territoriesOf(s, r.id)
    // A sweep of more than a handful of territories in one turn is fantasy — but
    // the ceiling scales with the prize. A three-card hand under an escalating
    // sequence is routinely worth more than the ground being crossed to take it,
    // and the recorded human games were lost to players holding six to eight
    // tiles whom this cap declared unkillable on principle.
    const cap = r.cards >= 3 ? 8 : 5
    if (!theirs.length || theirs.length > cap) continue
    const defence = theirs.reduce((n, t) => n + s.troops[t], 0)
    const theirSet = new Set(theirs)
    // `extra` is force in hand rather than on the board — armies mid-deploy, or a
    // set about to be cashed. Counting it is what lets a bot see the kill *before*
    // trading, which is the trade the recorded human games are built on: cash,
    // land it on the right border, take the hand.
    const force =
      extra +
      mine
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
 * How much a rival's position reads as the set-race strategy: one dominant
 * stack, little ground, and a hand that keeps growing. All of it is public, and
 * none of it needs history — the signature *is* the position, which keeps
 * agents pure functions of state.
 *
 * Gated on a real hand first: without cards there is no race being run, however
 * compact the position — a camper is concentrated and small too, and attacking
 * a camper's fortress is a measured mistake.
 */
export function sharkLikeness(s: GameState, p: PlayerId): number {
  const cards = s.players[p].cards.length
  if (cards < 2) return 0
  const theirs = territoriesOf(s, p)
  if (!theirs.length) return 0
  let armies = 0
  let biggest = 0
  for (const t of theirs) {
    armies += s.troops[t]
    biggest = Math.max(biggest, s.troops[t])
  }
  const concentration = biggest / Math.max(1, armies)
  const compact = 1 - Math.min(1, theirs.length / 12)
  const hand = Math.min(1, cards / HAND_LIMIT)
  return concentration * 0.45 + compact * 0.25 + hand * 0.3
}

/**
 * The set-racer worth reacting to before the bank pact can fire — the pact
 * needs the escalation to already outweigh the map, and a racer noticed only
 * then has already banked the win. Profiling reads the signature earlier.
 */
export function profiledShark(s: GameState, me: PlayerId): { id: PlayerId; likeness: number } | null {
  let best: { id: PlayerId; likeness: number } | null = null
  for (const q of s.players) {
    if (!q.alive || q.id === me) continue
    const likeness = sharkLikeness(s, q.id)
    if (likeness >= 0.6 && (!best || likeness > best.likeness)) best = { id: q.id, likeness }
  }
  return best
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
  /**
   * Fired by the bank path rather than the ground path: the target is winning the
   * set race, not the map. Consumers that mass armies key off this — the ground
   * pile-on was measured win-rate neutral as pure target redirection, and gets to
   * keep the behaviour it was measured with.
   */
  bank: boolean
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
  const ground = groundLeader(s, live)
  const picked = ground ?? bankLeader(s, live)
  if (!picked) return null
  const { leader, lead } = picked
  const theirs = territoriesOf(s, leader)
  const mine = new Set<TerritoryId>(territoriesOf(s, me))
  const joined = s.log.some(
    (e) =>
      s.turn - e.turn <= 2 &&
      // somebody else is already taking ground off them...
      ((e.victim === leader && e.player !== null && e.player !== me && e.player !== leader) ||
        // ...or they came for us, in which case hitting back *is* joining
        (e.victim === me && e.player === leader)),
  )
  return {
    target: leader,
    lead,
    againstMe: leader === me,
    canReach: leader !== me && theirs.some((t) => ADJACENCY[t].some((n) => mine.has(n))),
    joined,
    bank: !ground,
  }
}

/** The classic pile-on: someone's *ground* has grown past the point of no return. */
function groundLeader(
  s: GameState,
  live: GameState['players'],
): { leader: PlayerId; lead: number } | null {
  const scored = live
    .map((p) => ({ id: p.id, score: assess(s, p.id).score }))
    .sort((a, b) => b.score - a.score)
  const [leader, runnerUp] = scored
  const lead = leader.score / Math.max(1, runnerUp.score)
  if (lead < GANG_UP_LEAD) return null
  if (territoriesOf(s, leader.id).length / TERRITORY_IDS.length < GANG_UP_SHARE) return null
  return { leader: leader.id, lead }
}

/**
 * The pile-on the recorded human games say the tiers were missing: once the
 * cash-in sequence outweighs the whole map's income, the table's real leader is
 * whoever holds the biggest bank-plus-army total, however little ground they
 * hold. The 45% board-share gate is the right test for a ground leader and
 * exactly the wrong one here — a set-racer wins from eight tiles.
 *
 * The `cards >= 3` requirement is what keeps this from decaying into "attack
 * whoever is nominally ahead" (the standing-policy failure that cost 8 points):
 * without a bank there is no race being won, and the ground path's share gate
 * still applies.
 */
function bankLeader(
  s: GameState,
  live: GameState['players'],
): { leader: PlayerId; lead: number } | null {
  if (!setsDominate(s)) return null
  const scored = live
    .map((p) => ({
      id: p.id,
      cards: p.cards.length,
      v:
        territoriesOf(s, p.id).reduce((n, t) => n + s.troops[t], 0) +
        handValue(s, p.id) +
        (p.cards.length >= HAND_LIMIT - 1 ? cashValue(s.setsTraded) * 0.5 : 0),
    }))
    .sort((a, b) => b.v - a.v)
  const [leader, runnerUp] = scored
  if (leader.cards < 3) return null
  const lead = leader.v / Math.max(1, runnerUp.v)
  if (lead < GANG_UP_LEAD) return null
  return { leader: leader.id, lead }
}
