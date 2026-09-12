/**
 * Judging a war, one turn at a time.
 *
 * The split is Risk's and it is the whole basis of the feature: every decision
 * produces two numbers that are never allowed to touch.
 *
 *   loss  how much worse your order set was than the best one available, priced
 *         before the jitter, in steps. This is the part you control.
 *   luck  what the resolution then did about it, relative to that expectation.
 *         This is the part you don't, and it is reported rather than blamed on you.
 *
 * What is different from Risk is the unit. A turn of Kessel is one decision — you
 * write orders for twenty-six formations and press one button — so a judgement
 * here covers a whole order set, and the alternatives it is compared against are
 * whole order sets too. See `price.ts` for why that has to be resolved rather than
 * integrated, and why it is resolved five times.
 *
 * The scoring is the smaller half. What makes a review teach anything is naming
 * the recurring error, and every fault named here comes with its own
 * counterfactual: the player's own orders with that one thing changed, priced on
 * the same seeds. So "leaving the last way out open, 4× −19" is not an
 * attribution of blame across a turn's loss — it is four occasions on which one
 * different order was measurably worth something.
 */
import type { PlayerId } from '../../engine/types'
import { evaluate } from '../../games/kessel/evaluate'
import { mapOf } from '../../games/kessel/map'
import type { GameMap } from '../../games/kessel/map'
import type { KesselState, Move, Order } from '../../games/kessel/types'
import { replay } from '../replay'
import type { Replay } from '../replay'
import type { Grade } from '../review'
import type { GameRecord } from '../store'
import { KESSEL_FAULT_LABEL, assaultsIn, priceTurn } from './price'
import type { Candidate, KesselFault, OrderSet } from './price'

export { KESSEL_FAULT_LABEL }
export type { KesselFault, OrderSet }

/**
 * Grade boundaries, in steps, anchored to what a step is worth in this game
 * rather than to round numbers.
 *
 * A corps is three steps and a side fields about seventy, so three steps is a
 * whole formation's worth of position given away in one turn, eight is an
 * operation and twenty is an army. That gives the bands a meaning a player can
 * check against the board in front of them, which "0.75 centipawns" never has.
 *
 * The bottom band is a full step because a turn is priced as an average over
 * five resolutions of a batch of twenty-six orders: real resolution, but not an
 * oracle, and flagging a turn it cannot tell apart from the best one is how a
 * review loses the reader.
 *
 * `npm run review-check:kessel` prints the distribution these come from — they
 * are percentiles of real play rather than numbers picked by eye.
 */
export const KESSEL_GRADE_CUTS: Array<{ grade: Grade; upTo: number }> = [
  { grade: 'best', upTo: 1 },
  { grade: 'good', upTo: 3 },
  { grade: 'inaccuracy', upTo: 8 },
  { grade: 'mistake', upTo: 20 },
  { grade: 'blunder', upTo: Infinity },
]

export const kesselGrade = (loss: number): Grade =>
  (KESSEL_GRADE_CUTS.find((g) => loss < g.upTo) as { grade: Grade }).grade

/** Worth stopping on when skipping through a war. */
export const isNotableTurn = (g: Grade) => g === 'mistake' || g === 'blunder'

/**
 * What a fault has to have been worth before it is worth saying: the same figure
 * below which a turn is graded as good as anything else.
 *
 * Tied to that band rather than picked, so the panel cannot say "as good as
 * anything else available" and then list two things to do differently.
 */
const FINDING_FLOOR = KESSEL_GRADE_CUTS[0].upTo

/**
 * What a habit has to have cost, in total, before it is named as one.
 *
 * Six steps is two corps' worth of position given away across a war. Below it,
 * "you did this three times" is a coincidence being promoted to a lesson.
 */
const HABIT_FLOOR = 6

/** One fault on one turn, with what fixing only that would have been worth. */
export interface Finding {
  fault: KesselFault
  /** steps the one-change alternative was worth over what was played. Never negative. */
  cost: number
  advice: string
}

export interface KesselJudgement {
  /** index into `replay.states`: the board the orders were written on */
  index: number
  /** index into `record.moves` of the commit that resolved them */
  commit: number
  turn: number
  player: PlayerId
  orders: OrderSet
  /** the best order set found, and what it was */
  best: OrderSet
  bestLabel: string
  evPlayed: number
  evBest: number
  /** steps the turn cost against the best available. Never negative. */
  loss: number
  grade: Grade
  /** what the resolution did relative to expectation, in steps */
  luck: number
  note: string
  /** what to fix, dearest first — each priced by its own counterfactual */
  findings: Finding[]
}

export interface KesselHabit {
  fault: KesselFault
  /** how many turns it showed up on, and what it was worth across them */
  count: number
  cost: number
}

export interface KesselPlayerReview {
  player: PlayerId
  decisions: number
  /** mean steps given up per turn — the headline number */
  meanLoss: number
  totalLoss: number
  /** net steps the resolution handed you (positive) or took (negative) */
  luck: number
  grades: Record<Grade, number>
  habits: KesselHabit[]
}

export interface KesselGameReview {
  replay: Replay<KesselState>
  judgements: KesselJudgement[]
  byPlayer: KesselPlayerReview[]
  reviewed: PlayerId[]
  error: string | null
}

/** A review's verdicts without the boards behind them — what crosses the worker boundary. */
export type KesselVerdicts = Pick<KesselGameReview, 'judgements' | 'byPlayer' | 'reviewed'>

export interface KesselReviewOptions {
  /** seats to judge. Defaults to every human seat. */
  players?: PlayerId[]
  onProgress?(done: number, total: number): void
}

/** One decision: the board the orders were written on, and the orders that were given. */
interface Decision {
  at: number
  commit: number
  turn: number
  player: PlayerId
  orders: OrderSet
}

/**
 * Every turn in the record, as the decision it was.
 *
 * A turn is a run of `order` moves ended by one `commit`, so the board at the
 * start of the run is what the player was looking at and the orders staged at the
 * commit are what they chose. Terms moves end a run without being one — a side
 * whose will is spent has no orders left to give, so there is no decision there
 * to grade.
 */
function decisionsOf(r: Replay<KesselState>, record: GameRecord): Decision[] {
  const out: Decision[] = []
  let start = 0
  for (let i = 0; i < record.moves.length && i + 1 < r.states.length; i++) {
    const mv = record.moves[i] as Move
    if (mv.type === 'order' || mv.type === 'clearOrder' || mv.type === 'moveHq') continue
    if (mv.type === 'commit') {
      const s = r.states[start]
      if (s && s.phase === 'orders' && s.current === r.states[i].current) {
        out.push({
          at: start,
          commit: i,
          turn: s.turn,
          player: s.current,
          orders: r.states[i].orders,
        })
      }
    }
    start = i + 1
  }
  return out
}

export function reviewKesselGame(
  record: GameRecord,
  opts: KesselReviewOptions = {},
): KesselGameReview {
  if (record.game !== 'kessel') throw new Error(`not a Kessel game: ${record.game}`)
  const r = replay<KesselState>(record)
  const reviewed =
    opts.players ??
    record.seats.map((seat, id) => (seat.bot === null ? id : -1)).filter((id) => id >= 0)
  const wanted = new Set(reviewed)

  const decisions = decisionsOf(r, record).filter((d) => wanted.has(d.player))
  const judgements: KesselJudgement[] = []
  let done = 0

  for (const d of decisions) {
    opts.onProgress?.(++done, decisions.length)
    const s = r.states[d.at]
    const m = mapOf(s.mapId)
    // Seeded off the record and the turn, so a war reviews identically however
    // often it is opened — advice that changed between viewings is
    // indistinguishable from a bug.
    const base = (Math.imul(record.seed ^ 0x1eaf, 2246822519) + d.commit) | 0
    const { played, candidates } = priceTurn(s, d.orders, d.player, base)

    let best = played
    for (const c of candidates) if (c.value > best.value) best = c
    const loss = Math.max(0, best.value - played.value)
    const grade = kesselGrade(loss)

    // Luck is what the one resolution that actually happened did against the
    // average of five that might have. It is the only place in here the real
    // outcome is read, and it never touches `loss`.
    const luck = evaluate(r.states[d.commit + 1], d.player) - played.value

    const findings = findingsFrom(candidates, played.value)
    judgements.push({
      index: d.at,
      commit: d.commit,
      turn: d.turn,
      player: d.player,
      orders: d.orders,
      best: best.orders,
      bestLabel: best.key === 'played' ? 'your orders' : best.label,
      evPlayed: played.value,
      evBest: best.value,
      loss,
      grade,
      luck,
      note: explain(m, s, d.player, best, loss),
      findings,
    })
  }

  return {
    replay: r,
    judgements,
    byPlayer: reviewed.map((p) => summarise(p, judgements)),
    reviewed,
    error: r.error,
  }
}

/**
 * What each named fault was worth on this turn.
 *
 * One fault can have several candidates behind it — three thin attacks are three
 * separate ways to drop one — so the dearest stands for it, with its own advice.
 * The costs are independent counterfactuals rather than a partition of the turn's
 * loss, and they are not expected to sum to it: fixing two things at once is
 * usually worth less than the two fixes added up, and sometimes more.
 */
function findingsFrom(candidates: Candidate[], played: number): Finding[] {
  const best = new Map<KesselFault, Finding>()
  for (const c of candidates) {
    if (!c.fault) continue
    const cost = Math.max(0, c.value - played)
    if (cost < FINDING_FLOOR) continue
    const had = best.get(c.fault)
    if (!had || cost > had.cost) best.set(c.fault, { fault: c.fault, cost, advice: c.advice })
  }
  return [...best.values()].sort((a, b) => b.cost - a.cost)
}

function summarise(player: PlayerId, all: KesselJudgement[]): KesselPlayerReview {
  const mine = all.filter((j) => j.player === player)
  const grades: Record<Grade, number> = {
    best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0,
  }
  let totalLoss = 0
  let luck = 0
  const habits = new Map<KesselFault, KesselHabit>()
  for (const j of mine) {
    grades[j.grade]++
    totalLoss += j.loss
    luck += j.luck
    for (const f of j.findings) {
      const h = habits.get(f.fault) ?? { fault: f.fault, count: 0, cost: 0 }
      h.count++
      h.cost += f.cost
      habits.set(f.fault, h)
    }
  }
  return {
    player,
    decisions: mine.length,
    totalLoss,
    meanLoss: mine.length ? totalLoss / mine.length : 0,
    luck,
    grades,
    // Once is a bad turn; twice is how you fight a war. A habit named off one
    // turn would be the per-turn verdict again, wearing a summary's clothes.
    habits: [...habits.values()]
      .filter((h) => h.count > 1 && h.cost >= HABIT_FLOOR)
      .sort((a, b) => b.cost - a.cost),
  }
}

// ─────────────────────────── saying why ───────────────────────────

/**
 * An order set as a sentence.
 *
 * Twenty-six orders will not fit on a panel and would not be read if they did, so
 * this is the shape of the turn: how much of the army fought, how much moved, how
 * much stood still, and where the weight of the attack went. The map underneath
 * carries the detail — the review draws an order set exactly the way the live game
 * draws staged orders, so the arrows are the list.
 */
export function describeOrders(
  m: GameMap,
  s: KesselState,
  orders: OrderSet,
  me: PlayerId,
): string {
  const mine = s.formations.filter((f) => f.owner === me)
  const count = (t: Order['type']) => mine.filter((f) => orders[f.id]?.type === t).length
  const assaults = assaultsIn(m, s, orders, me)
  const bits: string[] = []

  if (assaults.length > 0) {
    const weight = [...assaults].sort((a, b) => b.committed.length - a.committed.length)[0]
    bits.push(
      assaults.length === 1
        ? `attack ${m.province[weight.to].name} at ${odds(weight.ratio)}`
        : `${assaults.length} attacks, the weight on ${m.province[weight.to].name} at ${odds(weight.ratio)}`,
    )
  }
  const moves = count('move')
  if (moves > 0) bits.push(`${moves} advancing`)
  const refits = count('refit')
  if (refits > 0) bits.push(`${refits} refitting`)
  // Standing still is digging in, ordered or not.
  const held = mine.length - moves - refits - count('attack')
  if (held > 0) bits.push(`${held} digging in`)
  return bits.length ? bits.join(', ') : 'nothing ordered'
}

const odds = (r: number) => (r === Infinity ? 'no defence' : `${r.toFixed(2)}:1`)

/**
 * What the whole number in the corner is accounting for.
 *
 * Only the plan-level comparison: which alternative won and by how much. The
 * advice belongs to the findings underneath, each with its own price, and saying
 * the dearest one twice on the same panel reads as the review having one idea.
 * When there is nothing to name, the two order summaries above this line are the
 * comparison, which is why it does not try to restate them.
 */
function explain(
  m: GameMap,
  s: KesselState,
  me: PlayerId,
  best: Candidate,
  loss: number,
): string {
  // A finding can never cost more than the loss, and the floor for one is the
  // same figure this band ends at, so a turn in here has nothing named against it.
  if (loss < KESSEL_GRADE_CUTS[0].upTo) return 'As good as anything else on offer this turn.'
  return `${cap(best.label)} — ${describeOrders(m, s, best.orders, me)} — were worth ${loss.toFixed(
    1,
  )} steps more.`
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
