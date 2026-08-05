/**
 * Positional facts every tier reasons from. Deliberately shared: tiers differ in
 * what they *do* with this, not in what they can see, which is what keeps them
 * playing like one species at different skill levels.
 */
import {
  ADJACENCY,
  CONTINENTS,
  CONTINENT_IDS,
  CONTINENT_OF,
  TERRITORIES_IN,
} from '../../engine/board'
import type { ContinentId, TerritoryId } from '../../engine/board'
import { territoriesOf } from '../../engine/game'
import type { GameState, PlayerId } from '../../engine/types'

/** Territories in a continent that touch anything outside it — what you must garrison. */
export const CONTINENT_BORDERS: Record<ContinentId, TerritoryId[]> = Object.fromEntries(
  CONTINENT_IDS.map((c) => {
    const inside = new Set(TERRITORIES_IN[c])
    return [c, TERRITORIES_IN[c].filter((t) => ADJACENCY[t].some((n) => !inside.has(n)))]
  }),
) as Record<ContinentId, TerritoryId[]>

/**
 * Armies per turn per territory you must defend. Australia (2.00) is twice as
 * efficient to hold as Africa (1.00), which is why it's almost always the right
 * first continent regardless of where you start.
 */
export const CONTINENT_EFFICIENCY: Record<ContinentId, number> = Object.fromEntries(
  CONTINENT_IDS.map((c) => [c, CONTINENTS[c].bonus / CONTINENT_BORDERS[c].length]),
) as Record<ContinentId, number>

export const enemyNeighbours = (s: GameState, me: PlayerId, t: TerritoryId): TerritoryId[] =>
  ADJACENCY[t].filter((n) => s.owner[n] !== me)

export const isBorder = (s: GameState, me: PlayerId, t: TerritoryId): boolean =>
  ADJACENCY[t].some((n) => s.owner[n] !== me)

/** Total enemy armies that could hit this territory next turn. */
export const pressure = (s: GameState, me: PlayerId, t: TerritoryId): number =>
  enemyNeighbours(s, me, t).reduce((sum, n) => sum + s.troops[n], 0)

/**
 * Border Security Ratio, from the Risk AI literature: enemy strength bearing on a
 * territory divided by what's defending it. Above ~1 means it's likely to fall.
 */
export const borderSecurityRatio = (s: GameState, me: PlayerId, t: TerritoryId): number =>
  pressure(s, me, t) / Math.max(1, s.troops[t])

export interface ContinentStanding {
  id: ContinentId
  size: number
  bonus: number
  efficiency: number
  /** how many of its territories we hold */
  mine: number
  /** territories we still need */
  missing: TerritoryId[]
  held: boolean
  /** total armies sitting on the ones we don't have */
  resistance: number
}

export function continentStanding(s: GameState, me: PlayerId, c: ContinentId): ContinentStanding {
  const members = TERRITORIES_IN[c]
  const missing = members.filter((t) => s.owner[t] !== me)
  return {
    id: c,
    size: members.length,
    bonus: CONTINENTS[c].bonus,
    efficiency: CONTINENT_EFFICIENCY[c],
    mine: members.length - missing.length,
    missing,
    held: missing.length === 0,
    resistance: missing.reduce((n, t) => n + s.troops[t], 0),
  }
}

export const allStandings = (s: GameState, me: PlayerId): ContinentStanding[] =>
  CONTINENT_IDS.map((c) => continentStanding(s, me, c))

/**
 * The continent to work towards next.
 *
 * Only unheld continents are candidates: one we already own needs defending, not
 * conquering, and returning it here made the bot treat every remaining enemy
 * territory as off-plan and stop expanding entirely.
 *
 * Efficiency decides which continent is worth having; progress and resistance
 * decide whether it's realistic this turn.
 */
export function chooseGoal(s: GameState, me: PlayerId): ContinentStanding | null {
  const income = Math.max(3, Math.floor(territoriesOf(s, me).length / 3))
  let best: ContinentStanding | null = null
  let bestScore = -Infinity
  for (const st of allStandings(s, me)) {
    if (st.held) continue
    const reachable =
      st.mine > 0 || st.missing.some((t) => ADJACENCY[t].some((n) => s.owner[n] === me))
    if (!reachable) continue
    const progress = st.mine / st.size
    // roughly what it would cost to finish: enemy armies plus a 1.5x attacking premium
    const cost = st.resistance * 1.5 + st.missing.length
    const reach = Math.min(1, (income * 2.5) / Math.max(1, cost))
    const score = st.efficiency * (0.35 + progress) * reach
    if (score > bestScore) {
      bestScore = score
      best = st
    }
  }
  return best
}

/** Continents we currently own outright — these need garrisoning, not attacking. */
export const heldContinents = (s: GameState, me: PlayerId): ContinentStanding[] =>
  allStandings(s, me).filter((st) => st.held)

/** Territories of ours that sit next to something we want. */
export function stagingFor(s: GameState, me: PlayerId, wanted: TerritoryId[]): Set<TerritoryId> {
  const out = new Set<TerritoryId>()
  for (const w of wanted)
    for (const n of ADJACENCY[w]) if (s.owner[n] === me) out.add(n)
  return out
}

/** Does taking this territory complete a continent for us? */
export function completesContinent(s: GameState, me: PlayerId, t: TerritoryId): ContinentId | null {
  const c = CONTINENT_OF[t]
  const others = TERRITORIES_IN[c].filter((x) => x !== t)
  return others.every((x) => s.owner[x] === me) ? c : null
}

/** Does taking this territory break someone else's continent bonus? */
export function breaksContinent(s: GameState, t: TerritoryId): ContinentId | null {
  const c = CONTINENT_OF[t]
  const owner = s.owner[t]
  return TERRITORIES_IN[c].every((x) => s.owner[x] === owner) ? c : null
}

/** Income a player is collecting right now — territories plus continent bonuses. */
export function incomeOf(s: GameState, p: PlayerId): number {
  const base = Math.max(3, Math.floor(territoriesOf(s, p).length / 3))
  const bonus = CONTINENT_IDS.filter((c) => TERRITORIES_IN[c].every((t) => s.owner[t] === p)).reduce(
    (n, c) => n + CONTINENTS[c].bonus,
    0,
  )
  return base + bonus
}
