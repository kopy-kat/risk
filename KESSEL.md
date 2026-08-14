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
objective value; edges carry shared border length, which sets attack frontage.

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

- **infantry** — draws 1 supply, holds ground, entrenches
- **armour** — draws 2, hits hardest. Drawing double is why armoured spearheads
  culminate first. That is the lesson, not a balance knob.
- **recon** — weak in combat, cheap, exists to sit behind the line and sever supply.
  It makes supply an active domain rather than bookkeeping.

Each side deploys 26, the contact line first and the rest in depth. The starting
frontier is 14 provinces wide; far fewer than this and the armies never meet, no front
forms, and with no front there is nothing to flank.

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
| 0 cut off | strength attrition each turn |

Capturing a depot resets chain depth, which is why offensives are aimed at them.
Encircling a force sends its depth to infinity and the pocket collapses without a
frontal assault.

Depot count is the lever that decides whether any of this matters. At 24 depots every
province sat within one hop of a railhead and the chain rules could never bite.

## Combat

Low variance by design, so the reviewer can price a decision rather than narrate a
dice roll. The only random element is ±15% on the cohesion bill; step losses are fully
deterministic.

Attack value is `Σ strength × cohesion × supply × type`, defence the same × terrain ×
entrenchment. The ratio drives cohesion loss on both sides, the loser losing more.
A defender at zero cohesion retreats one province.

**A formation ordered to retreat with no friendly-reachable province surrenders.**

Frontage is the sum of shared border length across every province attacking, capped at
four. Converging on a province from several directions brings more to bear than piling
onto one border, and no province can absorb an unlimited stack.

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

Two things this got wrong and now doesn't: formations lost in combat cost no will at
all, so the track measured only starvation; and weariness was steep enough to decide
every game, which made each war end on the same turn regardless of what happened in it.

## Bots

Three doctrines — Attrition, Maneuver, Elastic Defence — as one parameterised policy
at different settings, so a bot reads as a commander with a view about war rather than
a weighted sum. `decideFor` plays any settings, which is what the search hill-climbs.

`npm run bench:kessel` measures them on paired seeds with the seats swapped, through
the same worker pool as Risk's benchmark. It prints Wilson intervals and says so when
one spans 50%, because a hundred games cannot tell a real edge from a coin flip and
reporting the raw score as settled is how you end up tuning against noise.

Maneuver beats Attrition, and both beat Elastic. Attrition beats Elastic by a wider
margin than Maneuver does, so the three are a matchup structure rather than a straight
ladder. The wars look different too: Maneuver settles Attrition in about a third of
the turns Attrition needs to grind down Elastic.

`npm run sim:kessel` is the soak — bot games with invariants checked after every move,
for the states nobody thought to write an assertion for.

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
