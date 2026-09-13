/**
 * The shared brain. Tiers are doctrines over this one agent rather than separate
 * implementations — that's what makes them read as the same species at different
 * skill levels instead of three different opponents.
 *
 * A doctrine is a set of things the bot is allowed to think about, never a handicap —
 * see BOTS.md, which also records what each flag is worth and the longer list of
 * plausible flags that measured worse than doing nothing.
 */
import { ADJACENCY } from '../../engine/board'
import type { TerritoryId } from '../../engine/board'
import { findSets } from '../../engine/cards'
import { expectedLoss, expectedSurvivors, winProb } from '../../engine/combat'
import { HAND_LIMIT, attackableFrom, connectedOwn, legalMoves, territoriesOf } from '../../engine/game'
import type { GameState, Move, PlayerId } from '../../engine/types'
import {
  aggressorsAgainst,
  CONTINENT_BORDERS,
  borderSecurityRatio,
  breaksContinent,
  chooseGoal,
  completesContinent,
  garrisonFor,
  isBorder,
  pressure,
  stagingFor,
} from './board-sense'
import { coalition, exposure, killableRival, primaryThreat, profiledShark, rivals, setsDominate } from './evaluate'
import type { Coalition, Rival } from './evaluate'
import { selectIntent } from './plans'
import type { Intent } from './plans'
import { bestSweep } from './sweep'
import { cashValue } from '../../engine/cards'
import { CONTINENTS as CONTS } from '../../engine/board'
import type { Bot } from '../types'

export type Plan = 'expand' | 'consolidate' | 'deny' | 'cycle' | 'decapitate'

export interface Doctrine {
  key: string
  name: string
  blurb: string
  /** won't attack below this chance of taking the territory */
  attackThreshold: number
  /**
   * Won't attack unless this many armies are expected to survive. Winning a
   * territory you can't then hold is the classic way to lose a won game.
   */
  minSurvivors: number
  /** how much a predicted army loss counts against the value of a target */
  lossAversion: number
  plans: ReadonlySet<Plan>
  /**
   * How strongly it refuses ground it can't hold. 0 grabs anything with good odds;
   * 1 discards targets whose new border would outgun the garrison left on them.
   * This is the main thing separating a sprawling bot from a solid one.
   */
  holdDiscipline?: number
  /** weigh targets by who owns them, and concentrate on the strongest rival */
  modelsOpponents?: boolean
  /**
   * Sit on sets instead of cashing on sight. The cash-in counter is global, so
   * every set an opponent trades raises the payout on ours — patience is worth
   * real armies, up to the point the hand limit forces the issue.
   */
  cardPatience?: boolean
  /**
   * Chase eliminations. Taking a player out hands us their whole hand, which with
   * an escalating cash-in is frequently worth more than the ground.
   */
  huntsEliminations?: boolean
  /**
   * Watch who is about to be forced to cash, and who has spread themselves thin.
   * Both are public information; both change where the next blow should land.
   */
  readsTable?: boolean
  /**
   * Hit back at whoever hit us. A named human-likeness guardrail: people bear
   * grudges, and it happens to be sound — an attacker has already committed
   * forces to our border and is likeliest to come again.
   */
  retaliates?: boolean
  /**
   * Commit to one objective per turn and spend the turn on it, instead of scoring
   * every target independently and drifting across three continents. See plans.ts.
   */
  usesPlans?: boolean
  /**
   * Gang up. When one player is clearly winning, turn on them and stop spending
   * armies on everyone else — and when the runaway player is *us*, notice that
   * three people are coming and stop sprawling. See `coalition` in evaluate.ts.
   */
  formsCoalitions?: boolean
  /**
   * How many captures deep to plan a single stack's route. 0 or 1 leaves the bot
   * choosing one blitz at a time, which cannot see a cheap tile that opens an
   * expensive one. See sweep.ts.
   */
  sweepDepth?: number
  /**
   * Spend the opening on the tiles that will have to *hold* the target continent,
   * rather than levelling every territory near it. See the setup phase.
   */
  draftsChokepoints?: boolean
  /**
   * Read *how* each opponent is playing, not just how big they are. Currently one
   * profile is recognised: the set-racer (one stack, little ground, growing hand
   * — see `sharkLikeness`). A profiled racer is treated as the primary threat and
   * massed against before the escalation makes them unstoppable, which is turns
   * earlier than the bank pact can fire.
   */
  profilesOpponents?: boolean
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/**
 * Commit to a plan only when there is a single opponent left to out-plan.
 *
 * A plan is a claim about the next several turns, and at a full table three other
 * people rearrange the board before your next one — so the claim expires before it
 * pays. Measured: +10 points heads-up, −12 at four seats.
 *
 * This is an on/off gate rather than a weight on purpose. Scaling the objective's
 * pull by 1/opponents instead — so a plan is worth a third as much against three
 * people as against one — still cost 7 points at four seats and gained nothing
 * heads-up. Commitment is either right or it isn't; a fraction of it is neither.
 */
function planApplies(s: GameState, me: PlayerId, d: Doctrine): boolean {
  return !!d.usesPlans && liveOpponents(s, me) <= 1
}

/** How many players are still in the game besides us. Never below 1. */
const liveOpponents = (s: GameState, me: PlayerId): number =>
  Math.max(1, s.players.filter((p) => p.alive && p.id !== me).length)

/**
 * What a decision knows about the table, read once and shared by every target it
 * then scores.
 *
 * None of it varies with the target and all of it walks the whole board —
 * `coalition` and `killableRival` assess every live player — so computed inside
 * the per-target loop it costs more than everything else the bot does. The review
 * feels it hardest: it prices a deploy by playing the turn out behind each of a
 * hundred alternatives, so one board read is a hundred thousand.
 */
interface TableRead {
  /** the rival worth concentrating on, if the doctrine models opponents */
  threatId: PlayerId | null
  /** who has taken ground from us lately */
  grudges: Map<PlayerId, number>
  /** the turn's objective, when there is one */
  intent: Intent | null
  /** the pile-on on the leader, if the doctrine joins one */
  pact: Coalition | null
  /** a rival we could wipe out this turn, if the doctrine hunts them */
  prey: Rival | null
  /** `exposure` by player, filled in as targets are scored */
  sprawl: Map<PlayerId, number>
}

function readTable(s: GameState, me: PlayerId, d: Doctrine): TableRead {
  return {
    // A profiled set-racer outranks the biggest position: the biggest
    // position is losing to them too, it just doesn't know it yet.
    threatId:
      (d.profilesOpponents ? profiledShark(s, me)?.id : null) ??
      (d.modelsOpponents ? primaryThreat(s, me)?.id ?? null : null),
    grudges: d.retaliates ? aggressorsAgainst(s, me) : new Map<PlayerId, number>(),
    intent: planApplies(s, me, d) ? selectIntent(s, me, d.plans) : null,
    pact: d.formsCoalitions ? coalition(s, me) : null,
    prey: d.huntsEliminations ? killableRival(s, me) : null,
    sprawl: new Map<PlayerId, number>(),
  }
}

/**
 * How much we want a territory, ignoring whether we can take it.
 *
 * The baseline matters more than it looks: every conquest is a third of an army
 * per turn plus progress toward a card. Priced too low, the bot stops expanding
 * once it holds its goal continent and quietly loses to anything that doesn't.
 */
function targetValue(
  s: GameState,
  me: PlayerId,
  t: TerritoryId,
  goal: string | null,
  d: Doctrine,
  read: TableRead,
): number {
  let v = 1.5
  const completed = completesContinent(s, me, t)
  if (completed) v += CONTINENTS[completed].bonus * 3
  else if (goal && goalContains(t, goal)) v += 3
  if (s.troops[t] <= 2) v += 0.4 // cheap mop-up

  // Breaking someone's bonus costs us a territory and costs them income — but the
  // relief is shared with everyone still standing. Heads-up we capture all of it;
  // at a full table we're doing two bystanders' work for them, and the benchmark
  // agrees emphatically (denial alone: +7 points at 2 seats, −4 at 4).
  if (d.plans.has('deny')) {
    const broken = breaksContinent(s, t)
    if (broken && s.owner[t] !== me) v += (CONTS[broken].bonus * 2.5) / liveOpponents(s, me)
  }

  // a card is worth a third of the next cash-in; guaranteeing one every turn is
  // most of what separates good players from adequate ones
  if (d.plans.has('cycle') && !s.conqueredThisTurn) v += cashValue(s.setsTraded) / 3

  if (d.modelsOpponents && read.threatId !== null && s.owner[t] === read.threatId) v *= 1.25

  const grudge = read.grudges.get(s.owner[t])
  if (grudge) v *= 1 + Math.min(0.3, grudge * 0.12)

  // the turn's objective outranks whatever else happens to look tempting
  if (read.intent && read.intent.targets.has(t)) v += 4

  // their hand comes with them, and an escalating cash-in makes that the single
  // biggest swing available
  const prey = read.prey
  if (prey && s.owner[t] === prey.id) v += 4 + prey.cards * (cashValue(s.setsTraded) / 3)

  if (d.readsTable) {
    const owner = s.players[s.owner[t]]
    if (owner && owner.id !== me) {
      // someone about to be forced to cash is about to get dangerous
      if (owner.cards.length >= HAND_LIMIT - 1) v *= 1.3
      // and a sprawling position is the cheapest place to take ground
      let sprawl = read.sprawl.get(owner.id)
      if (sprawl === undefined) read.sprawl.set(owner.id, (sprawl = exposure(s, owner.id)))
      if (sprawl > 8) v *= 1.15
    }
  }

  // Join the pile-on. The boost scales with how far clear the leader is, and the
  // matching discount on everyone else is the truce — no point spending armies on a
  // peer while the player who is actually winning grows unchecked. Soft rather than
  // absolute, so a free elimination is still taken, and conditional on `canReach`:
  // declining to attack anyone we *can* reach is paralysis, not diplomacy.
  const pact = read.pact
  if (pact && !pact.againstMe && pact.canReach && pact.joined) {
    if (s.owner[t] === pact.target) v *= 1 + clamp((pact.lead - 1) * 1.6, 0.2, 1)
    else v *= 0.6
  }

  return v
}

/**
 * Enemy strength that would bear on `to` once we hold it, ignoring the territory
 * we attacked from. Taking ground you immediately lose is worse than not taking it.
 */
function postCapturePressure(s: GameState, me: PlayerId, from: TerritoryId, to: TerritoryId): number {
  return ADJACENCY[to]
    .filter((n) => n !== from && s.owner[n] !== me)
    .reduce((sum, n) => sum + s.troops[n], 0)
}

// avoid importing CONTINENT_OF twice; small helper keeps targetValue readable
import { CONTINENT_OF, CONTINENTS } from '../../engine/board'
const goalContains = (t: TerritoryId, goal: string) => CONTINENT_OF[t] === goal

/**
 * Whether to cash a set now. Impatient bots trade on sight; patient ones wait,
 * because the cash-in counter is global and every rival's trade raises our payout.
 */
function shouldTrade(
  s: GameState,
  me: PlayerId,
  d: Doctrine,
  goal: { resistance: number } | null,
): boolean {
  if (!d.cardPatience) return true
  const hand = s.players[me].cards.length
  if (hand >= HAND_LIMIT) return true // forced
  const value = cashValue(s.setsTraded)
  // cash when it actually buys something: enough to finish the continent we're on
  if (goal && value >= goal.resistance * 1.3) return true
  // or when it turns a near-elimination into a certain one — counting the set
  // itself and the armies already in hand, because the kill it buys is the
  // whole reason to cash it
  if (d.huntsEliminations && killableRival(s, me, 1.4, s.toDeploy + value)) return true
  // Tempo while a set is still small next to the map; a war chest once it is not.
  // Every trade walks the global ladder, so a mid-game cash with nothing to buy
  // hands the bigger rungs to whoever is banking — which is exactly how the
  // recorded human games were lost. Once the sequence outweighs the whole
  // table's ground income, a set is spent on a kill or held until forced.
  return value >= PATIENCE_CEILING && !setsDominate(s)
}

/**
 * Cash unconditionally once a set is worth this much, however little else is going on.
 *
 * A backstop that almost never fires in self-play — sweeping it over 6 / 10 / 15 /
 * 20 / 25 returns *identical* win rates from 10 upwards, because the rules above it
 * decide first and self-play games rarely run long enough for the sequence to reach
 * here. It is capped by `setsDominate` rather than unconditional because a long
 * game is precisely where "cash because it's big" becomes a donation.
 */
const PATIENCE_CEILING = 15

export function makeStrategist(doctrine: Doctrine): Bot {
  return {
    key: doctrine.key,
    name: doctrine.name,
    blurb: doctrine.blurb,

    decide(s, me, rand): Move {
      const goal = chooseGoal(s, me)
      const goalId = goal?.id ?? null

      switch (s.phase) {
        // ── initial placement ───────────────────────────────────
        case 'setup': {
          const mine = territoriesOf(s, me)

          // The opening is the one phase where every tier used to play identically,
          // and it is not a small phase: 20–40 armies, placed before a shot is fired.
          // A continent is held at its doors — Australia has exactly one — so the
          // armies belong there rather than spread evenly over the ground behind it.
          if (doctrine.draftsChokepoints && goalId) {
            const doors = CONTINENT_BORDERS[goalId].filter((t) => s.owner[t] === me)
            if (doors.length) {
              return {
                type: 'placeInitial',
                territory: doors.reduce((a, b) => (s.troops[a] <= s.troops[b] ? a : b)),
              }
            }
          }

          const wanted = goal && !goal.held ? goal.missing : []
          const staging = stagingFor(s, me, wanted)
          // shore up the thinnest useful territory: piling onto one tile during
          // placement wastes the whole opening
          const pool = mine.filter((t) => staging.has(t) || (goalId && goalContains(t, goalId)))
          const candidates = pool.length ? pool : mine.filter((t) => isBorder(s, me, t))
          const final = candidates.length ? candidates : mine
          const pick = final.reduce((best, t) => {
            const a = s.troops[t] - borderSecurityRatio(s, me, t)
            const b = s.troops[best] - borderSecurityRatio(s, me, best)
            return a < b ? t : best
          }, final[0])
          return { type: 'placeInitial', territory: pick }
        }

        // ── reinforcement ───────────────────────────────────────
        case 'deploy': {
          const sets = findSets(s.players[me].cards)
          if (sets.length && shouldTrade(s, me, doctrine, goal)) {
            return { type: 'tradeCards', cards: sets[0] }
          }

          const mine = territoriesOf(s, me)
          // A rival forced to cash next turn arrives with a pile of armies, so the
          // border facing them is more dangerous than its current troop count says.
          const surging = doctrine.readsTable
            ? new Set(rivals(s, me).filter((r) => r.cashingSoon).map((r) => r.id))
            : new Set<PlayerId>()
          const risk = (t: TerritoryId) => {
            const extra = surging.size
              ? ADJACENCY[t].some((n) => surging.has(s.owner[n]))
                ? cashValue(s.setsTraded) * 0.5
                : 0
              : 0
            return (pressure(s, me, t) + extra) / Math.max(1, s.troops[t])
          }
          // defend anything about to fall, before thinking about expansion
          const atRisk = mine.filter((t) => risk(t) > 1.1).sort((a, b) => risk(b) - risk(a))

          // The `goal?.held` gate is load-bearing: defending a threatened border that
          // carries no bonus costs 8–16 points at every table size, because the armies
          // buy a tile that was going to fall anyway instead of buying ground.
          if (doctrine.plans.has('consolidate') && atRisk.length && goal?.held) {
            const t = atRisk[0]
            const need = Math.ceil(pressure(s, me, t) * 0.6) - s.troops[t]
            return { type: 'deploy', territory: t, count: clamp(need, 1, s.toDeploy) }
          }

          // A kill the pool in hand can pay for outranks everything else the
          // turn could buy: the armies land on the prey's border, and the
          // attack phase collects the hand. This is the other half of the
          // trade-for-the-kill clause in `shouldTrade` — cashing was only
          // worth it if the cash arrives where the kill is.
          if (doctrine.huntsEliminations && s.toDeploy > 0) {
            const prey = killableRival(s, me, 1.4, s.toDeploy)
            if (prey) {
              const theirs = new Set(territoriesOf(s, prey.id))
              const doors = mine.filter((t) => ADJACENCY[t].some((n) => theirs.has(n)))
              if (doors.length) {
                const door = doors.reduce((a, b) => (s.troops[a] >= s.troops[b] ? a : b))
                return { type: 'deploy', territory: door, count: s.toDeploy }
              }
            }
          }

          // A bank pact is different from a ground one: the target is winning the
          // set race from a handful of tiles, so redirecting attacks we could
          // already make is not enough — the armies have to *arrive* at their
          // border before any kill is real. Ground pacts keep the behaviour they
          // were measured with (attack redirection only, no massing). A profiling
          // doctrine masses a turn earlier: the racer's signature is readable
          // before the escalation makes the pact's own trigger true.
          if (doctrine.formsCoalitions) {
            const pact = coalition(s, me)
            const mark =
              pact?.bank && !pact.againstMe && pact.joined && pact.canReach
                ? pact.target
                : doctrine.profilesOpponents
                  ? (profiledShark(s, me)?.id ?? null)
                  : null
            if (mark !== null) {
              const theirs = new Set(territoriesOf(s, mark))
              const doors = mine.filter((t) => ADJACENCY[t].some((n) => theirs.has(n)))
              if (doors.length) {
                const door = doors.reduce((a, b) => (s.troops[a] >= s.troops[b] ? a : b))
                return { type: 'deploy', territory: door, count: s.toDeploy }
              }
            }
          }

          // otherwise mass for the push: one stack takes continents, many don't
          const plan = planApplies(s, me, doctrine) ? selectIntent(s, me, doctrine.plans) : null
          if (plan && plan.staging.length) {
            const door = plan.staging.reduce((a, b) => (s.troops[a] >= s.troops[b] ? a : b))
            // everything goes to the objective, on the strongest door into it
            return { type: 'deploy', territory: door, count: s.toDeploy }
          }
          const wanted = goal && !goal.held ? goal.missing : []
          const staging = [...stagingFor(s, me, wanted)]
          if (doctrine.plans.has('expand') && staging.length) {
            const best = staging.reduce((a, b) => (s.troops[a] >= s.troops[b] ? a : b))
            return { type: 'deploy', territory: best, count: s.toDeploy }
          }

          const fallback = (atRisk[0] ?? mine.filter((t) => isBorder(s, me, t))[0] ?? mine[0])
          return { type: 'deploy', territory: fallback, count: s.toDeploy }
        }

        // ── attack ──────────────────────────────────────────────
        case 'attack': {
          let best: { from: TerritoryId; to: TerritoryId; score: number } | null = null
          // Read once for the whole decision — see `TableRead`. Repeating any of it
          // per target is a whole-board walk inside the innermost loop there is.
          const read = readTable(s, me, doctrine)

          for (const from of territoriesOf(s, me)) {
            const a = s.troops[from]
            if (a < 2) continue
            const keep = garrisonFor(s, me, from)

            for (const to of attackableFrom(s, from)) {
              const d = s.troops[to]
              const p = winProb(a, d)
              // One flat gate for every target, deliberately, and cheap enough to run
              // before pricing anything. Scaling it against the prize — a 30% shot at
              // finishing a continent waved through where a 30% shot at a field in
              // Siberia isn't — reads as obviously better judgement and measures +1.5
              // heads-up against −4.5 at four seats. `score` below already prices the
              // odds; letting marginal attacks through on top of that spends twice.
              if (p < doctrine.attackThreshold) continue

              const survivors = expectedSurvivors(a, d)
              if (survivors < doctrine.minSurvivors) continue

              // don't strip a garrison we still need
              const leftBehind = survivors - 1
              if (isBorder(s, me, from) && leftBehind < keep * 0.5) continue

              let value = targetValue(s, me, to, goalId, doctrine, read)

              // Discipline: don't take what the neighbours will simply take back.
              // Scaled by table size for the mirror-image reason denial isn't —
              // sprawl heads-up has one punisher, sprawl at a full table has three.
              //
              // Deliberately *not* raised when the table has turned on us. Turtling
              // while ahead measures −7.5 at four seats: a leader holding a third of
              // the board wins by finishing, and a bot that answers pressure by
              // valuing position over tempo stops closing games out.
              const discipline = (doctrine.holdDiscipline ?? 0) * liveOpponents(s, me) * 0.6
              if (discipline > 0) {
                const after = postCapturePressure(s, me, from, to)
                const holding = survivors - 1 // what actually advances
                if (after > holding * 1.4) {
                  value -= discipline * (after - holding) * 0.4
                }
              }

              const cost = expectedLoss(a, d) * doctrine.lossAversion
              const score = value * p - cost


              if (score > 0 && (!best || score > best.score)) best = { from, to, score }
            }
          }

          // Plan the whole route, not just the next tile. The two are priced the same
          // way — `targetValue` for the tiles, `lossAversion` for the armies — so the
          // better of them can simply be taken. A route wins when a cheap tile that
          // scores nothing on its own opens one that matters, which is precisely the
          // case a greedy scorer is blind to.
          const sweep = doctrine.sweepDepth
            ? bestSweep(
                s,
                me,
                doctrine.sweepDepth,
                (t) => targetValue(s, me, t, goalId, doctrine, read),
                { minStepOdds: doctrine.attackThreshold, lossAversion: doctrine.lossAversion },
              )
            : null
          if (sweep && (!best || sweep.score > best.score)) {
            return { type: 'blitz', from: sweep.from, to: sweep.route[0] }
          }

          if (!best) return { type: 'endAttack' }
          return { type: 'blitz', from: best.from, to: best.to }
        }

        // ── how far to advance after a capture ──────────────────
        //
        // `to` is already ours by the time we're asked, so `garrisonFor` reads both
        // sides post-capture and the only question is how to split what's left.
        case 'occupy': {
          const occ = s.pendingOccupation!
          const here = s.troops[occ.from]
          const needFrom = garrisonFor(s, me, occ.from)
          const shortTo = Math.max(0, garrisonFor(s, me, occ.to) - s.troops[occ.to])
          const sparable = here - needFrom

          let extra: number
          if (needFrom <= 1) {
            // the source is interior now: armies left there can neither attack nor
            // defend, which is the classic stack stranded a tile behind the front
            extra = occ.max
          } else if (sparable < shortTo) {
            // not enough to hold both doors, so the one facing more guns gets it
            const pTo = pressure(s, me, occ.to)
            const pFrom = pressure(s, me, occ.from)
            extra = Math.round(((here - 1) * pTo) / Math.max(1, pTo + pFrom))
          } else if (isBorder(s, me, occ.to)) {
            extra = sparable // the front moved forward; the armies go with it
          } else {
            extra = shortTo // nothing beyond it to fight, so keep the reserve at the door
          }
          return { type: 'occupy', count: clamp(extra, occ.min, occ.max) }
        }

        // ── end-of-turn shuffle ─────────────────────────────────
        //
        // Only interior stacks are drained, and only into the front closest to
        // falling. That declines the fortify on about a third of turns, 60% of which
        // do have three-plus armies within reach of a thin border — but moving them
        // measures neutral. Two rewrites were tried and both are recorded in BOTS.md;
        // the armies are idle *behind a front that isn't the decisive one*, and one
        // move per turn cannot repair that. Massing in one stack is already correct.
        case 'fortify': {
          if (!s.canFortify) return { type: 'endTurn' }
          const mine = territoriesOf(s, me)
          const fronts = mine
            .filter((t) => isBorder(s, me, t))
            .sort((a, b) => borderSecurityRatio(s, me, b) - borderSecurityRatio(s, me, a))
          if (!fronts.length) return { type: 'endTurn' }

          for (const target of fronts) {
            // drain safe interior stacks first; never strip another border
            const sources = mine
              .filter((t) => t !== target && s.troops[t] > 1 && !isBorder(s, me, t))
              .filter((t) => connectedOwn(s, me, t).has(target))
              .sort((a, b) => s.troops[b] - s.troops[a])
            if (sources.length) {
              return { type: 'fortify', from: sources[0], to: target, count: s.troops[sources[0]] - 1 }
            }
          }
          return { type: 'endTurn' }
        }

        default: {
          const moves = legalMoves(s)
          return moves[Math.floor(rand() * moves.length)]
        }
      }
    },
  }
}

/** Adjacent-territory helper kept here so doctrines can share it later. */
export const neighboursOwnedBy = (s: GameState, p: PlayerId, t: TerritoryId): TerritoryId[] =>
  ADJACENCY[t].filter((n) => s.owner[n] === p)
