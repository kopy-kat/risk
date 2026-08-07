/**
 * Worker end of the game pool. Plays batches of jobs and posts the outcomes back.
 *
 * The static imports here are deliberately confined to `node:` builtins and the
 * bare `tsx` specifier: a worker thread does not inherit tsx's module hooks, so
 * extensionless imports of project files fail until `register()` has run. Hence
 * the dynamic import below — moving it to the top of the file breaks the pool.
 */
import { parentPort } from 'node:worker_threads'
import { register } from 'tsx/esm/api'

register()

const { playMatch } = await import('./match')
const { fallbacks, resetFallbacks } = await import('../src/bots/play')

export interface Batch {
  /** indices into the parent's job list, so outcomes can be reassembled in order */
  at: number[]
  jobs: import('./match').Job[]
}

parentPort!.on('message', (batch: Batch) => {
  resetFallbacks()
  parentPort!.postMessage({
    at: batch.at,
    outcomes: batch.jobs.map(playMatch),
    fallbacks: { ...fallbacks },
  })
})
