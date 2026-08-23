/**
 * Kessel's rules, on a grid.
 *
 * The real map is generated and will change as its topology is tuned, so every
 * assertion here runs on a synthetic grid instead — a rule that only holds on one
 * arrangement of provinces isn't a rule.
 */
import {
  ACTIVATIONS, REINFORCE_EVERY, REPLACEMENT_TURNS, WILL_FLOOR,
  activationsUsed, applyMove, createGame, legalMoves, view,
} from '../src/games/kessel/game'
import { engage } from '../src/games/kessel/combat'
import { observed } from '../src/games/kessel/intel'
import { MUD_CYCLE, RAIL_ALLOWANCE, exploitReach, isMud, reachable } from '../src/games/kessel/movement'
import { STACK_LIMIT, registerMap } from '../src/games/kessel/map'
import type { MapData, Province, Terrain } from '../src/games/kessel/map'
import { depthMap, liveDepots, retreatOptions, retreatTargets, supplyStates } from '../src/games/kessel/supply'
import type { Formation, KesselState, UnitType } from '../src/games/kessel/types'
import type { PlayerId } from '../src/engine/types'

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
        id: id(x, y),
        name: id(x, y),
        nation: 'grid',
        terrain: 'plain' as Terrain,
        depot: 0,
        vp: 0,
        cx: x * 100,
        cy: y * 100,
        d: '',
        ...over[id(x, y)],
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
/** Each fixture gets its own map id so overrides in one test can't leak into another. */
function fixture(over: Partial<Record<string, Partial<Province>>> = {}) {
  const data = { ...gridMap(over), id: `grid${mapSerial++}` }
  return registerMap(data)
}

let formationSerial = 0
function corps(owner: PlayerId, at: string, patch: Partial<Formation> = {}): Formation {
  return {
    id: formationSerial++,
    owner,
    type: 'infantry' as UnitType,
    at,
    strength: 3,
    cohesion: 100,
    wear: 0,
    dug: 0,
    supply: 3,
    rest: 0,
    ...patch,
  }
}

/** The grid's two ends: where each side's supply enters, and where its reinforcements arrive. */
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
      id: i,
      name: `S${i}`,
      color: i,
      bot: null,
      alive: true,
      will: 100,
      aims: [],
      revealed: [],
      home: homeOf(i as PlayerId),
      seen: {},
    })),
    owner,
    formations,
    orders: {},
    phase: 'orders',
    current: 0,
    turn: 1,
    log: [],
    moves: [],
    record: true,
    rngState: 12345,
    winner: null,
    nextFormationId: formationSerial,
    offered: false,
    ...patch,
  }
}

/** Split the grid down the middle: left half to side 0, right half to side 1. */
function split(): Record<string, PlayerId> {
  const owner: Record<string, PlayerId> = {}
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) owner[id(x, y)] = x < W / 2 ? 0 : 1
  return owner
}

// ── supply traces from depots and degrades with depth ───────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 2 } })
  const owner = split()
  const s = stateOn(m.id, owner, [])
  const dist = depthMap(m, s, 0)

  eq(dist[id(0, 1)], 0, 'a depot is at depth zero')
  eq(dist[id(1, 1)], 1, 'each province of plain costs one')
  eq(dist[id(3, 1)], 3, 'depth accumulates along the chain')
  ok(dist[id(4, 1)] === Infinity, 'supply does not trace into ground the enemy holds')
}

// ── rough country costs more to supply through ──────────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 2 }, [id(1, 1)]: { terrain: 'mountain' } })
  const s = stateOn(m.id, split(), [])
  const dist = depthMap(m, s, 0)
  eq(dist[id(1, 1)], 2, 'mountain costs double')
  eq(dist[id(2, 1)], 3, 'and the cost carries down the chain')
}

// ── an enemy zone of control severs the chain ───────────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 2 } })
  const owner = split()
  // A lone enemy recon slipped in behind the line, holding nothing.
  const raider = corps(1, id(3, 0), { type: 'recon', strength: 1 })
  const s = stateOn(m.id, owner, [raider])
  const dist = depthMap(m, s, 0)

  ok(dist[id(3, 1)] === Infinity, 'a chain may not be traced through an enemy zone of control')
  ok(dist[id(2, 1)] < Infinity, 'ground short of the raider is still supplied')

  const screened = stateOn(m.id, owner, [raider, corps(0, id(3, 1))])
  ok(
    depthMap(m, screened, 0)[id(3, 1)] < Infinity,
    'holding the province with a formation of your own reopens it',
  )
}

// ── supply state degrades in bands rather than switching off ────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const all: Record<string, PlayerId> = {}
  for (const p of m.ids) all[p] = 0
  const near = corps(0, id(1, 1))
  const far = corps(0, id(5, 1))
  const s = stateOn(m.id, all, [near, far])
  const states = supplyStates(m, s, 0)

  eq(states[near.id], 3, 'a formation near the railhead is fully supplied')
  eq(states[far.id], 2, 'one past the first band is strained, not starving')
}

// ── a depot serves a finite number of formations ────────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 1 } })
  const all = [corps(0, id(1, 1)), corps(0, id(1, 0)), corps(0, id(1, 2))]
  const s = stateOn(m.id, split(), all)
  const states = supplyStates(m, s, 0)
  const served = all.filter((f) => states[f.id] === 3).length

  eq(served, 2, 'one point of depot capacity serves two infantry corps')
  ok(
    all.some((f) => states[f.id] === 1),
    'the corps that finds nothing at the railhead is strained, not cut off — it can still trace a line',
  )
}

// ── armour draws double, so it culminates first ─────────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 1 } })
  const tanks = [corps(0, id(1, 1), { type: 'armour' }), corps(0, id(1, 0), { type: 'armour' })]
  const s = stateOn(m.id, split(), tanks)
  const states = supplyStates(m, s, 0)
  eq(
    tanks.filter((f) => states[f.id] === 3).length,
    1,
    'the same depot that serves two infantry corps serves one armoured one',
  )
}

// ── strained supply forbids attacking, but not holding ──────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const owner = split()
  const spearhead = corps(0, id(3, 1), { supply: 2 })
  const s = stateOn(m.id, owner, [spearhead, corps(1, id(4, 1))])
  const mine = legalMoves(s, 0)

  ok(
    !mine.some((mv) => mv.type === 'order' && mv.order.type === 'attack'),
    'a strained formation may not start an attack — that is the culminating point',
  )
  ok(
    mine.some((mv) => mv.type === 'order' && mv.order.type === 'hold'),
    'it can still hold the ground it is standing on',
  )
}

// ── a broken formation retreats toward its own supply ───────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const owner = split()
  const beaten = corps(0, id(3, 1))
  const s = stateOn(m.id, owner, [beaten])
  const where = retreatTargets(m, s, beaten)

  ok(where.length > 0, 'a formation with friendly ground behind it has somewhere to go')
  eq(where[0], id(2, 1), 'and it falls back toward the railhead, not away from it')
}

// ── encirclement, and the one rule the game is built on ─────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3 } })
  const owner = split()
  // Side 0 has closed a ring around one province of side 1's ground.
  const pocket = id(4, 1)
  owner[id(3, 1)] = 0
  owner[id(4, 0)] = 0
  owner[id(4, 2)] = 0
  owner[id(5, 1)] = 0

  const trapped = corps(1, pocket, { cohesion: 20 })
  const ring = [corps(0, id(3, 1)), corps(0, id(4, 0)), corps(0, id(4, 2)), corps(0, id(5, 1))]
  const s = stateOn(m.id, owner, [trapped, ...ring])

  eq(retreatTargets(m, s, trapped).length, 0, 'an encircled formation has nowhere to retreat')

  let g = s
  g = applyMove(g, { type: 'order', formation: ring[0].id, order: { type: 'attack', to: pocket } })
  g = applyMove(g, { type: 'commit' })

  ok(
    !g.formations.some((f) => f.id === trapped.id),
    'beaten with no line of retreat, it surrenders instead of falling back',
  )
  eq(g.owner[pocket], 0, 'and the pocket changes hands')
}

// ── the same beating, with a way out, only pushes ───────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3 } })
  const owner = split()
  owner[id(3, 1)] = 0

  const defender = corps(1, id(4, 1), { cohesion: 20 })
  const s = stateOn(m.id, owner, [defender, corps(0, id(3, 1))])

  let g = s
  const attacker = g.formations.find((f) => f.owner === 0) as Formation
  g = applyMove(g, { type: 'order', formation: attacker.id, order: { type: 'attack', to: id(4, 1) } })
  g = applyMove(g, { type: 'commit' })

  const survivor = g.formations.find((f) => f.id === defender.id)
  ok(!!survivor, 'a defender with ground behind it survives the same beating')
  ok(survivor !== undefined && survivor.at !== id(4, 1), 'it is pushed off the province')
  ok(
    survivor !== undefined && survivor.strength === defender.strength,
    'and keeps its strength — combat pushes, encirclement kills',
  )
}

// ── a packed province is no way out either ──────────────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3 } })
  const owner = split()
  owner[id(3, 1)] = 0

  // The only ground behind this defender is already holding all the terrain takes.
  const defender = corps(1, id(4, 1), { cohesion: 20 })
  const packed = [corps(1, id(4, 0)), corps(1, id(4, 2)), corps(1, id(5, 1))]
  const crowd = packed.flatMap((f) => [f, corps(1, f.at), corps(1, f.at)])
  const s = stateOn(m.id, owner, [defender, ...crowd, corps(0, id(3, 1))])

  eq(retreatOptions(m, s, defender).length, 0, 'ground packed to the stack limit is not a line of retreat')

  let g = s
  const attacker = g.formations.find((f) => f.owner === 0) as Formation
  g = applyMove(g, { type: 'order', formation: attacker.id, order: { type: 'attack', to: id(4, 1) } })
  g = applyMove(g, { type: 'commit' })
  ok(
    !g.formations.some((f) => f.id === defender.id),
    'so a formation with nowhere that will hold it surrenders like any other pocket',
  )
}

// ── crossing the ground costs more than holding it ──────────────────
{
  const m = fixture()
  const attacker = corps(0, id(3, 1))
  const defender = corps(1, id(4, 1))
  const { resolve } = await import('../src/games/kessel/combat')
  // Even strength, open ground, nobody dug in: the bill still falls on the attacker.
  const e = resolve(m, [attacker], [defender], id(4, 1), () => 0.5)
  ok(
    e.attackerLoss > e.defenderLoss,
    'an assault at even odds is a losing trade, or attacking at any odds is free',
  )
}

// ── a formation goes as far as its legs, and stops on contact ───────
{
  // No depot anywhere, so there is no railway: this is the march alone.
  const m = fixture()
  const all: Record<string, PlayerId> = {}
  for (const p of m.ids) all[p] = 0

  const foot = corps(0, id(0, 1))
  const horse = corps(0, id(0, 0), { type: 'recon' })
  const s = stateOn(m.id, all, [foot, horse])

  const footReach = reachable(m, s, foot).cost
  const horseReach = reachable(m, s, horse).cost
  eq(footReach[id(2, 1)], 2, 'infantry crosses two provinces of open ground')
  ok(footReach[id(3, 1)] === undefined, 'and no further')
  ok(horseReach[id(3, 0)] !== undefined, 'recon goes further on the same ground')

  // An enemy anywhere near the route ends the march at first contact.
  const blocked = stateOn(m.id, all, [foot, corps(1, id(2, 1))])
  const stopped = reachable(m, blocked, foot).cost
  ok(stopped[id(1, 1)] !== undefined, 'a march may enter the ground an enemy watches')
  ok(stopped[id(1, 0)] !== undefined, 'and reach elsewhere freely')
  ok(stopped[id(2, 0)] === undefined, 'but it ends there rather than passing through')
}

// ── a march takes the ground it crosses ─────────────────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const owner = split()
  const rider = corps(0, id(3, 1), { type: 'recon' })
  let g = stateOn(m.id, owner, [rider])
  const far = id(5, 1)
  ok(reachable(m, g, rider).cost[far] !== undefined, 'recon can ride deep into empty ground')

  g = applyMove(g, { type: 'order', formation: rider.id, order: { type: 'move', to: far } })
  g = applyMove(g, { type: 'commit' })
  eq(g.owner[id(4, 1)], 0, 'the ground it rode across changes hands, not just where it stopped')
  eq(g.owner[far], 0, 'including where it ended')
}

// ── you cannot set every province in motion at once ─────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const all: Record<string, PlayerId> = {}
  for (const p of m.ids) all[p] = 0
  const spread = m.ids.slice(0, ACTIVATIONS + 3).map((p) => corps(0, p))
  let g = stateOn(m.id, all, spread)

  let ordered = 0
  for (const f of spread) {
    const to = (m.adjacency[f.at] ?? []).find((n) => reachable(m, g, f).cost[n] !== undefined)
    if (!to) continue
    try {
      g = applyMove(g, { type: 'order', formation: f.id, order: { type: 'move', to } })
      ordered++
    } catch {
      break
    }
  }
  eq(ordered, ACTIVATIONS, 'the activation budget caps how many provinces can move in a turn')
  eq(activationsUsed(g, 0).size, ACTIVATIONS, 'and it is counted by province, not by formation')

  // Holding costs nothing, so a line can be manned without spending the budget.
  const idle = spread[spread.length - 1]
  g = applyMove(g, { type: 'order', formation: idle.id, order: { type: 'hold' } })
  eq(activationsUsed(g, 0).size, ACTIVATIONS, 'holding is free')
}

// ── damage costs steps deterministically ────────────────────────────
{
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const s = stateOn(m.id, split(), [])
  void s
  void m
  // applyLoss is exercised through combat above; this pins the threshold itself.
  const { applyLoss, WEAR_PER_STEP } = await import('../src/games/kessel/combat')
  const f = corps(0, id(1, 1), { wear: WEAR_PER_STEP - 1, strength: 3 })
  eq(applyLoss(f, 1).strength, 2, 'crossing the wear threshold costs exactly one step, with no roll')
  eq(applyLoss(f, 0.5).strength, 3, 'and stopping short of it costs nothing')
}

// ── a depot is a railhead, not a well: cut from home it issues nothing ──
{
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(4, 1)]: { depot: 2 } })
  const owner = split()
  // Side 0 has taken the enemy depot at (4,1) and the ground around it, but the
  // enemy still stands on (3,1): the depot is behind their line, off side 0's network.
  owner[id(4, 1)] = 0
  owner[id(4, 0)] = 0
  owner[id(4, 2)] = 0
  const garrison = corps(0, id(4, 1))
  const s = stateOn(m.id, owner, [garrison, corps(1, id(3, 1))])

  ok(!liveDepots(m, s, 0).includes(id(4, 1)), 'a depot the enemy has cut off from home is not a source')
  eq(supplyStates(m, s, 0)[garrison.id], 0, 'and the formation standing on it is cut off like any other pocket')

  // Reopen the line: side 0 holds (3,1) too, and the screen is gone.
  const open = { ...owner, [id(3, 1)]: 0 as PlayerId }
  const relieved = stateOn(m.id, open, [garrison, corps(0, id(3, 1))])
  ok(liveDepots(m, relieved, 0).includes(id(4, 1)), 'reconnected to home, the same depot issues supply again')
  eq(supplyStates(m, relieved, 0)[garrison.id], 3, 'and its garrison is fully supplied')
}

// ── each border admits its frontage, and the best value goes through first ──
{
  const m = fixture()
  const target = id(4, 1)
  const spent = corps(0, id(3, 1), { cohesion: 20 })
  const fresh = corps(0, id(3, 1), { type: 'armour' })
  const flank = corps(0, id(4, 0))
  const second = corps(0, id(4, 0))
  const third = corps(0, id(4, 0))
  const committed = engage(m, [spent, fresh, flank, second, third], target)

  ok(committed.some((f) => f.id === fresh.id), 'the fresh armour goes in')
  ok(committed.some((f) => f.id === flank.id), 'so does the flank')
  eq(committed.filter((f) => f.at === id(3, 1)).length, 2, 'open ground admits two across one border')
  eq(committed.length, 4, 'and four in all, from however many directions')
  // Through a pass only one gets in, and it is the best one.
  const narrow = fixture({ [id(4, 1)]: { terrain: 'mountain' } })
  const pass = engage(narrow, [spent, fresh], target)
  eq(pass.length, 1, 'a mountain border admits one formation')
  eq(pass[0].id, fresh.id, 'and it is the one with the most to bring, not the one listed first')
}

// ── terms: refused, the broken side fights the turn out and can ask again ──
{
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3 } })
  const owner = split()
  const mine = corps(0, id(3, 1))
  const theirs = corps(1, id(4, 1))
  let g = stateOn(m.id, owner, [mine, theirs])
  g.sides[0].will = WILL_FLOOR

  const first = legalMoves(g, 0)
  ok(first.some((mv) => mv.type === 'offerTerms'), 'a side at the floor may ask for terms')
  ok(first.some((mv) => mv.type === 'commit'), 'and may still play the turn')
  ok(
    !first.some((mv) => mv.type === 'order' && mv.order.type === 'attack'),
    'but it can no longer be ordered forward',
  )
  ok(
    first.some((mv) => mv.type === 'order' && mv.order.type === 'move'),
    'holding, refitting and moving are still its to give',
  )

  g = applyMove(g, { type: 'offerTerms' })
  eq(g.phase, 'terms', 'the offer goes to the other side')
  g = applyMove(g, { type: 'rejectTerms' })
  eq(g.phase, 'orders', 'refused, the war goes on')
  eq(g.current, 0, 'and the broken side has its turn')
  eq(g.sides[1].will, 100 - 8, 'refusing cost the refuser will')
  ok(!legalMoves(g, 0).some((mv) => mv.type === 'offerTerms'), 'it cannot ask twice in one turn')
  g = applyMove(g, { type: 'commit' })
  eq(g.current, 1, 'it commits, and the turn passes')
  g = applyMove(g, { type: 'commit' })
  ok(legalMoves(g, 0).some((mv) => mv.type === 'offerTerms'), 'next turn it may ask again')
}

// ── no order is an order to dig in, and a refit stands until it is done ──
{
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const owner = split()
  const quiet = corps(0, id(1, 1))
  const tired = corps(0, id(1, 0), { cohesion: 50 })
  let g = stateOn(m.id, owner, [quiet, tired, corps(1, id(6, 1))])
  g = applyMove(g, { type: 'order', formation: tired.id, order: { type: 'refit' } })
  g = applyMove(g, { type: 'commit' })

  eq(g.formations.find((f) => f.id === quiet.id)?.dug, 1, 'a formation nobody ordered digs in anyway')
  eq(g.orders[tired.id]?.type, 'refit', 'a refit outlives the turn it was given')
  g = applyMove(g, { type: 'commit' }) // the other side
  g = applyMove(g, { type: 'commit' }) // ours again: still refitting
  g = applyMove(g, { type: 'commit' })
  ok(!g.orders[tired.id], 'and ends on its own once cohesion is full')
  eq(g.formations.find((f) => f.id === tired.id)?.cohesion, 100, 'which it is')
}

// ── exploitation: what takes a province by assault rides on with what is left ──
{
  // The enemy railhead sits at (4,0), so a beaten defender falls back there and
  // leaves the road east open.
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(4, 0)]: { depot: 3 } })
  const owner = split()
  const tanks = corps(0, id(3, 1), { type: 'armour' })
  const foot = corps(0, id(2, 0))
  const weak = corps(1, id(4, 1), { cohesion: 5, strength: 1 })
  const s = stateOn(m.id, owner, [tanks, foot, weak])

  ok(exploitReach(m, s, tanks, id(4, 1)).cost[id(5, 1)] !== undefined, 'armour can plan to ride on past the ground it takes')
  eq(Object.keys(exploitReach(m, s, foot, id(4, 1)).cost).length, 0, 'infantry has nothing left after an assault')

  let g = applyMove(s, { type: 'order', formation: tanks.id, order: { type: 'attack', to: id(4, 1), onward: id(5, 1) } })
  g = applyMove(g, { type: 'commit' })
  eq(g.formations.find((f) => f.id === tanks.id)?.at, id(5, 1), 'the assault goes in, the ground falls, and the armour is two provinces on')
  eq(g.owner[id(4, 1)], 0, 'the ground it broke through is taken')
  eq(g.owner[id(5, 1)], 0, 'and so is the ground it rode on to')
}

// ── the railway: far, along the supply network, out of contact to out of contact ──
{
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const owner = split()
  const reserve = corps(0, id(0, 0))
  const s = stateOn(m.id, owner, [reserve, corps(1, id(4, 1))])
  const reach = reachable(m, s, reserve)

  ok(reach.rail.has(id(2, 2)), 'a reserve out of contact can ride the railway further than it marches')
  ok(!reach.cost[id(3, 1)], 'but not into contact with the enemy')
  ok(RAIL_ALLOWANCE > 2, 'the railway is the interior line')

  const strained = stateOn(m.id, owner, [corps(0, id(0, 0), { supply: 2 }), corps(1, id(4, 1))])
  eq(reachable(m, strained, strained.formations[0]).rail.size, 0, 'a formation short of supply does not get a train')
  const forward = stateOn(m.id, owner, [corps(0, id(3, 1)), corps(1, id(4, 1))])
  eq(reachable(m, forward, forward.formations[0]).rail.size, 0, 'nor does one already in contact')
}

// ── mud: on the calendar, halves the march, spares the railway ──
{
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const all: Record<string, PlayerId> = {}
  for (const p of m.ids) all[p] = 0
  const muddy = [...Array(MUD_CYCLE * 2).keys()].map((t) => t + 1).filter(isMud)
  ok(muddy.length > 0 && muddy.length < MUD_CYCLE, 'some turns are mud and most are not')

  const tanks = corps(0, id(3, 1), { type: 'armour', supply: 2 })
  const dry = reachable(m, stateOn(m.id, all, [tanks], { turn: muddy[0] - 1 }), tanks)
  const wet = reachable(m, stateOn(m.id, all, [tanks], { turn: muddy[0] }), tanks)
  ok(Object.keys(wet.cost).length < Object.keys(dry.cost).length, 'armour gets less far in the mud')
}

// ── replacements: a corps rebuilds on a live railhead, and only there ──
{
  const m = fixture({ [id(0, 1)]: { depot: 3 } })
  const owner = split()
  const cadre = corps(0, id(0, 1), { strength: 1 })
  const field = corps(0, id(2, 1), { strength: 1 })
  let g = stateOn(m.id, owner, [cadre, field, corps(1, id(6, 1))])
  for (let t = 0; t < REPLACEMENT_TURNS; t++) {
    g = applyMove(g, { type: 'order', formation: cadre.id, order: { type: 'refit' } })
    g = applyMove(g, { type: 'order', formation: field.id, order: { type: 'refit' } })
    g = applyMove(g, { type: 'commit' })
    g = applyMove(g, { type: 'commit' })
  }
  eq(g.formations.find((f) => f.id === cadre.id)?.strength, 2, 'refitting on the railhead brings a step back')
  eq(g.formations.find((f) => f.id === field.id)?.strength, 1, 'refitting in the field does not')
}

// ── reinforcements: a corps by rail, on the calendar, to the rearmost railhead ──
{
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3 } })
  let g = stateOn(m.id, split(), [corps(0, id(2, 1)), corps(1, id(4, 1))])
  const before = g.formations.length
  for (let t = 1; t < REINFORCE_EVERY; t++) {
    g = applyMove(g, { type: 'commit' })
    g = applyMove(g, { type: 'commit' })
  }
  eq(g.formations.length, before + 2, 'each side receives a corps when the draft falls due')
  ok(g.formations.some((f) => f.owner === 0 && f.at === id(0, 1)), 'it detrains at the railhead nearest home')
}

// ── war aims: dealt off a public menu, hidden until given away ──
{
  const m = fixture({
    [id(0, 1)]: { depot: 3, vp: 2 },
    [id(6, 1)]: { depot: 3, vp: 2 },
    [id(5, 0)]: { vp: 1 },
  })
  const owner = split()
  const far = corps(0, id(2, 0))
  const a = corps(0, id(4, 0))
  const b = corps(0, id(6, 0))
  const c = corps(0, id(5, 1))
  owner[id(4, 0)] = 0
  owner[id(6, 0)] = 0
  owner[id(5, 1)] = 0
  let g = stateOn(m.id, owner, [far, a, b, c, corps(1, id(6, 2))])
  g.sides[0].aims = [id(5, 0), id(6, 1)]

  g = applyMove(g, { type: 'commit' })
  ok(g.sides[0].revealed.includes(id(5, 0)), 'three formations beside an aim give it away')
  ok(!g.sides[0].revealed.includes(id(6, 1)), 'the one nobody has approached stays hidden')
}

// ── fog: what an enemy counter is worth is known on contact, or under recon ──
{
  const m = fixture({ [id(0, 1)]: { depot: 3 }, [id(6, 1)]: { depot: 3 } })
  const owner = split()
  const line = corps(0, id(3, 1))
  const eyes = corps(0, id(2, 0), { type: 'recon', strength: 1 })
  const s = stateOn(m.id, owner, [line, eyes, corps(1, id(4, 1)), corps(1, id(6, 1))])
  const seen = observed(m, s, 0)
  ok(seen.has(id(4, 1)), 'the province next door is observed')
  ok(seen.has(id(4, 0)), 'recon sees two provinces out')
  ok(!seen.has(id(6, 1)), 'the enemy rear is not')
}

// ── a whole game runs to a settled peace ────────────────────────────
{
  const m = fixture({
    [id(0, 1)]: { depot: 3, vp: 2 },
    [id(6, 1)]: { depot: 3, vp: 2 },
    [id(2, 0)]: { vp: 1 },
    [id(4, 2)]: { vp: 1 },
  })
  let g = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 7, mapId: m.id })

  ok(g.formations.filter((f) => f.owner === 0).length > 0, 'each side deploys an army')
  ok(
    g.sides.every((side) => side.aims.length > 0 && side.aims.every((p) => m.province[p].vp > 0 && g.owner[p] !== side.id)),
    'and is dealt war aims, all of them ground worth something on the far side',
  )
  ok(
    g.sides.every((side) => side.revealed.length === 0),
    'which the enemy knows nothing of yet',
  )
  const overstacked = m.ids.filter(
    (p) => g.formations.filter((f) => f.at === p).length > STACK_LIMIT[m.province[p].terrain],
  )
  eq(overstacked.length, 0, 'and no province is deployed into beyond what it will hold')
  ok(
    m.ids.some((p) => g.owner[p] === 0 && (m.adjacency[p] ?? []).some((n) => g.owner[n] === 1)
      && g.formations.some((f) => f.at === p && f.owner === 0)),
    'the line is manned at the point of contact, not left in the rear',
  )
  let steps = 0
  let everStuck = false
  let sinceCommit = 0
  while (g.phase !== 'gameOver' && steps < 60000) {
    const moves = legalMoves(g, g.current)
    if (moves.length === 0) {
      everStuck = true
      break
    }
    // Give orders for a while, then commit — a walk that picks uniformly commits
    // once in a thousand now that a formation can be sent anywhere it can reach.
    const commit = moves.find((mv) => mv.type === 'commit')
    const pick = commit && sinceCommit > 20 ? commit : moves[Math.floor((steps * 2654435761) % moves.length)]
    sinceCommit = pick.type === 'commit' ? 0 : sinceCommit + 1
    g = applyMove(g, pick)
    steps++
  }
  ok(!everStuck, 'the move generator is never empty while the war is on')

  const v = view(g)
  ok(v.standing.every((n) => n >= 0 && n <= 1), 'standing is a share of the win condition')
  ok(Math.abs(v.standing.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'and the shares sum to one')
  ok(steps < 60000, 'a war reaches a settled peace rather than running forever')
}

console.log(`\n${passed} assertions passed`)
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILED:`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('all green')
