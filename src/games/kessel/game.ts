import { rngFrom } from '../../engine/rng'
import type { PlayerId, SeatConfig } from '../../engine/types'
import type { GameView } from '../types'
import { applyLoss, engage, resolve } from './combat'
import { updateSightings } from './intel'
import { STACK_LIMIT, mapOf } from './map'
import type { GameMap, ProvinceId } from './map'
import { ASSAULT_COST, allowance, exploitReach, reachable, routeTo } from './movement'
import { depthMap, liveDepots, network, retreatTargets, supplyStates } from './supply'
import type { Formation, FormationId, KesselState, Move, Order, Side, UnitType, Verdict } from './types'

export const RULES_VERSION = ['kessel2', 'rear', 'rail6', 'exploit', 'mud10', 'aimsdealt6of10', 'will25', 'hq2r3', 'armies26v29', 'aims24'].join('|')

/**
 * Provinces you can set in motion in one turn.
 *
 * A commander who can order every formation every turn is not choosing anything.
 * The cost is per *province*, not per formation, so concentrating a push is
 * cheaper than spreading it — which is the operational lesson, and the reason a
 * solid manned line is not free.
 */
export const ACTIVATIONS = 7

/**
 * Headquarters per side, and how far each one's command reaches: provinces of the
 * side's own ground, counted from where it stands. A formation beyond every one of
 * them is out of command, and an order to move or attack reaches it a turn late.
 *
 * Two, because a main front and a sideshow is the choice this exists to force: the
 * line can be commanded, and Norway or the south of Italy then waits a turn for
 * its orders unless a headquarters goes there and the line goes without.
 */
export const HQS_PER_SIDE = 2
export const COMMAND_RADIUS = 3
/** How far a headquarters relocates in a turn, through its own side's ground. */
export const HQ_MOVE = 4

/** At or below this a side can no longer be ordered forward, and may ask for terms. */
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

/** Establishment: the steps a corps of each type is raised with, and rebuilt back up to. */
export const STRENGTH: Record<UnitType, number> = { infantry: 3, armour: 3, recon: 1 }
const ORDER_OF_BATTLE: UnitType[] = ['infantry', 'infantry', 'infantry', 'armour', 'recon']
/**
 * Enough to man the contact line and hold something back. Too few and the armies
 * never touch: they wander toward objectives across open country, no front forms,
 * and with no front there is nothing to flank and no ring to close.
 *
 * By side, West then East, and unequal on purpose. The East holds the deep, open
 * half of the map with its peninsulas at the far end of its railways, and with
 * equal armies the West wins most wars between identical doctrines. The difference
 * is whatever brings `npm run bench:kessel -- maneuver maneuver` back to an even split.
 */
const FORMATIONS_PER_SIDE = [26, 29]
export const AIMS_PER_SIDE = 6
/**
 * What each side's aims are dealt from: the most valuable ground on the enemy's
 * side of the line. The menu is public and the deal is not — which is the shape
 * real war aims have. Everyone knew the Reich wanted oil, steel or the capital;
 * nobody knew which.
 */
export const AIM_MENU = 10
/** A side's enemy learns an aim once this many of that side's formations stand beside it. */
const MASSED = 3

/**
 * Share of the map, from each side's own end, that is its rear: where supply enters
 * and reinforcements arrive. Depots are railheads on the line back to here, so
 * a depot the enemy has cut off from it issues nothing.
 */
const HOME_SHARE = 1 / 14
/** Consecutive turns refitting on a live railhead, under strength, to regain a step. */
export const REPLACEMENT_TURNS = 3
/** A fresh infantry corps arrives at each side's rearmost railhead every this many turns. */
export const REINFORCE_EVERY = 6

/**
 * How far apart the two sides' shares of their own aims have to end for a peace to
 * be more than narrow. The winner is decided by who holds more; this is what makes
 * refusing terms worth a side's will when it is already ahead.
 */
export const VERDICT_MARGIN: Record<'decisive' | 'clear', number> = { decisive: 0.5, clear: 0.25 }

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
  const rear = Math.max(1, Math.round(byLon.length * HOME_SHARE))

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
    aims: [],
    revealed: [],
    home: id === 0 ? byLon.slice(0, rear) : byLon.slice(byLon.length - rear),
    seen: {},
    hqs: [],
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
    const quota = FORMATIONS_PER_SIDE[side.id]
    for (let pass = 0; placed < quota && pass < 3; pass++) {
      for (const at of posts) {
        if (placed >= quota) break
        if ((stacked[at] ?? 0) >= STACK_LIMIT[m.province[at].terrain]) continue
        stacked[at] = (stacked[at] ?? 0) + 1
        const type = ORDER_OF_BATTLE[placed % ORDER_OF_BATTLE.length]
        formations.push(raise(nextFormationId++, side.id, type, at))
        placed++
      }
    }
  }
  for (const side of sides) side.hqs = placeHqs(m, owner, formations, side.id)

  const s: KesselState = {
    mapId,
    sides,
    owner,
    formations,
    orders: {},
    delayed: {},
    hqOrders: {},
    phase: 'orders',
    current: 0,
    turn: 1,
    log: [],
    moves: [],
    record,
    rngState: seed | 0,
    winner: null,
    nextFormationId,
    offered: false,
    peace: null,
  }

  // The deal: six off each side's menu, from the game's own generator, so the
  // same seed is the same war and neither side chose anything the other can read.
  const rng = rngFrom(s.rngState)
  for (const side of s.sides) {
    const menu = aimMenu(m, s, side.id)
    while (side.aims.length < AIMS_PER_SIDE && menu.length > 0) {
      side.aims.push(menu.splice(Math.floor(rng.next() * menu.length), 1)[0])
    }
  }
  s.rngState = rng.state

  const states = supplyStates(m, s, 0)
  for (const f of s.formations) if (f.owner === 0) f.supply = states[f.id] ?? 0
  for (const side of s.sides) side.seen = updateSightings(m, s, side.id)
  return s
}

const raise = (id: number, owner: PlayerId, type: UnitType, at: ProvinceId): Formation => ({
  id,
  owner,
  type,
  at,
  strength: STRENGTH[type],
  cohesion: 100,
  wear: 0,
  dug: 0,
  supply: 3,
  rest: 0,
})

const value = (m: GameMap, p: ProvinceId) => m.province[p].depot * 2 + m.province[p].vp

/**
 * Where a side's headquarters start: one at a time, wherever commands the most of
 * its army, with the contact line counting double because the line is where an
 * order arriving late costs most. Never on the line itself, where the first
 * assault would overrun it.
 */
function placeHqs(
  m: GameMap,
  owner: Record<ProvinceId, PlayerId>,
  formations: Formation[],
  p: PlayerId,
): ProvinceId[] {
  const own = m.ids.filter((id) => owner[id] === p)
  const onLine = (id: ProvinceId) => (m.adjacency[id] ?? []).some((n) => owner[n] !== p)
  const mine = formations.filter((f) => f.owner === p)
  const reach = new Map(own.map((id) => [id, groundWithin(m, owner, p, [id], COMMAND_RADIUS)]))
  const picked: ProvinceId[] = []
  const covered = new Set<FormationId>()
  for (let i = 0; i < HQS_PER_SIDE; i++) {
    let best: ProvinceId | null = null
    let gain = -1
    for (const id of own) {
      if (onLine(id) || picked.includes(id)) continue
      const near = reach.get(id) as Set<ProvinceId>
      const g = mine.reduce((n, f) => n + (!covered.has(f.id) && near.has(f.at) ? (onLine(f.at) ? 2 : 1) : 0), 0)
      if (g > gain) {
        gain = g
        best = id
      }
    }
    if (best === null) break
    picked.push(best)
    for (const f of mine) if ((reach.get(best) as Set<ProvinceId>).has(f.at)) covered.add(f.id)
  }
  return picked
}

/** Provinces `p` holds within `radius` steps of `from`, walking only through ground it holds. */
function groundWithin(
  m: GameMap,
  owner: Record<ProvinceId, PlayerId>,
  p: PlayerId,
  from: ProvinceId[],
  radius: number,
): Set<ProvinceId> {
  let ring = from.filter((id) => owner[id] === p)
  const seen = new Set<ProvinceId>(ring)
  for (let d = 0; d < radius && ring.length > 0; d++) {
    const next: ProvinceId[] = []
    for (const at of ring) {
      for (const n of m.adjacency[at] ?? []) {
        if (seen.has(n) || owner[n] !== p) continue
        seen.add(n)
        next.push(n)
      }
    }
    ring = next
  }
  return seen
}

/** The ground headquarters standing on `from` would command. */
export const commandFrom = (m: GameMap, s: KesselState, p: PlayerId, from: ProvinceId[]): Set<ProvinceId> =>
  groundWithin(m, s.owner, p, from, COMMAND_RADIUS)

/**
 * The formations whose orders `p` has carried out the turn they are given.
 *
 * A side with no headquarters at all is not modelled for command and commands
 * everything, which is what a scenario or a test that places none gets.
 */
export function inCommand(m: GameMap, s: KesselState, p: PlayerId): Set<FormationId> {
  const mine = s.formations.filter((f) => f.owner === p)
  if (s.sides[p].hqs.length === 0) return new Set(mine.map((f) => f.id))
  const reach = commandFrom(m, s, p, s.sides[p].hqs)
  return new Set(mine.filter((f) => reach.has(f.at)).map((f) => f.id))
}

/** Where headquarters `hq` of side `p` can be sent this turn, the ground it stands on included. */
export function hqReach(m: GameMap, s: KesselState, p: PlayerId, hq: number): Set<ProvinceId> {
  const at = s.sides[p].hqs[hq]
  return at === undefined ? new Set() : groundWithin(m, s.owner, p, [at], HQ_MOVE)
}

/**
 * The war aims a side is dealt from: the most valuable ground the enemy holds,
 * as the war opens. Ties go to the better-served province, then to the name, so
 * the menu is the same every time the same map is dealt.
 */
export function aimMenu(m: GameMap, s: KesselState, p: PlayerId): ProvinceId[] {
  return m.ids
    .filter((id) => s.owner[id] !== p && m.province[id].vp > 0)
    .sort(
      (a, b) =>
        m.province[b].vp - m.province[a].vp ||
        m.province[b].depot - m.province[a].depot ||
        (a < b ? -1 : 1),
    )
    .slice(0, AIM_MENU)
}

const clone = (s: KesselState): KesselState => ({
  ...s,
  sides: s.sides.map((x) => ({ ...x, aims: [...x.aims], revealed: [...x.revealed], hqs: [...x.hqs] })),
  owner: { ...s.owner },
  formations: s.formations.map((f) => ({ ...f })),
  orders: { ...s.orders },
  delayed: { ...s.delayed },
  hqOrders: { ...s.hqOrders },
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

/** A side at or below the floor: it can hold, move and refit, and it can ask for terms. It cannot attack. */
export const broken = (s: KesselState, p: PlayerId) => s.sides[p].will <= WILL_FLOOR

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
      need(!s.delayed[move.formation], "still carrying out last turn's order")
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
    case 'moveHq': {
      need(s.phase === 'orders', 'not the order phase')
      need(move.hq >= 0 && move.hq < s.sides[me].hqs.length, 'no such headquarters')
      if (move.to === null) {
        delete s.hqOrders[move.hq]
        break
      }
      need(hqReach(m, s, me, move.hq).has(move.to), 'the headquarters cannot get there this turn')
      s.hqOrders[move.hq] = move.to
      break
    }
    case 'commit': {
      need(s.phase === 'orders', 'not the order phase')
      return endTurn(m, resolveTurn(m, s))
    }
    case 'offerTerms': {
      need(s.phase === 'orders', 'not the order phase')
      need(broken(s, me), 'will is not broken')
      need(!s.offered, 'terms were already refused this turn')
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
      // The broken side fights the turn out: it can hold, move and refit, and
      // it can ask again next turn. Refusing costs will, so a side that keeps
      // refusing eventually breaks too, and two broken sides is where a war ends
      // whatever either of them wanted.
      s.offered = true
      s.phase = 'orders'
      s.current = (1 - me) as PlayerId
      log(s, me, 'refuses terms')
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
      // longer start anything. A side whose will is gone is in the same position.
      return (
        f.supply >= 3 &&
        !broken(s, f.owner) &&
        (m.adjacency[f.at] ?? []).includes(order.to) &&
        at(s, order.to).some((x) => x.owner !== f.owner) &&
        (order.onward === undefined || exploitReach(m, s, f, order.to).cost[order.onward] !== undefined)
      )
  }
}

export function legalMoves(s: KesselState, p: PlayerId): Move[] {
  if (p !== s.current) return []
  const m = mapOf(s.mapId)

  if (s.phase === 'terms') return [{ type: 'acceptTerms' }, { type: 'rejectTerms' }]
  if (s.phase !== 'orders') return []

  const out: Move[] = [{ type: 'commit' }]
  // A side whose will is gone may ask for terms once a turn. Refused, it fights
  // the turn out without attacking — the war still has a way to end short of
  // annihilation, and "fight on" still means something to the side that said it.
  if (broken(s, p) && !s.offered) out.push({ type: 'offerTerms' })

  for (let hq = 0; hq < s.sides[p].hqs.length; hq++) {
    for (const to of hqReach(m, s, p, hq)) out.push({ type: 'moveHq', hq, to })
  }

  const spent = activationsUsed(s, p)
  const depth = depthMap(m, s, p)
  for (const f of s.formations) {
    if (f.owner !== p || s.delayed[f.id]) continue
    const orders: Order[] = [{ type: 'hold' }, { type: 'refit' }]
    if (spent.size < ACTIVATIONS || spent.has(f.at)) {
      for (const n of Object.keys(reachable(m, s, f, { depth }).cost)) orders.push({ type: 'move', to: n })
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

  const mine = s.formations.filter((f) => f.owner === me)

  // Command, measured on the board the orders were written on. What was ordered
  // out of command last turn arrives now and is carried out; what is ordered out
  // of command now sets off, and is carried out next turn.
  const command = inCommand(m, s, me)
  const sent: Record<FormationId, Order> = {}
  for (const f of mine) {
    const late = s.delayed[f.id]
    const order = s.orders[f.id]
    delete s.delayed[f.id]
    if (late) {
      s.orders[f.id] = late
    } else if (order && (order.type === 'move' || order.type === 'attack') && !command.has(f.id)) {
      sent[f.id] = order
      delete s.orders[f.id]
    }
  }

  const ordered = (type: Order['type']) => mine.filter((f) => s.orders[f.id]?.type === type)

  // Standing still is digging in, whether or not anybody said so.
  for (const f of mine) {
    const o = s.orders[f.id]
    if (!o || o.type === 'hold') f.dug = Math.min(3, f.dug + 1)
  }

  const railheads = new Set(liveDepots(m, s, me))
  for (const f of mine) {
    if (s.orders[f.id]?.type !== 'refit') {
      f.rest = 0
      continue
    }
    f.cohesion = Math.min(100, f.cohesion + (f.supply >= 2 ? REFIT_GAIN : RECOVER_GAIN))
    f.dug = 0
    // Replacements arrive by rail, so a corps only rebuilds where the trains
    // stop — which makes a railhead in the rear worth holding for its own sake.
    if (f.supply >= 3 && railheads.has(f.at) && f.strength < STRENGTH[f.type]) {
      f.rest += 1
      if (f.rest >= REPLACEMENT_TURNS) {
        f.strength += 1
        f.rest = 0
        log(s, me, `${m.province[f.at].name}: ${CORPS[f.type]} is brought back up to strength`)
      }
    } else f.rest = 0
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
    if (!legalOrder(m, s, f, { type: 'attack', to: order.to })) continue
    attacks.set(order.to, [...(attacks.get(order.to) ?? []), f])
  }

  const aims = s.sides[me]
  const reveal = (p: ProvinceId) => {
    if (aims.aims.includes(p) && !aims.revealed.includes(p)) aims.revealed.push(p)
  }

  for (const [target, all] of attacks) {
    const defenders = at(s, target).filter((f) => f.owner !== me)
    if (defenders.length === 0) continue
    reveal(target)

    // Frontage caps how much reaches the fighting. Mass still wins, but it has to
    // fit through the borders it is attacking across — which is why converging on
    // a province from several directions brings more to bear than piling up on one.
    const committed = engage(m, all, target)

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

      // The exploitation: whoever broke in rides on with what the assault left,
      // over ground the enemy no longer stands on, and stops where it meets him.
      for (const f of advancing) {
        const onward = (s.orders[f.id] as { onward?: ProvinceId }).onward
        if (!onward || onward === target) continue
        const reach = reachable(m, s, f, { from: target, budget: allowance(f.type, s.turn) - ASSAULT_COST })
        if (reach.cost[onward] === undefined) continue
        for (const p of routeTo(reach, onward)) s.owner[p] = me
        f.at = onward
        f.dug = 0
        log(s, me, `rides on to ${m.province[onward].name}`)
      }
    } else {
      log(s, me, `is repulsed at ${m.province[target].name}`)
    }
  }

  // An aim gives itself away when it is taken, or when the army masses beside it.
  for (const p of aims.aims) {
    if (s.owner[p] === me) reveal(p)
    else if (mine.filter((f) => f.strength > 0 && (m.adjacency[p] ?? []).includes(f.at)).length >= MASSED) reveal(p)
  }

  // Moves and attacks are spent; a refit stands until there is nothing left to regain.
  const standing: Record<number, Order> = {}
  for (const f of s.formations) {
    const o = s.orders[f.id]
    if (!o) continue
    if (f.owner !== me || o.type === 'refit') standing[f.id] = o
  }
  s.orders = standing

  // Headquarters go last, so where they stand commands next turn and never the
  // turn being resolved — sending one forward is a plan, not a way to reach this
  // turn's orders.
  for (const [hq, to] of Object.entries(s.hqOrders)) {
    if (s.owner[to] === me) s.sides[me].hqs[Number(hq)] = to
  }
  s.hqOrders = {}
  displaceOverrun(m, s)
  Object.assign(s.delayed, sent)

  s.rngState = rng.state
  return updateWill(m, s, me, mineBefore, theirsBefore, standingBefore)
}

/**
 * A headquarters whose ground has been taken falls back to the nearest ground its
 * side still holds out of contact, and commands from there. It is not destroyed:
 * the cost of being overrun is every order that now arrives late because the staff
 * is somewhere nobody planned for it to be.
 */
function displaceOverrun(m: GameMap, s: KesselState) {
  for (const side of s.sides) {
    side.hqs = side.hqs.map((hq) => {
      if (s.owner[hq] === side.id) return hq
      const to = nearestQuietGround(m, s, side.id, hq)
      if (to !== hq) log(s, side.id, `${m.province[hq].name}: headquarters overrun, falls back to ${m.province[to].name}`)
      return to
    })
  }
}

function nearestQuietGround(m: GameMap, s: KesselState, p: PlayerId, from: ProvinceId): ProvinceId {
  const enemyAt = new Set(s.formations.filter((f) => f.owner !== p).map((f) => f.at))
  const quiet = (id: ProvinceId) => !(m.adjacency[id] ?? []).some((n) => enemyAt.has(n))
  const seen = new Set<ProvinceId>([from])
  const queue = [from]
  let fallback: ProvinceId | null = null
  for (let i = 0; i < queue.length; i++) {
    const here = queue[i]
    if (s.owner[here] === p) {
      if (quiet(here)) return here
      fallback ??= here
    }
    for (const n of m.adjacency[here] ?? []) {
      if (seen.has(n)) continue
      seen.add(n)
      queue.push(n)
    }
  }
  return fallback ?? from
}

const CORPS: Record<UnitType, string> = {
  infantry: 'an infantry corps',
  armour: 'an armoured corps',
  recon: 'a reconnaissance corps',
}

const CADRE_COHESION = 30

function cadre(s: KesselState, f: Formation, at: ProvinceId) {
  s.formations.push({
    ...raise(s.nextFormationId++, f.owner, f.type, at),
    strength: 1,
    cohesion: CADRE_COHESION,
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
const exhausted = (s: KesselState) => s.sides.every((side) => broken(s, side.id))

/**
 * Where a reinforcement detrains: the largest live railhead with room for one
 * more corps, the one nearest home if several. Largest first, because the
 * nearest to home on its own can be a backwater at the end of a sea link, and a
 * fresh corps that detrains a week's march from the war is not a reinforcement.
 */
export function rearmostRailhead(m: GameMap, s: KesselState, p: PlayerId): ProvinceId | null {
  const net = network(m, s, p)
  const hops: Record<ProvinceId, number> = {}
  const queue: ProvinceId[] = []
  for (const h of s.sides[p].home) {
    if (!net.has(h)) continue
    hops[h] = 0
    queue.push(h)
  }
  for (let i = 0; i < queue.length; i++) {
    for (const n of m.adjacency[queue[i]] ?? []) {
      if (hops[n] !== undefined || !net.has(n)) continue
      hops[n] = hops[queue[i]] + 1
      queue.push(n)
    }
  }
  return (
    liveDepots(m, s, p, net)
      .filter((d) => at(s, d).length < STACK_LIMIT[m.province[d].terrain])
      .sort(
        (a, b) =>
          m.province[b].depot - m.province[a].depot || hops[a] - hops[b] || (a < b ? -1 : 1),
      )[0] ?? null
  )
}

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
  s.offered = false

  // Reinforcements are on the calendar, the same for both sides: a corps by
  // rail to the rearmost railhead still standing. It gives the clock a second
  // hand — a side that is losing can hold for the next draft, and one that is
  // winning had better finish before it arrives.
  if (next === 0 && s.turn % REINFORCE_EVERY === 0) {
    for (const side of s.sides) {
      const where = rearmostRailhead(m, s, side.id)
      if (where === null) continue
      s.formations.push(raise(s.nextFormationId++, side.id, 'infantry', where))
      log(s, side.id, `${m.province[where].name}: a fresh infantry corps arrives by rail`)
    }
  }

  for (const side of s.sides) side.seen = updateSightings(m, s, side.id)

  // A standing refit ends when the formation is whole: full cohesion, and full
  // strength or nowhere to rebuild it. Dropped here rather than left to waste a
  // turn not digging in.
  for (const id of Object.keys(s.orders)) {
    const o = s.orders[Number(id)]
    const f = s.formations.find((x) => x.id === Number(id))
    if (!f) {
      delete s.orders[Number(id)]
      continue
    }
    if (o.type !== 'refit') continue
    const railheads = liveDepots(m, s, f.owner)
    const rebuilding = f.strength < STRENGTH[f.type] && railheads.includes(f.at)
    if (f.cohesion >= 100 && !rebuilding) delete s.orders[Number(id)]
  }
  for (const id of Object.keys(s.delayed)) {
    if (!s.formations.some((f) => f.id === Number(id))) delete s.delayed[Number(id)]
  }

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
  const verdict = verdictOf(aims, s.winner)
  s.peace = { aims, ground, verdict }
  s.phase = 'gameOver'
  log(s, s.winner, s.winner === null ? 'the war ends in stalemate' : `achieves its war aims — a ${verdict} peace`)
  return s
}

function verdictOf(aims: number[], winner: PlayerId | null): Verdict {
  if (winner === null) return 'stalemate'
  const margin = aims[winner] - aims[1 - winner]
  return margin >= VERDICT_MARGIN.decisive ? 'decisive' : margin >= VERDICT_MARGIN.clear ? 'clear' : 'narrow'
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
