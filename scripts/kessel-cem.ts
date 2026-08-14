/**
 * The search both Kessel experiments share: cross-entropy over doctrine settings.
 *
 * Sample a generation, keep the elites, refit the distribution to them. Hill
 * climbing on a noisy objective mostly climbs the noise; drawing a fresh
 * generation from a fitted distribution does not, and the spread it reports is
 * itself a signal — a distribution that collapses has found something, one that
 * stays wide has not.
 *
 * Kept in one place because a second copy would drift, and the two scripts using
 * it are meant to be comparable.
 */
import type { Doctrine } from '../src/games/kessel/bot'
import type { Job } from './match'
import { playGames } from './parallel'

export const TURN_CAP = 600

export type Params = Omit<Doctrine, 'key' | 'name' | 'blurb'>

export const SPACE: Record<keyof Params, { lo: number; hi: number }> = {
  attackRatio: { lo: 0.8, hi: 2.5 },
  encirclement: { lo: 0, hi: 3 },
  refitBelow: { lo: 0, hi: 80 },
  objectivePull: { lo: 0, hi: 2 },
  overreach: { lo: 0, hi: 1 },
  counterattack: { lo: 0, hi: 3 },
}

export const KEYS = Object.keys(SPACE) as (keyof Params)[]

export type Dist = Record<keyof Params, { mean: number; sd: number }>

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

function gauss(rand: () => number): number {
  const u = Math.max(1e-9, rand())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

export const startDist = (): Dist =>
  Object.fromEntries(
    KEYS.map((k) => [
      k,
      { mean: (SPACE[k].lo + SPACE[k].hi) / 2, sd: (SPACE[k].hi - SPACE[k].lo) / 4 },
    ]),
  ) as Dist

export function sample(d: Dist, rand: () => number): Params {
  return Object.fromEntries(
    KEYS.map((k) => [k, clamp(d[k].mean + d[k].sd * gauss(rand), SPACE[k].lo, SPACE[k].hi)]),
  ) as Params
}

export function refit(elites: Params[]): Dist {
  return Object.fromEntries(
    KEYS.map((k) => {
      const xs = elites.map((e) => e[k])
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length
      const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length
      // A floor on the spread, or the distribution collapses onto the first elite
      // and every later generation re-measures the same point.
      return [k, { mean, sd: Math.max(Math.sqrt(varr), (SPACE[k].hi - SPACE[k].lo) * 0.04) }]
    }),
  ) as Dist
}

export const asDoctrine = (p: Params): Doctrine => ({ key: 'probe', name: 'Probe', blurb: '', ...p })

export const show = (p: Params) => KEYS.map((k) => `  ${k.padEnd(15)} ${p[k].toFixed(2)}`).join('\n')

/** A seeded generator, so a search is reproducible from its `--seed`. */
export function rngFor(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Opponent {
  /** registry key, or a name for a doctrine supplied inline */
  key: string
  params?: Params
}

/**
 * Win rate for every candidate against every opponent, averaged.
 *
 * Seats swap on paired seeds — going first is worth something, and an unrotated
 * comparison measures position rather than doctrine. Every game in the generation
 * goes into one worker pool call, so the pool stays saturated across candidates
 * rather than draining between them.
 */
export async function rateAll(
  pool: Params[],
  opponents: Opponent[],
  games: number,
  offset: number,
  workers: number,
): Promise<number[]> {
  const jobs: Job[] = []
  for (const p of pool) {
    for (const opp of opponents) {
      for (let s = 0; s < games; s++) {
        const flip = s % 2 === 1
        const doctrines: Record<string, Doctrine> = { probe: asDoctrine(p) }
        if (opp.params) doctrines[opp.key] = asDoctrine(opp.params)
        jobs.push({
          game: 'kessel',
          order: flip ? [opp.key, 'probe'] : ['probe', opp.key],
          seed: offset + s + 1,
          turnCap: TURN_CAP,
          doctrines,
        })
      }
    }
  }

  const { outcomes } = await playGames(jobs, workers)

  const per = opponents.length * games
  return pool.map((_, i) => {
    let wins = 0
    let decided = 0
    for (let j = 0; j < per; j++) {
      const o = outcomes[i * per + j]
      if (!o || o.winner === null) continue
      decided++
      // Seat 0 is the probe on even seeds within each opponent's block of games.
      const s = j % games
      if (o.winner === (s % 2 === 1 ? 1 : 0)) wins++
    }
    return decided === 0 ? 0.5 : wins / decided
  })
}
