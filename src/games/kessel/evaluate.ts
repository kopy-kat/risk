/**
 * What a position is worth, from one side's point of view.
 *
 * The bots score *moves* — a ratio here, a choke point there — which is enough to
 * choose an order and not enough to compare two whole turns. Pricing a decision
 * needs a number for the board it produces, so this is that number.
 *
 * ── The unit ──────────────────────────────────────────────────────
 *
 * One **step** of a fully supplied formation. Everything below is quoted against
 * it, which is what makes a review's "you gave up 6 steps" checkable against
 * experience: a corps is three or four steps, so six is two corps' worth of
 * position and half a step is nothing.
 *
 * Nothing here is fitted. The weights are set by argument from the rules and left
 * alone; `npm run review-check:kessel` says whether the result can tell a strong
 * doctrine from a weak one, which is the only claim being made for them.
 */
import type { PlayerId } from '../../engine/types'
import { mapOf } from './map'
import type { GameMap, ProvinceId } from './map'
import { retreatOptions, supplyStates } from './supply'
import type { KesselState } from './types'

/**
 * Winning, in steps. Large enough that no positional consideration outbids it and
 * finite so that differences either side of it still mean something.
 */
export const WIN_SCORE = 2000

/**
 * What a step is worth at each supply state, 0–3.
 *
 * Steeper than combat's own supply multiplier, and deliberately: combat asks what
 * a formation can do this afternoon, a position has to price what it is still
 * going to be. A cut-off corps is not a third of an army, it is an army with a
 * week to live.
 */
const SUPPLY_WORTH = [0.3, 0.6, 0.9, 1] as const

/**
 * Full cohesion, per step of the formation carrying it.
 *
 * Half of what the step itself is worth, and per step rather than per formation
 * because a broken armoured corps has more to get back than a broken recon
 * screen. Under the step, because cohesion comes back and strength does not; not
 * far under, because the combat table has a formation at nothing fighting at a
 * quarter of its power and being pushed off the first province anyone asks it
 * about.
 */
const COHESION_VALUE = 0.5

/**
 * Being at full supply, per formation.
 *
 * Anything less cannot start an attack at all. That is a cliff rather than a
 * slope, so scaling strength by supply does not capture it: two armies of equal
 * material where only one can move first are not equal positions.
 */
const READY_VALUE = 0.5

/**
 * One point of objective value inside your own war aims.
 *
 * This is the win condition, so it dominates: a side's six aims run to about
 * fifteen points, which at this weight is worth more than twice its whole army.
 * That is the intended shape — you can win a war you did not conquer, and an
 * evaluation that priced corps above aims would advise the opposite.
 */
const AIM_VALUE = 14

/**
 * One point of objective value held anywhere.
 *
 * Small, because ground off your aims only decides the peace when the aims tie —
 * but not zero, because that tiebreak is real and because ground is where aims
 * are reached from.
 */
const GROUND_VALUE = 0.8

/**
 * Closing on a war aim you do not hold: steps per point of objective value, at
 * the moment your ground reaches it.
 *
 * Aims held is the win condition and it dominates — but it is also a step
 * function, and a position made only of step functions has no gradient between
 * them. Without this, an army that spent the war at home scores exactly as well
 * as one that has fought to the edge of everything it wants, and every advance
 * that does not itself capture an objective reads as ground taken for nothing.
 * That is the difference between a doctrine that wins and one that does not, so
 * it has to be in here somewhere.
 *
 * Measured from the ground the side holds rather than from its nearest formation,
 * which would make sending one recon corps toward an objective worth as much as
 * bringing the front to it.
 */
const AIM_REACH = 1

/** Provinces beyond which an objective is not being approached, it is merely somewhere. */
const AIM_HORIZON = 10

/**
 * A province held, objective value or none.
 *
 * Most of the map scores nothing at the peace, so an evaluation that counted only
 * objective value would price four fifths of Europe at zero and rate giving it
 * away as free. Ground is the supply network: a chain traces through provinces
 * you hold and stops at ones you do not, which is why a front that has been
 * pushed back is a front drawing on a longer road.
 */
const PROVINCE_VALUE = 0.4

/**
 * A turn spent dug in, per level, to a ceiling of three.
 *
 * Entrenchment multiplies defence by up to 1.3 and is lost the moment a formation
 * moves. Without it a position where the line has stood and prepared scores the
 * same as one where it has just arrived, and pulling a formation out of the line
 * would read as costless.
 */
const DUG_VALUE = 0.3

/**
 * One point of will.
 *
 * Will is the clock on the whole war: at the floor a side can only ask for terms.
 * Half a step a point puts the seventy-five point band at about the worth of an
 * army, which is the right order — losing your army and losing the country's
 * appetite for the war should cost about the same.
 *
 * It double-counts casualties on purpose. A formation lost costs its steps *and*
 * four points of will, because it costs the army a corps and the country a
 * reason to go on.
 */
const WILL_VALUE = 0.5

/**
 * What a formation with no line of retreat, and with exactly one, costs its owner
 * beyond the ground it stands on — as a fraction of its strength.
 *
 * Beaten in a pocket a formation is gone outright and leaves no cadre, so a ring
 * already closed is nearly the whole corps. One way out is a ring one order from
 * closing, worth about half of that: the difference between a threat and a fact.
 *
 * Charged against the side that is trapped, so it reads the same from both ends —
 * being nearly surrounded is exactly as bad for you as it is good for them — and
 * only where an enemy is adjacent to press it. The rules already take that view of
 * starvation, and without the gate a corps standing in a quiet corner of the map
 * with one road out is scored as though it were in a pocket.
 *
 * The second figure is small on purpose, and it is measured rather than assumed —
 * `npm run review-check:kessel` is where it shows. On a dense front nearly every
 * formation in contact has one road back,
 * so a heavy charge there says "your whole line is in danger" every turn — and
 * makes withdrawing it look free, which at one ply it is, because the enemy has
 * not walked into the gap yet. A threat one order from being answered is worth a
 * tenth of the corps; only a ring already closed is worth the corps.
 */
const TRAP_CREDIT = [0.85, 0.12] as const

/**
 * How much of that a formation at *full* cohesion carries.
 *
 * A ring only kills what it can beat: a formation surrenders when it is driven to
 * zero cohesion with nowhere to go, and a fresh corps in good ground takes three
 * or four engagements to get there. Charging the whole corps against a full-
 * strength formation the moment it loses its last road says the pincer that
 * closed the ring is itself doomed — which made closing one score as a mistake,
 * in a game whose entire thesis is that closing one wins.
 */
const TRAP_WHEN_FRESH = 0.25

/** What a formation in a ring is worth to the side that closed it. */
const trapCost = (strength: number, cohesion: number, ways: number) =>
  TRAP_CREDIT[ways] *
  strength *
  (TRAP_WHEN_FRESH + (1 - TRAP_WHEN_FRESH) * (1 - Math.max(0, Math.min(100, cohesion)) / 100))

export interface Assessment {
  /** objective value of the war aims this side holds */
  aims: number
  /** how close this side's ground has come to the aims it does not hold */
  reach: number
  /** objective value held anywhere on the map */
  ground: number
  /** provinces held, whatever they score at the peace */
  provinces: number
  /** strength, discounted by what supply lets it be */
  force: number
  cohesion: number
  /** formations that could start an attack */
  ready: number
  /** turns spent preparing the ground the line is standing on */
  dug: number
  will: number
  /** debit: this side's own formations at or near a pocket */
  trapped: number
  score: number
}

/**
 * One side's position, in steps.
 *
 * `supply` is passed in rather than read off the formations. The `supply` field is
 * only refreshed for the side about to move, so after a turn resolves the mover's
 * own formations still carry what they drew *before* they advanced — which is
 * exactly the reading that hides a culminating point.
 */
export function assess(
  m: GameMap,
  s: KesselState,
  p: PlayerId,
  supply: Record<number, number>,
): Assessment {
  const side = s.sides[p]
  const aims = side.aims.reduce((n, id) => n + (s.owner[id] === p ? m.province[id].vp : 0), 0)
  let ground = 0
  let provinces = 0
  for (const id of m.ids) {
    if (s.owner[id] !== p) continue
    provinces++
    ground += m.province[id].vp
  }

  const away = side.aims.some((id) => s.owner[id] !== p) ? distanceFromHeld(m, s, p) : null
  const reach = away
    ? side.aims.reduce((n, id) => {
        if (s.owner[id] === p) return n
        const closeness = Math.max(0, (AIM_HORIZON - away[id]) / AIM_HORIZON)
        return n + m.province[id].vp * closeness
      }, 0)
    : 0

  const enemyAt = new Set(s.formations.filter((f) => f.owner !== p).map((f) => f.at))
  const pressed = (at: ProvinceId) => (m.adjacency[at] ?? []).some((n) => enemyAt.has(n))

  let force = 0
  let cohesion = 0
  let ready = 0
  let dug = 0
  let trapped = 0
  for (const f of s.formations) {
    if (f.owner !== p) continue
    const sup = supply[f.id] ?? f.supply
    force += f.strength * SUPPLY_WORTH[sup]
    cohesion += (f.cohesion / 100) * f.strength * COHESION_VALUE
    if (sup >= 3) ready += READY_VALUE
    dug += Math.min(f.dug, 3) * DUG_VALUE
    if (!pressed(f.at)) continue
    const ways = retreatOptions(m, s, f).length
    if (ways < TRAP_CREDIT.length) trapped += trapCost(f.strength, f.cohesion, ways)
  }

  return {
    aims,
    reach,
    ground,
    provinces,
    force,
    cohesion,
    ready,
    dug,
    will: side.will,
    trapped,
    score:
      aims * AIM_VALUE +
      reach * AIM_REACH +
      ground * GROUND_VALUE +
      provinces * PROVINCE_VALUE +
      force +
      cohesion +
      ready +
      dug +
      side.will * WILL_VALUE -
      trapped,
  }
}

/** How many provinces of somebody else's ground lie between this side and each province. */
function distanceFromHeld(m: GameMap, s: KesselState, p: PlayerId): Record<ProvinceId, number> {
  const dist: Record<ProvinceId, number> = {}
  const queue: ProvinceId[] = []
  for (const id of m.ids) {
    if (s.owner[id] === p) {
      dist[id] = 0
      queue.push(id)
    } else dist[id] = Infinity
  }
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]
    for (const n of m.adjacency[at] ?? []) {
      if (dist[n] !== Infinity) continue
      dist[n] = dist[at] + 1
      queue.push(n)
    }
  }
  return dist
}

/**
 * The position in steps, from `me`'s point of view: what this side has, less what
 * the other one has.
 *
 * Two sides, so the difference is the whole story — none of Risk's argument about
 * dividing a rival's score between everyone still standing applies here.
 */
export function evaluate(s: KesselState, me: PlayerId): number {
  if (s.winner !== null) return s.winner === me ? WIN_SCORE : -WIN_SCORE
  // A war that ended with nobody ahead is worth nothing to either side, whatever
  // the line looks like: the peace has already been scored and it was a draw.
  if (s.phase === 'gameOver') return 0

  const m = mapOf(s.mapId)
  const them = (1 - me) as PlayerId
  return assess(m, s, me, supplyStates(m, s, me)).score -
    assess(m, s, them, supplyStates(m, s, them)).score
}
