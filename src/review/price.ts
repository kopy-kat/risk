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
 * alternatives were worth at the moment of choice. One ply is not an approximation
 * of the answer here; it *is* the question.
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
