/**
 * Read exported games and say what actually happened in them.
 *
 *   npm run study -- games.json            -- the shape of every game
 *   npm run study -- games.json --review   -- ...and grade every seat, bots included
 *
 * The file is what the Export button on the setup screen writes. Games are
 * stored as a seed and a move list, so replaying them here reconstructs every
 * board exactly — dice, deal and bot decisions included.
 *
 * This exists because the benchmark can only measure the bots against each
 * other, and a recorded game against a person is the only evidence available of
 * a strategy none of them plays. What to look at first: the army column. A seat
 * carrying far more armies than territories is banking, and nothing in the
 * evaluation counts that as a threat.
 */
import { readFileSync } from 'node:fs'
import { TERRITORY_IDS } from '../src/engine/board'
import type { GameState } from '../src/engine/types'
import { replay } from '../src/review/replay'
import { reviewGame } from '../src/review/review'
import { FAULT_LABEL } from '../src/review/review'
import type { GameRecord } from '../src/review/store'

const argv = process.argv.slice(2)
const path = argv.find((a) => !a.startsWith('--'))
const wantReview = argv.includes('--review')
/** Turns between sampled rows; a 60-turn game at 6 prints ten lines. */
const EVERY = Number(argv[argv.indexOf('--every') + 1]) || 6

if (!path) {
  console.error('usage: npm run study -- <exported.json> [--review] [--every N]')
  process.exit(1)
}

const games: GameRecord[] = JSON.parse(readFileSync(path, 'utf8'))
console.log(`${games.length} game${games.length === 1 ? '' : 's'} from ${path}`)

const tiles = (s: GameState, p: number) => TERRITORY_IDS.filter((t) => s.owner[t] === p)
const armies = (s: GameState, p: number) => tiles(s, p).reduce((a, t) => a + s.troops[t], 0)
const stack = (s: GameState, p: number) => Math.max(0, ...tiles(s, p).map((t) => s.troops[t]))

for (const record of games) {
  const r = replay(record)
  const label = record.seats.map((s, i) => `${s.name}(${s.bot ?? 'human'})${i === record.winner ? '*' : ''}`)
  console.log(`\n── ${record.id} · ${record.seats.length} seats · ${record.turns} turns`)
  console.log(`   ${label.join('  ')}${record.winner === null ? '  (no winner)' : '   * won'}`)

  if (r.error) {
    console.log(`   ${r.error}`)
    continue
  }

  /**
   * One row per sampled turn: territories, total armies, biggest single stack.
   * The three together are the whole diagnosis — territories alone cannot tell a
   * player who is losing apart from one who is loading.
   */
  const col = (s: string) => s.padEnd(16)
  console.log(`\n   turn   ${record.seats.map((s) => col(s.name.slice(0, 12))).join('')}`)
  console.log(`          ${record.seats.map(() => col('tiles/army/max')).join('')}`)
  const seen = new Set<number>()
  const rows: Array<[number, string]> = []
  for (const s of r.states) {
    if (seen.has(s.turn)) continue
    seen.add(s.turn)
    rows.push([
      s.turn,
      record.seats.map((_, p) => col(`${tiles(s, p).length}/${armies(s, p)}/${stack(s, p)}`)).join(''),
    ])
  }
  const last = r.states[r.states.length - 1]
  for (const [turn, row] of rows.filter(([t], i) => t % EVERY === 0 || i === rows.length - 1))
    console.log(`   ${String(turn).padStart(4)}   ${row}`)
  console.log(
    `   final  ${record.seats.map((_, p) => col(`${tiles(last, p).length}/${armies(last, p)}/${stack(last, p)}`)).join('')}`,
  )

  if (!wantReview) continue

  /**
   * Grade every seat, not just the human ones. Pointing the reviewer at the bots
   * is the point: a tier that loses while giving up *fewer* armies per decision
   * than the winner is not blundering, it is being out-planned — and those two
   * findings call for completely different fixes.
   */
  const all = record.seats.map((_, i) => i)
  const review = reviewGame(record, { players: all })
  console.log('')
  for (const p of review.byPlayer) {
    const who = record.seats[p.player]
    console.log(
      `   ${who.name.padEnd(9)} ${(who.bot ?? 'human').padEnd(8)} ` +
        `${p.meanLoss.toFixed(2)} armies given up per decision over ${p.decisions}` +
        `   luck ${p.luck >= 0 ? '+' : ''}${p.luck.toFixed(0)}`,
    )
    for (const h of p.habits)
      console.log(`             ${FAULT_LABEL[h.fault]} — ${h.count}× −${h.armies.toFixed(0)}`)
  }
}
