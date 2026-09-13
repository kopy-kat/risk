import type { PlayerId } from '../../engine/types'
import type { GameMap, ProvinceId, Terrain } from './map'
import { STACK_LIMIT, SUPPLY_COST } from './map'
import { depthMap } from './supply'
import type { KesselState, UnitType } from './types'

/**
 * How far a formation gets in a turn.
 *
 * The whole operational layer hangs off these three numbers being different. With
 * everything at one province a turn there is no exploitation, no getting behind a
 * line, and nothing can outrun its own supply — so the culminating point can only
 * be reached by grinding, which is the opposite of the point.
 */
export const ALLOWANCE: Record<UnitType, number> = {
  infantry: 2,
  armour: 4,
  recon: 5,
}

/**
 * What an assault spends of the allowance. What is left is the exploitation: a
 * formation that takes a province by attack may ride on with the remainder, so
 * armour breaks through in the turn it breaks in and infantry does not.
 */
export const ASSAULT_COST = 2

/**
 * How far a formation rides the railway in a turn: through its own supply
 * network only, starting and ending out of contact, at full supply. This is the
 * interior line — without it a reserve is local to the sector it stands in, and
 * where to commit it is never a question.
 */
export const RAIL_ALLOWANCE = 6

/**
 * Two turns in every ten the roads are mud. Marching allowances halve; the
 * railways still run. It is small and it is on the calendar, which is the point:
 * an offensive has a date by which it has to have gone in.
 */
export const MUD_CYCLE = 10
export const MUD_TURNS = 2
export const isMud = (turn: number) =>
  turn % MUD_CYCLE === 0 || turn % MUD_CYCLE > MUD_CYCLE - MUD_TURNS

export const allowance = (type: UnitType, turn: number): number =>
  isMud(turn) ? Math.floor(ALLOWANCE[type] / 2) : ALLOWANCE[type]

/** Ground you cross rather than fight over still costs what it costs. */
const MOVE_COST: Record<Terrain, number> = {
  plain: 1,
  urban: 1,
  hill: 1,
  forest: 2,
  marsh: 2,
  mountain: 2,
}

/**
 * Provinces an enemy formation watches. Movement ends the moment you enter one:
 * without that, a fast formation laps the front line every turn and the front
 * stops meaning anything.
 */
function watched(m: GameMap, s: KesselState, me: PlayerId): Set<ProvinceId> {
  const zoc = new Set<ProvinceId>()
  for (const f of s.formations) {
    if (f.owner === me) continue
    zoc.add(f.at)
    for (const n of m.adjacency[f.at] ?? []) zoc.add(n)
  }
  return zoc
}

export interface Reach {
  /** cost to arrive, for every province this formation can legally end its turn in */
  cost: Record<ProvinceId, number>
  /** the province stepped from, so a march can be walked back into a route */
  from: Record<ProvinceId, ProvinceId>
  /** destinations reached only by rail */
  rail: Set<ProvinceId>
}

export interface Mover {
  id?: number
  at: ProvinceId
  owner: PlayerId
  type: UnitType
  supply?: number
}

export interface ReachOptions {
  /** start somewhere other than where the formation stands — the exploitation after an assault */
  from?: ProvinceId
  /** movement to spend, when it is not the turn's whole allowance */
  budget?: number
  /** the side's supply depths, when the caller already has them — the railway runs along them */
  depth?: Record<ProvinceId, number>
}

/**
 * Everywhere a formation could go this turn, and what it costs to arrive.
 *
 * Enemy-held provinces are never entered — taking ground is what an attack order
 * is for. A province already holding all the terrain will take is not somewhere
 * you can stop, so it is not somewhere you can go.
 */
export function reachable(m: GameMap, s: KesselState, f: Mover, opts: ReachOptions = {}): Reach {
  const origin = opts.from ?? f.at
  const budget = opts.budget ?? allowance(f.type, s.turn)
  const zoc = watched(m, s, f.owner)
  const enemyAt = new Set(s.formations.filter((x) => x.owner !== f.owner).map((x) => x.at))
  const occupancy: Record<ProvinceId, number> = {}
  for (const x of s.formations) if (x.id !== f.id) occupancy[x.at] = (occupancy[x.at] ?? 0) + 1
  const full = (p: ProvinceId) => (occupancy[p] ?? 0) >= STACK_LIMIT[m.province[p].terrain]

  const cost: Record<ProvinceId, number> = { [origin]: 0 }
  const from: Record<ProvinceId, ProvinceId> = {}
  const open = [origin]

  while (open.length > 0) {
    // Small budgets and unit costs, so a scan beats a heap and stays readable.
    let best = 0
    for (let i = 1; i < open.length; i++) if (cost[open[i]] < cost[open[best]]) best = i
    const at = open.splice(best, 1)[0]

    // Movement ends on contact, so a province in an enemy's reach is a place you
    // arrive and stop, never one you pass through.
    if (at !== origin && zoc.has(at)) continue

    for (const n of m.adjacency[at] ?? []) {
      if (enemyAt.has(n)) continue
      const next = cost[at] + MOVE_COST[m.province[n].terrain]
      if (next > budget) continue
      if (cost[n] !== undefined && cost[n] <= next) continue
      cost[n] = next
      from[n] = at
      open.push(n)
    }
  }

  const rail = new Set<ProvinceId>()
  // The railway: along the supply network, from out of contact to out of contact,
  // and only for a formation the trains are already reaching.
  if (opts.from === undefined && opts.budget === undefined && f.supply === 3 && !zoc.has(origin)) {
    const depth = opts.depth ?? depthMap(m, s, f.owner)
    const rcost: Record<ProvinceId, number> = { [origin]: 0 }
    const rfrom: Record<ProvinceId, ProvinceId> = {}
    const queue = [origin]
    while (queue.length > 0) {
      let best = 0
      for (let i = 1; i < queue.length; i++) if (rcost[queue[i]] < rcost[queue[best]]) best = i
      const at = queue.splice(best, 1)[0]
      for (const n of m.adjacency[at] ?? []) {
        if (depth[n] === Infinity) continue
        const next = rcost[at] + SUPPLY_COST[m.province[n].terrain]
        if (next > RAIL_ALLOWANCE) continue
        if (rcost[n] !== undefined && rcost[n] <= next) continue
        rcost[n] = next
        rfrom[n] = at
        queue.push(n)
      }
    }
    for (const p of Object.keys(rcost)) {
      if (p === origin || cost[p] !== undefined || zoc.has(p)) continue
      cost[p] = rcost[p]
      rail.add(p)
      // Walk the rail route back into `from`, so the march it stands for can be traced.
      for (let at = p; at !== origin && from[at] === undefined; at = rfrom[at]) from[at] = rfrom[at]
    }
  }

  delete cost[origin]
  for (const p of Object.keys(cost)) {
    if (full(p)) {
      delete cost[p]
      rail.delete(p)
    }
  }
  return { cost, from, rail }
}

/**
 * Where an assault on `target` could ride on to, if it takes the ground: the
 * board after the defenders are gone, and what the allowance has left after the
 * assault. Empty for anything too slow to exploit at all.
 */
export function exploitReach(m: GameMap, s: KesselState, f: Mover, target: ProvinceId): Reach {
  const budget = allowance(f.type, s.turn) - ASSAULT_COST
  if (budget <= 0) return { cost: {}, from: {}, rail: new Set() }
  const after: KesselState = {
    ...s,
    owner: { ...s.owner, [target]: f.owner },
    formations: s.formations.filter((x) => !(x.at === target && x.owner !== f.owner)),
  }
  const reach = reachable(m, after, f, { from: target, budget })
  // Riding back to where the assault started is not exploiting anything.
  delete reach.cost[f.at]
  return reach
}

/**
 * The route a formation actually walks, destination last.
 *
 * Ground is claimed all the way along it, not just where the march ends —
 * otherwise a deep ride leaves a corridor of enemy ground behind it and cutting a
 * supply line by riding across it would not work.
 */
export function routeTo(reach: Reach, to: ProvinceId): ProvinceId[] {
  if (reach.cost[to] === undefined) return []
  const route: ProvinceId[] = []
  for (let at: ProvinceId | undefined = to; at !== undefined; at = reach.from[at]) route.unshift(at)
  return route.slice(1)
}

/** Whether a formation can end this turn in `to`. */
export const canReach = (m: GameMap, s: KesselState, f: Mover, to: ProvinceId): boolean =>
  reachable(m, s, f).cost[to] !== undefined
