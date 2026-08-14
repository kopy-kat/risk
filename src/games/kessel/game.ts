import { rngFrom } from '../../engine/rng'
import type { PlayerId, SeatConfig } from '../../engine/types'
import type { GameView } from '../types'
import { applyLoss, resolve } from './combat'
import { STACK_LIMIT, frontage, mapOf } from './map'
import type { GameMap, ProvinceId } from './map'
import { reachable, routeTo } from './movement'
import { depthMap, retreatTargets, supplyStates } from './supply'
import type { Formation, KesselState, Move, Order, Side, UnitType } from './types'

export const RULES_VERSION = ['kessel1', 'wear100', 'frontage28', 'will25'].join('|')

/**
 * Provinces you can set in motion in one turn.
 *
 * A commander who can order every formation every turn is not choosing anything.
 * The cost is per *province*, not per formation, so concentrating a push is
 * cheaper than spreading it — which is the operational lesson, and the reason a
 * solid manned line is not free.
 */
export const ACTIVATIONS = 7

/** At or below this a side has no orders left to give and must ask for terms. */
export const WILL_FLOOR = 25

/** Cost of refusing an offered peace: pressing a war past its aims exhausts you too. */
const REJECT_COST = 8

const WILL = {
  perFormationLost: 4,
  perObjectiveLost: 3,
  perObjectiveTaken: 3,
  /**
   * Every turn, regardless — long wars exhaust. Deliberately small: this is the
   * backstop that stops a stalemate running forever, and if it is large enough to
   * decide games then every war ends on the same turn no matter what happened.
   */
  weariness: 0.15,
}

const REFIT_GAIN = 30
const RECOVER_GAIN = 12
/** Cohesion and damage a cut-off formation takes each turn. */
const STARVE_COHESION = 15
const STARVE_WEAR = 25

const STRENGTH: Record<UnitType, number> = { infantry: 3, armour: 3, recon: 1 }
const ORDER_OF_BATTLE: UnitType[] = ['infantry', 'infantry', 'infantry', 'armour', 'recon']
/**
 * Enough to man the contact line and hold something back. Too few and the armies
 * never touch: they wander toward objectives across open country, no front forms,
 * and with no front there is nothing to flank and no ring to close.
 */
const FORMATIONS_PER_SIDE = 26
const AIMS_PER_SIDE = 6

export interface KesselOptions {
  seats: SeatConfig[]
  seed?: number
  record?: boolean
  mapId?: string
}

export function createGame({ seats, seed = 1, record = true, mapId = 'europe' }: KesselOptions): KesselState {
  if (seats.length !== 2) throw new Error('Kessel is a two-sided game')
  const m = mapOf(mapId)

  const byLon = [...m.ids].sort((a, b) => m.province[a].cx - m.province[b].cx)
  const half = Math.floor(byLon.length / 2)

  const owner: Record<ProvinceId, PlayerId> = {}
  byLon.forEach((id, i) => {
    owner[id] = i < half ? 0 : 1
  })

  const sides: Side[] = seats.map((seat, id) => ({
    id,
    name: seat.name,
    color: seat.color ?? id,
    bot: seat.bot,
    alive: true,
    will: 100,
    aims: byLon
      .filter((p) => owner[p] !== id && m.province[p].vp > 0)
      .sort((a, b) => m.province[b].vp - m.province[a].vp)
      .slice(0, AIMS_PER_SIDE),
  }))

  const formations: Formation[] = []
  let nextFormationId = 0
  for (const side of sides) {
    const mine = byLon.filter((id) => owner[id] === side.id)
    const onContact = (id: ProvinceId) => (m.adjacency[id] ?? []).some((n) => owner[n] !== side.id)
    // The line first, then depth behind it — an army that starts on its own
    // railheads has to march to the war before it can fight one.
    const posts = [
      ...mine.filter(onContact).sort((a, b) => value(m, b) - value(m, a)),
      ...mine.filter((id) => !onContact(id)).sort((a, b) => value(m, b) - value(m, a)),
    ]

    const stacked: Record<ProvinceId, number> = {}
    let placed = 0
    for (let pass = 0; placed < FORMATIONS_PER_SIDE && pass < 3; pass++) {
      for (const at of posts) {
        if (placed >= FORMATIONS_PER_SIDE) break
        if ((stacked[at] ?? 0) >= STACK_LIMIT[m.province[at].terrain]) continue
        stacked[at] = (stacked[at] ?? 0) + 1
        const type = ORDER_OF_BATTLE[placed % ORDER_OF_BATTLE.length]
        formations.push({
          id: nextFormationId++,
          owner: side.id,
          type,
          at,
          strength: STRENGTH[type],
          cohesion: 100,
          wear: 0,
          dug: 0,
          supply: 3,
        })
        placed++
      }
    }
  }

  const s: KesselState = {
    mapId,
    sides,
    owner,
    formations,
    orders: {},
    phase: 'orders',
    current: 0,
    turn: 1,
    log: [],
    moves: [],
    record,
    rngState: seed | 0,
    winner: null,
    nextFormationId,
  }

  const states = supplyStates(m, s, 0)
  for (const f of s.formations) if (f.owner === 0) f.supply = states[f.id] ?? 0
  return s
}

const value = (m: GameMap, p: ProvinceId) => m.province[p].depot * 2 + m.province[p].vp

const clone = (s: KesselState): KesselState => ({
  ...s,
  sides: s.sides.map((x) => ({ ...x, aims: [...x.aims] })),
  owner: { ...s.owner },
  formations: s.formations.map((f) => ({ ...f })),
  orders: { ...s.orders },
  log: [...s.log],
  moves: s.record ? [...s.moves] : s.moves,
})

const log = (s: KesselState, player: PlayerId | null, text: string) => {
  s.log.push({ turn: s.turn, player, text })
}

const need = (cond: boolean, why: string) => {
  if (!cond) throw new Error(why)
}

const at = (s: KesselState, where: ProvinceId) => s.formations.filter((f) => f.at === where)

export function applyMove(s0: KesselState, move: Move): KesselState {
  const s = clone(s0)
  const m = mapOf(s.mapId)
  if (s.record) s.moves.push(move)
  const me = s.current

  switch (move.type) {
    case 'order': {
      need(s.phase === 'orders', 'not the order phase')
      const f = s.formations.find((x) => x.id === move.formation)
      need(!!f && f.owner === me, 'not your formation')
      need(legalOrder(m, s, f as Formation, move.order), 'illegal order')
      need(
        activationsAfter(s, me, (f as Formation).at, move.order) <= ACTIVATIONS,
        'no activations left this turn',
      )
      s.orders[move.formation] = move.order
      break
    }
    case 'clearOrder': {
      need(s.phase === 'orders', 'not the order phase')
      delete s.orders[move.formation]
      break
    }
    case 'commit': {
      need(s.phase === 'orders', 'not the order phase')
      return endTurn(m, resolveTurn(m, s))
    }
    case 'offerTerms': {
      need(s.phase === 'orders', 'not the order phase')
      need(s.sides[me].will <= WILL_FLOOR, 'will is not broken')
      if (exhausted(s)) return settle(m, s)
      s.phase = 'terms'
      s.current = (1 - me) as PlayerId
      log(s, me, 'offers terms')
      break
    }
    case 'acceptTerms': {
      need(s.phase === 'terms', 'no terms on the table')
      return settle(m, s)
    }
    case 'rejectTerms': {
      need(s.phase === 'terms', 'no terms on the table')
      s.sides[me].will = clampWill(s.sides[me].will - REJECT_COST)
      s.phase = 'orders'
      s.current = (1 - me) as PlayerId
      log(s, me, 'refuses terms')
      // Refusing costs will, so a side that keeps refusing eventually breaks too,
      // and two broken sides is where a war ends whatever either of them wanted.
      if (exhausted(s)) return settle(m, s)
      break
    }
  }
  return s
}

/** Provinces `p` has already set in motion this turn. Holding and refitting are free. */
export function activationsUsed(s: KesselState, p: PlayerId): Set<ProvinceId> {
  const out = new Set<ProvinceId>()
  for (const f of s.formations) {
    if (f.owner !== p) continue
    const o = s.orders[f.id]
    if (o && (o.type === 'move' || o.type === 'attack')) out.add(f.at)
  }
  return out
}

const activationsAfter = (s: KesselState, p: PlayerId, from: ProvinceId, order: Order): number => {
  if (order.type !== 'move' && order.type !== 'attack') return activationsUsed(s, p).size
  const after = activationsUsed(s, p)
  after.add(from)
  return after.size
}

function legalOrder(m: GameMap, s: KesselState, f: Formation, order: Order): boolean {
  switch (order.type) {
    case 'hold':
    case 'refit':
      return true
    case 'move':
      return reachable(m, s, f).cost[order.to] !== undefined
    case 'attack':
      // The culminating point, and the reason an offensive has a reach: anything
      // short of full supply can still hold the ground it stands on and can no
      // longer start anything.
      return (
        f.supply >= 3 &&
        (m.adjacency[f.at] ?? []).includes(order.to) &&
        at(s, order.to).some((x) => x.owner !== f.owner)
      )
  }
}

export function legalMoves(s: KesselState, p: PlayerId): Move[] {
  if (s.phase === 'terms') {
    return p === s.current ? [{ type: 'acceptTerms' }, { type: 'rejectTerms' }] : []
  }
  if (s.phase !== 'orders' || p !== s.current) return []

  // A side whose will is gone has no orders left to give — it can only ask for
  // terms. Without this the war has no way to end short of annihilation, which is
  // the grind war aims exist to prevent.
  if (s.sides[p].will <= WILL_FLOOR) return [{ type: 'offerTerms' }]

  const m = mapOf(s.mapId)
  const out: Move[] = [{ type: 'commit' }]

  const spent = activationsUsed(s, p)
  for (const f of s.formations) {
    if (f.owner !== p) continue
    const orders: Order[] = [{ type: 'hold' }, { type: 'refit' }]
    if (spent.size < ACTIVATIONS || spent.has(f.at)) {
      for (const n of Object.keys(reachable(m, s, f).cost)) orders.push({ type: 'move', to: n })
      for (const n of m.adjacency[f.at] ?? []) orders.push({ type: 'attack', to: n })
    }
    for (const order of orders) {
      if (legalOrder(m, s, f, order)) out.push({ type: 'order', formation: f.id, order })
    }
  }
  return out
}

function resolveTurn(m: GameMap, s: KesselState): KesselState {
  const me = s.current
  const rng = rngFrom(s.rngState)
  const rand = () => rng.next()
  const mineBefore = objectivesHeld(m, s, me)
  const theirsBefore = objectivesHeld(m, s, (1 - me) as PlayerId)
  const standingBefore = s.sides.map((side) => s.formations.filter((f) => f.owner === side.id).length)

  const ordered = (type: Order['type']) =>
    s.formations.filter((f) => f.owner === me && s.orders[f.id]?.type === type)

  for (const f of ordered('hold')) f.dug = Math.min(3, f.dug + 1)
  for (const f of ordered('refit')) {
    f.cohesion = Math.min(100, f.cohesion + (f.supply >= 2 ? REFIT_GAIN : RECOVER_GAIN))
    f.dug = 0
  }

  for (const f of ordered('move')) {
    const order = s.orders[f.id] as { type: 'move'; to: ProvinceId }
    const reach = reachable(m, s, f)
    if (reach.cost[order.to] === undefined) continue
    for (const p of routeTo(reach, order.to)) s.owner[p] = me
    f.at = order.to
    f.dug = 0
  }

  const attacks = new Map<ProvinceId, Formation[]>()
  for (const f of ordered('attack')) {
    const order = s.orders[f.id] as { type: 'attack'; to: ProvinceId }
    if (!legalOrder(m, s, f, order)) continue
    attacks.set(order.to, [...(attacks.get(order.to) ?? []), f])
  }

  for (const [target, all] of attacks) {
    const defenders = at(s, target).filter((f) => f.owner !== me)
    if (defenders.length === 0) continue

    // Frontage caps how much reaches the fighting. Mass still wins, but it has to
    // fit through the borders it is attacking across — which is why converging on
    // a province from several directions brings more to bear than piling up on one.
    const sources = [...new Set(all.map((f) => f.at))]
    const room = Math.min(4, sources.reduce((n, src) => n + frontage(m, src, target), 0))
    const committed = [...all].sort((a, b) => b.strength - a.strength).slice(0, room)

    const engagement = resolve(m, committed, defenders, target, rand)
    for (const f of committed) Object.assign(f, applyLoss(f, engagement.attackerLoss))
    for (const f of defenders) Object.assign(f, applyLoss(f, engagement.defenderLoss))

    const fallback = depthMap(m, s, defenders[0].owner)
    for (const f of defenders) {
      if (f.strength <= 0) {
        // Beaten down in a stand-up fight, a formation leaves a remnant that plugs
        // the gap behind it. Beaten in a pocket it leaves nothing — which is what
        // makes encirclement categorically worse than attrition rather than merely
        // a better exchange rate.
        const rear = retreatTargets(m, s, f, fallback)
        remove(m, s, f, 'is destroyed')
        if (rear.length > 0) cadre(s, f, rear[0])
        continue
      }
      if (f.cohesion > 0) continue
      const where = retreatTargets(m, s, f, fallback)
      if (where.length === 0) {
        // The rule the whole game is built around.
        remove(m, s, f, 'is encircled and surrenders')
        continue
      }
      f.at = where[0]
      f.dug = 0
      f.cohesion = 5
    }
    for (const f of committed) if (f.strength <= 0) remove(m, s, f, 'is destroyed')

    if (at(s, target).length === 0 || at(s, target).every((f) => f.owner === me)) {
      s.owner[target] = me
      const room = STACK_LIMIT[m.province[target].terrain] - at(s, target).length
      const advancing = committed
        .filter((f) => f.strength > 0 && f.at !== target)
        .sort((a, b) => b.cohesion - a.cohesion)
        .slice(0, Math.max(0, room))
      for (const f of advancing) {
        f.at = target
        f.dug = 0
      }
      log(s, me, `takes ${m.province[target].name}`)
    } else {
      log(s, me, `is repulsed at ${m.province[target].name}`)
    }
  }

  s.orders = {}
  s.rngState = rng.state
  return updateWill(m, s, me, mineBefore, theirsBefore, standingBefore)
}

const CORPS: Record<UnitType, string> = {
  infantry: 'an infantry corps',
  armour: 'an armoured corps',
  recon: 'a reconnaissance corps',
}

const CADRE_COHESION = 30

function cadre(s: KesselState, f: Formation, at: ProvinceId) {
  s.formations.push({
    id: s.nextFormationId++,
    owner: f.owner,
    type: f.type,
    at,
    strength: 1,
    cohesion: CADRE_COHESION,
    wear: 0,
    dug: 0,
    supply: f.supply,
  })
}

function remove(m: GameMap, s: KesselState, f: Formation, why: string) {
  s.formations = s.formations.filter((x) => x.id !== f.id)
  log(s, f.owner, `${m.province[f.at].name}: ${CORPS[f.type]} ${why}`)
}

const objectivesHeld = (m: GameMap, s: KesselState, p: PlayerId): number =>
  s.sides[p].aims.reduce((n, id) => n + (s.owner[id] === p ? m.province[id].vp : 0), 0)

function updateWill(
  m: GameMap,
  s: KesselState,
  me: PlayerId,
  mineBefore: number,
  theirsBefore: number,
  standingBefore: number[],
): KesselState {
  const them = (1 - me) as PlayerId
  const gained = objectivesHeld(m, s, me) - mineBefore
  const lost = theirsBefore - objectivesHeld(m, s, them)
  const casualties = s.sides.map(
    (side, i) => standingBefore[i] - s.formations.filter((f) => f.owner === side.id).length,
  )

  s.sides[me].will = clampWill(
    s.sides[me].will + gained * WILL.perObjectiveTaken - casualties[me] * WILL.perFormationLost - WILL.weariness,
  )
  s.sides[them].will = clampWill(
    s.sides[them].will - lost * WILL.perObjectiveLost - casualties[them] * WILL.perFormationLost - WILL.weariness,
  )
  return s
}

const clampWill = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10))

/** Neither side can carry on. Mutual exhaustion ends more wars than victory does. */
const exhausted = (s: KesselState) => s.sides.every((side) => side.will <= WILL_FLOOR)

function endTurn(m: GameMap, s: KesselState): KesselState {
  const next = (1 - s.current) as PlayerId

  const states = supplyStates(m, s, next)
  for (const f of s.formations) {
    if (f.owner !== next) continue
    f.supply = states[f.id] ?? 0
    // A pocket only starves while somebody is pressing it. Without this gate,
    // severing one rear province once quietly kills an army the enemy has walked
    // away from, and cordoning beats fighting.
    const pressed = (m.adjacency[f.at] ?? []).some((n) =>
      s.formations.some((x) => x.at === n && x.owner !== next && x.supply >= 2),
    )
    if (f.supply === 0 && pressed) {
      Object.assign(f, applyLoss(f, STARVE_WEAR))
      f.cohesion = Math.max(0, f.cohesion - STARVE_COHESION)
    } else if (f.supply >= 2) {
      f.cohesion = Math.min(100, f.cohesion + RECOVER_GAIN)
    }
  }

  const starved = s.formations.filter((f) => f.owner === next && f.strength <= 0)
  for (const f of starved) remove(m, s, f, 'starves in the pocket')
  if (starved.length > 0) {
    s.sides[next].will = clampWill(s.sides[next].will - starved.length * WILL.perFormationLost)
  }

  s.current = next
  if (next === 0) s.turn += 1
  s.phase = 'orders'

  if (!s.formations.some((f) => f.owner === next)) return settle(m, s)
  return s
}

const aimScore = (m: GameMap, s: KesselState, p: PlayerId): number => {
  const total = s.sides[p].aims.reduce((n, id) => n + m.province[id].vp, 0)
  return total === 0 ? 0 : objectivesHeld(m, s, p) / total
}

const groundHeld = (m: GameMap, s: KesselState, p: PlayerId): number =>
  m.ids.reduce((n, id) => n + (s.owner[id] === p ? m.province[id].vp : 0), 0)

/**
 * End the war on the line as it stands, scored against each side's stated aims.
 * You can win a war you did not conquer, and lose one in which you took ground.
 *
 * Aims decide it; everything of value held decides ties. Without the tiebreak two
 * sides that both failed score 0–0 and the war is called a draw however lopsided
 * the map has become.
 */
function settle(m: GameMap, s: KesselState): KesselState {
  const aims = s.sides.map((side) => aimScore(m, s, side.id))
  const ground = s.sides.map((side) => groundHeld(m, s, side.id))
  const score = aims[0] === aims[1] ? ground : aims
  s.winner = score[0] === score[1] ? null : score[0] > score[1] ? 0 : 1
  s.phase = 'gameOver'
  log(s, s.winner, s.winner === null ? 'the war ends in stalemate' : 'achieves its war aims')
  return s
}

export function view(s: KesselState): GameView {
  const m = mapOf(s.mapId)
  const score = s.sides.map((side) => aimScore(m, s, side.id))
  const sum = score.reduce((a, b) => a + b, 0)
  return {
    current: s.current,
    turn: s.turn,
    winner: s.winner,
    over: s.phase === 'gameOver',
    players: s.sides.map((x) => ({ id: x.id, name: x.name, bot: x.bot, alive: x.alive })),
    standing: sum === 0 ? score.map(() => 1 / score.length) : score.map((n) => n / sum),
  }
}
