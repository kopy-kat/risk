import bastogne from '../../../data/maps/bastogne.json'
import kiev from '../../../data/maps/kiev.json'
import uranus from '../../../data/maps/uranus.json'
import sedan from '../../../data/maps/sedan.json'
import type { PlayerId } from '../../engine/types'
import { registerMap } from './map'
import type { MapData, ProvinceId } from './map'
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
  formations: { side: PlayerId; type: UnitType; at: ProvinceId; strength?: number }[]
  aims: ProvinceId[]
  turns: number
  arrivals?: Arrival[]
  /**
   * A defence: the enemy corps you must destroy for two stars and for three. Set
   * only where the player starts holding every objective — see `starsFor`.
   */
  destroy?: [number, number]
  /** the side the player takes */
  player: PlayerId
  /** the doctrine the other side fights with, before it has learned anything about you */
  enemy: string
}

export interface Arrival {
  turn: number
  side: PlayerId
  type: UnitType
}

const inf = (side: PlayerId, at: ProvinceId, strength?: number) => ({ side, type: 'infantry' as const, at, strength })
const arm = (side: PlayerId, at: ProvinceId) => ({ side, type: 'armour' as const, at })
const rec = (side: PlayerId, at: ProvinceId) => ({ side, type: 'recon' as const, at })

export const MISSIONS: Mission[] = [
  {
    id: 'sedan@1',
    name: 'Sedan',
    date: 'May 1940',
    briefing:
      'The Allies have marched their best armies north into Belgium to meet you on the plain. ' +
      'Behind them the Ardennes is held by little, and the Meuse at Sedan by less. Break through ' +
      'the forest, cross the river, and drive for the Channel before they turn round — every ' +
      'objective you hold at the end is theirs cut off from France.',
    mapId: 'sedan',
    sides: ['Germany', 'Allies'],
    held: ['duisburg', 'bonn', 'koblenz', 'wittlich', 'kaiserslautern', 'cologne', 'dusseldorf', 'venlo', 'eindhoven', 'maastricht', 'aachen', 'prum', 'bitburg', 'trier', 'saarbrucken', 'luxembourg'],
    home: [['duisburg', 'koblenz', 'kaiserslautern'], ['paris', 'meaux', 'calais', 'dunkirk', 'boulogne']],
    formations: [
      arm(0, 'luxembourg'),
      arm(0, 'luxembourg'),
      arm(0, 'bitburg'),
      arm(0, 'bitburg'),
      arm(0, 'prum'),
      arm(0, 'prum'),
      rec(0, 'luxembourg'),
      inf(0, 'aachen'),
      inf(0, 'aachen'),
      inf(0, 'maastricht'),
      inf(0, 'maastricht'),
      inf(0, 'eindhoven'),
      inf(0, 'trier'),
      inf(0, 'trier'),
      inf(0, 'saarbrucken'),

      inf(1, 'antwerp'),
      inf(1, 'antwerp'),
      inf(1, 'hasselt'),
      arm(1, 'hasselt'),
      inf(1, 'liege', 2),
      inf(1, 'brussels'),
      rec(1, 'stvith'),
      rec(1, 'bastogne'),
      inf(1, 'dinant', 2),
      inf(1, 'sedan', 2),
      inf(1, 'metz'),
      arm(1, 'reims'),
    ],
    aims: ['brussels', 'antwerp', 'sedan', 'amiens', 'abbeville', 'calais'],
    turns: 12,
    player: 0,
    enemy: 'attrition',
  },
  {
    id: 'kiev@2',
    name: 'Kiev',
    date: 'September 1941',
    briefing:
      'Five Soviet armies stand on the Dnieper around Kyiv, and Stalin has forbidden them to ' +
      'fall back. Your panzers are at both ends of the line — Guderian in the north at ' +
      'Novhorod-Siverskyi, Kleist in the south at the Kremenchuk bridgehead. Drive them towards ' +
      'each other and meet behind Kyiv before the autumn mud. The city is only one objective: ' +
      'most of the value is the ring itself — Lokhvytsia, where the pincers meet, and Romny, ' +
      'Lubny and Pryluky that close it. Keep the roads behind your panzers held, or the ring ' +
      'closes on them instead.',
    mapId: 'kiev',
    sides: ['Germany', 'Soviet Union'],
    held: [
      'gomel', 'mozyr', 'starodub', 'horodnia', 'novhorod', 'shostka',
      'ovruch', 'malyn', 'irpin', 'zhytomyr', 'berdychiv', 'fastiv', 'bilatserkva', 'vinnytsia', 'uman',
      'korsun', 'zvenyhorodka', 'novomyrhorod', 'kirovohrad', 'oleksandriia', 'chyhyryn', 'kremenchuk',
    ],
    home: [['gomel', 'starodub', 'zhytomyr', 'vinnytsia', 'kirovohrad'], ['sumy', 'lebedyn', 'okhtyrka', 'karlivka', 'poltava']],
    formations: [
      arm(0, 'novhorod'),
      arm(0, 'novhorod'),
      arm(0, 'shostka'),
      rec(0, 'shostka'),
      inf(0, 'horodnia'),
      inf(0, 'gomel'),
      inf(0, 'malyn'),
      inf(0, 'irpin'),
      inf(0, 'fastiv'),
      inf(0, 'bilatserkva'),
      arm(0, 'kremenchuk'),
      arm(0, 'kremenchuk'),
      inf(0, 'chyhyryn'),
      inf(0, 'korsun'),

      inf(1, 'kyiv'),
      inf(1, 'kyiv'),
      inf(1, 'chernobyl'),
      inf(1, 'boryspil'),
      inf(1, 'chernihiv'),
      inf(1, 'mena'),
      inf(1, 'konotop'),
      inf(1, 'hlukhiv', 2),
      inf(1, 'kaniv'),
      inf(1, 'cherkasy'),
      inf(1, 'semenivka'),
      inf(1, 'kobeliaky', 2),
      arm(1, 'pryluky'),
      rec(1, 'lubny'),
      inf(1, 'poltava'),
      inf(1, 'nizhyn'),
      inf(1, 'sumy'),
    ],
    aims: ['kyiv', 'lokhvytsia', 'romny', 'lubny', 'pryluky'],
    turns: 10,
    arrivals: [
      { turn: 3, side: 1, type: 'infantry' },
      { turn: 5, side: 1, type: 'armour' },
    ],
    player: 0,
    enemy: 'attrition',
  },
  {
    id: 'bastogne@1',
    name: 'Bastogne',
    date: 'December 1944',
    briefing:
      'Out of the fog, three German armies have fallen on the quietest sector of your line: ' +
      'four tired divisions spread along the Our. They are going for the Meuse bridges at ' +
      'Dinant and Huy, and for Liège behind them, through the two road hubs they cannot go ' +
      'round — St-Vith and Bastogne. Hold what you can, give ground where you must, and ' +
      'make them pay for every road: help is coming by rail from the north and from Patton ' +
      'in the south, and their fuel will not last.',
    mapId: 'bastogne',
    sides: ['Germany', 'United States'],
    held: ['schleiden', 'blankenheim', 'losheim', 'prum', 'gerolstein', 'dasburg', 'bitburg', 'trier'],
    home: [['blankenheim', 'gerolstein', 'trier'], ['liege', 'namur', 'aachen', 'luxembourg', 'sedan']],
    formations: [
      arm(0, 'schleiden'),
      arm(0, 'blankenheim'),
      arm(0, 'losheim'),
      rec(0, 'losheim'),
      inf(0, 'schleiden'),
      inf(0, 'blankenheim'),
      arm(0, 'prum'),
      arm(0, 'dasburg'),
      arm(0, 'dasburg'),
      inf(0, 'prum'),
      inf(0, 'gerolstein'),
      inf(0, 'bitburg'),
      inf(0, 'trier'),

      inf(1, 'monschau'),
      inf(1, 'elsenborn', 2),
      inf(1, 'stvith', 2),
      inf(1, 'clervaux', 2),
      inf(1, 'wiltz', 2),
      inf(1, 'echternach'),
      rec(1, 'bastogne'),
    ],
    aims: ['bastogne', 'stvith', 'dinant', 'huy', 'liege'],
    turns: 10,
    arrivals: [
      { turn: 2, side: 1, type: 'infantry' },
      { turn: 3, side: 1, type: 'armour' },
      { turn: 4, side: 1, type: 'armour' },
      { turn: 5, side: 1, type: 'infantry' },
    ],
    destroy: [4, 6],
    player: 1,
    enemy: 'maneuver',
  },
  {
    id: 'uranus@1',
    name: 'Uranus',
    date: 'November 1942',
    briefing:
      'The German Sixth Army has spent the autumn fighting for the ruins of Stalingrad, and ' +
      'its flanks along the Don and in the southern steppe are held by Romanian armies with ' +
      'little armour. Break both flanks at once — from the Serafimovich and Kletskaya ' +
      'bridgeheads in the north, from below Krasnoarmeysk in the south — and meet at Kalach. ' +
      'Then hold the ring: Hoth will come up from Kotelnikovo to break it open.',
    mapId: 'uranus',
    sides: ['Soviet Union', 'Germany'],
    held: [
      'veshenskaya', 'serafimovich', 'kletskaya', 'frolovo', 'yelan', 'ilovlya', 'olkhovka', 'kotluban',
      'dubovka', 'leninsk', 'akhtuba', 'beketovka', 'krasnoarmeysk', 'plodovitoe', 'malyederbety', 'sadovoye',
    ],
    home: [['yelan', 'frolovo', 'olkhovka', 'leninsk', 'sadovoye'], ['tatsinskaya', 'millerovo', 'morozovskaya', 'tsimlyansk', 'remontnoye']],
    formations: [
      arm(0, 'serafimovich'),
      arm(0, 'serafimovich'),
      inf(0, 'serafimovich'),
      rec(0, 'veshenskaya'),
      inf(0, 'kletskaya'),
      inf(0, 'kletskaya'),
      rec(0, 'kletskaya'),
      inf(0, 'frolovo'),
      arm(0, 'plodovitoe'),
      inf(0, 'plodovitoe'),
      rec(0, 'malyederbety'),
      inf(0, 'krasnoarmeysk'),
      inf(0, 'beketovka'),
      inf(0, 'kotluban'),
      inf(0, 'dubovka'),

      inf(1, 'stalingrad'),
      inf(1, 'stalingrad'),
      inf(1, 'orlovka'),
      inf(1, 'gumrak'),
      inf(1, 'kachalinskaya'),
      inf(1, 'vertyachy'),
      arm(1, 'karpovka'),
      inf(1, 'raspopinskaya'),
      inf(1, 'perelazovsky', 2),
      inf(1, 'bokovskaya', 2),
      { side: 1, type: 'armour', at: 'perelazovsky', strength: 2 },
      inf(1, 'tundutovo'),
      inf(1, 'abganerovo', 2),
      inf(1, 'kalach', 2),
    ],
    aims: ['kalach', 'sovetsky', 'surovikino', 'stalingrad'],
    turns: 10,
    arrivals: [
      { turn: 3, side: 1, type: 'armour' },
      { turn: 4, side: 1, type: 'armour' },
      { turn: 5, side: 1, type: 'infantry' },
    ],
    player: 0,
    enemy: 'attrition',
  },
]

/**
 * Stars for the side that won: one for any win, three for a decisive one. A loss
 * or a stalemate earns none, so a mission is passed by winning it and mastered by
 * winning it well.
 *
 * A defence starts with every objective in hand, so the margin would hand out three
 * stars for standing still. There holding is one star, and the rest are for making
 * the attack pay — the enemy corps destroyed — or for breaking it outright, which
 * ends the battle before its last turn.
 */
export function starsFor(s: KesselState, side: PlayerId, mission: Mission): number {
  if (s.winner !== side || !s.peace) return 0
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
 * A mission made harder once for every time it has been won decisively: a turn
 * shorter, and a corps more for the enemy by rail on the second turn. Nothing
 * about the map or the opening changes, so what was learned still applies — it
 * just has to be done faster against more.
 */
export function levelled(mission: Mission, level: number): Mission {
  if (level <= 0) return mission
  const enemy = (1 - mission.player) as PlayerId
  return {
    ...mission,
    turns: mission.turns - level,
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

for (const map of [sedan, kiev, bastogne, uranus]) registerMap(map as unknown as MapData)
