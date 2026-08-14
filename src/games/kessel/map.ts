export type ProvinceId = string

export type Terrain = 'plain' | 'forest' | 'hill' | 'mountain' | 'marsh' | 'urban'

export interface Province {
  id: ProvinceId
  name: string
  nation: string
  terrain: Terrain
  /** supply capacity as a source, 0 for most provinces */
  depot: number
  /** objective value at the peace, 0–3 */
  vp: number
  /** label anchor — pole of inaccessibility, so it stays inside concave shapes */
  cx: number
  cy: number
  /** SVG path, map units */
  d: string
}

export interface Edge {
  a: ProvinceId
  b: ProvinceId
  /** shared border length in map units — sets how many formations can attack across it */
  len: number
  sea: boolean
}

export interface MapData {
  id: string
  name: string
  viewBox: string
  coast: string
  provinces: Province[]
  adjacency: Record<ProvinceId, ProvinceId[]>
  edges: Edge[]
}

/** A map with its lookups built. Topology is the game's main tuning surface, so
 * maps are data loaded by id rather than a module every rule imports — a scenario
 * can ship its own without touching a line of the engine. */
export interface GameMap extends MapData {
  ids: ProvinceId[]
  province: Record<ProvinceId, Province>
  edge(a: ProvinceId, b: ProvinceId): Edge | undefined
}

const key = (a: ProvinceId, b: ProvinceId) => (a < b ? `${a}|${b}` : `${b}|${a}`)

export function loadMap(data: MapData): GameMap {
  const byKey: Record<string, Edge> = Object.fromEntries(data.edges.map((e) => [key(e.a, e.b), e]))
  return {
    ...data,
    ids: data.provinces.map((p) => p.id),
    province: Object.fromEntries(data.provinces.map((p) => [p.id, p])),
    edge: (a, b) => byKey[key(a, b)],
  }
}

const MAPS: Record<string, GameMap> = {}

export function registerMap(data: MapData): GameMap {
  const m = loadMap(data)
  MAPS[m.id] = m
  return m
}

export function mapOf(id: string): GameMap {
  const m = MAPS[id]
  if (!m) throw new Error(`unknown map: ${id}`)
  return m
}

/**
 * How many formations can engage across a border at once — two over open ground,
 * one over anything that funnels. Mass still wins, but it has to be *aimed*: this
 * is what stops a province absorbing an unlimited stack, and it does the job
 * without a stacking rule.
 */
const ENGAGEMENT_LIMIT: Record<Terrain, number> = {
  plain: 2,
  urban: 1,
  hill: 1,
  forest: 1,
  marsh: 1,
  mountain: 1,
}

export function frontage(m: GameMap, a: ProvinceId, b: ProvinceId): number {
  const e = m.edge(a, b)
  if (!e) return 0
  if (e.sea) return 1
  // The narrower of the two sides governs — a broad plain reached through a pass
  // is still reached through a pass.
  const limit = Math.min(ENGAGEMENT_LIMIT[m.province[a].terrain], ENGAGEMENT_LIMIT[m.province[b].terrain])
  return e.len < 18 ? 1 : limit
}

/** Supply traces slower through country that has no roads worth the name. */
export const SUPPLY_COST: Record<Terrain, number> = {
  plain: 1,
  urban: 1,
  hill: 1,
  forest: 2,
  marsh: 2,
  mountain: 2,
}

/** Defence multiplier for holding this ground. */
export const TERRAIN_DEFENCE: Record<Terrain, number> = {
  plain: 1,
  urban: 1.5,
  hill: 1.25,
  forest: 1.25,
  marsh: 1.4,
  mountain: 1.6,
}

/** How many formations fit. Concentration of force has a ceiling, and it's terrain. */
export const STACK_LIMIT: Record<Terrain, number> = {
  plain: 3,
  urban: 3,
  hill: 3,
  forest: 2,
  marsh: 2,
  mountain: 2,
}
