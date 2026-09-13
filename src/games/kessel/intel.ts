import type { PlayerId } from '../../engine/types'
import type { GameMap, ProvinceId } from './map'
import type { Formation, KesselState, Sighting } from './types'

/**
 * How far a reconnaissance corps sees past the line. Everyone sees the province
 * next door; recon is what tells you about the one behind it, which is the other
 * half of its job beside severing supply.
 */
export const RECON_SIGHT = 2

/**
 * Provinces `me` can currently see into: everywhere one of its formations stands
 * or borders, and everything within `RECON_SIGHT` of its recon.
 *
 * Ownership and the number of counters on a province are always public — a front
 * line is known in real war. What is hidden is what those counters are worth.
 */
export function observed(m: GameMap, s: KesselState, me: PlayerId): Set<ProvinceId> {
  const out = new Set<ProvinceId>()
  for (const f of s.formations) {
    if (f.owner !== me) continue
    out.add(f.at)
    for (const n of m.adjacency[f.at] ?? []) out.add(n)
    if (f.type !== 'recon') continue
    const walked = new Set<ProvinceId>([f.at])
    let ring = [f.at]
    for (let d = 0; d < RECON_SIGHT; d++) {
      const next: ProvinceId[] = []
      for (const at of ring) {
        for (const n of m.adjacency[at] ?? []) {
          if (walked.has(n)) continue
          walked.add(n)
          out.add(n)
          next.push(n)
        }
      }
      ring = next
    }
  }
  return out
}

export const sightingOf = (f: Formation, turn: number): Sighting => ({
  type: f.type,
  strength: f.strength,
  cohesion: f.cohesion,
  supply: f.supply,
  turn,
})

/** What `me` knows of every enemy formation after looking at the board as it stands. */
export function updateSightings(
  m: GameMap,
  s: KesselState,
  me: PlayerId,
): Record<number, Sighting> {
  const seen = { ...s.sides[me].seen }
  const eyes = observed(m, s, me)
  for (const f of s.formations) {
    if (f.owner === me || !eyes.has(f.at)) continue
    seen[f.id] = sightingOf(f, s.turn)
  }
  return seen
}
