// Inlines board + geometry data into the design mock so it opens straight from disk
// (no fetch, no server, no CORS). Run: node scripts/build-mock.mjs
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const geo = JSON.parse(readFileSync(join(root, 'data/territories.json'), 'utf8'))
const board = JSON.parse(readFileSync(join(root, 'data/board.json'), 'utf8'))

// Continent label anchors, in open ocean on the side that reads as "belonging to"
// the landmass. Solved offline against the real paths with isPointInFill — see
// scripts/solve-label-anchors.mjs if the geometry ever changes. Mirrors
// CONTINENT_LABEL_POS in src/engine/board.ts; keep the two in step.
const labels = {
  northAmerica: [113, 32],
  europe: [338, 67],
  asia: [606, 18],
  southAmerica: [114, 377],
  africa: [344, 404],
  australia: [572, 422],
}

const html = readFileSync(join(root, 'mock/index.template.html'), 'utf8')
  .replace('__TERRITORIES__', JSON.stringify(geo.territories))
  .replace('__CONT_LABELS__', JSON.stringify(labels))
  .replace('__BOARD__', JSON.stringify(board))

writeFileSync(join(root, 'mock/index.html'), html)
console.log(`mock/index.html — ${geo.territories.length} territories, ${(html.length / 1024).toFixed(0)}kb`)
