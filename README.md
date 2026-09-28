# RISK

Risk for a laptop: the classic 42-territory board, driven from the keyboard, against
bots that actually play well. 2–6 seats, any mix of humans and bots, no accounts and
no server — it's a static page that runs entirely in the browser.

Two games share the shell. Setup picks between **Risk** and **Kessel**, an experimental
operational wargame played as a ladder of short historical missions, where formations
are pushed back by combat and destroyed only when they cannot retreat. See
[Kessel](#kessel) below.

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
undoes, and `Shift`+click deploys everything at once. That is the whole list; the
button label carries its own hint, so nothing needs memorising.

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

## Kessel

The second game, picked in setup: operational battles as a ladder of historical missions.
**A formation beaten with a line of retreat is pushed back at full strength; beaten
without one it surrenders.** Encirclement kills, combat only
pushes — everything else exists to make that rule bite. Rules, map generation and the
design targets are in [`KESSEL.md`](KESSEL.md); `src/games/kessel` is the engine.

### Campaigns

Picking Kessel opens its campaigns. A campaign is a run of historical battles fought by
one side in order, each a short fight on its own map at a scale where a pocket is
several provinces across: a fixed order of battle, one set of objectives both sides
contest, and a turn limit. **The army carries**: whatever comes out of one battle is the
army for the next — each corps at the strength it ended on, a slot with nobody left to
fill it empty — plus whatever fresh draft the next battle brings. Lose a battle and you
fight it again with the army you went in with; win it and you choose to go on or to try
it again for more.

- **France 1940** — Germany, six battles: Gembloux on the Belgian plain, the Sedan
  breakthrough, the Arras counterattack, the race for the Channel ports at Dunkirk, the
  Weygand line in Fall Rot, and the race to the Loire crossings.
- **East 1941** — the Soviet Union, seven battles from the frontier to Moscow: a fighting
  withdrawal, the Dubno counterstroke, breakouts at Minsk and Kiev, the Smolensk relief,
  holding against Typhoon, and the December counteroffensive.
- **Kiev 1941** — Germany, two panzer pincers meeting behind Kyiv before the mud.
- **Uranus 1942** — the Soviet Union, ringing Stalingrad and holding the ring.
- **Kursk 1943** — the Soviet Union, holding the salient against pincers from Oryol and Belgorod.
- **Falaise 1944** — the Allies, shutting the sack on two German armies at Trun and Chambois.
- **Bastogne 1944** — the United States, holding the road hubs and the Meuse.

The briefing names the objectives; hold more than half their value when the last turn
has been fought and you have won. The margin is the stars — ★ narrow, ★★ clear, ★★★
decisive. In a defence you start with everything, so holding is ★ and the other stars
are for enemy corps destroyed, or for destroying them all before the last turn. In a
breakout, a relief or a withdrawal the stars are for the marked corps you bring out with
a route home. A campaign is scored by its stars across all its battles, and one finished
with two thirds of them goes up a level, to four: every battle a turn shorter — in a
defence a turn longer to hold — with one more enemy corps arriving by rail on turn 2.
Any battle a run has reached can be practised as written, outside the campaign. On the
attack you face **Defence in Depth**, which walks corps out of a closing ring rather than
dig in and lose them.

**The enemy learns you.** After every commit the board you leave is read for how much
of the enemy's line you have left with one way out or none. Averaged over your recent
missions, that teaches an enemy on the defensive caution: a corps with the ring closing on it is ordered
first and walks out rather than dig in, unless it is standing on an objective. The
briefing says when it has noticed. Nothing is hidden and nothing is random.

A turn is orders, then one resolve. Select a formation — click it, or `←` `→` to
cycle through them, the contact line first — then click a province: enemy-held
attacks, anything else moves. **Standing still digs in**, so a formation with no order
is holding; `R` refits, and a refit stands from turn to turn until the formation is
whole. After staging an attack with armour or recon, click further on to set where it
rides to if the ground falls — the exploitation. `G` selects a headquarters, again for
the other, and a click sends it. `⌫` clears the staged order or calls the headquarters
back, `Esc` deselects, `⌘Z` undoes, and `Space` presses the one dark button — `Commit
turn`.

**Command.** Each side has two headquarters, drawn as flags. A formation more than
three provinces of your own ground from both is out of command and drawn faded: an
order to move or attack it is carried out a turn late, dotted on the map until then,
and it takes no other order meanwhile. A headquarters moves up to four provinces
through your own ground and commands from there the next turn; overrun, it falls back.

Movement: infantry 2, armour 4, recon 5, across terrain that costs what it costs, and
the march ends the moment it enters ground an enemy watches. A formation out of contact
and in full supply can instead ride the **railway** six along its own supply network,
starting and ending out of contact — the interior line. Two turns in every ten are
**mud**: the march halves, the trains still run, and the topbar counts down to it.

Supply enters the map at each side's **rear**, the provinces the mission names, and
flows through friendly ground the enemy does not overlook. Depots are railheads on that
line: one cut off from home issues nothing, and is drawn struck through. A corps under
strength that refits on a live railhead regains a step every three turns. What else
arrives, and when, is the mission's timetable — by rail, or for a reserve that was there
all along, where it stood.

**The map zooms.** Scroll or pinch to zoom about the pointer, drag to pan, `+` `−` to zoom about the
middle and `0` to fit. It goes to 4×, and the counters grow with the ground rather
than floating over it at a fixed size. Beyond the theatre the plate ends in a drawn
neatline with the off-map sheet showing past it — the coastline is clipped to a
lon/lat box, and that is where the box is.

The map carries the things you can't play without:

- **Fog.** Ownership and the number of counters on a province are public — a front
  line is known. What a counter is worth is known only where you can see: beside your
  formations, or within two of your recon. Elsewhere it is drawn from what you last
  saw, with how many turns ago in the corner, or as `?` if never. Bots see everything.
- **Supply, in four bands.** Supplied · strained · failing · exhausted, on a strip down
  each counter, with the key above the bar. Anything short of full supply cannot start
  an attack — that is the culminating point, and it is what a strained counter's broken
  outline means. A counter with no route home is hatched and struck through: it keeps
  its band the turn it is cut off, loses one a turn after, and once exhausted is losing
  strength every turn while an enemy presses it.
- **Pockets.** A province whose garrison has nowhere to retreat is ringed in red,
  measured against the board *this turn's staged moves* would produce — so a ring you
  are about to close counts before you press the button.
- **The odds, before you commit.** Staging or hovering an attack prices it in the bar:
  the force ratio, how many of your formations the borders actually admit — each border
  takes its frontage, the best attack value first, four in all — and whether the
  defender has anywhere to fall back to.
- **Depots** (capacity as pips, struck when cut from home), **objective values** (a
  diamond, the province hatched), and **headquarters** (a flag in the side's colour).

Four doctrines rather than difficulty rungs: **Attrition**, **Maneuver**, **Elastic
Defence** and **Defence in Depth** are one policy at different settings — how much it pays to close a ring rather
than force a front, how far it will outrun its supply, when it pulls a formation out to
refit, and how much a corps cut off from home is worth, so they ride through an empty rear
to cut it and counterattack whoever cuts theirs. All four garrison a railhead or a city an
enemy is closing on before they spend
the turn's activations at the front, order what is in command before what is not, and
send their headquarters wherever they command the most of the line.

### Reviewing a battle

Battles are stored and reviewed like Risk games, and the screen is the same one — but the
unit of judgement is different. You stage orders for every formation and press one
button, so **the decision is the whole turn**, and a turn is priced against whole
alternatives: what each doctrine would have ordered from that board, and your own orders
with one thing changed. Each candidate is resolved through the engine five times under
different generator states and averaged, because the ±15% on the cohesion bill decides a
step loss or a surrender often enough to price the roll instead of the plan. **Loss** is
the gap to the best alternative, in *steps*; **luck** is what the one resolution that
happened did against that average. Neither can reach the other.

The one-change alternatives are what makes it advice. Each names a fault and carries what
fixing only that was measured to be worth — *"The corps in Dinant had one way out, and
the corps beside it could have stood in it."* Counted across the battle they become the habits
panel: *leaving the last way out open, 4× −70*. The faults are
attacking under the odds an assault has to clear, advancing past your own supply, leaving
a formation strained and idle, leaving an enemy's last way out open, standing where you
cannot fall back, and attacking in too many places at once. The review sees the whole
board; the fog is yours, not its.

`npm run review-check:kessel` is the check that this measures skill rather than noise,
and `npm run test:kessel-review` the one that pins the properties it rests on.
[`KESSEL.md`](KESSEL.md) has the position evaluation, the numbers and where it is still
weak.

## Development

The rules live in `src/engine` as pure functions — no React, no dependencies.
`applyMove` never mutates: it clones, validates, and returns the next state. That's
what makes ten thousand headless games take seconds, and it's what undo and replay are
built on.

| command | what it does |
| --- | --- |
| `npm test` | assertions over the rules (cards, combat, reinforcement, placement) |
| `npm run test:kessel` | Kessel's rules — supply, encirclement, retreat, the settled result |
| `npm run test:kessel-review` | the Kessel reviewer's arithmetic: loss floored and blind to the roll, luck averaging to nothing |
| `npm run sim` | soak test: bot-vs-bot games, invariants checked after every move |
| `npm run sim:kessel` | the same soak for Kessel, over the missions |
| `npm run bench` | head-to-head bot benchmark — paired seeds, seat rotation, Wilson intervals |
| `npm run bench:missions` | each mission played from your side by every doctrine — wins, stars, objectives held, enemy corps destroyed — then again against the enemy adapted to its tells; `--level N` plays it N levels up |
| `npm run exploit` | searches for a strategy a tier has no answer to; prints the exploitability number |
| `npm run exploit:kessel` | the same search over Kessel's doctrine space, from the player's side of the missions |
| `npm run fit-eval` | fits the evaluation's weights to outcomes over a mixed population of strategies |
| `npm run study` | replays exported games, Risk or Kessel, and grades every seat, bots included |
| `npm run review-check` | checks the reviewer measures skill, not noise |
| `npm run review-check:kessel` | the same question for Kessel, against a commander who fights hard and badly |
| `npm run smoke` | browser end-to-end: play, record, replay, review (needs a `build`) |
| `npm run gen-map -- --map=<id>` | builds a mission's map — province shapes, adjacency and label anchors — from seed points and the coastline |
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
