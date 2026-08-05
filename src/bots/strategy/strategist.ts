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
import { attackableFrom, connectedOwn, legalMoves, territoriesOf } from '../../engine/game'
import type { GameState, Move, PlayerId } from '../../engine/types'
import {
  borderSecurityRatio,
  chooseGoal,
  completesContinent,
  isBorder,
  pressure,
  stagingFor,
} from './board-sense'
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
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/**
 * How much we want a territory, ignoring whether we can take it.
 *
 * The baseline matters more than it looks: every conquest is a third of an army
 * per turn plus progress toward a card. Priced too low, the bot stops expanding
 * once it holds its goal continent and quietly loses to anything that doesn't.
 */
function targetValue(s: GameState, me: PlayerId, t: TerritoryId, goal: string | null): number {
  let v = 1.5
  const completed = completesContinent(s, me, t)
  if (completed) v += CONTINENTS[completed].bonus * 3
  else if (goal && goalContains(t, goal)) v += 3
  if (s.troops[t] <= 2) v += 0.4 // cheap mop-up
  return v
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
          if (sets.length) return { type: 'tradeCards', cards: sets[0] }

          const mine = territoriesOf(s, me)
          // defend anything about to fall, before thinking about expansion
          const atRisk = mine
            .filter((t) => borderSecurityRatio(s, me, t) > 1.1)
            .sort((a, b) => borderSecurityRatio(s, me, b) - borderSecurityRatio(s, me, a))

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

              const value = targetValue(s, me, to, goalId)
              const cost = expectedLoss(a, d) * doctrine.lossAversion
              const score = value * p - cost

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
