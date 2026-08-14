/**
 * Is the Kessel reviewer's judgement worth anything?
 *
 *   npm run review-check:kessel            -- 16 games per pair
 *   npm run review-check:kessel -- 60      -- more of them
 *
 * Same argument as `review-check.ts`, and the same shape. There is no ground
 * truth for "that turn was a mistake", so the reviewer cannot be tested against
 * one — but `npm run bench:kessel` establishes a ladder (Maneuver beats
 * Attrition, both beat Elastic), and if loss per turn measures skill then pointed
 * at each doctrine's own orders it has to agree: the stronger doctrine in a
 * pairing must give up *less* per turn than the weaker one it is playing.
 *
 * That is a stronger claim than Risk's check makes. A Risk decision is one move
 * out of a hundred and thirty and the tiers differ over whole turns, so there the
 * claim is only that the ordering is not contradicted. A Kessel decision *is* a
 * whole turn — the same grain the doctrines differ at — so here the headline pair
 * has to resolve, and if it does not the evaluation in
 * `src/games/kessel/evaluate.ts` is wrong. The honest response to that is to say
 * so, not to tune until the number comes out right.
 *
 * Compared **paired by seed**, for the reason `bench-kessel.ts` pairs: both
 * doctrines fight the same board with the seats swapped on odd seeds, so
 * differencing within a seed cancels the map and the deal instead of adding them.
 * The unit of independence is the game, not the turn — a bad position produces a
 * run of bad turns — so per-game means are what get differenced.
 *
 * It also prints the loss distribution, which is where the grade bands in
 * `src/review/kessel/review.ts` come from: percentiles of real play rather than
 * round numbers picked by eye.
 */
import { KESSEL_GRADE_CUTS } from '../src/review/kessel/review'
import type { Grade } from '../src/review/review'
import { RECKLESS, runAll } from './kessel-review-job'
import type { ReviewJob, ReviewResult } from './kessel-review-job'

const GAMES = Number(process.argv[2] ?? 16)
const TURN_CAP = 300

/**
 * The pairings, headline first.
 *
 * The headline sets the strongest doctrine against a commander who fights hard
 * and badly — assaults at odds that cannot pay, never refits, outruns its own
 * supply. That is the pair the claim is made about, and it is the right one:
 * every doctrine in the ladder is *competent*, and what separates them is
 * strategic and takes a war to show, while what a reviewer exists to catch is a
 * player making mistakes inside a turn. The win rate is printed beside the loss
 * from the same games, so the ladder the check is measured against is not taken
 * on trust either.
 *
 * The three doctrine pairs follow as diagnostics. They are reported in full and
 * not asserted, for a reason worth stating in advance rather than after the
 * numbers: loss is the gap to the best *available* alternative, so it measures
 * how well a side used the options in front of it. A doctrine that keeps its
 * options closed — Elastic holds and refits and declines to advance — has less to
 * give up per turn than one manoeuvring for a decision, whatever the eventual
 * result. That is a real limit on what a per-turn measure can say, and pretending
 * otherwise by asserting those pairs would only hide it.
 */
const PAIRS: [string, string][] = [
  ['maneuver', 'reckless'],
  ['maneuver', 'elastic'],
  ['attrition', 'elastic'],
  ['maneuver', 'attrition'],
]
const HEADLINE = 0
const DOCTRINES = { reckless: RECKLESS }

const GRADES: Grade[] = KESSEL_GRADE_CUTS.map((g) => g.grade)

const jobs: ReviewJob[] = []
for (const [a, b] of PAIRS) {
  for (let g = 0; g < GAMES; g++) {
    // Odd seeds swap the seats, so the same board is fought from both sides.
    const order = g % 2 === 1 ? [b, a] : [a, b]
    jobs.push({ order, seed: g * 104729 + 7, turnCap: TURN_CAP, doctrines: DOCTRINES })
  }
}

const started = Date.now()
let ticked = 0
const results: ReviewResult[] = await runAll(jobs, (done, total) => {
  const pct = Math.floor((done / total) * 20)
  if (pct === ticked) return
  ticked = pct
  process.stderr.write(`\r  judging ${done}/${total} wars…   `)
})
process.stderr.write('\r'.padEnd(40) + '\r')

/**
 * Turns into a war after which its result is usually no longer in question.
 *
 * Grinding pairings run past two hundred turns and, on the evidence of the
 * position score, are decided inside the first forty: the boards stop changing
 * and the rest is weariness ticking down to the will floor. Averaging loss over
 * those turns measures which doctrine keeps trying things in a war it has already
 * won, which is not the question. So there are two readings, and the second is
 * the one to believe when they disagree — the same reason `review-check.ts` reads
 * its ladder a second time over the seeds both tiers won.
 */
const OPENING_TURNS = 40

interface Side {
  key: string
  /** mean loss per turn, indexed by seed */
  perGame: number[]
  /** the same, over the turns while the outcome was still open */
  perOpening: number[]
  losses: number[]
  grades: Record<Grade, number>
  faults: Record<string, { count: number; cost: number }>
  turnsJudged: number
}

const blank = (key: string): Side => ({
  key,
  perGame: [],
  perOpening: [],
  losses: [],
  grades: Object.fromEntries(GRADES.map((g) => [g, 0])) as Record<Grade, number>,
  faults: {},
  turnsJudged: 0,
})

const mean = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / Math.max(1, xs.length)
const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0

/** Paired difference in per-game means. Negative means the *stronger* side lost less. */
function pairedDiff(strong: number[], weak: number[]) {
  const diffs = strong.map((x, i) => x - weak[i])
  const m = mean(diffs)
  const variance =
    diffs.length > 1 ? diffs.reduce((n, x) => n + (x - m) ** 2, 0) / (diffs.length - 1) : 0
  return { n: diffs.length, mean: m, se: diffs.length ? Math.sqrt(variance / diffs.length) : 0 }
}

const allLosses: number[] = []
const allLucks: number[] = []
let ok = true
let at = 0

for (const [pair, [a, b]] of PAIRS.entries()) {
  const A = blank(a)
  const B = blank(b)
  const turns: number[] = []
  let winsA = 0
  let decided = 0

  for (let g = 0; g < GAMES; g++, at++) {
    const r = results[at]
    const swapped = g % 2 === 1
    turns.push(r.turns)
    if (r.winner !== null) {
      decided++
      if (r.winner === (swapped ? 1 : 0)) winsA++
    }
    for (const side of [A, B]) {
      const seat = side === A ? (swapped ? 1 : 0) : swapped ? 0 : 1
      const seen = r.seats[seat]
      side.losses.push(...seen.losses)
      side.turnsJudged += seen.losses.length
      side.perGame.push(mean(seen.losses))
      side.perOpening.push(mean(seen.losses.filter((_, k) => seen.turns[k] <= OPENING_TURNS)))
      for (const g2 of GRADES) side.grades[g2] += seen.grades[g2]
      for (const [f, v] of Object.entries(seen.faults)) {
        const acc = (side.faults[f] ??= { count: 0, cost: 0 })
        acc.count += v.count
        acc.cost += v.cost
      }
      allLosses.push(...seen.losses)
      allLucks.push(...seen.lucks)
    }
  }

  turns.sort((x, y) => x - y)
  console.log(
    `\n${a} vs ${b} — ${GAMES} games, median ${turns[Math.floor(turns.length / 2)]} turns, ` +
      `${a} won ${winsA}/${decided}`,
  )
  for (const side of [A, B]) {
    const sorted = [...side.losses].sort((x, y) => x - y)
    console.log(
      `  ${side.key.padEnd(10)} ${String(side.turnsJudged).padStart(5)} turns   ` +
        `mean ${mean(side.losses).toFixed(2)}   p50 ${quantile(sorted, 0.5).toFixed(2)}   ` +
        `p90 ${quantile(sorted, 0.9).toFixed(2)}   p99 ${quantile(sorted, 0.99).toFixed(2)}`,
    )
  }

  const verdict = (d: { mean: number; se: number }, headline: boolean) => {
    const resolved = d.mean < -2 * d.se
    const inverted = d.mean > 2 * d.se
    return {
      resolved,
      inverted,
      text:
        `${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(2)} ± ${(2 * d.se).toFixed(2)} steps/turn` +
        (resolved
          ? '   ✓ the stronger doctrine gives up less'
          : inverted
            ? '   ✗ the WEAKER doctrine gives up less'
            : headline
              ? '   ✗ nothing resolved'
              : '   ~ tied inside the error bar, which is all this pair is asked for'),
    }
  }

  const all = verdict(pairedDiff(A.perGame, B.perGame), pair === HEADLINE)
  const open = verdict(pairedDiff(A.perOpening, B.perOpening), pair === HEADLINE)
  if (pair === HEADLINE && !(all.resolved && open.resolved)) ok = false
  console.log(`  ${a} − ${b}, whole war       ${all.text}`)
  console.log(`  ${a} − ${b}, first ${OPENING_TURNS} turns   ${open.text}`)

  for (const side of [A, B]) {
    const named = Object.entries(side.faults)
      .sort((x, y) => y[1].cost - x[1].cost)
      .slice(0, 4)
      .map(([f, v]) => `${f} ${v.count}× −${v.cost.toFixed(0)}`)
    console.log(`  ${side.key.padEnd(10)} named faults: ${named.join(', ') || 'none'}`)
  }
  console.log(`  grades ${GRADES.map((g) => g.padStart(10)).join('')}`)
  for (const side of [A, B]) {
    console.log(
      `  ${side.key.padEnd(10)}` +
        GRADES.map((g) =>
          `${((side.grades[g] / Math.max(1, side.turnsJudged)) * 100).toFixed(1)}%`.padStart(10),
        ).join(''),
    )
  }
}

// ── where the grade bands come from ────────────────────────────────
const sorted = [...allLosses].sort((x, y) => x - y)
console.log(
  `\nloss distribution over ${sorted.length} turns (steps):\n  ` +
    [0.5, 0.7, 0.8, 0.9, 0.95, 0.99]
      .map((q) => `p${q * 100} ${quantile(sorted, q).toFixed(2)}`)
      .join('   '),
)
console.log(`  bands at ${KESSEL_GRADE_CUTS.map((g) => g.upTo).slice(0, -1).join(' / ')}`)

// ── luck must average to nothing, and loss must not ────────────────
// Luck is the difference between what five resolutions of a turn said and what
// the one that happened did, so a persistent bias would mean the expectation and
// the engine disagree — and would reach the player as "the jitter hates me", in
// every war, forever. Loss is a maximum over alternatives, so it is bounded below
// by zero and has no reason to average to it.
const meanLuck = mean(allLucks)
const varLuck = allLucks.reduce((n, x) => n + (x - meanLuck) ** 2, 0) / Math.max(1, allLucks.length - 1)
const seLuck = Math.sqrt(varLuck / Math.max(1, allLucks.length))
console.log(
  `\nmean luck per turn: ${meanLuck.toFixed(3)} ± ${(2 * seLuck).toFixed(3)} steps (want ≈ 0)` +
    `\nmean loss per turn: ${mean(allLosses).toFixed(3)} steps (want ≫ 0 — loss is not noise)`,
)
if (Math.abs(meanLuck) > Math.max(0.25, 2 * seLuck)) {
  console.log('✗ expectation and outcome disagree — the luck split is biased')
  ok = false
}

console.log(`\n${GAMES} games per pair, ${jobs.length} wars in ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(
  ok
    ? `\n✓ ${PAIRS[HEADLINE][0]} gives up significantly less per turn than ${PAIRS[HEADLINE][1]}, ` +
      'on both readings, in games it also wins — and luck averages to nothing'
    : '\n✗ see above — the reviewer is not separating the sides it is meant to',
)
if (!ok) process.exitCode = 1
