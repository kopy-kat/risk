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

**Search is over plans, deliberately.** Raw-move MCTS looks like the obvious trap:
Risk's branching factor is astronomical (every source × every target × every army
split) and dice make playouts noisy, so a sampled search burns enormous effort to
arrive at mediocre moves. Searching five intents with expected-value combat is
tractable and produces better play.

Two thirds of that has since been measured and does not hold for *this* engine — the
move space is already collapsed, and combat resolves by expectation rather than
sampling. See "The search layer" below. The conclusion survives anyway: plans are
the right unit because they're what makes play legible as human, not because raw
moves are computationally out of reach.

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
heads-up, win rate, row vs column
           marshal  general  colonel     easy   random
marshal          —      61%      67%      77%     100%
general        40%        —      58%      69%     100%
colonel        33%      42%        —      67%     100%
easy           23%      31%      33%        —      99%
random          0%       0%       0%       1%        —
```

Mixed games (random seat counts, 150 games): marshal 42% · general 32% · colonel 19%
· easy 7% · random 1%.

At four seats: General beats Colonel 64/36, Marshal beats General 59/41 and Colonel
70/30.

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

Two failed attempts at hedging it are worth recording. Splitting the reinforcement
pool between objective and threatened border did nothing, because the engine
re-enters `decide` for the remainder and it lands at the same door. Defending first
at a full table was actively worse (−17). Commitment is either right or it isn't;
half-commitment is neither.

That closed the last gap in the ladder: Marshal went from level with General
heads-up to **62.7%**.

### Marshal used to tie General heads-up, and that was the correct answer

Both of Marshal's tools are inherently multi-player. "Eliminate a rival for their
cards" and "win the game" are the same sentence when there is one opponent, and
there is no table to read. The ablation is unambiguous:

| Marshal's addition | 2 seats | 4 seats |
| --- | --- | --- |
| elimination hunting | 0.0 | **+7.3** |
| table reading | +0.3 | **+4.3** |
| pressing an advantage | +0.2 | −1.7 |

That made Marshal a multiplayer specialist. The prediction at the time was that a
heads-up edge would need genuine multi-turn planning rather than another heuristic,
and that turned out to be right: the plan layer above supplied it.

Pressing an advantage was **removed**: it measured mildly *harmful*, which is not
what anyone would guess about "take longer odds when you're clearly winning".

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
3. **Colonel** — done. Beats the old bot 67/33 and random 100/0.
4. **Evaluation function** — done (`src/bots/strategy/evaluate.ts`). Positions scored
   in army units: income over a horizon, plus armies and hand value, minus exposure.
   Also rival tracking (income, hand size, adjacency, about-to-cash).
5. **General** — done. 57/43 over Colonel heads-up, 64/36 at four seats.
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

### The lookahead that didn't work — three times

Scoring candidate attacks by the position they lead to is the obvious next step and
it has now failed three times. Recording all three, because the failure is more
useful than the feature would have been.

| attempt | 2 seats | 4 seats |
| --- | --- | --- |
| 1. objective = score minus the **strongest rival** | +3 | −22 |
| 2. objective = own gain + **damage dealt**, discounted by table size | +2 | −23 |
| 3. as (2), with the evaluation fixed, weight scaled by table size | +4 | −10 |

Attempt 1 failed because measuring against the leader makes attacking anyone else
negative by construction: you spend armies, the leader doesn't. Attempt 2 fixed the
objective and barely moved, which is what exposed the evaluation bug above. Attempt 3
fixed the evaluation, finally produced a genuine heads-up gain — and still cost 10
points at four seats, tripling stalled games.

The remaining cause looks structural rather than tuneable: the scaling is by *live*
opponents, so late in a four-player game the weight ramps to full strength exactly
when the game should be closing out, and a bot that values position over tempo stops
finishing. More fundamentally, one ply is the wrong depth — the position after our
capture says little about the position after three replies.

A working version needs the opponent's reply modelled, not just our own move, and
should search **plans** rather than captures, which is what the architecture said
from the start. The one-ply shortcut is a dead end and the code has been removed
rather than left switched off.

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
they lead to — which is, structurally, the thing that just failed three times. It's
worth being explicit about why that isn't a fourth attempt.

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

Three things make that safe to look at:

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
entirely a question about what you can do next. But measured on the ladder, rolling
them out makes the reviewer *worse at telling the tiers apart*: with attacks and
occupations included `easy` came out better than Marshal, General and Colonel and no
adjacent pair separated; with occupations alone General and Colonel swapped. The
likely cause is the one `MAX_SHORTFALL` exists for — a loss is denominated in armies,
a rollout widens the gap between the best line and a reasonable one, and that gap
grows with the size of the position, which is to say with how well someone is
playing. Deploys have the most to gain from turn context and the least room for the
spread to run away, since every candidate is placing the same armies.

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

`npm run review-check` measures the result against the ladder, paired by seed the
way `bench.ts` pairs, over 20 games per tier:

```
marshal 1.64  <  general 2.34      paired gap −0.53 ± 0.55   ordered
general 2.34  <  colonel 3.38                 −0.24 ± 1.02   ordered
colonel 3.38  <  easy    6.62                 −2.15 ± 2.14   separated
easy    6.62  <  random  7.43                 −2.00 ± 1.87   separated
```

**All four pairs come out in the right order**, and the grade histogram is monotone in
both tails — the share of decisions graded best runs 75 / 73 / 70 / 55 / 36 down the
ladder, and blunders run 1.0 / 1.6 / 5.3 / 5.5 / 8.5 up it. Two of the four gaps are
wider than twice their standard error; the other two are the right sign inside it.
Marshal against General is the pair that should be hardest, and is: elimination
hunting and table reading pay off across turns rather than within one decision, which
is the same fact the ablation table above reports as "multiplayer specialist".

**Pairing is not optional here, and getting it wrong nearly shipped a bad number.**
The first version treated every decision as an independent sample. Decisions inside
one game are heavily correlated — a losing position produces a run of bad decisions —
so four thousand clustered decisions are nowhere near four thousand observations. The
error bars came out roughly 4× too tight, tight enough that the check passed at 20
games per tier and failed at 8 on the *same seeds*. Averaging within a game and
differencing across seeds fixes both the clustering and the map luck at once.

The consequence worth stating plainly: this check confirms the ordering and resolves
Colonel from `easy` and `easy` from `random` at twenty games. It does **not** resolve
Marshal from General or General from Colonel at that size. It is a guard against gross
miscalibration, which is what it is there for — not a fine-grained ranking.

7. **Plan layer** — done (`plans.ts`), gated to duels.
8. **Still open** — search *over* plans (as opposed to choosing one greedily),
   personality/posture variation so two Marshals don't play identically, and a
   plan layer that survives a full table.

## The search layer

Three lookahead attempts have failed, and all three were one ply deep. The tier
table's "lookahead: opponents' replies" row is still owed. This is the plan for
paying it, and the measurements that shape it.

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

The evaluation is the bottleneck, not the engine. `assess` walks all 42 territories
five or six times per call (`territoriesOf` inside `smoothIncome`, `incomeOf`, and
`exposure` each rescan). Caching that is the first optimisation if search ever
becomes evaluation-bound.

### Stages

Each stands alone and is measurable on the existing bench. Do not start one before
the previous is confirmed.

**A — max-n search over the existing move space.** Every player maximises *their
own* score rather than one player maximising a margin against the leader. That is
the structural version of what attempts 1 and 2 tried to patch with weights, and
unlike a weight it does not need switching off at a full table. Chance nodes
resolve by *expectation* through `winProb` / `expectedSurvivors` rather than
sampling — the exact tables in `combat.ts` remove the dice-noise objection to
search entirely. Tier by simulation budget *on top of* tier by plan set, so Colonel
still differs from Marshal in what it considers, not only in how long it thinks.

Acceptance: beats current Marshal at both 2 and 4 seats, outside the Wilson
interval, with no rise in stalled games. The four-seat number is where the previous
three attempts died, so it is the one that matters.

**B — learned leaf evaluation.** Replace hand-picked weights with weights fitted to
outcomes: harvest `(position, eventual winner)` from self-play, regress, ship as
JSON. **Zero dependencies** — plain least squares first, a small MLP only if linear
clearly underfits. The data half pays off before the model half, because fitting
weights independently adjudicates the hand-calibration above: if `ARMY_WEIGHT`
comes back near 0.5 that confirms it, and if it comes back near 0.15 that is a
finding.

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

- **"Top 1%" is unverifiable from here.** What can be guaranteed is that Marshal beats
  General beats Colonel by clear margins. The real acceptance test is a human.
- **Personality vs strength.** Two Marshals will play near-identically. Varying
  *posture* (aggressive / turtle / opportunist) on top of tier would make multiplayer
  games feel less uniform — worth doing after the tiers work.
- **No LLM**, by choice; nothing here needs one. The `Bot` interface would accept one
  unchanged if that ever changes.
