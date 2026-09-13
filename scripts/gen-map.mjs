/**
 * Turns a hand-authored list of province seed points plus a real coastline into
 * a finished province map — geometry, adjacency, border lengths, label anchors.
 *
 *   node scripts/gen-map.mjs                              # data/maps/europe.json
 *   node scripts/gen-map.mjs --fetch                      # re-clip the coastline first
 *   node scripts/gen-map.mjs --fetch=./ne_land.geojson    # ...from a local copy
 *   node scripts/gen-map.mjs --seeds=a.json --out=b.json  # try a seed set out of tree
 *
 * Provinces grow by a shortest-path search that may only travel over land pixels,
 * so a seed's territory stops dead at the coast. Nearest-seed by straight line
 * would hand Normandy to a British seed across the Channel; a search that walks
 * the land gets coasts, straits and peninsulas right without special cases. The
 * flip side is that water crossings are never implicit — every one comes from the
 * seed file's seaLinks and is flagged in the output so it can cost more.
 *
 * The coastline is Natural Earth 1:50m land, public domain. --fetch clips it to
 * the map bounds and writes data/maps/<id>.coast.json, which is committed so that
 * ordinary runs are offline and byte-for-byte reproducible.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const NE_LAND_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson'

const VIEW_W = 1400
const GRID_W = 1800
/** Douglas-Peucker tolerance on the traced pixel staircase, in grid pixels. */
const SIMPLIFY_PX = 1.5
const CHAIKIN_PASSES = 2
/** Chaikin quadruples the point count and most of the new points land on straight
 *  runs, so the smoothed ring gets a second, much finer pass. */
const POLISH_PX = 0.35
/** Two provinces meeting at a corner share a pixel or two of border; a real
 *  frontier shares many. Below this they are neighbours on paper only. */
const MIN_SHARED_PX = 8
/** Islets under this size leave the raster entirely: no seed can reach them, so
 *  they would otherwise be permanently unassigned land and a mess of stray paths. */
const MIN_ISLAND_PX = 24
/** How far a seed may be nudged to find land, for points authored on a coast that
 *  the 1:50m outline puts just offshore. */
const SNAP_RADIUS_PX = 60

const args = process.argv.slice(2)
const flag = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (hit === undefined) return null
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : ''
}

const mapId = flag('map') || 'europe'
const seedsPath = flag('seeds') || join(root, `data/maps/${mapId}.seeds.json`)
const coastPath = flag('coast') || join(root, `data/maps/${mapId}.coast.json`)
const outPath = flag('out') || join(root, `data/maps/${mapId}.json`)
const fetchArg = flag('fetch')

const started = Date.now()
const round1 = (v) => Math.round(v * 10) / 10

/** Sutherland-Hodgman against one half-plane of the bounds rectangle. */
function clipHalf(ring, keep, cut) {
  const out = []
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i]
    const prev = ring[(i + ring.length - 1) % ring.length]
    const inCur = keep(cur)
    const inPrev = keep(prev)
    if (inCur) {
      if (!inPrev) out.push(cut(prev, cur))
      out.push(cur)
    } else if (inPrev) out.push(cut(prev, cur))
  }
  return out
}

function clipRing(ring, b) {
  const cutX = (c) => (p, q) => {
    const t = (c - p[0]) / (q[0] - p[0])
    return [c, p[1] + t * (q[1] - p[1])]
  }
  const cutY = (c) => (p, q) => {
    const t = (c - p[1]) / (q[1] - p[1])
    return [p[0] + t * (q[0] - p[0]), c]
  }
  let r = ring
  r = clipHalf(r, (p) => p[0] >= b.lonMin, cutX(b.lonMin))
  if (r.length < 3) return null
  r = clipHalf(r, (p) => p[0] <= b.lonMax, cutX(b.lonMax))
  if (r.length < 3) return null
  r = clipHalf(r, (p) => p[1] >= b.latMin, cutY(b.latMin))
  if (r.length < 3) return null
  r = clipHalf(r, (p) => p[1] <= b.latMax, cutY(b.latMax))
  return r.length < 3 ? null : r
}

function clipLand(geojson, b) {
  const polygons = []
  for (const f of geojson.features) {
    const parts =
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const part of parts) {
      const rings = []
      for (const ring of part) {
        const clipped = clipRing(ring, b)
        // A hole survives only inside a surviving shell, so an empty shell ends it.
        if (!clipped) {
          if (rings.length === 0) break
          continue
        }
        rings.push(clipped.map(([lon, lat]) => [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4]))
      }
      if (rings.length) polygons.push(rings)
    }
  }
  return polygons
}

async function writeCoast(bounds, source) {
  const geojson = source
    ? JSON.parse(readFileSync(source, 'utf8'))
    : await (await fetch(NE_LAND_URL)).json()
  const polygons = clipLand(geojson, bounds)
  mkdirSync(dirname(coastPath), { recursive: true })
  writeFileSync(
    coastPath,
    JSON.stringify({
      source: 'Natural Earth 1:50m land (public domain)',
      url: NE_LAND_URL,
      bounds,
      polygons,
    }),
  )
  const pts = polygons.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0)
  console.log(`clipped coastline: ${polygons.length} polygons, ${pts} points -> ${coastPath}`)
}

function projector(bounds) {
  const kx = Math.cos((((bounds.latMin + bounds.latMax) / 2) * Math.PI) / 180)
  const scale = VIEW_W / ((bounds.lonMax - bounds.lonMin) * kx)
  return {
    width: VIEW_W,
    height: Math.round((bounds.latMax - bounds.latMin) * scale),
    x: (lon) => (lon - bounds.lonMin) * kx * scale,
    y: (lat) => (bounds.latMax - lat) * scale,
    lon: (x) => bounds.lonMin + x / (kx * scale),
    lat: (y) => bounds.latMax - y / scale,
  }
}

/** Even-odd scanline fill, sampling pixel centres. Holes need no special case:
 *  their edges contribute crossings like any other ring. */
function rasterize(polygons, proj, s, W, H) {
  const land = new Uint8Array(W * H)
  for (const rings of polygons) {
    const edges = []
    let yLo = Infinity
    let yHi = -Infinity
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        const ax = proj.x(a[0]) * s
        const ay = proj.y(a[1]) * s
        const bx = proj.x(b[0]) * s
        const by = proj.y(b[1]) * s
        if (ay === by) continue
        edges.push(ax, ay, bx, by)
        yLo = Math.min(yLo, ay, by)
        yHi = Math.max(yHi, ay, by)
      }
    }
    if (!edges.length) continue
    const rowLo = Math.max(0, Math.ceil(yLo - 0.5))
    const rowHi = Math.min(H - 1, Math.floor(yHi - 0.5))
    const xs = []
    for (let row = rowLo; row <= rowHi; row++) {
      const yc = row + 0.5
      xs.length = 0
      for (let e = 0; e < edges.length; e += 4) {
        const ay = edges[e + 1]
        const by = edges[e + 3]
        if (ay > yc === by > yc) continue
        const ax = edges[e]
        const bx = edges[e + 2]
        xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax))
      }
      if (xs.length < 2) continue
      xs.sort((p, q) => p - q)
      const base = row * W
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.ceil(xs[i] - 0.5))
        const to = Math.min(W - 1, Math.ceil(xs[i + 1] - 0.5) - 1)
        for (let x = from; x <= to; x++) land[base + x] = 1
      }
    }
  }
  return land
}

const D8X = [1, -1, 0, 0, 1, 1, -1, -1]
const D8Y = [0, 0, 1, -1, 1, -1, 1, -1]
/** Chamfer weights: 7/5 is a good cheap stand-in for sqrt 2, and keeps the grown
 *  borders from going visibly diamond-shaped the way unweighted steps do. */
const D8W = [5, 5, 5, 5, 7, 7, 7, 7]

/** Drops 8-connected land blobs below `minPx`, and returns how many pixels went. */
function pruneIslets(land, W, H, minPx) {
  const seen = new Uint8Array(land.length)
  const stack = []
  const blob = []
  let dropped = 0
  for (let p = 0; p < land.length; p++) {
    if (!land[p] || seen[p]) continue
    stack.length = 0
    blob.length = 0
    stack.push(p)
    seen[p] = 1
    while (stack.length) {
      const q = stack.pop()
      blob.push(q)
      const x = q % W
      const y = (q - x) / W
      for (let k = 0; k < 8; k++) {
        const nx = x + D8X[k]
        const ny = y + D8Y[k]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const n = ny * W + nx
        if (!land[n] || seen[n]) continue
        seen[n] = 1
        stack.push(n)
      }
    }
    if (blob.length < minPx) {
      for (const q of blob) land[q] = 0
      dropped += blob.length
    }
  }
  return dropped
}

/** Multi-source Dijkstra over land pixels, bucketed by distance (weights are 5
 *  and 7, so eight buckets cycle without collisions). */
function growRegions(land, W, H, seedPx) {
  const dist = new Int32Array(land.length).fill(0x7fffffff)
  const owner = new Int32Array(land.length).fill(-1)
  const buckets = Array.from({ length: 8 }, () => [])
  let pending = 0
  for (let s = 0; s < seedPx.length; s++) {
    const p = seedPx[s]
    if (p < 0 || dist[p] === 0) continue
    dist[p] = 0
    owner[p] = s
    buckets[0].push(p)
    pending++
  }
  for (let d = 0; pending > 0; d++) {
    const bucket = buckets[d & 7]
    while (bucket.length) {
      const p = bucket.pop()
      pending--
      if (dist[p] !== d) continue
      const x = p % W
      const y = (p - x) / W
      for (let k = 0; k < 8; k++) {
        const nx = x + D8X[k]
        const ny = y + D8Y[k]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const q = ny * W + nx
        if (!land[q]) continue
        const nd = d + D8W[k]
        if (nd >= dist[q]) continue
        dist[q] = nd
        owner[q] = owner[p]
        buckets[nd & 7].push(q)
        pending++
      }
    }
  }
  return owner
}

/**
 * Marching squares over the pixel cracks: each inside pixel contributes the
 * boundary edges it does not share with another inside pixel, wound so the
 * interior sits on the right. Shells come out clockwise and holes anticlockwise,
 * which is what the default non-zero fill rule wants.
 *
 * `mask` must be padded by one empty pixel on every side; `ox`/`oy` shift the
 * result back into whole-grid corner coordinates.
 */
function traceMask(mask, w, h, ox, oy) {
  const CW = w + 1
  const a = new Int32Array(CW * (h + 1)).fill(-1)
  const b = new Int32Array(CW * (h + 1)).fill(-1)
  const add = (from, to) => {
    if (a[from] === -1) a[from] = to
    else b[from] = to
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!mask[y * w + x]) continue
      const c = y * CW + x
      if (!mask[(y - 1) * w + x]) add(c, c + 1)
      if (!mask[y * w + x + 1]) add(c + 1, c + 1 + CW)
      if (!mask[(y + 1) * w + x]) add(c + 1 + CW, c + CW)
      if (!mask[y * w + x - 1]) add(c + CW, c)
    }
  }

  // At a saddle two loops meet in one corner. Turning left — away from the
  // interior — joins them, matching the 8-connected search that grew the region.
  const step = (c, dx, dy) => {
    if (a[c] === -1) return -1
    if (b[c] === -1 || (dx === 0 && dy === 0)) {
      const n = a[c]
      a[c] = b[c]
      b[c] = -1
      return n
    }
    for (const [tx, ty] of [
      [dy, -dx],
      [dx, dy],
      [-dy, dx],
    ]) {
      const want = c + ty * CW + tx
      if (a[c] === want) {
        a[c] = b[c]
        b[c] = -1
        return want
      }
      if (b[c] === want) {
        b[c] = -1
        return want
      }
    }
    const n = a[c]
    a[c] = b[c]
    b[c] = -1
    return n
  }

  const rings = []
  for (let start = 0; start < a.length; start++) {
    while (a[start] !== -1) {
      const ring = []
      let c = start
      let dx = 0
      let dy = 0
      do {
        ring.push(c)
        const n = step(c, dx, dy)
        if (n === -1) break
        const delta = n - c
        dx = delta === 1 ? 1 : delta === -1 ? -1 : 0
        dy = delta === CW ? 1 : delta === -CW ? -1 : 0
        c = n
      } while (c !== start)
      if (ring.length >= 4)
        rings.push(ring.map((p) => [(p % CW) + ox, (p - (p % CW)) / CW + oy]))
    }
  }
  return rings
}

function dpSimplify(pts, tol) {
  const n = pts.length
  if (n < 3) return pts.slice()
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack = [[0, n - 1]]
  const tol2 = tol * tol
  while (stack.length) {
    const [lo, hi] = stack.pop()
    if (hi - lo < 2) continue
    const [x0, y0] = pts[lo]
    const [x1, y1] = pts[hi]
    const ex = x1 - x0
    const ey = y1 - y0
    const len2 = ex * ex + ey * ey
    let far = -1
    let best = tol2
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = pts[i]
      let d2
      if (len2 === 0) {
        d2 = (px - x0) ** 2 + (py - y0) ** 2
      } else {
        const cross = (px - x0) * ey - (py - y0) * ex
        d2 = (cross * cross) / len2
      }
      if (d2 > best) {
        best = d2
        far = i
      }
    }
    if (far === -1) continue
    keep[far] = 1
    stack.push([lo, far], [far, hi])
  }
  return pts.filter((_, i) => keep[i])
}

/** Anchoring the split at the loop's topmost-then-leftmost corner is what lets a
 *  neighbour that walks the same loop from a different start reduce it to the
 *  very same points. */
function simplifyClosed(ring, tol) {
  if (ring.length < 8) return ring
  let a = 0
  for (let i = 1; i < ring.length; i++)
    if (ring[i][1] < ring[a][1] || (ring[i][1] === ring[a][1] && ring[i][0] < ring[a][0])) a = i
  const rot = [...ring.slice(a), ...ring.slice(0, a)]
  let far = 0
  let best = -1
  for (let i = 1; i < rot.length; i++) {
    const d = (rot[i][0] - rot[0][0]) ** 2 + (rot[i][1] - rot[0][1]) ** 2
    if (d > best) {
      best = d
      far = i
    }
  }
  const head = dpSimplify(rot.slice(0, far + 1), tol)
  const tail = dpSimplify([...rot.slice(far), rot[0]], tol)
  return [...head.slice(0, -1), ...tail.slice(0, -1)]
}

function chaikinClosed(ring) {
  const out = []
  for (let i = 0; i < ring.length; i++) {
    const [px, py] = ring[i]
    const [qx, qy] = ring[(i + 1) % ring.length]
    out.push([px * 0.75 + qx * 0.25, py * 0.75 + qy * 0.25])
    out.push([px * 0.25 + qx * 0.75, py * 0.25 + qy * 0.75])
  }
  return out
}

function chaikinOpen(pts) {
  if (pts.length < 3) return pts
  const out = [pts[0]]
  for (let i = 0; i < pts.length - 1; i++) {
    const [px, py] = pts[i]
    const [qx, qy] = pts[i + 1]
    if (i > 0) out.push([px * 0.75 + qx * 0.25, py * 0.75 + qy * 0.25])
    if (i < pts.length - 2) out.push([px * 0.25 + qx * 0.75, py * 0.25 + qy * 0.75])
  }
  out.push(pts[pts.length - 1])
  return out
}

/**
 * Simplify and smooth a traced loop.
 *
 * Every province is traced on its own, so the two sides of a border are two
 * separate loops. Left to themselves they each drift up to the tolerance and the
 * map ends up with hairline gaps along every frontier. Splitting the loop at the
 * corners where three regions meet fixes it: the stretch between two such corners
 * is the same run of pixel cracks for both provinces, and Douglas-Peucker and
 * Chaikin both give the same answer on a reversed run, so the two sides come out
 * point-for-point identical and the map tiles.
 */
function smoothRing(ring, isJunction) {
  const marks = []
  for (let i = 0; i < ring.length; i++) if (isJunction(ring[i][0], ring[i][1])) marks.push(i)

  if (marks.length < 2) {
    let r = simplifyClosed(ring, SIMPLIFY_PX)
    if (r.length < 4) return r
    for (let i = 0; i < CHAIKIN_PASSES; i++) r = chaikinClosed(r)
    return simplifyClosed(r, POLISH_PX)
  }

  const out = []
  for (let k = 0; k < marks.length; k++) {
    const from = marks[k]
    const to = marks[(k + 1) % marks.length]
    const arc =
      to > from ? ring.slice(from, to + 1) : [...ring.slice(from), ...ring.slice(0, to + 1)]
    let r = dpSimplify(arc, SIMPLIFY_PX)
    for (let i = 0; i < CHAIKIN_PASSES; i++) r = chaikinOpen(r)
    r = dpSimplify(r, POLISH_PX)
    out.push(...r.slice(0, -1))
  }
  return out
}

function ringsToPath(rings, unitsPerPx) {
  const parts = []
  for (const ring of rings) {
    if (ring.length < 3) continue
    const pts = ring.map(([x, y]) => `${round1(x * unitsPerPx)} ${round1(y * unitsPerPx)}`)
    parts.push(`M${pts.join('L')}Z`)
  }
  return parts.join('')
}

/** Pole of inaccessibility: chamfer distance transform, then the deepest pixel.
 *  A centroid falls outside anything concave — Norway, Italy, Greece. */
function poleOfInaccessibility(mask, w, h) {
  const dist = new Int32Array(mask.length)
  const INF = 1 << 28
  for (let i = 0; i < mask.length; i++) dist[i] = mask[i] ? INF : 0
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (!dist[i]) continue
      const d = Math.min(
        dist[i - w] + 5,
        dist[i - 1] + 5,
        dist[i - w - 1] + 7,
        dist[i - w + 1] + 7,
        dist[i],
      )
      dist[i] = d
    }
  }
  let best = -1
  let bx = 0
  let by = 0
  for (let y = h - 2; y >= 0; y--) {
    for (let x = w - 2; x >= 1; x--) {
      const i = y * w + x
      if (!dist[i]) continue
      const d = Math.min(
        dist[i + w] + 5,
        dist[i + 1] + 5,
        dist[i + w + 1] + 7,
        dist[i + w - 1] + 7,
        dist[i],
      )
      dist[i] = d
      if (d > best) {
        best = d
        bx = x
        by = y
      }
    }
  }
  return [bx, by]
}

const readJson = (path, what) => {
  if (!existsSync(path)) throw new Error(`no ${what} at ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

const seedFile = readJson(seedsPath, 'seed file')
const bounds = seedFile.bounds

if (fetchArg !== null) await writeCoast(bounds, fetchArg || null)

const coast = readJson(coastPath, 'clipped coastline — run with --fetch to build one')
const proj = projector(bounds)
const s = GRID_W / VIEW_W
const unitsPerPx = 1 / s
const W = GRID_W
const H = Math.round(proj.height * s)

const land = rasterize(coast.polygons, proj, s, W, H)
let landPx = 0
for (let i = 0; i < land.length; i++) landPx += land[i]
const droppedPx = pruneIslets(land, W, H, MIN_ISLAND_PX)

const seeds = seedFile.seeds
const snapped = []
const seedPx = seeds.map((seed) => {
  const gx = Math.round(proj.x(seed.lon) * s - 0.5)
  const gy = Math.round(proj.y(seed.lat) * s - 0.5)
  if (gx < 0 || gy < 0 || gx >= W || gy >= H) throw new Error(`seed ${seed.id} is outside bounds`)
  if (land[gy * W + gx]) return gy * W + gx
  for (let r = 1; r <= SNAP_RADIUS_PX; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const nx = gx + dx
        const ny = gy + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        if (!land[ny * W + nx]) continue
        snapped.push(`${seed.id} (+${r}px)`)
        return ny * W + nx
      }
    }
  }
  throw new Error(`seed ${seed.id} has no land within ${SNAP_RADIUS_PX}px`)
})

const owner = growRegions(land, W, H, seedPx)

let unassigned = 0
const counts = new Int32Array(seeds.length)
const box = seeds.map(() => [W, H, -1, -1])
for (let p = 0; p < owner.length; p++) {
  const o = owner[p]
  if (o < 0) {
    if (land[p]) unassigned++
    continue
  }
  counts[o]++
  const x = p % W
  const y = (p - x) / W
  const bb = box[o]
  if (x < bb[0]) bb[0] = x
  if (y < bb[1]) bb[1] = y
  if (x > bb[2]) bb[2] = x
  if (y > bb[3]) bb[3] = y
}

const empty = seeds.filter((seed, i) => counts[i] === 0).map((seed) => seed.id)
if (empty.length) throw new Error(`no region grew for: ${empty.join(', ')}`)

// Unassigned land is always an island no seed can walk to. Reporting where the
// big ones are is the difference between a number and something the author can
// act on: an island that large usually wants a seed and a sea link.
const orphanLand = new Uint8Array(land.length)
for (let p = 0; p < land.length; p++) if (land[p] && owner[p] < 0) orphanLand[p] = 1
const orphans = []
{
  const seen = new Uint8Array(land.length)
  const stack = []
  for (let p = 0; p < orphanLand.length; p++) {
    if (!orphanLand[p] || seen[p]) continue
    stack.length = 0
    stack.push(p)
    seen[p] = 1
    let n = 0
    let sx = 0
    let sy = 0
    while (stack.length) {
      const q = stack.pop()
      const x = q % W
      const y = (q - x) / W
      n++
      sx += x
      sy += y
      for (let k = 0; k < 8; k++) {
        const nx = x + D8X[k]
        const ny = y + D8Y[k]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const r = ny * W + nx
        if (!orphanLand[r] || seen[r]) continue
        seen[r] = 1
        stack.push(r)
      }
    }
    orphans.push({ n, lon: proj.lon(sx / n / s), lat: proj.lat(sy / n / s) })
  }
  orphans.sort((a, b) => b.n - a.n)
}

// A corner where three or more labels meet — water and off-map both count as one
// label, so a coastal corner between two provinces is a junction too.
const labelAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : owner[y * W + x])
const isJunction = (cx, cy) => {
  const p = labelAt(cx - 1, cy - 1)
  const q = labelAt(cx, cy - 1)
  const r = labelAt(cx - 1, cy)
  const t = labelAt(cx, cy)
  let n = 1
  if (q !== p) n++
  if (r !== p && r !== q) n++
  if (t !== p && t !== q && t !== r) n++
  return n >= 3
}

const provinces = seeds.map((seed, i) => {
  const [x0, y0, x1, y1] = box[i]
  const mw = x1 - x0 + 3
  const mh = y1 - y0 + 3
  const mask = new Uint8Array(mw * mh)
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (owner[y * W + x] === i) mask[(y - y0 + 1) * mw + (x - x0 + 1)] = 1

  const rings = traceMask(mask, mw, mh, x0 - 1, y0 - 1).map((ring) => smoothRing(ring, isJunction))
  const d = ringsToPath(rings, unitsPerPx)
  if (!d) throw new Error(`empty path for ${seed.id}`)
  const [ax, ay] = poleOfInaccessibility(mask, mw, mh)

  const { id, name, nation, terrain, depot, vp } = seed
  return {
    id,
    name,
    nation,
    terrain,
    depot,
    vp,
    cx: round1((ax + x0 - 1 + 0.5) * unitsPerPx),
    cy: round1((ay + y0 - 1 + 0.5) * unitsPerPx),
    d,
  }
})

// Shared border in pixel cracks: four-connected, so provinces that only touch at
// a corner share nothing at all and never reach the threshold.
const shared = new Map()
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = owner[y * W + x]
    if (o < 0) continue
    for (const q of [x + 1 < W ? y * W + x + 1 : -1, y + 1 < H ? (y + 1) * W + x : -1]) {
      if (q < 0) continue
      const n = owner[q]
      if (n < 0 || n === o) continue
      const key = o < n ? `${o},${n}` : `${n},${o}`
      shared.set(key, (shared.get(key) ?? 0) + 1)
    }
  }
}

const edges = []
for (const [key, px] of shared) {
  if (px < MIN_SHARED_PX) continue
  const [a, b] = key.split(',').map(Number)
  edges.push({ a: seeds[a].id, b: seeds[b].id, len: round1(px * unitsPerPx), sea: false })
}

// Sea links have no shared border, so `len` carries the width of the water they
// cross — the same units, and the number the crossing rules will want.
const rim = seeds.map(() => [])
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    const o = owner[y * W + x]
    if (o < 0) continue
    if (
      owner[y * W + x - 1] === o &&
      owner[y * W + x + 1] === o &&
      owner[(y - 1) * W + x] === o &&
      owner[(y + 1) * W + x] === o
    )
      continue
    rim[o].push(x, y)
  }
}
const stride = (list) => Math.max(1, Math.ceil(list.length / 2 / 1500))

const byId = new Map(seeds.map((seed, i) => [seed.id, i]))
const landPairs = new Set(edges.flatMap((e) => [`${e.a}|${e.b}`, `${e.b}|${e.a}`]))
const redundant = []
for (const link of seedFile.seaLinks ?? []) {
  const a = byId.get(link.a)
  const b = byId.get(link.b)
  if (a === undefined || b === undefined) throw new Error(`sea link names an unknown province: ${link.a} <-> ${link.b}`)
  // The land border already connects them, and two edges for one pair would
  // double-count in every degree and frontage calculation downstream.
  if (landPairs.has(`${link.a}|${link.b}`)) {
    redundant.push(`${link.a} <-> ${link.b}`)
    continue
  }
  const A = rim[a]
  const B = rim[b]
  const sa = stride(A) * 2
  const sb = stride(B) * 2
  let best = Infinity
  for (let i = 0; i < A.length; i += sa)
    for (let j = 0; j < B.length; j += sb) {
      const dx = A[i] - B[j]
      const dy = A[i + 1] - B[j + 1]
      const d = dx * dx + dy * dy
      if (d < best) best = d
    }
  const edge = { a: link.a, b: link.b, len: round1(Math.sqrt(best) * unitsPerPx), sea: true }
  if (link.name) edge.name = link.name
  edges.push(edge)
}

edges.sort((p, q) => p.a.localeCompare(q.a) || p.b.localeCompare(q.b))

const adjacency = Object.fromEntries(seeds.map((seed) => [seed.id, []]))
for (const e of edges) {
  adjacency[e.a].push(e.b)
  adjacency[e.b].push(e.a)
}
for (const list of Object.values(adjacency)) list.sort()

const coastMask = new Uint8Array((W + 2) * (H + 2))
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) if (land[y * W + x]) coastMask[(y + 1) * (W + 2) + (x + 1)] = 1
const coastPathD = ringsToPath(
  traceMask(coastMask, W + 2, H + 2, -1, -1).map((ring) => smoothRing(ring, () => false)),
  unitsPerPx,
)

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(
  outPath,
  JSON.stringify({
    id: seedFile.id,
    name: seedFile.name,
    viewBox: `0 0 ${VIEW_W} ${proj.height}`,
    coast: coastPathD,
    provinces,
    adjacency,
    edges,
  }),
)

const degrees = Object.values(adjacency).map((l) => l.length)
const avg = degrees.reduce((a, c) => a + c, 0) / degrees.length
console.log(`${outPath}`)
console.log(`  ${provinces.length} provinces, ${edges.length} edges (${edges.filter((e) => e.sea).length} sea)`)
console.log(`  grid ${W}x${H}, ${landPx} land px, ${droppedPx} dropped as islets`)
console.log(`  ${unassigned} land px unassigned (${((unassigned / (landPx - droppedPx)) * 100).toFixed(2)}%) in ${orphans.length} islands no seed can reach`)
for (const o of orphans.slice(0, 3))
  console.log(`    ${o.n} px near ${o.lon.toFixed(1)},${o.lat.toFixed(1)}`)
console.log(`  average degree ${avg.toFixed(2)}, min ${Math.min(...degrees)}, max ${Math.max(...degrees)}`)
if (snapped.length) console.log(`  snapped to land: ${snapped.join(', ')}`)
if (redundant.length) console.log(`  sea links dropped, already a land border: ${redundant.join(', ')}`)
console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s`)
