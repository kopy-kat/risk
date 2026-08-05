/**
 * The shared brain. Tiers are doctrines over this one agent rather than separate
 * implementations — that's what makes them read as the same species at different
 * skill levels instead of three different opponents.
 *
 * See BOTS.md. This file currently implements the Colonel-level plans (expand and
 * consolidate); deny / cycle / decapitate hook in at the marked points.
 */
import { ADJACENCY } from '../../engine/board'
import type { TerritoryId } from '../../engine/board'
import { findSets } from '../../engine/cards'
import { expectedLoss, expectedSurvivors, winProb } from '../../engine/combat'
import { HAND_LIMIT, attackableFrom, connectedOwn, legalMoves, territoriesOf } from '../../engine/game'
import type { GameState, Move, PlayerId } from '../../engine/types'
import {
  borderSecurityRatio,
  breaksContinent,
  chooseGoal,
  completesContinent,
  isBorder,
  pressure,
  stagingFor,
} from './board-sense'
import { exposure, killableRival, primaryThreat, rivals } from './evaluate'
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
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/** How many players are still in the game besides us. Never below 1. */
const liveOpponents = (s: GameState, me: PlayerId): number =>
  Math.max(1, s.players.filter((p) => p.alive && p.id !== me).length)

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
  threatId: PlayerId | null,
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

  if (d.modelsOpponents && threatId !== null && s.owner[t] === threatId) v *= 1.25

  if (d.huntsEliminations) {
    const prey = killableRival(s, me)
    // their hand comes with them, and an escalating cash-in makes that the single
    // biggest swing available
    if (prey && s.owner[t] === prey.id) v += 4 + prey.cards * (cashValue(s.setsTraded) / 3)
  }

  if (d.readsTable) {
    const owner = s.players[s.owner[t]]
    if (owner && owner.id !== me) {
      // someone about to be forced to cash is about to get dangerous
      if (owner.cards.length >= HAND_LIMIT - 1) v *= 1.3
      // and a sprawling position is the cheapest place to take ground
      const sprawl = exposure(s, owner.id)
      if (sprawl > 8) v *= 1.15
    }
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

/** Garrison a territory should keep, given what's pointed at it. */
function garrisonFor(s: GameState, me: PlayerId, t: TerritoryId): number {
  if (!isBorder(s, me, t)) return 1
  const threat = pressure(s, me, t)
  return clamp(Math.ceil(threat * 0.55), 2, 12)
}

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
  // or when it turns a near-elimination into a certain one
  if (d.huntsEliminations && killableRival(s, me, 1.4)) return true
  return value >= 15
}

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

          if (doctrine.plans.has('consolidate') && atRisk.length && goal?.held) {
            const t = atRisk[0]
            const need = Math.ceil(pressure(s, me, t) * 0.6) - s.troops[t]
            return { type: 'deploy', territory: t, count: clamp(need, 1, s.toDeploy) }
          }

          // otherwise mass for the push: one stack takes continents, many don't
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
          const threat = doctrine.modelsOpponents ? primaryThreat(s, me) : null
          const threatId = threat?.id ?? null

          for (const from of territoriesOf(s, me)) {
            const a = s.troops[from]
            if (a < 2) continue
            const keep = garrisonFor(s, me, from)

            for (const to of attackableFrom(s, from)) {
              const d = s.troops[to]
              const p = winProb(a, d)
              if (p < doctrine.attackThreshold) continue

              const survivors = expectedSurvivors(a, d)
              if (survivors < doctrine.minSurvivors) continue

              // don't strip a garrison we still need
              const leftBehind = survivors - 1
              if (isBorder(s, me, from) && leftBehind < keep * 0.5) continue

              let value = targetValue(s, me, to, goalId, doctrine, threatId)

              // Discipline: don't take what the neighbours will simply take back.
              // Scaled by table size for the mirror-image reason denial isn't —
              // sprawl heads-up has one punisher, sprawl at a full table has three.
              const discipline = (doctrine.holdDiscipline ?? 0) * liveOpponents(s, me) * 0.6
              if (discipline > 0) {
                const after = postCapturePressure(s, me, from, to)
                const holding = survivors - 1 // what actually advances
                if (after > holding * 1.4) {
                  value -= discipline * (after - holding) * 0.4
                }
              }

              const cost = expectedLoss(a, d) * doctrine.lossAversion
              let score = value * p - cost

              if (score > 0 && (!best || score > best.score)) best = { from, to, score }
            }
          }

          if (!best) return { type: 'endAttack' }
          return { type: 'blitz', from: best.from, to: best.to }
        }

        // ── how far to advance after a capture ──────────────────
        case 'occupy': {
          const occ = s.pendingOccupation!
          const total = s.troops[occ.from]
          const keepHere = isBorder(s, me, occ.from) ? garrisonFor(s, me, occ.from) : 1
          const extra = clamp(total - keepHere, occ.min, occ.max)
          return { type: 'occupy', count: extra }
        }

        // ── end-of-turn shuffle ─────────────────────────────────
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
