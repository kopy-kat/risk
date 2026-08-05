/**
 * Works out which adjacent territories are separated by water, and where to draw
 * the connecting route, by sampling the real outlines in a browser.
 *
 *   node scripts/solve-sea-routes.mjs
 *
 * Writes data/sea-routes.json. Only needs re-running if the map geometry or the
 * adjacency graph changes.
 *
 * The measured split is unambiguous: land borders come out <= 1.1 units apart,
 * water crossings >= 5.5, so the 2.5 threshold sits in open space.
 */
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOUCH_THRESHOLD = 2.5
/** Alaska <-> Kamchatka is a whole map apart; it gets drawn as two edge stubs. */
const WRAP_PAIR = ['alaska', 'kamchatka']
const LEFT_EDGE = 16
const RIGHT_EDGE = 739

const board = JSON.parse(readFileSync(join(root, 'data/board.json'), 'utf8'))
const geo = JSON.parse(readFileSync(join(root, 'data/territories.json'), 'utf8'))

// Build a throwaway page holding just the outlines. Measuring against the real
// app or the design mock would couple this pipeline to their markup.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 560">${geo.territories
  .map((t) => `<path class="edge" id="edge-${t.id}" fill="none" stroke="#000" d="${t.d}"/>`)
  .join('')}</svg>`

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`)
await page.waitForSelector('.edge')

const pairs = await page.evaluate((adjacency) => {
  const els = {}
  for (const el of document.querySelectorAll('.edge')) els[el.id.replace('edge-', '')] = el

  const SAMPLES = 500
  const pts = {}
  for (const [id, el] of Object.entries(els)) {
    const L = el.getTotalLength()
    const arr = new Float64Array(SAMPLES * 2)
    for (let i = 0; i < SAMPLES; i++) {
      const pt = el.getPointAtLength((i / SAMPLES) * L)
      arr[i * 2] = pt.x
      arr[i * 2 + 1] = pt.y
    }
    pts[id] = arr
  }

  const out = []
  const seen = new Set()
  for (const [a, ns] of Object.entries(adjacency))
    for (const n of ns) {
      const key = [a, n].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      const A = pts[a], B = pts[n]
      let best = Infinity, bi = 0, bj = 0
      for (let i = 0; i < A.length; i += 2)
        for (let j = 0; j < B.length; j += 2) {
          const dx = A[i] - B[j], dy = A[i + 1] - B[j + 1]
          const d = dx * dx + dy * dy
          if (d < best) { best = d; bi = i; bj = j }
        }
      const r = (v) => Math.round(v * 10) / 10
      out.push({
        a, b: n,
        dist: Math.round(Math.sqrt(best) * 100) / 100,
        pa: [r(A[bi]), r(A[bi + 1])],
        pb: [r(B[bj]), r(B[bj + 1])],
      })
    }
  return out
}, board.adjacency)

await browser.close()

const isWrap = (r) => WRAP_PAIR.includes(r.a) && WRAP_PAIR.includes(r.b)
const separated = pairs.filter((r) => r.dist >= TOUCH_THRESHOLD)

const routes = separated
  .filter((r) => !isWrap(r))
  .sort((x, y) => x.dist - y.dist)
  .map(({ a, b, pa, pb, dist }) => ({ a, b, pa, pb, dist }))

const wrapRow = separated.find(isWrap)
const wrap = wrapRow
  ? [
      { territory: wrapRow.a, from: wrapRow.pa, toX: wrapRow.pa[0] < 370 ? LEFT_EDGE : RIGHT_EDGE },
      { territory: wrapRow.b, from: wrapRow.pb, toX: wrapRow.pb[0] < 370 ? LEFT_EDGE : RIGHT_EDGE },
    ]
  : []

writeFileSync(
  join(root, 'data/sea-routes.json'),
  JSON.stringify({ threshold: TOUCH_THRESHOLD, routes, wrap }, null, 1),
)

console.log(`${pairs.length} adjacency pairs`)
console.log(`  ${pairs.length - separated.length} share a land border (max ${Math.max(...pairs.filter((r) => r.dist < TOUCH_THRESHOLD).map((r) => r.dist))} units apart)`)
console.log(`  ${routes.length} drawn as sea routes`)
console.log(`  ${wrap.length ? `${wrapRow.a} <-> ${wrapRow.b} drawn as edge stubs (${wrapRow.dist} units apart)` : 'no wrap pair'}`)
