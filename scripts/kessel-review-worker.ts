/**
 * Worker end of the Kessel review pool.
 *
 * The static imports are confined to `node:` builtins and the bare `tsx`
 * specifier for the reason `game-worker.ts` gives: a worker thread does not
 * inherit tsx's module hooks, so extensionless imports of project files fail
 * until `register()` has run.
 */
import { parentPort } from 'node:worker_threads'
import { register } from 'tsx/esm/api'

register()

const { runOne } = await import('./kessel-review-job')

parentPort!.on('message', (batch: import('./kessel-review-job').Batch) => {
  parentPort!.postMessage({ at: batch.at, results: batch.jobs.map(runOne) })
})
