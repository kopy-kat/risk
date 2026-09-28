import bastogne from '../../../../data/maps/bastogne.json'
import falaise from '../../../../data/maps/falaise.json'
import kiev from '../../../../data/maps/kiev.json'
import kursk from '../../../../data/maps/kursk.json'
import uranus from '../../../../data/maps/uranus.json'
import { registerMap } from '../map'
import type { MapData } from '../map'
import type { Campaign } from '../missions'
import { arm, inf, rec } from './oob'

for (const map of [kiev, bastogne, uranus, falaise, kursk]) registerMap(map as unknown as MapData)

// Battles that belong to no campaign yet, each fought as a campaign of one.

export const KIEV: Campaign = {
  id: 'kiev',
  name: 'Kiev 1941',
  side: 'Germany',
  blurb: 'Two panzer pincers meeting behind Kyiv before the mud.',
  missions: [
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
      enemy: 'depth',
    },
  ],
}

export const BASTOGNE: Campaign = {
  id: 'bastogne',
  name: 'Bastogne 1944',
  side: 'United States',
  blurb: 'Holding the road hubs and the Meuse.',
  missions: [
    {
      id: 'bastogne@2',
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
        { turn: 2, side: 0, type: 'armour' },
        { turn: 3, side: 0, type: 'infantry' },
        { turn: 3, side: 1, type: 'infantry' },
        { turn: 5, side: 1, type: 'armour' },
        { turn: 6, side: 1, type: 'armour' },
      ],
      destroy: [1, 3],
      player: 1,
      enemy: 'maneuver',
    },
  ],
}

export const URANUS: Campaign = {
  id: 'uranus',
  name: 'Uranus 1942',
  side: 'Soviet Union',
  blurb: 'Ringing Stalingrad and holding the ring.',
  missions: [
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
      enemy: 'depth',
    },
  ],
}

export const FALAISE: Campaign = {
  id: 'falaise',
  name: 'Falaise 1944',
  side: 'Allies',
  blurb: 'Shutting the sack on two German armies.',
  missions: [
    {
      id: 'falaise@2',
      name: 'Falaise',
      date: 'August 1944',
      briefing:
        'Hitler has thrown his armour west at Mortain, and it has stuck there. Two German armies ' +
        'now stand in a sack whose mouth is the Dives valley between Falaise and Argentan. The ' +
        'Canadians and the Poles are coming south from Caen, Patton\'s XV Corps north from Alençon: ' +
        'meet at Trun and Chambois and the sack is shut. Falaise and Argentan are the hinges, the ' +
        'mouth is the prize — and the SS panzer corps outside it will come back to prise it open.',
      mapId: 'falaise',
      sides: ['Allies', 'Germany'],
      held: [
        'bayeux', 'caen', 'ranville', 'troarn', 'cabourg', 'mezidon', 'evrecy', 'bretteville', 'villersbocage', 'caumont', 'stlo', 'torigni',
        'aunay', 'vire', 'villedieu', 'avranches', 'sthilaire', 'mortain', 'sourdeval', 'tinchebray', 'domfront', 'fougeres', 'vitre', 'mayenne',
        'laval', 'preenpail', 'alencon', 'mamers', 'lemans', 'bonnetable', 'laferte',
      ],
      home: [['bayeux', 'stlo', 'avranches', 'laval', 'lemans'], ['evreux', 'elbeuf', 'dreux', 'conches', 'pontaudemer']],
      formations: [
        arm(0, 'bretteville'),
        arm(0, 'bretteville'),
        inf(0, 'bretteville'),
        inf(0, 'caen'),
        rec(0, 'caen'),
        inf(0, 'evrecy'),
        inf(0, 'ranville'),
        inf(0, 'aunay'),
        inf(0, 'vire'),
        inf(0, 'tinchebray'),
        inf(0, 'domfront'),
        arm(0, 'alencon'),
        inf(0, 'alencon'),
        rec(0, 'alencon'),
        arm(0, 'mamers'),
        inf(0, 'preenpail'),

        inf(1, 'conde', 2),
        inf(1, 'flers', 2),
        inf(1, 'thury', 2),
        { side: 1, type: 'armour', at: 'flers', strength: 2 },
        inf(1, 'falaise', 2),
        inf(1, 'lafertemace', 2),
        inf(1, 'briouze', 2),
        { side: 1, type: 'armour', at: 'ecouche', strength: 2 },
        inf(1, 'argentan', 2),
        inf(1, 'carrouges', 2),
        rec(1, 'putanges'),
        inf(1, 'stpierre', 2),
        inf(1, 'pontleveque', 2),
        arm(1, 'vimoutiers'),
        inf(1, 'lisieux'),
        inf(1, 'chambois', 2),
        inf(1, 'sees', 2),
        inf(1, 'mortagne', 2),
      ],
      aims: ['falaise', 'argentan', 'trun', 'chambois', 'vimoutiers'],
      turns: 10,
      arrivals: [
        { turn: 3, side: 1, type: 'armour' },
        { turn: 4, side: 1, type: 'armour' },
      ],
      player: 0,
      enemy: 'depth',
    },
  ],
}

export const KURSK: Campaign = {
  id: 'kursk',
  name: 'Kursk 1943',
  side: 'Soviet Union',
  blurb: 'Holding the salient against both pincers.',
  missions: [
    {
      id: 'kursk@1',
      name: 'Kursk',
      date: 'July 1943',
      briefing:
        'The Germans have waited all spring to cut off the Kursk salient, and you have spent the ' +
        'spring waiting for them. Model will come south from Oryol at Ponyri and Olkhovatka; ' +
        'Manstein\'s panzer corps north from Belgorod for Oboyan and Prokhorovka, to meet at Kursk. ' +
        'Your line is thinner than your trenches: hold the fronts, keep the salient\'s neck open, ' +
        'and the Steppe Front will come up by rail from Stary Oskol to strike their spearheads.',
      mapId: 'kursk',
      sides: ['Germany', 'Soviet Union'],
      held: [
        'mtsensk', 'karachev', 'orel', 'novosil', 'kromy', 'zmievka', 'glazunovka', 'trosna', 'dmitrovsk',
        'komarichi', 'sevsk', 'glukhov', 'putivl', 'belopolye', 'sumy', 'akhtyrka', 'bogodukhov', 'graivoron',
        'tomarovka', 'belgorod', 'kharkov', 'volchansk', 'chuguev',
      ],
      home: [['orel', 'karachev', 'mtsensk', 'kharkov', 'akhtyrka', 'chuguev'], ['livny', 'kastornoye', 'staryoskol', 'novyoskol', 'valuyki']],
      formations: [
        arm(0, 'glazunovka'),
        arm(0, 'glazunovka'),
        inf(0, 'glazunovka'),
        arm(0, 'trosna'),
        inf(0, 'trosna'),
        inf(0, 'zmievka'),
        arm(0, 'tomarovka'),
        arm(0, 'tomarovka'),
        inf(0, 'tomarovka'),
        arm(0, 'belgorod'),
        arm(0, 'belgorod'),
        inf(0, 'belgorod'),
        arm(0, 'graivoron'),
        rec(0, 'graivoron'),
        inf(0, 'volchansk'),
        inf(0, 'sumy'),

        inf(1, 'maloarkhangelsk'),
        inf(1, 'ponyri'),
        inf(1, 'olkhovatka'),
        inf(1, 'fatezh'),
        arm(1, 'kursk'),
        inf(1, 'rylsk'),
        inf(1, 'sudzha'),
        inf(1, 'rakitnoye'),
        inf(1, 'yakovlevo'),
        inf(1, 'yakovlevo'),
        arm(1, 'oboyan'),
        inf(1, 'korocha'),
        inf(1, 'shebekino'),
        rec(1, 'ivnya'),
      ],
      aims: ['kursk', 'ponyri', 'olkhovatka', 'oboyan', 'prokhorovka'],
      turns: 10,
      arrivals: [
        { turn: 2, side: 1, type: 'armour' },
        { turn: 3, side: 1, type: 'armour' },
        { turn: 4, side: 1, type: 'infantry' },
        { turn: 5, side: 1, type: 'infantry' },
      ],
      destroy: [6, 9],
      player: 1,
      enemy: 'maneuver',
    },
  ],
}
