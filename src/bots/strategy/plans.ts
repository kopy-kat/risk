/**
 * The plan layer.
 *
 * Everything up to here scored targets one at a time, which means the bot can
 * drift: take a territory in Africa, then one in Asia, then reinforce Europe, and
 * finish the turn having advanced nothing. People don't play that way. They decide
 * *"I'm taking Australia this turn"* and then spend the turn doing it.
 *
 * So each turn one intent is chosen and everything — where armies land, what gets
 * attacked, where the fortify goes — serves it. The intent is recomputed from the
 * position every call rather than stored, which keeps agents pure functions of the
 * state; it is stable within a turn because it derives from continent standings,
 * which move slowly.
 */
import { ADJACENCY, CONTINENTS, TERRITORIES_IN } from '../../engine/board'
import type { ContinentId, TerritoryId } from '../../engine/board'
import { cashValue } from '../../engine/cards'
import { territoriesOf } from '../../engine/game'
import type { GameState, PlayerId } from '../../engine/types'
import { allStandings, isBorder, pressure, stagingFor } from './board-sense'
import { INCOME_HORIZON, killableRival, rivals } from './evaluate'

export type IntentKind = 'expand' | 'deny' | 'decapitate' | 'consolidate' | 'cycle'

export interface Intent {
  kind: IntentKind
  /** what this intent wants to take */
  targets: Set<TerritoryId>
  /** our territories bordering those, where armies should mass */
  staging: TerritoryId[]
  /** for the log and for debugging why a bot did something */
  label: string
  score: number
}

const EMPTY: Intent = {
  kind: 'consolidate',
  targets: new Set(),
  staging: [],
  label: 'hold',
  score: 0,
}

/**
 * Value in armies, divided by what it costs to get. Everything is denominated the
 * same way so intents of different kinds can be compared at all.
 */
function rate(value: number, cost: number): number {
  return value / Math.max(2, cost)
}

export function selectIntent(s: GameState, me: PlayerId, allowed: ReadonlySet<string>): Intent {
  const mine = territoriesOf(s, me)
  if (!mine.length) return EMPTY
  const opponents = Math.max(1, rivals(s, me).length)
  const candidates: Intent[] = []

  const make = (
    kind: IntentKind,
    targets: TerritoryId[],
    label: string,
    value: number,
    cost: number,
  ): Intent | null => {
    const reachable = targets.filter((t) => ADJACENCY[t].some((n) => s.owner[n] === me))
    if (!reachable.length) return null
    return {
      kind,
      targets: new Set(targets),
      staging: [...stagingFor(s, me, reachable)],
      label,
      score: rate(value, cost),
    }
  }

  // ── take a continent ────────────────────────────────────────
  if (allowed.has('expand')) {
    for (const st of allStandings(s, me)) {
      if (st.held || st.mine === 0) continue
      const value = st.bonus * INCOME_HORIZON + st.missing.length
      const cost = st.resistance * 1.5 + st.missing.length
      const i = make('expand', st.missing, `take ${CONTINENTS[st.id].name}`, value, cost)
      if (i) candidates.push(i)
    }
  }

  // ── break someone else's ────────────────────────────────────
  if (allowed.has('deny')) {
    for (const r of rivals(s, me)) {
      for (const c of Object.keys(CONTINENTS) as ContinentId[]) {
        const members = TERRITORIES_IN[c]
        if (!members.every((t) => s.owner[t] === r.id)) continue
        // one territory is enough to kill the bonus, so cost is the cheapest door
        const cheapest = members
          .filter((t) => ADJACENCY[t].some((n) => s.owner[n] === me))
          .sort((a, b) => s.troops[a] - s.troops[b])[0]
        if (!cheapest) continue
        // the relief is shared with every other survivor
        const value = (CONTINENTS[c].bonus * INCOME_HORIZON) / opponents
        const i = make('deny', [cheapest], `break ${CONTINENTS[c].name}`, value, s.troops[cheapest] * 1.5)
        if (i) candidates.push(i)
      }
    }
  }

  // ── knock someone out for their hand ────────────────────────
  if (allowed.has('decapitate')) {
    const prey = killableRival(s, me)
    if (prey) {
      const theirs = territoriesOf(s, prey.id)
      const value = 6 + prey.cards * (cashValue(s.setsTraded) / 3) + prey.income * INCOME_HORIZON
      const cost = theirs.reduce((n, t) => n + s.troops[t], 0) * 1.4
      const i = make('decapitate', theirs, `eliminate ${s.players[prey.id].name}`, value, cost)
      if (i) candidates.push(i)
    }
  }

  // ── guarantee a card ────────────────────────────────────────
  if (allowed.has('cycle') && !s.conqueredThisTurn) {
    const doors = mine
      .filter((t) => s.troops[t] >= 2)
      .flatMap((t) => ADJACENCY[t].filter((n) => s.owner[n] !== me))
      .sort((a, b) => s.troops[a] - s.troops[b])
    if (doors.length) {
      const cheapest = doors[0]
      const i = make('cycle', [cheapest], 'take a card', cashValue(s.setsTraded) / 3, s.troops[cheapest] * 1.5)
      if (i) candidates.push(i)
    }
  }

  // ── or just hold the line ───────────────────────────────────
  const threatened = mine
    .filter((t) => isBorder(s, me, t) && pressure(s, me, t) > s.troops[t] * 1.2)
    .sort((a, b) => pressure(s, me, b) - pressure(s, me, a))
  if (threatened.length) {
    candidates.push({
      kind: 'consolidate',
      targets: new Set(),
      staging: threatened.slice(0, 3),
      label: 'hold the line',
      // worth roughly the income of what's about to be lost
      score: rate(threatened.length * INCOME_HORIZON * 0.34, 6),
    })
  }

  if (!candidates.length) return EMPTY
  return candidates.reduce((best, c) => (c.score > best.score ? c : best))
}
