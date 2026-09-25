import type { PlayerId } from '../../engine/types'
import type { Doctrine } from './bot'
import type { GameMap } from './map'
import { retreatOptions } from './supply'
import type { Formation, KesselState } from './types'

/**
 * What a side gives away about itself, read off the boards it leaves the enemy: the
 * share of the enemy's line it has left with one way out or none. A share of the line
 * rather than a count, so a big battle and a small one say the same thing.
 *
 * It is the only tell the enemy learns from because it is the only one a defending
 * doctrine can answer. Weaknesses of your own — spearheads short of supply, corps
 * with one way back — would have to be punished by attacking, and a doctrine holding
 * a line rarely attacks, so raising the settings that price them measured as nothing
 * or worse.
 */
export interface Tells {
  /** absent on records from before it was read, which count as none */
  rings?: number
}

function lineOf(m: GameMap, s: KesselState, p: PlayerId): Formation[] {
  const enemyAt = new Set(s.formations.filter((f) => f.owner !== p).map((f) => f.at))
  return s.formations.filter((f) => f.owner === p && (m.adjacency[f.at] ?? []).some((n) => enemyAt.has(n)))
}

/** One board's tells for `p`, or null when nothing of the enemy's is in contact. */
export function tellsOn(m: GameMap, s: KesselState, p: PlayerId): Tells | null {
  const theirs = lineOf(m, s, (1 - p) as PlayerId)
  if (theirs.length === 0) return null
  return { rings: theirs.filter((f) => retreatOptions(m, s, f).length <= 1).length / theirs.length }
}

export function meanTells(all: Tells[]): Tells | null {
  if (all.length === 0) return null
  return { rings: all.reduce((n, t) => n + (t.rings ?? 0), 0) / all.length }
}

/**
 * How far a share of the enemy's line left in rings raises its caution, and where it
 * stops: past two, a cautious corps starts walking off ground it should have held.
 */
const WEIGHT = 6
const CAUTION_MAX = 2

/** Below this a tell is noise, and not worth a line in the briefing. */
const NOTICED = 0.15

export interface Adapted {
  doctrine: Doctrine
  /** what the enemy has noticed, for the briefing, or null if nothing yet */
  lesson: string | null
}

/** The enemy you have taught: the more you pocket it, the sooner it gets out. */
export function adapt(base: Doctrine, tells: Tells | null): Adapted {
  const rings = tells?.rings ?? 0
  return {
    doctrine: { ...base, caution: Math.min(CAUTION_MAX, (base.caution ?? 0) + rings * WEIGHT) },
    lesson: rings < NOTICED ? null : 'The enemy has learned you close rings, and will pull out of them before they shut.',
  }
}
