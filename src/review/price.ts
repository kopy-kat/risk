/**
 * Pricing a move without rolling it.
 *
 * `assess` scores a *position*. To say anything about a *decision* you need the
 * value of a move before the dice land, which in Risk is not the same thing: a
 * 75% attack that fails was still the right move. Everything here is expectation,
 * computed analytically from the exact combat tables — nothing is simulated, so
 * the same move always prices the same.
 *
 * That distinction is the whole basis of the review feature. Judging a move by
 * what happened to it would grade luck and call it skill.
 *
 * ── Why this isn't the lookahead BOTS.md abandoned ──────────────────
 *
 * One-ply position scoring failed three times as a way for a bot to *choose* a
 * move, and was removed rather than left switched off. This lives in `src/review`
 * and no bot imports it, deliberately — but the resemblance is close enough to be
 * worth saying why it's sound here and wasn't there.
 *
 * The lookahead's fatal objection was depth: "the position after our capture says
 * little about the position after three replies." That objection is about
 * *predicting* a game that hasn't happened. Review isn't predicting anything — the
 * game is over, the replies are in the record, and the only question is what the
 * alternatives were worth at the moment of choice. For an attack, whose effect is
 * immediate, one ply is not an approximation of that answer; it *is* the question.
 *
 * A deploy is the exception, and `evalLine` is where it's handled: armies in hand
 * buy nothing until they're spent, so pricing one needs the rest of the turn. Still
 * no replies, and still nothing predicted — the horizon stops where your turn does.
 *
 * It's also downstream of the same fix. `assess` used to score 58% of clearly
 * favourable captures as losses, and a reviewer built on that would have told
 * people their good attacks were mistakes.
 */
import { ADJACENCY } from '../engine/board'
import type { TerritoryId } from '../engine/board'
import {
  attackerDice as diceFor,
  defenderDice,
  exchangeOdds,
  expectedDefendersLeft,
  expectedSurvivors,
  winProb,
} from '../engine/combat'
import { applyMove, legalMoves, territoriesOf } from '../engine/game'
import type { GameState, Move, PlayerId } from '../engine/types'
import { garrisonFor, isBorder, pressure } from '../bots/strategy/board-sense'
import { EXPOSURE_WEIGHT, assess } from '../bots/strategy/evaluate'
import type { Bot } from '../bots/types'

/** Winning dwarfs any positional consideration, but stays finite so deltas work. */
const WIN_SCORE = 500

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/** Live opponents at a decision point. Never below 1, so it can divide. */
export const rivalCount = (s: GameState, me: PlayerId): number =>
  Math.max(1, s.players.filter((p) => p.alive && p.id !== me).length)

/**
 * One number for a position, from `me`'s point of view.
 *
 * Own score minus the **sum** of rival scores, divided by how many rivals there
 * were at the decision point. Both halves of that are deliberate, and both are
 * fixes for ways the obvious formulations fail:
 *
 * - Not `relativeStanding` (own minus the *strongest* rival). That was tried as
 *   bot lookahead and made Marshal markedly worse — see BOTS.md. It scores every
 *   attack on a non-leader as negative, because you spend armies and the leader
 *   doesn't, which at a full table argues against attacking at all.
 * - Not the *mean* of live rivals either, which looks equivalent and isn't:
 *   eliminating the weakest player raises the mean of those left, so knocking
 *   someone out — the single biggest swing in Risk — would score as a loss. A sum
 *   over a fixed divisor makes an elimination remove their score outright.
 *
 * `divisor` must be held constant across every candidate from one decision, which
 * is why it's a parameter rather than read from `s`.
 */
export function objective(s: GameState, me: PlayerId, divisor: number): number {
  if (s.winner === me) return WIN_SCORE
  if (!s.players[me].alive) return -WIN_SCORE
  let rivals = 0
  for (const p of s.players) {
    if (p.alive && p.id !== me) rivals += scoreOf(s, p.id)
  }
  // Armies still in hand are armies. `assess` only counts what's on the board,
  // which is right for sizing up a rival — you can't see their reinforcement —
  // but scoring our own position without it makes every partial deploy look like
  // it threw away the armies it hadn't placed yet.
  const inHand = s.phase === 'deploy' && s.current === me ? s.toDeploy : 0
  // Damaging any one rival by X is worth X/divisor to us: the relief from a broken
  // continent is shared with everyone still standing. That the benchmark already
  // found this scaling empirically (BOTS.md, denial at 2 vs 4 seats) is a good sign
  // it's the right shape.
  return scoreOf(s, me) + inHand - rivals / divisor
}

/**
 * The most one territory may contribute to exposure, for review purposes.
 *
 * `assess` leaves exposure unbounded, which is right for the bots: they only ever
 * compare small local changes, where the unbounded part largely cancels, and
 * `EXPOSURE_WEIGHT` already sets its influence on play. A reviewer compares *whole*
 * alternatives, and there the tail runs away — a border facing a 180-army stack
 * scores a shortfall of a hundred-odd on its own.
 *
 * Measured: without this, Colonel's fortifies averaged a 14.8-army "loss" against
 * Marshal's 0.9, purely because Colonel's big stacks make the differences between
 * fortify targets enormous. It ranked the tiers wrongly as a result.
 *
 * 12 is the ceiling `garrisonFor` puts on a garrison, for the same reason: past
 * that you aren't reinforcing a border, you're writing it off. A territory can only
 * be lost once, so its contribution has to be bounded by what losing it costs.
 */
const MAX_SHORTFALL = 12

/**
 * `assess`'s score with exposure bounded per territory.
 *
 * Done here rather than in `assess` so the bots keep exactly the evaluation they
 * were tuned and benchmarked against — this is a property the *reviewer* needs,
 * not a correction to how anything plays.
 */
function scoreOf(s: GameState, p: PlayerId): number {
  const a = assess(s, p)
  let capped = 0
  for (const t of territoriesOf(s, p)) {
    if (!isBorder(s, p, t)) continue
    const want = pressure(s, p, t) * 0.6
    if (want > s.troops[t]) capped += Math.min(want - s.troops[t], MAX_SHORTFALL)
  }
  // add back the share of exposure we refuse to count
  return a.score + (a.exposure - capped) * EXPOSURE_WEIGHT
}

/**
 * Resolve a pending occupation the way a competent player would, so positions are
 * always compared fully settled.
 *
 * Without this, an attack's expected value and its actual outcome would be scored
 * at different points — one with the armies split, one with the choice still open
 * — and the difference between them would show up as luck.
 */
export function settle(s: GameState): GameState {
  const occ = s.pendingOccupation
  if (!occ) return s
  const keep = garrisonFor(s, s.current, occ.from)
  const count = clamp(s.troops[occ.from] - keep, occ.min, occ.max)
  return applyMove(s, { type: 'occupy', count })
}

/** Shallow fork, copying only what the hypothetical boards below mutate. */
function fork(s: GameState): GameState {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p, cards: p.cards.slice() })),
    owner: { ...s.owner },
    troops: { ...s.troops },
  }
}

/**
 * The board after a capture, with `total` armies surviving across the pair.
 *
 * `total` is an expectation, so it's usually fractional. That's deliberate — the
 * board is never rendered, only scored, and rounding it would bias small stacks
 * where the difference between 1.4 and 2 armies decides whether a border holds.
 */
function capturedBoard(
  s: GameState,
  me: PlayerId,
  from: TerritoryId,
  to: TerritoryId,
  total: number,
): GameState {
  const w = fork(s)
  const loser = w.owner[to]
  w.owner[to] = me
  // split the survivors the same way `settle` would, so a modelled capture and a
  // real one are scored on the same basis
  w.troops[from] = total
  w.troops[to] = 0
  const keep = garrisonFor(w, me, from)
  const advance = clamp(total - keep, 1, total - 1)
  w.troops[from] = total - advance
  w.troops[to] = advance

  // Elimination is the biggest single swing in the game — their hand comes with
  // them — so a model that ignored it would badly underprice the killing blow.
  if (loser !== me && !Object.values(w.owner).includes(loser)) {
    const dead = w.players[loser]
    if (dead.alive) {
      w.players[loser] = { ...dead, alive: false, cards: [] }
      w.players[me] = { ...w.players[me], cards: [...w.players[me].cards, ...dead.cards] }
      const alive = w.players.filter((p) => p.alive)
      if (alive.length === 1) w.winner = alive[0].id
    }
  }
  return w
}

/** The board after an attack that failed: ground down to one, defenders thinned. */
function repelledBoard(
  s: GameState,
  from: TerritoryId,
  to: TerritoryId,
  attackerLeft: number,
  defendersLeft: number,
): GameState {
  const l = fork(s)
  l.troops[from] = attackerLeft
  l.troops[to] = defendersLeft
  return l
}

/**
 * Expected value of a move, in armies, from `me`'s point of view.
 *
 * Deterministic moves are applied and scored. Attacks are integrated over their
 * outcome distribution instead of rolled. "I'm done" moves — `endAttack`,
 * `endTurn` — score the position as it stands, because that *is* what they
 * produce: the board handed over. Scoring them by applying them would compare a
 * mid-turn position against a post-handover one and make every comparison at that
 * node meaningless.
 */
export function evalMove(s: GameState, move: Move, me: PlayerId, divisor: number): number {
  switch (move.type) {
    case 'endAttack':
    case 'endTurn':
      return objective(settle(s), me, divisor)

    case 'blitz': {
      const a = s.troops[move.from]
      const d = s.troops[move.to]
      const p = winProb(a, d)
      const win = capturedBoard(s, me, move.from, move.to, expectedSurvivors(a, d))
      if (p >= 1) return objective(win, me, divisor)
      // a failed blitz always ends with the attacker on exactly one army
      const lose = repelledBoard(s, move.from, move.to, 1, expectedDefendersLeft(a, d))
      return p * objective(win, me, divisor) + (1 - p) * objective(lose, me, divisor)
    }

    case 'attack': {
      // A single exchange, enumerated exactly. The UI only ever blitzes, so these
      // arrive from the random baseline bot or a bot's illegal-move fallback —
      // rare, but a recorded game can contain them and they have to price.
      const a = s.troops[move.from]
      const d = s.troops[move.to]
      let ev = 0
      for (const e of exchangeOdds(Math.min(move.dice, diceFor(a)), defenderDice(d))) {
        const a2 = a - e.attackerLoss
        const d2 = d - e.defenderLoss
        const board =
          d2 <= 0
            ? capturedBoard(s, me, move.from, move.to, a2)
            : repelledBoard(s, move.from, move.to, a2, d2)
        ev += e.p * objective(board, me, divisor)
      }
      return ev
    }

    default:
      return objective(settle(applyMove(s, move)), me, divisor)
  }
}

// ─────────────────────── the rest of the turn ───────────────────────

/**
 * How far a rollout may run before giving up.
 *
 * A turn is a deploy or two, a handful of attacks with their occupations, and a
 * fortify, so this is not a horizon anything real reaches. It's here so a policy
 * that somehow stops making progress can't hang the review.
 */
const ROLLOUT_BUDGET = 24

/**
 * Where a line stops being about the move that started it.
 *
 * A continuation is worth what it's worth *times the chance of reaching it*, and
 * far enough down that chance is small enough that the arithmetic is only adding
 * noise to a decision made at the top.
 */
const MIN_REACH = 0.05

/**
 * How many attacks a line may claim before it stops being a reason and starts
 * being a forecast.
 *
 * A rollout exists to say what a move was *for* — the push it pays for, the door it
 * opens. Four attacks is a turn's plan; twelve is a conquest of two continents, and
 * a recommendation is not the place to promise one. The bound is about what the
 * review is willing to claim, and about cost, not about calibration: unbounded, the
 * ladder in `review-check` comes out ordered either way.
 */
const MAX_CHAIN = 4

export interface Line {
  /** the first move's value in armies, with the rest of the turn played out */
  value: number
  /** what that came to: the move itself, then the policy's continuation */
  moves: Move[]
}

/**
 * Can this attack be played at all? Enough to keep a policy that offers something
 * illegal from being scored on a board it couldn't have reached.
 */
const canAttack = (s: GameState, me: PlayerId, from: TerritoryId, to: TerritoryId): boolean =>
  s.owner[from] === me && s.owner[to] !== me && s.troops[from] >= 2 && ADJACENCY[from].includes(to)

/**
 * The board a blitz most likely produces, built rather than rolled for.
 *
 * A rollout must not be able to get *lucky*. A move's value is the best of what the
 * position offers, so it is a maximum over alternatives — and a maximum over rolled
 * continuations selects for whichever alternative the dice smiled on, which with an
 * elimination worth a whole hand is enough to invent a blunder out of nothing. It
 * would also make the same game grade differently on a second viewing.
 *
 * So the likely outcome is constructed instead. Above even odds the attack is taken
 * as won, with the expected survivors split the way `garrisonFor` would split them;
 * below, as ground down to one army. Resolving to one branch is exactly what
 * `evalLine` pays back, because it prices the move by the full expectation and only
 * *continues* from here.
 */
function likelyBoard(s: GameState, me: PlayerId, from: TerritoryId, to: TerritoryId): GameState {
  const a = s.troops[from]
  const d = s.troops[to]
  // Rounded, unlike the modelled boards `evalMove` scores: this one is played on,
  // and a territory holding 4.3 armies is not a position the rules can continue from.
  const left = Math.round(expectedSurvivors(a, d))
  // Two armies is the least a capture can be expressed with — one to hold the
  // ground, one to hold what it came from. Rounding *up* to it would invent an
  // army on every marginal attack, and a chain of marginal attacks would then
  // conjure the force it needed to keep going.
  if (winProb(a, d) < 0.5 || left < 2) {
    return repelledBoard(s, from, to, 1, Math.max(1, Math.round(expectedDefendersLeft(a, d))))
  }
  const w = capturedBoard(s, me, from, to, left)
  w.conqueredThisTurn = true
  return w
}

/**
 * What a move is worth once the turn it belongs to has been finished.
 *
 * One ply prices an attack honestly, because an attack's effect is immediate. It
 * cannot price a deploy at all, because a deploy's effect is entirely in the
 * attacks it pays for — and `objective` counts armies still in hand, so at one ply
 * "put one army down and think again" scores almost exactly as well as the
 * position before it. The reviewer's alternative to anything was a move that
 * committed nothing, which is why its advice read as having no idea what the turn
 * was for. Playing the turn out is what makes a commitment cost something.
 *
 * The disagreement is not marginal. Over the deploys of four tiers, the move this
 * picks is the one a single ply liked best 18% of the time, and sits outside its top
 * six in nearly two positions in five — so there is also no cheap static ordering to
 * prune the candidate list by. The disagreement *is* the feature.
 *
 * Nothing in here rolls dice. The continuation comes from the reference policy, its
 * attacks resolve to `likelyBoard`, and each step contributes what it *adds* to the
 * position, discounted by the chance of reaching it at all. The discount is not a
 * safety margin, it's the arithmetic: a gain behind three even-money attacks is
 * worth an eighth of itself, and counting it whole would let the alternative with
 * the longest line win every comparison.
 *
 * Two properties follow, and both matter:
 *
 *  - **A move with nothing after it prices exactly as it did before.** Its own
 *    value is still the full expectation over both outcomes, so a rollout only
 *    ever *adds* a continuation; it never re-prices the move itself. The grade
 *    bands stay anchored to the same thing they were calibrated against.
 *  - **It is deterministic**, so a game reviews identically however often it's
 *    opened and every candidate at a decision is compared on the same terms.
 */
export function evalLine(
  s: GameState,
  first: Move,
  me: PlayerId,
  divisor: number,
  bot: Bot,
  rand: () => number,
  budget: number = ROLLOUT_BUDGET,
): Line {
  // Ending the turn is scored where it stands, for the reason `evalMove` gives:
  // applying it would price the position the *next* player inherits.
  if (first.type === 'endTurn') return { value: objective(settle(s), me, divisor), moves: [first] }

  const moves: Move[] = []
  let cur = s
  let at = objective(settle(s), me, divisor)
  let value = at
  let reach = 1
  let next: Move | null = first
  const standing = alive(s)
  let chain = 0

  for (let i = 0; i < budget && next && reach > MIN_REACH; i++) {
    const m = next
    if (m.type === 'blitz') {
      if (chain++ > MAX_CHAIN) break
      if (!canAttack(cur, me, m.from, m.to)) {
        if (i === 0) return { value: -Infinity, moves: [] }
        break
      }
      // The move's own value is the exact expectation over both outcomes, so the
      // attack itself is priced no differently than it ever was.
      value += reach * (evalMove(cur, m, me, divisor) - at)
      const p = winProb(cur.troops[m.from], cur.troops[m.to])
      cur = likelyBoard(cur, me, m.from, m.to)
      reach *= p < 0.5 ? 1 - p : p
      at = objective(cur, me, divisor)
    } else {
      let after: GameState
      try {
        // Single-roll attacks would put dice back into the rollout, but no
        // strategist emits one and the UI can't play them either — which is why
        // `candidateMoves` drops them — so this is deploys, occupations, fortifies.
        after = applyMove(cur, m)
      } catch {
        // An illegal *candidate* must never win the comparison: scoring it as a
        // position it never reached would recommend a move that can't be played.
        // Deeper in it's the policy that came up short, and what the line is worth
        // so far is still the honest answer.
        if (i === 0) return { value: -Infinity, moves: [] }
        break
      }
      const to = objective(settle(after), me, divisor)
      value += reach * (to - at)
      at = to
      cur = after
    }
    moves.push(m)
    // A line stops at the first player it knocks out.
    //
    // Elimination is where a modelled board is least worth believing and worth the
    // most if believed: `likelyBoard` hands every above-even attack the territory,
    // so a chain of them sweeps a player off the map, takes their hand, and — with
    // `WIN_SCORE` twenty times any real score — reports a forced win. Measured, the
    // whole tail of the loss distribution was that: strong tiers, whose positions
    // support long chains, were graded on 250-army swings in games they had already
    // won, and blundered *more* often than `easy` as a result. The elimination the
    // line actually reaches is still priced, exactly, by the attack that makes it.
    if (cur.winner !== null || alive(cur) < standing) break
    next = follow(cur, me, bot, rand)
  }

  return { value, moves }
}

const alive = (s: GameState): number => s.players.filter((p) => p.alive).length

/** The policy's next move, or null once the turn is over or it can't offer one. */
function follow(s: GameState, me: PlayerId, bot: Bot, rand: () => number): Move | null {
  if (s.phase === 'gameOver' || s.current !== me) return null
  let m: Move
  try {
    m = bot.decide(s, me, rand)
  } catch {
    return null
  }
  // `endTurn` is where a rollout stops rather than a move it plays.
  return m.type === 'endTurn' ? null : m
}

/**
 * The moves worth comparing against at a decision point.
 *
 * `legalMoves` is the engine's full enumeration; this trims it to what a player
 * could actually have done through the interface. Single-roll attacks are
 * dropped — every attack in the UI is a blitz, so "you should have rolled two
 * dice at Ukraine" is advice about a button that doesn't exist.
 */
export function candidateMoves(s: GameState): Move[] {
  const all = legalMoves(s)
  if (s.phase !== 'attack') return all
  return all.filter((m) => m.type !== 'attack')
}

/** Stable identity for a move, for de-duplicating candidate lists. */
export function moveKey(m: Move): string {
  switch (m.type) {
    case 'placeInitial':
      return `place:${m.territory}`
    case 'tradeCards':
      return `trade:${[...m.cards].sort((a, b) => a - b).join(',')}`
    case 'deploy':
      return `deploy:${m.territory}:${m.count}`
    case 'attack':
      return `attack:${m.from}>${m.to}:${m.dice}`
    case 'blitz':
      return `blitz:${m.from}>${m.to}`
    case 'occupy':
      return `occupy:${m.count}`
    case 'fortify':
      return `fortify:${m.from}>${m.to}:${m.count}`
    default:
      return m.type
  }
}

/** Enemy strength that would bear on `t` if we held it, ignoring `from`. */
export const pressureAfter = (
  s: GameState,
  me: PlayerId,
  from: TerritoryId,
  to: TerritoryId,
): number =>
  ADJACENCY[to]
    .filter((n) => n !== from && s.owner[n] !== me)
    .reduce((sum, n) => sum + s.troops[n], 0)
