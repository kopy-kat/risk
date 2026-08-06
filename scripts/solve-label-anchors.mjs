/**
 * Finds an open-ocean anchor for each continent label, on the side of the landmass
 * that reads as belonging to it. Results are pasted into CONTINENT_LABEL_POS in
 * src/engine/board.ts — only needs re-running if the map geometry changes.
 *
 *   node scripts/solve-label-anchors.mjs
 *
 * The label is two lines of text, and the long ones ("NORTH AMERICA") are wide, so
 * the search tests the whole box the label will occupy — inflated by MARGIN — for
 * land rather than just the anchor point. Anything less and the wide labels end up
 * printed across Canada.
 */
import { chromium } from 'playwright'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const geo = JSON.parse(readFileSync(join(root, 'data/territories.json'), 'utf8'))
const board = JSON.parse(readFileSync(join(root, 'data/board.json'), 'utf8'))

/** preferred bearing (degrees, 0 = east, 90 = south) and how far off it may stray */
const PREF = {
  africa: [180, 55],
  asia: [270, 50],
  northAmerica: [280, 90],
  southAmerica: [180, 60],
  europe: [300, 60],
  australia: [200, 80],
}

/** how much clear water to leave around the label, in map units */
const MARGIN = 8

// A throwaway page with just the shapes — measuring against the real app or the
// design mock would couple this pipeline to their markup.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 560">${geo.territories
  .map((t) => `<path class="terr" id="t-${t.id}" d="${t.d}"/>`)
  .join('')}</svg>`

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`)
await page.waitForSelector('.terr')

const names = Object.fromEntries(
  Object.entries(board.continents).map(([id, c]) => [id, c.name.toUpperCase()]),
)

const result = await page.evaluate(
  ({ territories, pref, labels, margin }) => {
    const svgEl = document.querySelector('svg')
    const paths = [...document.querySelectorAll('.terr')]
    const pt = svgEl.createSVGPoint()

    const onLand = (x, y) => {
      pt.x = x
      pt.y = y
      for (const el of paths) if (el.isPointInFill(pt)) return true
      return false
    }

    // .cont-label is 8.5px uppercase with .34em tracking; .cont-bonus sits 11 below
    const widthOf = (text) => text.length * 8.5 * (0.62 + 0.34)

    /** is the label's whole box, plus a margin of clear water, free of land? */
    const clear = (x, y, w) => {
      const x0 = x - w / 2 - margin
      const x1 = x + w / 2 + margin
      const y0 = y - 8 - margin
      const y1 = y + 15 + margin
      for (let px = x0; px <= x1; px += 4)
        for (let py = y0; py <= y1; py += 4) if (onLand(px, py)) return false
      return true
    }

    const groups = {}
    for (const t of territories) (groups[t.continent] ||= []).push(t)

    const out = {}
    for (const [key, members] of Object.entries(groups)) {
      const cx = members.reduce((s, t) => s + t.cx, 0) / members.length
      const cy = members.reduce((s, t) => s + t.cy, 0) / members.length
      const w = widthOf(labels[key])
      const [want, span] = pref[key] ?? [null, 360]
      let best = null
      for (let r = 10; r <= 320 && !best; r += 4)
        for (let a = 0; a < 360; a += 4) {
          if (want !== null) {
            const dev = Math.abs(((a - want + 540) % 360) - 180)
            if (dev > span) continue
          }
          const x = cx + r * Math.cos((a * Math.PI) / 180)
          const y = cy + r * Math.sin((a * Math.PI) / 180)
          // stay inside the viewBox, and off the strip the floating dock covers
          if (x - w / 2 < 16 || x + w / 2 > 740 || y < 18 || y > 500) continue
          if (y > 452 && x > 190 && x < 570) continue
          if (clear(x, y, w)) {
            best = [Math.round(x), Math.round(y)]
            break
          }
        }
      out[key] = best
    }
    return out
  },
  { territories: geo.territories, pref: PREF, labels: names, margin: MARGIN },
)

console.log(JSON.stringify(result, null, 1))
await browser.close()
