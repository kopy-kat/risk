/// <reference lib="webworker" />
/**
 * Judging a war off the main thread, for the reason `../review.worker.ts` gives:
 * straight-line arithmetic with no yield points in it, and a lot of it. Each turn
 * resolves a dozen alternative order sets five times each through the engine, so
 * a long war is tens of thousands of hypothetical turns. On the main thread that
 * is a locked tab under the word "Analysing", which a viewer cannot tell apart
 * from a crash.
 */
import { reviewKesselGame } from './review'
import type { KesselVerdicts } from './review'
import type { GameRecord } from '../store'

/** What comes back out, in the order it arrives: progress until the verdicts. */
export type FromKesselReviewWorker =
  | { kind: 'progress'; done: number; total: number }
  | { kind: 'done'; verdicts: KesselVerdicts }

declare const self: DedicatedWorkerGlobalScope

self.onmessage = ({ data }: MessageEvent<GameRecord>) => {
  const { judgements, byPlayer, reviewed } = reviewKesselGame(data, {
    onProgress: (done, total) => self.postMessage({ kind: 'progress', done, total }),
  })
  self.postMessage({ kind: 'done', verdicts: { judgements, byPlayer, reviewed } })
}
