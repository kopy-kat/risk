/**
 * Is the reviewer's judgement worth anything?
 *
 *   npm run review-check            -- 40 games per tier
 *   npm run review-check -- 120     -- more of them
 *
 * The reviewer tells a player which of their moves were bad. There's no ground
 * truth for that, so it can't be tested directly — but there *is* a known ladder
 * to check it against. `npm run bench` establishes that Marshal beats General
 * beats Colonel beats easy beats random. If the evaluator measures skill, then
 * pointed at each tier's own moves it must not *contradict* that ladder: no
 * weaker tier may give up significantly fewer armies per decision than a stronger
 * one.
 *
 * If it does, the reviewer is measuring something else, and no amount of
 * plausible-sounding advice on top of it would be worth shipping.
 *
 * Note the claim is "doesn't contradict", not "resolves". At twenty games all five
 * tiers come out in the right order, but the gaps between the strong ones sit inside
 * twice their standard error, and that is the honest result rather than a failure:
 * Marshal's edge is elimination hunting and table reading — strategy that pays off
 * over turns — while this measures the quality of single decisions.
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
  /** mean loss per game, indexed by seed */
  perGame: number[]
  /** whether that seed's game was won inside the turn cap */
  finished: boolean[]
  stalled: number
  mean: number
  p50: number
  p90: number
  p99: number
  luck: number
  attacks: number
  grades: Record<Grade, number>
}> = []

const seedFor = (g: number) => g * 104729 + 7

for (const tier of TIERS) {
  if (!ALL_BOTS.some((b) => b.key === tier)) continue
  const losses: number[] = []
  /** mean loss per game, so games can be compared seed by seed below */
  const perGame: number[] = []
  /** whether that seed's game was actually won, for the second reading below */
  const finished: boolean[] = []
  const grades = Object.fromEntries(GRADES.map((g) => [g, 0])) as Record<Grade, number>
  let luck = 0
  let attacks = 0
  let stalled = 0
  for (let g = 0; g < GAMES; g++) {
    const record = play(tier, seedFor(g))
    if (!record.finished) stalled++
    // Seat 0 only. Reviewing every seat would quadruple the work for the same
    // answer, since all four play the same tier.
    const review = reviewGame(record, { players: [0] })
    if (review.error) throw new Error(`${tier} game ${g}: ${review.error}`)
    let sum = 0
    for (const j of review.judgements) {
      losses.push(j.loss)
      sum += j.loss
      grades[j.grade]++
      if (j.luck !== null) {
        luck += j.luck
        attacks++
      }
    }
    perGame.push(review.judgements.length ? sum / review.judgements.length : 0)
    finished.push(record.finished)
  }
  losses.sort((a, b) => a - b)
  const mean = losses.reduce((n, x) => n + x, 0) / Math.max(1, losses.length)
  rows.push({
    tier,
    n: losses.length,
    perGame,
    finished,
    stalled,
    mean,
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
      `p90 ${r.p90.toFixed(2)}   p99 ${r.p99.toFixed(2)}   luck/attack ${r.luck.toFixed(3)}` +
      (r.stalled ? `   stalled ${r.stalled}/${GAMES}` : ''),
  )
}

// ── games nobody won ───────────────────────────────────────────────
// On its own line, because it is a fact about the *tier* rather than about the
// reviewer, and reading it as the latter costs an afternoon. `random` stalls in
// every game and always has — that is what random play is, and it is why stalled
// games are reported rather than dropped. What matters is a tier that starts
// stalling when it didn't before.
const stalling = rows.filter((r) => r.stalled)
if (stalling.length) {
  console.log(
    `\nstalled past ${TURN_CAP} turns: ` +
      `${stalling.map((r) => `${r.tier} ${r.stalled}/${GAMES}`).join(', ')}\n` +
      `  A tier that can't finish at ${SEATS} seats is a bot problem, not a reviewing one — ` +
      `check\n  \`npm run bench -- <tier> <tier> --players ${SEATS}\`. Its decisions are still ` +
      `counted below,\n  alongside a second reading over the seeds both tiers won.`,
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
// Loss per decision must not *contradict* the benchmark's ladder: no weaker tier
// may come out significantly better than a stronger one. This is the evaluator
// agreeing with `npm run bench` about which bots are better, measured a completely
// different way — per decision rather than by win rate.
//
// Compared **paired by seed**, for the reason `bench.ts` already pairs: every tier
// plays the same seed set, so differencing within a seed cancels map luck instead
// of adding it. It also fixes a subtler error — decisions are not independent
// samples. A bad position produces a whole run of bad decisions, so treating four
// thousand clustered decisions as four thousand observations understates the error
// badly enough to flip this check between sample sizes. The unit of independence
// is the game, so that is what gets averaged and differenced.
//
/** Paired difference over the seeds `keep` allows. Positive means the weaker tier won. */
function pairedDiff(a: number[], b: number[], keep: (g: number) => boolean) {
  const diffs = a.map((x, g) => (keep(g) ? x - b[g] : null)).filter((d): d is number => d !== null)
  const mean = diffs.length ? diffs.reduce((n, x) => n + x, 0) / diffs.length : 0
  const variance =
    diffs.length > 1 ? diffs.reduce((n, x) => n + (x - mean) ** 2, 0) / (diffs.length - 1) : 0
  return { n: diffs.length, mean, se: diffs.length ? Math.sqrt(variance / diffs.length) : 0 }
}

const show = (d: { mean: number; se: number }) =>
  `${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(2)} ± ${(2 * d.se).toFixed(2)}`

console.log('\nordering (mean armies given up per decision, weakest last):')
let ok = true
for (let i = 1; i < rows.length; i++) {
  const prev = rows[i - 1]
  const cur = rows[i]
  const all = pairedDiff(prev.perGame, cur.perGame, () => true)
  const inverted = all.mean > 2 * all.se
  if (inverted) ok = false
  const rel = inverted ? '≫ (!)' : all.mean < 0 ? '<' : '≈'
  console.log(
    `  ${prev.tier.padEnd(8)} ${prev.mean.toFixed(2)} ${rel} ${cur.tier.padEnd(8)} ${cur.mean.toFixed(2)}` +
      `   (paired diff ${show(all)})`,
  )
  // Second reading, over the seeds both tiers actually won.
  //
  // A stalled game is a sprawl nobody can hold and it scores badly from end to end,
  // so a pair where one tier stalls more is partly a comparison of stall rates. When
  // the two readings disagree, the disagreement *is* the answer: the ordering above
  // is about the bots' ability to finish, not about the reviewer. Left out below five
  // seeds, where the error bar stops meaning anything.
  if (prev.stalled || cur.stalled) {
    const won = pairedDiff(prev.perGame, cur.perGame, (g) => prev.finished[g] && cur.finished[g])
    console.log(
      won.n >= 5
        ? `      of which both won: ${show(won)} over ${won.n} seeds` +
          (inverted && won.mean <= 2 * won.se ? '  — the inversion is the stalls' : '')
        : `      only ${won.n} seeds were won by both — nothing to compare`,
    )
  }
}
console.log(
  ok
    ? '\n✓ nothing contradicts the benchmark ladder (≈ means tied within error)'
    : '\n✗ a weaker tier scores significantly better — this is not measuring skill',
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
