/**
 * Focused assertions for the rules that are easy to get quietly wrong.
 * Run with: npm test
 */
import { TERRITORY_IDS, ADJACENCY, TERRITORIES_IN, CONTINENT_IDS, CONTINENTS } from '../src/engine/board'
import { CASH_VALUES, cashValue, isValidSet, findSets } from '../src/engine/cards'
import {
  armiesNeededFor,
  expectedDefendersLeft,
  expectedLoss,
  expectedSurvivors,
  exchangeOdds,
  winProb,
} from '../src/engine/combat'
import {
  applyMove, bestTradeIn, createGame, legalMoves, reinforcementFor, territoriesOf, connectedOwn,
  RULES_VERSION,
} from '../src/engine/game'
import { rngFrom } from '../src/engine/rng'
import {
  CLEARS_UNDO, UNDOABLE, clickableFor, isHumanTurn, moveForClick, previewFor, primaryFor,
  targetsFor, validDestination, validSelection,
} from '../src/ui/decide'
import type { TerritoryId } from '../src/engine/board'
import { reviewGame } from '../src/review/review'
import { BOT_BY_KEY } from '../src/bots'
import { stepBot } from '../src/bots/play'
import { evalMove, rivalCount } from '../src/review/price'
import type { Card, GameState } from '../src/engine/types'

let passed = 0
const failures: string[] = []

function eq<T>(actual: T, expected: T, what: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) passed++
  else failures.push(`${what}\n    expected ${b}\n    got      ${a}`)
}
function ok(cond: boolean, what: string) {
  if (cond) passed++
  else failures.push(what)
}

// ── board integrity ──────────────────────────────────────────────
eq(TERRITORY_IDS.length, 42, '42 territories')
eq(CONTINENT_IDS.length, 6, '6 continents')
eq(
  Object.fromEntries(CONTINENT_IDS.map((c) => [c, TERRITORIES_IN[c].length])),
  { northAmerica: 9, southAmerica: 4, europe: 7, africa: 6, asia: 12, australia: 4 },
  'continent sizes match the classic board',
)
eq(
  CONTINENT_IDS.reduce((n, c) => n + TERRITORIES_IN[c].length, 0),
  42,
  'continents partition the board',
)
eq(
  CONTINENT_IDS.map((c) => CONTINENTS[c].bonus).reduce((a, b) => a + b, 0),
  24,
  'continent bonuses total 24 (5+2+5+3+7+2)',
)
for (const [a, ns] of Object.entries(ADJACENCY))
  for (const n of ns) ok(ADJACENCY[n].includes(a), `adjacency symmetric: ${a} <-> ${n}`)

// ── card cash-in: the progressive sequence, then +5 forever ───────
eq(CASH_VALUES, [4, 6, 8, 10, 12, 15, 20, 25], 'cash table')
eq(
  Array.from({ length: 12 }, (_, i) => cashValue(i)),
  [4, 6, 8, 10, 12, 15, 20, 25, 30, 35, 40, 45],
  'cash-in escalates by 5 past 25',
)

// ── set validity ─────────────────────────────────────────────────
const card = (id: number, suit: Card['suit']): Card => ({ id, suit, territory: 'brazil' })
ok(isValidSet([card(1, 'infantry'), card(2, 'infantry'), card(3, 'infantry')]), 'three of a kind is a set')
ok(isValidSet([card(1, 'infantry'), card(2, 'cavalry'), card(3, 'artillery')]), 'one of each is a set')
ok(!isValidSet([card(1, 'infantry'), card(2, 'infantry'), card(3, 'cavalry')]), 'two-and-one is not a set')
ok(isValidSet([card(1, 'infantry'), card(2, 'infantry'), card(3, 'wild')]), 'wild completes a pair')
ok(isValidSet([card(1, 'infantry'), card(2, 'cavalry'), card(3, 'wild')]), 'wild completes a mixed pair')
ok(!isValidSet([card(1, 'infantry'), card(2, 'infantry')]), 'two cards is not a set')
eq(findSets([card(1, 'infantry'), card(2, 'cavalry'), card(3, 'artillery'), card(4, 'infantry')]).length, 2, 'finds both sets in a 4-card hand')

// ── trading actually pays out, and escalates ─────────────────────
{
  let s = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: 'easy' }], seed: 5 })
  // fast-forward past initial placement
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])
  eq(s.phase, 'deploy', 'setup ends in the deploy phase')
  eq(s.turn, 1, 'first turn is turn 1')

  // hand the current player a known set, on territories they do not own
  const notMine = TERRITORY_IDS.find((t) => s.owner[t] !== s.current)!
  s.players[s.current].cards = [
    { id: 90, suit: 'infantry', territory: notMine },
    { id: 91, suit: 'cavalry', territory: notMine },
    { id: 92, suit: 'artillery', territory: notMine },
  ]
  const before = s.toDeploy
  s = applyMove(s, { type: 'tradeCards', cards: [90, 91, 92] })
  eq(s.toDeploy - before, 4, 'first set pays 4')
  eq(s.setsTraded, 1, 'set counted')
  eq(s.players[s.current].cards.length, 0, 'cards left the hand')
  eq(s.discard.length, 3, 'cards went to the discard pile')

  // second set pays 6, plus the +2 territory bonus when a card matches something owned
  const mine = territoriesOf(s, s.current)[0]
  s.players[s.current].cards = [
    { id: 93, suit: 'infantry', territory: mine },
    { id: 94, suit: 'infantry', territory: notMine },
    { id: 95, suit: 'wild', territory: null },
  ]
  const before2 = s.toDeploy
  s = applyMove(s, { type: 'tradeCards', cards: [93, 94, 95] })
  eq(s.toDeploy - before2, 8, 'second set pays 6 plus the +2 territory bonus')
}

// ── the set the UI cashes for you ────────────────────────────────
{
  let s = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: 'easy' }], seed: 5 })
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])
  const p = s.current
  const mine = territoriesOf(s, p)[0]
  const notMine = TERRITORY_IDS.find((t) => s.owner[t] !== p)!

  eq(bestTradeIn(s, p), null, 'nothing to cash with an empty hand')

  // two sets available: three-of-a-kind on foreign ground, or a mixed one that
  // includes a territory this player holds. The +2 bonus wins.
  s.players[p].cards = [
    { id: 90, suit: 'infantry', territory: notMine },
    { id: 91, suit: 'infantry', territory: notMine },
    { id: 92, suit: 'infantry', territory: notMine },
    { id: 93, suit: 'cavalry', territory: mine },
    { id: 94, suit: 'artillery', territory: notMine },
  ]
  eq(bestTradeIn(s, p), { cards: [90, 93, 94], value: 6 }, 'takes the set carrying the +2 territory bonus')

  // same payout either way — then the wild is the one to keep
  s.players[p].cards = [
    { id: 90, suit: 'infantry', territory: notMine },
    { id: 91, suit: 'infantry', territory: notMine },
    { id: 92, suit: 'infantry', territory: notMine },
    { id: 93, suit: 'wild', territory: null },
  ]
  eq(bestTradeIn(s, p), { cards: [90, 91, 92], value: 4 }, 'spends wilds last')
}

// ── the recap's log: repeated rolls collapse, earlier states don't move ──
{
  let s = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 5 })
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])
  while (s.phase === 'deploy')
    s = applyMove(s, { type: 'deploy', territory: territoriesOf(s, s.current)[0], count: s.toDeploy })

  // two big stacks, so neither round can end the fight
  const from = territoriesOf(s, s.current).find((t) => ADJACENCY[t].some((n) => s.owner[n] !== s.current))!
  const to = ADJACENCY[from].find((n) => s.owner[n] !== s.current)!
  s = { ...s, troops: { ...s.troops, [from]: 30, [to]: 30 } }

  const first = applyMove(s, { type: 'attack', from, to, dice: 3 })
  eq(first.log.length - s.log.length, 1, 'a failed attack writes one line')
  const snapshot = JSON.stringify(first)
  const second = applyMove(first, { type: 'attack', from, to, dice: 3 })
  eq(second.log.length, first.log.length, 'the second roll folds into the same line')
  eq(second.log[second.log.length - 1].tally?.rounds, 2, 'and the line counts both rounds')
  eq(JSON.stringify(first), snapshot, 'collapsing replaces the entry rather than editing history')

  // a different target starts a fresh line
  const other = ADJACENCY[from].find((n) => s.owner[n] !== s.current && n !== to)
  if (other) {
    const third = applyMove({ ...second, troops: { ...second.troops, [from]: 30, [other]: 30 } },
      { type: 'attack', from, to: other, dice: 3 })
    eq(third.log.length - second.log.length, 1, 'a different target gets its own line')
  }
}

// ── reinforcement maths ──────────────────────────────────────────
{
  let s = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 11 })
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])
  // 21 territories each at 2 players -> floor(21/3) = 7, no continents held
  eq(territoriesOf(s, 0).length, 21, 'two players split 42 territories evenly')
  const held = CONTINENT_IDS.filter((c) => TERRITORIES_IN[c].every((t) => s.owner[t] === 0))
  const bonus = held.reduce((n, c) => n + CONTINENTS[c].bonus, 0)
  eq(reinforcementFor(s, 0), 7 + bonus, 'reinforcement = floor(terr/3) + continent bonuses')

  // minimum of 3 even when nearly wiped out
  const stripped: GameState = { ...s, owner: { ...s.owner } }
  for (const t of TERRITORY_IDS) stripped.owner[t] = 1
  stripped.owner[TERRITORY_IDS[0]] = 0
  eq(reinforcementFor(stripped, 0), 3, 'reinforcement floors at 3')
}

// ── initial deployment: every army gets placed, one at a time ─────
{
  const seats = [
    { name: 'A', bot: null },
    { name: 'B', bot: null },
    { name: 'C', bot: null },
  ]
  let s = createGame({ seats, seed: 21 })
  eq(TERRITORY_IDS.every((t) => s.troops[t] === 1), true, 'every territory starts with exactly 1 army')
  eq(
    s.players.map((p) => p.reserve + territoriesOf(s, p.id).length),
    [35, 35, 35],
    '3 players get 35 armies each, dealt plus reserve',
  )

  // placement alternates between players who still have armies
  const seen: number[] = []
  while (s.phase === 'setup') {
    seen.push(s.current)
    s = applyMove(s, { type: 'placeInitial', territory: territoriesOf(s, s.current)[0] })
  }
  ok(seen.slice(0, 6).join('') === '012012', `placement rotates through players (got ${seen.slice(0, 6).join('')})`)
  eq(s.players.every((p) => p.reserve === 0), true, 'all reserves placed')
  const total = TERRITORY_IDS.reduce((n, t) => n + s.troops[t], 0)
  eq(total, 105, 'all 3x35 armies are on the board')
}

// ── combat never leaves a territory empty, and captures transfer ──
{
  let s = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 33 })
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])
  // find a border, stack it, and grind until something changes hands
  const from = territoriesOf(s, s.current).find((t) => ADJACENCY[t].some((n) => s.owner[n] !== s.current))!
  const to = ADJACENCY[from].find((n) => s.owner[n] !== s.current)!
  s = { ...s, troops: { ...s.troops, [from]: 40, [to]: 1 }, phase: 'attack', toDeploy: 0 }
  let guard = 0
  while (s.phase === 'attack' && s.owner[to] !== s.current && guard++ < 200) {
    s = applyMove(s, { type: 'attack', from, to, dice: 3 })
  }
  eq(s.owner[to], s.current, 'attacker eventually takes the territory')
  eq(s.phase, 'occupy', 'a capture forces an occupy decision')
  ok(s.troops[to] >= 1, 'captured territory is never left empty')
  ok(s.troops[from] >= 1, 'attacking territory keeps a garrison')
  const occ = s.pendingOccupation!
  s = applyMove(s, { type: 'occupy', count: occ.max })
  eq(s.phase, 'attack', 'occupying returns to the attack phase')
  eq(s.troops[occ.from], 1, 'moving the maximum leaves exactly 1 behind')
}

// ── blitz resolves many rounds as one move ────────────────────────
{
  let s = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 77 })
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])
  const from = territoriesOf(s, s.current).find((t) => ADJACENCY[t].some((n) => s.owner[n] !== s.current))!
  const to = ADJACENCY[from].find((n) => s.owner[n] !== s.current)!

  // overwhelming odds: one blitz should finish the job
  s = { ...s, troops: { ...s.troops, [from]: 60, [to]: 3 }, phase: 'attack', toDeploy: 0 }
  const attacker = s.current
  s = applyMove(s, { type: 'blitz', from, to })
  eq(s.owner[to], attacker, 'blitz takes the territory outright')
  eq(s.phase, 'occupy', 'blitz still hands you the occupy decision')
  ok(s.lastBlitz !== null, 'blitz records a summary')
  ok(s.lastBlitz!.rounds >= 1, 'blitz reports at least one round')
  ok(s.lastBlitz!.captured, 'blitz summary says captured')
  ok(s.troops[from] >= 1 && s.troops[to] >= 1, 'blitz never empties a territory')

  // hopeless odds: blitz spends itself down to a single army and stops
  let s2 = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 78 })
  while (s2.phase === 'setup') s2 = applyMove(s2, legalMoves(s2)[0])
  const f2 = territoriesOf(s2, s2.current).find((t) => ADJACENCY[t].some((n) => s2.owner[n] !== s2.current))!
  const t2 = ADJACENCY[f2].find((n) => s2.owner[n] !== s2.current)!
  s2 = { ...s2, troops: { ...s2.troops, [f2]: 3, [t2]: 60 }, phase: 'attack', toDeploy: 0 }
  const before2 = s2.current
  s2 = applyMove(s2, { type: 'blitz', from: f2, to: t2 })
  ok(s2.owner[t2] !== before2 || s2.phase === 'occupy', 'blitz against 60 armies does not silently succeed')
  if (s2.phase !== 'occupy') {
    eq(s2.troops[f2], 1, 'a failed blitz leaves exactly 1 army behind')
    eq(s2.phase, 'attack', 'a failed blitz stays in the attack phase')
    eq(s2.lastBlitz!.captured, false, 'failed blitz summary says not captured')
  }

  // an attack needs 2 armies, blitz included
  let s3 = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 79 })
  while (s3.phase === 'setup') s3 = applyMove(s3, legalMoves(s3)[0])
  const f3 = territoriesOf(s3, s3.current).find((t) => ADJACENCY[t].some((n) => s3.owner[n] !== s3.current))!
  const t3 = ADJACENCY[f3].find((n) => s3.owner[n] !== s3.current)!
  s3 = { ...s3, troops: { ...s3.troops, [f3]: 1 }, phase: 'attack', toDeploy: 0 }
  let threw = false
  try { applyMove(s3, { type: 'blitz', from: f3, to: t3 }) } catch { threw = true }
  ok(threw, 'blitz from a single army is rejected')
}

// ── combat maths, pinned to the known closed-form values ──────────
{
  const near = (a: number, b: number, tol: number, what: string) => {
    if (Math.abs(a - b) <= tol) passed++
    else failures.push(`${what}\n    expected ~${b}\n    got      ${a}`)
  }
  // one exchange, 1 die each: attacker wins 15 of 36
  const e11 = exchangeOdds(1, 1)
  near(e11.find((e) => e.defenderLoss === 1)!.p, 15 / 36, 1e-12, '1v1 exchange: attacker wins 15/36')
  // 3 dice vs 2: defender loses both 2890 times in 7776
  const e32 = exchangeOdds(3, 2)
  near(e32.find((e) => e.defenderLoss === 2)!.p, 2890 / 7776, 1e-12, '3v2 exchange: defender loses 2, 2890/7776')
  near(e32.find((e) => e.attackerLoss === 2)!.p, 2275 / 7776, 1e-12, '3v2 exchange: attacker loses 2, 2275/7776')
  near(e32.reduce((n, e) => n + e.p, 0), 1, 1e-9, '3v2 exchange probabilities sum to 1')

  // full battles
  near(winProb(2, 1), 15 / 36, 1e-12, 'winProb(2,1) is a single 1v1 roll')
  ok(winProb(1, 1) === 0, 'one army cannot attack')
  ok(winProb(5, 0) === 1, 'an empty territory is already taken')
  ok(winProb(10, 3) > winProb(5, 3), 'more attackers is never worse')
  ok(winProb(5, 3) > winProb(5, 6), 'more defenders is never better')

  // the attacker's edge grows with scale — the fact that makes stacking work
  ok(winProb(3, 1) > 0.7 && winProb(3, 1) < 0.8, `winProb(3,1) ≈ 0.75, got ${winProb(3, 1).toFixed(3)}`)
  ok(winProb(20, 15) > winProb(4, 3), 'a 4:3 fight is safer at scale than in miniature')

  // survivors and losses
  ok(expectedSurvivors(20, 2) > 15, 'a big stack barely notices two defenders')
  ok(expectedSurvivors(3, 5) < expectedSurvivors(3, 1), 'tougher targets leave fewer survivors')
  ok(expectedLoss(10, 5) > expectedLoss(10, 1), 'stronger defence costs more')
  eq(armiesNeededFor(1, 0.5), 3, 'beating one defender at even odds needs 3 armies')
  eq(armiesNeededFor(4, 0.5), 6, 'beating four defenders at even odds needs 6')

  // large stacks must not blow up the memo tables (this crashed the first Colonel)
  const big = winProb(30000, 5000)
  ok(big > 0.99, `huge favourable stacks resolve, got ${big}`)
  ok(Number.isFinite(expectedSurvivors(30000, 5000)), 'survivors stay finite at scale')
  ok(expectedSurvivors(30000, 5000) > 20000, 'survivors scale back up to real army counts')
}

// ── applyMove is pure: the undo stack depends on this ─────────────
{
  let s = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: 'easy' }], seed: 91 })
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])
  const snapshot = JSON.stringify(s)
  const mine = territoriesOf(s, s.current)[0]
  const next = applyMove(s, { type: 'deploy', territory: mine, count: 1 })
  eq(JSON.stringify(s), snapshot, 'applyMove leaves the input state untouched')
  ok(next !== s, 'applyMove returns a new object')
  ok(next.troops[mine] === s.troops[mine] + 1, 'the new state has the change')
  ok(next.owner !== s.owner && next.troops !== s.troops, 'nested records are cloned, not shared')

  // so restoring the old state really is a complete undo
  eq(next.toDeploy, s.toDeploy - 1, 'deploy consumed an army')
  eq(s.troops[mine], JSON.parse(snapshot).troops[mine], 'original troop count intact')
}

// ── fortifying leaves the turn open so it can still be undone ─────
{
  let s = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 92 })
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])
  const turn = s.turn
  const actor = s.current
  s = { ...s, phase: 'fortify', toDeploy: 0, canFortify: true }
  const from = territoriesOf(s, actor).find((t) => connectedOwn(s, actor, t).size > 0)!
  const to = [...connectedOwn(s, actor, from)][0]
  s = { ...s, troops: { ...s.troops, [from]: 5 } }
  s = applyMove(s, { type: 'fortify', from, to, count: 2 })
  eq(s.phase, 'fortify', 'still your turn after fortifying')
  eq(s.turn, turn, 'turn counter unchanged')
  eq(s.current, actor, 'still the same player')
  eq(s.canFortify, false, 'the one fortify is spent')
  eq(legalMoves(s).map((m) => m.type), ['endTurn'], 'only ending the turn is left')
  s = applyMove(s, { type: 'endTurn' })
  ok(s.current !== actor || s.players.length === 1, 'ending the turn passes play on')
}

// ── fortify only travels through your own territory ───────────────
{
  let s = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 44 })
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])
  const mine = territoriesOf(s, 0)
  const reach = connectedOwn(s, 0, mine[0])
  ok(![...reach].some((t) => s.owner[t] !== 0), 'connected set contains only your own territories')
  ok(!reach.has(mine[0]), 'connected set excludes the origin')
}

// ── the UI's decisions, which the engine tests above can't see ────
//
// src/ui/decide.ts holds every "what can the player do right now" answer as a
// pure function. The engine can be perfectly correct while the UI offers a move
// it would reject, or draws a preview the move wouldn't produce — so these are
// checked as properties over real game states rather than as hand-picked cases.
{
  // stale selections: the case that motivated deriving `sel` instead of clearing it
  let s = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 101 })
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])
  s = { ...s, phase: 'attack', toDeploy: 0 }

  const from = territoriesOf(s, s.current).find((t) => ADJACENCY[t].some((n) => s.owner[n] !== s.current))!
  const enemy = ADJACENCY[from].find((n) => s.owner[n] !== s.current)!
  eq(validSelection(s, null), null, 'nothing selected stays nothing')
  eq(validSelection(s, enemy), null, "you can't select a territory you don't own")
  eq(validSelection({ ...s, troops: { ...s.troops, [from]: 10 } }, from), from, 'a stacked border territory is selectable')
  eq(
    validSelection({ ...s, troops: { ...s.troops, [from]: 1 } }, from),
    null,
    'a territory spent down to one army stops being selectable',
  )
  // this is the blitz case: nothing about phase or player changed, so no effect would fire
  const botTurn = { ...s, players: s.players.map((p) => (p.id === s.current ? { ...p, bot: 'easy' } : p)) }
  eq(validSelection(botTurn, from), null, "a bot's turn has no human selection")

  // fortify: spending the one fortify invalidates the selection without a phase change
  let f = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 102 })
  while (f.phase === 'setup') f = applyMove(f, legalMoves(f)[0])
  f = { ...f, phase: 'fortify', toDeploy: 0, canFortify: true }
  const src = territoriesOf(f, f.current).find((t) => connectedOwn(f, f.current, t).size > 0)!
  f = { ...f, troops: { ...f.troops, [src]: 5 } }
  eq(validSelection(f, src), src, 'a connected stack is selectable while the fortify is unspent')
  eq(validSelection({ ...f, canFortify: false }, src), null, 'spending the fortify invalidates the selection')

  // a destination only counts while it's still in the target set
  const reach = targetsFor(f, src)
  const reachable = [...reach][0]
  const unreachable = TERRITORY_IDS.find((t) => t !== src && !reach.has(t))!
  eq(validDestination(src, reachable, reach), reachable, 'a reachable destination stands')
  eq(validDestination(src, unreachable, reach), null, 'an unreachable destination is dropped')
  eq(validDestination(null, reachable, reach), null, 'no source means no destination')
}

{
  // Property sweep. Play out whole games as two humans, and at every single state
  // ask the UI what it would offer — then make the engine judge the answer.
  let primaries = 0
  let previews = 0
  let clicks = 0
  const bad: string[] = []

  for (let g = 0; g < 12; g++) {
    let s = createGame({ seats: [{ name: 'A', bot: null }, { name: 'B', bot: null }], seed: 500 + g })
    const rng = rngFrom(g * 7919 + 13)
    let guard = 0

    while (s.phase !== 'gameOver' && guard++ < 1200) {
      const amounts = [0, 1, 3, 999]   // including out-of-range values the clamps must absorb

      // 1. whatever the dark button offers, the engine must accept
      for (const amount of amounts) {
        const selected = territoriesOf(s, s.current).find((t) => validSelection(s, t) !== null) ?? null
        const sel = validSelection(s, selected)
        const dest = validDestination(sel, [...targetsFor(s, sel)][0] ?? null, targetsFor(s, sel))
        const p = primaryFor(s, amount, sel, dest)
        if (!p || p.kind !== 'move' || !p.move) continue
        primaries++
        try {
          const after = applyMove(s, p.move)

          // 2. and if it drew a preview, the move must produce exactly those numbers
          const pv = previewFor(s, amount, sel, dest)
          if (pv) {
            previews++
            for (const [t, n] of Object.entries(pv) as [TerritoryId, number][])
              if (after.troops[t] !== n)
                bad.push(`preview promised ${t}=${n}, move produced ${after.troops[t]} (${p.move.type}, amount ${amount})`)
          }
        } catch (e) {
          bad.push(`primary offered an illegal move: ${JSON.stringify(p.move)} — ${(e as Error).message}`)
        }
      }

      // 3. every clickable territory must produce a move the engine accepts
      const sel = validSelection(s, territoriesOf(s, s.current).find((t) => validSelection(s, t) !== null) ?? null)
      for (const t of clickableFor(s, targetsFor(s, sel))) {
        for (const shift of [false, true]) {
          const move = moveForClick(s, t, shift, 2, sel)
          if (!move) continue
          clicks++
          try { applyMove(s, move) } catch (e) {
            bad.push(`clickable ${t} produced an illegal move: ${JSON.stringify(move)} — ${(e as Error).message}`)
          }
        }
      }

      const moves = legalMoves(s)
      s = applyMove(s, moves[Math.floor(rng.next() * moves.length)])
    }
  }

  ok(primaries > 200, `the sweep actually exercised the primary action (${primaries} offers)`)
  ok(previews > 20, `the sweep actually exercised previews (${previews} drawn)`)
  ok(clicks > 200, `the sweep actually exercised clicks (${clicks} made)`)
  ok(bad.length === 0, `UI never offers what the engine rejects\n    ${bad.slice(0, 5).join('\n    ')}`)
}

{
  // The bot's turn belongs to Skip, and nothing else.
  let s = createGame({ seats: [{ name: 'A', bot: 'easy' }, { name: 'B', bot: null }], seed: 103 })
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])
  eq(isHumanTurn(s), false, "the bot's seat is not a human turn")
  eq(primaryFor(s, 1, null, null)?.kind, 'skipBots', "a bot's turn offers Skip")
  eq(primaryFor(s, 1, null, null)?.label, 'Skip to B', 'Skip names the next human')
  eq(clickableFor(s, new Set()).size, 0, "nothing is clickable on a bot's turn")
  eq(previewFor(s, 1, null, null), null, "no preview on a bot's turn")

  // with no humans left there is nobody to skip to
  const allBots = { ...s, players: s.players.map((p) => ({ ...p, bot: 'easy' })) }
  eq(primaryFor(allBots, 1, null, null)?.label, 'Skip to end', 'with no humans, Skip runs to the end')

  // a finished game has no primary action at all
  eq(primaryFor({ ...s, phase: 'gameOver' }, 1, null, null), null, 'game over offers nothing')
}

{
  // Undo covers the deterministic moves and nothing else — rewinding past a roll
  // would be save-scumming, and ending a turn draws a card.
  for (const t of ['deploy', 'tradeCards', 'fortify', 'endAttack'] as const)
    ok(UNDOABLE.has(t) && !CLEARS_UNDO.has(t), `${t} is undoable`)
  for (const t of ['attack', 'blitz', 'endTurn'] as const)
    ok(CLEARS_UNDO.has(t) && !UNDOABLE.has(t), `${t} closes the undo window`)
}

// ── a game is its seed plus its move list ─────────────────────────
// This is the property the whole review feature rests on: replaying the recorded
// moves against a fresh game must reproduce the original exactly, dice included.
// If it ever stops holding, saved games silently render boards that never existed.
{
  const seats = [
    { name: 'A', bot: 'colonel' },
    { name: 'B', bot: 'general' },
    { name: 'C', bot: 'marshal' },
  ]
  const rng = rngFrom(4242)
  let s = createGame({ seats, seed: 777 })
  while (s.phase !== 'gameOver' && s.turn < 60) {
    s = stepBot(s, BOT_BY_KEY[s.players[s.current].bot!], () => rng.next())
  }
  ok(s.moves.length > 100, `a played game records its moves, got ${s.moves.length}`)

  let r = createGame({ seats, seed: 777 })
  for (const m of s.moves) r = applyMove(r, m)
  eq(r.owner, s.owner, 'replay reproduces every territory owner')
  eq(r.troops, s.troops, 'replay reproduces every troop count')
  eq(r.rngState, s.rngState, 'replay lands on the same generator state — the dice matched')
  eq(r.winner, s.winner, 'replay reproduces the result')
  eq(r.turn, s.turn, 'replay reproduces the turn count')
  eq(
    r.players.map((p) => p.cards.map((c) => c.id)),
    s.players.map((p) => p.cards.map((c) => c.id)),
    'replay reproduces every hand, so the deck was dealt identically',
  )

  // the move list is per-state, not shared — this is what makes undo correct
  const before = s.moves.length
  const mid = createGame({ seats, seed: 777 })
  const after = applyMove(mid, s.moves[0])
  eq(mid.moves.length, 0, 'applying a move leaves the original move list alone')
  eq(after.moves.length, 1, 'the new state carries the move')
  eq(s.moves.length, before, 'and the finished game is untouched by any of it')
}

// ── the reviewer prices moves without rolling them ────────────────
{
  const seats = [{ name: 'A', bot: null }, { name: 'B', bot: 'general' }]
  let s = createGame({ seats, seed: 51 })
  while (s.phase === 'setup') s = applyMove(s, legalMoves(s)[0])

  // Same position, same price, every time. A reviewer that sampled dice would
  // grade the same decision differently on each viewing.
  const move = legalMoves(s)[0]
  const a = evalMove(s, move, s.current, rivalCount(s, s.current))
  const b = evalMove(s, move, s.current, rivalCount(s, s.current))
  eq(a, b, 'evaluating a move twice gives the same number')

  // and it must not consume the generator, or "analysing" would change the game
  const rngBefore = s.rngState
  for (const m of legalMoves(s).slice(0, 20)) evalMove(s, m, s.current, 2)
  eq(s.rngState, rngBefore, 'pricing moves never touches the dice')
}

// ── the reviewer judges the right seats, and only them ────────────
{
  const seats = [
    { name: 'You', bot: null },
    { name: 'Bot', bot: 'general' },
  ]
  const rng = rngFrom(31337)
  let s = createGame({ seats, seed: 2024 })
  while (s.phase !== 'gameOver' && s.turn < 25) {
    s = stepBot(s, BOT_BY_KEY[s.players[s.current].bot ?? 'colonel'], () => rng.next())
  }
  const base = {
    id: 't', schema: 1, rules: RULES_VERSION, seed: 2024, botSeed: 0, seats,
    moves: s.moves, assisted: [] as number[], winner: s.winner, turns: s.turn,
    finished: s.phase === 'gameOver', savedAt: 0,
  }

  const all = reviewGame(base)
  ok(all.judgements.length > 0, 'a played game produces judgements')
  ok(!all.error, `the recorded game replays cleanly: ${all.error}`)
  ok(
    all.judgements.every((j) => j.player === 0),
    'only the human seat is judged — the bot is not being graded',
  )
  ok(all.judgements.every((j) => j.loss >= 0), 'no decision scores better than the best available')

  // Moves the app played on your behalf must not be held against you.
  const skipped = all.judgements.map((j) => j.index).slice(0, 3)
  const partial = reviewGame({ ...base, assisted: skipped })
  ok(
    skipped.every((i) => !partial.judgements.some((j) => j.index === i)),
    'auto-placed moves are excluded from the review',
  )
  eq(
    partial.judgements.length,
    all.judgements.length - skipped.length,
    'and excluding them removes exactly those decisions',
  )

  // Reviewing is read-only: it must not disturb the record it was handed.
  eq(base.moves.length, s.moves.length, 'reviewing leaves the stored move list alone')
}

// ── expected defenders left, against the closed form ──────────────
{
  // With one attacker army the attack is already spent, so every defender stands.
  eq(expectedDefendersLeft(1, 5), 5, 'a spent attack leaves the defence intact')
  eq(expectedDefendersLeft(5, 0), 0, 'nothing to defend with')
  ok(
    expectedDefendersLeft(10, 8) < 8,
    'a big attack that still fails has thinned the defence',
  )
  ok(
    expectedDefendersLeft(2, 8) > expectedDefendersLeft(8, 8),
    'a bigger attacker leaves fewer defenders standing even in defeat',
  )
  // Both branches have to account for the whole battle: on a win no defenders are
  // left at all, so the unconditional expectation is just the losing branch's
  // share — and it has to land strictly between "none" and "all of them".
  for (const [a, d] of [[5, 3], [8, 5], [4, 4], [12, 8]] as const) {
    const expected = (1 - winProb(a, d)) * expectedDefendersLeft(a, d)
    ok(expected > 0 && expected < d, `defenders left for ${a}v${d} is in range, got ${expected}`)
  }
}

console.log(`\n${passed} assertions passed`)
if (failures.length) {
  console.error(`\n${failures.length} FAILED:`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('all green\n')
