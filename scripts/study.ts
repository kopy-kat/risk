/**
 * Read exported games and say what actually happened in them.
 *
 *   npm run study -- games.json            -- the shape of every game
 *   npm run study -- games.json --review   -- ...and grade every seat, bots included
 *
 * The file is what the Export button on the setup screen writes, Risk and Kessel
 * games alike. Games are stored as a seed and a move list, so replaying them here
 * reconstructs every board exactly — dice, deal and bot decisions included.
 *
 * This exists because the benchmark can only measure the bots against each
 * other, and a recorded game against a person is the only evidence available of
 * a strategy none of them plays. What to look at first in Risk: the army column.
 * A seat carrying far more armies than territories is banking — the signature
 * `sharkLikeness` reads and the strategy the card-economy work answers. In
 * Kessel: the cut-off column. Formations standing cut off turn after turn are a
 * pocket about to close, whatever the line in front of them looks like. When a
 * new export beats the bots, the loop is: name what the winner is doing, make
 * the pool's policy space express it, then fix the bots until the exploit
 * search comes back under an equal share.
 */
import { readFileSync } from 'node:fs'
import { TERRITORY_IDS } from '../src/engine/board'
import type { GameState } from '../src/engine/types'
import { mapOf } from '../src/games/kessel/map'
import { supplyStates } from '../src/games/kessel/supply'
import type { KesselState } from '../src/games/kessel/types'
import { KESSEL_FAULT_LABEL, reviewKesselGame } from '../src/review/kessel/review'
import { replay } from '../src/review/replay'
import { FAULT_LABEL, reviewGame } from '../src/review/review'
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

for (const record of games) {
  const label = record.seats.map((s, i) => `${s.name}(${s.bot ?? 'human'})${i === record.winner ? '*' : ''}`)
  console.log(`\n── ${record.id} · ${record.game ?? 'risk'} · ${record.seats.length} seats · ${record.turns} turns`)
  console.log(`   ${label.join('  ')}${record.winner === null ? '  (no winner)' : '   * won'}`)
  if (record.game === 'kessel') studyKessel(record)
  else studyRisk(record)
}

function studyRisk(record: GameRecord) {
  const r = replay(record)
  if (r.error) {
    console.log(`   ${r.error}`)
    return
  }

  const tiles = (s: GameState, p: number) => TERRITORY_IDS.filter((t) => s.owner[t] === p)
  const armies = (s: GameState, p: number) => tiles(s, p).reduce((a, t) => a + s.troops[t], 0)
  const stack = (s: GameState, p: number) => Math.max(0, ...tiles(s, p).map((t) => s.troops[t]))

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

  if (!wantReview) return

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

function studyKessel(record: GameRecord) {
  const r = replay<KesselState>(record)
  if (r.error) {
    console.log(`   ${r.error}`)
    return
  }
  const m = mapOf(r.states[0].mapId)

  /**
   * One row per sampled turn, read at the start of the West's orders: formations,
   * steps and provinces, then war aims held, will, and formations cut off. Ground
   * alone says little in a war decided by pockets — a side can hold its whole line
   * with a third of its army starving behind it.
   */
  const col = (s: string) => s.padEnd(32)
  const cell = (s: KesselState, p: number) => {
    const mine = s.formations.filter((f) => f.owner === p)
    const supply = supplyStates(m, s, p)
    const side = s.sides[p]
    return col(
      `${mine.length}/${mine.reduce((n, f) => n + f.strength, 0)}/${m.ids.filter((id) => s.owner[id] === p).length}` +
        ` ${side.aims.filter((id) => s.owner[id] === p).length}/${side.aims.length}` +
        ` ${Math.round(side.will)} ${mine.filter((f) => supply[f.id] === 0).length}`,
    )
  }
  console.log(`\n   turn   ${record.seats.map((s) => col(s.name.slice(0, 12))).join('')}`)
  console.log(`          ${record.seats.map(() => col('corps/steps/prov aims will cut')).join('')}`)
  const seen = new Set<number>()
  const rows: Array<[number, string]> = []
  for (const s of r.states) {
    if (s.phase !== 'orders' || s.current !== 0 || seen.has(s.turn)) continue
    seen.add(s.turn)
    rows.push([s.turn, record.seats.map((_, p) => cell(s, p)).join('')])
  }
  const last = r.states[r.states.length - 1]
  for (const [turn, row] of rows.filter(([t], i) => t % EVERY === 0 || i === rows.length - 1))
    console.log(`   ${String(turn).padStart(4)}   ${row}`)
  console.log(`   final  ${record.seats.map((_, p) => cell(last, p)).join('')}`)
  for (const e of last.log.filter((x) => /terms|war aims|stalemate/.test(x.text)))
    console.log(`   T${e.turn}  ${e.player === null ? '' : `${record.seats[e.player].name} `}${e.text}`)

  if (!wantReview) return

  const review = reviewKesselGame(record, { players: record.seats.map((_, i) => i) })
  console.log('')
  for (const p of review.byPlayer) {
    const who = record.seats[p.player]
    console.log(
      `   ${who.name.padEnd(9)} ${(who.bot ?? 'human').padEnd(16)} ` +
        `${p.meanLoss.toFixed(2)} steps given up per turn over ${p.decisions}` +
        `   luck ${p.luck >= 0 ? '+' : ''}${p.luck.toFixed(1)}`,
    )
    for (const h of p.habits)
      console.log(`             ${KESSEL_FAULT_LABEL[h.fault]} — ${h.count}× −${h.cost.toFixed(1)}`)
  }
}
