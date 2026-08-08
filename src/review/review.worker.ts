/// <reference lib="webworker" />
/**
 * Judging a game off the main thread.
 *
 * `reviewGame` is straight-line arithmetic with no yield points in it, and a lot of
 * it: every deploy is priced by playing the rest of the turn out for each of up to
 * a hundred alternatives, so a long game runs tens of thousands of hypothetical
 * turns. On the main thread that is a locked tab under the word "Analysing", which
 * a viewer cannot tell apart from a crash — and no amount of making it faster fixes
 * that, because it would still be blocking.
 *
 * So the shape is the fix rather than the speed: the thread that draws stays free,
 * and the progress posted from in here is what says the difference between working
 * and hung.
 */
import { reviewGame } from './review'
import type { Verdicts } from './review'
import type { GameRecord } from './store'

/** What comes back out, in the order it arrives: progress until the verdicts. */
export type FromReviewWorker =
  | { kind: 'progress'; done: number; total: number }
  | { kind: 'done'; verdicts: Verdicts }

declare const self: DedicatedWorkerGlobalScope

self.onmessage = ({ data }: MessageEvent<GameRecord>) => {
  const { judgements, byPlayer, reviewed } = reviewGame(data, {
    onProgress: (done, total) => self.postMessage({ kind: 'progress', done, total }),
  })
  self.postMessage({ kind: 'done', verdicts: { judgements, byPlayer, reviewed } })
}
