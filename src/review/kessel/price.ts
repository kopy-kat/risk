/**
 * Pricing a turn of Kessel, without letting the jitter price it for you.
 *
 * Risk prices one move at a time and can do it analytically: the combat tables
 * are exact, so `src/review/price.ts` integrates over the outcome distribution
 * and never rolls anything. Kessel cannot be priced that way and does not need
 * to be, for two reasons.
 *
 * The first is that **the decision is not a move**. A player stages orders for up
 * to twenty-six formations and then presses one button, so the thing they chose
 * is the whole order set. Grading the orders one at a time would report a
 * concentrated assault as three separate mediocre attacks and an encirclement as
 * four moves that each achieved nothing.
 *
 * The second is that a turn resolves as a batch: attacks interact through
 * frontage, through who advances into what, and through whose line of retreat is
 * still open once everyone else has moved. There is no closed form for that. So
 * a candidate is resolved through the engine itself — and resolved several times,
 * under different generator states, and averaged.
 *
 * ── Why averaging is not the same as rolling ──────────────────────
 *
 * The ±15% on the cohesion bill is small and mostly harmless: it moves cohesion by
 * two or three points, which is worth a fortieth of a step. It is *occasionally*
 * enormous, because it decides whether a bill crosses the wear threshold that
 * costs a step, or drives cohesion to zero and pushes a formation off a province
 * it cannot leave. Those are the outcomes worth a corps.
 *
 * A single resolution therefore prices the roll, not the plan. Every candidate is
 * resolved under the *same* set of generator states, so the comparison between
 * them is paired and the common part of the noise cancels. Loss is computed from
 * those averages and never from what actually happened; luck is the difference
 * between what actually happened and that average, and is reported separately.
 * Neither is allowed anywhere near the other.
 */
import type { PlayerId } from '../../engine/types'
import { rngFrom } from '../../engine/rng'
import { attackValue, defendValue, engage } from '../../games/kessel/combat'
import { evaluate } from '../../games/kessel/evaluate'
import { applyMove } from '../../games/kessel/game'
import { DOCTRINES, decideFor } from '../../games/kessel/bot'
import { STACK_LIMIT, mapOf } from '../../games/kessel/map'
import type { GameMap, ProvinceId } from '../../games/kessel/map'
import { depthMap, retreatOptions, supplyStates } from '../../games/kessel/supply'
import type { Formation, FormationId, KesselState, Order } from '../../games/kessel/types'

/** A whole turn's orders — the thing a player actually chose. */
export type OrderSet = Record<FormationId, Order>

/**
 * How many generator states each candidate is resolved under.
 *
 * The jitter is lumpy rather than wide: nearly every resolution lands in the same
 * place and a few land a step or a surrender away. Five is enough to keep one of
 * those from deciding a comparison on its own, and the cost is linear.
 */
export const SAMPLES = 5

/**
 * The force ratio below which an assault is not worth its own cohesion bill.
 *
 * Crossing the ground costs the attacker `ASSAULT_PREMIUM` — a factor of 1.4 —
 * so the two bills balance at about 1.18:1 and an attack below that spends more
 * readiness than it takes. A quarter over the balance point is the margin that
 * pays for the province as well. It is not a doctrine's threshold: the three of
 * them sit at 1.15, 1.30 and 1.35 either side of this, and this is what the rules
 * say rather than what any of them believes.
 */
export const WORTHWHILE_RATIO = 1.25

/**
 * The recurring ways a turn of Kessel is thrown away.
 *
 * Each one is a real operational lesson and — the part that matters — each one is
 * priced by its own counterfactual rather than by an attribution. Every fault
 * below has a candidate order set that fixes *only* that, so "this cost you 4.2"
 * means "your own orders with this one thing changed were worth 4.2 more", which
 * is a claim the player can check by looking at the board.
 */
export type KesselFault =
  | 'thin-odds'
  | 'culmination'
  | 'idle-strained'
  | 'missed-pocket'
  | 'exposed'
  | 'dispersal'

export const KESSEL_FAULT_LABEL: Record<KesselFault, string> = {
  'thin-odds': 'attacking below the odds that pay',
  culmination: 'advancing past your own supply',
  'idle-strained': 'leaving formations idle out of supply',
  'missed-pocket': 'leaving the last way out open',
  exposed: 'standing where you cannot fall back',
  dispersal: 'attacking in too many places at once',
}

/**
 * One order set worth comparing against, and what it was meant to show.
 *
 * A candidate is either a whole alternative plan — what a doctrine would have
 * ordered from the same board — or the player's own orders with one thing
 * changed. The second kind is what turns a score into advice: "this, but without
 * the attack on Kiev" is something to do differently, and "Maneuver was worth six
 * more" is not.
 */
export interface Candidate {
  key: string
  /** how the review names it */
  label: string
  orders: OrderSet
  /** the fault this candidate exists to price, when it is a fix for one */
  fault: KesselFault | null
  /** the instruction, when it is a fix */
  advice: string
  value: number
}

/** One assault, grouped and capped exactly the way `resolveTurn` will do it. */
export interface Assault {
  to: ProvinceId
  /** everyone ordered in, before the frontage cap */
  sent: Formation[]
  /** the ones the borders admit — what the engine will actually fight with */
  committed: Formation[]
  defenders: Formation[]
  ratio: number
  /** defenders with nowhere to fall back to: an assault that kills rather than pushes */
  trapped: number
}

/**
 * Generator states to resolve a candidate under.
 *
 * Derived from the turn rather than drawn, so a game reviews identically however
 * often it is opened — and shared across every candidate at one decision, so the
 * comparison between them is paired.
 */
export function seedsFor(base: number): number[] {
  const out: number[] = []
  for (let k = 1; k <= SAMPLES; k++) out.push(Math.imul(base + k, 2654435761) | 0)
  return out
}

/**
 * The board this order set produces, under one generator state.
 *
 * `record` is off and the log is dropped: a hypothetical turn is scored, never
 * replayed or read back, and copying a long game's move list for each of sixty
 * resolutions a turn is the whole cost of doing it the expensive way.
 */
export function resolveOnce(s: KesselState, orders: OrderSet, seed: number): KesselState {
  return applyMove(
    { ...s, orders, rngState: seed, record: false, moves: [], log: [] },
    { type: 'commit' },
  )
}

/** What an order set is worth, averaged over the jitter rather than exposed to it. */
export function valueOf(
  s: KesselState,
  orders: OrderSet,
  me: PlayerId,
  seeds: number[],
): number {
  let sum = 0
  for (const seed of seeds) sum += evaluate(resolveOnce(s, orders, seed), me)
  return sum / seeds.length
}

/**
 * What a doctrine would have ordered from this same board.
 *
 * Played out order by order through `applyMove`, because `decideFor` reads the
 * orders staged so far — an assault is several formations agreeing on a target,
 * and a doctrine asked for twenty-six independent opinions would never mass.
 */
export function doctrineOrders(
  doctrine: (typeof DOCTRINES)[number],
  s: KesselState,
  me: PlayerId,
  rand: () => number,
): OrderSet {
  let cur: KesselState = { ...s, orders: {}, record: false, moves: [], log: [] }
  const cap = cur.formations.length + 4
  for (let i = 0; i < cap; i++) {
    let move
    try {
      move = decideFor(doctrine, cur, me, rand)
    } catch {
      break
    }
    if (move.type !== 'order') break
    try {
      cur = applyMove(cur, move)
    } catch {
      // A doctrine that offers something illegal contributes the orders it had
      // already given rather than nothing — the alternative is silently dropping
      // a whole candidate and comparing the player against a shorter list.
      break
    }
  }
  return cur.orders
}

/** Attacks as the engine will group them: by target, capped by the frontage between. */
export function assaultsIn(
  m: GameMap,
  s: KesselState,
  orders: OrderSet,
  me: PlayerId,
): Assault[] {
  const byTarget = new Map<ProvinceId, Formation[]>()
  for (const f of s.formations) {
    if (f.owner !== me) continue
    const order = orders[f.id]
    if (order?.type !== 'attack') continue
    byTarget.set(order.to, [...(byTarget.get(order.to) ?? []), f])
  }

  const out: Assault[] = []
  for (const [to, sent] of byTarget) {
    const defenders = s.formations.filter((f) => f.at === to && f.owner !== me)
    if (defenders.length === 0) continue
    const committed = engage(m, sent, to)
    const ours = committed.reduce((n, f) => n + attackValue(f), 0)
    const theirs = defenders.reduce((n, f) => n + defendValue(m, f, to), 0)
    out.push({
      to,
      sent,
      committed,
      defenders,
      ratio: theirs === 0 ? Infinity : ours / theirs,
      trapped: defenders.filter((f) => retreatOptions(m, s, f).length === 0).length,
    })
  }
  return out
}

/**
 * The board this turn's *moves* would produce, before anyone fights on it.
 *
 * Supply is drawn on the ground you end the turn standing on, so this is what a
 * culminating point has to be measured against: a spearhead that outruns its
 * trucks has done so the moment it arrives, not after the battle.
 */
export function projectMoves(s: KesselState, orders: OrderSet): KesselState {
  const owner = { ...s.owner }
  const formations = s.formations.map((f) => {
    const order = orders[f.id]
    if (order?.type !== 'move') return f
    owner[order.to] = f.owner
    return { ...f, at: order.to }
  })
  return { ...s, owner, formations }
}

// ───────────────────────── the alternatives ─────────────────────────

/** Orders that leave a formation free to be given a different one. */
const idle = (o: Order | undefined) => !o || o.type === 'hold' || o.type === 'refit'

const withOrder = (orders: OrderSet, id: FormationId, order: Order): OrderSet => ({
  ...orders,
  [id]: order,
})

const adjacentEnemy = (m: GameMap, s: KesselState, f: Formation): boolean =>
  (m.adjacency[f.at] ?? []).some((n) => s.formations.some((x) => x.at === n && x.owner !== f.owner))

const roomAt = (m: GameMap, s: KesselState, p: ProvinceId): number =>
  STACK_LIMIT[m.province[p].terrain] - s.formations.filter((f) => f.at === p).length

/**
 * Where a formation already inside a closed ring can still go.
 *
 * A pocket is closed against *retreat*, which needs ground you hold — but a
 * formation can still be ordered forward into empty ground the enemy owns, and
 * moving there takes it. Breaking out is sometimes the only order left.
 */
function breakoutFor(m: GameMap, s: KesselState, f: Formation): ProvinceId | null {
  for (const n of m.adjacency[f.at] ?? []) {
    if (s.formations.some((x) => x.at === n && x.owner !== f.owner)) continue
    if (roomAt(m, s, n) <= 0) continue
    return n
  }
  return null
}

/**
 * Cohesion below which a formation out of supply and out of contact is wasting
 * the turn. Above it a refit buys little and holding may be worth the entrenchment.
 */
const IDLE_COHESION = 75

/** How many separate targets makes a turn worth asking the concentration question about. */
const DISPERSAL_TARGETS = 3

/**
 * The player's own orders with one thing put right, one candidate per thing.
 *
 * These are the whole reason the reviewer can say anything useful. A doctrine's
 * plan says the turn could have gone better; a perturbation says *what to change*,
 * and because it differs from what was played in exactly one respect, the gap
 * between the two prices that one respect and nothing else.
 */
export function perturbations(
  m: GameMap,
  s: KesselState,
  played: OrderSet,
  me: PlayerId,
): Omit<Candidate, 'value'>[] {
  const out: Omit<Candidate, 'value'>[] = []
  const name = (p: ProvinceId) => m.province[p].name
  const assaults = assaultsIn(m, s, played, me)

  // ── attacking below the odds that pay ──
  // A ring already closed is worth forcing at any odds — beaten there, a formation
  // surrenders — so an assault on a defender with nowhere to go is never thin.
  const thin = assaults
    .filter((a) => a.ratio < WORTHWHILE_RATIO && a.trapped === 0)
    .sort((a, b) => a.ratio - b.ratio)
  const holdAll = (orders: OrderSet, sent: Formation[]) =>
    sent.reduce((acc, f) => withOrder(acc, f.id, { type: 'hold' }), orders)

  for (const a of thin.slice(0, 3)) {
    out.push({
      key: `drop:${a.to}`,
      label: `your orders without the attack on ${name(a.to)}`,
      orders: holdAll(played, a.sent),
      fault: 'thin-odds',
      advice: `Call off ${name(a.to)} — it went in at ${a.ratio.toFixed(2)}:1, under the ${WORTHWHILE_RATIO.toFixed(
        2,
      )}:1 an assault has to clear to pay for itself.`,
    })
  }
  if (thin.length > 1) {
    out.push({
      key: 'drop:all',
      label: `your orders without the ${thin.length} thin attacks`,
      orders: thin.reduce((acc, a) => holdAll(acc, a.sent), played),
      fault: 'thin-odds',
      advice: `Call off all ${thin.length} attacks under ${WORTHWHILE_RATIO.toFixed(2)}:1 and hold the line instead.`,
    })
  }

  // ── the culminating point ──
  // Measured on the board the moves produce, not on the one they left: what a
  // formation draws is decided by where it ends the turn.
  const after = supplyStates(m, projectMoves(s, played), me)
  const culminating = s.formations.filter((f) => {
    const order = played[f.id]
    return order?.type === 'move' && f.supply >= 3 && (after[f.id] ?? 3) < 3
  })
  if (culminating.length > 0) {
    const first = culminating[0]
    const to = (played[first.id] as { to: ProvinceId }).to
    out.push({
      key: 'culminate',
      label: `your orders without the ${culminating.length > 1 ? 'advances' : 'advance'} that outrun supply`,
      orders: culminating.reduce((acc, f) => withOrder(acc, f.id, { type: 'hold' }), played),
      fault: 'culmination',
      advice:
        culminating.length > 1
          ? `${culminating.length} formations arrive short of full supply, ${name(first.at)} → ${name(
              to,
            )} among them, and cannot attack from where they land.`
          : `${name(first.at)} → ${name(to)} arrives short of full supply and cannot attack from there.`,
    })
  }

  // ── strained and idle: refit it ──
  // Refitting is worth eighteen points of cohesion over standing still, and a
  // formation that cannot attack and has nobody to hold against is giving up
  // exactly that for nothing.
  const strained = s.formations.filter(
    (f) =>
      f.owner === me &&
      f.supply <= 2 &&
      f.cohesion < IDLE_COHESION &&
      idle(played[f.id]) &&
      !adjacentEnemy(m, s, f),
  )
  if (strained.length > 0) {
    out.push({
      key: 'refit',
      label: `your orders with ${strained.length} strained ${strained.length > 1 ? 'formations' : 'formation'} refitting`,
      orders: strained.reduce((acc, f) => withOrder(acc, f.id, { type: 'refit' }), played),
      fault: 'idle-strained',
      advice: `Refit ${name(strained[0].at)}${
        strained.length > 1 ? ` and ${strained.length - 1} more` : ''
      } — out of supply, out of contact and spending the turn on nothing.`,
    })
  }

  // ── strained and idle: walk it back down the chain ──
  //
  // The other half of the same fault, and the more expensive one. A formation
  // whose chain has failed is not merely unable to attack, it is decaying where
  // it stands — and supply is drawn on the ground you end the turn on, so one
  // province back toward the railhead is an order, not a plan.
  const depth = depthMap(m, s, me)
  const stranded = s.formations
    .map((f) => {
      if (f.owner !== me || f.supply > 1 || !idle(played[f.id])) return null
      const back = (m.adjacency[f.at] ?? [])
        .filter((n) => s.owner[n] === me && depth[n] < depth[f.at] && roomAt(m, s, n) > 0)
        .filter((n) => !s.formations.some((x) => x.at === n && x.owner !== me))
        .sort((a, b) => depth[a] - depth[b])[0]
      return back ? { f, back } : null
    })
    .filter((x): x is { f: Formation; back: ProvinceId } => x !== null)
  if (stranded.length > 0) {
    const first = stranded[0]
    out.push({
      key: 'unstrand',
      label: `your orders with ${stranded.length} ${stranded.length > 1 ? 'formations' : 'formation'} pulled back into supply`,
      orders: stranded.reduce((acc, x) => withOrder(acc, x.f.id, { type: 'move', to: x.back }), played),
      fault: 'idle-strained',
      advice: `${name(first.f.at)} has outrun its supply and is standing still in it. ${name(
        first.back,
      )} is one province back down the chain${
        stranded.length > 1 ? `, and ${stranded.length - 1} more are in the same position` : ''
      }.`,
    })
  }

  // ── the pocket you didn't close ──
  for (const e of nearlyTrapped(m, s, me).slice(0, 2)) {
    const closer = s.formations
      .filter(
        (f) =>
          f.owner === me &&
          (m.adjacency[f.at] ?? []).includes(e.escape) &&
          roomAt(m, s, e.escape) > 0 &&
          idle(played[f.id]),
      )
      .sort((a, b) => b.strength - a.strength)[0]
    // Somebody already standing in the last way out closes it for free; only an
    // opening nobody was sent to is a miss.
    if (!closer) continue
    if (Object.values(played).some((o) => o.type === 'move' && o.to === e.escape)) continue
    out.push({
      key: `pocket:${e.formation.id}`,
      label: `your orders, plus closing ${name(e.escape)}`,
      orders: withOrder(played, closer.id, { type: 'move', to: e.escape }),
      fault: 'missed-pocket',
      advice: `The corps in ${name(e.formation.at)} had one way out — ${name(
        e.escape,
      )} — and ${name(
        closer.at,
      )} could have stood in it. Beaten in a pocket, a formation surrenders instead of falling back.`,
    })
  }

  // ── standing where you cannot fall back ──
  //
  // Deliberately narrow. On a dense front nearly every formation in contact has
  // exactly one road behind it, so flagging that flags the whole line every turn
  // — and prices it, because pulling a line back costs nothing at one ply that
  // the enemy has not yet done. A habit reported wrongly is worse than one left
  // out, so this is the ring already closed and nothing else: in contact, no line
  // of retreat at all, and a way out still open because the ground beyond it is
  // empty.
  const escapes = s.formations
    .map((f) => {
      if (f.owner !== me || !idle(played[f.id])) return null
      if (!adjacentEnemy(m, s, f)) return null
      if (retreatOptions(m, s, f).length > 0) return null
      const to = breakoutFor(m, s, f)
      return to ? { f, to } : null
    })
    .filter((x): x is { f: Formation; to: ProvinceId } => x !== null)
  if (escapes.length > 0) {
    const first = escapes[0]
    out.push({
      key: 'withdraw',
      label: `your orders with ${escapes.length} encircled ${escapes.length > 1 ? 'formations' : 'formation'} broken out`,
      orders: escapes.reduce((acc, e) => withOrder(acc, e.f.id, { type: 'move', to: e.to }), played),
      fault: 'exposed',
      advice: `The corps in ${name(
        first.f.at,
      )} is in contact with no line of retreat, so the next assault it loses destroys it outright rather than pushing it back. ${name(
        first.to,
      )} is still open.`,
    })
  }

  // ── attacking in too many places at once ──
  if (assaults.length >= DISPERSAL_TARGETS) {
    const best = [...assaults].sort((a, b) => b.ratio - a.ratio)[0]
    let orders = played
    let redirected = 0
    for (const a of assaults) {
      if (a.to === best.to) continue
      for (const f of a.sent) {
        const canJoin =
          f.supply >= 3 &&
          (m.adjacency[f.at] ?? []).includes(best.to) &&
          f.at !== best.to
        orders = withOrder(orders, f.id, canJoin ? { type: 'attack', to: best.to } : { type: 'hold' })
        if (canJoin) redirected++
      }
    }
    out.push({
      key: 'concentrate',
      label: `everything you sent, aimed at ${name(best.to)}`,
      orders,
      fault: 'dispersal',
      advice: `You attacked ${assaults.length} provinces at once. ${
        redirected > 0
          ? `${redirected} of those formations could have gone in at ${name(best.to)} instead`
          : `Only ${name(best.to)} was worth forcing`
      } — mass has to be aimed, not merely amassed.`,
    })
  }

  return out
}

export interface NearPocket {
  formation: Formation
  /** the single province it can still fall back to */
  escape: ProvinceId
}

/** Enemy formations one order away from having nowhere to go. */
export function nearlyTrapped(m: GameMap, s: KesselState, me: PlayerId): NearPocket[] {
  const out: NearPocket[] = []
  for (const f of s.formations) {
    if (f.owner === me) continue
    const ways = retreatOptions(m, s, f)
    if (ways.length === 1) out.push({ formation: f, escape: ways[0] })
  }
  return out.sort((a, b) => b.formation.strength - a.formation.strength)
}

/**
 * Everything worth comparing this turn's orders against, priced.
 *
 * Three whole plans and a handful of one-change edits. The played set is priced
 * on the same seeds as the rest, so it is compared against them and not against
 * what the dice happened to do to it.
 */
export function priceTurn(
  s: KesselState,
  played: OrderSet,
  me: PlayerId,
  base: number,
): { played: Candidate; candidates: Candidate[] } {
  const m = mapOf(s.mapId)
  const seeds = seedsFor(base)
  // Seeded off the turn, so a doctrine's own coin flips are the same every time
  // this game is opened.
  const rng = rngFrom((base ^ 0x5eed) | 0)
  const rand = () => rng.next()

  const yours: Candidate = {
    key: 'played',
    label: 'your orders',
    orders: played,
    fault: null,
    advice: '',
    value: valueOf(s, played, me, seeds),
  }

  const rest: Omit<Candidate, 'value'>[] = [
    ...DOCTRINES.map((d) => ({
      key: `doctrine:${d.key}`,
      label: `${d.name}'s orders`,
      orders: doctrineOrders(d, s, me, rand),
      fault: null,
      advice: '',
    })),
    ...perturbations(m, s, played, me),
  ]

  const candidates = rest.map((c) => ({ ...c, value: valueOf(s, c.orders, me, seeds) }))
  return { played: yours, candidates }
}
