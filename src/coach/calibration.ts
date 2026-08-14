/**
 * Turning settled predictions into a read on someone's judgement.
 *
 * The measure is calibration, not accuracy. Being right less often than you
 * expected is not a mistake in play — it is a mistake in *belief*, and it is the
 * one thing a review of moves can never surface, because the board never records
 * what you thought was going to happen. So the report answers one question: when
 * you say 80%, how often are you right?
 *
 * Direction is the part worth reading. A 10-point gap that runs the same way
 * every time is a habit you can correct; a 25-point gap that changes sign is
 * eight predictions and no signal.
 */
import type { GameState, PlayerId } from '../engine/types'
import { replay } from '../review/replay'
import { getGame } from '../review/store'
import type { GameRecord } from '../review/store'
import { describeRow, recapBetween } from '../ui/recap'
import { CLAIM_LABEL, CONFIDENCE_STEPS, describeClaim, resolveClaim, turnWindows, windowFor } from './claims'
import type { Claim, ClaimKind } from './claims'
import { allNotes } from './store'
import type { TurnNote } from './store'

export interface Scored {
  gameId: string
  /** when the game was last written, so games sort into the order they were played */
  when: number
  turn: number
  claim: Claim
  confidence: number
  correct: boolean
  /** the claim as a sentence, resolved against the seats of its own game */
  said: string
}

export interface Bucket {
  confidence: number
  claims: number
  correct: number
  /** stated confidence minus fraction correct, in points: positive is overconfident */
  gap: number
}

export interface Bias {
  kind: ClaimKind
  claims: number
  gap: number
  sentence: string
}

export interface TrendPoint {
  gameId: string
  when: number
  claims: number
  brier: number
}

/** One turn's plan, against what the board did about it. */
export interface TurnRead {
  turn: number
  intent: string
  happened: string
  claim: string | null
  confidence: number
  correct: boolean | null
}

/**
 * Zero is perfect, 0.25 is a coin flip called at 50%, 1 is confidently wrong
 * every time. It is the only single number that punishes overconfidence and
 * underconfidence alike, which is why it and not accuracy is the headline.
 */
export const brierOf = (scored: Scored[]): number | null =>
  scored.length
    ? scored.reduce((sum, s) => sum + (s.confidence / 100 - (s.correct ? 1 : 0)) ** 2, 0) / scored.length
    : null

export function bucketsOf(scored: Scored[]): Bucket[] {
  return CONFIDENCE_STEPS.map((confidence) => {
    const here = scored.filter((s) => s.confidence === confidence)
    const correct = here.filter((s) => s.correct).length
    return {
      confidence,
      claims: here.length,
      correct,
      gap: here.length ? confidence - (correct / here.length) * 100 : 0,
    }
  }).filter((b) => b.claims > 0)
}

/** Below this a gap is a handful of coin flips, and naming it would be noise. */
const MIN_CLAIMS = 3
/** Below this a gap is inside what anyone's judgement can resolve. */
const MIN_GAP = 10

const BIAS_PHRASE: Record<ClaimKind, { over: string; under: string }> = {
  attackedBy: {
    over: 'you brace for attacks that never come',
    under: 'you consistently underestimate how often the table turns on you',
  },
  holdContinent: {
    over: 'you overrate your grip on a continent',
    under: 'you hold continents more often than you give yourself credit for',
  },
  territoriesAtLeast: {
    over: 'you overrate how much ground one turn wins you',
    under: 'you take more ground in a turn than you expect to',
  },
  cashes: {
    over: 'you expect the table to cycle cards faster than it does',
    under: 'you underestimate how fast a banked hand comes back at you',
  },
}

/**
 * The one bias worth naming. Grouped by what the claim was *about* rather than by
 * confidence, because "overconfident at 80%" is a number and "you brace for
 * attacks that never come" is something to do differently next game.
 */
export function biasOf(scored: Scored[]): Bias | null {
  let worst: Bias | null = null
  for (const kind of Object.keys(BIAS_PHRASE) as ClaimKind[]) {
    const here = scored.filter((s) => s.claim.kind === kind)
    if (here.length < MIN_CLAIMS) continue
    const said = here.reduce((sum, s) => sum + s.confidence, 0) / here.length
    const right = (here.filter((s) => s.correct).length / here.length) * 100
    const gap = said - right
    if (Math.abs(gap) < MIN_GAP) continue
    if (worst && Math.abs(gap) <= Math.abs(worst.gap)) continue
    worst = {
      kind,
      claims: here.length,
      gap,
      sentence:
        `On ${CLAIM_LABEL[kind]} you said ${Math.round(said)}% and were right ` +
        `${Math.round(right)}% of the time — ` +
        `${gap > 0 ? BIAS_PHRASE[kind].over : BIAS_PHRASE[kind].under}.`,
    }
  }
  return worst
}

export function trendOf(scored: Scored[]): TrendPoint[] {
  const byGame = new Map<string, Scored[]>()
  for (const s of scored) {
    const list = byGame.get(s.gameId)
    if (list) list.push(s)
    else byGame.set(s.gameId, [s])
  }
  return [...byGame.entries()]
    .map(([gameId, list]) => ({
      gameId,
      when: list[0].when,
      claims: list.length,
      brier: brierOf(list) as number,
    }))
    .sort((a, b) => a.when - b.when)
}

/** Which way the trend runs, or null when there aren't two games to compare. */
export function driftOf(trend: TrendPoint[]): 'sharpening' | 'holding' | 'slipping' | null {
  if (trend.length < 2) return null
  const half = Math.floor(trend.length / 2)
  const mean = (xs: TrendPoint[]) => xs.reduce((sum, t) => sum + t.brier, 0) / xs.length
  const delta = mean(trend.slice(trend.length - half)) - mean(trend.slice(0, half))
  if (delta < -0.02) return 'sharpening'
  if (delta > 0.02) return 'slipping'
  return 'holding'
}

const seatName = (record: GameRecord) => (p: PlayerId) => record.seats[p]?.name ?? `Seat ${p + 1}`

/** Every note of this game whose horizon has arrived, settled against the boards. */
export function scoreGame(record: GameRecord, states: GameState[], notes: TurnNote[]): Scored[] {
  const windows = turnWindows(states)
  const name = seatName(record)
  const out: Scored[] = []
  for (const note of notes) {
    if (!note.claim) continue
    const w = windowFor(windows, note.player, note.turn)
    if (!w) continue
    const correct = resolveClaim(note.claim, w, states)
    if (correct === null) continue
    out.push({
      gameId: record.id,
      when: record.savedAt,
      turn: note.turn,
      claim: note.claim,
      confidence: note.confidence,
      correct,
      said: describeClaim(note.claim, name),
    })
  }
  return out
}

/**
 * The player's own reasoning, turn by turn, against the scoreline of that turn.
 * The board delta comes from the same two-board comparison the live recap uses,
 * so what the report says happened is what the game said happened.
 */
export function readTurns(
  record: GameRecord,
  states: GameState[],
  notes: TurnNote[],
  player: PlayerId,
): TurnRead[] {
  const windows = turnWindows(states)
  const name = seatName(record)
  return notes
    .filter((n) => n.player === player)
    .sort((a, b) => a.turn - b.turn)
    .map((n) => {
      const w = windowFor(windows, n.player, n.turn)
      const row = w
        ? recapBetween(states[w.start], states[w.handover]).find((r) => r.player === player)
        : undefined
      return {
        turn: n.turn,
        intent: n.intent,
        happened: row ? describeRow(row, name) : 'nothing changed hands',
        claim: n.claim ? describeClaim(n.claim, name) : null,
        confidence: n.confidence,
        correct: w && n.claim ? resolveClaim(n.claim, w, states) : null,
      }
    })
}

/**
 * Settled predictions from every *other* stored game, re-derived by replaying
 * each one. Nothing is cached: a stored outcome would be a second copy of a fact
 * the move list already holds, and the two would eventually disagree.
 */
export function pastScores(exceptGameId: string): Scored[] {
  const byGame = new Map<string, TurnNote[]>()
  for (const n of allNotes()) {
    if (n.gameId === exceptGameId) continue
    const list = byGame.get(n.gameId)
    if (list) list.push(n)
    else byGame.set(n.gameId, [n])
  }
  const out: Scored[] = []
  for (const [id, notes] of byGame) {
    const rec = getGame(id)
    if (!rec) continue
    const { states } = replay(rec)
    if (states.length) out.push(...scoreGame(rec, states, notes))
  }
  return out
}
