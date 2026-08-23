/**
 * The Kessel reviewer's arithmetic, asserted.
 *
 * Two kinds of thing are checked here. The evaluation and the fault detectors are
 * pinned on a synthetic grid, for the reason `test-kessel.ts` gives: a rule that
 * only holds on one arrangement of provinces is not a rule. The properties that
 * make a review trustworthy — loss floored at zero, loss blind to the roll, luck
 * averaging to nothing, the same war judged the same way twice — are asserted on
 * real bot games on the real map, because those are properties of the whole
 * pipeline rather than of any one function.
 *
 * `npm run review-check:kessel` is the other half, and answers a different
 * question: not "is this correct" but "does it measure skill".
 */
import { rngFrom } from '../src/engine/rng'
import type { PlayerId } from '../src/engine/types'
import { kessel } from '../src/games/kessel'
import { DOCTRINES, KESSEL_BOTS } from '../src/games/kessel/bot'
import { WIN_SCORE, assess, evaluate } from '../src/games/kessel/evaluate'
import { applyMove, createGame } from '../src/games/kessel/game'
import { STACK_LIMIT, mapOf, registerMap } from '../src/games/kessel/map'
import type { MapData, Province, Terrain } from '../src/games/kessel/map'
import { stepBot } from '../src/games/kessel/play'
import { depthMap, supplyStates } from '../src/games/kessel/supply'
import type { Formation, KesselState, UnitType } from '../src/games/kessel/types'
import { doctrineOrders, perturbations, priceTurn, valueOf, seedsFor } from '../src/review/kessel/price'
import type { KesselFault, OrderSet } from '../src/review/kessel/price'
import { reviewKesselGame } from '../src/review/kessel/review'
import type { GameRecord } from '../src/review/store'

let passed = 0
const failures: string[] = []

const ok = (cond: boolean, what: string) => {
  if (cond) passed++
  else failures.push(what)
}
const eq = <T>(got: T, want: T, what: string) => {
  if (Object.is(got, want)) passed++
  else failures.push(`${what} — got ${String(got)}, wanted ${String(want)}`)
}
const near = (got: number, want: number, tol: number, what: string) => {
  if (Math.abs(got - want) <= tol) passed++
  else failures.push(`${what} — got ${got.toFixed(3)}, wanted ${want} ± ${tol}`)
}

// ─────────────────────────── the grid ───────────────────────────

const W = 7
const H = 3
const id = (x: number, y: number) => `p${x}_${y}`

function gridMap(over: Partial<Record<string, Partial<Province>>> = {}): MapData {
  const provinces: Province[] = []
  const adjacency: Record<string, string[]> = {}
  const edges: MapData['edges'] = []
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      provinces.push({
        id: id(x, y), name: id(x, y), nation: 'grid', terrain: 'plain' as Terrain,
        depot: 0, vp: 0, cx: x * 100, cy: y * 100, d: '', ...over[id(x, y)],
      })
      const near: string[] = []
      if (x > 0) near.push(id(x - 1, y))
      if (x < W - 1) near.push(id(x + 1, y))
      if (y > 0) near.push(id(x, y - 1))
      if (y < H - 1) near.push(id(x, y + 1))
      adjacency[id(x, y)] = near
      for (const n of near) if (id(x, y) < n) edges.push({ a: id(x, y), b: n, len: 60, sea: false })
    }
  }
  return { id: 'grid', name: 'Grid', viewBox: '0 0 700 300', coast: '', provinces, adjacency, edges }
}

let mapSerial = 0
const fixture = (over: Partial<Record<string, Partial<Province>>> = {}) =>
  registerMap({ ...gridMap(over), id: `revgrid${mapSerial++}` })

let formationSerial = 1000
const corps = (owner: PlayerId, at: string, patch: Partial<Formation> = {}): Formation => ({
  id: formationSerial++, owner, type: 'infantry' as UnitType, at,
  strength: 3, cohesion: 100, wear: 0, dug: 0, supply: 3, rest: 0, ...patch,
})

const homeOf = (side: PlayerId): string[] =>
  Array.from({ length: H }, (_, y) => id(side === 0 ? 0 : W - 1, y))

function stateOn(
  mapId: string,
  owner: Record<string, PlayerId>,
  formations: Formation[],
  patch: Partial<KesselState> = {},
): KesselState {
  return {
    mapId,
    sides: [0, 1].map((i) => ({
      id: i, name: `S${i}`, color: i, bot: null, alive: true, will: 100, aims: [],
      revealed: [], home: homeOf(i as PlayerId), seen: {},
    })),
    owner, formations, orders: {}, phase: 'orders', current: 0, turn: 1,
    log: [], moves: [], record: false, rngState: 12345, winner: null,
    nextFormationId: formationSerial + 1000, offered: false,
    ...patch,
  }
}

function split(): Record<string, PlayerId> {
  const owner: Record<string, PlayerId> = {}
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) owner[id(x, y)] = x < W / 2 ? 0 : 1
  return owner
}

const faultsOf = (m: ReturnType<typeof fixture>, s: KesselState, orders: OrderSet, me: PlayerId) =>
  new Set(perturbations(m, s, orders, me).map((c) => c.fault).filter(Boolean) as KesselFault[])

// ── the evaluation reads a position from one side ───────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3 } })
  const s = stateOn(m.id, split(), [corps(0, id(2, 1)), corps(1, id(4, 1))])

  near(evaluate(s, 0), -evaluate(s, 1), 1e-9, 'a position is worth to one side what it costs the other')
  eq(evaluate({ ...s, winner: 0, phase: 'gameOver' }, 0), WIN_SCORE, 'winning is worth the win score')
  eq(evaluate({ ...s, winner: 0, phase: 'gameOver' }, 1), -WIN_SCORE, 'and losing costs it')
  eq(evaluate({ ...s, winner: null, phase: 'gameOver' }, 0), 0, 'a stalemate is worth nothing to either side')
}

// ── war aims dominate everything else it weighs ─────────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3, vp: 3 } })
  const owner = split()
  const base = stateOn(m.id, owner, [corps(0, id(2, 1))])
  const withAim = {
    ...base,
    sides: base.sides.map((x) => (x.id === 0 ? { ...x, aims: [id(6, 1)] } : x)),
  }
  const held = { ...withAim, owner: { ...owner, [id(6, 1)]: 0 as PlayerId } }

  ok(
    evaluate(held, 0) - evaluate(withAim, 0) > 30,
    'taking a three-point war aim is worth more than a corps',
  )
  const extraCorps = { ...withAim, formations: [...withAim.formations, corps(0, id(2, 0))] }
  ok(
    evaluate(held, 0) > evaluate(extraCorps, 0),
    'and worth more than an extra formation — the win condition outranks the army',
  )
}

// ── supply, cohesion and a closed ring all price ────────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const all: Record<string, PlayerId> = {}
  for (const p of m.ids) all[p] = 0
  const fresh = stateOn(m.id, all, [corps(0, id(1, 1))])
  const worn = { ...fresh, formations: [{ ...fresh.formations[0], cohesion: 0 }] }
  ok(evaluate(fresh, 0) > evaluate(worn, 0), 'readiness is worth something on top of the steps')

  const supplied = supplyStates(m, fresh, 0)
  eq(supplied[fresh.formations[0].id], 3, 'the fixture formation is in supply')
  ok(
    assess(m, fresh, 0, supplied).ready > 0,
    'a formation at full supply is credited with being able to start an attack',
  )

  // A ring closed around a beaten formation, with an enemy pressing it.
  const owner = split()
  const pocket = id(4, 1)
  for (const p of [id(3, 1), id(4, 0), id(4, 2), id(5, 1)]) owner[p] = 0
  const ring = [corps(0, id(3, 1)), corps(0, id(4, 0)), corps(0, id(4, 2)), corps(0, id(5, 1))]
  const trapped = stateOn(m.id, owner, [corps(1, pocket, { cohesion: 10 }), ...ring])
  const openOwner = { ...owner, [id(5, 1)]: 1 as PlayerId }
  const loose = stateOn(m.id, openOwner, [
    corps(1, pocket, { cohesion: 10 }),
    ...ring.filter((f) => f.at !== id(5, 1)),
  ])
  ok(
    evaluate(trapped, 0) - evaluate(trapped, 1) > evaluate(loose, 0) - evaluate(loose, 1),
    'a formation with no line of retreat is worth less to its owner than one with a way out',
  )
}

// ── the fault detectors, on the grid ────────────────────────────────
{
  // An assault at even strength across open ground, with the defender free to
  // fall back: under the odds an attack has to clear to pay for itself.
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3 } })
  const owner = split()
  owner[id(3, 1)] = 0
  const attacker = corps(0, id(3, 1))
  const s = stateOn(m.id, owner, [attacker, corps(1, id(4, 1))])
  ok(
    faultsOf(m, s, { [attacker.id]: { type: 'attack', to: id(4, 1) } }, 0).has('thin-odds'),
    'an assault at even odds against a defender who can retreat is named as thin',
  )
  ok(
    !faultsOf(m, s, { [attacker.id]: { type: 'hold' } }, 0).has('thin-odds'),
    'and holding instead is not',
  )
}

{
  // Advancing to the end of the chain, where supply gives out and the formation
  // arrives unable to attack.
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const owner: Record<string, PlayerId> = {}
  for (const p of m.ids) owner[p] = 0
  const spearhead = corps(0, id(4, 1))
  const s = stateOn(m.id, owner, [spearhead])
  eq(supplyStates(m, s, 0)[spearhead.id], 3, 'it starts in full supply')
  ok(
    faultsOf(m, s, { [spearhead.id]: { type: 'move', to: id(5, 1) } }, 0).has('culmination'),
    'advancing to where the chain runs out is named as the culminating point',
  )
  ok(
    !faultsOf(m, s, { [spearhead.id]: { type: 'move', to: id(3, 1) } }, 0).has('culmination'),
    'and falling back down the chain is not',
  )
}

{
  // An enemy formation with one way out, and a corps standing next to it.
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3 } })
  const owner = split()
  // The ring is closed except for p5_1, and a corps of ours stands beside it.
  for (const p of [id(3, 1), id(4, 0), id(4, 2), id(5, 0)]) owner[p] = 0
  const closer = corps(0, id(5, 0))
  const s = stateOn(m.id, owner, [
    corps(1, id(4, 1)),
    corps(0, id(3, 1)),
    corps(0, id(4, 0)),
    corps(0, id(4, 2)),
    closer,
  ])
  ok(
    faultsOf(m, s, { [closer.id]: { type: 'hold' } }, 0).has('missed-pocket'),
    'the last way out of an enemy formation, with a corps able to stand in it, is named',
  )
  ok(
    !faultsOf(m, s, { [closer.id]: { type: 'move', to: id(5, 1) } }, 0).has('missed-pocket'),
    'and taking it is not',
  )
}

{
  // A formation of ours in contact with nowhere to fall back to.
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3 } })
  const owner = split()
  owner[id(4, 1)] = 0
  const stranded = corps(0, id(4, 1))
  const s = stateOn(m.id, owner, [
    stranded,
    corps(1, id(4, 0)),
    corps(1, id(4, 2)),
    corps(1, id(3, 1)),
  ])
  ok(
    faultsOf(m, s, { [stranded.id]: { type: 'hold' } }, 0).has('exposed'),
    'a formation in contact with no line of retreat is named, with a way out still open',
  )
}

{
  // Three separate assaults where the force could have gone in at one.
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3 } })
  const owner = split()
  for (const p of [id(3, 0), id(3, 1), id(3, 2)]) owner[p] = 0
  const sent = [corps(0, id(3, 0)), corps(0, id(3, 1)), corps(0, id(3, 2))]
  const s = stateOn(m.id, owner, [
    ...sent,
    corps(1, id(4, 0)),
    corps(1, id(4, 1)),
    corps(1, id(4, 2)),
  ])
  const orders: OrderSet = {
    [sent[0].id]: { type: 'attack', to: id(4, 0) },
    [sent[1].id]: { type: 'attack', to: id(4, 1) },
    [sent[2].id]: { type: 'attack', to: id(4, 2) },
  }
  ok(faultsOf(m, s, orders, 0).has('dispersal'), 'three assaults at once is named as dispersal')
}

// ─────────────── the properties, on real games ───────────────

const BOTS = Object.fromEntries(KESSEL_BOTS.map((b) => [b.key, b]))

function playRecord(order: string[], seed: number, cap = 300): GameRecord {
  const rng = rngFrom((seed ^ 0x9e3779b9) >>> 0)
  let s = createGame({ seats: order.map((k, i) => ({ name: `P${i}`, bot: `kessel-${k}` })), seed })
  while (s.phase !== 'gameOver' && s.turn < cap) {
    s = stepBot(s, BOTS[s.sides[s.current].bot as string], () => rng.next())
  }
  return {
    id: `${order.join('-')}-${seed}`, schema: 1, rules: kessel.rulesVersion, seed,
    botSeed: seed ^ 0x9e3779b9, game: 'kessel',
    seats: order.map((_, i) => ({ name: `P${i}`, bot: null })),
    moves: s.moves, assisted: [], winner: s.winner, turns: s.turn,
    finished: s.phase === 'gameOver', savedAt: 0,
  }
}

const games = [
  playRecord(['maneuver', 'elastic'], 3607),
  playRecord(['attrition', 'maneuver'], 90211),
  playRecord(['elastic', 'attrition'], 41),
]
const reviews = games.map((g) => reviewKesselGame(g, { players: [0, 1] }))
const all = reviews.flatMap((r) => r.judgements)

ok(all.length > 100, `there is a war's worth of decisions to check, got ${all.length}`)
ok(reviews.every((r) => r.error === null), 'the records replay against the rules as they stand')

// ── loss is never negative ──
eq(all.filter((j) => j.loss < 0).length, 0, 'loss is never negative')
eq(
  all.filter((j) => j.evBest < j.evPlayed - 1e-9).length,
  0,
  'the best candidate is never worse than the played one — the played set is in the comparison',
)
eq(
  all.filter((j) => j.findings.some((f) => f.cost < 0 || !f.advice)).length,
  0,
  'every named fault carries a cost of its own and something to do about it',
)

// ── loss is blind to the roll ──
// The one property that makes the split trustworthy. Pricing reads the board the
// orders were written on and resolves it under its own seeds, so the generator
// state the game actually carried cannot reach it. Assert it rather than trust it.
{
  const r = reviews[0]
  const j = r.judgements.find((x) => x.loss > 0.5) as (typeof r.judgements)[number]
  const s = r.replay.states[j.index]
  const base = 12345
  const a = priceTurn(s, j.orders, j.player, base)
  const b = priceTurn({ ...s, rngState: (s.rngState ^ 0x7fffffff) | 0 }, j.orders, j.player, base)
  near(
    b.played.value - a.played.value,
    0,
    1e-9,
    'the generator state the game was carrying does not change what a turn prices at',
  )
}

// ── a deliberately terrible order set prices worse than a doctrine's ──
//
// Two ways of throwing a turn away, both built without reference to anything the
// reviewer detects: a headlong assault, where every formation in contact charges
// the strongest stack it can see whatever the odds, and a general rout, where the
// whole army walks back down its own supply chain and gives up the front.
//
// Not asserted on every single board, and the reason is worth keeping: a turn is
// priced one ply deep, and one ply after a headlong assault a few provinces have
// changed hands and nobody has counterattacked yet. On a board where the enemy is
// thin the charge really is the better turn, and a check that demanded otherwise
// would be demanding the evaluation lie.
{
  const r = reviews[0]
  let boards = 0
  const win = { assault: 0, rout: 0 }
  const gap = { assault: 0, rout: 0 }

  for (const j of r.judgements.slice(0, 40)) {
    const s = r.replay.states[j.index]
    const m = mapOf(s.mapId)
    const seeds = seedsFor(j.commit)
    const depth = depthMap(m, s, j.player)
    const strengthAt = (p: string) =>
      s.formations.filter((v) => v.at === p).reduce((n, v) => n + v.strength, 0)

    const assault: OrderSet = {}
    const rout: OrderSet = {}
    for (const f of s.formations) {
      if (f.owner !== j.player) continue
      const target = (m.adjacency[f.at] ?? [])
        .filter((n) => s.formations.some((x) => x.at === n && x.owner !== j.player))
        .sort((x, y) => strengthAt(y) - strengthAt(x))[0]
      assault[f.id] = target && f.supply >= 3 ? { type: 'attack', to: target } : { type: 'hold' }
      const back = (m.adjacency[f.at] ?? [])
        .filter(
          (n) =>
            s.owner[n] === j.player && !s.formations.some((x) => x.at === n && x.owner !== j.player),
        )
        .sort((x, y) => depth[x] - depth[y])[0]
      rout[f.id] = back ? { type: 'move', to: back } : { type: 'hold' }
    }
    // On a board where nothing of ours is in contact, "charge everything" is the
    // same turn as "hold everything" and the comparison says nothing.
    if (Object.values(assault).filter((o) => o.type === 'attack').length < 3) continue

    const rng = rngFrom(j.commit | 0)
    const good = valueOf(s, doctrineOrders(DOCTRINES[1], s, j.player, () => rng.next()), j.player, seeds)
    boards++
    for (const [key, orders] of [['assault', assault], ['rout', rout]] as const) {
      const bad = valueOf(s, orders, j.player, seeds)
      gap[key] += good - bad
      if (good > bad) win[key]++
    }
  }

  ok(boards >= 10, `there are boards with something to throw away on, got ${boards}`)
  ok(
    win.rout >= boards * 0.9,
    `giving up the front prices worse than a doctrine's turn on ${win.rout}/${boards} boards`,
  )
  ok(
    win.assault >= boards * 0.7,
    `charging every stack in reach prices worse on ${win.assault}/${boards} boards`,
  )
  ok(
    gap.rout / boards > 5 && gap.assault / boards > 5,
    `and both by a wide margin — rout ${(gap.rout / boards).toFixed(1)}, assault ${(
      gap.assault / boards
    ).toFixed(1)} steps a turn`,
  )
}

// ── the same war reviews identically twice ──
{
  const again = reviewKesselGame(games[0], { players: [0, 1] })
  eq(
    JSON.stringify(again.judgements),
    JSON.stringify(reviews[0].judgements),
    'the same war reviews identically twice, down to the advice',
  )
}

// ── luck averages to nothing; loss does not ──
{
  const lucks = all.map((j) => j.luck)
  const mean = lucks.reduce((a, b) => a + b, 0) / lucks.length
  const variance = lucks.reduce((a, b) => a + (b - mean) ** 2, 0) / (lucks.length - 1)
  const se = Math.sqrt(variance / lucks.length)
  ok(
    Math.abs(mean) <= Math.max(0.25, 2 * se),
    `luck averages to nothing over ${lucks.length} turns — got ${mean.toFixed(3)} ± ${(2 * se).toFixed(3)}`,
  )
  const meanLoss = all.reduce((a, j) => a + j.loss, 0) / all.length
  ok(
    meanLoss > 0.25,
    `loss does not, because it is a maximum over alternatives — got ${meanLoss.toFixed(3)}`,
  )
  ok(
    all.some((j) => Math.abs(j.luck) > 1),
    'and the resolution does move individual turns, so the split is measuring something',
  )
}

// ── a turn that ends the war prices above every alternative ─────────
{
  // The last province of value is ours, so the peace has something to score on.
  const m = fixture({ [id(0, 1)]: { depot: 3, vp: 2 }, [id(6, 1)]: { depot: 3 } })
  const owner = split()
  for (const p of [id(3, 1), id(4, 0), id(4, 2), id(5, 1)]) owner[p] = 0
  const last = corps(1, id(4, 1), { cohesion: 5 })
  const killer = corps(0, id(3, 1))
  const s = stateOn(m.id, owner, [
    last, killer, corps(0, id(4, 0)), corps(0, id(4, 2)), corps(0, id(5, 1)),
  ])
  const finish = applyMove(
    { ...s, orders: { [killer.id]: { type: 'attack', to: id(4, 1) } } },
    { type: 'commit' },
  )
  eq(finish.winner, 0, 'taking the last formation in a pocket ends the war')
  eq(evaluate(finish, 0), WIN_SCORE, 'and the position after it is worth the win score')
  eq(
    STACK_LIMIT[m.province[id(4, 1)].terrain] > 0,
    true,
    'the fixture province can hold a formation at all',
  )
}

console.log(`\n${passed} assertions passed`)
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILED:`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('all green')
