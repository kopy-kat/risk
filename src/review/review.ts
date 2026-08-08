/**
 * Judging a played game, one decision at a time.
 *
 * The model is backgammon's, not chess's. Chess review works by scoring the
 * position after your move, because the position after your move is a fact. Risk
 * rolls dice, so "what happened" and "what you chose" are different questions and
 * conflating them produces advice nobody should take — attack at 75%, lose the
 * roll, get told you blundered.
 *
 * So every decision produces two independent numbers:
 *
 *   loss  how much worse your move was than the best one available, priced before
 *         the dice, in armies. This is the part you control.
 *   luck  what the dice then did about it, relative to expectation. This is the
 *         part you don't, and it is reported separately rather than blamed on you.
 */
import { CONTINENTS, TERRITORY_NAMES } from '../engine/board'
import type { ContinentId, TerritoryId } from '../engine/board'
import { expectedSurvivors, winProb } from '../engine/combat'
import { applyMove } from '../engine/game'
import type { GameState, Move, Phase, PlayerId } from '../engine/types'
import { rngFrom } from '../engine/rng'
import { marshalBot } from '../bots/marshal'
import type { Bot } from '../bots/types'
import {
  candidateMoves,
  evalLine,
  evalMove,
  moveKey,
  objective,
  pressureAfter,
  rivalCount,
  settle,
} from './price'
import { breaksContinent, completesContinent, isBorder, pressure } from '../bots/strategy/board-sense'
import { replay } from './replay'
import type { Replay } from './replay'
import type { GameRecord } from './store'

export type Grade = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'

/**
 * The recurring ways a turn is thrown away.
 *
 * One graded move is a verdict on a move. The same verdict eleven times is a
 * verdict on how someone plays, and that is the thing worth telling them — a
 * hundred and thirty separate judgements is a transcript, not advice. The list is
 * short on purpose: these are the faults the evaluator can name from what it
 * already computed, not every way a game can go wrong.
 */
export type Fault = 'long-odds' | 'unholdable' | 'stopped-early' | 'interior-deploy' | 'no-fortify'

export const FAULT_LABEL: Record<Fault, string> = {
  'long-odds': 'attacking at long odds',
  unholdable: "taking ground you can't hold",
  'stopped-early': 'stopping with attacks still on the board',
  'interior-deploy': 'deploying away from the fighting',
  'no-fortify': 'ending the turn without fortifying',
}

/**
 * Grade boundaries, in armies, anchored to what an army is actually worth in
 * this game rather than to round numbers.
 *
 * A turn's reinforcement runs 3–15 armies, so roughly ten armies is a wasted
 * turn and twenty-five is a wasted couple. That gives the bands a meaning a
 * player can check against their own experience, which "0.75 centipawns" never
 * has.
 *
 * The bottom band is generous on purpose. The evaluator is a heuristic, not an
 * oracle, and flagging a decision it cannot really tell apart from the best one
 * is exactly how a review feature loses the user's trust.
 *
 * `npm run review-check` prints the resulting distribution per bot tier, which
 * is the check that these separate strength rather than just sorting noise.
 */
export const GRADE_CUTS: Array<{ grade: Grade; upTo: number }> = [
  { grade: 'best', upTo: 1 },
  { grade: 'good', upTo: 4 },
  { grade: 'inaccuracy', upTo: 10 },
  { grade: 'mistake', upTo: 25 },
  { grade: 'blunder', upTo: Infinity },
]

export const gradeFor = (loss: number): Grade =>
  (GRADE_CUTS.find((g) => loss < g.upTo) as { grade: Grade }).grade

/**
 * Worth stopping on when skipping through a game.
 *
 * Inaccuracies are graded and coloured but deliberately not navigated to: a game
 * runs to well over a hundred of your own decisions, so including them would
 * make "next mistake" walk you through a third of the game.
 */
export const isNotable = (g: Grade) => g === 'mistake' || g === 'blunder'

/**
 * Reinforcement, and only reinforcement, is judged by playing the turn out.
 *
 * Two of the other phases have nothing left in the turn to play, so a rollout there
 * returns the static value exactly (see `evalLine`) at a hundred times the cost: an
 * initial placement hands straight over to the next player, and a fortify is
 * followed only by `endTurn`.
 *
 * Attacks and occupations are the interesting exclusions, because a rollout does say
 * something new about both — how much of a stack to advance is a question about what
 * you can do next, and one ply cannot see it. Widening this set has been measured
 * twice, on two different sets of rules, and both times it made the reviewer *worse
 * at telling the tiers apart* on every pair at once: pairs that separated stopped
 * separating, the error bars widened everywhere, and `review-check` failed outright.
 * It also costs several times as much. Widen it only behind a `review-check 20`, and
 * read the second, both-won line — the first one moves when a bot's stall rate does.
 *
 * The reason is the durable part, because it says where the technique belongs at all:
 * **roll out where one ply is blind, never where it is exact.** An attack's value is
 * already integrated over its exact outcome distribution, so rolling one out replaces
 * an exact number with that same number plus a policy's guess about the rest of the
 * turn — strictly more noise, no more signal. A deploy has no exact number to
 * replace: armies in hand buy nothing until they're spent, which is what makes turn
 * context worth its cost there and nowhere else.
 */
const DEEP_PHASES = new Set<Phase>(['deploy'])

export interface Judgement {
  /** index into `record.moves`, and into `replay.states` for the board before it */
  index: number
  turn: number
  player: PlayerId
  played: Move
  best: Move
  evPlayed: number
  evBest: number
  /** how many armies the choice cost, priced before the dice. Never negative. */
  loss: number
  grade: Grade
  /** attacks only: what the dice did relative to expectation, in armies */
  luck: number | null
  /**
   * What the recommendation was *for*: `best`, then how the reference policy spent
   * the rest of the turn behind it. A single move is often unreadable on its own —
   * "deploy 1 to Ural" means nothing until you see it followed by the attack it
   * was buying.
   */
  line: Move[]
  note: string
  /** the named fault behind the note, when there was one to name */
  fault: Fault | null
}

export interface Habit {
  fault: Fault
  /** how many decisions it cost, and how many armies in total */
  count: number
  armies: number
}

/**
 * What a habit has to have cost before it's worth naming.
 *
 * A turn's reinforcement is 3–15 armies, so ten is roughly a turn thrown away —
 * the same anchor `GRADE_CUTS` uses. Below it, "you did this twice" is a coincidence
 * being promoted to a diagnosis.
 */
const HABIT_FLOOR = 10

export interface PlayerReview {
  player: PlayerId
  decisions: number
  /** mean armies given up per decision — the headline accuracy number */
  meanLoss: number
  totalLoss: number
  /** net armies the dice handed you (positive) or took (negative) */
  luck: number
  grades: Record<Grade, number>
  /**
   * What went wrong more than once, dearest first.
   *
   * Deliberately not accompanied by a per-phase accuracy split, tempting as it is:
   * only deploys are priced a turn deep (see `DEEP_PHASES`), so their losses are
   * measured against a wider field of alternatives than an attack's. Printing the
   * two side by side would read as "your deploys are your weakness" when the
   * difference is in the measurement.
   */
  habits: Habit[]
}

export interface GameReview {
  replay: Replay
  judgements: Judgement[]
  byPlayer: PlayerReview[]
  /** which seats were judged */
  reviewed: PlayerId[]
  error: string | null
}

/**
 * A review's verdicts without the boards behind them.
 *
 * What crosses the worker boundary in `review.worker.ts`: `replay.states` is a
 * thousand full positions for a long game, and `replay` rebuilds them from the
 * record in milliseconds, so recomputing them on the receiving side costs less
 * than cloning them across.
 */
export type Verdicts = Pick<GameReview, 'judgements' | 'byPlayer' | 'reviewed'>

export interface ReviewOptions {
  /** seats to judge. Defaults to every human seat. */
  players?: PlayerId[]
  /** the reference opponent whose judgement is being borrowed */
  bot?: Bot
  /**
   * Called as each decision is taken up, so a caller can show something moving.
   * A long game is tens of seconds of arithmetic and a still screen is
   * indistinguishable from a hang.
   */
  onProgress?(done: number, total: number): void
}

export function reviewGame(record: GameRecord, opts: ReviewOptions = {}): GameReview {
  const r = replay(record)
  const bot = opts.bot ?? marshalBot
  const reviewed =
    opts.players ??
    record.seats.map((seat, id) => (seat.bot === null ? id : -1)).filter((id) => id >= 0)
  const wanted = new Set(reviewed)
  const assisted = new Set(record.assisted)

  const judgements: Judgement[] = []
  // Seeded so a game reviews identically every time it's opened — the bot's own
  // `decide` may draw from it, and advice that changed between viewings would be
  // indistinguishable from a bug.
  const rng = rngFrom((record.seed ^ 0x1eaf) >>> 0)
  const rand = () => rng.next()

  // The denominator has to be known before the first one is judged, and which
  // moves count is a property of the record rather than of the pricing, so it's
  // a scan of the seats rather than a first pass over the work itself.
  let total = 0
  for (let i = 0; i < r.states.length - 1; i++) {
    if (wanted.has(r.states[i].current) && !assisted.has(i)) total++
  }
  let done = 0

  for (let i = 0; i < r.states.length - 1; i++) {
    const s = r.states[i]
    const played = record.moves[i]
    const me = s.current
    if (!wanted.has(me) || assisted.has(i)) continue
    opts.onProgress?.(++done, total)

    const divisor = rivalCount(s, me)
    const options = candidatesWith(s, bot, me, rand)
    // A forced move is not a decision, and grading one is noise.
    if (options.length < 2) continue

    const price = DEEP_PHASES.has(s.phase)
      ? (m: Move) => evalLine(s, m, me, divisor, bot, rand)
      : (m: Move) => ({ value: evalMove(s, m, me, divisor), moves: [m] })

    const playedKey = moveKey(played)
    let best = options[0]
    let evBest = -Infinity
    let line: Move[] = [best]
    let evPlayed: number | null = null
    for (const m of options) {
      const priced = price(m)
      if (moveKey(m) === playedKey) evPlayed = priced.value
      if (priced.value > evBest) {
        evBest = priced.value
        best = m
        line = priced.moves
      }
    }
    // The played move is in the candidate set in all but a corner case — a fortify
    // size `spread` doesn't sample, say — so it usually costs nothing to price.
    if (evPlayed === null) evPlayed = price(played).value

    // The played move is always in the candidate set in principle, but floating
    // point and the single-roll trim mean it can price a hair above the winner.
    const loss = Math.max(0, evBest - evPlayed)
    const grade = gradeFor(loss)

    // Luck stays a one-ply quantity whatever the loss is priced at: it is what the
    // dice did to *this* move, so it compares the board they produced against what
    // the move was worth before them. Measured against the same modelled split the
    // expectation used, which is what `settle` is for — otherwise the two would be
    // scored at different points in the turn and the gap would look like fortune.
    const luck =
      played.type === 'attack' || played.type === 'blitz'
        ? objective(settle(r.states[i + 1]), me, divisor) - evalMove(s, played, me, divisor)
        : null

    judgements.push({
      index: i,
      turn: s.turn,
      player: me,
      played,
      best,
      evPlayed,
      evBest,
      loss,
      grade,
      luck,
      line,
      ...explain(s, me, played, best, loss),
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
 * What to compare against: everything the interface could have done, plus the
 * bot's own pick.
 *
 * The union matters. `legalMoves` offers deploys of one army or all of them and
 * fortifies at three sampled sizes, because it exists to bound a bot's branching
 * factor — so on its own it would compare the player against a deliberately coarse
 * menu and call the gaps mistakes.
 */
function candidatesWith(s: GameState, bot: Bot, me: PlayerId, rand: () => number): Move[] {
  const out = candidateMoves(s)
  const seen = new Set(out.map(moveKey))
  try {
    const pick = bot.decide(s, me, rand)
    // A bot may return an illegal move — the game loop is allowed to fall back to a
    // random one, so this is a supported outcome rather than a bug. It must not
    // reach the pricing, which would either throw or recommend an unplayable move.
    if (!seen.has(moveKey(pick))) {
      applyMove(s, pick)
      out.push(pick)
    }
  } catch {
    // a bot that throws, or offers something illegal, contributes no candidate
  }
  return out
}

function summarise(player: PlayerId, all: Judgement[]): PlayerReview {
  const mine = all.filter((j) => j.player === player)
  const grades: Record<Grade, number> = {
    best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0,
  }
  let totalLoss = 0
  let luck = 0
  const habits = new Map<Fault, Habit>()
  for (const j of mine) {
    grades[j.grade]++
    totalLoss += j.loss
    if (j.luck !== null) luck += j.luck
    if (j.fault) {
      const h = habits.get(j.fault) ?? { fault: j.fault, count: 0, armies: 0 }
      h.count++
      h.armies += j.loss
      habits.set(j.fault, h)
    }
  }
  return {
    player,
    decisions: mine.length,
    totalLoss,
    meanLoss: mine.length ? totalLoss / mine.length : 0,
    luck,
    grades,
    // Once is a bad move; twice is how you play. A habit named off a single
    // decision would be the per-move verdict again, wearing a summary's clothes.
    habits: [...habits.values()]
      .filter((h) => h.count > 1 && h.armies >= HABIT_FLOOR)
      .sort((a, b) => b.armies - a.armies),
  }
}

// ─────────────────────────── saying why ───────────────────────────

const name = (t: TerritoryId) => TERRITORY_NAMES[t] ?? t
const continent = (c: ContinentId) => CONTINENTS[c].name
const pct = (p: number) => `${Math.round(p * 100)}%`

/** A move as a short phrase, for the move list and the advice line. */
export function describeMove(s: GameState, m: Move): string {
  switch (m.type) {
    case 'placeInitial':
      return `reinforce ${name(m.territory)}`
    case 'tradeCards':
      return 'cash a set'
    case 'deploy':
      return `deploy ${m.count} to ${name(m.territory)}`
    case 'attack':
      return `attack ${name(m.to)} from ${name(m.from)}`
    case 'blitz':
      return `attack ${name(m.to)} from ${name(m.from)} (${pct(
        winProb(s.troops[m.from], s.troops[m.to]),
      )})`
    case 'occupy':
      return `advance ${m.count}`
    case 'endAttack':
      return 'stop attacking'
    case 'fortify':
      return `move ${m.count} from ${name(m.from)} to ${name(m.to)}`
    case 'endTurn':
      return 'end the turn'
  }
}

/**
 * A move as a plan rather than an instruction, for the moves behind the
 * recommendation. No odds: they'd be read against the board on screen, and every
 * step of a continuation happens on a board that doesn't exist yet.
 */
function intent(m: Move): string {
  switch (m.type) {
    case 'attack':
    case 'blitz':
      return `take ${name(m.to)}`
    case 'deploy':
      return `${m.count} more to ${name(m.territory)}`
    case 'tradeCards':
      return 'cash a set'
    case 'fortify':
      return `move ${m.count} up to ${name(m.to)}`
    case 'placeInitial':
      return `reinforce ${name(m.territory)}`
    case 'occupy':
      return `advance ${m.count}`
    case 'endAttack':
      return 'stop attacking'
    case 'endTurn':
      return 'end the turn'
  }
}

/**
 * What the recommendation was in aid of.
 *
 * The move itself is already on screen; this is the rest of the turn behind it,
 * and it's the part that makes a recommendation like "deploy 1 to Ural" mean
 * anything at all. Occupations are dropped — advancing after a capture is the
 * second half of an attack, not a separate intention — and so is the end of the
 * turn, which is where every line finishes and so distinguishes none of them.
 *
 * Three steps, because past that a line stops being the reason for a move and
 * starts being a forecast of a turn nobody has played yet.
 */
export function describeContinuation(line: Move[]): string {
  const rest = line
    .slice(1)
    .filter((m) => m.type !== 'occupy' && m.type !== 'endAttack' && m.type !== 'endTurn')
  if (!rest.length) return ''
  const shown = rest.slice(0, 3)
  // `legalMoves` offers a deploy of one army or of all of them, so a recommendation
  // to place one is routinely followed by the policy placing the rest in the same
  // spot. Naming the territory twice reads like two different ideas.
  const here = line[0].type === 'deploy' ? line[0].territory : null
  const phrases = shown.map((m) =>
    m.type === 'deploy' && m.territory === here ? `${m.count} more there` : intent(m),
  )
  return `then ${phrases.join(', ')}${rest.length > shown.length ? '…' : ''}`
}

/**
 * Why the recommendation is better, in the terms the bot actually reasons in.
 *
 * Every clause here comes from a signal the strategist itself uses — continent
 * completion, denial, holdability, exact odds. That's deliberate: an explanation
 * generated separately from the decision would be a plausible-sounding story
 * about a number it had no part in producing.
 */
function explain(
  s: GameState,
  me: PlayerId,
  played: Move,
  best: Move,
  loss: number,
): { note: string; fault: Fault | null } {
  if (loss < GRADE_CUTS[0].upTo) {
    return { note: 'As good as anything else available.', fault: null }
  }
  // The recommendation is already spelled out in the row above this, so the note
  // says *why* rather than repeating *what*.
  const why = merit(s, me, best)
  const wrong = critique(s, me, played, best)
  return {
    note: [why ? `${cap(why)}.` : '', wrong.text].filter(Boolean).join(' '),
    fault: wrong.fault,
  }
}

/** The chance an attack comes off, or null for anything that isn't one. */
const oddsOf = (s: GameState, m: Move): number | null =>
  m.type === 'blitz' || m.type === 'attack' ? winProb(s.troops[m.from], s.troops[m.to]) : null

/** What recommends a move. */
function merit(s: GameState, me: PlayerId, m: Move): string {
  if (m.type === 'blitz' || m.type === 'attack') {
    const to = m.to
    const bits: string[] = []
    const completes = completesContinent(s, me, to)
    if (completes) bits.push(`it completes ${continent(completes)}`)
    const breaks = breaksContinent(s, to)
    if (breaks && s.owner[to] !== me) bits.push(`it breaks ${continent(breaks)}`)
    const defender = s.players[s.owner[to]]
    if (defender && defender.id !== me) {
      const theirs = Object.values(s.owner).filter((o) => o === defender.id).length
      if (theirs === 1) bits.push(`it eliminates ${defender.name} and takes their hand`)
    }
    if (!bits.length) {
      const p = winProb(s.troops[m.from], s.troops[to])
      // What it leaves standing, not just what it's likely to take: an attack you
      // win with one army left is a territory you hand straight back.
      const left = Math.round(expectedSurvivors(s.troops[m.from], s.troops[to]))
      bits.push(
        p > 0.8
          ? `it's ${pct(p)} and should leave ${left} armies across the pair`
          : 'it is the best value on the board',
      )
    }
    return bits.join(', and ')
  }
  if (m.type === 'deploy') {
    if (!isBorder(s, me, m.territory)) return 'it builds the stack that does the work'
    const short = Math.round(pressure(s, me, m.territory) * 0.6) - s.troops[m.territory]
    return short > 0
      ? `${name(m.territory)} faces ${pressure(s, me, m.territory)} enemy armies and is ${short} short`
      : 'those armies would be in contact with the enemy'
  }
  if (m.type === 'tradeCards') return 'the set is worth more spent than held'
  if (m.type === 'endAttack') return 'there was nothing left worth the armies'
  if (m.type === 'fortify') return 'it puts the armies where the pressure is'
  if (m.type === 'placeInitial') return 'it strengthens the ground you actually want'
  return ''
}

/**
 * What was wrong with what happened instead, said against the recommendation
 * wherever the two are comparable.
 *
 * A criticism with one number in it is an assertion; with both it's an argument
 * the reader can check — and the numbers are the ones the grade was computed from,
 * so there's nothing to reconcile.
 */
function critique(
  s: GameState,
  me: PlayerId,
  m: Move,
  best: Move,
): { text: string; fault: Fault | null } {
  const theirs = oddsOf(s, best)
  if (m.type === 'blitz' || m.type === 'attack') {
    const a = s.troops[m.from]
    const p = winProb(a, s.troops[m.to])
    if (theirs !== null && theirs - p > 0.15)
      return { text: `Yours was ${pct(p)} against ${pct(theirs)}.`, fault: 'long-odds' }
    if (p < 0.4) return { text: `Yours was only ${pct(p)}.`, fault: 'long-odds' }
    const after = pressureAfter(s, me, m.from, m.to)
    if (after > a * 1.4)
      return {
        text: `You'd have taken ${name(m.to)} into ${after} enemy armies.`,
        fault: 'unholdable',
      }
    return { text: '', fault: null }
  }
  if (m.type === 'endAttack') {
    return {
      text:
        theirs !== null
          ? `You stopped with ${pct(theirs)} on the board.`
          : 'You stopped with armies still in contact.',
      fault: 'stopped-early',
    }
  }
  if (m.type === 'deploy' && !isBorder(s, me, m.territory))
    return {
      text: `${name(m.territory)} is interior — those armies were out of the game.`,
      fault: 'interior-deploy',
    }
  if (m.type === 'endTurn' && s.canFortify)
    return { text: 'You left your fortify unused.', fault: 'no-fortify' }
  return { text: '', fault: null }
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
