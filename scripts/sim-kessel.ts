/**
 * Soak test: bot-vs-bot Kessel games, invariants checked after every move.
 *
 *   npm run sim:kessel -- 200
 *
 * The assertions in `test-kessel.ts` pin rules that were written down. This exists
 * for the states nobody thought to write down — a formation standing on ground its
 * owner does not hold, a stack past what the terrain will take, a war that ends
 * without a winner or carries on after one.
 */
import { kessel } from '../src/games/kessel'
import { REPLACEMENT_TURNS } from '../src/games/kessel/game'
import { STACK_LIMIT, mapOf } from '../src/games/kessel/map'
import type { KesselState, Move } from '../src/games/kessel/types'
import { rngFrom } from '../src/engine/rng'

const GAMES = Number(process.argv[2] ?? 100)
const STEP_CAP = 400_000

const violations: string[] = []
const seen = new Set<string>()

function check(s: KesselState, where: string) {
  const m = mapOf(s.mapId)
  const fail = (what: string) => {
    const key = `${what} @ ${where}`
    if (seen.has(key)) return
    seen.add(key)
    violations.push(key)
  }

  for (const p of m.ids) {
    if (s.owner[p] !== 0 && s.owner[p] !== 1) fail(`province ${p} owned by nobody`)
  }

  const stacked: Record<string, number> = {}
  for (const f of s.formations) {
    stacked[f.at] = (stacked[f.at] ?? 0) + 1
    if (s.owner[f.at] !== f.owner) fail('a formation stands on ground its owner does not hold')
    if (f.strength < 1 || f.strength > 4) fail(`strength out of range (${f.strength})`)
    if (f.cohesion < 0 || f.cohesion > 100) fail(`cohesion out of range (${f.cohesion})`)
    if (f.wear < 0 || f.wear >= 100) fail(`wear out of range (${f.wear})`)
    if (f.supply < 0 || f.supply > 3) fail(`supply out of range (${f.supply})`)
    if (f.rest < 0 || f.rest >= REPLACEMENT_TURNS) fail(`rest out of range (${f.rest})`)
    if (!m.province[f.at]) fail('a formation stands on a province the map does not have')
  }
  for (const [at, n] of Object.entries(stacked)) {
    if (n > STACK_LIMIT[m.province[at].terrain]) fail(`${n} formations in ${m.province[at].terrain}`)
  }

  for (const side of s.sides) {
    if (side.will < 0 || side.will > 100) fail(`will out of range (${side.will})`)
  }

  const over = s.phase === 'gameOver'
  if (over !== kessel.view(s).over) fail('view disagrees with the phase about whether the war is over')
  if (!over && s.winner !== null) fail('a winner while the war is still on')

  if (s.phase === 'orders' && Object.keys(s.orders).length > 0) {
    for (const id of Object.keys(s.orders)) {
      const f = s.formations.find((x) => x.id === Number(id))
      if (!f) fail('an order staged against a formation that is gone')
      // A refit stands across turns, so the other side's can be on the board; nothing else of theirs can.
      else if (f.owner !== s.current && s.orders[Number(id)].type !== 'refit') fail("the other side's order on the board")
    }
  }
  for (const side of s.sides) {
    if (side.aims.length === 0) fail(`${side.name} has no war aims`)
  }
}

const bots = kessel.bots
let finished = 0
const turns: number[] = []
const wins: Record<string, number> = {}
const t0 = Date.now()

for (let g = 0; g < GAMES; g++) {
  const a = bots[g % bots.length]
  const b = bots[(g + 1 + Math.floor(g / bots.length)) % bots.length]
  const seat = [a, b]
  const rng = rngFrom(g * 7919 + 13)

  let s = kessel.create({
    seats: [{ name: a.name, bot: a.key }, { name: b.name, bot: b.key }],
    seed: g + 1,
    record: false,
  }) as KesselState
  check(s, 'start')

  let steps = 0
  while (!kessel.view(s).over && steps < STEP_CAP) {
    const v = kessel.view(s)
    let move: Move
    try {
      move = seat[v.current].decide(s as never, v.current, () => rng.next()) as Move
    } catch (e) {
      violations.push(`bot ${seat[v.current].key} threw: ${e instanceof Error ? e.message : String(e)}`)
      break
    }
    try {
      s = kessel.apply(s as never, move as never) as KesselState
    } catch (e) {
      // Enumerating is the expensive call now that a formation can be sent
      // anywhere it can reach, so it is only paid when something has gone wrong.
      const legal = kessel.legalMoves(s as never, v.current)
      violations.push(
        legal.length === 0
          ? 'the move generator ran empty while the war was on'
          : `illegal bot move: ${e instanceof Error ? e.message : String(e)}`,
      )
      break
    }
    check(s, move.type)
    steps++
  }

  const v = kessel.view(s)
  if (v.over) {
    finished++
    turns.push(v.turn)
    const who = v.winner === null ? 'stalemate' : seat[v.winner].key
    wins[who] = (wins[who] ?? 0) + 1
  } else {
    violations.push(`game ${g} hit the step cap without settling`)
  }
}

turns.sort((x, y) => x - y)
const at = (p: number) => turns[Math.floor(turns.length * p)] ?? 0
console.log(`\n${GAMES} games in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${finished} settled`)
console.log(`turns  p25 ${at(0.25)}  median ${at(0.5)}  p75 ${at(0.75)}  max ${turns[turns.length - 1] ?? 0}`)
for (const [k, n] of Object.entries(wins).sort((x, y) => y[1] - x[1])) {
  console.log(`  ${k.padEnd(18)} ${String(n).padStart(4)}  ${((n / GAMES) * 100).toFixed(1)}%`)
}

if (violations.length > 0) {
  console.log(`\n${violations.length} INVARIANT VIOLATIONS:`)
  for (const v of violations.slice(0, 20)) console.log(`  ✗ ${v}`)
  process.exit(1)
}
console.log('no invariant violations')
