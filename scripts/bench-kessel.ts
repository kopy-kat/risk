/**
 * Head-to-head doctrine benchmark for Kessel.
 *
 *   npm run bench:kessel                          all pairs, 120 games each
 *   npm run bench:kessel -- maneuver attrition 400
 *   npm run bench:kessel -- maneuver maneuver 200   one doctrine against itself
 *
 * Paired seeds with the seats swapped, because moving first is worth something
 * and an unrotated comparison measures position rather than doctrine. Win rates
 * carry Wilson intervals: an interval that spans 50% is a coin flip however
 * lopsided the raw score looks, which at a hundred games it very often is.
 *
 * The swap also hides the map. Seat 0 is always the West, so every pairing prints
 * the same games a second time split by side. Against itself a doctrine has
 * nothing to be better than, and that line is the whole result: how far the map
 * favours one end of Europe.
 */
import { KESSEL_BOTS } from '../src/games/kessel/bot'
import { wilson } from './stats'
import type { Job } from './match'
import { playGames } from './parallel'

const TURN_CAP = 600

const keys = KESSEL_BOTS.map((b) => b.key.replace('kessel-', ''))
const args = process.argv.slice(2)
const games = Number(args.at(-1)) > 0 ? Number(args.pop()) : 120
const named = args.filter((a) => keys.includes(a))

const pairs: [string, string][] = []
if (named.length === 2) pairs.push([named[0], named[1]])
else for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) pairs.push([keys[i], keys[j]])

const jobs: Job[] = []
for (const [a, b] of pairs) {
  for (let s = 0; s < games; s++) {
    // Odd seeds swap the seats, so the same board is played from both sides.
    const order = s % 2 === 1 ? [b, a] : [a, b]
    jobs.push({ game: 'kessel', order: order.map((k) => `kessel-${k}`), seed: s + 1, turnCap: TURN_CAP })
  }
}

const t0 = Date.now()
const { outcomes, fallbacks } = await playGames(jobs)
const secs = (Date.now() - t0) / 1000

console.log(`\n${jobs.length} games in ${secs.toFixed(1)}s\n`)

const spans = ({ p, half }: { p: number; half: number }) => p - half <= 0.5 && p + half >= 0.5
const pct = ({ p, half }: { p: number; half: number }) => `${(p * 100).toFixed(1)}% ±${(half * 100).toFixed(1)}`

let at = 0
for (const [a, b] of pairs) {
  let winsA = 0
  let west = 0
  let decided = 0
  let capped = 0
  const turns: number[] = []
  for (let s = 0; s < games; s++, at++) {
    const o = outcomes[at]
    if (!o) continue
    turns.push(o.turns)
    if (o.turns >= TURN_CAP) capped++
    if (o.winner === null) continue
    decided++
    if (o.winner === 0) west++
    // Seat 0 is `a` on even seeds and `b` on odd ones.
    if (o.winner === (s % 2 === 1 ? 1 : 0)) winsA++
  }
  turns.sort((x, y) => x - y)
  const doctrine = wilson(winsA, decided)
  const side = wilson(west, decided)
  console.log(
    `${a.padEnd(11)} ${String(winsA).padStart(4)} — ${String(decided - winsA).padEnd(4)} ${b.padEnd(11)}` +
      `  ${pct(doctrine)}${spans(doctrine) ? '  (spans 50% — a coin flip)' : ''}` +
      `  median ${turns[Math.floor(turns.length / 2)]} turns` +
      (capped ? `  ${capped} hit the cap` : ''),
  )
  console.log(
    `${'West'.padEnd(11)} ${String(west).padStart(4)} — ${String(decided - west).padEnd(4)} ${'East'.padEnd(11)}` +
      `  ${pct(side)}${spans(side) ? '' : '  (the map favours one side)'}`,
  )
}

const noise = Object.entries(fallbacks).filter(([, n]) => n > 0)
if (noise.length) console.log(`\nillegal moves: ${noise.map(([k, n]) => `${k} ${n}`).join(', ')}`)
