/**
 * Head-to-head bot benchmark.
 *
 *   npm run bench                        -- round-robin over every registered bot
 *   npm run bench -- easy random         -- one pairing
 *   npm run bench -- easy random 500     -- ...over 500 seeds
 *   npm run bench -- --players 4         -- 4-seat games instead of 2
 *   npm run bench -- --jobs 1            -- one thread, for profiling
 *
 * Two things make the output trustworthy:
 *
 *   Paired seeds — every seed is played by both seat arrangements, so map luck
 *   cancels out instead of adding variance.
 *
 *   Seat rotation — Risk has a real turn-order advantage. Each pairing is played
 *   in every seat order, and the turn-order edge is reported separately. A bot
 *   that only wins from seat one is not a stronger bot.
 *
 * Win rates carry Wilson intervals; anything inside the interval is noise.
 */
import { ALL_BOTS, BOT_BY_KEY, LADDER } from '../src/bots'
import type { Job } from './match'
import { defaultWorkers, playGames } from './parallel'

const TURN_CAP = 600
const Z = 1.96 // 95%

/** Wilson score interval — honest at small n, unlike the normal approximation. */
function wilson(wins: number, n: number): { p: number; half: number } {
  if (!n) return { p: 0, half: 0 }
  const p = wins / n
  const d = 1 + (Z * Z) / n
  const centre = (p + (Z * Z) / (2 * n)) / d
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d
  return { p: centre, half }
}

/** Every rotation of the seat order, so each bot plays each position equally. */
function rotations<T>(xs: T[]): T[][] {
  return xs.map((_, i) => [...xs.slice(i), ...xs.slice(0, i)])
}

interface Tally {
  wins: Record<string, number>
  /** wins, and games played, broken down by the seat index the bot occupied */
  bySeat: Record<string, number[]>
  playedSeat: Record<string, number[]>
  capped: number
  turns: number
  games: number
  labels: string[]
  botOf: Record<string, string>
}

/**
 * Contenders get distinct labels even when they're the same bot, so self-play
 * (the sanity check that should land at 50/50) tallies correctly instead of
 * collapsing both sides into one bucket.
 */
function label(bots: string[]): { labels: string[]; botOf: Record<string, string> } {
  const seen: Record<string, number> = {}
  const botOf: Record<string, string> = {}
  const labels = bots.map((b) => {
    seen[b] = (seen[b] ?? 0) + 1
    const dup = bots.filter((x) => x === b).length > 1
    const l = dup ? `${b}#${seen[b]}` : b
    botOf[l] = b
    return l
  })
  return { labels, botOf }
}

async function runPairing(
  bots: string[],
  seeds: number,
  seatCount: number,
  workers: number,
): Promise<{ tally: Tally; fallbacks: Record<string, number> }> {
  const { labels, botOf } = label(bots)
  // fill the table up to seatCount by cycling the contenders
  const seats = Array.from({ length: seatCount }, (_, i) => labels[i % labels.length])
  const orders = rotations(seats)

  const t: Tally = {
    wins: Object.fromEntries(labels.map((b) => [b, 0])),
    bySeat: Object.fromEntries(labels.map((b) => [b, Array(seatCount).fill(0)])),
    playedSeat: Object.fromEntries(labels.map((b) => [b, Array(seatCount).fill(0)])),
    capped: 0,
    turns: 0,
    games: 0,
    labels,
    botOf,
  }

  // Jobs are built up front and played in any order; the tally below walks them
  // back in the order they were created, so the numbers don't depend on timing.
  const jobs: Job[] = []
  const played: string[][] = []
  for (let i = 0; i < seeds; i++) {
    const seed = i * 2654435761 + 1013904223
    for (const order of orders) {
      jobs.push({ order: order.map((l) => botOf[l]), seed, turnCap: TURN_CAP })
      played.push(order)
    }
  }

  const { outcomes, fallbacks } = await playGames(jobs, workers)
  outcomes.forEach(({ winner, turns }, i) => {
    const order = played[i]
    order.forEach((bot, seat) => t.playedSeat[bot][seat]++)
    t.games++
    t.turns += turns
    if (winner === null) t.capped++
    else {
      const key = order[winner]
      t.wins[key]++
      t.bySeat[key][winner]++
    }
  })
  return { tally: t, fallbacks }
}

function report(_bots: string[], t: Tally, seatCount: number) {
  const decided = t.games - t.capped
  const bots = t.labels
  console.log(
    `\n${bots.join('  vs  ')} — ${t.games} games ` +
      `(${t.games / rotations(Array(seatCount)).length} seeds × ${seatCount} seat orders)\n`,
  )
  const ranked = [...bots].sort((a, b) => t.wins[b] - t.wins[a])
  for (const b of ranked) {
    const { p, half } = wilson(t.wins[b], decided)
    console.log(
      `  ${b.padEnd(12)} ${String(t.wins[b]).padStart(5)} wins   ` +
        `${(p * 100).toFixed(1).padStart(5)}%  ±${(half * 100).toFixed(1)}`,
    )
  }

  // turn-order edge: how much better the best bot does from the front seat
  const top = ranked[0]
  const perSeat = t.bySeat[top].map((w, seat) => {
    const played = t.playedSeat[top][seat]
    return played ? (w / played) * 100 : 0
  })
  console.log(
    `\n  ${top} by seat: ` + perSeat.map((v, i) => `#${i + 1} ${v.toFixed(0)}%`).join('  '),
  )
  const edge = Math.max(...perSeat) - Math.min(...perSeat)
  console.log(`  turn-order spread: ${edge.toFixed(0)} points`)
  console.log(`  avg game: ${(t.turns / t.games).toFixed(1)} turns`)
  if (t.capped) console.log(`  hit the ${TURN_CAP}-turn cap: ${t.capped}/${t.games}`)
}

// ── entry point ───────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name: string, fallback: number) => {
  const i = argv.indexOf(name)
  return i >= 0 ? Number(argv[i + 1]) : fallback
}
const seatCount = flag('--players', 2)
const workers = flag('--jobs', defaultWorkers())
const flagValues = new Set(['--players', '--jobs'].map((f) => argv.indexOf(f) + 1).filter((i) => i > 0))
const positional = argv.filter((a, i) => !a.startsWith('--') && !flagValues.has(i))

const names = positional.filter((a) => Number.isNaN(Number(a)))
const seeds = Number(positional.find((a) => !Number.isNaN(Number(a)))) || 200

for (const n of names) {
  if (!BOT_BY_KEY[n]) {
    console.error(`unknown bot "${n}" — registered: ${ALL_BOTS.map((b) => b.key).join(', ')}`)
    process.exit(1)
  }
}

const started = Date.now()
const bad: Record<string, number> = {}
const collect = (f: Record<string, number>) => {
  for (const [k, n] of Object.entries(f)) bad[k] = (bad[k] ?? 0) + n
}

if (names.length >= 2) {
  const seats = Math.max(seatCount, names.length)
  const { tally, fallbacks } = await runPairing(names, seeds, seats, workers)
  collect(fallbacks)
  report(names, tally, seats)
} else {
  // round-robin the ladder, pairwise. Not the opponent pool: those exist to be
  // beaten by a tier, and ranking them against each other measures nothing.
  const keys = LADDER.map((b) => b.key)
  if (keys.length < 2) {
    console.error('need at least two registered bots to benchmark')
    process.exit(1)
  }
  console.log(`round-robin: ${keys.join(', ')} — ${seeds} seeds per pairing`)
  const table: Record<string, Record<string, string>> = {}
  for (const a of keys) table[a] = {}
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) {
      const pair = [keys[i], keys[j]]
      const { tally, fallbacks } = await runPairing(pair, seeds, 2, workers)
      collect(fallbacks)
      report(pair, tally, 2)
      const decided = tally.games - tally.capped
      table[keys[i]][keys[j]] = `${((tally.wins[keys[i]] / decided) * 100).toFixed(0)}%`
      table[keys[j]][keys[i]] = `${((tally.wins[keys[j]] / decided) * 100).toFixed(0)}%`
    }

  console.log('\n\nwin rate, row vs column\n')
  const w = Math.max(...keys.map((k) => k.length)) + 2
  console.log(' '.repeat(w) + keys.map((k) => k.padStart(w)).join(''))
  for (const a of keys)
    console.log(a.padEnd(w) + keys.map((b) => (a === b ? '—' : table[a][b] ?? '').padStart(w)).join(''))
}

const illegal = Object.entries(bad).filter(([, n]) => n > 0)
if (illegal.length) {
  console.log('\nILLEGAL MOVES (bot fell back to random — results are not trustworthy):')
  for (const [k, n] of illegal) console.log(`  ${k}: ${n}`)
}
console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`)
