/**
 * One war played and judged, and the pool that runs a pile of them.
 *
 * Split out of `review-check-kessel.ts` so that the serial path and the worker
 * threads drive exactly one implementation — a second copy of this loop would be
 * a second set of results. Reviewing a war is a couple of seconds of arithmetic
 * with nothing shared between games, so it parallelises for free, and without
 * that the check is minutes of a still terminal.
 */
import { cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import { kessel } from '../src/games/kessel'
import { KESSEL_BOTS, decideFor } from '../src/games/kessel/bot'
import type { Doctrine } from '../src/games/kessel/bot'
import { createGame } from '../src/games/kessel/game'
import { stepBot } from '../src/games/kessel/play'
import { rngFrom } from '../src/engine/rng'
import { reviewKesselGame } from '../src/review/kessel/review'
import type { Grade } from '../src/review/review'
import type { GameRecord } from '../src/review/store'

/**
 * A commander who fights hard and badly: assaults at odds that cannot pay, never
 * pulls a formation out to refit, sees no reason to cut a line of retreat, and
 * charges the objectives with no regard for where its supply reaches.
 *
 * It exists because the three doctrines are all *competent* — the difference
 * between them is strategic and takes a war to show — while the thing a reviewer
 * is for is a player making mistakes inside a turn. Six numbers, so it
 * structured-clones to a worker for free.
 */
export const RECKLESS: Doctrine = {
  key: 'reckless',
  name: 'Reckless',
  blurb: 'Attacks at any odds, never refits, and outruns its own supply.',
  attackRatio: 0.6,
  encirclement: 0,
  refitBelow: 0,
  objectivePull: 1.2,
  overreach: 1,
  counterattack: 0,
}

export interface ReviewJob {
  /** doctrine keys in seat order, without the `kessel-` prefix */
  order: string[]
  seed: number
  turnCap: number
  /** policies built for this run alone, keyed by the name used in `order` */
  doctrines?: Record<string, Doctrine>
}

export interface SeatResult {
  /** which turn of the war each judgement below belongs to */
  turns: number[]
  losses: number[]
  lucks: number[]
  grades: Record<Grade, number>
  faults: Record<string, { count: number; cost: number }>
}

export interface ReviewResult {
  turns: number
  finished: boolean
  /** which seat won, or null if nobody did */
  winner: number | null
  seats: SeatResult[]
}

const BOTS = Object.fromEntries(KESSEL_BOTS.map((b) => [b.key, b]))

/** One war, packaged exactly as the app would store it. */
function play({ order, seed, turnCap, doctrines }: ReviewJob): GameRecord {
  const rng = rngFrom((seed ^ 0x9e3779b9) >>> 0)
  const seats = order.map((key) => {
    const probe = doctrines?.[key]
    return probe
      ? {
          key: `kessel-${key}`,
          name: key,
          blurb: '',
          decide: (st: never, me: number, r: () => number) => decideFor(probe, st, me, r),
        }
      : BOTS[`kessel-${key}`]
  })
  let s = createGame({
    seats: order.map((key, i) => ({ name: `P${i}`, bot: `kessel-${key}` })),
    seed,
  })
  while (s.phase !== 'gameOver' && s.turn < turnCap) {
    s = stepBot(s, seats[s.current] as never, () => rng.next())
  }
  return {
    id: `${order.join('-')}-${seed}`,
    schema: 1,
    rules: kessel.rulesVersion,
    seed,
    botSeed: seed ^ 0x9e3779b9,
    game: 'kessel',
    // Both seats are recorded as human, which is what makes every turn either
    // doctrine played a decision the reviewer takes up.
    seats: order.map((_, i) => ({ name: `P${i}`, bot: null })),
    moves: s.moves,
    assisted: [],
    winner: s.winner,
    turns: s.turn,
    finished: s.phase === 'gameOver',
    savedAt: 0,
  }
}

export function runOne(job: ReviewJob): ReviewResult {
  const record = play(job)
  const review = reviewKesselGame(record, { players: [0, 1] })
  if (review.error) throw new Error(`${job.order.join(' v ')} seed ${job.seed}: ${review.error}`)

  const seats: SeatResult[] = record.seats.map((_, seat) => {
    const mine = review.judgements.filter((j) => j.player === seat)
    const grades: Record<Grade, number> = {
      best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0,
    }
    const faults: Record<string, { count: number; cost: number }> = {}
    for (const j of mine) {
      grades[j.grade]++
      for (const f of j.findings) {
        const at = (faults[f.fault] ??= { count: 0, cost: 0 })
        at.count++
        at.cost += f.cost
      }
    }
    return {
      turns: mine.map((j) => j.turn),
      losses: mine.map((j) => j.loss),
      lucks: mine.map((j) => j.luck),
      grades,
      faults,
    }
  })
  return { turns: record.turns, finished: record.finished, winner: record.winner, seats }
}

const workerCount = () => Math.max(1, Math.min(16, cpus().length - 2))

export interface Batch {
  at: number[]
  jobs: ReviewJob[]
}

/** Run every job, results reassembled in job order rather than completion order. */
export async function runAll(
  jobs: ReviewJob[],
  onDone?: (done: number, total: number) => void,
): Promise<ReviewResult[]> {
  const workers = workerCount()
  let done = 0
  if (workers <= 1 || jobs.length < 2) {
    return jobs.map((j) => {
      const r = runOne(j)
      onDone?.(++done, jobs.length)
      return r
    })
  }

  const out: ReviewResult[] = Array.from({ length: jobs.length })
  // One job per message: games differ in length by a factor of five, so handing
  // a worker a contiguous block leaves most of the pool idle waiting for one.
  let next = 0
  const pool = Array.from(
    { length: Math.min(workers, jobs.length) },
    () => new Worker(new URL('./kessel-review-worker.ts', import.meta.url)),
  )
  try {
    await Promise.all(
      pool.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const feed = () => {
              if (next >= jobs.length) return resolve()
              const at = next++
              w.postMessage({ at: [at], jobs: [jobs[at]] } satisfies Batch)
            }
            w.on('message', (m: { at: number[]; results: ReviewResult[] }) => {
              m.at.forEach((i, k) => (out[i] = m.results[k]))
              onDone?.(++done, jobs.length)
              feed()
            })
            w.on('error', reject)
            feed()
          }),
      ),
    )
  } finally {
    await Promise.all(pool.map((w) => w.terminate()))
  }
  return out
}
