import { TERRAIN_DEFENCE } from './map'
import type { GameMap, ProvinceId } from './map'
import type { Formation, UnitType } from './types'

const ATTACK_FACTOR: Record<UnitType, number> = { infantry: 1, armour: 1.4, recon: 0.5 }
const DEFEND_FACTOR: Record<UnitType, number> = { infantry: 1.1, armour: 1, recon: 0.5 }

/** Supply state 0–3 to a combat multiplier. Failing supply halves what an army can do. */
const SUPPLY_FACTOR = [0.35, 0.5, 0.9, 1] as const

/** Even a broken formation fights a little, so cohesion scales rather than gates. */
const cohesionFactor = (cohesion: number) => 0.25 + 0.75 * (cohesion / 100)

const entrench = (dug: number) => 1 + Math.min(dug, 3) * 0.1

export const attackValue = (f: Formation): number =>
  f.strength * cohesionFactor(f.cohesion) * SUPPLY_FACTOR[f.supply] * ATTACK_FACTOR[f.type]

export const defendValue = (m: GameMap, f: Formation, where: ProvinceId): number =>
  f.strength *
  cohesionFactor(f.cohesion) *
  SUPPLY_FACTOR[f.supply] *
  DEFEND_FACTOR[f.type] *
  TERRAIN_DEFENCE[m.province[where].terrain] *
  entrench(f.dug)

/** Cohesion a balanced engagement costs each side. */
const BASE_LOSS = 22

/**
 * What it costs to be the one crossing the ground. Without it an assault at even
 * odds is very nearly a fair trade, and combat spends cohesion, which refitting
 * gives back — so attacking would be close to free.
 *
 * It did not measurably move exploitability, which is worth knowing: the line that
 * beats the doctrines is about rushing objectives, not about cheap assaults.
 */
const ASSAULT_PREMIUM = 1.4

/** How far the ratio can swing the bill, either way. */
const SWING = [0.4, 2.2] as const

/**
 * The only randomness in the game, and it is deliberately small: ±15% on the
 * cohesion bill. Combat has to be predictable enough that the reviewer can price
 * a decision instead of narrating a dice roll, and predictable enough that
 * "concentrate and you will win here" is a statement you can act on.
 */
const JITTER = 0.3

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

export interface Engagement {
  ratio: number
  attackerLoss: number
  defenderLoss: number
}

export function resolve(
  m: GameMap,
  attackers: Formation[],
  defenders: Formation[],
  where: ProvinceId,
  rand: () => number,
): Engagement {
  const a = attackers.reduce((n, f) => n + attackValue(f), 0)
  const d = defenders.reduce((n, f) => n + defendValue(m, f, where), 0)
  const ratio = d === 0 ? SWING[1] : a / d

  const jitter = () => 1 - JITTER / 2 + rand() * JITTER
  return {
    ratio,
    attackerLoss: BASE_LOSS * clamp(1 / ratio, ...SWING) * ASSAULT_PREMIUM * jitter(),
    defenderLoss: BASE_LOSS * clamp(ratio, ...SWING) * jitter(),
  }
}

/** Damage that costs a formation one step. */
export const WEAR_PER_STEP = 100

/**
 * Spend cohesion, and convert accumulated damage into step losses. Returns the
 * formation as it stands afterwards; a strength of 0 means it is gone.
 */
export function applyLoss(f: Formation, loss: number): Formation {
  const wear = f.wear + loss
  const steps = Math.floor(wear / WEAR_PER_STEP)
  return {
    ...f,
    cohesion: Math.max(0, f.cohesion - loss),
    wear: wear - steps * WEAR_PER_STEP,
    strength: Math.max(0, f.strength - steps),
    dug: 0,
  }
}
