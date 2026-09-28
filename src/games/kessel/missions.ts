import type { PlayerId } from '../../engine/types'
import { CAMPAIGNS } from './campaigns'
import type { ProvinceId } from './map'
import type { KesselState, UnitType } from './types'

/**
 * A battle rather than a war: its own map at a scale where a pocket is several
 * provinces across, a fixed order of battle, one set of objectives both sides
 * fight over, and a turn limit. Everything else is the war's rules unchanged.
 *
 * Both sides are given the same `aims`, which is what makes the settlement read
 * as the battle: the two shares always sum to one, so whoever holds more than
 * half the objectives' value when time runs out has won it.
 */
export interface Mission {
  /** `name@version` — bump the version whenever an edit would desync a saved move list */
  id: string
  name: string
  date: string
  briefing: string
  mapId: string
  sides: [string, string]
  /** provinces side 0 holds at the start; side 1 holds the rest */
  held: ProvinceId[]
  /** where each side's supply enters the map */
  home: [ProvinceId[], ProvinceId[]]
  /**
   * The order of battle. In a campaign the player's are slots for the army carried
   * in — see `fromMission` — except the ones marked `fresh`, which arrive whatever.
   */
  formations: { side: PlayerId; type: UnitType; at: ProvinceId; strength?: number; fresh?: boolean }[]
  aims: ProvinceId[]
  turns: number
  arrivals?: Arrival[]
  /**
   * A defence: the enemy corps you must destroy for two stars and for three. Set
   * only where the player starts holding every objective — see `starsFor`.
   */
  destroy?: [number, number]
  /**
   * A breakout, a relief or a withdrawal: the player's corps that have to end the
   * battle with a route home, by their index in `formations`, and how many of them
   * for one, two and three stars. Saving the first number wins it, whatever the
   * objectives say — they are there to tempt.
   */
  save?: Save
  /** the side the player takes */
  player: PlayerId
  /** the doctrine the other side fights with, before it has learned anything about you */
  enemy: string
}

export interface Arrival {
  turn: number
  side: PlayerId
  type: UnitType
  /**
   * Where it appears, when not by rail — a reserve that was there all along. Held
   * by its side and with room, or it detrains at the railhead like any other.
   */
  at?: ProvinceId
}

export interface Save {
  pocket: number[]
  stars: [number, number, number]
}

/**
 * A campaign: battles fought in order by one side, the army that comes out of each
 * carried into the next — see `fromMission`. Replayed as a whole, it is scored by the
 * stars across all of them, and it is the campaign that levels, not the battle.
 */
export interface Campaign {
  id: string
  name: string
  /** the side the player takes throughout */
  side: string
  blurb: string
  missions: Mission[]
}

export const MISSIONS: Mission[] = CAMPAIGNS.flatMap((c) => c.missions)

/** The campaign a mission belongs to. */
export const campaignOf = (missionId: string): Campaign =>
  CAMPAIGNS.find((c) => c.missions.some((x) => x.id === missionId)) as Campaign

/**
 * Stars for the side that won: one for any win, three for a decisive one. A loss
 * or a stalemate earns none, so a mission is passed by winning it and mastered by
 * winning it well.
 *
 * A mission with something to save is starred by how much of it got out.
 *
 * A defence starts with every objective in hand, so the margin would hand out three
 * stars for standing still. There holding is one star, and the rest are for making
 * the attack pay — the enemy corps destroyed — or for breaking it outright, which
 * ends the battle before its last turn.
 */
export function starsFor(s: KesselState, side: PlayerId, mission: Mission): number {
  if (s.winner !== side || !s.peace) return 0
  if (mission.save) {
    const saved = s.peace.saved ?? 0
    return saved >= mission.save.stars[2] ? 3 : saved >= mission.save.stars[1] ? 2 : 1
  }
  if (!mission.destroy) return { decisive: 3, clear: 2, narrow: 1, stalemate: 0 }[s.peace.verdict]
  if (s.turnLimit !== undefined && s.turn <= s.turnLimit) return 3
  const destroyed = corpsLost(s, (1 - side) as PlayerId)
  return destroyed >= mission.destroy[1] ? 3 : destroyed >= mission.destroy[0] ? 2 : 1
}

/** Corps `p` has lost outright — destroyed, surrendered or starved — as the log tells it. */
export const corpsLost = (s: KesselState, p: PlayerId) =>
  s.log.filter((l) => l.player === p && /is destroyed|surrenders|starves/.test(l.text)).length

export const starLine = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n)

/** How many times a mission can be mastered before it stops getting harder. */
export const MAX_LEVEL = 3

/**
 * A mission made harder once for every time it has been won decisively: a corps
 * more for the enemy by rail on the second turn, and a turn less to win it in — or,
 * in a defence, a turn more to hold out, since a shorter one is easier. Nothing
 * about the map or the opening changes, so what was learned still applies.
 */
export function levelled(mission: Mission, level: number): Mission {
  if (level <= 0) return mission
  const enemy = (1 - mission.player) as PlayerId
  return {
    ...mission,
    turns: mission.turns + (mission.destroy ? level : -level),
    arrivals: [
      ...(mission.arrivals ?? []),
      ...Array.from({ length: level }, () => ({ turn: 2, side: enemy, type: 'infantry' as const })),
    ],
  }
}

/** A mission's name across versions, which is what progress is kept against. */
export const missionKey = (id: string) => id.split('@')[0]

export const MISSION_BY_ID: Record<string, Mission> = Object.fromEntries(MISSIONS.map((m) => [m.id, m]))

export function missionOf(id: string): Mission {
  const mission = MISSION_BY_ID[id]
  if (!mission) throw new Error(`unknown mission: ${id}`)
  return mission
}

