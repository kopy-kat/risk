# risk

Risk is the board game where players move armies across a map of 42 territories until
one of them holds the whole world. This version runs in the browser, can be played from
the keyboard and has bots that are actually good.

Play it at [risk.konradkopp.com](https://risk.konradkopp.com), with 2 to 6 players in
any mix of humans and bots.

```bash
npm install
npm run dev
```

## Rules

Standard Risk, with these choices:

- Territories are dealt at random and turn order is drawn at the start.
- Card sets escalate: 4, 6, 8, 10, 12, 15, 20, 25, then +5 each time.
- Every attack is a blitz. It repeats until the territory falls or you are down to one
  army.
- One fortify per turn, through connected land you own.

The engine is in `src/engine`.

## Features

| key | what it does |
| --- | --- |
| `Space` | the main button: confirm, end attack, end turn, skip the bots |
| `←` `→` | size a move |
| `Shift`+`←` `→` | minimum or maximum |
| `Shift`+click | deploy everything at once |
| `Esc` | deselect |
| `⌘Z` | undo |

- The controls are in one bar at the bottom and the map gets the rest of the screen.
- While you size a move, both territories show the number they would end on.
- After the bots have played, a panel shows what happened and can replay it.
- One seed drives the deal, the dice and the bots, so any game can be replayed exactly.
- After a game you can review it with the bot's opinion on every move. It scores each
  decision before the dice, so a good attack that lost the roll counts as bad luck and
  not as a mistake.

## Bots

There are three levels: Colonel, General and Marshal. All three run the same code and
differ in what they are allowed to think about, so the easier ones are not the hard one
with random mistakes added.

- Colonel only expands and consolidates.
- General also denies continents, cycles cards and leaves ground it can't hold.
- Marshal also hunts eliminations, tracks who is about to be forced to cash and plans
  attacks three captures deep.

General and Marshal hold their cards once a late set is worth more than the board, and
they turn on a player who is running away with the game. Sometimes that is you.

Heads-up, Marshal beats General 67/33 and General beats Colonel 53/47 (`npm run bench`).
The design, the results and the changes that measured worse are in [`BOTS.md`](BOTS.md).

To add a bot, implement `Bot` from `src/bots/types.ts` and add it to `BOTS` in
`src/bots/index.ts`.

## Kessel

Kessel is a second game in setup and still an experiment. You fight short
historical battles in order, as campaigns. A formation that loses a fight is pushed
back at full strength if it can retreat and surrenders if it can't, so you destroy
units by encircling them. More in [`KESSEL.md`](KESSEL.md).

## Development

| command | what it does |
| --- | --- |
| `npm test` | assertions over the rules |
| `npm run sim` | bot-vs-bot games with invariants checked after every move |
| `npm run bench` | head-to-head bot benchmark |
| `npm run exploit` | searches for a strategy a level has no answer to |
| `npm run smoke` | browser end-to-end (needs a `build`) |

The rest are in `package.json`.

Code is MIT. The map geometry in `data/` is derived from
[`Risk_board.svg`](https://commons.wikimedia.org/wiki/File:Risk_board.svg) by Gr0gmint
on Wikimedia Commons and is CC BY-SA 3.0 (`data/LICENSE`). "RISK" is a Hasbro
trademark and nothing here uses Hasbro artwork.
