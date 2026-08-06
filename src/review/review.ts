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
import { winProb } from '../engine/combat'
import type { GameState, Move, PlayerId } from '../engine/types'
import { rngFrom } from '../engine/rng'
import { marshalBot } from '../bots/marshal'
import type { Bot } from '../bots/types'
import {
  candidateMoves,
  evalMove,
  moveKey,
  objective,
  pressureAfter,
  rivalCount,
  settle,
} from '../bots/strategy/lookahead'
import { breaksContinent, completesContinent, isBorder } from '../bots/strategy/board-sense'
import { replay } from './replay'
import type { Replay } from './replay'
import type { GameRecord } from './store'

export type Grade = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'

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
  note: string
}

export interface PlayerReview {
  player: PlayerId
  decisions: number
  /** mean armies given up per decision — the headline accuracy number */
  meanLoss: number
  totalLoss: number
  /** net armies the dice handed you (positive) or took (negative) */
  luck: number
  grades: Record<Grade, number>
}

export interface GameReview {
  replay: Replay
  judgements: Judgement[]
  byPlayer: PlayerReview[]
  /** which seats were judged */
  reviewed: PlayerId[]
  error: string | null
}

export interface ReviewOptions {
  /** seats to judge. Defaults to every human seat. */
  players?: PlayerId[]
  /** the reference opponent whose judgement is being borrowed */
  bot?: Bot
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

  for (let i = 0; i < r.states.length - 1; i++) {
    const s = r.states[i]
    const played = record.moves[i]
    const me = s.current
    if (!wanted.has(me) || assisted.has(i)) continue

    const divisor = rivalCount(s, me)
    const options = candidatesWith(s, bot, me, rand)
    // A forced move is not a decision, and grading one is noise.
    if (options.length < 2) continue

    let best = options[0]
    let evBest = -Infinity
    for (const m of options) {
      const ev = evalMove(s, m, me, divisor)
      if (ev > evBest) {
        evBest = ev
        best = m
      }
    }

    const evPlayed = evalMove(s, played, me, divisor)
    // The played move is always in the candidate set in principle, but floating
    // point and the single-roll trim mean it can price a hair above the winner.
    const loss = Math.max(0, evBest - evPlayed)
    const grade = gradeFor(loss)

    // Luck is measured against the same modelled split the expectation used, which
    // is what `settle` is for — otherwise the two would be scored at different
    // points in the turn and the gap would look like fortune.
    const luck =
      played.type === 'attack' || played.type === 'blitz'
        ? objective(settle(r.states[i + 1]), me, divisor) - evPlayed
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
      note: explain(s, me, played, best, loss),
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
    if (!seen.has(moveKey(pick))) out.push(pick)
  } catch {
    // a bot that throws just doesn't contribute a candidate
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
  for (const j of mine) {
    grades[j.grade]++
    totalLoss += j.loss
    if (j.luck !== null) luck += j.luck
  }
  return {
    player,
    decisions: mine.length,
    totalLoss,
    meanLoss: mine.length ? totalLoss / mine.length : 0,
    luck,
    grades,
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
 * Why the recommendation is better, in the terms the bot actually reasons in.
 *
 * Every clause here comes from a signal the strategist itself uses — continent
 * completion, denial, holdability, exact odds. That's deliberate: an explanation
 * generated separately from the decision would be a plausible-sounding story
 * about a number it had no part in producing.
 */
function explain(s: GameState, me: PlayerId, played: Move, best: Move, loss: number): string {
  if (loss < GRADE_CUTS[0].upTo) return 'As good as anything else available.'

  // The recommendation is already spelled out in the row above this, so the note
  // says *why* rather than repeating *what*.
  const why = merit(s, me, best)
  const fault = critique(s, me, played)
  return [why ? `${cap(why)}.` : '', fault].filter(Boolean).join(' ')
}

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
      bits.push(p > 0.8 ? `it's ${pct(p)} and costs little` : 'it is the best value on the board')
    }
    return bits.join(', and ')
  }
  if (m.type === 'deploy') {
    return isBorder(s, me, m.territory)
      ? 'those armies would be in contact with the enemy'
      : 'it builds the stack that does the work'
  }
  if (m.type === 'tradeCards') return 'the set is worth more spent than held'
  if (m.type === 'endAttack') return 'there was nothing left worth the armies'
  if (m.type === 'fortify') return 'it puts the armies where the pressure is'
  if (m.type === 'placeInitial') return 'it strengthens the ground you actually want'
  return ''
}

/** What was wrong with what happened instead. */
function critique(s: GameState, me: PlayerId, m: Move): string {
  if (m.type === 'blitz' || m.type === 'attack') {
    const a = s.troops[m.from]
    const d = s.troops[m.to]
    const p = winProb(a, d)
    if (p < 0.4) return `Yours was only ${pct(p)}.`
    const after = pressureAfter(s, me, m.from, m.to)
    if (after > a * 1.4) return `You'd have taken ${name(m.to)} into ${after} enemy armies.`
    return ''
  }
  if (m.type === 'endAttack') return 'You stopped with armies still in contact.'
  if (m.type === 'deploy' && !isBorder(s, me, m.territory))
    return `${name(m.territory)} is interior — those armies were out of the game.`
  if (m.type === 'endTurn' && s.canFortify) return 'You left your fortify unused.'
  return ''
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
