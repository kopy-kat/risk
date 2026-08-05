import { ADJACENCY, CONTINENT_IDS, CONTINENTS, TERRITORIES_IN, TERRITORY_IDS, TERRITORY_NAMES } from './board'
import type { TerritoryId } from './board'
import { buildDeck, cashValue, findSets, isValidSet } from './cards'
import { rngFrom, rollDie, shuffle } from './rng'
import type { Card, GameState, Move, Player, PlayerId } from './types'

/** Classic starting-army counts by player count. */
const START_ARMIES: Record<number, number> = { 2: 40, 3: 35, 4: 30, 5: 25, 6: 20 }

/** A player must trade once their hand reaches this size. */
export const HAND_LIMIT = 5

export interface SeatConfig {
  name: string
  /** bot registry key, or null for a human seat */
  bot: string | null
}

export interface NewGameOptions {
  seats: SeatConfig[]
  seed?: number
}

// ─────────────────────────── queries ───────────────────────────

export const territoriesOf = (s: GameState, p: PlayerId): TerritoryId[] =>
  TERRITORY_IDS.filter((t) => s.owner[t] === p)

export const continentsHeldBy = (s: GameState, p: PlayerId) =>
  CONTINENT_IDS.filter((c) => TERRITORIES_IN[c].every((t) => s.owner[t] === p))

/** floor(territories / 3), min 3, plus continent bonuses. */
export function reinforcementFor(s: GameState, p: PlayerId): number {
  const base = Math.max(3, Math.floor(territoriesOf(s, p).length / 3))
  const bonus = continentsHeldBy(s, p).reduce((sum, c) => sum + CONTINENTS[c].bonus, 0)
  return base + bonus
}

/** Territories reachable from `from` travelling only through `p`'s own territories. */
export function connectedOwn(s: GameState, p: PlayerId, from: TerritoryId): Set<TerritoryId> {
  const seen = new Set<TerritoryId>([from])
  const queue = [from]
  while (queue.length) {
    const cur = queue.pop() as TerritoryId
    for (const n of ADJACENCY[cur]) {
      if (s.owner[n] === p && !seen.has(n)) {
        seen.add(n)
        queue.push(n)
      }
    }
  }
  seen.delete(from)
  return seen
}

export const attackableFrom = (s: GameState, t: TerritoryId): TerritoryId[] =>
  s.troops[t] < 2 ? [] : ADJACENCY[t].filter((n) => s.owner[n] !== s.owner[t])

const nextAlive = (s: GameState, after: PlayerId): PlayerId => {
  const n = s.players.length
  for (let i = 1; i <= n; i++) {
    const cand = (after + i) % n
    if (s.players[cand].alive) return cand
  }
  return after
}

// ─────────────────────────── setup ───────────────────────────

export function createGame({ seats, seed = 1 }: NewGameOptions): GameState {
  if (seats.length < 2 || seats.length > 6) throw new Error('Risk supports 2–6 players')
  const rng = rngFrom(seed)

  const players: Player[] = seats.map((seat, id) => ({
    id,
    name: seat.name,
    color: id,
    bot: seat.bot,
    alive: true,
    cards: [],
    reserve: 0,
  }))

  // Every territory is dealt out at random with a single army on it; whatever is
  // left of each player's starting armies gets placed by hand, one at a time.
  const shuffled = shuffle(TERRITORY_IDS, rng)
  const owner: Record<TerritoryId, PlayerId> = {}
  const troops: Record<TerritoryId, number> = {}
  shuffled.forEach((t, i) => {
    owner[t] = i % players.length
    troops[t] = 1
  })
  for (const p of players) {
    const dealt = shuffled.filter((t) => owner[t] === p.id).length
    p.reserve = START_ARMIES[players.length] - dealt
  }

  const s: GameState = {
    players,
    owner,
    troops,
    phase: 'setup',
    current: 0,
    turn: 0,
    toDeploy: 0,
    deck: shuffle(buildDeck(), rng),
    discard: [],
    setsTraded: 0,
    conqueredThisTurn: false,
    canFortify: true,
    pendingOccupation: null,
    lastBattle: null,
    lastBlitz: null,
    log: [],
    rngState: rng.state,
    winner: null,
  }
  log(s, null, `${players.length} players · territories dealt · place your remaining armies`)
  return s
}

// ─────────────────────────── move generation ───────────────────────────

export function legalMoves(s: GameState): Move[] {
  if (s.phase === 'gameOver') return []
  const p = s.current
  const me = s.players[p]
  const mine = territoriesOf(s, p)

  switch (s.phase) {
    case 'setup':
      return mine.map((t) => ({ type: 'placeInitial', territory: t }) as Move)

    case 'deploy': {
      const sets = findSets(me.cards).map((cards) => ({ type: 'tradeCards', cards }) as Move)
      // Holding five or more cards forces a trade before anything else.
      if (me.cards.length >= HAND_LIMIT && sets.length) return sets
      const deploys: Move[] = []
      for (const t of mine) {
        deploys.push({ type: 'deploy', territory: t, count: 1 })
        if (s.toDeploy > 1) deploys.push({ type: 'deploy', territory: t, count: s.toDeploy })
      }
      return [...sets, ...deploys]
    }

    case 'attack': {
      const moves: Move[] = [{ type: 'endAttack' }]
      for (const from of mine) {
        const maxDice = Math.min(3, s.troops[from] - 1)
        if (maxDice < 1) continue
        for (const to of attackableFrom(s, from)) {
          for (let dice = 1; dice <= maxDice; dice++) moves.push({ type: 'attack', from, to, dice })
          moves.push({ type: 'blitz', from, to })
        }
      }
      return moves
    }

    case 'occupy': {
      const occ = s.pendingOccupation!
      const moves: Move[] = []
      for (let c = occ.min; c <= occ.max; c++) moves.push({ type: 'occupy', count: c })
      return moves
    }

    case 'fortify': {
      const moves: Move[] = [{ type: 'endTurn' }]
      if (!s.canFortify) return moves
      for (const from of mine) {
        if (s.troops[from] < 2) continue
        for (const to of connectedOwn(s, p, from))
          for (const count of spread(1, s.troops[from] - 1))
            moves.push({ type: 'fortify', from, to, count })
      }
      return moves
    }
  }
}

/** A few representative amounts rather than every integer, to keep fortify branching sane. */
function spread(lo: number, hi: number): number[] {
  if (hi < lo) return []
  const out = new Set([lo, hi, Math.floor((lo + hi) / 2)])
  return [...out].filter((n) => n >= lo && n <= hi)
}

// ─────────────────────────── move application ───────────────────────────

function clone(s: GameState): GameState {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p, cards: p.cards.slice() })),
    owner: { ...s.owner },
    troops: { ...s.troops },
    deck: s.deck.slice(),
    discard: s.discard.slice(),
    log: s.log.slice(),
    pendingOccupation: s.pendingOccupation ? { ...s.pendingOccupation } : null,
    lastBattle: s.lastBattle ? { ...s.lastBattle } : null,
    lastBlitz: s.lastBlitz ? { ...s.lastBlitz } : null,
  }
}

const name = (t: TerritoryId) => TERRITORY_NAMES[t]

function log(s: GameState, player: PlayerId | null, text: string) {
  s.log.push({ turn: s.turn, player, text })
  if (s.log.length > 400) s.log.shift()
}

export function applyMove(state: GameState, move: Move): GameState {
  const s = clone(state)
  const rng = rngFrom(s.rngState)
  const p = s.current
  const me = s.players[p]

  switch (move.type) {
    case 'placeInitial': {
      expect(s.phase === 'setup', 'not in setup')
      expect(s.owner[move.territory] === p, 'not your territory')
      expect(me.reserve > 0, 'no armies left to place')
      s.troops[move.territory]++
      me.reserve--
      if (s.players.some((q) => q.reserve > 0)) {
        // hand to the next player who still has armies
        let n = p
        do n = (n + 1) % s.players.length
        while (s.players[n].reserve === 0)
        s.current = n
      } else {
        s.current = 0
        beginTurn(s, 0)
      }
      break
    }

    case 'tradeCards': {
      expect(s.phase === 'deploy', 'cards can only be traded while deploying')
      const cards = move.cards.map((id) => {
        const c = me.cards.find((x) => x.id === id)
        expect(!!c, `card ${id} not in hand`)
        return c as Card
      })
      expect(isValidSet(cards), 'not a valid set')
      me.cards = me.cards.filter((c) => !move.cards.includes(c.id))
      s.discard.push(...cards)
      const value = cashValue(s.setsTraded)
      s.setsTraded++
      s.toDeploy += value
      // classic territory bonus, pooled rather than forced onto the named territory
      const matched = cards.some((c) => c.territory && s.owner[c.territory] === p)
      if (matched) s.toDeploy += 2
      log(s, p, `traded a set · +${value}${matched ? ' +2 territory bonus' : ''}`)
      break
    }

    case 'deploy': {
      expect(s.phase === 'deploy', 'not in deploy')
      expect(s.owner[move.territory] === p, 'not your territory')
      expect(me.cards.length < HAND_LIMIT || !findSets(me.cards).length, 'you must trade a set first')
      expect(move.count >= 1 && move.count <= s.toDeploy, 'bad deploy count')
      s.troops[move.territory] += move.count
      s.toDeploy -= move.count
      if (s.toDeploy === 0) s.phase = 'attack'
      break
    }

    case 'attack': {
      requireAttack(s, move.from, move.to)
      const maxDice = Math.min(3, s.troops[move.from] - 1)
      expect(move.dice >= 1 && move.dice <= maxDice, 'bad dice count')
      s.lastBlitz = null
      const captured = battle(s, rng, move.from, move.to, move.dice)
      if (captured) claim(s, move.from, move.to, move.dice)
      break
    }

    case 'blitz': {
      const { from, to } = move
      requireAttack(s, from, to)
      s.lastBlitz = null
      let rounds = 0
      let attackerLoss = 0
      let defenderLoss = 0
      let captured = false
      // Each round costs at least one army on one side, so this always terminates.
      while (s.troops[from] >= 2 && !captured) {
        const dice = Math.min(3, s.troops[from] - 1)
        const before = { a: s.troops[from], d: s.troops[to] }
        captured = battle(s, rng, from, to, dice)
        rounds++
        attackerLoss += before.a - s.troops[from]
        defenderLoss += before.d - s.troops[to]
        if (captured) claim(s, from, to, dice)
      }
      s.lastBlitz = { from, to, rounds, attackerLoss, defenderLoss, captured }
      break
    }

    case 'occupy': {
      expect(s.phase === 'occupy', 'nothing to occupy')
      const occ = s.pendingOccupation!
      expect(move.count >= occ.min && move.count <= occ.max, 'bad occupation count')
      s.troops[occ.from] -= move.count
      s.troops[occ.to] += move.count
      s.pendingOccupation = null
      s.phase = 'attack'
      checkWinner(s)
      break
    }

    case 'endAttack':
      expect(s.phase === 'attack', 'not in attack')
      s.phase = 'fortify'
      break

    case 'fortify': {
      expect(s.phase === 'fortify', 'not in fortify')
      expect(s.canFortify, 'already fortified this turn')
      const { from, to } = move
      expect(s.owner[from] === p && s.owner[to] === p, 'both territories must be yours')
      expect(from !== to, 'pick two different territories')
      expect(connectedOwn(s, p, from).has(to), 'no route through your own territories')
      expect(move.count >= 1 && move.count <= s.troops[from] - 1, 'bad fortify count')
      s.troops[from] -= move.count
      s.troops[to] += move.count
      s.canFortify = false
      log(s, p, `moved ${move.count} from ${name(from)} to ${name(to)}`)
      // Deliberately does *not* end the turn — that leaves a window in which the
      // fortify can still be undone, and ending the turn draws a card (random),
      // which is a hard undo boundary.
      break
    }

    case 'endTurn':
      expect(s.phase === 'attack' || s.phase === 'fortify', 'cannot end turn now')
      endTurn(s, rng)
      break
  }

  s.rngState = rng.state
  return s
}

function roll(rng: ReturnType<typeof rngFrom>, count: number): number[] {
  return Array.from({ length: count }, () => rollDie(rng)).sort((x, y) => y - x)
}

function requireAttack(s: GameState, from: TerritoryId, to: TerritoryId) {
  expect(s.phase === 'attack', 'not in attack')
  expect(s.owner[from] === s.current, 'not your territory')
  expect(s.owner[to] !== s.current, 'that territory is already yours')
  expect(ADJACENCY[from].includes(to), 'territories are not adjacent')
  expect(s.troops[from] >= 2, 'need at least 2 armies to attack')
}

/** One exchange of dice. Mutates troop counts and returns whether `to` fell. */
function battle(
  s: GameState,
  rng: ReturnType<typeof rngFrom>,
  from: TerritoryId,
  to: TerritoryId,
  diceCount: number,
): boolean {
  const a = roll(rng, diceCount)
  const d = roll(rng, Math.min(2, s.troops[to]))
  let attackerLoss = 0
  let defenderLoss = 0
  for (let i = 0; i < Math.min(a.length, d.length); i++) {
    if (a[i] > d[i]) defenderLoss++
    else attackerLoss++ // ties go to the defender
  }
  s.troops[from] -= attackerLoss
  s.troops[to] -= defenderLoss
  const captured = s.troops[to] === 0
  s.lastBattle = { from, to, attackerDice: a, defenderDice: d, attackerLoss, defenderLoss, captured }
  return captured
}

/**
 * Take an emptied territory. The dice that won it advance immediately so nothing
 * is ever left holding zero armies; moving more is the player's call.
 */
function claim(s: GameState, from: TerritoryId, to: TerritoryId, moved: number) {
  const p = s.current
  const loser = s.owner[to]
  s.owner[to] = p
  s.conqueredThisTurn = true
  s.troops[from] -= moved
  s.troops[to] = moved
  log(s, p, `took ${name(to)} from ${s.players[loser].name}`)
  s.pendingOccupation = { from, to, moved, min: 0, max: s.troops[from] - 1 }
  s.phase = 'occupy'
  maybeEliminate(s, loser, p)
}

function expect(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`illegal move: ${message}`)
}

function beginTurn(s: GameState, p: PlayerId) {
  s.current = p
  s.turn++
  s.phase = 'deploy'
  s.toDeploy = reinforcementFor(s, p)
  s.conqueredThisTurn = false
  s.canFortify = true
  s.pendingOccupation = null
}

function endTurn(s: GameState, rng: ReturnType<typeof rngFrom>) {
  const p = s.current
  if (s.conqueredThisTurn) {
    const card = drawCard(s, rng)
    if (card) s.players[p].cards.push(card)
  }
  checkWinner(s)
  if (s.phase === 'gameOver') return
  beginTurn(s, nextAlive(s, p))
}

function drawCard(s: GameState, rng: ReturnType<typeof rngFrom>): Card | null {
  if (!s.deck.length) {
    if (!s.discard.length) return null
    s.deck = shuffle(s.discard, rng)
    s.discard = []
  }
  return s.deck.pop() ?? null
}

function maybeEliminate(s: GameState, loser: PlayerId, victor: PlayerId) {
  if (territoriesOf(s, loser).length > 0) return
  s.players[loser].alive = false
  // the victor inherits the eliminated player's hand
  const spoils = s.players[loser].cards
  if (spoils.length) s.players[victor].cards.push(...spoils)
  s.players[loser].cards = []
  log(s, victor, `eliminated ${s.players[loser].name}${spoils.length ? ` · took ${spoils.length} cards` : ''}`)
}

function checkWinner(s: GameState) {
  const alive = s.players.filter((p) => p.alive)
  const holdsAll = alive.length === 1 || territoriesOf(s, s.current).length === TERRITORY_IDS.length
  if (alive.length === 1 || holdsAll) {
    s.winner = alive.length === 1 ? alive[0].id : s.current
    s.phase = 'gameOver'
    log(s, s.winner, 'wins the world')
  }
}
