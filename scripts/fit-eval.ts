/**
 * Stage B, the data half: fit the evaluation's weights to game outcomes.
 *
 *   npm run fit-eval                 -- 1500 games, prints the adjudication
 *   npm run fit-eval -- --games 4000 -- more data, slower
 *
 * Harvests (position features, eventual winner) from games over a *population* —
 * the three tiers, every named pool point, and every archived exploiter — then
 * fits win probability by plain least squares and writes the weights to
 * `data/eval-weights.json`.
 *
 * The population matters more than the model. A fit on tier self-play inherits
 * self-play's blind spots: those games end near turn 49, nobody farms, nobody
 * banks, so hands and stack concentration never get the chance to predict
 * anything. Mixed tables put the strategies that actually win long games into
 * the training data — which is the whole reason `data/exploiters.json` seats
 * are included.
 *
 * Two honest limitations, by design:
 *
 *   The label is "won the whole game", so the fit favours what wins from any
 *   position, pooled over the early and late game alike.
 *
 *   Rows within one game are heavily correlated (the review-check lesson), so
 *   no standard errors are printed — the point estimates are meaningful, error
 *   bars computed as if rows were independent would not be. The out-of-sample
 *   check splits by *game* for the same reason.
 *
 * What it adjudicates: `assess` scores a position as
 *   smoothIncome × INCOME_HORIZON + armies × ARMY_WEIGHT + handValue − exposure × EXPOSURE_WEIGHT
 * with hand-picked constants (6, 0.5, 1, 0.25). Rescaling the fitted coefficients
 * to the handValue term makes the two directly comparable, and the rank check
 * answers the question that matters for play: on unseen games, which scoring
 * puts the eventual winner first more often?
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BOT_BY_KEY } from '../src/bots'
import { makePolicyBot } from '../src/bots/pool'
import type { Policy } from '../src/bots/pool'
import { stepBot } from '../src/bots/play'
import {
  ARMY_WEIGHT,
  EXPOSURE_WEIGHT,
  INCOME_HORIZON,
  exposure,
  handValue,
} from '../src/bots/strategy/evaluate'
import { incomeOf } from '../src/bots/strategy/board-sense'
import { createGame, territoriesOf } from '../src/engine/game'
import { rngFrom } from '../src/engine/rng'
import type { GameState, PlayerId } from '../src/engine/types'
import type { Bot } from '../src/bots/types'

const argv = process.argv.slice(2)
const opt = (name: string, fallback: number) => {
  const i = argv.indexOf(name)
  return i >= 0 ? Number(argv[i + 1]) : fallback
}
const GAMES = opt('--games', 1500)
const BASE_SEED = opt('--seed', 424242)
const TURN_CAP = 600
/** Positions sampled per player per game — few, because rows in a game correlate. */
const SAMPLES = 8

const WEIGHTS_PATH = fileURLToPath(new URL('../data/eval-weights.json', import.meta.url))
const ARCHIVE_PATH = fileURLToPath(new URL('../data/exploiters.json', import.meta.url))

// ── population ────────────────────────────────────────────────
// Tiers weighted up: theirs is the evaluation being fitted, so most positions
// should come from boards they produce. The pool and the archive supply the
// long games and the banked hands self-play never reaches.
const DRAW: Array<[string, number]> = [
  ['marshal', 3],
  ['general', 3],
  ['colonel', 3],
  ['cardShark', 2],
  ['blitzer', 1],
  ['banker', 1],
  ['camper', 1],
  ['farmer', 1],
]

const bots: Record<string, Bot> = { ...BOT_BY_KEY }
if (existsSync(ARCHIVE_PATH)) {
  const archived: Array<{ policy: Policy }> = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf8'))
  archived.forEach((a, i) => {
    const key = `exploiter${i}`
    bots[key] = makePolicyBot(key, key, '', a.policy)
    DRAW.push([key, 1])
  })
}
const TICKETS = DRAW.flatMap(([k, w]) => Array.from({ length: w }, () => k))

// ── features ──────────────────────────────────────────────────
// The raw terms `assess` weighs, plus two shapes it cannot see: ground share in
// tiles, and how concentrated the armies sit. Order matters to the report below.
const FEATURES = ['smoothIncome', 'armies', 'handValue', 'exposure', 'territories', 'concentration'] as const

function smoothIncome(s: GameState, p: PlayerId): number {
  const base = territoriesOf(s, p).length / 3
  const bonus = incomeOf(s, p) - Math.max(3, Math.floor(territoriesOf(s, p).length / 3))
  return base + bonus
}

function featuresOf(s: GameState, p: PlayerId): number[] {
  const mine = territoriesOf(s, p)
  let armies = 0
  let biggest = 0
  for (const t of mine) {
    armies += s.troops[t]
    biggest = Math.max(biggest, s.troops[t])
  }
  return [
    smoothIncome(s, p),
    armies,
    handValue(s, p),
    exposure(s, p),
    mine.length,
    biggest / Math.max(1, armies),
  ]
}

// ── harvest ───────────────────────────────────────────────────
interface Row {
  x: number[]
  y: number
  game: number
  /** which board this row was read from, so ranking groups the right rivals */
  snap: number
}

const rows: Row[] = []
let snapCounter = 0
const draw = rngFrom(BASE_SEED)
let played = 0
let stalled = 0

for (let g = 0; g < GAMES; g++) {
  const seed = BASE_SEED + g * 7919
  const seats = 4 + Math.floor(draw.next() * 3) // 4–6
  const order = Array.from({ length: seats }, () => TICKETS[Math.floor(draw.next() * TICKETS.length)])
  const rng = rngFrom(seed ^ 0x5bf03635)
  let s = createGame({
    seats: order.map((bot, i) => ({ name: `P${i}`, bot })),
    seed,
    record: false,
  })

  // sample at random turn boundaries, decided before the game is known
  const snaps: Array<{ turn: number; rows: Array<{ x: number[]; p: PlayerId }> }> = []
  const wanted = new Set<number>()
  while (wanted.size < SAMPLES) wanted.add(2 + Math.floor(draw.next() * 78))

  let lastTurn = -1
  while (s.phase !== 'gameOver' && s.turn < TURN_CAP) {
    if (s.turn !== lastTurn) {
      lastTurn = s.turn
      if (wanted.has(s.turn)) {
        snaps.push({
          turn: s.turn,
          rows: s.players.filter((p) => p.alive).map((p) => ({ x: featuresOf(s, p.id), p: p.id })),
        })
      }
    }
    const bot = bots[s.players[s.current].bot!]
    s = stepBot(s, bot, () => rng.next())
  }
  played++
  if (s.winner === null) {
    stalled++
    continue // a capped game labels nobody
  }
  for (const snap of snaps) {
    const id = snapCounter++
    for (const r of snap.rows) rows.push({ x: r.x, y: r.p === s.winner ? 1 : 0, game: g, snap: id })
  }
}

console.log(`${played} games (${stalled} stalled and unlabelled), ${rows.length} position rows`)

// ── fit: least squares with a ridge hair, split by game ───────
const dim = FEATURES.length + 1 // + intercept
const isTest = (r: Row) => r.game % 5 === 0 // every fifth game held out
const train = rows.filter((r) => !isTest(r))
const test = rows.filter(isTest)

function solve(data: Row[]): number[] {
  const A = Array.from({ length: dim }, () => new Float64Array(dim))
  const b = new Float64Array(dim)
  for (const r of data) {
    const x = [...r.x, 1]
    for (let i = 0; i < dim; i++) {
      b[i] += x[i] * r.y
      for (let j = 0; j < dim; j++) A[i][j] += x[i] * x[j]
    }
  }
  for (let i = 0; i < dim; i++) A[i][i] += 1e-6 * Math.max(1, A[i][i])
  // Gaussian elimination — six unknowns does not need a library
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < dim; col++) {
    let pivot = col
    for (let r = col + 1; r < dim; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r
    ;[M[col], M[pivot]] = [M[pivot], M[col]]
    for (let r = 0; r < dim; r++) {
      if (r === col || M[r][col] === 0) continue
      const f = M[r][col] / M[col][col]
      for (let c = col; c <= dim; c++) M[r][c] -= f * M[col][c]
    }
  }
  return Array.from({ length: dim }, (_, i) => M[i][dim] / M[i][i])
}

const w = solve(train)

// ── the adjudication ──────────────────────────────────────────
console.log('\nfitted coefficients (win probability per unit):')
FEATURES.forEach((f, i) => console.log(`  ${f.padEnd(14)} ${w[i] >= 0 ? '+' : ''}${w[i].toFixed(5)}`))
console.log(`  intercept      ${w[dim - 1] >= 0 ? '+' : ''}${w[dim - 1].toFixed(5)}`)

const hv = w[2]
if (Math.abs(hv) > 1e-9) {
  console.log('\nrescaled so handValue = 1, next to the hand calibration:')
  const hand: Record<string, number> = {
    smoothIncome: INCOME_HORIZON,
    armies: ARMY_WEIGHT,
    handValue: 1,
    exposure: -EXPOSURE_WEIGHT,
    territories: 0,
    concentration: 0,
  }
  FEATURES.forEach((f, i) =>
    console.log(`  ${f.padEnd(14)} fitted ${(w[i] / hv).toFixed(2).padStart(7)}   hand-picked ${hand[f]}`),
  )
}

/**
 * The check that matters for play: on held-out games, which scoring ranks the
 * eventual winner first? `assess` is used as a comparator between players, so
 * rank accuracy is its fitness measured the way it is actually used.
 */
function rankAccuracy(score: (x: number[]) => number): number {
  const byPosition = new Map<number, Array<{ v: number; y: number }>>()
  for (const r of test) {
    if (!byPosition.has(r.snap)) byPosition.set(r.snap, [])
    byPosition.get(r.snap)!.push({ v: score(r.x), y: r.y })
  }
  let right = 0
  let total = 0
  for (const grp of byPosition.values()) {
    if (grp.length < 2 || !grp.some((g) => g.y === 1)) continue
    total++
    const top = grp.reduce((a, b) => (b.v > a.v ? b : a))
    if (top.y === 1) right++
  }
  return total ? right / total : 0
}

const fitted = (x: number[]) => x.reduce((n, v, i) => n + v * w[i], w[dim - 1])
const handPicked = (x: number[]) => x[0] * INCOME_HORIZON + x[1] * ARMY_WEIGHT + x[2] - x[3] * EXPOSURE_WEIGHT

console.log(`\nheld-out winner-ranked-first: fitted ${(rankAccuracy(fitted) * 100).toFixed(1)}%  hand-picked ${(rankAccuracy(handPicked) * 100).toFixed(1)}%`)

writeFileSync(
  WEIGHTS_PATH,
  JSON.stringify(
    {
      features: FEATURES,
      weights: Object.fromEntries(FEATURES.map((f, i) => [f, w[i]])),
      intercept: w[dim - 1],
      games: GAMES,
      rows: rows.length,
      seed: BASE_SEED,
    },
    null,
    2,
  ) + '\n',
)
console.log(`\nweights written to data/eval-weights.json`)
