# Bots

Design notes for the agents. The goal is three difficulty tiers that all play
*like people* — differing in judgement, not in handicaps.

| tier | target strength |
| --- | --- |
| **Colonel** | roughly RISK: Global Domination's "Expert" — the current entry point |
| **General** | a good club player |
| **Marshal** | aspirationally top-1% |

There is no "easy" rung in the difficulty picker. `easy` and `random` stay in the codebase as
regression rungs — `easy` in particular is the **fixed yardstick**: it never changes, so
"tier vs `easy`" is the only number that answers whether a change made the bots stronger
rather than merely rearranged the gaps between them.

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
  table sense       who is running away with it, and is anyone stopping them
        |
  plan layer        pick an intent for the turn
        |             expand · consolidate · deny · cycle · decapitate
        |
  route planning    price a whole sequence of captures, not the next one
        |
  execution         turn the intent into concrete moves
```

The plan layer is what makes play legible as human: people think "I'm taking Australia
this turn" or "I need to break their Africa", not "maximise a weighted sum".

**There is no search layer, and that is a measured position rather than an omission.**
The original argument against raw-move search was that Risk's branching factor is
astronomical and dice make playouts noisy. Neither holds for *this* engine — the move
space is already collapsed (`deploy` offers `{1, all}`, `blitz` folds a whole battle
into one action) and the exact tables resolve combat by expectation. So search was
built, to that specification, and lost anyway. See "The search layer" below; the short
version is that the leaf evaluation is the binding constraint, not the search.

## How the tiers differ

By **what the bot is allowed to think about** — never by injected mistakes. Random
blunders read as bugs, not as a weaker opponent.

| | Colonel | General | Marshal |
| --- | --- | --- | --- |
| combat odds | exact | exact | exact |
| plans | expand, consolidate | + deny, cycle | + decapitate |
| cards | cashes as soon as able | holds with a purpose | plays the set race |
| opponents | ignores them | tracks income and threat | tracks hands, predicts cash-ins |
| the table | — | gangs up on a runaway leader | gangs up on a runaway leader |
| attacking | one capture at a time | one capture at a time | plans a route three deep |
| the opening | levels the ground it holds | levels the ground it holds | drafts the chokepoints |
| overextending | tends to | avoids it | punishes yours |

**"Lookahead" is not a row in that table, and that is the honest state of things.** No
tier searches past the move in front of it. Four attempts are recorded below.

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

`npm run bench` — see the harness in `scripts/bench.ts`. It ranks `BENCH_LADDER` in
`src/bots/index.ts`: the three tiers plus the two fixed rungs. That is a different list
from `BOTS`, which is the difficulty setting a person picks from; the opponent pool
below is in neither.

Two things make the numbers trustworthy:

- **Paired seeds.** The same seed is played by both configurations, so map luck
  cancels instead of adding variance.
- **Seat rotation.** Risk has a real turn-order advantage, so every pairing is played
  in both seat orders. The harness reports the turn-order edge separately — if it's
  large and a bot only wins from seat one, that's not a stronger bot.

Win rates come with Wilson confidence intervals. With 400 games a 55% result is
±4.9 points, so anything inside that is noise and not a reason to keep a change.

**Measured: going first is worth roughly 50 points heads-up.** Self-play lands at
exactly 50.0% / 50.0% (the harness has no bias by construction), but the seat
breakdown shows the opening seat winning three-quarters of two-player games; every
pairing in the results below reports a turn-order spread of 40–60 points. At four
seats it falls to ~10–15. Any comparison without seat rotation would be measuring
position, not skill — which is worth remembering when reading anyone else's Risk AI
results.

**It is also the single largest difficulty knob in the app, and it isn't a bot
change.** A fixed seat list hands seat one to whoever sits in it, which is worth more
than the entire distance from Colonel to Marshal. `drawForTurnOrder` in `App.tsx`
shuffles the seats from the game seed, so each seat's palette slot travels with it and
the order still replays exactly. The bench is untouched: it rotates seats by
construction and must keep doing so.

## Results

Win rate for the row, Wilson interval at 95%. Heads-up is 300 seeds × 2 seat orders;
four seats is 200 seeds × 4 rotations.

```
                    2 seats        4 seats
marshal > general   66.6 ±3.8     57.5 ±3.4
marshal > colonel   70.0 ±3.7     57.0 ±3.4
general > colonel   53.2 ±4.0     56.6 ±3.5

against the fixed `easy` rung — the yardstick for absolute strength
marshal > easy      80.5 ±3.2     94.0 ±1.6
general > easy      71.7 ±3.6     88.3 ±2.2
colonel > easy      68.4 ±3.7     94.2 ±1.6
easy    > random    97.9 ±1.1
```

Stalled games are 2% or below in every pairing. Mixed tables with random seat counts
(`npm run sim -- 300`, seats drawn from `ALL_BOTS`, so the opponent pool is in the
draw) put all three tiers in order and separate every step:

```
marshal 30.4% · general 24.6% · colonel 19.2% · blitzer 11.9% · easy 8.1%
farmer 3.5% · random 1.5% · banker 0.8% · camper 0%
```

That the middle of the ladder separates here and barely does heads-up is not a
contradiction: a six-way table with five kinds of opponent is a different game from a
duel, and it is the closest thing on this page to what the app actually opens on.

**Colonel outscoring General against `easy` at four seats is not a misprint**, and it
is the clearest illustration on this page of why a bench pairing is not a strength
measurement. Those tables are two of the tier against two `easy`, so General's denial
and coalition logic aims it at the strongest player present — frequently the *other
General* — while two Colonels ignore each other and farm the weak seats. It is the
"doing the bystanders' work" effect that scales denial by opponent count, showing up as
a scoreboard inversion. Heads-up, where there is no bystander, the order is correct.

**Read the `easy` column, not the tier-vs-tier column, to answer "did this get
stronger".** Every tier shares one brain, so a fix to `occupy` or `fortify` lifts all
three at once and *shrinks* the head-to-head gaps even as absolute strength rises. That
is exactly what happened: Colonel gained the most from the shared occupy fix, which is
why the heads-up General-over-Colonel step is the thinnest number on this page while
every tier beats `easy` by more than it used to.

**The ladder is uneven, and heads-up it is uneven in the wrong direction.** Marshal
separates cleanly (66.6 / 70.0) because route planning and the chokepoint opening both
pay in a duel; General over Colonel at 53.2 is barely outside chance. At four seats the
three steps are level at 57 but all narrower than the top tier deserves. The honest
summary is that the top of the ladder moved and the middle did not.

### What the bench cannot see

Every number above is a bot against a bot, which answers "is this stronger?" and cannot
answer "is there a strategy none of these has a reply to?". A bot only ever faces
opponents that think the way it does, so a hole shared by all three tiers is invisible
to every pairing at once.

Four recorded games against a person say what that misses. Marshal filled every other
seat; the person won three of them — at six, five and four seats. `npm run study`
replays an exported game and prints territories, armies and largest stack per seat per
turn, which is the shape that makes the pattern visible: in each win they hold four to
fourteen territories and carry between two and seven times the armies per territory any
tier does, while Marshal's largest stack sits at two to five for the whole game.

**But banking is the symptom, and the card economy is the cause.** In the six-seat game
the leader reached turn 53 holding 40 of 42 territories against the person's two, and
the log for the last four turns reads:

```
t53  leader  +11 · holds North America, South America
t53  leader  traded a set · +45      (then +50, and 20 territories taken)
t54  person  +3 · traded a set · +55
t55  leader  +33 · holds five continents
t56  person  +3 · traded a set · +65  → took all 42
```

`CASH_VALUES` runs 4, 6, 8, 10, 12, 15, 20, 25 and then **+5 forever**, so in a long
game a set outgrows the entire board. The leader's 40 territories and five continent
bonuses paid 33 a turn; the person's one set paid 65. Holding ground stopped being how
income works around turn 45 and no tier noticed, because in self-play games end before
the sequence gets there — the four-seat tier-vs-tier games above average 49 turns.

**And the tiers do not close games out.** Marshal left a two-territory player alive for
three consecutive turns while holding 40 territories. That is not a one-off: across 60
six-seat Marshal self-play games, 339 turns end with a rival that could have been
wiped out still standing — 5.6 a game — and 2 of those 60 games are won by a player who
was spared. (The test is crude and reads as an upper bound: it asks whether every one of
the rival's territories borders one of ours at 80%+ odds, not whether one stack can
actually chain through them all.) Eliminating a player takes their hand, and a hand is
worth more than the board late, so declining is not the small mistake it looks like.

The through-line: **elimination hunting and card timing are both priced against map
income, and late in a long game map income is the smaller number.**

### The opponent pool

`src/bots/pool.ts`. One parameterised policy, four named points, none of them a tier and
none of them offered as a difficulty. They are outside `BENCH_LADDER` on purpose —
ranking a tier against them would be reading a diagnostic as a score.

| point | what it does |
| --- | --- |
| `banker` | garrisons a home continent, banks the surplus, cashes it into one sweep |
| `blitzer` | takes anything better than a coin flip and never stops |
| `camper` | holds one small continent very hard and refuses to leave it |
| `farmer` | one territory a turn for the card, cashed on sight |

`npm run exploit -- --report` scores each against a table of the target. One candidate
against three or five of the tier, so the number to beat is an equal share:

```
                  4 seats (25.0%)   6 seats (16.7%)
banker                1.2 ±1.2          1.2 ±1.2
blitzer               9.7 ±4.4          6.4 ±3.7
camper                1.2 ±1.2          1.2 ±1.2
farmer                1.2 ±1.2          1.3 ±1.3
```

**None of them is an exploit, and the crude one is the best of them.** Every point that
banks armies is beaten worse than the one that just attacks, which is the first useful
thing the pool produced: banking without the card economy behind it is a pile of armies
behind a border that is too long to hold. `homeFocus` — sit in one continent and
garrison only its chokepoints — was added precisely to fix that and made `banker` and
`camper` *worse*, which is worth stating plainly rather than tuning away.

The one thing they are one policy family for: `npm run exploit` searches the space they
sit in, so a new exploit arrives as seven numbers rather than as a new file.

### Searching for exploits

`scripts/exploit.ts`. Cross-entropy over the policy space, maximising win rate against a
tier: sample candidates, keep the best third, refit, repeat. Seven dimensions of mixed
integers and reals, a noisy objective and no gradient, which is what CEM is for. The
named points seed the first generation, so it starts from the strategies a person would
have written by hand rather than from noise, and the search seed is reported so a run
that finds something replays exactly.

Two things keep the noise survivable. **Common random numbers**: every candidate in a
generation plays the same seeds in the same rotations, so selection compares strategies
rather than maps. And **one dispatch per generation**: all of a generation's games go to
the worker pool in a single call, so the cores stay saturated instead of draining
between candidates.

**Do not read a pool number off `npm run bench`.** The bench fills a table by cycling
its contenders, so `bench -- marshal blitzer --players 4` is two of each and reports
12.2 ±4.9 for the pair — about 6 a seat, against the 9.7 ±4.4 a lone `blitzer` scores
among three Marshals. Two exploiters divide a tier's attention and prop each other up,
which is a fact about the seating rather than about the strategy. `--report` is the
number to quote.

**No exploit, and the way it fails is the useful part.** 14 candidates × 8 generations
× 120 games against Marshal at four seats:

```
gen 0   11.2 ±5.4     garrison 1  expandTo 42  perTurn 42  safeOdds 0.50  cashAt  4  sweepRatio 99.00  homeFocus 0.00
gen 3   14.5 ±6.1     garrison 2  expandTo 35  perTurn 37  safeOdds 0.64  cashAt 26  sweepRatio  5.02  homeFocus 0.22
gen 7   16.1 ±6.4     garrison 2  expandTo 40  perTurn 40  safeOdds 0.76  cashAt 17  sweepRatio  5.50  homeFocus 0.18
```

It gains five points on the best hand-written point and still lands well under the 25%
an equal share is worth. **Every knob that makes a policy turtle is driven to its
inactive end**: `expandTo` and `perTurn` to their ceilings, so neither cap ever binds;
`sweepRatio` to 5.5, so the sweep never fires; `homeFocus` to 0.18, below the threshold
at which it does anything. What survives is an unbounded expander with a raised odds
threshold and mild card patience — a better-tuned `blitzer`.

That is the same conclusion as the tuning sweeps in "Things that measure worse than they
sound", reached from the other side of the board: **tempo beats position**, and an
adversary given a free hand to be patient declines to be.

It is also a finding about the space rather than about Marshal. The strategy that
actually beat Marshal depends on *surviving on two territories while the leader declines
to finish*, and no setting of these seven parameters steers a game into that — it is the
opponent's omission, not the policy's choice. Fixing the omission and re-running is the
measurement that says whether the omission was what mattered.

### The bench runs on every core

`scripts/parallel.ts`. Games are independent and fully determined by their seed, so this
is embarrassingly parallel, and outcomes come back indexed and are reassembled in job
order rather than completion order — the results are identical to running them in a row.
**800 four-seat games: 21s against 130s**, and the `marshal > general` figures above are
reproduced exactly, which is the check that matters.

Batches are small — several per worker, handed out as they finish. Game length varies by
an order of magnitude between pairings, so a contiguous split leaves most cores waiting
on one straggler.

Two things worth knowing before touching it:

- **A worker thread does not inherit tsx's module hooks.** `scripts/game-worker.ts` calls
  `register()` from `tsx/esm/api` and only then dynamically imports anything from the
  project. Moving those imports to the top of the file, where they belong everywhere
  else, breaks the pool with a module-not-found on an extensionless path.
- **`createGame({ record: false })`** stops `applyMove` appending to the move list and
  stops `clone` copying it, so per-move cost no longer grows with the length of the
  game. Nothing replays a benchmark game. Anything that will be saved, undone or
  reviewed needs it left on.

### The plan layer

Everything before it scored targets one at a time, which lets a bot drift — a
territory in Africa, then one in Asia, then reinforcing Europe, ending the turn
having advanced nothing. People don't play that way: they decide *"I'm taking
Australia this turn"* and spend the turn doing it.

`plans.ts` picks one intent per turn — expand, deny, decapitate, cycle or
consolidate — rates them all in armies-per-army-spent so different kinds are
comparable, and everything else serves the winner. It's recomputed from the
position each call rather than stored, so agents stay pure functions of state.

**Worth +10 points heads-up, and about −12 at four seats**, so it is gated to
duels. A plan is a claim about the next several turns; at a full table three other
people rearrange the board before your next one, so the claim expires before it
pays. In a duel it survives — which is exactly where the top tier needed help.

Three failed attempts at hedging it are worth recording. Splitting the reinforcement
pool between objective and threatened border did nothing, because the engine
re-enters `decide` for the remainder and it lands at the same door. Defending first
at a full table was actively worse (−17). And scaling the objective's pull by
`1/opponents` instead of gating it — so a plan is worth a third as much against three
people as against one, which sounds like the obviously right generalisation — still
cost 7 points at four seats and gained nothing heads-up. Commitment is either right
or it isn't; half-commitment is neither, three times over.

### Elimination hunting and table reading are multiplayer tools

Both are inherently so. "Eliminate a rival for their cards" and "win the game" are the
same sentence when there is one opponent, and there is no table to read. The ablation is
unambiguous, and it is why Marshal's heads-up edge had to come from the plan layer,
route planning and the opening instead:

| Marshal's addition | 2 seats | 4 seats |
| --- | --- | --- |
| elimination hunting | 0.0 | **+7.3** |
| table reading | +0.3 | **+4.3** |
| pressing an advantage | +0.2 | −1.7 |

These two make Marshal a multiplayer specialist and nothing else, so its heads-up edge
has to come from somewhere structural rather than from another table-reading heuristic.
The plan layer, route planning and the chokepoint opening are that somewhere.

"Pressing an advantage" — taking longer odds when you're clearly winning — is **not**
implemented, because it measures mildly harmful, which is not what anyone would guess.
Turtling when the table turns on you is the same idea from the other side and measures
much worse (−7.5). Both belong to a pattern: adjusting aggression to how the game is
going, in either direction, loses to just playing the position.

### Strategy inverts with table size

The most useful thing the benchmark has produced. Ablating General's four additions
against Colonel gave near-opposite answers at two and four seats:

| addition | alone, 2 seats | alone, 4 seats |
| --- | --- | --- |
| denial | **57.5%** | 46.5% |
| hold discipline | 50.1% | **58.2%** |
| card cycling | 50.0% | 51.7% |
| card patience | 49.3% | 51.4% |

Heads-up, denial is the *entire* gain — strip it and General falls to 49.9%, pure
chance. At four seats denial is actively negative and discipline is everything.

Both directions have the same cause. Breaking a continent costs you a territory and
costs them their income, but the relief is *shared with everyone still standing*.
Heads-up you capture all of it; at a full table you're doing two bystanders' work.
Overextension mirrors it: sprawl heads-up has one punisher, sprawl at a full table
has three.

So both are scaled by live opponent count. Doing that lifted the four-seat result
from 56.7% to 64.4% while leaving heads-up unchanged, and cut stalled games from 54
to 36 per 600.

The general lesson for Marshal: **a tier tuned only heads-up will be wrong**, and
possibly backwards, at the table sizes people actually play. Benchmark both.

Card cycling and patience measured as roughly neutral at both counts. They're kept
because the effect is small rather than adverse and the mechanisms are sound — but
they are not currently earning their keep, and that's worth revisiting rather than
assuming the strategy literature applies unchanged to this rule set.

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
3. **Colonel** — done. Beats `random` 100/0.
4. **Evaluation function** — done (`src/bots/strategy/evaluate.ts`). Positions scored
   in army units: income over a horizon, plus armies and hand value, minus exposure.
   Also rival tracking (income, hand size, adjacency, about-to-cash).
5. **General** — done. Current margins are in Results above rather than repeated here.
6. **Marshal** — done, with a caveat. Elimination hunting and table reading both pay
   at four seats and do nothing heads-up.

### The evaluation was quietly broken

Diagnosing the lookahead turned up a real modelling bug. Sampling 2,309 clearly
favourable captures (≥ 70% win probability) and scoring each with `assess`:

```
                          before fix   after fix
mean delta to our score       +1.61       +2.70
captures scoring NEGATIVE       58%         11%
```

**58% of attacks a good player makes without thinking scored as losses.** Two causes:

- **Income was a step function.** Real income is `floor(territories / 3)`, so two
  captures in three change it by exactly nothing. As an optimisation target that is
  hopeless. Scoring now uses unfloored territory income — the *marginal* value of a
  territory really is a third of an army per turn.
- **Armies were weighted as an end.** Counting them 1:1 against income made every
  trade of armies for ground look like a loss. They're a means; they're now weighted
  0.5, and exposure 0.25, since a fresh conquest always creates an under-garrisoned
  border.

This is a correctness fix rather than a win-rate one — the ladder is unchanged — but
anything that scores positions was building on sand.

### The lookahead that didn't work — four times

Scoring candidate attacks by the position they lead to is the obvious next step and
it has now failed four times. Recording all four, because the failure is more
useful than the feature would have been.

| attempt | 2 seats | 4 seats |
| --- | --- | --- |
| 1. one ply, objective = score minus the **strongest rival** | +3 | −22 |
| 2. one ply, objective = own gain + **damage dealt**, discounted by table size | +2 | −23 |
| 3. as (2), with the evaluation fixed, weight scaled by table size | +4 | −10 |
| 4. **max-n search**, chance nodes by expectation, depth 4 / 5 / 8 | −1 | −10 to −20 |

Attempt 1 failed because measuring against the leader makes attacking anyone else
negative by construction: you spend armies, the leader doesn't. Attempt 2 fixed the
objective and barely moved, which is what exposed the evaluation bug above. Attempt 3
fixed the evaluation, finally produced a genuine heads-up gain — and still cost 10
points at four seats, tripling stalled games.

Attempt 4 is the one that settles the question, because it removes every objection
raised against the first three. It was a genuine max-n search: a value *vector* with
one component per seat, each mover maximising their own component, so nobody is
modelled as trying to hurt anybody and the table-size weight that the earlier attempts
kept having to switch off is gone by construction. Blitzes were chance nodes with two
children weighted by `winProb` and filled in from `expectedSurvivors` /
`expectedDefendersLeft`, so there was no playout noise either. Candidate moves came
from the doctrine's own attack scores, so it explored what the heuristic already liked
and asked whether it still looked good after a reply. It needed a leaf evaluator ten
times faster than `assess` — one pass over the board scoring every seat at once — which
duly worked.

Marshal against General at four seats, against 58.8% for no search at all:

```
depth 4   46.9%    stalled games  1.3%
depth 5   49.2%                   1.7%
depth 8   38.3%                  12.5%
```

**Deeper is monotonically worse**, and that is the finding. The search is not buggy —
it produces legal moves, never falls back, and the machinery does what it says. It is
optimising `assess` harder, and `assess` does not survive being optimised hard.
BOTS.md already says as much about `EXPOSURE_WEIGHT` in the reviewer section: the
evaluation is calibrated as a *comparator for small local changes*, where its unbounded
and hand-picked parts largely cancel. A search maximises it globally instead, so those
parts stop cancelling and start driving, and depth amplifies the error rather than the
signal. The depth-8 stall rate is the visible symptom — a bot that has learned to
value position over tempo and stops finishing games.

So the ordering in the build order below is wrong, and this is the correction:
**stage B is a prerequisite for stage A, not a follow-on.** Search cannot be validated
against a leaf evaluation that was never fitted to outcomes. The code has been removed
rather than left switched off, per the same rule that removed the one-ply version — but
the two reusable pieces are named above and are cheap to rebuild: the all-seats
one-pass evaluator, and candidate generation driven by the doctrine's own scores.

### Ganging up

Human games turn on this as much as on any tactic: the moment somebody is clearly
winning, everyone else stops fighting each other and turns on them, and the truce
dissolves the moment the leader is back in the pack. It needs no negotiating, which is
what makes it available to a bot — the position is public, so every player reads the
same board and reaches the same conclusion independently.

`coalition` in `evaluate.ts`, for General and Marshal. Three conditions, and every one
of them was forced by a measurement:

- **Against the runner-up, not the field average.** The average version reads like the
  right definition and behaves as a standing policy of attacking whoever is nominally
  ahead: eliminations and ground-down players drag the mean down, so the ratio only ever
  climbs. Live on 83% of turns at a mean 2.64×, and −8 points at four seats. It is
  lookahead attempt 1 wearing a different hat.
- **The leader must hold 45% of the board.** Cutting the leader down is a *public
  good* — you pay the armies and everyone still standing collects the relief. At 30%
  the individually correct play is to free-ride, and a bot that goes in anyway simply
  loses. Near half the map that inverts: nobody who lets the leader through wins at
  all, so joining stops being generous and becomes survival. This threshold is the whole
  difference between neutral and −4.
- **Reciprocity.** A bot joins only once somebody else is already taking ground off the
  leader, or once the leader has come for it — both meaning the armies are committed
  anyway. Going first unprompted costs 6 points, because in a mixed field the tiers
  without coalition logic free-ride on the ones with it.

The payload is a boost on the leader's ground scaled by how far clear they are, plus a
soft 0.6× discount on everyone else — the truce. Soft rather than absolute, so a free
elimination is still taken, and conditional on actually bordering the leader, because
declining to attack anyone you *can* reach is paralysis rather than diplomacy.

**Win-rate neutral** (55.3% against 55.9% for the control, n=1200 at four seats), kept
for the same reason retaliation is: it is on the human-likeness list. It fires on 23–29%
of turns and targets whoever is actually leading — on a mixed table, 36/35/30 across
Colonel, General and Marshal, so it is reading the board rather than a tier.

Two things that sound like the same idea and are not, both measured, both rejected:
turtling when the coalition is against *you* costs 7.5 points, because a leader holding
half the board wins by finishing; and aiming the pile-on at the leader's *continent
bonus* rather than their ground costs 4.4, despite being the cheap move a human table
actually makes.

### Planning a route instead of a capture

`sweep.ts`, Marshal only, three captures deep. It enumerates routes out of any stack of
four or more, carries the expected survivors from one fight to the next through
`chainOdds` — which existed, tested, and imported by nothing — and prices the whole
route in the same units `targetValue` prices a single tile, so the better of the two can
just be taken. A route wins when a cheap tile that scores nothing on its own opens one
that matters, which is exactly the case a greedy scorer cannot see.

Worth +1.7 against General at four seats, neutral against `easy` at both sizes. It
fires often — a two-or-more-tile route exists on 56% of attack decisions and Marshal
plays its head on about two thirds of those — so the modest gain is informative rather
than disappointing:

**Greedy re-entry already produces most chains implicitly.** After a capture the stack
is sitting on the frontier, so the next-best single target is usually the next tile of
the route anyway. The sweep's value is the cases where the *first* tile is worthless on
its own, and those are rarer than they feel. It is kept because it is a real difference
in how Marshal plays and reads as commitment rather than drift.

### The opening is a phase too

Every tier used to place its opening armies identically, and it is not a small phase:
20–40 armies, placed before a shot is fired. Marshal now drafts the **chokepoints** —
the territories that will have to hold the target continent, `CONTINENT_BORDERS`
intersected with what it owns — instead of levelling the ground behind them. Australia
has exactly one door, so the armies go there.

**+4.2 against `easy` and +3.5 against Colonel, heads-up**, neutral at four seats. The
largest single bot gain in this round of work, from the phase nobody had touched.

It does not generalise down the ladder, and the asymmetry is unexplained. Giving General
the same opening is tempting, because it evens the heads-up ladder considerably — the
two steps become 61/62 instead of 68/54 — but it costs General 4.2 points against `easy`
at four seats and thins both steps there to ~52. Since the app opens on four players,
that trade is the wrong way round, so this stays Marshal-only.

### Occupy reads both doors

How many armies follow a conquest was one of three decisions (with setup and fortify)
that no doctrine flag reached. It kept `garrisonFor(from)` and pushed the rest, which
never asks what the *captured* tile needs.

It now reads the garrison requirement on both sides — `to` is already ours by the time
the engine asks, so `garrisonFor` sees the post-capture board on both — and splits by
pressure when there isn't enough for both doors. The case that matters most: when the
source has become interior, everything advances, because armies left one tile behind the
front can neither attack nor defend.

Worth +3.7 to General heads-up and +2.5 at four seats. It also compresses the ladder,
because it helps Colonel more than it helps Marshal — a shared-brain fix shows up as
*less* separation between tiers even while every tier gets stronger, which is why the
absolute yardstick against `easy` is the one to read for "did this help".

### What the fortify phase is not

The fortify heuristic drains interior stacks into the front closest to falling, and
declines to move anything on about a third of turns. That looks like an obvious defect,
and 60% of those declined turns really do have three or more armies within reach of an
under-defended border, a mean of four armies sitting idle.

Moving them wins nothing. Two rewrites were measured — one ranking every connected
(source, target) pair by relief delivered, one massing forward toward the objective
instead of patching sideways — and both came in inside the interval at two seats and at
four. The first was actively catastrophic before being narrowed (Colonel 67% → 46.5%)
because it dismantled the main stack to top up distant borders, which is the clearest
demonstration available that **massing in one stack is already the correct policy** and
the idle armies are idle behind a front that isn't the decisive one. One move per turn
cannot repair that, and shouldn't try.

### Things that measure worse than they sound

Collected because each one is an idea a reasonable person would expect to work, and the
cost of re-discovering them is a day each.

| change | 2 seats | 4 seats |
| --- | --- | --- |
| defend a threatened border that carries no bonus | −8 | −16 |
| scale the attack threshold by target value | +1.5 | −4.5 |
| turtle when the table has turned on you | — | −7.5 |
| gang up on the leader's continent bonus rather than their ground | — | −4.4 |
| gang up unprompted, without reciprocity | — | −6 |
| plan objectives at reduced weight instead of gating them | 0 | −7 |
| rewrite fortify (two designs) | 0 | 0 |

And one that is inert rather than harmful: the flat "cash any set worth this much"
backstop in `shouldTrade` returns *identical* win rates at 10, 15, 20 and 25. The rules
above it decide first, and a game rarely runs long enough for the escalating sequence to
reach it. Card timing in this engine is entirely "cash when it buys the objective",
which is worth knowing before anyone tunes that number again.

The shape across all of them: **tempo beats position, and caution costs more than the
armies it saves.** That was already the lesson from sweeping Colonel's attack threshold
from 0.7 down to 0.4, and every result since has pointed the same way.

### Retaliation

Bots now bear grudges: an opponent who took ground from us in the last two turns is
weighted up as a target. Read from the game log — `LogEntry.victim` carries who lost
the territory — so agents stay pure functions of the position rather than
accumulating state.

Win-rate neutral, and kept anyway. It's on the human-likeness list, not the strength
list, and an attacker has already committed forces to our border so it isn't
*unsound* either.

### One ply is fine for judging attacks, and wrong for playing

The game reviewer (`src/review/price.ts`) scores candidate moves by the position
they lead to — which is, structurally, the thing that has now failed four times. It's
worth being explicit about why it isn't a fifth attempt.

The objection that killed the lookahead was depth: the position after our capture
says little about the position after three replies. That is an objection to
*predicting* a game still being played. A review predicts nothing — the game is
over, the replies are already in the record, and the only question is what the
alternatives were worth at the moment of choice. For an attack, one ply isn't an
approximation of that answer, it's the whole of it. No bot imports the module, and
the tiers are unchanged.

Its objective is own score minus the **sum** of rival scores over a divisor fixed
at the decision point. Both halves avoid a specific failure:

- Not attempt 1's *strongest rival*, which is negative by construction.
- Not the **mean** of live rivals either, which looks equivalent and isn't:
  eliminating the weakest player raises the mean of those left, so a mean-based
  objective scores the single biggest swing in Risk as a *loss*. A sum over a fixed
  divisor makes an elimination remove that rival's score outright.

It needed one new combat table, `expectedDefendersLeft` — the mirror of
`expectedSurvivors`, giving the losing branch of an attack. Without it that branch
has to be guessed, and a guess there biases every attack judgement the same way.
Both are pinned against Monte Carlo in `scripts/test.ts`.

And it is entirely downstream of the evaluation fix above. Built on the old
`assess`, the reviewer would have told people that 58% of their good attacks were
mistakes.

**A deploy can't be priced at one ply, and the fix is one turn deep.** Armies in hand
buy nothing until they're spent, and `objective` counts them either way — so at one
ply "place one army and think again" scores within a hair of the position before it,
and it was frequently the best thing the reviewer could find. Every deploy was
compared against a move that committed nothing, which is why the advice read as
having no idea what the turn was for. `evalLine` prices a deploy by applying it and
letting Marshal finish the turn behind it, which also gives the recommendation
something to say: *deploy 1 to Ural, then take Afghanistan*.

The candidate list has to widen to match, and this is the one place the reviewer
deliberately leaves the engine's move generation behind. `legalMoves` offers `{1,
all}` on each territory, which is the right branching factor for a bot and useless as
advice: the only reinforcement the reviewer could recommend was committing nothing or
committing everything, and a player who split their armies sensibly was compared
against neither. `candidateMoves` adds a third and a half of the pool on each border,
and roughly one deploy recommendation in five is now one of them. Borders only —
splitting an interior deploy is two bad ideas where there was one, the whole-pool
version is still there to be recommended against, and measured, every split worth
recommending was on a border anyway.

Three things make the rollout safe to look at:

- **No dice.** The continuation's attacks resolve to their likely board — above even
  odds, captured with the expected survivors — never to a roll. A maximum over
  *rolled* alternatives selects for the one the dice favoured, which invents blunders
  and grades the same game differently on a second viewing.
- **Discounted by reach.** Each step contributes what it adds times the chance of
  getting there. A gain three even-money attacks deep is worth an eighth of itself;
  counting it whole hands the comparison to whichever alternative has the longest
  line. Lines stop at four attacks and at the first elimination they claim, because
  past that a review is forecasting a conquest rather than explaining a move.
- **It only ever adds.** A move with nothing after it prices exactly as it did
  before — its own value is still the full expectation over both outcomes — so the
  grade bands stay anchored to what they were calibrated against.

**And it is confined to deploys, because the check says so.** A rollout has something
real to say about attacks and occupations too — how much of a stack to advance is
entirely a question about what you can do next. Widening the set has been measured
twice now, under two different sets of rules, and both times it made the reviewer
*worse at telling the tiers apart* on every pair at once: pairs that separated stopped
separating, the error bars widened everywhere, `review-check` failed outright, and it
cost several times as much.

**Roll out where one ply is blind, never where it is exact.** That is the durable
lesson and it explains the result. An attack's value is already integrated over its
exact outcome distribution, so rolling one out replaces an exact number with that
number plus a policy's guess about the rest of the turn — strictly more noise for no
more signal. A deploy has no exact number to replace, because armies in hand buy
nothing until they're spent. Turn context earns its cost there and nowhere else.

**Judging whole alternatives needs exposure bounded; playing doesn't.** `assess`
leaves exposure unbounded and `EXPOSURE_WEIGHT` sets its influence, which is right
for agents: they compare small local changes, and the unbounded part largely
cancels. A reviewer compares *whole* alternatives, and there a border facing a
180-army stack contributes a shortfall of a hundred on its own. Unbounded, Colonel's
fortifies scored a mean 14.8-army loss against Marshal's 0.9 — entirely because
Colonel's stacks are bigger, not because its fortifies are worse — and the reviewer
ranked Colonel below `easy` as a result. Bounded per territory at 12 (`garrisonFor`'s
ceiling) inside `src/review/price.ts`, deliberately not in `assess`, so nothing that
plays is touched.

`npm run review-check` measures the result against the ladder, paired by seed the way
`bench.ts` pairs. It takes the better part of an hour now that reinforcement is judged a
whole turn deep, so it is a gate rather than something to iterate against. Mean armies
given up per decision, 40 games per tier at four seats:

```
marshal 1.49  <  general 2.13      paired diff −0.41 ± 0.33   separated
general 2.13  <  colonel 2.36                  −0.33 ± 0.50   right order, inside error
colonel 2.36  <  easy    4.29                  −0.97 ± 0.97   right order, at the edge
easy    4.29  <  random  7.34                  −3.68 ± 1.06   separated
```

**All four pairs come out in the right order**, and blunders run monotonically up the
ladder — 0.9 / 1.4 / 1.7 / 4.1 / 7.9 percent of decisions from Marshal to `random`.

**This metric is highly sensitive to how long a tier's games run, and that is the thing
to check first when it disagrees with the bench.** A game that stalls is a sprawl nobody
can hold; it produces bad decisions from end to end and contributes all of them to the
average. Self-play at four seats, 20 games against a 300-turn cap:

```
marshal   40 turns   0 stalled   13.5k decisions
general   72 turns   1 stalled   24.5k decisions
colonel   36 turns   0 stalled   11.5k decisions
```

General plays the long game and contributes twice Colonel's decisions, which is why its
gap to Colonel stays inside the error bar rather than separating. Push its stall rate up
and this check reports it as the *weakest* of the top three while the bench still has it
ahead — so an inversion here is worth reading as a bot problem before a reviewer one.

Marshal against General is the pair that should be hardest, and is the one that
separates most cleanly here — which is not what the earlier ablation predicts, since
elimination hunting and table reading pay off across turns rather than within one
decision, and route planning only ever shows the reviewer the first tile of a route. The
honest reading is that a per-decision metric and a win rate are measuring different
things, and agreement between them is a check rather than a guarantee.

**Pairing is not optional here, and getting it wrong nearly shipped a bad number.**
The first version treated every decision as an independent sample. Decisions inside
one game are heavily correlated — a losing position produces a run of bad decisions —
so four thousand clustered decisions are nowhere near four thousand observations. The
error bars came out roughly 4× too tight, tight enough that the check passed at 20
games per tier and failed at 8 on the *same seeds*. Averaging within a game and
differencing across seeds fixes both the clustering and the map luck at once.

The consequence worth stating plainly: this check separates Marshal from General and
`easy` from `random`, and puts the other two pairs in the right order without resolving
them at this sample size. It is a guard against gross miscalibration, which is what it
is there for — not a fine-grained ranking.

7. **Plan layer** — done (`plans.ts`), gated to duels.
8. **Route planning** — done (`sweep.ts`), Marshal only, three deep.
9. **Coalitions** — done (`coalition` in `evaluate.ts`), General and Marshal.
10. **Learned leaf evaluation** — stage B below, and now the *blocking* item rather
    than an optional one: search cannot be validated against hand-picked weights.
11. **Opponent pool and exploiter search** — done (`src/bots/pool.ts`,
    `scripts/exploit.ts`). The search returns a negative result on the current space;
    see "Searching for exploits".
12. **Still open** — pricing the card economy against map income late (below),
    closing games out, personality/posture variation so two Marshals don't play
    identically, and a plan layer that survives a full table.

## The search layer

Four lookahead attempts have now failed. Three were one ply deep; the fourth was a
real max-n search built to the specification below, and it failed harder than the
three before it. The measurements are worth more than the feature would have been.

### Search is far cheaper here than the architecture note assumed

Branching factor, over five Marshal-vs-Marshal games, counted on the moves
`legalMoves` actually emits:

```
overall   mean 34.2   max 1756

setup     mean  21.0   max   21
deploy    mean  38.5   max   82
attack    mean  23.5   max   67
occupy    mean   8.8   max  102
fortify   mean 148.6   max 1756
```

Comparable to chess in the mean, and the whole tail is fortify — one move per turn,
where most candidates are near-equivalent and a search can restrict them freely.
Nothing about this is astronomical, because the engine already collapses the
combinatorics: `deploy` offers `{1, all}` rather than every split, `spread()` gives
fortify three amounts, and `blitz` folds an entire battle into one action.

Cost per operation, mid-game, four seats:

```
applyMove           1.54us
legalMoves          0.88us
assess (1 player)   9.85us
relativeStanding   31.27us     <- 60% of a simulation
```

A simulation at depth 8 costs ~51us, so **400 simulations is ~20ms** — affordable
in the browser at thousands. Self-play runs 69 games/second at ~260 decisions per
game, which is enough to benchmark a search change the same day it's written.

The cost estimate held up: a 400-node budget at depth 4–5 tripled bench wall-clock and
nothing worse, which is comfortably affordable. Speed was never what stopped this.

The evaluation is the bottleneck twice over — for throughput, because `assess` walks all
42 territories five or six times per call (`territoriesOf` inside `smoothIncome`,
`incomeOf` and `exposure` each rescan), and for *correctness*, which is the one that
actually matters. Scoring every seat in one pass over the board fixes the first and is
worth doing regardless; only stage B fixes the second.

### Stages

**Take B before A.** The original order had it the other way round, and building A
proved that wrong: the search worked and lost anyway, because there is nothing sound at
the leaf for it to maximise. See "The lookahead that didn't work" above for the
measurements.

**B — learned leaf evaluation.** Replace hand-picked weights with weights fitted to
outcomes: harvest `(position, eventual winner)` from self-play, regress, ship as
JSON. **Zero dependencies** — plain least squares first, a small MLP only if linear
clearly underfits. The data half pays off before the model half, because fitting
weights independently adjudicates the hand-calibration above: if `ARMY_WEIGHT`
comes back near 0.5 that confirms it, and if it comes back near 0.15 that is a
finding.

The specific thing to look for: `assess` is calibrated as a comparator for *small local
changes*, so a fitted version should differ most in the terms that only matter when
compared globally — exposure above all, which is unbounded and which the reviewer
already has to clamp for exactly this reason.

**A — max-n search over the existing move space.** Every player maximises *their
own* score rather than one player maximising a margin against the leader. Chance nodes
resolve by *expectation* through `winProb` / `expectedSurvivors` rather than sampling —
the exact tables in `combat.ts` remove the dice-noise objection to search entirely.
Tier by node budget *on top of* tier by plan set, so Colonel still differs from Marshal
in what it considers, not only in how long it thinks.

All of that has been built once and measured; the machinery is not the hard part and is
described above in enough detail to rebuild. Two implementation notes worth carrying
forward. `assess` in a loop is unaffordable — score every seat in one pass over the
board. And depth has to be counted in *turns*, not plies: from the attack phase, four
plies reaches only `endAttack` and `endTurn`, so the leaf lands before the next player
has deployed and the evaluation is systematically wrong about them.

Acceptance: beats current Marshal at both 2 and 4 seats, outside the Wilson
interval, with no rise in stalled games. The four-seat number is where all four
previous attempts died, so it is the one that matters.

**C — AlphaZero is deliberately not staged.** The compute is affordable; the
objections are design ones. Tiering breaks, because a net has one strength and
"Colonel doesn't think about denial" is what makes the tiers read as different
kinds of player rather than different amounts of one. The human-likeness guardrails
are anti-optimal by construction, so a net's output would need hand-filtering,
which reintroduces the heuristics. And stock AlphaZero mismatches this game three
ways: dice need chance nodes, 3–6 seats need max-n rather than minimax, and hidden
hands mean a net reading full `GameState` would train as a cheater. Revisit only if
A and B both land and plateau; A is a prerequisite for C regardless, so taking them
in order wastes nothing.

## Open questions

- **Income stops being about territory, and no tier notices.** `CASH_VALUES` escalates
  without bound while the whole board pays at most 14 plus continent bonuses, so past
  roughly turn 45 a set is worth more than everything anyone holds. Tier-vs-tier games
  average 49 turns and rarely reach it, which is exactly why the bench cannot see it.
  Two things follow and neither is implemented: hold cards when the sequence is about to
  overtake the map, and treat a player who can still take one territory a turn as
  dangerous regardless of how little they hold.
- **The tiers do not close games out.** 5.6 turns a game end with a rival that could
  have been wiped out still standing. The fix is cheap and the measurement is already
  written; what is unknown is whether forcing it costs anything elsewhere, since
  "pressing an advantage" measured mildly harmful and this looks like the same shape
  from the outside.
- **"Top 1%" is unverifiable from here.** The real acceptance test is a human, and the
  strongest available evidence says the heuristics are near their ceiling: of roughly a
  dozen plausible improvements measured in the last round, two paid, one was neutral and
  kept for human-likeness, and the rest were negative. Getting materially past here
  means stage B, not another flag — though the two items above are ordinary bugs rather
  than ceiling, and come first.
- **The middle of the ladder is thin heads-up.** General over Colonel is 53.2%, because
  every shared fix helps Colonel at least as much as General. Widening it needs a
  General-only capability that holds up at four seats, and chokepoint drafting — the
  obvious candidate — does not.
- **Personality vs strength.** Two Marshals play near-identically. Varying *posture*
  (aggressive / turtle / opportunist) on top of tier would make multiplayer games feel
  less uniform — worth doing after the tiers work.
- **A coalition is invisible except through its effects.** You can see two bots turn on
  the leader if you're watching the map, but nothing says so. Surfacing it would mean
  either the bots writing to the log — which would cost `decide` its purity — or the
  recap deriving it, which is where it belongs.
- **No LLM**, by choice; nothing here needs one. The `Bot` interface would accept one
  unchanged if that ever changes.
