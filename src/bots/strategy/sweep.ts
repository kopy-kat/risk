/**
 * Planning a whole turn's attack as one route, rather than one blitz at a time.
 *
 * Everything above this picks the single best-looking capture, plays it, and asks
 * again. That is enough to take ground but it cannot see the shape strong play
 * actually has: hoard, cash, and then clear six territories with one stack to bank
 * a card, finish a continent and knock somebody out. A greedy scorer declines the
 * cheap first tile of that route because on its own it is worth nothing, and so it
 * never reaches the tile that was the point.
 *
 * So a route is priced whole. `chainOdds` in `combat.ts` already carries the stack's
 * expected survivors from one fight to the next; what was missing was anything that
 * asked it a question.
 *
 * No state is kept. The route is recomputed from the position each call, which means
 * a bot follows through on it for as long as it stays the best route and abandons it
 * the moment the dice say otherwise — which is the behaviour we want anyway, and it
 * keeps agents pure functions of the board.
 */
import { ADJACENCY, TERRITORY_IDS } from '../../engine/board'
import type { TerritoryId } from '../../engine/board'
import { expectedSurvivors, winProb } from '../../engine/combat'
import type { GameState, PlayerId } from '../../engine/types'

export interface Sweep {
  /** the stack the route is driven from */
  from: TerritoryId
  /** territories to take, in order */
  route: TerritoryId[]
  /** chance of clearing the whole route */
  p: number
  /** expected armies still standing at the end of it */
  survivors: number
  /** value of the route, each tile discounted by the chance of getting that far */
  score: number
}

/**
 * A stack has to be worth driving before a route is worth planning. Below this the
 * only reachable routes are one tile long, which is what the greedy scorer already
 * does — and enumerating them again for every 2-army border tile costs more than it
 * finds.
 */
const MIN_STACK = 4

/**
 * Best route out of one of our territories, up to `depth` captures deep.
 *
 * `valueOf` prices a single tile and comes from the caller so a route is denominated
 * the same way single captures are — otherwise the two could not be compared and
 * picking between them would be arbitrary.
 */
export function bestSweep(
  s: GameState,
  me: PlayerId,
  depth: number,
  valueOf: (t: TerritoryId) => number,
  opts: { minStepOdds: number; lossAversion: number },
): Sweep | null {
  if (depth < 2) return null
  let best: Sweep | null = null

  const consider = (cand: Sweep) => {
    if (!best || cand.score > best.score) best = cand
  }

  for (const from of TERRITORY_IDS) {
    if (s.owner[from] !== me) continue
    const stack = s.troops[from]
    if (stack < MIN_STACK) continue

    // depth-first over enemy neighbours, carrying the stack's expected survivors
    // forward exactly as an actual sweep would carry them
    const walk = (
      at: TerritoryId,
      armies: number,
      visited: Set<TerritoryId>,
      route: TerritoryId[],
      pSoFar: number,
      valueSoFar: number,
    ) => {
      if (route.length >= depth || armies < 2) return
      for (const next of ADJACENCY[at]) {
        if (s.owner[next] === me || visited.has(next)) continue
        const d = s.troops[next]
        const step = winProb(armies, d)
        if (step < opts.minStepOdds) continue
        // one army is always pinned in the territory it attacked from, so what
        // carries on to the next fight is one short of what survives this one
        const advancing = Math.floor(expectedSurvivors(armies, d)) - 1
        if (advancing < 1) continue

        const p = pSoFar * step
        // each tile is worth its value times the odds of ever reaching it, and the
        // armies spent getting there are charged at the doctrine's loss aversion
        const value = valueSoFar + valueOf(next) * p
        const nextRoute = [...route, next]
        // one-tile routes are what the greedy scorer already produces; this only
        // exists to find the ones it cannot see
        if (nextRoute.length >= 2) {
          consider({
            from,
            route: nextRoute,
            p,
            survivors: advancing,
            score: value - (stack - advancing) * opts.lossAversion,
          })
        }
        visited.add(next)
        walk(next, advancing, visited, nextRoute, p, value)
        visited.delete(next)
      }
    }

    walk(from, stack, new Set([from]), [], 1, 0)
  }

  return best
}
