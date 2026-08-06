/**
 * "What can the player do right now" — as pure functions of game state.
 *
 * These used to live inside App as `useMemo` bodies, where nothing could reach
 * them but a browser. Out here `scripts/test.ts` can assert the two properties
 * that actually keep the game playable:
 *
 *   the primary button never offers a move the engine would reject, and
 *   a preview never promises a number the move wouldn't produce.
 *
 * Both are invisible to the engine tests — the rules stay perfectly correct
 * while the UI hands you an illegal move — so this is the seam where a UI bug
 * becomes catchable.
 *
 * Nothing here touches React or component state. The two genuinely UI-only
 * inputs — which territory you've clicked, and how many armies you've dialled
 * up — come in as arguments.
 */
import { ADJACENCY } from '../engine/board'
import type { TerritoryId } from '../engine/board'
import { findSets } from '../engine/cards'
import { HAND_LIMIT, attackableFrom, connectedOwn, territoriesOf } from '../engine/game'
import type { GameState, Move } from '../engine/types'

/** Deterministic moves — safe to rewind past. */
export const UNDOABLE = new Set<Move['type']>(['deploy', 'tradeCards', 'fortify', 'endAttack'])
/** Rolling dice or ending the turn (which draws a card) closes the undo window. */
export const CLEARS_UNDO = new Set<Move['type']>(['attack', 'blitz', 'endTurn'])

/** Whether the seat on the clock is a person rather than a bot. */
export const isHumanTurn = (s: GameState): boolean => !s.players[s.current].bot

/** Deploying is blocked until an over-limit hand cashes a set. */
export const mustTrade = (s: GameState): boolean => {
  const me = s.players[s.current]
  return s.phase === 'deploy' && me.cards.length >= HAND_LIMIT && findSets(me.cards).length > 0
}

/**
 * A selection is only real if the current state still permits acting on it.
 * Deriving this rather than clearing `selected` from an effect is what stops
 * stale selections: a blitz can spend the attacker down to one army, and a
 * fortify can be used up, and neither changes phase or player — so nothing
 * dependency-based would fire.
 */
export function validSelection(s: GameState, selected: TerritoryId | null): TerritoryId | null {
  if (!selected || !isHumanTurn(s)) return null
  if (s.owner[selected] !== s.current) return null
  if (s.troops[selected] < 2) return null
  if (s.phase === 'attack') return attackableFrom(s, selected).length ? selected : null
  if (s.phase === 'fortify') return s.canFortify && connectedOwn(s, s.current, selected).size ? selected : null
  return null
}

/** Where a valid selection can act — attack targets, or fortify destinations. */
export function targetsFor(s: GameState, sel: TerritoryId | null): Set<TerritoryId> {
  if (!sel) return new Set()
  if (s.phase === 'attack') return new Set(attackableFrom(s, sel))
  if (s.phase === 'fortify') return connectedOwn(s, s.current, sel)
  return new Set()
}

/** A fortify destination only counts while it's still reachable from the source. */
export const validDestination = (
  sel: TerritoryId | null,
  fortifyTo: TerritoryId | null,
  targets: Set<TerritoryId>,
): TerritoryId | null => (sel && fortifyTo && targets.has(fortifyTo) ? fortifyTo : null)

/**
 * Every territory the player can click. `autoSetup` is the one UI-only input:
 * once you've handed initial placement to the machine, clicking is off.
 */
export function clickableFor(
  s: GameState,
  targets: Set<TerritoryId>,
  autoSetup = false,
): Set<TerritoryId> {
  const out = new Set<TerritoryId>()
  if (!isHumanTurn(s)) return out
  const me = s.players[s.current]
  const mine = territoriesOf(s, s.current)
  switch (s.phase) {
    case 'setup':
      if (me.reserve > 0 && !autoSetup) mine.forEach((t) => out.add(t))
      break
    case 'deploy':
      if (s.toDeploy > 0 && !mustTrade(s)) mine.forEach((t) => out.add(t))
      break
    case 'attack':
      mine.forEach((t) => { if (attackableFrom(s, t).length) out.add(t) })
      targets.forEach((t) => out.add(t))
      break
    case 'fortify':
      if (s.canFortify) {
        mine.forEach((t) => { if (s.troops[t] > 1 && connectedOwn(s, s.current, t).size) out.add(t) })
        targets.forEach((t) => out.add(t))
      }
      break
  }
  return out
}

/**
 * What the badges would read if you confirmed — for the two moves where you pick
 * an amount and the result is certain. An attack has no honest preview: the dice
 * decide, so the map keeps showing what's actually there.
 *
 * The amounts are clamped exactly as `primaryFor` clamps them, so the map can
 * never promise a number the move wouldn't produce. `scripts/test.ts` pins that
 * agreement by applying the move and comparing.
 */
export function previewFor(
  s: GameState,
  amount: number,
  sel: TerritoryId | null,
  dest: TerritoryId | null,
): Record<TerritoryId, number> | null {
  if (!isHumanTurn(s)) return null
  if (s.phase === 'occupy' && s.pendingOccupation) {
    const occ = s.pendingOccupation
    const n = clamp(amount, occ.min, occ.max)
    return { [occ.from]: s.troops[occ.from] - n, [occ.to]: s.troops[occ.to] + n }
  }
  if (s.phase === 'fortify' && sel && dest) {
    const n = clamp(amount, 1, s.troops[sel] - 1)
    return { [sel]: s.troops[sel] - n, [dest]: s.troops[dest] + n }
  }
  return null
}

/**
 * The single dark button in the bar, and what Space does.
 *
 * `move` is the engine move it would play; the two `kind`s that carry none are
 * the ones that drive the UI rather than the rules. Keeping the move as data
 * instead of a closure is what lets the tests check it against `legalMoves`.
 */
export interface Primary {
  label: string
  kind: 'move' | 'skipBots' | 'autoSetup'
  move: Move | null
}

export function primaryFor(
  s: GameState,
  amount: number,
  sel: TerritoryId | null,
  dest: TerritoryId | null,
): Primary | null {
  if (s.phase === 'gameOver') return null
  if (s.players[s.current].bot) {
    const nextHuman = s.players.find((p) => p.alive && !p.bot)
    return {
      label: nextHuman ? `Skip to ${nextHuman.name}` : 'Skip to end',
      kind: 'skipBots',
      move: null,
    }
  }
  switch (s.phase) {
    case 'setup':
      return { label: 'Auto-place rest', kind: 'autoSetup', move: null }
    case 'attack':
      return { label: 'End attack', kind: 'move', move: { type: 'endAttack' } }
    case 'occupy': {
      const occ = s.pendingOccupation!
      return {
        label: 'Confirm',
        kind: 'move',
        move: { type: 'occupy', count: clamp(amount, occ.min, occ.max) },
      }
    }
    case 'fortify':
      // never offer a fortify once it's been spent, whatever the selection says
      if (sel && dest) {
        return {
          label: 'Confirm · end turn',
          kind: 'move',
          move: { type: 'fortify', from: sel, to: dest, count: clamp(amount, 1, s.troops[sel] - 1) },
        }
      }
      return { label: 'End turn', kind: 'move', move: { type: 'endTurn' } }
    default:
      return null
  }
}

/**
 * The move a click on `t` plays, or null when the click only changes selection.
 * Mirrors `pick` in App — kept here so the tests can confirm that every
 * clickable territory really does produce a move the engine accepts.
 */
export function moveForClick(
  s: GameState,
  t: TerritoryId,
  shift: boolean,
  amount: number,
  sel: TerritoryId | null,
): Move | null {
  switch (s.phase) {
    case 'setup':
      return { type: 'placeInitial', territory: t }
    case 'deploy':
      // click places the current amount; shift means "all of it"
      return { type: 'deploy', territory: t, count: shift ? s.toDeploy : clamp(amount, 1, s.toDeploy) }
    case 'attack':
      if (s.owner[t] === s.current) return null
      return sel && ADJACENCY[sel].includes(t) ? { type: 'blitz', from: sel, to: t } : null
    default:
      return null
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)
