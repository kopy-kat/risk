# Bots

Design notes for the agents. The goal is three difficulty tiers that all play
*like people* — differing in judgement, not in handicaps.

| tier | target strength |
| --- | --- |
| **Colonel** | roughly RISK: Global Domination's "Expert" — the current entry point |
| **General** | a good club player |
| **Marshal** | aspirationally top-1% |

There is no "easy" tier. `random` stays in the codebase as a regression baseline but
is hidden from the seat picker.

## What the research says

**Tactical heuristics have a known ceiling, and it's exactly where the app's bots
sit.** Franz Hahn's Maastricht thesis round-robined Risk heuristics and found the
strongest simple combination to be: reinforce borders, attack with full force, and
attack only when the battle is better than 50%. The author calls the result
"moderately strong". RISK: Global Domination's developers describe each AI persona as
around 40 weighted attributes. Both are parameter bags with no planning layer, and
both land in the same place: tactically competent, strategically absent.

So the interesting work is not better tactics. It's adding the layer above them.

**Expert Risk is a card game wearing a map.** Strong-play sources converge on: take a
card every turn, time cash-ins deliberately, and eliminate players to capture their
hands. With our escalating sequence (4, 6, 8, 10, 12, 15, 20, 25, then +5) a late set
dwarfs map income — the entire 42-territory board yields only 14 armies a turn.

### Combat maths

Exact probability the attacker takes the territory, computed over the full battle:

```
atk\def     1     2     3     4     5     6     7     8
    2      42%   11%    3%    1%    0%    0%    0%    0%
    3      75%   36%   21%    9%    5%    2%    1%    0%
    4      92%   66%   47%   31%   21%   13%    8%    5%
    5      97%   79%   64%   48%   36%   25%   18%   12%
    6      99%   89%   77%   64%   51%   40%   30%   22%
    8     100%   97%   91%   83%   74%   64%   54%   45%
   10     100%   99%   97%   93%   87%   81%   73%   65%
   15     100%  100%  100%   99%   98%   97%   95%   92%
```

Break-even attacker:defender ratios: **3.00 against one defender, 2.00 against two,
1.50 against four, ~1.13 against eight**. The attacker's edge *grows* with stack size.

This is why "attack when you're above 50%" is a weak rule. It is true, and it still
loses games, because it says nothing about what the win costs. A bot needs expected
*surviving armies*, not just win probability.

### Continent economics

Computed from the real adjacency graph:

```
continent      size  bonus  borders  bonus/border
Australia         4      2        1          2.00
North America     9      5        3          1.67
Asia             12      7        5          1.40
Europe            7      5        4          1.25
South America     4      2        2          1.00
Africa            6      3        3          1.00
```

Australia is twice as efficient to hold as Africa. Total continent bonuses (24) far
exceed total territory income (14), so continents — and denying them — are where the
game is decided.

## Architecture

**One brain, three depths of thought.** Not three separate bots.

If the tiers share a reasoning core they read as the same species at different skill
levels, which is what "plays like a human" requires. Three independent
implementations produce three different species, and that reads as artificial no
matter how well each one plays.

```
  combat model      exact win/loss tables, expected survivors
        |
  evaluation        score a position: income, continent efficiency,
        |           border security, card equity, opponent threat
        |
  plan layer        pick an intent for the turn
        |             expand · consolidate · deny · cycle · decapitate
        |
  execution         turn the intent into concrete moves
        |
  search            shallow, over PLANS not raw moves
```

The plan layer is what the existing bots lack, and it's what makes play legible as
human: people think "I'm taking Australia this turn" or "I need to break their
Africa", not "maximise a weighted sum".

**Search is over plans, deliberately.** Raw-move MCTS is the obvious trap: Risk's
branching factor is astronomical (every source × every target × every army split) and
dice make playouts noisy, so a sampled search burns enormous effort to arrive at
mediocre moves. Searching five intents with expected-value combat is tractable and
produces better play.

## How the tiers differ

By **what the bot is allowed to think about** — never by injected mistakes. Random
blunders read as bugs, not as a weaker opponent.

| | Colonel | General | Marshal |
| --- | --- | --- | --- |
| combat odds | exact | exact | exact |
| plans | expand, consolidate | + deny, cycle | + decapitate, kingmaking |
| cards | cashes as soon as able | holds with a purpose | plays the set race |
| opponents | ignores them | tracks income and threat | tracks hands, predicts cash-ins |
| lookahead | this turn | its own next turn | opponents' replies |
| overextending | tends to | avoids it | punishes yours |

This mirrors how real players actually differ — a weak player isn't a strong player
with noise added, they're a strong player who isn't considering as much.

## Human-likeness guardrails

Explicit anti-tells, because these are what make a bot feel like a machine:

- no one-army trails left behind a conquest
- no thirty micro-fortifies to shave an army
- never attack on marginally positive EV just because it's positive
- retaliate when attacked — grudges are human *and* strategically sound
- don't perfectly optimise the last army in a stack

## Measuring

`npm run bench` — see the harness in `scripts/bench.ts`.

Two things make the numbers trustworthy:

- **Paired seeds.** The same seed is played by both configurations, so map luck
  cancels instead of adding variance.
- **Seat rotation.** Risk has a real turn-order advantage, so every pairing is played
  in both seat orders. The harness reports the turn-order edge separately — if it's
  large and a bot only wins from seat one, that's not a stronger bot.

Win rates come with Wilson confidence intervals. With 400 games a 55% result is
±4.9 points, so anything inside that is noise and not a reason to keep a change.

**Measured: going first is worth ~39 points heads-up.** Self-play over 600 games
lands at exactly 50.0% / 50.0% (the harness has no bias by construction), but the
seat breakdown shows seat one winning **69%** of two-player games. At four seats the
spread is ~15 points. Any comparison without seat rotation would be measuring
position, not skill — which is worth remembering when reading anyone else's Risk AI
results.

It's also a design input: a bot that knows it's moving last should play differently
from one that opened.

## Results so far

```
win rate, row vs column
           colonel     easy   random
colonel          —      67%     100%
easy           33%        —      99%
random          0%       1%        —
```

### What tuning Colonel actually taught us

I hand-picked an attack threshold of 0.7 as "what a human would call a reasonable
attack". Sweeping the parameter against the benchmark disagreed: **0.4 wins 67%
where 0.7 managed 55%.** Expansion compounds in Risk — territories buy income,
income buys cards, cards buy armies — so caution costs more than the armies it
saves. The tier brief already said Colonel is the one that overextends; the data
just agreed more strongly than expected.

Two bugs the harness caught that would otherwise have been invisible:

- **Unbounded memoisation.** `winProb` memoises every (a, d) pair below the starting
  one. Colonel masses into a single stack, so late-game it asked for
  `winProb(30000, 5000)` and blew past V8's Map limit. The bot then fell back to
  random moves in 205 of 600 games and *looked* merely weak. Large matchups are now
  scaled into an exactly-computable range. `stepBot` counts fallbacks and the bench
  reports them, because "the bot is bad" and "the bot is crashing" look identical
  from the outside.
- **Turtling after the goal.** `chooseGoal` returned continents already held, so once
  Colonel owned one, every remaining enemy territory scored as off-plan and ordinary
  conquests came out *negative* against loss aversion. It won the opening — 27
  territories to 15 at turn 30 — then sat still and lost. Held continents are now
  defended, not targeted.

## Build order

1. **Harness** — done (`scripts/bench.ts`). "Is this better?" is unanswerable without
   it, and the turn-order figure above shows why a naive comparison misleads.
2. **Combat tables** — done (`src/engine/combat.ts`). `winProb`, `expectedSurvivors`,
   `expectedLoss`, `armiesNeededFor`, `chainOdds`, pinned in tests against the known
   closed-form values (15/36 for 1v1, 2890/7776 for 3v2).
3. **Colonel** — done. Beats the old bot 67/33 and random 100/0.
4. **Evaluation function** — a real position score, rather than Colonel's per-target
   heuristic. Needed before the higher tiers can search over plans.
5. **General**, then **Marshal**, each validated against the tier below.

## Open questions

- **"Top 1%" is unverifiable from here.** What can be guaranteed is that Marshal beats
  General beats Colonel by clear margins. The real acceptance test is a human.
- **Personality vs strength.** Two Marshals will play near-identically. Varying
  *posture* (aggressive / turtle / opportunist) on top of tier would make multiplayer
  games feel less uniform — worth doing after the tiers work.
- **No LLM**, by choice; nothing here needs one. The `Bot` interface would accept one
  unchanged if that ever changes.
