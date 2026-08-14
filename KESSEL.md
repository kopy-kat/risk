# KESSEL — design and measurements

Operational war on a province map, beside classic Risk. You win by cutting supply
and breaking cohesion, not by grinding stacks. It teaches what Risk cannot, because
Risk has no logistics, no morale and no way to end short of conquest: concentration
of force, the culminating point, envelopment, and war aims.

Rules live in `src/games/kessel` as pure functions, on the same `applyMove` contract
as Risk. `npm run test:kessel` asserts them on a synthetic grid rather than the real
map — a rule that only holds on one arrangement of provinces isn't a rule.

## The one rule

Formations are pushed back by combat and destroyed only when they cannot retreat —
so encirclement, not attrition, is how an army dies.

Everything else exists to make that rule bite.

## Map

`npm run gen-map` builds `data/maps/europe.json` from a hand-authored seed file over
a Natural Earth coastline. Natural Earth is public domain, so unlike the Risk board
this map carries no share-alike terms.

142 provinces, average degree 4.38, diameter 17, from Iberia to the Volga. Seeds are
real cities at real coordinates, so density follows settlement: the west is dense and
grinding, the east deep and open. Provinces carry terrain, depot capacity and
objective value; edges carry shared border length, which narrows engagement across
the tightest crossings.

Topology is the main tuning surface. Edit `data/maps/europe.seeds.json` and
regenerate — it takes under a second — rather than patching geometry.

## Formations

| field | meaning |
| --- | --- |
| `strength` | steps, 1–4. Lost slowly, and mostly to encirclement. |
| `cohesion` | 0–100. Readiness. Lost fast, regained in supply. |
| `wear` | damage since the last step loss. Every 100 costs a step, with no roll. |
| `type` | `infantry` · `armour` · `recon` |

Strength is what you have; cohesion is what you can use today. Splitting them is what
makes maneuver something other than faster attrition: a frontal attack spends cohesion
on both sides and moves the line, and a formation pushed twice is still at full
strength and can no longer attack.

- **infantry** — moves 2, draws 1 supply, holds ground, entrenches
- **armour** — moves 4, draws 2, hits hardest. Drawing double while travelling fast
  is why armoured spearheads culminate first. That is the lesson, not a balance knob.
- **recon** — moves 5, weak in combat, cheap. It gets behind a line and severs
  supply, which is what makes supply an active domain rather than bookkeeping.

Movement is an allowance spent over terrain, and it **ends the moment a formation
enters ground an enemy watches** — without that a fast formation laps the front
every turn and the front stops meaning anything. A march takes the ground it
crosses, not only where it stops, so riding across a supply line cuts it.

Differential speed is what makes the rest work. At a uniform one province a turn
armour is expensive infantry, nothing can outrun its own supply, and Elastic
Defence has nothing to counterattack — it lost almost every game until formations
had legs.

Each side deploys 26, the contact line first and the rest in depth. The starting
frontier is 14 provinces wide; far fewer than this and the armies never meet, no front
forms, and with no front there is nothing to flank.

## Activations

Seven provinces can be set in motion in a turn. Holding and refitting are free;
moving or attacking costs one for the province the order leaves from, so
concentrating a push is cheaper than spreading one and a fully manned line is not.

A commander who can order every formation every turn is not choosing anything.

## Supply

13 depots, capacity 1–3, serving two draw per point. Supply traces outward through
friendly-held provinces that are not in an enemy zone of control, costing 1 per
province and 2 through mountain, marsh or forest. A formation draws from the cheapest
reachable depot with capacity left; the ones at the end of the chain go short.

Degradation is graded, never deletion:

| state | effect |
| --- | --- |
| 3 supplied | full |
| 2 strained | may not attack |
| 1 failing | combat halved, cohesion decays |
| 0 cut off | strength attrition each turn, while an enemy is pressing the pocket |

Capturing a depot resets chain depth, which is why offensives are aimed at them.
Encircling a force sends its depth to infinity and the pocket collapses without a
frontal assault.

Depot count is the lever that decides whether any of this matters. At 24 depots every
province sat within one hop of a railhead and the chain rules could never bite.

Starvation needs an enemy adjacent to the pocket. Ungated, severing one rear province
kills an army the enemy has walked away from, and cordoning beats fighting.

## Combat

Low variance by design, so the reviewer can price a decision rather than narrate a
dice roll. The only random element is ±15% on the cohesion bill; step losses are fully
deterministic.

Attack value is `Σ strength × cohesion × supply × type`, defence the same × terrain ×
entrenchment. The ratio drives cohesion loss on both sides, the loser losing more.
A defender at zero cohesion retreats one province.

**A formation ordered to retreat with no friendly-reachable province surrenders.** A
province already packed to what its terrain holds is not a way out either.

Two formations can engage across open ground and one across anything that funnels, so
concentration has to be *aimed* rather than merely amassed. Converging from several
directions brings more to bear than piling onto one border, to a ceiling of four.

Death is asymmetric, and this is the incentive gradient the whole design rests on: a
formation beaten down in a stand-up fight leaves a cadre behind that plugs the gap, and
one destroyed in a pocket leaves nothing.

## War aims

Total conquest is not the win condition. Each side has a **will** track and an
objective set. Will falls with formations lost and objectives lost, rises with
objectives taken, and decays slightly every turn.

At or below the floor a side has no orders left to give and must ask for terms. The
other side may refuse, at a cost to its own will — so refusing a reasonable peace
exhausts you too, and two broken sides end the war whatever either wanted. Peace is
scored on the line as it stands, against each side's stated aims, with everything of
value held breaking ties.

So you can win a war you did not conquer, and lose one in which you took ground.

Weariness is deliberately small. It is the backstop that stops a stalemate running
forever, and anything large enough to decide games ends every war on the same turn
regardless of what happened in it.

## Bots

Three doctrines — Attrition, Maneuver, Elastic Defence — as one parameterised policy
at different settings, so a bot reads as a commander with a view about war rather than
a weighted sum. `decideFor` plays any settings, which is what the search hill-climbs.

`npm run bench:kessel` measures them on paired seeds with the seats swapped, through
the same worker pool as Risk's benchmark. It prints Wilson intervals and says so when
one spans 50%, because a hundred games cannot tell a real edge from a coin flip and
reporting the raw score as settled is how you end up tuning against noise.

No doctrine dominates: Elastic beats Attrition, and the other two pairings are inside
the interval. They still make different wars — Attrition against Elastic runs about a
third longer than either pairing with Maneuver.

`npm run sim:kessel` is the soak — bot games with invariants checked after every move,
for the states nobody thought to write an assertion for.

## Review

The unit of judgement is a **turn**, not a move. You stage orders for up to 26 formations
and press one button, so the thing you chose is the whole order set, and grading it a
formation at a time would report a concentrated assault as three mediocre attacks and an
encirclement as four moves that achieved nothing.

An order set is priced against whole alternatives: what each of the three doctrines would
have ordered from that board via `decideFor`, and the player's own orders with one thing
changed. Each candidate goes through the engine five times under different generator
states and is averaged, on the same seeds for every candidate so the comparison is paired.
Five, because the ±15% on the cohesion bill is usually worth a fortieth of a step and
occasionally decides a wear threshold or a surrender — a single resolution prices the
roll rather than the plan. **Loss** is the gap to the best candidate, in steps; **luck** is
what the resolution that actually happened did against that average, and it is the only
place the real outcome is read.

`src/games/kessel/evaluate.ts` is the position score. War aims dominate — a side's six
aims are worth more than twice its army, which is what makes a war you did not conquer
winnable — over ground held, force discounted by supply, cohesion, readiness,
entrenchment, will, and a debit for formations at or near a pocket. Two of those weights
were wrong in ways worth recording, because both made the reviewer recommend the opposite
of the game's thesis:

- **Ground and approach have to be scored, not just objectives.** Four fifths of the map
  scores nothing at the peace and aims are a step function, so without a per-province term
  and a distance-to-objective term an army that spent the war at home priced the same as
  one that fought to the edge of everything it wanted.
- **A ring is only worth what it can beat.** Charging the whole corps against any formation
  that loses its last road flags the entire front every turn, makes withdrawing it look
  free — at one ply the enemy has not walked into the gap yet — and prices the pincer that
  closes a ring as a blunder. It scales with how close the formation is to being pushed.

The scoring is the smaller half. Every named fault comes with the player's own orders with
that one thing changed, priced on the same seeds, so *"the corps in Basel had one way out —
Zurich — and Freiburg could have stood in it"* carries a number that is a measured
counterfactual rather than a share of the turn's loss. Seven of them: thin odds,
the culminating point, strained and idle, the pocket left open, standing with no way back,
dispersal, and formations left without orders at all — which cost you the entrenchment an
unordered formation never digs.

`npm run review-check:kessel` is the check that this measures skill rather than noise. The
headline pairing is Maneuver against a commander who fights hard and badly, because every
doctrine in the ladder is competent and what separates them takes a war to show, while
what a reviewer exists to catch is a mistake inside a turn. Maneuver wins those wars and
gives up about half as much per turn, resolved well outside the paired error bar. Over
twenty thousand turns luck averages to within a hundredth of a step of nothing while loss
averages well above it, which is the property that keeps the two from contaminating each
other.

Where it is weak is worth saying, and the check prints it rather than hiding it: **loss is
the gap to the best available alternative, so it measures how well a side used the options
in front of it.** Elastic Defence holds, refits and declines to advance, and comes out
with less to give up per turn than Attrition, which wins those wars. A doctrine that keeps
its options closed is not something a per-turn measure can convict.

## Fog

Not built. Staged cheapest-first when it is, because the expensive part of fog is
hidden *position*: it makes the bot's belief combinatorial and the reviewer's job
ill-posed.

1. **Fog of strength.** Ownership and formation counts stay public — front lines are
   known in real war. Strength, cohesion and type visible only on contact or under
   recon; elsewhere the last known value and its age. Belief is one scalar per
   province, so no particle filter and the reviewer prices against the belief vector.
2. **Order latency.** Formations outside an HQ's command radius execute one turn late.
   No hidden state at all, and it produces real friction.
3. **Hidden position.** Deferred. Costs the most and buys the least.

## How we know it isn't shallow

An invented design has no playtest history, so the open question is whether its
strategy space has a dominant line. A ladder of doctrines cannot answer it — each one
only ever plays opponents that think the way it does.

`npm run exploit:kessel` searches the doctrine parameter space by cross-entropy for
the point that beats a given doctrine hardest, then re-measures the winner on fresh
seeds. That second step is the one that matters: the search maximises over a noisy
objective, so its best score is biased upward by however much it managed to overfit,
and only fresh seeds say what it actually found. Anything that still clears the
interval is archived to `data/kessel-exploiters.json` and seeds the next search.

The number it prints is **exploitability**, and on an invented game it is a statement
about the rules rather than the bot: a large edge found cheaply means the design has a
dominant line and needs changing.

At six generations of eight candidates, two independent searches find nothing that
beats the strongest doctrine by more than the confirmation interval. That is a weak
statement — the budget is small and the interval is ±6 points — but it is the only
kind of evidence an invented design can have, and it is the number to re-run after
every rules change.
