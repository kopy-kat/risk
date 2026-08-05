/**
 * Finds an open-ocean anchor for each continent label, on the side of the landmass
 * that reads as belonging to it. Results are pasted into CONTINENT_LABEL_POS in
 * src/engine/board.ts — only needs re-running if the map geometry changes.
 *
 *   node scripts/solve-label-anchors.mjs
 */
import { chromium } from 'playwright'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const geo = JSON.parse(readFileSync(join(root, 'data/territories.json'), 'utf8'))

/** preferred bearing (degrees, 0 = east, 90 = south) and how far off it may stray */
const PREF = {
  africa: [180, 55],
  asia: [270, 55],
  northAmerica: [270, 70],
  southAmerica: [180, 60],
  europe: [300, 60],
  australia: [200, 70],
}

// A throwaway page with just the shapes — measuring against the real app or the
// design mock would couple this pipeline to their markup.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 560">${geo.territories
  .map((t) => `<path class="terr" id="t-${t.id}" d="${t.d}"/>`)
  .join('')}</svg>`

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`)
await page.waitForSelector('.terr')

const result = await page.evaluate(
  ({ territories, pref }) => {
    const svgEl = document.querySelector('svg')
    const paths = [...document.querySelectorAll('.terr')]
    const pt = svgEl.createSVGPoint()

    // a label needs a clear box roughly 68 x 28 around the anchor
    const clear = (x, y) => {
      for (let dx = -34; dx <= 34; dx += 8.5)
        for (let dy = -13; dy <= 15; dy += 7) {
          pt.x = x + dx
          pt.y = y + dy
          for (const el of paths) if (el.isPointInFill(pt)) return false
        }
      return true
    }

    const groups = {}
    for (const t of territories) (groups[t.continent] ||= []).push(t)

    const out = {}
    for (const [key, members] of Object.entries(groups)) {
      const cx = members.reduce((s, t) => s + t.cx, 0) / members.length
      const cy = members.reduce((s, t) => s + t.cy, 0) / members.length
      const [want, span] = pref[key] ?? [null, 360]
      let best = null
      for (let r = 10; r <= 300 && !best; r += 6)
        for (let a = 0; a < 360; a += 6) {
          if (want !== null) {
            const dev = Math.abs(((a - want + 540) % 360) - 180)
            if (dev > span) continue
          }
          const x = cx + r * Math.cos((a * Math.PI) / 180)
          const y = cy + r * Math.sin((a * Math.PI) / 180)
          if (x < 60 || x > 700 || y < 26 || y > 470) continue
          if (clear(x, y)) {
            best = [Math.round(x), Math.round(y)]
            break
          }
        }
      out[key] = best
    }
    return out
  },
  { territories: geo.territories, pref: PREF },
)

console.log(JSON.stringify(result, null, 1))
await browser.close()
