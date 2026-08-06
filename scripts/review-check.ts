/**
 * Is the reviewer's judgement worth anything?
 *
 *   npm run review-check            -- 40 games per tier
 *   npm run review-check -- 120     -- more of them
 *
 * The reviewer tells a player which of their moves were bad. There's no ground
 * truth for that, so it can't be tested directly — but there *is* a known
 * ordering to check it against. `npm run bench` establishes that Marshal beats
 * General beats Colonel beats easy beats random, by clear margins. If the
 * evaluator is measuring skill, it must reproduce that ordering when pointed at
 * each tier's own moves: stronger bots should give up fewer armies per decision.
 *
 * If it doesn't, the reviewer is measuring something else, and no amount of
 * plausible-sounding advice on top of it would be worth shipping.
 *
 * It also prints the loss distribution, which is where the grade thresholds in
 * `src/review/review.ts` come from — percentiles of real play rather than round
 * numbers picked by eye.
 */
import { ALL_BOTS, BOT_BY_KEY } from '../src/bots'
import { stepBot } from '../src/bots/play'
import { createGame } from '../src/engine/game'
import { RULES_VERSION } from '../src/engine/game'
import { rngFrom } from '../src/engine/rng'
import { GRADE_CUTS, reviewGame } from '../src/review/review'
import type { Grade } from '../src/review/review'
import type { GameRecord } from '../src/review/store'

const GAMES = Number(process.argv[2] ?? 40)
const TURN_CAP = 300
const TIERS = ['marshal', 'general', 'colonel', 'easy', 'random']
const SEATS = 4

/** Play one all-`tier` game and package it exactly as the app would store it. */
function play(tier: string, seed: number): GameRecord {
  const seats = Array.from({ length: SEATS }, (_, i) => ({ name: `P${i}`, bot: tier }))
  const rng = rngFrom((seed ^ 0x9e3779b9) >>> 0)
  let s = createGame({ seats, seed })
  while (s.phase !== 'gameOver' && s.turn < TURN_CAP) {
    s = stepBot(s, BOT_BY_KEY[s.players[s.current].bot!], () => rng.next())
  }
  return {
    id: `${tier}-${seed}`,
    schema: 1,
    rules: RULES_VERSION,
    seed,
    botSeed: seed ^ 0x9e3779b9,
    seats,
    moves: s.moves,
    assisted: [],
    winner: s.winner,
    turns: s.turn,
    finished: s.phase === 'gameOver',
    savedAt: 0,
  }
}

const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0

const GRADES: Grade[] = GRADE_CUTS.map((g) => g.grade)

const started = Date.now()
const rows: Array<{
  tier: string
  n: number
  mean: number
  p50: number
  p90: number
  p99: number
  luck: number
  attacks: number
  grades: Record<Grade, number>
}> = []

for (const tier of TIERS) {
  if (!ALL_BOTS.some((b) => b.key === tier)) continue
  const losses: number[] = []
  const grades = Object.fromEntries(GRADES.map((g) => [g, 0])) as Record<Grade, number>
  let luck = 0
  let attacks = 0
  for (let g = 0; g < GAMES; g++) {
    const record = play(tier, g * 104729 + 7)
    // Seat 0 only. Reviewing every seat would quadruple the work for the same
    // answer, since all four play the same tier.
    const review = reviewGame(record, { players: [0] })
    if (review.error) throw new Error(`${tier} game ${g}: ${review.error}`)
    for (const j of review.judgements) {
      losses.push(j.loss)
      grades[j.grade]++
      if (j.luck !== null) {
        luck += j.luck
        attacks++
      }
    }
  }
  losses.sort((a, b) => a - b)
  rows.push({
    tier,
    n: losses.length,
    mean: losses.reduce((n, x) => n + x, 0) / Math.max(1, losses.length),
    p50: quantile(losses, 0.5),
    p90: quantile(losses, 0.9),
    p99: quantile(losses, 0.99),
    // per *attack*, not per game: random's games run ten times longer than
    // Marshal's, so a per-game figure would compare their game lengths
    luck: luck / Math.max(1, attacks),
    attacks,
    grades,
  })
  const r = rows[rows.length - 1]
  console.log(
    `${tier.padEnd(9)} ${String(r.n).padStart(6)} decisions   ` +
      `mean ${r.mean.toFixed(2)}   p50 ${r.p50.toFixed(2)}   ` +
      `p90 ${r.p90.toFixed(2)}   p99 ${r.p99.toFixed(2)}   luck/attack ${r.luck.toFixed(3)}`,
  )
}

// ── where the grade thresholds come from ───────────────────────────
// The bands should separate the tiers: a stronger bot spends more of its moves
// in the top band and almost none in the bottom one. If two tiers have the same
// histogram the thresholds aren't discriminating, whatever the means say.
console.log(`\ngrade distribution (% of decisions), cuts at ${GRADE_CUTS.map((g) => g.upTo).slice(0, -1).join(' / ')}:`)
console.log(`${''.padEnd(9)}${GRADES.map((g) => g.padStart(12)).join('')}`)
for (const r of rows) {
  console.log(
    r.tier.padEnd(9) +
      GRADES.map((g) => `${((r.grades[g] / r.n) * 100).toFixed(1)}%`.padStart(12)).join(''),
  )
}

console.log(`\n${GAMES} games per tier, ${SEATS} seats, in ${((Date.now() - started) / 1000).toFixed(1)}s`)

// ── the check that actually matters ────────────────────────────────
// Mean loss must rise monotonically as the tiers get weaker. This is the
// evaluator agreeing with the benchmark about which bots are better, measured a
// completely different way — per-decision rather than by win rate.
console.log('\nordering (mean armies given up per decision, weakest last):')
let ok = true
for (let i = 1; i < rows.length; i++) {
  const prev = rows[i - 1]
  const cur = rows[i]
  const good = cur.mean >= prev.mean
  if (!good) ok = false
  console.log(
    `  ${prev.tier} ${prev.mean.toFixed(2)} ${good ? '<' : '≥ (!)'} ${cur.tier} ${cur.mean.toFixed(2)}`,
  )
}
console.log(
  ok
    ? '\n✓ the reviewer ranks the tiers the same way the benchmark does'
    : '\n✗ the reviewer disagrees with the benchmark — it is not measuring skill',
)
if (!ok) process.exitCode = 1

// Luck must average to roughly nothing per attack. It's the difference between
// what the combat model predicted and what the dice did, so a persistent bias
// would mean the two disagree — and would reach the user as "the dice hate me",
// in every game, forever.
const meanLuck = rows.reduce((n, r) => n + r.luck * r.attacks, 0) / rows.reduce((n, r) => n + r.attacks, 0)
console.log(`\nmean luck per attack, pooled: ${meanLuck.toFixed(3)} armies (want ≈ 0)`)
if (Math.abs(meanLuck) > 0.25) {
  console.log('✗ expectation and outcome disagree — the luck split is biased')
  process.exitCode = 1
}
