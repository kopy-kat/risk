/**
 * One headless game, and the shape of a request for one.
 *
 * Split out of `bench.ts` so that the benchmark, the exploiter search and the
 * worker threads all drive games through exactly one implementation. A second
 * copy of this loop would be a second set of results.
 */
import { BOT_BY_KEY } from '../src/bots'
import { stepBot } from '../src/bots/play'
import { makePolicyBot } from '../src/bots/pool'
import type { Policy } from '../src/bots/pool'
import { createGame } from '../src/engine/game'
import { rngFrom } from '../src/engine/rng'
import { KESSEL_BOTS, decideFor } from '../src/games/kessel/bot'
import type { Doctrine } from '../src/games/kessel/bot'
import { meanTells, tellsOn } from '../src/games/kessel/adapt'
import type { Tells } from '../src/games/kessel/adapt'
import { createGame as createKessel } from '../src/games/kessel/game'
import { mapOf } from '../src/games/kessel/map'
import { missionOf, starsFor } from '../src/games/kessel/missions'
import { stepBot as stepKessel } from '../src/games/kessel/play'
import '../src/games/kessel'

export interface Job {
  /** which game's rules to play under; Risk when absent */
  game?: string
  /** bot keys in play order */
  order: string[]
  seed: number
  turnCap: number
  /**
   * Policy bots built for this game alone, keyed by the name used in `order`.
   *
   * This is what lets `npm run exploit` benchmark candidates that aren't in the
   * registry. A `Policy` is six numbers, so it structured-clones to a worker for
   * free — registering thousands of throwaway bots up front would not.
   */
  policies?: Record<string, Policy>
  /**
   * Kessel's equivalent: doctrines built for this game alone. Six numbers, so
   * they structured-clone to a worker for free.
   */
  doctrines?: Record<string, Doctrine>
  /** a Kessel mission to fight instead of the war */
  scenario?: string
  level?: number
}

export interface Outcome {
  /** index into the seat list, or null if the game hit the turn cap */
  winner: number | null
  turns: number
  /** Kessel's peace, when it has one */
  /** Kessel mission: the stars the player's side earned */
  stars?: number
  /** Kessel: each seat's share of its aims at the peace */
  aims?: number[]
  /** Kessel: each seat's tells, read off the board it left after every commit */
  tells?: (Tells | null)[]
}

/** Everything derives from `seed`, so the same job always produces the same game. */
export function playMatch(job: Job): Outcome {
  return job.game === 'kessel' ? playKessel(job) : playRisk(job)
}

function playKessel({ order, seed, turnCap, doctrines, scenario, level }: Job): Outcome {
  const rng = rngFrom(seed ^ 0x5bf03635)
  const bots = Object.fromEntries(KESSEL_BOTS.map((b) => [b.key, b]))
  const seats = order.map((key) => {
    const probe = doctrines?.[key]
    if (!probe) return bots[key]
    return { key, name: key, blurb: '', decide: (s: never, me: number, r: () => number) =>
      decideFor(probe, s, me, r) }
  })

  let s = createKessel({
    seats: order.map((bot, i) => ({ name: `P${i}`, bot })),
    seed,
    record: false,
    scenario,
    level,
  })
  const m = mapOf(s.mapId)
  const seen: Tells[][] = order.map(() => [])
  while (s.phase !== 'gameOver' && s.turn < turnCap) {
    const mover = s.current
    const phase = s.phase
    s = stepKessel(s, seats[mover] as never, () => rng.next())
    if (phase === 'orders' && s.current !== mover) {
      const t = tellsOn(m, s, mover)
      if (t) seen[mover].push(t)
    }
  }
  const mission = scenario ? missionOf(scenario) : null
  const stars = mission ? starsFor(s, mission.player, mission) : undefined
  return { winner: s.winner, turns: s.turn, stars, aims: s.peace?.aims, tells: seen.map(meanTells) }
}

function playRisk({ order, seed, turnCap, policies }: Job): Outcome {
  const rng = rngFrom(seed ^ 0x5bf03635)
  const bots = policies
    ? { ...BOT_BY_KEY, ...Object.fromEntries(
        Object.entries(policies).map(([k, p]) => [k, makePolicyBot(k, k, '', p)]),
      ) }
    : BOT_BY_KEY
  let s = createGame({
    seats: order.map((bot, i) => ({ name: `P${i}`, bot })),
    seed,
    // The move list is only there to replay a game later, and nothing replays a
    // benchmark game. Recording it makes `applyMove` cost grow with the length
    // of the game, since `clone` copies the list every move.
    record: false,
  })
  while (s.phase !== 'gameOver' && s.turn < turnCap) {
    const bot = bots[s.players[s.current].bot!]
    // non-strict: one bad move shouldn't abort a 600-game run
    s = stepBot(s, bot, () => rng.next())
  }
  return { winner: s.winner, turns: s.turn }
}
