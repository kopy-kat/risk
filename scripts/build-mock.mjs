// Inlines board + geometry data into the design mock so it opens straight from disk
// (no fetch, no server, no CORS). Run: node scripts/build-mock.mjs
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const geo = JSON.parse(readFileSync(join(root, 'data/territories.json'), 'utf8'))
const board = JSON.parse(readFileSync(join(root, 'data/board.json'), 'utf8'))

// Continent label anchors, in open ocean on the side that reads as "belonging to"
// the landmass. Solved offline against the real paths with isPointInFill —
// see scripts/solve-label-anchors.mjs if the geometry ever changes.
const labels = {
  northAmerica: [137, 46],
  europe: [333, 73],
  asia: [643, 28],
  southAmerica: [141, 372],
  africa: [341, 399],
  australia: [582, 413],
}

const html = readFileSync(join(root, 'mock/index.template.html'), 'utf8')
  .replace('__TERRITORIES__', JSON.stringify(geo.territories))
  .replace('__CONT_LABELS__', JSON.stringify(labels))
  .replace('__BOARD__', JSON.stringify(board))

writeFileSync(join(root, 'mock/index.html'), html)
console.log(`mock/index.html — ${geo.territories.length} territories, ${(html.length / 1024).toFixed(0)}kb`)
