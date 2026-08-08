/**
 * Play a pile of games across worker threads.
 *
 * Games are independent and fully determined by their seed, so this is
 * embarrassingly parallel and the results are identical to running them in a
 * row — outcomes come back indexed and are reassembled in job order, never in
 * completion order.
 *
 * Batches are small on purpose. Game length varies by an order of magnitude
 * between pairings (a blitzer duel is 11 turns, a table of turtles is 600), so
 * handing each worker a contiguous quarter of the list would leave most of them
 * idle waiting for one. Several batches per worker, handed out as they finish,
 * costs nothing and keeps every core busy to the end.
 */
import { cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import { fallbacks, resetFallbacks } from '../src/bots/play'
import { playMatch } from './match'
import type { Job, Outcome } from './match'

/** Leave a couple of cores for the OS and whatever else the machine is doing. */
export const defaultWorkers = (): number => Math.max(1, Math.min(16, cpus().length - 2))

export interface PlayResult {
  outcomes: Outcome[]
  fallbacks: Record<string, number>
}

export async function playGames(jobs: Job[], workers = defaultWorkers()): Promise<PlayResult> {
  // A thread costs a few hundred milliseconds to start, since it re-imports the
  // whole module graph before it can play anything. That is worth paying as soon
  // as there is more than a batch or two of work, and not before.
  if (workers <= 1 || jobs.length < workers * 2) {
    resetFallbacks()
    return { outcomes: jobs.map(playMatch), fallbacks: { ...fallbacks } }
  }

  const outcomes: Outcome[] = Array.from({ length: jobs.length })
  const tally: Record<string, number> = {}
  const batchSize = Math.max(1, Math.ceil(jobs.length / (workers * 4)))
  let next = 0

  const pool = Array.from(
    { length: Math.min(workers, Math.ceil(jobs.length / batchSize)) },
    () => new Worker(new URL('./game-worker.ts', import.meta.url)),
  )

  try {
    await Promise.all(
      pool.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const feed = () => {
              if (next >= jobs.length) return resolve()
              const at = []
              for (let i = 0; i < batchSize && next < jobs.length; i++, next++) at.push(next)
              w.postMessage({ at, jobs: at.map((i) => jobs[i]) })
            }
            w.on('message', (m: { at: number[]; outcomes: Outcome[]; fallbacks: Record<string, number> }) => {
              m.at.forEach((i, k) => (outcomes[i] = m.outcomes[k]))
              for (const [k, n] of Object.entries(m.fallbacks)) tally[k] = (tally[k] ?? 0) + n
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

  return { outcomes, fallbacks: tally }
}
