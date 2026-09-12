import type { PlayerId } from '../../engine/types'
import type { GameBot } from '../types'
import { attackValue, defendValue, engage } from './combat'
import { ACTIVATIONS, activationsUsed, broken, commandFrom, hqReach, inCommand } from './game'
import { STACK_LIMIT, mapOf } from './map'
import type { GameMap, ProvinceId } from './map'
import { exploitReach, reachable } from './movement'
import { retreatOptions, supplyStates } from './supply'
import type { Formation, KesselState, Move, Order } from './types'

/**
 * What separates one bot from another. Every tier is this same policy at
 * different settings — constrained doctrines rather than free optimisation, so a
 * bot reads as a commander with a view about war rather than a weighted sum, and
 * so the settings double as the space `npm run exploit` searches.
 */
export interface Doctrine {
  key: string
  name: string
  blurb: string
  /** local force ratio required before it will attack at all */
  attackRatio: number
  /** how much it pays to close a ring rather than push a front */
  encirclement: number
  /** cohesion below which a formation pulls out of the line to refit */
  refitBelow: number
  /** pull toward objectives, against the pull of holding a solid front */
  objectivePull: number
  /** tolerance for standing where supply is already strained */
  overreach: number
  /**
   * Appetite for hitting what has outrun its own supply. This is what makes a
   * defensive doctrine something other than passivity: yielding ground is only a
   * plan if you take it back from an enemy who can no longer hold it.
   */
  counterattack: number
}

export const DOCTRINES: Doctrine[] = [
  {
    key: 'attrition',
    name: 'Attrition',
    blurb: 'Broad frontal pressure. Takes ground where the odds are plain and holds what it takes.',
    attackRatio: 1.35,
    encirclement: 0.2,
    refitBelow: 35,
    objectivePull: 0.6,
    overreach: 0.2,
    counterattack: 0.3,
  },
  {
    key: 'maneuver',
    name: 'Maneuver',
    blurb: 'Concentrates, looks for the flank, and would rather cut a line of retreat than force a front.',
    attackRatio: 1.15,
    encirclement: 1.4,
    refitBelow: 30,
    objectivePull: 1,
    overreach: 0.5,
    counterattack: 0.6,
  },
  {
    key: 'elastic',
    name: 'Elastic Defence',
    blurb: 'Yields ground to keep formations whole, then counterattacks what has outrun its supply.',
    attackRatio: 1.3,
    encirclement: 0.9,
    refitBelow: 55,
    objectivePull: 0.45,
    overreach: 0,
    counterattack: 1.8,
  },
]

const provinceValue = (m: GameMap, p: ProvinceId) => m.province[p].vp * 2 + m.province[p].depot * 3

/** Distance in provinces from every province to the nearest of `goals`. */
function distanceTo(m: GameMap, goals: ProvinceId[]): Record<ProvinceId, number> {
  const dist: Record<ProvinceId, number> = {}
  for (const id of m.ids) dist[id] = Infinity
  const queue = [...goals]
  for (const g of goals) dist[g] = 0
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]
    for (const n of m.adjacency[at] ?? []) {
      if (dist[n] !== Infinity) continue
      dist[n] = dist[at] + 1
      queue.push(n)
    }
  }
  return dist
}

/**
 * Provinces that are somebody's last way out. Standing in one is worth more than
 * any amount of pushing on the front it belongs to, which is the whole reason the
 * bot understands envelopment rather than only ratios.
 */
function chokePoints(m: GameMap, s: KesselState, me: PlayerId): Map<ProvinceId, number> {
  const out = new Map<ProvinceId, number>()
  for (const f of s.formations) {
    if (f.owner === me) continue
    const ways = retreatOptions(m, s, f)
    if (ways.length === 0 || ways.length > 2) continue
    const worth = (f.strength * 3) / ways.length
    for (const w of ways) out.set(w, (out.get(w) ?? 0) + worth)
  }
  return out
}

/**
 * Where the headquarters go this turn: each in turn to whatever ground in reach
 * commands the most of the army the other one does not, a corps counting by its
 * strength and double on the contact line. Never into contact, where the next
 * assault overruns it. Staged even when the answer is to stay put, so the
 * question is asked once a turn rather than before every order.
 */
function hqMove(m: GameMap, s: KesselState, me: PlayerId): Move | null {
  const hqs = s.sides[me].hqs
  const hq = hqs.findIndex((_, i) => s.hqOrders[i] === undefined)
  if (hq === -1) return null

  const enemyAt = new Set(s.formations.filter((f) => f.owner !== me).map((f) => f.at))
  const inContact = (p: ProvinceId) => (m.adjacency[p] ?? []).some((n) => enemyAt.has(n))
  const mine = s.formations.filter((f) => f.owner === me)
  const covered = commandFrom(m, s, me, hqs.map((at, i) => s.hqOrders[i] ?? at).filter((_, i) => i !== hq))
  const canGo = hqReach(m, s, me, hq)
  // Staying put is a legal relocation from ground the side holds, so an empty
  // reach means this headquarters is somewhere the rules cannot send it from.
  if (!canGo.has(hqs[hq])) return null

  let best = hqs[hq]
  let gain = -1
  for (const at of canGo) {
    if (inContact(at)) continue
    const reach = commandFrom(m, s, me, [at])
    const g = mine.reduce(
      (n, f) => n + (!covered.has(f.at) && reach.has(f.at) ? f.strength * (inContact(f.at) ? 2 : 1) : 0),
      0,
    )
    if (g > gain) {
      gain = g
      best = at
    }
  }
  return { type: 'moveHq', hq, to: best }
}

/**
 * The policy itself, for any settings — not just the three named ones. This is what
 * the exploitability search plays: it hill-climbs these parameters looking for a
 * setting the best doctrine has no answer to.
 */
export function decideFor(
  doctrine: Doctrine,
  s: KesselState,
  me: PlayerId,
  rand: () => number,
): Move {
  if (s.phase === 'terms') return termsReply(s, me)

  if (broken(s, me) && !s.offered) return { type: 'offerTerms' }

  const m = mapOf(s.mapId)
  const mine = s.formations.filter((f) => f.owner === me)

  // A refit stands from one turn to the next. The doctrine only meant it for as
  // long as the formation was below its own threshold and out of contact, so a
  // standing one past that point is cleared and decided afresh.
  const stale = mine.find(
    (f) =>
      s.orders[f.id]?.type === 'refit' &&
      (f.cohesion >= doctrine.refitBelow ||
        (m.adjacency[f.at] ?? []).some((n) => s.formations.some((x) => x.at === n && x.owner !== me))),
  )
  if (stale) return { type: 'clearOrder', formation: stale.id }

  const relocate = hqMove(m, s, me)
  if (relocate) return relocate

  const pending = mine.filter((f) => !s.orders[f.id] && !s.delayed[f.id])
  if (pending.length === 0) return { type: 'commit' }

  // Supply is recomputed at turn start, but orders staged earlier in this same
  // turn move formations, so it is re-read here rather than trusted from state.
  const supply = supplyStates(m, s, me)
  const spent = activationsUsed(s, me)
  const command = inCommand(m, s, me)

  // The budget goes to the contact line first. Ordering formations in whatever
  // sequence they happen to sit in the list spends it on rear areas and leaves
  // the front standing still. Before even the line: whoever stands near valuable
  // ground of ours that is empty with an enemy closing on it — left until the
  // activations are spent, the rear is never garrisoned and a raid takes it —
  // and whoever is in command, because an activation spent out of command buys
  // nothing this turn.
  const enemyAt = (p: ProvinceId) => s.formations.some((x) => x.at === p && x.owner !== me)
  const within2 = (p: ProvinceId, test: (q: ProvinceId) => boolean) =>
    (m.adjacency[p] ?? []).some((n) => test(n) || (m.adjacency[n] ?? []).some(test))
  const threatened = new Set(
    m.ids.filter(
      (p) =>
        s.owner[p] === me &&
        provinceValue(m, p) > 0 &&
        !s.formations.some((x) => x.at === p) &&
        within2(p, enemyAt),
    ),
  )
  const guardian = (f: Formation) => threatened.size > 0 && within2(f.at, (q) => threatened.has(q))
  const inContact = (f: Formation) => (m.adjacency[f.at] ?? []).some(enemyAt)
  const f = [...pending].sort(
    (a, b) =>
      Number(guardian(b)) - Number(guardian(a)) ||
      Number(command.has(b.id)) - Number(command.has(a.id)) ||
      Number(inContact(b)) - Number(inContact(a)) ||
      b.strength - a.strength,
  )[0]

  const at = { ...f, supply: supply[f.id] ?? f.supply }
  const afford = spent.size < ACTIVATIONS || spent.has(f.at)

  return {
    type: 'order',
    formation: f.id,
    order: orderFor(doctrine, m, s, me, at, rand, afford, command.has(f.id)),
  }
}

function orderFor(
  d: Doctrine,
  m: GameMap,
  s: KesselState,
  me: PlayerId,
  f: Formation,
  rand: () => number,
  afford: boolean,
  commanded: boolean,
): Order {
  const neighbours = m.adjacency[f.at] ?? []
  const enemyAt = (p: ProvinceId) => s.formations.filter((x) => x.at === p && x.owner !== me)
  const friendlyAt = (p: ProvinceId) => s.formations.filter((x) => x.at === p && x.owner === me)
  const chokes = chokePoints(m, s, me)

  if (f.cohesion < d.refitBelow && !neighbours.some((n) => enemyAt(n).length > 0)) {
    return { type: 'refit' }
  }

  // Ground of ours worth something, with nobody on it and an enemy two provinces
  // away. A rear nobody garrisons is a rear a recon corps takes, railhead and
  // all — so standing on it is worth about what the province is, whatever the
  // doctrine thinks of the front.
  const enemyNear = (p: ProvinceId) =>
    (m.adjacency[p] ?? []).some(
      (n) => enemyAt(n).length > 0 || (m.adjacency[n] ?? []).some((nn) => enemyAt(nn).length > 0),
    )
  const guardWorth = (n: ProvinceId, standing: number) =>
    s.owner[n] === me && provinceValue(m, n) > 0 && standing === 0 && enemyNear(n)
      ? provinceValue(m, n) * 0.6
      : 0

  // Holding is worth the entrenchment — and the ground, if this is the only
  // formation between a valuable province and an enemy close enough to walk in.
  const alone = friendlyAt(f.at).length === 1
  let best: { order: Order; score: number } = {
    order: { type: 'hold' },
    score: dugInWorth(f) + (alone ? guardWorth(f.at, 0) : 0),
  }
  // Out of activations, the only orders left are the free ones.
  if (!afford) return best.order

  const goals = s.sides[me].aims.filter((p) => s.owner[p] !== me)
  const pull = distanceTo(m, goals.length > 0 ? goals : m.ids.filter((p) => s.owner[p] !== me))

  /** What standing on `n` would be worth, from `from` — the same yardstick for a march and an exploitation. */
  const groundWorth = (from: ProvinceId, n: ProvinceId) => {
    const closing = (chokes.get(n) ?? 0) * d.encirclement
    const advance = (pull[from] - pull[n]) * d.objectivePull
    const strain = s.owner[n] === me ? 0 : (1 - d.overreach) * 0.5
    return closing + advance + provinceValue(m, n) * 0.2 - strain + guardWorth(n, friendlyAt(n).length)
  }

  // An assault ordered out of command goes in a turn late, against whatever is
  // standing there by then — which is not an assault anyone planned.
  if (commanded && f.supply >= 3 && !broken(s, me)) {
    for (const n of neighbours) {
      const defenders = enemyAt(n)
      if (defenders.length === 0) continue

      // Everyone who could join this attack, not just whoever is stacked here —
      // an assault is what several provinces do to one, and a formation weighing
      // it alone always finds the odds against and never starts.
      const help = s.formations.filter(
        (x) =>
          x.owner === me &&
          x.id !== f.id &&
          (m.adjacency[x.at] ?? []).includes(n) &&
          x.supply >= 3 &&
          (!s.orders[x.id] || sameTarget(s.orders[x.id], n)),
      )
      const committed = engage(m, [f, ...help], n)
      if (!committed.some((x) => x.id === f.id)) continue
      const ours = committed.reduce((t, x) => t + attackValue(x), 0)
      const theirs = defenders.reduce((t, x) => t + defendValue(m, x, n), 0)
      const ratio = theirs === 0 ? Infinity : ours / theirs
      if (ratio < d.attackRatio) continue

      const trapped = defenders.filter((x) => retreatOptions(m, s, x).length === 0).length
      // What the enemy's supply was when they last drew it — which is what you can
      // see of them, and the moment a counterattack is aimed at.
      const overextended = defenders.reduce((t, x) => t + (3 - x.supply), 0)
      const score =
        ratio +
        provinceValue(m, n) * 0.4 +
        trapped * 4 * d.encirclement +
        overextended * d.counterattack
      if (score <= best.score) continue

      // Where to ride on to if the ground falls: the best of what the assault
      // would leave reachable, if it beats standing on the ground taken.
      let onward: ProvinceId | undefined
      let worth = 0
      for (const p of Object.keys(exploitReach(m, s, f, n).cost)) {
        const w = groundWorth(n, p)
        if (w > worth) {
          worth = w
          onward = p
        }
      }
      best = { order: onward ? { type: 'attack', to: n, onward } : { type: 'attack', to: n }, score }
    }
  }

  for (const n of Object.keys(reachable(m, s, f).cost)) {
    if (enemyAt(n).length > 0) continue
    if (friendlyAt(n).length >= STACK_LIMIT[m.province[n].terrain]) continue
    const score = groundWorth(f.at, n) + rand() * 0.1
    if (score > best.score) best = { order: { type: 'move', to: n }, score }
  }

  return best.order
}


const sameTarget = (o: Order, n: ProvinceId) => o.type === 'attack' && o.to === n

/** Holding is worth more the longer it has been held — entrenchment is real value. */
const dugInWorth = (f: Formation) => 0.5 + f.dug * 0.3

/**
 * Terms are offered by whoever is broken, so this is the reply of the side still
 * standing. Take the peace when it already meets your aims; press on only while
 * you are behind and still have the will to spend.
 */
function termsReply(s: KesselState, me: PlayerId): Move {
  const them = (1 - me) as PlayerId
  const ahead = s.sides[me].will >= s.sides[them].will
  return ahead ? { type: 'acceptTerms' } : { type: 'rejectTerms' }
}

export const KESSEL_BOTS: GameBot<KesselState, Move>[] = DOCTRINES.map((d) => ({
  key: `kessel-${d.key}`,
  name: d.name,
  blurb: d.blurb,
  decide: (state, me, rand) => decideFor(d, state, me, rand),
}))
