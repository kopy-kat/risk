import type { PlayerId } from '../../engine/types'
import type { GameMap, ProvinceId, Terrain } from './map'
import { STACK_LIMIT } from './map'
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
}

/**
 * Everywhere a formation could go this turn, and what it costs to arrive.
 *
 * Enemy-held provinces are never entered — taking ground is what an attack order
 * is for. A province already holding all the terrain will take is not somewhere
 * you can stop, so it is not somewhere you can go.
 */
export function reachable(m: GameMap, s: KesselState, f: { at: ProvinceId; owner: PlayerId; type: UnitType }): Reach {
  const budget = ALLOWANCE[f.type]
  const zoc = watched(m, s, f.owner)
  const enemyAt = new Set(s.formations.filter((x) => x.owner !== f.owner).map((x) => x.at))
  const occupancy: Record<ProvinceId, number> = {}
  for (const x of s.formations) if (x.id !== (f as { id?: number }).id) occupancy[x.at] = (occupancy[x.at] ?? 0) + 1

  const cost: Record<ProvinceId, number> = { [f.at]: 0 }
  const from: Record<ProvinceId, ProvinceId> = {}
  const open = [f.at]

  while (open.length > 0) {
    // Small budgets and unit costs, so a scan beats a heap and stays readable.
    let best = 0
    for (let i = 1; i < open.length; i++) if (cost[open[i]] < cost[open[best]]) best = i
    const at = open.splice(best, 1)[0]

    // Movement ends on contact, so a province in an enemy's reach is a place you
    // arrive and stop, never one you pass through.
    if (at !== f.at && zoc.has(at)) continue

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

  delete cost[f.at]
  for (const p of Object.keys(cost)) {
    if ((occupancy[p] ?? 0) >= STACK_LIMIT[m.province[p].terrain]) delete cost[p]
  }
  return { cost, from }
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
export const canReach = (
  m: GameMap,
  s: KesselState,
  f: { at: ProvinceId; owner: PlayerId; type: UnitType },
  to: ProvinceId,
): boolean => reachable(m, s, f).cost[to] !== undefined
