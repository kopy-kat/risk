import { ADJACENCY, CONTINENT_IDS, TERRITORIES_IN } from '../engine/board'
import type { ContinentId, TerritoryId } from '../engine/board'
import { winProb } from '../engine/combat'
import { HAND_LIMIT, attackableFrom, bestTradeIn, connectedOwn, legalMoves, suppliedOf, territoriesOf } from '../engine/game'
import type { GameState, Move, PlayerId } from '../engine/types'
import { CONTINENT_BORDERS, CONTINENT_EFFICIENCY } from './strategy/board-sense'
import type { Bot } from './types'

/**
 * The opponent pool: one crude policy family, several named points in it.
 *
 * The tiers are measured against each other and against `easy`, which answers
 * "is this stronger?" and cannot answer "is there a strategy this has no reply
 * to?". A bot only ever faces opponents that think the way it does, so a hole
 * shared by all three tiers is invisible to every pairing at once.
 *
 * These are not tiers. Nobody should have to play one, and none of them is any
 * good at Risk in general. Their whole job is to be *different* — a tier that
 * cannot beat all of them comfortably has a hole, and the hole is the finding.
 *
 * They are one parameterised policy rather than several hand-written bots so
 * that `npm run exploit` can search the same space the named points sit in. A
 * new exploit arrives as ten numbers rather than as a new file, and anything
 * the search finds above an equal share lands in `data/exploiters.json`.
 *
 * `npm run exploit -- --report` scores every named point against a tier. The
 * strongest point is `cardShark` — the strategy read out of recorded human
 * games, which forced three axes onto this space (`bankSets`, `preyFocus`,
 * `strikeScope`) and drove the card-economy work in the tiers: see "The
 * opponent pool" and "The card economy, answered" in BOTS.md.
 */
export interface Policy {
  /** armies left on each border tile before anything reaches the stack */
  garrison: number
  /** stop expanding once this many territories are held — the anti-sprawl cap */
  expandTo: number
  /** captures allowed per turn while not sweeping; 1 is "take the card and stop" */
  perTurn: number
  /** the least win probability worth attacking on */
  safeOdds: number
  /** cash a set once it pays this much, or when the hand limit forces it */
  cashAt: number
  /** the stack fires once it outnumbers every enemy army by this much */
  sweepRatio: number
  /**
   * How much of the game happens inside one continent. At 0 the policy has no
   * notion of continents at all and takes whatever is cheapest wherever it is;
   * at 1 it garrisons only that continent's chokepoints and leaves it only to
   * finish it.
   *
   * It is the only parameter that gives the family any territorial shape, and it
   * **costs** the points that use it: turning it up moved `banker` and `camper`
   * from bad to worse against Marshal. Committing to a continent means holding
   * everything outside it at one army, and a tier walks through that faster than
   * the chokepoints pay for themselves. Kept because the search needs the axis to
   * rule it out, not because it works.
   */
  homeFocus: number
  /**
   * Treat the hand as part of the army. At 1, sets are held until the hand limit
   * forces the issue (`cashAt` goes inert), and a tradeable set's value counts
   * toward the sweep trigger — the bank and the stack strike together. This is
   * the axis the original seven-dimension space could not express, and it is the
   * one the recorded human games are built on: the escalating sequence makes a
   * banked set outgrow the whole board, so the win condition is the cash-in, not
   * the ground. 0 or 1; a fraction behaves as 1.
   */
  bankSets: number
  /**
   * How strongly targets are picked for who owns them rather than what they cost.
   * At 0 the cheapest qualifying tile wins; toward 1 the policy prefers tiles
   * owned by players who are nearly dead and holding cards — elimination hunting
   * for hands, which chains: each kill's spoils force a trade that funds the next.
   */
  preyFocus: number
  /**
   * What the strike has to outweigh before it fires: the whole board at 0, only
   * the cheapest rival at 1. The recorded human games strike near 1 — kill the
   * most affordable player, let the inherited hand force a trade, and let that
   * trade decide whether the chain continues. Waiting to outweigh everyone at
   * once is `banker`, and `banker` loses.
   */
  strikeScope: number
}

/** Named points in the space. Each is a strategy a person would recognise. */
export const POLICIES: Record<string, Policy> = {
  /** Turtle in one continent, bank the surplus, cash it into one board-clearing turn. */
  banker: { garrison: 3, expandTo: 10, perTurn: 2, safeOdds: 0.8, cashAt: 20, sweepRatio: 1.5, homeFocus: 0.9, bankSets: 0, preyFocus: 0, strikeScope: 0 },
  /** Take everything that is better than a coin flip and never stop. */
  blitzer: { garrison: 1, expandTo: 42, perTurn: 42, safeOdds: 0.5, cashAt: 4, sweepRatio: 99, homeFocus: 0, bankSets: 0, preyFocus: 0, strikeScope: 0 },
  /** Hold one small continent very hard and refuse to leave it. */
  camper: { garrison: 5, expandTo: 7, perTurn: 1, safeOdds: 0.95, cashAt: 8, sweepRatio: 2.5, homeFocus: 1, bankSets: 0, preyFocus: 0, strikeScope: 0 },
  /** One territory a turn for the card, cashed the moment it is legal. */
  farmer: { garrison: 2, expandTo: 42, perTurn: 1, safeOdds: 0.85, cashAt: 4, sweepRatio: 99, homeFocus: 0, bankSets: 0, preyFocus: 0, strikeScope: 0 },
  /**
   * The strategy from the recorded human games, stated as policy numbers: one
   * capture a turn from a single walking stack, sets held until the limit forces
   * them, and a strike that fires once the bank plus the stack outweighs the
   * board — then chains eliminations for their hands, each one funding the next.
   * `cashAt` is inert under `bankSets`; it is set high to say so out loud.
   * `strikeScope` 0, measured: striking as soon as the cheapest rival was
   * affordable (0.8) cost half its win rate — the bank opened before the
   * escalation was worth the spend.
   */
  cardShark: { garrison: 1, expandTo: 42, perTurn: 1, safeOdds: 0.8, cashAt: 99, sweepRatio: 1.0, homeFocus: 0, bankSets: 1, preyFocus: 0.8, strikeScope: 0 },
}

const enemyNeighbours = (s: GameState, me: PlayerId, t: TerritoryId) =>
  ADJACENCY[t].filter((n) => s.owner[n] !== me)

const isBorder = (s: GameState, me: PlayerId, t: TerritoryId) =>
  enemyNeighbours(s, me, t).length > 0

/**
 * Where the policy is trying to live.
 *
 * Foothold first, efficiency second — the product, with no constant term, so a
 * continent it holds nothing in scores zero however cheap it is to defend.
 * Ranking by efficiency alone sends every policy to Australia from wherever the
 * deal put it, and one that commits to a continent it cannot reach garrisons a
 * door it does not own while the rest of its ground is taken off it.
 *
 * Held continents stay eligible, unlike `chooseGoal` — this answers "where do I
 * live", not "what do I take next".
 */
function homeOf(s: GameState, me: PlayerId): ContinentId {
  const score = (c: ContinentId) => {
    const inside = TERRITORIES_IN[c]
    return CONTINENT_EFFICIENCY[c] * (inside.filter((t) => s.owner[t] === me).length / inside.length)
  }
  return CONTINENT_IDS.reduce((best, c) => (score(c) > score(best) ? c : best), CONTINENT_IDS[0])
}

/** Committed enough to treat one continent as home rather than as a preference. */
const homebound = (p: Policy) => p.homeFocus >= 0.5

/** The doors we own into home — what a turtle actually has to hold. */
const doorsOf = (s: GameState, me: PlayerId): TerritoryId[] =>
  CONTINENT_BORDERS[homeOf(s, me)].filter((t) => s.owner[t] === me)

/**
 * How many armies a tile is meant to carry before anything reaches the stack.
 * Home's doors get the full figure; everything else is scaled down by focus, so
 * a committed turtle stops paying for the sprawl it can't defend anyway.
 */
function garrisonTarget(s: GameState, me: PlayerId, t: TerritoryId, p: Policy): number {
  if (!isBorder(s, me, t)) return 1
  if (!homebound(p)) return p.garrison
  const door = CONTINENT_BORDERS[homeOf(s, me)].includes(t)
  return door ? p.garrison : Math.max(1, Math.round(p.garrison * (1 - p.homeFocus)))
}

/**
 * Where the surplus goes. It has to be a border tile or the stack can neither
 * attack nor defend — armies one tile behind the front are the thing this whole
 * family exists to *not* do. A homebound policy piles on a door instead, which
 * is the same tile it would have to defend anyway.
 */
function stackOf(s: GameState, me: PlayerId, p: Policy): TerritoryId {
  const mine = territoriesOf(s, me)
  const front = mine.filter((t) => isBorder(s, me, t))
  const doors = homebound(p) ? doorsOf(s, me).filter((t) => front.includes(t)) : []
  const pool = doors.length ? doors : front.length ? front : mine
  return pool.reduce((best, t) => (s.troops[t] > s.troops[best] ? t : best), pool[0])
}

const enemyTroops = (s: GameState, me: PlayerId): number => {
  let sum = 0
  for (const t of Object.keys(s.troops) as TerritoryId[])
    if (s.owner[t] !== me) sum += s.troops[t]
  return sum
}

/** Treats the hand as armies-in-waiting. See `Policy.bankSets`. */
const banking = (p: Policy) => p.bankSets >= 0.5

/** What the hand would pay if cashed right now — the bank behind the stack. */
const bankOf = (s: GameState, me: PlayerId, p: Policy): number =>
  banking(p) ? (bestTradeIn(s, me)?.value ?? 0) : 0

/** The smallest rival army total still on the board — the most affordable kill. */
function cheapestRival(s: GameState, me: PlayerId): number {
  let least = Infinity
  for (const q of s.players) {
    if (!q.alive || q.id === me) continue
    let sum = 0
    for (const t of territoriesOf(s, q.id)) sum += s.troops[t]
    least = Math.min(least, sum)
  }
  return least === Infinity ? 0 : least
}

/**
 * Re-derived every call rather than latched, which is safe because it is
 * self-sustaining: a blitz at these odds costs the stack less than it removes
 * from the other side, so the ratio only climbs once the sweep has started.
 * A banking policy counts its tradeable set too: the strike is stack plus cash.
 * `strikeScope` slides what must be outweighed from the whole board down to the
 * cheapest rival — mid-chain the cheapest rival is the next link, so a chain
 * that can still afford its next kill keeps rolling.
 */
function sweeping(s: GameState, me: PlayerId, p: Policy): boolean {
  const all = enemyTroops(s, me)
  const need = all + p.strikeScope * (cheapestRival(s, me) - all)
  return s.troops[stackOf(s, me, p)] - 1 + bankOf(s, me, p) >= p.sweepRatio * need
}

/** Captures made this turn, read from the log so the policy stays a pure function. */
const capturesThisTurn = (s: GameState, me: PlayerId): number =>
  s.log.filter((e) => e.turn === s.turn && e.player === me && e.victim !== undefined).length

/** Every capture available, best odds first. */
function targets(s: GameState, me: PlayerId) {
  const out: Array<{ from: TerritoryId; to: TerritoryId; odds: number }> = []
  for (const from of territoriesOf(s, me))
    for (const to of attackableFrom(s, from))
      out.push({ from, to, odds: winProb(s.troops[from] - 1, s.troops[to]) })
  return out.sort((a, b) => b.odds - a.odds)
}

/**
 * How much this tile's owner is worth hunting: card-rich and nearly dead scores
 * high. In the same 0-to-~1 range as `odds`, so `preyFocus` weighs the two
 * directly against each other.
 */
function preyScore(s: GameState, t: TerritoryId): number {
  const owner = s.players[s.owner[t]]
  const held = territoriesOf(s, owner.id).length
  return (owner.cards.length / HAND_LIMIT) * 0.6 + Math.min(1, 3 / Math.max(1, held)) * 0.4
}

/** The best capture by odds plus who it hurts. At `preyFocus` 0 this is pure odds. */
function pickTarget(
  s: GameState,
  p: Policy,
  options: Array<{ from: TerritoryId; to: TerritoryId; odds: number }>,
): { from: TerritoryId; to: TerritoryId; odds: number } | null {
  if (!options.length) return null
  if (p.preyFocus <= 0) return options[0]
  return options.reduce((best, o) =>
    o.odds + p.preyFocus * preyScore(s, o.to) > best.odds + p.preyFocus * preyScore(s, best.to) ? o : best,
  )
}

export function makePolicyBot(key: string, name: string, blurb: string, p: Policy): Bot {
  return {
    key,
    name,
    blurb,

    decide(s, me, rand): Move {
      switch (s.phase) {
        /**
         * Level the border rather than towering. A tower placed in setup is a
         * tower with nothing around it, and the rest of the line gets eaten
         * before the stack is worth anything.
         */
        case 'setup': {
          const mine = territoriesOf(s, me)
          // Home *and* what touches it. Confining setup to owned home tiles alone
          // towers when the deal gave it one of them, and a tower with nothing
          // around it is the failure this family started out making.
          const inside = homebound(p) ? new Set(TERRITORIES_IN[homeOf(s, me)]) : new Set<TerritoryId>()
          const home = mine.filter((t) => inside.has(t) || ADJACENCY[t].some((n) => inside.has(n)))
          const front = mine.filter((t) => isBorder(s, me, t))
          const pool = home.length ? home : front.length ? front : mine
          return {
            type: 'placeInitial',
            territory: pool.reduce((best, t) => (s.troops[t] < s.troops[best] ? t : best), pool[0]),
          }
        }

        /**
         * Garrison first, bank the rest. The split is `garrison` rather than a
         * separate share parameter: how much the line needs already decides how
         * much is spare, and two knobs for one quantity search worse than one.
         */
        case 'deploy': {
          const trade = bestTradeIn(s, me)
          const forced = s.players[me].cards.length >= HAND_LIMIT
          // A banking policy ignores `cashAt`: the set is the war chest, and it opens
          // only when the limit forces it or the strike is on.
          const willing = banking(p) ? sweeping(s, me, p) : trade !== null && (trade.value >= p.cashAt || sweeping(s, me, p))
          if (trade && (forced || willing))
            return { type: 'tradeCards', cards: trade.cards }

          // supply mode: reinforcements can only land on supplied ground
          const supplied = s.mode === 'supply' ? suppliedOf(s, me) : null
          const thin = territoriesOf(s, me)
            .filter((t) => (!supplied || supplied.has(t)) && s.troops[t] < garrisonTarget(s, me, t, p))
            .sort((a, b) => s.troops[a] - s.troops[b])
          if (thin.length) return { type: 'deploy', territory: thin[0], count: 1 }
          let stack = stackOf(s, me, p)
          if (supplied && !supplied.has(stack))
            stack = [...supplied].reduce((a, b) => (s.troops[a] >= s.troops[b] ? a : b))
          return { type: 'deploy', territory: stack, count: s.toDeploy }
        }

        /**
         * Four gates, in order: the sweep overrides everything; otherwise the
         * anti-sprawl cap and the per-turn cap decide whether to attack at all,
         * `homeFocus` decides where, and `safeOdds` decides which.
         *
         * Home is a filter rather than a bonus. Scoring "inside home" against
         * odds means picking units for the two, and every weighting that does
         * that ends up expanding out of the continent as soon as the ground
         * outside is a little cheaper — which is the sprawl the parameter exists
         * to prevent.
         */
        case 'attack': {
          const options = targets(s, me)
          if (!options.length) return { type: 'endAttack' }

          if (sweeping(s, me, p)) {
            const stack = stackOf(s, me, p)
            const fromStack = options.filter((o) => o.from === stack)
            const pick = pickTarget(s, p, fromStack.length ? fromStack : options)!
            return { type: 'blitz', from: pick.from, to: pick.to }
          }

          if (territoriesOf(s, me).length >= p.expandTo) return { type: 'endAttack' }
          if (capturesThisTurn(s, me) >= p.perTurn) return { type: 'endAttack' }

          const inside = TERRITORIES_IN[homeOf(s, me)]
          const athome = homebound(p) ? options.filter((o) => inside.includes(o.to)) : []
          const pick = pickTarget(s, p, (athome.length ? athome : options).filter((o) => o.odds >= p.safeOdds))
          return pick ? { type: 'blitz', from: pick.from, to: pick.to } : { type: 'endAttack' }
        }

        /**
         * Sweeping, the stack travels whole. Otherwise it leaves its garrison
         * behind, because a tile emptied to one army is a tile given back next
         * turn along with the card that comes with it.
         */
        case 'occupy': {
          const occ = s.pendingOccupation!
          if (sweeping(s, me, p)) return { type: 'occupy', count: occ.max }
          const keep = Math.max(0, p.garrison - 1)
          return { type: 'occupy', count: Math.min(occ.max, Math.max(occ.min, occ.max - keep)) }
        }

        /** Rake loose armies back to the stack, down to what each tile is meant to hold. */
        case 'fortify': {
          if (!s.canFortify) return { type: 'endTurn' }
          const stack = stackOf(s, me, p)
          const reachable = connectedOwn(s, me, stack)
          const donor = territoriesOf(s, me)
            .filter((t) => t !== stack && reachable.has(t))
            .filter((t) => s.troops[t] > garrisonTarget(s, me, t, p))
            .sort((a, b) => s.troops[b] - s.troops[a])[0]
          if (!donor) return { type: 'endTurn' }
          return {
            type: 'fortify',
            from: donor,
            to: stack,
            count: s.troops[donor] - garrisonTarget(s, me, donor, p),
          }
        }

        default: {
          const moves = legalMoves(s)
          return moves[Math.floor(rand() * moves.length)]
        }
      }
    },
  }
}

export const bankerBot = makePolicyBot(
  'banker',
  'Quartermaster',
  'Banks every spare army in one stack, then cashes it into one sweep',
  POLICIES.banker,
)

export const blitzerBot = makePolicyBot(
  'blitzer',
  'Hussar',
  'Attacks anything better than a coin flip and never stops',
  POLICIES.blitzer,
)

export const camperBot = makePolicyBot(
  'camper',
  'Castellan',
  'Holds a small patch very hard and refuses to leave it',
  POLICIES.camper,
)

export const farmerBot = makePolicyBot(
  'farmer',
  'Reeve',
  'Takes one territory a turn for the card and cashes on sight',
  POLICIES.farmer,
)

export const cardSharkBot = makePolicyBot(
  'cardShark',
  'Cartomancer',
  'Farms a card a turn from one walking stack, banks sets, then cashes into a chain of eliminations',
  POLICIES.cardShark,
)

export const POOL: Bot[] = [bankerBot, blitzerBot, camperBot, farmerBot, cardSharkBot]
