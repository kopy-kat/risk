/**
 * Predictions, and the arithmetic that settles them.
 *
 * A claim is scored against boards and nothing else. Everything here takes a run
 * of `GameState`s — the same run `replay` produces from a seed and a move list —
 * and reads the answer out of it. That is what keeps a verdict stable when a turn
 * is undone and played differently, and what lets a prediction made months ago be
 * re-settled today without having kept a single UI event.
 *
 * Nothing in here is reachable from `applyMove`, the bots, or a move type: a game
 * plays out identically whether or not anyone wrote down what they expected.
 */
import { ADJACENCY, CONTINENTS, CONTINENT_IDS, TERRITORIES_IN } from '../engine/board'
import type { ContinentId } from '../engine/board'
import { HAND_LIMIT, continentsHeldBy, territoriesOf } from '../engine/game'
import type { GameState, Move, PlayerId } from '../engine/types'

/**
 * One scorable sentence about the near future. Each carries only what identifies
 * it; the words come from `describeClaim`, so a claim recorded under one set of
 * seat names still reads correctly against the game it was made in.
 */
export type Claim =
  | { kind: 'holdContinent'; continent: ContinentId }
  | { kind: 'attackedBy'; who: PlayerId }
  | { kind: 'territoriesAtLeast'; n: number }
  | { kind: 'cashes'; who: PlayerId }

export type ClaimKind = Claim['kind']

/**
 * Fixed rungs rather than a free number. A calibration table needs claims to pile
 * up in the same buckets to say anything, and nobody's judgement distinguishes
 * 73% from 76%.
 */
export const CONFIDENCE_STEPS = [50, 60, 70, 80, 90, 95]

export const CLAIM_LABEL: Record<ClaimKind, string> = {
  holdContinent: 'holding a continent',
  attackedBy: 'being attacked',
  territoriesAtLeast: 'ground taken in a turn',
  cashes: 'the table cashing sets',
}

export function describeClaim(c: Claim, name: (p: PlayerId) => string): string {
  switch (c.kind) {
    case 'holdContinent':
      return `I will hold ${CONTINENTS[c.continent].name} at the start of my next turn`
    case 'attackedBy':
      return `${name(c.who)} will attack me before my next turn`
    case 'territoriesAtLeast':
      return `I will end this turn holding ${c.n} or more territories`
    case 'cashes':
      return `${name(c.who)} will cash a set before my next turn`
  }
}

/** The same claim short enough for the bar. */
export function claimChip(c: Claim, name: (p: PlayerId) => string): string {
  switch (c.kind) {
    case 'holdContinent': return `Hold ${CONTINENTS[c.continent].name}`
    case 'attackedBy': return `${name(c.who)} attacks me`
    case 'territoriesAtLeast': return `${c.n}+ territories`
    case 'cashes': return `${name(c.who)} cashes`
  }
}

/** How many claims the bar offers. A menu you have to read is a menu you skip. */
const MENU_MAX = 6
/** Cards in hand before a player counts as one who might cash. */
const BANKING = HAND_LIMIT - 2

/**
 * The menu, generated from the board in front of you.
 *
 * Every option has to be a live question — a continent you're nowhere near and a
 * player who can't reach you are both unfalsifiable in practice, and a menu of
 * those teaches nothing about judgement.
 */
export function offerClaims(s: GameState, me: PlayerId): Claim[] {
  const out: Claim[] = []
  const mine = new Set(territoriesOf(s, me))

  const reach = CONTINENT_IDS
    .map((c) => ({ c, missing: TERRITORIES_IN[c].filter((t) => !mine.has(t)).length }))
    .filter((x) => x.missing <= 1)
    .sort((a, b) => a.missing - b.missing || CONTINENTS[b.c].bonus - CONTINENTS[a.c].bonus)
  for (const { c } of reach.slice(0, 2)) out.push({ kind: 'holdContinent', continent: c })

  // rivals ranked by what they actually have on your border, not by size
  const massed = new Map<PlayerId, number>()
  for (const t of mine)
    for (const n of ADJACENCY[t]) {
      const q = s.owner[n]
      if (q === me || !s.players[q].alive) continue
      massed.set(q, (massed.get(q) ?? 0) + s.troops[n])
    }
  const pressing = [...massed.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
  for (const [q] of pressing.slice(0, 2)) out.push({ kind: 'attackedBy', who: q })

  out.push({ kind: 'territoriesAtLeast', n: mine.size + 2 })

  const banking = s.players
    .filter((p) => p.alive && p.id !== me && p.cards.length >= BANKING)
    .sort((a, b) => b.cards.length - a.cards.length || a.id - b.id)[0]
  if (banking) out.push({ kind: 'cashes', who: banking.id })

  return out.slice(0, MENU_MAX)
}

/**
 * One player's turn, as indices into a run of boards.
 *
 * `handover` is where control left them and `next` is where it came back, which
 * are different horizons: "I will end this turn holding twelve territories" is
 * answered at the first, "Azure will attack me before my next turn" at the
 * second. Both default to the end of the run, with a flag saying so — a game that
 * stopped part way through has claims nothing can settle yet, and guessing at
 * them is the one thing a calibration report must never do.
 */
export interface TurnWindow {
  player: PlayerId
  turn: number
  start: number
  handover: number
  next: number
  /** whether the player's turn actually ended inside the run */
  ended: boolean
  /** whether the player got another turn inside the run */
  returned: boolean
}

export function turnWindows(states: GameState[]): TurnWindow[] {
  const out: TurnWindow[] = []
  const last = states.length - 1
  if (last < 0) return out
  let open: TurnWindow | null = null
  for (let i = 0; i <= last; i++) {
    const s = states[i]
    // initial placement runs through the same handovers and is not a turn
    if (s.phase === 'setup') continue
    if (open && s.current === open.player) continue
    if (open) {
      open.handover = i
      open.ended = true
    }
    // the same player's previous turn is only now closed off
    for (let j = out.length - 1; j >= 0; j--) {
      if (out[j].player === s.current && !out[j].returned) {
        out[j].next = i
        out[j].returned = true
        break
      }
    }
    open = {
      player: s.current,
      turn: s.turn,
      start: i,
      handover: last,
      next: last,
      ended: false,
      returned: false,
    }
    out.push(open)
  }
  return out
}

export const windowFor = (
  windows: TurnWindow[],
  player: PlayerId,
  turn: number,
): TurnWindow | null => windows.find((w) => w.player === player && w.turn === turn) ?? null

/** The move that produced `states[i + 1]`, and the seat that played it. */
function stepAt(states: GameState[], i: number): { actor: PlayerId; move: Move; before: GameState } | null {
  const before = states[i]
  const after = states[i + 1]
  if (!before || !after) return null
  const move = after.moves[after.moves.length - 1]
  return move ? { actor: before.current, move, before } : null
}

/**
 * Did it happen? `null` means the horizon hasn't arrived — an unfinished game,
 * or a claim made on the last turn anyone played.
 *
 * Events settle to `true` the moment they occur, whatever the horizon does after,
 * so a verdict never flips as more of the game is replayed. That monotonicity is
 * the property `scripts/test.ts` pins.
 */
export function resolveClaim(
  claim: Claim,
  w: TurnWindow,
  states: GameState[],
): boolean | null {
  const last = states.length - 1
  const over = states[last]?.phase === 'gameOver'

  switch (claim.kind) {
    case 'holdContinent': {
      if (!w.returned && !over) return null
      return continentsHeldBy(states[w.returned ? w.next : last], w.player).includes(claim.continent)
    }
    case 'territoriesAtLeast': {
      if (!w.ended && !over) return null
      return territoriesOf(states[w.ended ? w.handover : last], w.player).length >= claim.n
    }
    case 'attackedBy':
    case 'cashes': {
      const until = w.returned ? w.next : last
      for (let i = w.start; i < until; i++) {
        const step = stepAt(states, i)
        if (!step || step.actor !== claim.who) continue
        if (claim.kind === 'cashes') {
          if (step.move.type === 'tradeCards') return true
        } else if (
          (step.move.type === 'attack' || step.move.type === 'blitz') &&
          step.before.owner[step.move.to] === w.player
        ) {
          return true
        }
      }
      return w.returned || over ? false : null
    }
  }
}
