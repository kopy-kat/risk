/**
 * Fit the strongest doctrine the parameter space holds.
 *
 *   npm run fit-doctrine
 *   npm run fit-doctrine -- --seeds 120 --generations 8
 *
 * Exploitability measured against a hand-tuned opponent mostly measures the hand
 * tuning: six numbers picked by a person are not going to be the best six. So the
 * champion has to be fitted before "is there a line this cannot answer" means
 * anything about the rules.
 *
 * The objective is the average win rate against a *population* — every named
 * doctrine plus everything the exploit search has archived — rather than against
 * one opponent. Fitting against a single opponent finds its counter, which is a
 * different and much easier thing to find.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DOCTRINES } from '../src/games/kessel/bot'
import type { Opponent, Params } from './kessel-cem'
import { KEYS, rateAll, refit, rngFor, sample, show, startDist } from './kessel-cem'
import { defaultWorkers } from './parallel'
import { wilson } from './stats'

const CHAMPION_PATH = fileURLToPath(new URL('../data/kessel-champion.json', import.meta.url))
const ARCHIVE_PATH = fileURLToPath(new URL('../data/kessel-exploiters.json', import.meta.url))

const argv = process.argv.slice(2)
const opt = (name: string, fallback: number) => {
  const i = argv.indexOf(name)
  return i >= 0 ? Number(argv[i + 1]) : fallback
}

const seeds = opt('--seeds', 60)
const candidates = opt('--candidates', 10)
const generations = opt('--generations', 6)
const confirm = opt('--confirm', 200)
const workers = opt('--jobs', defaultWorkers())
const rand = rngFor(opt('--seed', 4242))
const eliteFrac = 0.3

const archived: { params: Params }[] = (() => {
  try {
    return JSON.parse(readFileSync(ARCHIVE_PATH, 'utf8')) as { params: Params }[]
  } catch {
    return []
  }
})()

const population: Opponent[] = [
  ...DOCTRINES.map((d) => ({ key: `kessel-${d.key}` })),
  ...archived.slice(0, 3).map((a, i) => ({ key: `archived${i}`, params: a.params })),
]

console.log(
  `fitting against ${population.length} opponents — ` +
    `${generations} generations × ${candidates} candidates × ${seeds} games each`,
)

let dist = startDist()
let best: Params | null = null
let bestRate = 0

for (let g = 0; g < generations; g++) {
  const pool = Array.from({ length: candidates }, () => sample(dist, rand))
  const rates = await rateAll(pool, population, seeds, g * 10_000, workers)
  const ranked = pool.map((p, i) => ({ p, r: rates[i] })).sort((a, b) => b.r - a.r)
  dist = refit(ranked.slice(0, Math.max(2, Math.round(candidates * eliteFrac))).map((e) => e.p))

  if (ranked[0].r > bestRate) {
    bestRate = ranked[0].r
    best = ranked[0].p
  }
  const spread = KEYS.map((k) => dist[k].sd / 1).reduce((a, b) => a + b, 0)
  console.log(
    `  gen ${g + 1}: best ${(ranked[0].r * 100).toFixed(1)}%  ` +
      `median ${(ranked[Math.floor(ranked.length / 2)].r * 100).toFixed(1)}%  ` +
      `spread ${spread.toFixed(2)}`,
  )
}

if (!best) {
  console.log('no candidate survived')
  process.exit(0)
}

const [confirmed] = await rateAll([best], population, confirm, 800_000, workers)
const { half } = wilson(Math.round(confirmed * confirm * population.length), confirm * population.length)

console.log(`\nsearch best   ${(bestRate * 100).toFixed(1)}%`)
console.log(`confirmed     ${(confirmed * 100).toFixed(1)}% ±${(half * 100).toFixed(1)} against the population, on fresh seeds`)
console.log(show(best))

writeFileSync(CHAMPION_PATH, `${JSON.stringify({ winRate: confirmed, against: population.map((o) => o.key), params: best }, null, 2)}\n`)
console.log(`\nwritten to ${CHAMPION_PATH.split('/').slice(-2).join('/')} — point exploit:kessel at it with --target champion`)
