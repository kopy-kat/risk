# RISK

Risk for a laptop: the classic 42-territory board, driven from the keyboard, against
bots that actually play well. 2–6 seats, any mix of humans and bots, no accounts and
no server — it's a static page that runs entirely in the browser.

Two games share the shell. Setup picks between **Risk** and **Kessel**, an operational
wargame on a 142-province map of Europe where formations are pushed back by combat and
destroyed only when they cannot retreat — see [Kessel](#kessel) below.

```bash
npm install
npm run dev        # then open the URL it prints
```

## Rules

Standard Risk, as implemented in `src/engine`:

- **Setup** — turn order is drawn at kick-off, then 42 territories are dealt at random
  with 1 army each and players place their remaining armies one at a time in that order
  (40/35/30/25/20 for 2/3/4/5/6 players). Moving first is worth ~50 points heads-up, so
  the seat list in setup is who you are, not when you go.
- **Deploy** — `floor(territories / 3)`, minimum 3, plus continent bonuses.
- **Cards** — 42 territory cards plus 2 wilds. A set is three of a kind, one of each,
  or anything with a wild. Cash-ins escalate 4, 6, 8, 10, 12, 15, 20, 25, then +5
  forever (`CASH_VALUES` in `src/engine/cards.ts`). Five cards forces a trade. One
  card per turn in which you took a territory. A set picturing ground you hold
  garrisons it with 2 extra armies on the spot — those never enter your deploy pool.
- **Combat** — attacker rolls up to 3 dice, defender up to 2, compared highest-first,
  ties to the defender. Every attack is a blitz: it repeats at best odds until the
  territory falls or the attacker is down to one army.
- **Conquest** — the dice you rolled advance immediately, then you choose how many
  more follow.
- **Fortify** — one move per turn between two of your territories connected through
  your own land.
- **Elimination** — take a player's last territory and you inherit their hand.
- **Victory** — hold all 42 territories, or be the last player standing.

When a set pictures more than one territory you hold, the +2 goes to one in contact
with an enemy rather than asking you — armies behind the lines do nothing.

## Features

**One key does everything.** `Space` presses the one dark button in the bottom bar —
confirm an occupation, end an attack, end a turn, skip the bots. `←` `→` size a move
and `Shift`+`←` `→` take it to the minimum or the maximum. `Esc` deselects, `⌘Z`
undoes, `Shift`+click deploys everything at once, and `L` opens the commander's log
before your first move of a turn. That is the whole list; the button label carries its
own hint, so nothing needs memorising.

- **No sidebar.** All controls live in a floating bottom bar; the map gets the screen.
  The bar keeps one footprint for the whole game, so nothing you aim at moves when a
  phase turns over or a bot takes its turn. Continent labels double as a progress
  readout (`AUSTRALIA 3/4 +2`).
- **Army counts preview live.** While sizing a deploy, occupy or fortify, both
  territories show the number they'd end on.
- **Cards trade themselves.** There's one good answer, so the bar highlights the set
  and the button shows what it pays.
- **Undo** covers deploys, trades and fortifies, and closes the moment you roll dice
  or end a turn — rewinding past a roll would be save-scumming.
- **Bot turns recap.** When control returns, a panel gives the scoreline for the turns
  you missed, with a button to replay them identically.
- **Every game replays from one number.** One seed drives the turn order, the deal, the
  dice and the bots, and it is stored with the move list.
- **Review your games.** Finished games are stored locally as a seed and a move list,
  and played back with the bot's opinion of every move — see below. **Export** on the
  setup screen writes them all to a file, which `npm run study` reads.
- **The commander's log** measures your judgement instead of correcting it — see below.

## Bots

Three tiers — **Colonel**, **General**, **Marshal** — picked once in setup for every bot
at the table, not per seat. They are one brain at three depths of thought, not three
implementations. Tiers differ by *what the bot is allowed to think about*, never by
injected mistakes, so a weaker one reads as a player considering less rather than a
stronger one with noise added.

```
combat model    exact win/loss tables and expected survivors — no simulated rolls
evaluation      income, continent efficiency, border security, card equity, threat
plan layer      one intent for the turn: expand · consolidate · deny · cycle · decapitate
execution       turn the intent into concrete moves
```

The plan layer is what makes play legible: people think "I'm taking Australia this
turn", not "maximise a weighted sum". Colonel gets expand and consolidate; General adds
denial, card cycling and the discipline to decline ground it can't hold; Marshal adds
elimination hunting, reading who is about to be forced to cash, attack routes planned
three captures deep, and an opening spent on the chokepoints that will have to hold its
continent.

**They play the card race.** With escalating cash-ins a late set outgrows the whole
board, and that is where long games are decided. Once the next set is worth more than
every player's ground income combined, General and Marshal stop cashing for tempo and
bank — a set is spent on an elimination or held until the limit forces it. Marshal
also cashes *for* the kill: if trading a set makes wiping a player affordable, it
trades, lands the armies on their border, and takes the hand. And it profiles: a
player farming cards from one big stack on a handful of territories is treated as the
table's real threat long before their bank pays out.

**They gang up.** General and Marshal both watch for a runaway leader — 45% of the board
and pulling clear of the runner-up — and turn on them together, easing off each other
while it lasts. Nobody negotiates: the board is public, so everyone reads it the same
way. The truce dissolves the moment the leader is back in the pack, and it is aimed at
whoever is actually winning, which some games means you and some games doesn't.

Heads-up: Marshal beats General 67/33, General beats Colonel 53/47. `npm run bench`
measures that with paired seeds and seat rotation, because going first is worth ~50
points heads-up and an unrotated comparison measures position rather than skill.
[`BOTS.md`](BOTS.md) has the design, the full results, and the substantial list of
plausible improvements that measured worse — including four attempts at lookahead.

**They are also measured against strategies they would never play.** A ladder of tiers
answers "is this stronger?" and cannot answer "is there a strategy this has no reply
to?" — a bot only ever has to beat opponents that think the way it does. So there is a
second set of opponents in `src/bots/pool.ts`: a turtle that banks every army in one
stack, a card shark that farms a card a turn and cashes a banked hand into a chain of
eliminations, one that attacks anything better than a coin flip, and two more. None of
them is good at Risk and none is selectable as an opponent; their whole job is to be
different. They are one parameterised policy rather than five hand-written bots,
because `npm run exploit` hill-climbs that same space for the point that beats a tier
hardest and reports the result as one number — **exploitability**, the best edge over
an equal table share a fixed search budget can find. Anything that beats its share is
archived to `data/exploiters.json`, seeds the next search, and joins the training
population of `npm run fit-eval`. `BOTS.md` records the whole loop, including the
recorded human games that forced it.

**The reviewer prices moves before the dice.** Attack at 75%, lose the roll, and a
naive reviewer calls it a blunder — it wasn't. So each decision is scored by
integrating over the outcome distribution with the same exact combat tables, giving
two numbers that never contaminate each other: **loss** (armies given up against the
best available move) and **luck** (what the dice then did about it). The summary reads
*"1.4 armies given up per decision; the dice were worth +10"*.

**Reinforcement is judged a turn at a time.** Armies in hand buy nothing until
they're spent, so a deploy is priced by letting the bot finish the turn behind it —
and the recommendation says what it was for: *deploy 1 to Ural, then take
Afghanistan*. Alongside the per-move verdicts the review names what you did wrong
more than once (*taking ground you can't hold, 6× −41*) and splits accuracy by where
in the turn it went.

### Writing one

```ts
import type { Bot } from './types'

export const myBot: Bot = {
  key: 'mine',
  name: 'Napoleon',
  blurb: 'What it does differently',
  decide(state, me, rand) {
    // return one legal Move. Use `rand()`, never Math.random, so games stay reproducible.
    return { type: 'endAttack' }
  },
}
```

Add it to `BOTS` in `src/bots/index.ts` (weakest first) and it appears as a difficulty
rung in setup; add it to `BENCH_LADDER` instead to have it ranked without offering it to
anyone. Then `npm run bench -- mine general 300`.

## The commander's log

The reviewer tells you which move was better. That is a different thing from knowing
*why* you chose the other one — and most of what improves strategic judgement is
noticing that your reads of the opponent are wrong in a consistent direction. So the
log measures calibration and never gives advice.

Before your first move of a turn the bar offers a strip. It is an offer, not a step:
the bar underneath keeps every key, and playing your first move takes the strip away.
`L` opens it, `⏎` moves from the intent to the prediction and then files it, `Esc`
puts it away. Once open it owns the keyboard — `↑` `↓` pick the claim, `←` `→` set the
confidence — the same bargain the seat-name fields make in setup.

- **Intent** — one line of free text. *"Take Australia and hold the Siam chokepoint."*
- **Prediction** — one claim from a menu generated off the live board (hold a
  continent, be attacked by a named player, end the turn on N territories, watch
  someone cash), plus a confidence from 50/60/70/80/90/95%.

Claims settle against the replayed boards and nothing else, so a verdict is stable
under undo and identical every time the game is replayed — and an unfinished horizon
stays unsettled rather than counting as wrong. **Calibration** in the review screen
buckets your claims by stated confidence against how often they were right, scores the
lot with a [Brier score](https://en.wikipedia.org/wiki/Brier_score), names the single
largest one-way bias in a sentence, and lists each turn's intent against what the board
actually did that turn.

Notes live under their own `localStorage` key, keyed by game and turn, so a game record
stays a seed and a move list and replays whether or not anything was written down. A
game with no human seat logs nothing.

## Kessel

The second game, picked in setup: operational war in Europe over ~140 provinces, two
sides, 26 formations each. **A formation beaten with a line of retreat is pushed back
at full strength; beaten without one it surrenders.** Encirclement kills, combat only
pushes — everything else exists to make that rule bite. Rules, map generation and the
design targets are in [`KESSEL.md`](KESSEL.md); `src/games/kessel` is the engine.

A turn is orders, then one resolve. Select a formation — click it, or `←` `→` to cycle
through the ones still without an order — then click an adjacent province: enemy-held
attacks, anything else moves. `H` holds and digs in, `R` refits, `⌫` clears the staged
order, `Esc` deselects, `⌘Z` undoes, and `Space` presses the one dark button —
`Commit turn`, or `Offer terms` once your will is spent.

**The map zooms.** Fifty-two counters over 142 provinces is crowded where it matters,
so scroll or pinch to zoom about the pointer, drag to pan, `+` `−` to zoom about the
middle and `0` to fit. It goes to 4×, and the counters grow with the ground rather
than floating over it at a fixed size. Beyond the theatre the plate ends in a drawn
neatline with the off-map sheet showing past it — the coastline is clipped to a
lon/lat box, and that is where the box is.

The map carries the things you can't play without:

- **Supply, in four bands.** Supplied · strained · failing · cut off, on a strip down
  each counter, with the key above the bar. Anything short of full supply cannot start
  an attack — that is the culminating point, and it is what a strained counter's broken
  outline means. A cut-off counter is hatched and struck through; it is losing strength
  every turn.
- **Pockets.** A province whose garrison has nowhere to retreat is ringed in red,
  measured against the board *this turn's staged moves* would produce — so a ring you
  are about to close counts before you press the button.
- **The odds, before you commit.** Staging or hovering an attack prices it in the bar:
  the force ratio, how many of your formations the border's frontage actually admits,
  and whether the defender has anywhere to fall back to.
- **Depots** (capacity as pips), **objective values** (a diamond), and each side's
  **war aims** (the diamond filled in that side's colour, the province hatched to
  match). Aims are what the peace is scored on.

Both sides' **will** sits in the bar against the threshold below which a side can only
ask for terms. Take the terms and the war ends on the line as it stands, scored against
what each side said it wanted — so you can win a war you did not conquer.

Three doctrines rather than difficulty rungs: **Attrition**, **Maneuver** and **Elastic
Defence** are one policy at different settings — how much it pays to close a ring rather
than force a front, how far it will outrun its supply, when it pulls a formation out to
refit. The review screen and the commander's log are Risk-only, so a Kessel game is not
recorded.

## Development

The rules live in `src/engine` as pure functions — no React, no dependencies.
`applyMove` never mutates: it clones, validates, and returns the next state. That's
what makes ten thousand headless games take seconds, and it's what undo and replay are
built on.

| command | what it does |
| --- | --- |
| `npm test` | assertions over the rules (cards, combat, reinforcement, placement) |
| `npm run test:kessel` | Kessel's rules — supply, encirclement, retreat, the settled peace |
| `npm run sim` | soak test: bot-vs-bot games, invariants checked after every move |
| `npm run bench` | head-to-head bot benchmark — paired seeds, seat rotation, Wilson intervals |
| `npm run exploit` | searches for a strategy a tier has no answer to; prints the exploitability number |
| `npm run fit-eval` | fits the evaluation's weights to outcomes over a mixed population of strategies |
| `npm run study` | replays exported games and grades every seat, bots included |
| `npm run review-check` | checks the reviewer measures skill, not noise |
| `npm run smoke` | browser end-to-end: play, record, replay, review (needs a `build`) |
| `npm run gen-map` | builds `data/maps/europe.json` — province shapes, adjacency and label anchors — from seed points and the coastline |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `oxlint` over `src` and `scripts` |

CI runs `lint`, `typecheck`, `test`, `sim -- 300`, `build` and `review-check -- 8`
on every pull request (`.github/workflows/ci.yml`) — nothing it checks is
unreproducible locally.

## Licensing

Code is MIT (`LICENSE`). The map geometry in `data/` is **not**: it's derived from
[`Risk_board.svg`](https://commons.wikimedia.org/wiki/File:Risk_board.svg) by
**Gr0gmint** on Wikimedia Commons, licensed **CC BY-SA 3.0**, and keeps share-alike
terms — see `data/LICENSE`.

"RISK" is a Hasbro trademark and the commercial board art is theirs. Game rules aren't
copyrightable and nothing here uses Hasbro artwork, but pick a different name and your
own map art before putting this anywhere public.
