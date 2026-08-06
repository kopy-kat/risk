# RISK

A playable Risk clone in the browser. Classic 42-territory board, 2–6 seats, any mix
of humans and bots.

```bash
npm install
npm run dev        # then open the URL it prints
```

Other scripts:

| command | what it does |
| --- | --- |
| `npm test` | ~200 assertions over the rules (cards, combat, reinforcement, placement) |
| `npm run sim` | soak test: hundreds of bot-vs-bot games, invariants checked after **every move** |
| `npm run bench` | head-to-head bot benchmark — paired seeds, seat rotation, Wilson intervals |
| `npm run sim -- 2000 easy` | 2000 games where every seat is the `easy` bot |
| `npm run review-check` | checks the game reviewer measures skill, not noise |
| `npm run smoke` | browser end-to-end: play, record, replay, review (needs a `build` first) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `oxlint` over `src` and `scripts` |
| `npm run build:mock` | rebuilds `mock/index.html`, the static design mock |

CI runs `lint`, `typecheck`, `test`, `sim -- 300` and `build` on every pull request
(`.github/workflows/ci.yml`). Running those five locally is the whole gate — there is
nothing CI checks that you can't reproduce.

## How it's put together

The rules live in `src/engine` as pure functions with no React and no dependencies.
That's deliberate: it's what makes bots easy to write and, more importantly, easy to
*measure* — you can run ten thousand headless games in a few seconds and see whether
a change actually helped.

```
data/board.json          adjacency, continent bonuses, display names
data/territories.json    SVG path + label anchor per territory (generated)
data/sea-routes.json     which adjacencies cross water, and where to draw them (generated)

src/engine/
  board.ts               typed board data
  types.ts               GameState, Move, Player, Card
  rng.ts                 seeded mulberry32 — the generator state lives in GameState,
                         so any game replays exactly from its seed
  cards.ts               deck, set validity, cash-in table
  game.ts                createGame / legalMoves / applyMove / reinforcementFor

src/bots/
  types.ts               the Bot interface
  random.ts, easy.ts     current agents
  play.ts                stepBot — runs one bot decision, falls back to a random
                         legal move if a bot misbehaves
  index.ts               registry; add to BOTS and it appears in the seat picker
  strategy/lookahead.ts  what a move is worth *before* the dice — expected value
                         from the exact combat tables, never a simulated roll

src/review/
  store.ts               saved games in localStorage: seed + move list, nothing else
  replay.ts              seed + moves -> every board the game ever had
  review.ts              grades each of your decisions, and splits luck out of it

src/ui/                  React: App, MapView, Dock, Setup, Review, theme.css
scripts/                 tests, simulator, mock builder, geometry solvers
```

All the controls live in the floating bottom bar — whose turn it is, your hand,
and the actions for the current phase. There's no sidebar; the map gets the screen.
The top bar carries the scoreboard: territory count and hand size per seat (both
public information in Risk, so showing them isn't a cheat).

## Controls

There is exactly one dark button in the bottom bar at any moment, and **Space always
presses it** — confirm an occupation, end an attack, end a turn, skip the bots. The
button label carries its own key hint, so nothing has to be memorised or looked up.

| key | does |
| --- | --- |
| `Space` | press the highlighted button |
| `Esc` | deselect / close |
| `⌘Z` | undo |
| `Shift`+click | deploy everything at once |

That's the whole list, and it's short deliberately. Earlier versions also bound `E`
(end turn), `S` (skip bots), `B` (blitz), `Enter`, the arrow keys and `0`–`9` for
typing amounts; each was cut because it only duplicated Space or a button sitting
right next to it — `S` was outright redundant, since the primary button during a bot
turn *is* "Skip", and `Enter` made the `␣` printed on that button a half-truth. The
full list lives in the ⚙ popover rather than a separate cheat sheet.

**Every attack is a blitz**, matching RISK: Global Domination — clicking a target
rolls repeatedly at best odds until you take the territory or spend down to one army,
so a grind that used to be eight clicks is one. There's no single-roll mode: rolling
one round at a time changes nothing about the odds, it just makes you click more.

Every "how many armies?" question — deploy, occupy, fortify — uses the same control:
**Min / − / value / + / All**. It's deliberately not a text input, because a focusable
field would own the Space key that belongs to Confirm. Occupy and fortify default to
moving the whole stack, so the common case is capture → Space.

While you're sizing one of those moves, **both territories preview the count they'd
end on** — dashed badge, accent ink, and the swing (`+3` / `−3`) underneath. The number
you're deciding about is the number on the map, rather than something to work out from
a sentence in the bar. Only the two deterministic moves get this: an attack is dice, so
the map keeps showing what's actually there rather than a number it can't promise.

**Cards trade themselves.** Which three you hand in has exactly one good answer — take
the +2 territory bonus when it's available, spend wilds last — so the bar highlights
the set it's about to cash and the button shows what it pays. Choosing the combination
by hand was busywork dressed up as a decision.

**Undo** covers deploys, card trades and fortifies. The window closes the moment you
roll dice or end your turn — rewinding past a roll and trying again would be
save-scumming, and ending a turn draws a card. It survives the deploy→attack
transition, so a misjudged deployment is recoverable right up until your first attack.

Undo is a stack of previous states rather than a set of inverse operations, which
works only because `applyMove` never mutates. `scripts/test.ts` asserts that purity
directly, since undo silently depends on it.

**Every game is reproducible from one number.** The seed shows in the ⚙ popover and
can be pasted into the setup screen to replay a game exactly — the deal, the dice and
the bots all derive from it. That's the difference between "the bot did something
stupid once" and a case you can re-run while fixing it.

## Reviewing your games

Finished games are kept locally and can be played back with the bot's opinion of every
move you made — the chess-style post-mortem, adjusted for the fact that Risk rolls dice.

Games are stored as **a seed and a list of moves**, never as boards. `applyMove` is pure
and the generator state lives inside `GameState`, so those two things reconstruct every
position exactly, dice included; a 300-move game is about 20 kB. The move list lives in
`GameState` rather than beside it, which is what makes undo correct for free — undo
restores an earlier state, and that state carries the earlier list.

**Skill and luck are reported separately, and that's the whole design.** Chess review
works by scoring the position after your move, because that position is a fact. Here it
isn't: attack at 75%, lose the roll, and a naive reviewer calls it a blunder. It wasn't.
So a move is priced *before* the dice, by integrating over the outcome distribution with
the exact tables in `src/engine/combat.ts` — never by rolling it:

```
EV(attack) = P(win) · score(board if it lands) + P(lose) · score(board if it doesn't)
```

That yields two numbers per decision that never contaminate each other: **loss** (how
much worse your move was than the best available, in armies) and **luck** (what the dice
then did about it, relative to expectation). The summary reads *"1.4 armies given up per
decision; the dice were worth +10"* — a split chess review structurally cannot make, and
the reason the right model here is backgammon's, not chess's.

Armies are the unit throughout, which beats centipawns for being checkable against
experience: a turn's reinforcement is 3–15 armies, so the grade bands sit at 1 / 4 / 10 /
25 — roughly *noise*, *a fraction of a turn*, *a wasted turn*, *a wasted couple*.

**The reviewer's judgement is Marshal's, and Marshal is not an oracle.** Advice is worded
as "General would have played X" rather than "you blundered", and the bands are
deliberately generous at the bottom, because flagging a decision the evaluator cannot
really tell apart from the best one is how a review feature loses your trust.

`npm run review-check` is what keeps it honest. There's no ground truth for "was that
move bad", but there is a known ladder — `npm run bench` says Marshal beats General beats
Colonel beats easy beats random — so the reviewer, pointed at each tier's own play, must
not *contradict* it. Measured per decision rather than by win rate:

```
                      mean armies given up per decision, and the paired per-seed gap
marshal 1.65  ≈  general 1.55      +0.02 ± 0.37   tied
general 1.55  <  colonel 4.19      −1.12 ± 0.90   separated
colonel 4.19  <  easy    4.81      −0.87 ± 1.59   tied
easy    4.81  <  random  6.87      −2.52 ± 1.65   separated
```

Two comparisons separate and two don't, and that's the honest result rather than a
failure. Marshal's edge over General is elimination hunting and table reading — strategy
paying off across turns — while this measures single decisions, so a per-move metric has
no way to see it. Colonel and easy simply need more games than a CI run can afford.

Games are compared **paired by seed**, for the reason `bench.ts` pairs: every tier plays
the same seed set, so differencing within a seed cancels map luck. Pairing also fixes a
subtler trap — decisions are *not* independent samples. A bad position produces a whole
run of bad decisions, so treating four thousand clustered decisions as four thousand
observations understates the error by about 4× — enough to flip this check between sample
sizes, which is exactly how the bug was found. The unit of independence is the game.

It also checks that luck averages to nothing (pooled: −0.025 armies per attack). A
persistent bias there would mean the expectation model and the dice disagree, and would
reach you as "the dice hate me", in every game, forever.

One thing the reviewer needs that the bots don't: **exposure has to be bounded.** `assess`
leaves it unbounded, which is fine for play — agents only compare small local changes,
where the unbounded part cancels — but a reviewer compares whole alternatives, and a
border facing a 180-army stack scores a shortfall of a hundred on its own. Left alone it
made Colonel's fortifies average a 14.8-army "loss" against Marshal's 0.9, purely because
Colonel's stacks are bigger, and ranked the tiers wrongly as a result. Capped per territory
at 12 in `src/review/price.ts` — not in `assess`, so the bots keep exactly the evaluation
they were benchmarked against.

Stored games carry a fingerprint of the rules they were played under. Retune
`CASH_VALUES` and old move lists stop applying part way through — which would otherwise
surface as a replay quietly showing a board that never existed — so they're quarantined
in the list instead of replayed.

When control returns to you — including after Skip — a transient panel lists what the
bots did: every reinforcement, assault, capture and elimination since your last move,
grouped by player, not a trimmed tail of them. Repeated rolls against one territory
collapse into a single line (`attacked Ural from China · 3× · −2/−2`), which is what
keeps "everything" readable. It clears on your next move; it's a recap, not a log
panel.

Continent labels on the map double as a progress readout — `AUSTRALIA 3/4 +2`, tinted
by whoever leads and solid once someone holds it outright. Being one territory off a
continent bonus is the most decision-relevant fact on the board, so it belongs on the
map rather than in a panel. All six sit in open water: `scripts/solve-label-anchors.mjs`
tests the whole box each label will occupy, inflated by a margin, against the real
paths — anchor-point-only checks are how the long ones ended up printed across Canada.

Two bits of map rendering worth knowing about, because both are easy to
reintroduce as bugs:

- **Fills and outlines are separate SVG layers.** If each territory drew its own
  stroke, the next territory's fill would paint over the shared edge and borders
  would come out half-missing.
- **Borders are stroked in ink, not the sea colour.** A pale stroke between two
  pastel fills reads as a *gap* rather than a border.

Sea routes are derived, not hand-listed. `scripts/solve-sea-routes.mjs` samples
every outline and measures the real distance between each adjacent pair; land
borders come out ≤ 1.1 units apart and water crossings ≥ 5.5, so the split is
unambiguous. Alaska–Kamchatka is a whole map wide, so it draws as a stub running
off each edge of the world. The geometry solvers need `playwright` (a
devDependency) and use your installed Chrome.

`applyMove` never mutates — it clones, validates, and returns the next state, throwing
`illegal move: …` on anything invalid. `legalMoves` enumerates every option for the
current phase and is guaranteed non-empty until the game ends.

## Writing a bot

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

Add it to `BOTS` in `src/bots/index.ts` and it shows up in the seat dropdown. To find
out whether it's actually better, run `npm run bench -- mine easy 300`. See
[`BOTS.md`](BOTS.md) for the design of the tiers and why the benchmark is built the
way it is — going first is worth ~39 points heads-up, so a comparison without seat
rotation measures position rather than skill.

`Marshal`, `General` and `Colonel` are the tiers, with General the default opponent.
Marshal's edge is specifically multiplayer — it hunts eliminations for the cards and
watches who is about to be forced to cash — so heads-up it plays level with General.
`Colonel` is the first tier — it picks an efficient continent, masses for it,
garrisons what it holds, and uses exact combat odds from `src/engine/combat.ts`. It
beats the old heuristic bot 67/33. `General` adds denial, card cycling and the
discipline to decline ground it can't hold, and beats Colonel 57/43. `easy` and
`random` are still in the codebase as benchmark rungs but are hidden from the seat
picker.

What Colonel deliberately does *not* do, and what the higher tiers add: break other
players' continents, time its card cash-ins, notice who is about to receive a pile of
armies, or hunt eliminations for the cards. See [`BOTS.md`](BOTS.md).

## Rules implemented

- **Setup** — all 42 territories dealt out at random with 1 army each, then each player
  places their remaining armies **one at a time** in turn order (40/35/30/25/20 total
  for 2/3/4/5/6 players). "Auto-place rest" fills yours in using the easy bot's logic.
- **Deploy** — `floor(territories / 3)`, minimum 3, plus continent bonuses.
- **Cards** — 42 territory cards (14 per suit) plus 2 wilds. A set is three of a kind,
  one of each, or anything with a wild. Cash-in escalates **4, 6, 8, 10, 12, 15, 20,
  25, then +5 forever** — retune `CASH_VALUES` in `src/engine/cards.ts` and nothing else
  needs to change. Holding 5+ cards forces a trade before you can deploy. One card per
  turn in which you took at least one territory.
- **Combat** — attacker rolls up to 3 dice (needs troops − 1), defender up to 2. Sorted
  highest-first and compared pairwise; ties go to the defender. A blitz is the same
  maths repeated at full odds until the territory falls or the attacker is down to one
  army — no separate dice model, just a loop over the single-roll code.
- **Conquest** — the dice you rolled advance immediately, then you choose how many more
  follow. No territory is ever left holding zero armies.
- **Fortify** — one move per turn between two of your territories connected by a path
  running entirely through your own land. Confirming it does *not* end your turn, so
  there's still a window to undo it.
- **Elimination** — take a player's last territory and you inherit their whole hand.
- **Victory** — hold all 42 territories, or be the last player standing.

Bots play on a timer, but the bottom bar has a **skip** button during their turns
that applies every remaining bot move at once and hands straight back to you. With
no human seats left it runs the game to its finish instead.

Two deliberate simplifications:

1. The classic +2 territory-match bonus on a traded set is added to your deploy pool
   rather than forced onto the specific territory pictured.
2. Inheriting cards can push a hand above 5 mid-turn; the forced trade happens at the
   start of your next deploy rather than immediately.

## Licensing

Code is MIT (`LICENSE`). The map geometry in `data/` is **not** — it's derived from a
CC BY-SA 3.0 work and keeps share-alike terms; see `data/LICENSE`.

The territory outlines are derived from
[`Risk_board.svg`](https://commons.wikimedia.org/wiki/File:Risk_board.svg) by
**Gr0gmint** on Wikimedia Commons, licensed **CC BY-SA 3.0** — so this derivative of
the map data carries the same share-alike terms. Territory paths were extracted and
re-baked into `data/territories.json`.

"RISK" is a Hasbro trademark and the commercial board art is theirs. Game rules aren't
copyrightable, and nothing here uses Hasbro artwork, but pick a different name and your
own map art before putting this anywhere public.
