import type { PlayerId } from '../../engine/types'
import { STACK_LIMIT, SUPPLY_COST } from './map'
import type { GameMap, ProvinceId } from './map'
import type { Formation, KesselState } from './types'

/** What a formation draws per turn. Armour draws double, so spearheads culminate first. */
export const DRAW = { infantry: 1, armour: 2, recon: 1 } as const

/**
 * Chain depth at which each supply state gives out. Graded, never deletion — an
 * army that outruns its trucks stops attacking long before it starts starving.
 */
export const DEPTH_BANDS = [4, 8, 12] as const

/** A depot serves this much draw per point of capacity. */
export const CAPACITY_PER_DEPOT = 2

const UNREACHABLE = Infinity

/**
 * Provinces an enemy formation projects into. Supply may not trace through one
 * unless the side holds it with a formation of its own — which is what makes a
 * thin screen of recon behind the line a weapon rather than a nuisance.
 */
export function enemyZoc(m: GameMap, s: KesselState, me: PlayerId): Set<ProvinceId> {
  const zoc = new Set<ProvinceId>()
  const held = new Set(s.formations.filter((f) => f.owner === me).map((f) => f.at))
  for (const f of s.formations) {
    if (f.owner === me) continue
    zoc.add(f.at)
    for (const n of m.adjacency[f.at] ?? []) if (!held.has(n)) zoc.add(n)
  }
  return zoc
}

/**
 * The supply network: every province this side's supply can flow through. Held
 * by it, not overlooked by an enemy it does not itself stand in, and — the part
 * that makes a pocket a pocket — traceable back to where its supply enters the
 * map. Ground that cannot be reached from home is ground the trains do not run to.
 */
export function network(m: GameMap, s: KesselState, me: PlayerId): Set<ProvinceId> {
  const blocked = enemyZoc(m, s, me)
  const open = new Set<ProvinceId>()
  const queue: ProvinceId[] = []
  for (const p of s.sides[me].home) {
    if (s.owner[p] === me && !blocked.has(p)) {
      open.add(p)
      queue.push(p)
    }
  }
  for (let i = 0; i < queue.length; i++) {
    for (const n of m.adjacency[queue[i]] ?? []) {
      if (open.has(n) || s.owner[n] !== me || blocked.has(n)) continue
      open.add(n)
      queue.push(n)
    }
  }
  return open
}

/**
 * Depots that issue supply: held, and on the network. A depot is a railhead, not
 * a well — one the enemy has cut off from home is a building with a name, and
 * the formations standing on it are in a pocket like anybody else.
 */
export function liveDepots(
  m: GameMap,
  s: KesselState,
  me: PlayerId,
  net = network(m, s, me),
): ProvinceId[] {
  return m.ids.filter((p) => m.province[p].depot > 0 && net.has(p))
}

/**
 * Cheapest supply chain depth from any of `me`'s live depots to every province,
 * over ground they control and the enemy does not overlook.
 */
export function depthMap(m: GameMap, s: KesselState, me: PlayerId): Record<ProvinceId, number> {
  const blocked = enemyZoc(m, s, me)
  const dist: Record<ProvinceId, number> = {}
  for (const id of m.ids) dist[id] = UNREACHABLE

  const open = new Set<ProvinceId>()
  for (const p of liveDepots(m, s, me)) {
    dist[p] = 0
    open.add(p)
  }

  while (open.size > 0) {
    let at: ProvinceId | null = null
    let best = UNREACHABLE
    for (const p of open) {
      if (dist[p] < best) {
        best = dist[p]
        at = p
      }
    }
    if (at === null) break
    open.delete(at)

    for (const n of m.adjacency[at] ?? []) {
      if (s.owner[n] !== me) continue
      if (blocked.has(n)) continue
      const next = dist[at] + SUPPLY_COST[m.province[n].terrain]
      if (next < dist[n]) {
        dist[n] = next
        open.add(n)
      }
    }
  }
  return dist
}

const bandFor = (depth: number): number => {
  if (depth === UNREACHABLE) return 0
  for (let i = 0; i < DEPTH_BANDS.length; i++) if (depth <= DEPTH_BANDS[i]) return 3 - i
  return 0
}

/**
 * Supply state 0–3 for every formation `me` has.
 *
 * Depots have finite capacity, so the second army drawing on the same railhead is
 * worse off than the first. Formations are served nearest-first: the ones at the
 * end of the chain go short, which is what makes an overextended spearhead feel
 * like an overextended spearhead.
 *
 * Running out of *capacity* is not the same as being cut off. A formation that can
 * still trace a line but finds nothing at the end of it is strained, not starving.
 */
export function supplyStates(
  m: GameMap,
  s: KesselState,
  me: PlayerId,
): Record<number, number> {
  const dist = depthMap(m, s, me)
  const capacity: Record<ProvinceId, number> = {}
  for (const p of liveDepots(m, s, me)) capacity[p] = m.province[p].depot * CAPACITY_PER_DEPOT

  const byDepth = s.formations.filter((f) => f.owner === me).sort((a, b) => dist[a.at] - dist[b.at])

  const out: Record<number, number> = {}
  for (const f of byDepth) {
    const depth = dist[f.at]
    if (depth === UNREACHABLE) {
      out[f.id] = 0
      continue
    }
    const source = nearestWithCapacity(m, f.at, capacity, dist)
    if (source === null) {
      out[f.id] = Math.min(1, bandFor(depth))
      continue
    }
    capacity[source] -= DRAW[f.type]
    out[f.id] = bandFor(depth)
  }
  return out
}

/**
 * The depot a formation actually draws from. Approximated by depth rather than by
 * solving the assignment — the difference only shows up when two chains of equal
 * length compete for one railhead, and it costs a hundred times less.
 */
function nearestWithCapacity(
  m: GameMap,
  from: ProvinceId,
  capacity: Record<ProvinceId, number>,
  dist: Record<ProvinceId, number>,
): ProvinceId | null {
  if (dist[from] === UNREACHABLE) return null
  let best: ProvinceId | null = null
  let bestDepth = UNREACHABLE
  for (const p of m.ids) {
    if (!(p in capacity) || capacity[p] <= 0) continue
    const d = dist[p] + dist[from]
    if (d < bestDepth) {
      bestDepth = d
      best = p
    }
  }
  return best
}

/**
 * Where a beaten formation can go. Empty means it surrenders instead of retreating,
 * which is the one rule the whole game is built around: encirclement kills, combat
 * only pushes.
 *
 * Unordered, and deliberately cheap: whether a pocket is closed gets asked about
 * every enemy formation many times a turn, and it is a question about adjacency,
 * not about supply.
 */
export function retreatOptions(m: GameMap, s: KesselState, f: Formation): ProvinceId[] {
  const enemyAt = new Set(s.formations.filter((x) => x.owner !== f.owner).map((x) => x.at))
  return (m.adjacency[f.at] ?? []).filter(
    (n) =>
      !enemyAt.has(n) &&
      s.owner[n] === f.owner &&
      // Ground already packed to what the terrain will hold is no way out either.
      s.formations.filter((x) => x.at === n && x.id !== f.id).length <
        STACK_LIMIT[m.province[n].terrain],
  )
}

/** The same options, nearest to supply first — which way a formation actually falls back. */
export function retreatTargets(
  m: GameMap,
  s: KesselState,
  f: Formation,
  dist = depthMap(m, s, f.owner),
): ProvinceId[] {
  return retreatOptions(m, s, f).sort((a, b) => dist[a] - dist[b])
}
