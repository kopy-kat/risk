# RISK

Risk for a laptop: the classic 42-territory board, driven from the keyboard, against
bots that actually play well. 2–6 seats, any mix of humans and bots, no accounts and
no server — it's a static page that runs entirely in the browser.

```bash
npm install
npm run dev        # then open the URL it prints
```

## Rules

Standard Risk, as implemented in `src/engine`:

- **Setup** — 42 territories dealt at random with 1 army each, then players place
  their remaining armies one at a time in turn order (40/35/30/25/20 for 2/3/4/5/6
  players).
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
undoes, `Shift`+click deploys everything at once. That is the whole list; the button
label carries its own hint, so nothing needs memorising.

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
- **Every game replays from one number.** The seed drives the deal, the dice and the
  bots; paste it into setup to re-run a game exactly.
- **Review your games.** Finished games are stored locally as a seed and a move list,
  and played back with the bot's opinion of every move — see below.

## Bots

Three tiers — **Marshal**, **General**, **Colonel** — and they are one brain at three
depths of thought, not three implementations. Tiers differ by *what the bot is allowed
to think about*, never by injected mistakes, so a weaker one reads as a player
considering less rather than a stronger one with noise added.

```
combat model    exact win/loss tables and expected survivors — no simulated rolls
evaluation      income, continent efficiency, border security, card equity, threat
plan layer      one intent for the turn: expand · consolidate · deny · cycle · decapitate
execution       turn the intent into concrete moves
```

The plan layer is what makes play legible: people think "I'm taking Australia this
turn", not "maximise a weighted sum". Colonel gets expand and consolidate; General
adds denial, card cycling and the discipline to decline ground it can't hold; Marshal
adds elimination hunting and reading who is about to be forced to cash.

Heads-up they separate cleanly — Marshal beats General 61/39, General beats Colonel
58/42. `npm run bench` measures that with paired seeds and seat rotation, because
going first is worth ~39 points heads-up and an unrotated comparison measures position
rather than skill. [`BOTS.md`](BOTS.md) has the design, the full results and the
lookahead attempts that failed.

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

Add it to `BOTS` in `src/bots/index.ts` and it appears in the seat picker. Then
`npm run bench -- mine general 300`.

## Development

The rules live in `src/engine` as pure functions — no React, no dependencies.
`applyMove` never mutates: it clones, validates, and returns the next state. That's
what makes ten thousand headless games take seconds, and it's what undo and replay are
built on.

| command | what it does |
| --- | --- |
| `npm test` | assertions over the rules (cards, combat, reinforcement, placement) |
| `npm run sim` | soak test: bot-vs-bot games, invariants checked after every move |
| `npm run bench` | head-to-head bot benchmark — paired seeds, seat rotation, Wilson intervals |
| `npm run review-check` | checks the reviewer measures skill, not noise |
| `npm run smoke` | browser end-to-end: play, record, replay, review (needs a `build`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `oxlint` over `src` and `scripts` |

CI runs `lint`, `typecheck`, `test`, `sim -- 300` and `build` on every pull request
(`.github/workflows/ci.yml`) — nothing it checks is unreproducible locally.

## Licensing

Code is MIT (`LICENSE`). The map geometry in `data/` is **not**: it's derived from
[`Risk_board.svg`](https://commons.wikimedia.org/wiki/File:Risk_board.svg) by
**Gr0gmint** on Wikimedia Commons, licensed **CC BY-SA 3.0**, and keeps share-alike
terms — see `data/LICENSE`.

"RISK" is a Hasbro trademark and the commercial board art is theirs. Game rules aren't
copyrightable and nothing here uses Hasbro artwork, but pick a different name and your
own map art before putting this anywhere public.
