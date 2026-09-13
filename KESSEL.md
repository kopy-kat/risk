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

142 provinces, average degree 4.41, diameter 17, from Iberia to the Volga. Seeds are
real cities at real coordinates, so density follows settlement: the west is dense and
grinding, the east deep and open. Provinces carry terrain, depot capacity and
objective value; edges carry shared border length, which narrows engagement across
the tightest crossings.

Each side's **rear** is one fourteenth of the map at its own end by longitude — ten
provinces: Iberia, Ireland and Scotland for the west, the Volga for the east. Supply enters there and
reinforcements arrive there. Every province a side starts with has to connect to its
rear through the side's own ground, which is why Norway and the Maghreb carry sea
links to Scotland and Tangier: an enclave that cannot trace home is a pocket on turn
one.

Topology is the main tuning surface. Edit `data/maps/europe.seeds.json` and
regenerate — it takes under a second — rather than patching geometry.

Objective values are set so the ten provinces each side's aims are dealt from are worth
the same to both. Will moves three points per objective point taken or lost, so a side
whose targets are worth less breaks first. The map fingerprint in the rules version is
only the map's id and province count, so a change to values needs a `RULES_VERSION` tag.

## Formations

| field | meaning |
| --- | --- |
| `strength` | steps, 1–4. Lost slowly, and mostly to encirclement. |
| `cohesion` | 0–100. Readiness. Lost fast, regained in supply. |
| `wear` | damage since the last step loss. Every 100 costs a step, with no roll. |
| `rest` | turns spent refitting on a live railhead while under strength. Three regain a step. |
| `type` | `infantry` · `armour` · `recon` |

Strength is what you have; cohesion is what you can use today. Splitting them is what
makes maneuver something other than faster attrition: a frontal attack spends cohesion
on both sides and moves the line, and a formation pushed twice is still at full
strength and can no longer attack.

- **infantry** — moves 2, draws 1 supply, holds ground, entrenches
- **armour** — moves 4, draws 2, hits hardest. Drawing double while travelling fast
  is why armoured spearheads culminate first. That is the lesson, not a balance knob.
- **recon** — moves 5, weak in combat, cheap. It gets behind a line and severs
  supply, which is what makes supply an active domain rather than bookkeeping; and
  it sees two provinces out where everyone else sees one.

Movement is an allowance spent over terrain, and it **ends the moment a formation
enters ground an enemy watches** — without that a fast formation laps the front
every turn and the front stops meaning anything. A march takes the ground it
crosses, not only where it stops, so riding across a supply line cuts it.

Differential speed is what makes the rest work. At a uniform one province a turn
armour is expensive infantry, nothing can outrun its own supply, and Elastic
Defence has nothing to counterattack.

**Exploitation.** An assault costs two of the allowance; whatever is left is
ridden on with if the ground falls, over ground the enemy no longer stands on,
stopping on contact like any march. Armour has two left and recon three; infantry
has none. An attack order names where to ride to in advance, because the turn is
plotted and resolved as one — and the ring that closes in the turn it is broken into
is the whole difference between a breakthrough and a bulge the enemy has a turn to
seal.

**The railway.** A formation out of contact and at full supply moves six along its
own supply network instead of marching, starting and ending out of contact. The map
is seventeen wide and infantry marches two, so without it a reserve is local to the
sector it stands in and where to commit it is never a question.

**Mud.** Two turns in every ten — the ninth and tenth — the march halves and the
trains still run. It is on the calendar for both sides, so an offensive has a date it
has to have gone in by.

The West deploys 26 and the East 29, the contact line first and the rest in depth. The
starting frontier is 14 provinces wide; far fewer than this and the armies never meet,
no front forms, and with no front there is nothing to flank. The East's extra corps
offset a map that otherwise hands the West most wars between identical doctrines;
`npm run bench:kessel -- maneuver maneuver` prints the side split to re-tune against.

## Activations

Seven provinces can be set in motion in a turn. Holding and refitting are free;
moving or attacking costs one for the province the order leaves from, so
concentrating a push is cheaper than spreading one and a fully manned line is not.

A commander who can order every formation every turn is not choosing anything.

**Standing still is digging in.** A formation with no order holds, so a turn's orders
are what changes, not a roll call. A refit stands from turn to turn until the
formation is whole — full cohesion, and full strength or nowhere to rebuild it — and
a move or an attack is spent the turn it is given.

## Command

Each side has two headquarters. A formation more than three provinces of its own
ground from both is out of command: an order to move or attack it is carried out at
the side's next commit rather than this one, and it takes no other order meanwhile.
Holding and refitting are immediate.

A headquarters goes up to four provinces through its own ground and commands from
there the turn after, so sending one forward is a plan and never a way to reach this
turn's orders. Overrun, it falls back to the nearest ground its side holds out of contact.

Two is the choice this forces: the main line can be commanded, and Norway, the south
of Italy or the Maghreb then waits a turn for its orders unless a headquarters goes there.

A side with no headquarters commands everything; the grid in `npm run test:kessel`
places none except where command itself is under test.

## Supply

Supply enters at the rear and flows through friendly-held provinces that are not in
an enemy zone of control — the **network**. 13 depots, capacity 1–3, serving two draw
per point, are railheads on it: a depot on the network resets chain depth to zero and
issues supply; one the enemy has cut off from home issues nothing, and whoever stands
on it is in a pocket like anybody else. Chains cost 1 per province and 2 through
mountain, marsh or forest. A formation draws from the cheapest live depot with
capacity left; the ones at the end of the chain go short.

Degradation is graded, never deletion:

| state | effect |
| --- | --- |
| 3 supplied | full |
| 2 strained | may not attack |
| 1 failing | combat halved, and no cohesion recovered |
| 0 cut off | strength attrition each turn, while an enemy is pressing the pocket |

Capturing a depot that connects to your own rear resets chain depth, which is why
offensives are aimed at them. Encircling a force — depot under its feet or not — sends
its depth to infinity and the pocket collapses without a frontal assault. A city held
by three dug-in infantry corps is worth more in defence than four armoured corps can
bring against it through one border each, which is correct; what makes it fall is the
cordon, not the assault.

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
concentration has to be *aimed* rather than merely amassed. Each border admits its own
frontage, the best attack value first; converging from several directions brings more
to bear than piling onto one border, to a ceiling of four.

Death is asymmetric, and this is the incentive gradient the whole design rests on: a
formation beaten down in a stand-up fight leaves a cadre behind that plugs the gap, and
one destroyed in a pocket leaves nothing.

## War aims

Total conquest is not the win condition. Each side has a **will** track and six
**aims**, dealt at the start off a public menu: the ten most valuable provinces on the
other side of the line. The menu is public and the deal is not — everyone knew what the
enemy might want, nobody knew which. An aim is revealed when
its owner takes it, attacks it, or ends a turn with three formations beside it, so
intent is read off deployment, which is how it is read in a real war. Will falls with
formations lost and objectives lost, rises with objectives taken, and decays slightly
every turn.

At or below the floor a side can no longer be ordered forward: it holds, refits and
moves, and once a turn it may ask for terms. The other side may refuse, at a cost to
its own will, and the broken side then fights the turn out — so refusing a reasonable
peace exhausts you too, "fight on" is a turn rather than a word, and two broken sides
end the war whatever either wanted. Peace is scored on the line as it stands, against
each side's stated aims, with everything of value held breaking ties.

So you can win a war you did not conquer, and lose one in which you took ground.

The peace names its margin too: decisive when the two sides' shares of their own aims
end half apart or more, clear from a quarter, narrow below that or when ground broke
a tie. The winner is the result; the margin is what refusing terms while ahead can buy.

Weariness is deliberately small. It is the backstop that stops a stalemate running
forever, and anything large enough to decide games ends every war on the same turn
regardless of what happened in it.

## Time

Will decays; two things push the other way, both on a calendar both sides can read.

- **Replacements.** A corps under strength that refits on a live railhead at full
  supply regains a step every three turns. Nowhere else — replacements come by rail —
  so a rear railhead is worth holding for its own sake and a cadre is a corps in six
  turns rather than a write-off.
- **Reinforcements.** Every sixth turn each side receives a fresh infantry corps at
  its largest live railhead, the one nearest home if several. Largest rather than
  rearmost, because the railhead nearest home can be a backwater at the end of a sea
  link, and a corps that detrains a week's march from the war is not a reinforcement.
  A side that is losing can hold for the next draft; one that is winning had better
  finish before it arrives.

## Bots

Three doctrines — Attrition, Maneuver, Elastic Defence — as one parameterised policy
at different settings, so a bot reads as a commander with a view about war rather than
a weighted sum. `decideFor` plays any settings, which is what the search hill-climbs.

`npm run bench:kessel` measures them on paired seeds with the seats swapped, through
the same worker pool as Risk's benchmark. It prints Wilson intervals and says so when
one spans 50%, because a hundred games cannot tell a real edge from a coin flip and
reporting the raw score as settled is how you end up tuning against noise. The swap
hides the map, so every pairing also prints its games split West against East, and a
doctrine against itself measures nothing else.

Maneuver and Elastic both beat Attrition, and Maneuver against Elastic is inside the
interval. They still make different wars — Attrition against Elastic runs about half
as long again as either pairing with Maneuver. Each against itself, Maneuver and
Attrition split West and East inside the interval and Elastic leans East.

All three garrison: valuable ground of theirs standing empty with an enemy two
provinces off is worth about what the province is, and whoever can reach it is
ordered before the front is. A rear nobody garrisons is a rear one armoured corps
takes, railhead and all, and the activation budget spent on the line never gets
round to it.

All three send their headquarters before giving any order, each to the ground in
reach that commands the most strength the other does not, the contact line counting
double. They order formations in command before the rest, and none orders an assault
out of command.

Pricing a doctrine's own pockets — walking a failing corps back to its railheads,
standing in the last way out behind its line — does not beat the same doctrine without
it, and weighted heavily it loses.

Bots see the whole board. The fog is the player's.

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
counterfactual rather than a share of the turn's loss. Six of them: thin odds,
the culminating point, strained and idle, the pocket left open, standing with no way back,
and dispersal.

A candidate is an order set, so where a headquarters was sent is not judged — only what
the orders were worth, with every order out of command resolved the way the engine
resolves it, a turn late.

The reviewer prices the board as it was, not as the player could see it. Every fault it
names is computable from what the player could see — odds are only priced against
defenders in contact, and positions are public — but the value of a whole order set
includes the enemy's hidden cohesion and supply, so loss is a hindsight measure: fair
between candidates, which all see the same board, and not a measure of what was knowable.

`npm run review-check:kessel` is the check that this measures skill rather than noise. The
headline pairing is Maneuver against a commander who fights hard and badly, because every
doctrine in the ladder is competent and what separates them takes a war to show, while
what a reviewer exists to catch is a mistake inside a turn. Maneuver wins those wars and
gives up about half as much per turn, resolved well outside the paired error bar on both
readings. Over twenty thousand turns luck averages to within a few hundredths of a step
of nothing while loss averages over three steps, which is the property that keeps the two
from contaminating each other.

Where it is weak is worth saying, and the check prints it rather than hiding it: **loss is
the gap to the best available alternative, so it measures how well a side used the options
in front of it.** Elastic Defence wins its wars against Attrition and gives up no less per
turn doing it — that pair sits inside the error bar — because a doctrine that holds, refits
and declines to advance keeps its options closed, and that is not something a per-turn
measure can convict.

## Fog

Fog of strength, and nothing deeper. Ownership and formation counts are public —
front lines are known in real war. Type, strength, cohesion and supply are visible
only where a side can see: beside its own formations, or within two provinces of its
recon. Elsewhere a counter shows what was last seen of it and how many turns ago, or
nothing if it was never seen. Each side's sightings are state, updated after every
resolution, so a replay fogs exactly as the game did.

Bots see everything and the reviewer scores the whole board; the fog is the player's
experience, which is where it earns its keep. Hidden *position* is not built: it makes
a fair bot's belief combinatorial and the reviewer's job ill-posed, and in operational
war the line is known anyway — it is the reserve behind it that is not, and fog of
strength already hides what the reserve is worth. Headquarters are public for the
same reason.

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

At six generations of ten candidates, seeded by the archived exploiters, the search
finds a line that beats Maneuver: its best candidate confirms at 59% ±6 on fresh seeds,
an exploitability of nine points over an even split. It attacks at much the same odds
and wants a ring about as badly, but it pulls formations out to refit far earlier,
drives at its aims nearly twice as hard, and counterattacks what has outrun its supply
four times as readily.

That is the signal this number exists to give, and it is unanswered: the rules have a
line the doctrines do not cope with. Exploitability measured against a hand-tuned
opponent is partly a statement about the hand tuning, so `npm run fit-doctrine`, which
fits a champion against the whole archived population, is where answering it starts.
Re-run both after every rules change.
