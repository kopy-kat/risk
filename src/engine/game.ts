import { ADJACENCY, CONTINENT_IDS, CONTINENTS, TERRITORIES_IN, TERRITORY_IDS, TERRITORY_NAMES } from './board'
import type { TerritoryId } from './board'
import { CASH_VALUES, buildDeck, cashValue, findSets, isValidSet } from './cards'
import { rngFrom, rollDie, shuffle } from './rng'
import type { Card, GameMode, GameState, LogEntry, Move, Player, PlayerId } from './types'

/** Classic starting-army counts by player count. */
const START_ARMIES: Record<number, number> = { 2: 40, 3: 35, 4: 30, 5: 25, 6: 20 }

/** A player must trade once their hand reaches this size. */
export const HAND_LIMIT = 5

/**
 * Fingerprint of the rules a recorded game was played under.
 *
 * A saved game is a move list, not a board — it only means anything replayed
 * against the same rules. Retune `CASH_VALUES` (which `cards.ts` explicitly
 * invites) or the starting armies and yesterday's move lists stop applying part
 * way through, which would otherwise surface as a replay quietly showing the
 * wrong board rather than as an error. Stored games carry this string and are
 * quarantined rather than replayed when it no longer matches.
 *
 * Rules that aren't a number get a literal token. Change what one of them names
 * and change the token with it — a move list only replays under the rules that
 * produced it, and the fingerprint is the only thing that knows.
 */
export const RULES_VERSION = [
  `t${TERRITORY_IDS.length}`,
  `h${HAND_LIMIT}`,
  `s${Object.entries(START_ARMIES).map(([n, a]) => `${n}:${a}`).join(',')}`,
  `c${CASH_VALUES.join(',')}`,
  'spoils:immediate',
  'match2:onboard',
].join('|')

/**
 * The fingerprint a game in this mode replays under. Classic keeps the bare
 * `RULES_VERSION` so every game recorded before modes existed stays replayable;
 * the other modes append a token, which also stops an older build from silently
 * replaying a supply game under classic rules — the boards would diverge.
 */
export const rulesFor = (mode: GameMode = 'classic'): string =>
  mode === 'classic' ? RULES_VERSION : `${RULES_VERSION}|mode:${mode}`

export interface SeatConfig {
  name: string
  /** bot registry key, or null for a human seat */
  bot: string | null
  /**
   * Palette slot, if it should differ from the seat index. Turn order is the seat
   * index and gets shuffled, so a player's colour has to be able to travel with
   * them — otherwise you pick Crimson in setup and start the game as Jade.
   */
  color?: number
}

export interface NewGameOptions {
  seats: SeatConfig[]
  seed?: number
  /** Keep the move list. Defaults on; see `GameState.record`. */
  record?: boolean
  /** Rule set. Defaults to classic; see `GameMode`. */
  mode?: GameMode
}

// ─────────────────────────── queries ───────────────────────────

export const territoriesOf = (s: GameState, p: PlayerId): TerritoryId[] =>
  TERRITORY_IDS.filter((t) => s.owner[t] === p)

export const continentsHeldBy = (s: GameState, p: PlayerId) =>
  CONTINENT_IDS.filter((c) => TERRITORIES_IN[c].every((t) => s.owner[t] === p))

/**
 * floor(territories / 3), min 3, plus continent bonuses. In supply mode only
 * supplied territories count, and a continent pays only while its tiles are in
 * supply — a fully-held continent is internally connected, but it can still be
 * an island cut off from the main body.
 */
export function reinforcementFor(s: GameState, p: PlayerId): number {
  if (s.mode !== 'supply') {
    const base = Math.max(3, Math.floor(territoriesOf(s, p).length / 3))
    const bonus = continentsHeldBy(s, p).reduce((sum, c) => sum + CONTINENTS[c].bonus, 0)
    return base + bonus
  }
  const supplied = suppliedOf(s, p)
  const base = Math.max(3, Math.floor(supplied.size / 3))
  const bonus = continentsHeldBy(s, p)
    .filter((c) => TERRITORIES_IN[c].every((t) => supplied.has(t)))
    .reduce((sum, c) => sum + CONTINENTS[c].bonus, 0)
  return base + bonus
}

/**
 * The territories `p` can supply: the largest connected group they hold, by
 * tile count, ties to the group carrying more armies. Everything outside it is
 * cut off — no income, no deploys, and attrition at the owner's turn start.
 *
 * Largest-by-tiles deliberately, not by armies: measured by armies, a single
 * roaming stack would out-vote the homeland and the mode would punish nothing.
 */
export function suppliedOf(s: GameState, p: PlayerId): Set<TerritoryId> {
  const mine = new Set(territoriesOf(s, p))
  let best: Set<TerritoryId> | null = null
  let bestArmies = 0
  while (mine.size) {
    const [start] = mine
    const group = new Set<TerritoryId>([start])
    const queue = [start]
    mine.delete(start)
    let armies = s.troops[start]
    while (queue.length) {
      const cur = queue.pop() as TerritoryId
      for (const n of ADJACENCY[cur]) {
        if (!mine.has(n)) continue
        mine.delete(n)
        group.add(n)
        queue.push(n)
        armies += s.troops[n]
      }
    }
    if (!best || group.size > best.size || (group.size === best.size && armies > bestArmies)) {
      best = group
      bestArmies = armies
    }
  }
  return best ?? new Set()
}

/**
 * Where the +2 territory-match bonus lands, or null if the set pictures nothing
 * you hold. The armies garrison the pictured territory itself — they never reach
 * the deploy pool, so they are not yours to place.
 *
 * Up to three cards in a set can match. Two armies behind the lines do nothing,
 * so a territory in contact with an enemy wins; beyond that the choice is between
 * equals and the board order settles it.
 */
function bonusTerritory(s: GameState, p: PlayerId, cards: Card[]): TerritoryId | null {
  const held = cards
    .map((c) => c.territory)
    .filter((t): t is TerritoryId => !!t && s.owner[t] === p)
  if (!held.length) return null
  const front = held.filter((t) => ADJACENCY[t].some((n) => s.owner[n] !== p))
  const pool = front.length ? front : held
  return TERRITORY_IDS.find((t) => pool.includes(t)) as TerritoryId
}

/**
 * The set worth cashing, what it pays into the pool, and where its +2 garrison
 * lands. Which three cards you hand in is a decision with exactly one good answer
 * — take the +2 territory bonus if it's there, and spend wilds last — so the UI
 * picks for you rather than making you hunt for the combination.
 */
export function bestTradeIn(
  s: GameState,
  p: PlayerId,
): { cards: number[]; value: number; bonusAt: TerritoryId | null } | null {
  const hand = s.players[p].cards
  const byId = new Map(hand.map((c) => [c.id, c]))
  const value = cashValue(s.setsTraded)
  let best: { cards: number[]; bonusAt: TerritoryId | null; worth: number; wilds: number } | null = null
  for (const ids of findSets(hand)) {
    const cards = ids.map((id) => byId.get(id) as Card)
    const bonusAt = bonusTerritory(s, p, cards)
    const wilds = cards.filter((c) => c.suit === 'wild').length
    const worth = value + (bonusAt ? 2 : 0)
    if (!best || worth > best.worth || (worth === best.worth && wilds < best.wilds))
      best = { cards: ids, bonusAt, worth, wilds }
  }
  return best && { cards: best.cards, value, bonusAt: best.bonusAt }
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

export function createGame({ seats, seed = 1, record = true, mode = 'classic' }: NewGameOptions): GameState {
  if (seats.length < 2 || seats.length > 6) throw new Error('Risk supports 2–6 players')
  const rng = rngFrom(seed)

  const players: Player[] = seats.map((seat, id) => ({
    id,
    name: seat.name,
    color: seat.color ?? id,
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
    moves: [],
    record,
    rngState: rng.state,
    winner: null,
    mode,
    capitals: {},
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
      // Cut-off territories take no reinforcements — the largest group always
      // exists and is always supplied, so there is always somewhere to deploy.
      const supplied = s.mode === 'supply' ? suppliedOf(s, p) : null
      const deploys: Move[] = []
      for (const t of mine) {
        if (supplied && !supplied.has(t)) continue
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
    // Never recorded means never appended to, so the empty list is safe to share.
    moves: s.record ? s.moves.slice() : s.moves,
    pendingOccupation: s.pendingOccupation ? { ...s.pendingOccupation } : null,
    lastBattle: s.lastBattle ? { ...s.lastBattle } : null,
    lastBlitz: s.lastBlitz ? { ...s.lastBlitz } : null,
    capitals: { ...s.capitals },
  }
}

const name = (t: TerritoryId) => TERRITORY_NAMES[t]

function push(s: GameState, entry: LogEntry) {
  s.log.push(entry)
  if (s.log.length > 2000) s.log.shift()
}

function log(s: GameState, player: PlayerId | null, text: string, victim?: PlayerId) {
  push(s, { turn: s.turn, player, text, victim })
}

/**
 * An attack that didn't take the territory. Repeated rolls against the same
 * target fold into the previous line rather than filling the recap with a dozen
 * near-identical entries. The entry is *replaced*, never mutated: clone() copies
 * the log array but not its entries, so an earlier state would see the edit too.
 */
function logAssault(
  s: GameState,
  p: PlayerId,
  from: TerritoryId,
  to: TerritoryId,
  rounds: number,
  attackerLoss: number,
  defenderLoss: number,
) {
  const key = `assault:${p}:${from}>${to}`
  const last = s.log[s.log.length - 1]
  const prev = last && last.key === key ? last.tally : null
  const tally = prev
    ? {
        rounds: prev.rounds + rounds,
        attackerLoss: prev.attackerLoss + attackerLoss,
        defenderLoss: prev.defenderLoss + defenderLoss,
      }
    : { rounds, attackerLoss, defenderLoss }
  const entry: LogEntry = {
    turn: s.turn,
    player: p,
    key,
    tally,
    text: `attacked ${name(to)} from ${name(from)} · ${tally.rounds}× · −${tally.attackerLoss}/−${tally.defenderLoss}`,
  }
  if (prev) s.log[s.log.length - 1] = entry
  else push(s, entry)
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
      if (s.mode === 'capitals' && s.capitals[p] === undefined) {
        s.capitals[p] = move.territory
        log(s, p, `founded their capital in ${name(move.territory)}`)
      }
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
      // the territory-match bonus garrisons the pictured territory on the spot; only
      // the cash-in itself is yours to place
      const bonusAt = bonusTerritory(s, p, cards)
      if (bonusAt) s.troops[bonusAt] += 2
      log(s, p, `traded a set · +${value}${bonusAt ? ` · +2 on ${name(bonusAt)}` : ''}`)
      break
    }

    case 'deploy': {
      expect(s.phase === 'deploy', 'not in deploy')
      expect(s.owner[move.territory] === p, 'not your territory')
      expect(me.cards.length < HAND_LIMIT || !findSets(me.cards).length, 'you must trade a set first')
      expect(move.count >= 1 && move.count <= s.toDeploy, 'bad deploy count')
      expect(
        s.mode !== 'supply' || suppliedOf(s, p).has(move.territory),
        'territory is out of supply',
      )
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
      else {
        const b = s.lastBattle!
        logAssault(s, p, move.from, move.to, 1, b.attackerLoss, b.defenderLoss)
      }
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
      if (!captured) logAssault(s, p, from, to, rounds, attackerLoss, defenderLoss)
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
      forceSpoilsTrade(s)
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

  // Recorded only once the move has validated — every `expect` above throws before
  // reaching here, so the list never contains a move the engine rejected. That's
  // what lets a replay assume the whole list applies cleanly.
  if (s.record) s.moves.push(move)
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
  const founder = s.players.find((q) => s.capitals[q.id] === to)
  if (founder) log(s, p, `captured ${founder.name}'s capital, ${name(to)}`, loser)
  else log(s, p, `took ${name(to)} from ${s.players[loser].name}`, loser)
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
  // Cut-off territories wither: a third of the armies above the last one, every
  // turn they stay cut off. Applied before income is counted so the player sees
  // the loss and their reinforcements on the same board. No dice — deterministic
  // attrition is what keeps replays exact.
  if (s.mode === 'supply') {
    const supplied = suppliedOf(s, p)
    let lost = 0
    let tiles = 0
    for (const t of territoriesOf(s, p)) {
      if (supplied.has(t) || s.troops[t] <= 1) continue
      const loss = Math.ceil((s.troops[t] - 1) / 3)
      s.troops[t] -= loss
      lost += loss
      tiles++
    }
    if (lost) log(s, p, `out of supply · lost ${lost} ${lost === 1 ? 'army' : 'armies'} in ${tiles} cut-off ${tiles === 1 ? 'territory' : 'territories'}`)
  }
  s.toDeploy = reinforcementFor(s, p)
  s.conqueredThisTurn = false
  s.canFortify = true
  s.pendingOccupation = null
  // One line per turn instead of one per placement: where the armies went is on
  // the map, and the recap only needs to say how big the turn was.
  const held = continentsHeldBy(s, p)
  log(s, p, `+${s.toDeploy}${held.length ? ` · holds ${held.map((c) => CONTINENTS[c].name).join(', ')}` : ''}`)
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

/**
 * Cards inherited from an eliminated player are cashed on the spot.
 *
 * Spoils are the only way a hand crosses the limit mid-turn, and the surplus
 * can't be carried: you trade down before the attack goes on, and the armies go
 * straight onto the board. That is a deploy, so this re-enters the deploy phase
 * rather than inventing one — `legalMoves` already refuses everything but a trade
 * while the hand is over the limit, and placing the last army hands back to
 * `attack`. Requiring a set as well as the count is what stops that from wedging:
 * an over-limit hand with nothing to cash would be a deploy phase with an empty
 * pool and no legal move.
 *
 * `conqueredThisTurn` distinguishes this deploy from a turn-opening one — it is
 * false for the whole of a normal deploy — which is how the UI can explain the
 * interruption without the state carrying a flag for it.
 */
function forceSpoilsTrade(s: GameState) {
  if (s.phase !== 'attack') return
  const me = s.players[s.current]
  if (me.cards.length < HAND_LIMIT || !findSets(me.cards).length) return
  s.phase = 'deploy'
  log(s, s.current, `holds ${me.cards.length} cards · must trade before attacking on`)
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
  // The capitals win: every founded capital held at once, the founder's own
  // included. Capitals exist for everyone the moment setup ends, so the check is
  // inert until then — and a dead founder's capital still counts.
  const holdsCapitals =
    s.mode === 'capitals' &&
    s.players.every((q) => {
      const cap = s.capitals[q.id]
      return cap !== undefined && s.owner[cap] === s.current
    })
  if (alive.length === 1 || holdsAll || holdsCapitals) {
    s.winner = alive.length === 1 ? alive[0].id : s.current
    s.phase = 'gameOver'
    log(s, s.winner, holdsAll ? 'wins the world' : 'holds every capital')
  }
}
