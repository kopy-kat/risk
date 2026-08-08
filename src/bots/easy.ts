import { ADJACENCY } from '../engine/board'
import type { TerritoryId } from '../engine/board'
import { attackableFrom, connectedOwn, legalMoves, suppliedOf, territoriesOf } from '../engine/game'
import type { GameState, Move, PlayerId } from '../engine/types'
import { findSets } from '../engine/cards'
import type { Bot } from './types'

/**
 * Deliberately shallow. It reinforces its most threatened border, only attacks
 * when it already outnumbers the defender, and shuffles armies out of its
 * interior. No lookahead, no continent plan, no card timing — those are the
 * obvious things to add when we build the good bots.
 */

const enemyNeighbours = (s: GameState, me: PlayerId, t: TerritoryId) =>
  ADJACENCY[t].filter((n) => s.owner[n] !== me)

/** How much enemy strength is stacked against a territory, net of its own garrison. */
const threat = (s: GameState, me: PlayerId, t: TerritoryId) =>
  enemyNeighbours(s, me, t).reduce((sum, n) => sum + s.troops[n], 0) - s.troops[t]

const borders = (s: GameState, me: PlayerId) =>
  territoriesOf(s, me).filter((t) => enemyNeighbours(s, me, t).length > 0)

function pickDeployTarget(s: GameState, me: PlayerId): TerritoryId {
  // supply mode: reinforcements can only land on supplied ground
  const supplied = s.mode === 'supply' ? suppliedOf(s, me) : null
  const front = borders(s, me).filter((t) => !supplied || supplied.has(t))
  const pool = front.length ? front : supplied ? [...supplied] : territoriesOf(s, me)
  return pool.reduce((best, t) => (threat(s, me, t) > threat(s, me, best) ? t : best), pool[0])
}

/**
 * Initial placement is one army at a time, so always picking the single most
 * threatened territory piles ~20 armies onto one tile before its threat score
 * drops enough to matter. Shoring up the thinnest border instead spreads the
 * line out, which both looks sane and plays better.
 */
function pickSetupTarget(s: GameState, me: PlayerId): TerritoryId {
  const front = borders(s, me)
  const pool = front.length ? front : territoriesOf(s, me)
  return pool.reduce((best, t) => {
    if (s.troops[t] !== s.troops[best]) return s.troops[t] < s.troops[best] ? t : best
    return threat(s, me, t) > threat(s, me, best) ? t : best
  }, pool[0])
}

export const easyBot: Bot = {
  key: 'easy',
  name: 'Sergeant',
  blurb: 'Reinforces its weakest border, attacks only when it outnumbers you',

  decide(s, me, rand): Move {
    switch (s.phase) {
      case 'setup':
        return { type: 'placeInitial', territory: pickSetupTarget(s, me) }

      case 'deploy': {
        const sets = findSets(s.players[me].cards)
        if (sets.length) return { type: 'tradeCards', cards: sets[0] }
        // Deploy in thirds rather than all at once. Reinforcing drops that
        // territory's threat score, so successive calls naturally rotate across
        // the front instead of building one absurd 20-army tower.
        const chunk = Math.max(1, Math.ceil(s.toDeploy / 3))
        return { type: 'deploy', territory: pickDeployTarget(s, me), count: Math.min(chunk, s.toDeploy) }
      }

      case 'attack': {
        // Best favourable attack by margin. The threshold is >= 0 rather than >= 1
        // on purpose: at >= 1 two of these bots turtle into a permanent stalemate,
        // never conquering, so never drawing cards, so never escalating out of it.
        let best: { from: TerritoryId; to: TerritoryId; margin: number } | null = null
        for (const from of territoriesOf(s, me)) {
          if (s.troops[from] < 2) continue
          for (const to of attackableFrom(s, from)) {
            const margin = s.troops[from] - 1 - s.troops[to]
            if (margin >= 0 && (!best || margin > best.margin)) best = { from, to, margin }
          }
        }
        if (!best) return { type: 'endAttack' }
        return { type: 'attack', from: best.from, to: best.to, dice: Math.min(3, s.troops[best.from] - 1) }
      }

      case 'occupy': {
        // push almost everything forward, leaving a token garrison behind
        const occ = s.pendingOccupation!
        return { type: 'occupy', count: Math.max(occ.min, occ.max - 1) }
      }

      case 'fortify': {
        // fortifying no longer ends the turn, so bail out once it's been used
        if (!s.canFortify) return { type: 'endTurn' }
        // drain a safe interior stack toward the most threatened border
        const front = borders(s, me)
        if (front.length) {
          const target = front.reduce((a, b) => (threat(s, me, a) > threat(s, me, b) ? a : b))
          const interior = territoriesOf(s, me)
            .filter((t) => t !== target && s.troops[t] > 1 && enemyNeighbours(s, me, t).length === 0)
            .filter((t) => connectedOwn(s, me, t).has(target))
            .sort((a, b) => s.troops[b] - s.troops[a])
          if (interior.length) {
            return { type: 'fortify', from: interior[0], to: target, count: s.troops[interior[0]] - 1 }
          }
        }
        return { type: 'endTurn' }
      }

      default: {
        const moves = legalMoves(s)
        return moves[Math.floor(rand() * moves.length)]
      }
    }
  },
}
