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
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build:mock` | rebuilds `mock/index.html`, the static design mock |

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

src/ui/                  React: App, MapView, Dock, Setup, theme.css
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
| `Space` / `Enter` | press the highlighted button |
| `Esc` | deselect / close |
| `⌘Z` | undo |
| `0`–`9` | type an amount (digits build up); `0` means all |
| `Shift`+click | invert: place all, or roll once |

That's the whole list, and it's short deliberately. Earlier versions also bound `E`
(end turn), `S` (skip bots), `B` (blitz) and the arrow keys; each was cut because it
only duplicated Space or a button sitting right next to it — `S` was outright
redundant, since the primary button during a bot turn *is* "Skip". The full list lives
in the ⚙ popover rather than a separate cheat sheet.

**Blitz is the default**, matching RISK: Global Domination — clicking a target rolls
repeatedly at best odds until you take the territory or spend down to one army, so a
grind that used to be eight clicks is now one. `B` or shift-click gets you a single
roll when you want to nurse a stack.

Every "how many armies?" question — deploy, occupy, fortify — uses the same control:
**Min / − / value / + / All**, with digits typed straight into it. It's deliberately
not a text input, because a focusable field would own the Space key that belongs to
Confirm. Occupy and fortify default to moving the whole stack, so the common case is
capture → Space.

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

When control returns to you — including after Skip — a transient panel lists what the
bots did. It clears on your next move; it's a recap, not a log panel.

Continent labels on the map double as a progress readout — `AUSTRALIA 3/4 +2`, tinted
by whoever leads and solid once someone holds it outright. Being one territory off a
continent bonus is the most decision-relevant fact on the board, so it belongs on the
map rather than in a panel.

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

`General` and `Colonel` are the current tiers, with General the default opponent.
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
