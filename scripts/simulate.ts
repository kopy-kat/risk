/**
 * Headless soak test for the rules engine.
 *
 *   npm run sim              -- 400 games, mixed bots
 *   npm run sim -- 2000 easy -- 2000 games where every seat is the easy bot
 *
 * Checks hard invariants after every single move, so a rules bug shows up as a
 * failing assertion with the move that caused it rather than as a weird board
 * three turns later.
 */
import { TERRITORY_IDS } from '../src/engine/board'
import { applyMove, createGame, legalMoves, territoriesOf } from '../src/engine/game'
import type { GameState } from '../src/engine/types'
import { rngFrom } from '../src/engine/rng'
import { BOTS, BOT_BY_KEY } from '../src/bots'
import { stepBot } from '../src/bots/play'

const GAMES = Number(process.argv[2] ?? 400)
const FORCE_BOT = process.argv[3]
const TURN_CAP = 800

function check(s: GameState, ctx: string) {
  let totalTroops = 0
  for (const t of TERRITORY_IDS) {
    const o = s.owner[t]
    if (o === undefined || o < 0 || o >= s.players.length) throw new Error(`${ctx}: ${t} has owner ${o}`)
    if (!Number.isInteger(s.troops[t]) || s.troops[t] < 1)
      throw new Error(`${ctx}: ${t} has ${s.troops[t]} troops`)
    totalTroops += s.troops[t]
  }
  if (totalTroops < TERRITORY_IDS.length) throw new Error(`${ctx}: only ${totalTroops} armies on the board`)

  const cardsOut = s.players.reduce((n, p) => n + p.cards.length, 0)
  const total = s.deck.length + s.discard.length + cardsOut
  if (total !== 44) throw new Error(`${ctx}: ${total} cards accounted for, expected 44`)

  for (const p of s.players) {
    const owns = territoriesOf(s, p.id).length
    if (p.alive && s.phase !== 'setup' && owns === 0) throw new Error(`${ctx}: ${p.name} alive with 0 territories`)
    if (!p.alive && owns > 0) throw new Error(`${ctx}: ${p.name} dead but owns ${owns}`)
  }

  if ((s.phase === 'gameOver') !== (s.winner !== null))
    throw new Error(`${ctx}: phase ${s.phase} vs winner ${s.winner}`)
  if (s.phase === 'occupy' && !s.pendingOccupation) throw new Error(`${ctx}: occupy phase with nothing pending`)
}

const wins = new Map<string, number>()
let totalTurns = 0
let capped = 0
const started = Date.now()

for (let g = 0; g < GAMES; g++) {
  const rng = rngFrom(g * 7919 + 13)
  const seatCount = 2 + Math.floor(rng.next() * 5) // 2–6
  const seats = Array.from({ length: seatCount }, (_, i) => ({
    name: `P${i}`,
    bot: FORCE_BOT ?? BOTS[Math.floor(rng.next() * BOTS.length)].key,
  }))

  let s = createGame({ seats, seed: g * 104729 + 7 })
  check(s, `game ${g} init`)

  let moves = 0
  while (s.phase !== 'gameOver' && s.turn < TURN_CAP) {
    const bot = BOT_BY_KEY[s.players[s.current].bot!]
    const before = s.phase
    s = stepBot(s, bot, () => rng.next())
    check(s, `game ${g} move ${moves} (${before} -> ${s.phase})`)
    if (++moves > 200_000) throw new Error(`game ${g}: move limit hit, likely a phase loop`)
  }

  if (s.phase !== 'gameOver') capped++
  else {
    const key = seats[s.winner!].bot!
    wins.set(key, (wins.get(key) ?? 0) + 1)
  }
  totalTurns += s.turn
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\n${GAMES} games in ${elapsed}s — no invariant violations`)
console.log(`avg ${(totalTurns / GAMES).toFixed(1)} turns/game, ${capped} hit the ${TURN_CAP}-turn cap\n`)

const decided = GAMES - capped
for (const [key, n] of [...wins].sort((a, b) => b[1] - a[1]))
  console.log(`  ${key.padEnd(10)} ${String(n).padStart(5)} wins  ${((n / decided) * 100).toFixed(1)}%`)

// A quick sanity check that the move generator never dead-ends.
let s2 = createGame({ seats: [{ name: 'A', bot: 'easy' }, { name: 'B', bot: 'easy' }], seed: 99 })
while (s2.phase !== 'gameOver' && s2.turn < 50) {
  if (!legalMoves(s2).length) throw new Error(`no legal moves in phase ${s2.phase}`)
  s2 = applyMove(s2, legalMoves(s2)[0])
}
console.log('\nmove generator: never empty ✓')
