# KESSEL — design and measurements

Operational battles on province maps, beside classic Risk. You win by cutting supply
and breaking cohesion, not by grinding stacks. It teaches what Risk cannot, because
Risk has no logistics, no morale and no way to end short of conquest: concentration
of force, the culminating point, envelopment, and fighting for objectives rather than
for ground.

Rules live in `src/games/kessel` as pure functions, on the same `applyMove` contract
as Risk. `npm run test:kessel` asserts them on a synthetic grid rather than the real
map — a rule that only holds on one arrangement of provinces isn't a rule.

## The one rule

Formations are pushed back by combat and destroyed only when they cannot retreat —
so encirclement, not attrition, is how an army dies.

Everything else exists to make that rule bite.

## Maps

Every mission has its own map, generated from a seeds file over a Natural Earth
coastline (see Missions). Natural Earth is public domain, so unlike the Risk board the
maps carry no share-alike terms. Seeds are real towns at real coordinates, so density
follows settlement. Provinces carry terrain, depot capacity and objective value; edges
carry shared border length, which narrows engagement across the tightest crossings.

Topology is the main tuning surface. Edit the seeds and regenerate — it takes under a
second — rather than patching geometry.

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
own supply network instead of marching, starting and ending out of contact. Infantry
marches two, so without it a reserve is local to the sector it stands in and where to
commit it is never a question.

**Mud.** Two turns in every ten — the ninth and tenth — the march halves and the
trains still run. It is on the calendar for both sides, so an offensive has a date it
has to have gone in by.

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

Two is the choice this forces: the main line can be commanded, and a flank then waits a
turn for its orders unless a headquarters goes there.

A side with no headquarters commands everything; the grid in `npm run test:kessel`
places none except where command itself is under test.

## Supply

Supply enters at the rear and flows through friendly-held provinces that are not in
an enemy zone of control — the **network**. Depots, capacity 1–3, serving two draw
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
| 0 exhausted | strength attrition each turn, while an enemy is pressing the pocket |

**Stocks.** A corps with no route home at all lives on what it carries: it keeps its band
the turn it is cut off and loses one every turn after, so a fully supplied corps has one
turn it can still attack out and is starving on the fourth. Without them a single ride
through an empty rear dropped a whole army to nothing in one turn — no pocket ever broke
out and nobody had a turn to relieve one. `supplyNext` is the one place the band is
decided; the bots and the evaluation read it rather than recomputing the line.

Capturing a depot that connects to your own rear resets chain depth, which is why
offensives are aimed at them. Encircling a force — depot under its feet or not — sends
its depth to infinity and the pocket collapses without a frontal assault once its
stocks are gone. A city held
by three dug-in infantry corps is worth more in defence than four armoured corps can
bring against it through one border each, which is correct; what makes it fall is the
cordon, not the assault.

Depot count is the lever that decides whether any of this matters: with a railhead
within a hop of every province the chain rules never bite.

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

## Objectives

Total conquest is not the win condition. A battle has one list of objectives for both
sides, scored on the line as it stands when the last turn has been fought, with
everything of value held breaking ties. So you can win a battle you did not annihilate,
and lose one in which you took ground. It ends early only when a side has no corps left.

The result names its margin: decisive when the two sides' shares of the objectives end
half apart or more, clear from a quarter, narrow below that or when ground broke a tie.

**Replacements.** A corps under strength that refits on a live railhead at full supply
regains a step every three turns. Nowhere else — replacements come by rail — so a rear
railhead is worth holding for its own sake and a cadre is a corps in six turns rather
than a write-off.

## Missions

A mission is data in its campaign's file under `src/games/kessel/campaigns`: its own map, who holds what, where
each side's supply enters, a fixed order of battle, the objectives, a turn limit and a
timetable of what arrives. An arrival detrains at the side's largest live railhead with
room, the one nearest home if several — or, given `at`, appears there if its side still
holds the ground and it has room: a reserve that was there all along, which is what an
ambush is on a map where the line is public and the reserve behind it is not.

A breakout, a relief or a withdrawal names the corps it is about in `save`, with how
many of them have to end with a route home for one, two and three stars. Saving the first
number wins it whatever the objectives say, so the objectives are what tempts the player
to stay. The two sides' shares of the
objectives sum to one, so the result is decisive at three quarters of the value held,
clear at five eighths.
The id carries a version; bump it on any edit, because the version is part of the rules
string a saved move list replays under.

**Maps are generated, not drawn**, at a scale where a pocket is several provinces across.
A map is a seeds file — `data/maps/<id>.seeds.json`, a town per province with lon/lat,
terrain, depot and value — run through `npm run gen-map -- --map=<id>`. For a new map,
`--fetch=data/maps/europe.coast.json` clips its coastline from the continent's, so no
download is needed.

Depots are capacity, not just railheads: each point serves two of draw, armour draws
two. Size a side's depots to its army or it opens short of supply and cannot attack.
Put the rear depots beyond two provinces of the front, or every doctrine garrisons them
instead of fighting — but a depot next to an enemy formation is dead from turn one, and
so is every bridgehead whose only road home runs past one. The generator decides who
borders whom, so check its output: `test:kessel` fails any mission whose player opens
short of supply.

The battles are grouped below by campaign, each on its own map so a campaign moves across
the country; only battles of different campaigns share one. Every attack is defended by **Defence in
Depth**, whose caution walks corps out of rings where Maneuver digs in and surrenders in
stacks; every German attack is fought by Maneuver. The best player-side doctrine in
`bench:missions` is meant to win between a tenth and a third of the time, because a person
beats the bots far more easily than they beat each other.

### France 1940 — Germany

**Gembloux** (`gembloux@2`, gembloux map, 67 provinces, 10 turns). Ten German formations at
Maastricht, Aachen, Eindhoven and Venlo against six Allied: the Cavalry Corps armour at
Hannut and garrisons at Liège, Namur, Leuven, Antwerp and Brussels, one more by rail on
turn 4. The objectives are Liège, Namur, Gembloux, Leuven, Brussels (worth two) and
Antwerp. The armour starts at Hannut: at Hasselt the battle is easier, and at Tienen or
Sint-Truiden the stars stop spreading.

**Sedan** (`sedan@3`, 68 provinces, 15 German formations against 14 Allied and four more
by rail to Paris on turns 3–7, 12 turns). The Prüm armour, the recon and the five northern
infantry corps are carried from Gembloux; the Luxembourg and Bitburg armour and the Trier and
Saarbrücken infantry are `fresh`, so a good Gembloux leaves the army the size it was written.
The Allied north starts in contact in Belgium — anything out of contact rides the
railway, and an Allied army free to rail home on turn one leaves nothing to encircle.
Allied corps caught in Belgium are the ones a German player pockets, so it is the mission
where Defence in Depth saves least. Verdun and Laon are held and Paris is reinforced
because with the French rear empty, armour through Arlon and Verdun took Paris on turn 5
and the Channel ports after it, and every Allied corps was cut off by turn 8.

**Arras** (`arras@2`, arras map, 56 provinces, 8 turns, enemy Maneuver). The Germans hold
a corridor three provinces wide from Laon, Guise and Le Cateau — their only supply entry —
to Abbeville, with bridgeheads south of the Somme at Poix, Conty and Moreuil. An armoured
and an infantry corps appear at Arras on turn 2 if the Allies still hold it, armour at
Compiègne on turn 3 and infantry at Beauvais on turn 4; the ambush is not in the briefing.
South of the Somme only Beauvais is held at the start, because every corps added there
walks into Amiens once the Germans leave it. Douai is the sixth objective so the Germans
start on three of seven points.

**Dunkirk** (`dunkirk@2`, flanders map, 53 provinces, 6 turns). The Germans hold the Aa
line from Desvres and St-Omer to Aire, Arras, Douai and the Dendermonde–Ath front; Arras
(worth two) and St-Pol are German-held objectives the pocket attacks. Montreuil and Arras
carry the depot capacity for the southern group to open in full supply. A full-strength
corps at Lens, or Ardres in German hands, makes it nearly unwinnable.

**Fall Rot** (`fallrot@1`, somme map, 10 turns, so the mud falls on its last two). The
Germans hold only the ground north of the Somme and the Aisne, on depots worth 13 so an
army of sixteen opens in full supply. Ten French corps hold the line with five behind it and
four more by rail. Weakening the line's garrisons does not make it easier; cutting the
second line does. On the somme map the Seine estuary makes Le Havre border Lisieux, and
Lisieux, Alençon and Auxerre are there to stop the generator joining Le Havre to Le Mans and
Troyes to Bourges.

**The Loire** (`loire@2`, loire map, 56 provinces, 6 turns). The Germans hold Paris to
Dreux, Verneuil and Nogent; rearguards at Mortagne, Chartres, Étampes, Fontainebleau and
Sens, armour at Châteaudun. The objectives are Orléans (worth two), Sully, Gien, Blois,
Amboise and Tours, and a corps appears on turn 4 at each of Orléans, Gien, Blois and Tours
still French. Beaugency is not an objective and Rambouillet and Montereau start French:
either way the race is a sprint.

### 1941 — the Soviet Union

**The Frontier** (`border@2`, lviv map, 69 provinces, 8 turns). Sixteen German formations
break out of Sokal, Velyki Mosty and Dołhobyczów towards Brody, with armour appearing at
Sokal on turn 2 and Dołhobyczów on turn 3 and infantry at Radymno on turn 2. Frontier corps
at strength 2 stand from Przemyśl to Lokachi, and eight have to end with a route home, six
for a star. Radymno starts German and empty and Velyki Mosty holds only the recon: with a
corps in each, two frontier corps die in every game and the upper stars cannot be reached.

**Dubno** (`dubno@1`, volhynia map, 67 provinces). Four mechanised corps arrive with `at` at Brody,
Kostopil, Zbarazh and Kostopil on turns 2–5, staggered because arriving together they win
every game. Zhovkva, Kamianka and Sokal start German and garrisoned: left Soviet, infantry
walks into Sokal on turn 2 and starves the panzer group.

**Minsk** (`minsk@1`, minsk map). Eleven pocket corps between Navahrudak and Valozhyn, the
ring's armour at Minsk and Dzyarzhynsk and on to Slutsk, four fresh corps attacking west
from the Berezina. The south-east is held thinly on purpose: a garrison at Rudzensk makes it
unwinnable. Stars at five, six and seven saved.

**Smolensk** (`smolensk@1`, smolensk map). Nine pocket corps at Smolensk, Katyn, Kasplya and
Rudnya, the ring shut at Yartsevo, Solovyovo and Dukhovshchina, relief from Dorogobuzh,
Safonovo, Kholm, Bely, Roslavl and Spas-Demensk — without the Spas-Demensk corps it cannot be
won. Krasny and Liozna carry German depots so the ring opens in supply. Stars at six, seven
and eight.

**Kiev Pocket** (`kievpocket@1`, kiev map, 7 turns). The ring is already shut at Romny,
Lokhvytsia, Lubny and Myrhorod and sixteen corps have to get east; stars at eight, ten and
twelve. A corps stands on Poltava because Khorol's zone of control otherwise kills the depot
and leaves the outside force short.

**Typhoon** (`typhoon@2`, vyazma map, 65 provinces, 11 turns, a defence). The Vyazma and
Bryansk pockets are German-held ground with no Soviet corps in them, because every corps in
a defence has to open in full supply. The objectives are Volokolamsk, Mozhaisk,
Maloyaroslavets, Kaluga, Tula and Moscow, Tula and Moscow worth two — so the Germans win by
taking the front towns. The front corps are at strength 1, the Siberians arrive on turns
4–6, and `destroy` is one and three.

**Before Moscow** (`counterblow@1`, moscow map, 66 provinces, 9 turns). The German spearheads stand at
strength 2 at Klin, Solnechnogorsk, Krasnaya Polyana, Yakhroma, Venyov and Stalinogorsk;
eight objectives, only Tula Soviet at the start. Tula's route home runs through a recon
corps at Tarusa, without which it opens cut off, and a fresh corps at Kimry stands in for
Torzhok, which borders only German ground.

### Battles on their own

**Kiev** (`kiev@2`, 56 provinces, 14 German formations in two wings against 17 Soviet,
two more by rail on turns 3 and 5, 10 turns so the mud is the deadline). The pincers are
three to four provinces from Lokhvytsia each, and the northern wing draws on a railhead
at Novhorod-Siverskyi because Gomel alone leaves it strained at the start. Most of the
value is the ring, not the city, and the briefing says so.

**Uranus** (`uranus@1`, 49 provinces, the Soviet Union). Two pincers from the Don
bridgeheads and the southern steppe meet at Kalach, against Romanian flanks, a garrison
at Kalach, and three German corps by rail to Kotelnikovo on turns 3–5 to break the ring.
Soviet supply enters at Yelan and Sadovoye on the map's edges, and a reserve corps holds
Frolovo, the Kletskaya bridgehead's only road home. Stalingrad is an objective, and its
garrison holds it however surrounded, so the decisive result means taking the city as
well as closing the ring.

**Falaise** (`falaise@2`, 65 provinces, the Allies). The German salient runs from Flers
to Falaise and Argentan, and its mouth is the Dives between Trun and Chambois; Canadians
from Bretteville and XV Corps from Alençon close it, against two SS panzer corps by rail
to Évreux on turns 3 and 4. Allied railheads sit at Caen, Alençon and three provinces or
more back, because Bayeux, Le Mans and Laval are two from the salient and bots walked off
the line to garrison them. Chambois, Sées and Mortagne start garrisoned: left empty, a
recon corps reaches Chambois on turn one and the whole salient is cut off by turn four.

**Kursk** (`kursk@1`, 51 provinces, the player defending as the Soviet Union). Sixteen
German formations, eight of them armour, strike from Oryol and Belgorod at fourteen
Soviet, with the Steppe Front arriving by rail on turns 2–5. Objectives are Ponyri,
Olkhovatka, Oboyan, Prokhorovka and Kursk. Panzers outrun their supply here far more than
at Bastogne, so `destroy` is six and nine: at four and six the doctrines took three stars
in a third of their games.

**Bastogne** (`bastogne@2`, 50 provinces, the player defending as the United States).
Thirteen German formations against seven thin American ones, with German depots a point
short of their army's draw — the fuel that ran out — so a German corps more by rail makes
it easier, not harder. The Americans get infantry on turn 3 and armour on turns 5 and 6;
the Germans armour on turn 2 and infantry on turn 3. Wiltz is a one-point railhead, or
the Clervaux corps opens strained through the forest. `destroy` is one and three.

**The enemy that learns.** After each commit, `tellsOn` reads the share of the enemy's
line the mover has left with at most one way out. `adapt` averages it over the mission
records still stored and adds six times that to the doctrine's `caution`, capped at 2 — only for an
enemy fighting Defence in Depth, since an attacker that learned caution would only attack less. That is the whole
of it, because it is the only habit a defending doctrine has an answer to: raising
`counterattack` against a player whose spearheads run short of supply changed nothing at
Sedan or Kiev, since a doctrine holding a line rarely attacks, and raising
`encirclement` against a player who stands with one way back helped at Sedan and made
Kiev easier by pulling the line apart to stand in choke points.

`caution` is the defender's missing reflex: a corps in contact with one way out or none
is ordered first, loses that much by holding, and gains it by reaching ground with two.
A garrison on an objective is exempt — ground held counts at the end however
surrounded, so walking off it gives away what the ring could not. Of the doctrines
only Defence in Depth has any, and caution is outside the exploit search. Against
Maneuver it cuts the corps a defender loses to pockets by about a fifth; above 2 it
starts costing objectives.

**Campaigns.** Missions are grouped into campaigns in `src/games/kessel/campaigns`, one
file each, fought in order by one side. The player's formations in a mission are slots:
the army carried out of the last battle fills them, strongest first by type, and a slot
nobody is left to fill stays empty; `fresh` ones are the draft and arrive whatever. A
lost battle is refought with the army it started with. Progress — the run under way, the
best total, the level — is kept per campaign in local storage, apart from the game records.

**Levels.** A campaign finished with two thirds of its stars goes up a level, to four:
every battle in it takes a turn off the limit — or adds one in a defence, where fewer
turns only means less to hold — and adds an enemy infantry corps by rail on turn 2. The
level and the army carried in are stored on each record, so a replay sets the battle up
the same way.

## Bots

Four doctrines — Attrition, Maneuver, Elastic Defence, Defence in Depth — as one parameterised policy
at different settings, so a bot reads as a commander with a view about war rather than
a weighted sum. `decideFor` plays any settings, which is what the search hill-climbs.

`npm run bench:missions` measures them from the player's side of every mission, through
the same worker pool as Risk's benchmark. It prints Wilson intervals, because a hundred
games cannot tell a real edge from a coin flip and reporting the raw score as settled
is how you end up tuning against noise.

All four garrison: valuable ground of theirs standing empty with an enemy two
provinces off is worth about what the province is, and whoever can reach it is
ordered before the front is. A rear nobody garrisons is a rear one armoured corps
takes, railhead and all, and the activation budget spent on the line never gets
round to it.

A side holding every objective is pulled back onto them rather than toward enemy
ground, which is a mission defender's whole brief.

All four send their headquarters before giving any order, each to the ground in
reach that commands the most strength the other does not, the contact line counting
double. They order formations in command before the rest, and none orders an assault
out of command.

Pricing a doctrine's own pockets — walking a failing corps back to its railheads,
standing in the last way out behind its line — does not beat the same doctrine without
it, and weighted heavily it loses.

**Cutting supply is priced, a corps at a time, by `sever`.** A march is worth the enemy
corps its route leaves with no route home — the ground it crosses as well as where it
stops, because a march takes both — and an assault is worth the corps of ours it
reconnects. Nothing moves while a side writes its orders, so who a corps standing in each
province would cut off is traced once a turn and cached. Guarding the provinces whose loss
would cut the doctrine's own corps off does worse than not guarding them: it pulls the
line apart to stand in the rear.

Bots see the whole board. The fog is the player's.

`npm run sim:kessel` is the soak — bot games with invariants checked after every move,
for the states nobody thought to write an assertion for.

## Review

The unit of judgement is a **turn**, not a move. You stage orders for up to 26 formations
and press one button, so the thing you chose is the whole order set, and grading it a
formation at a time would report a concentrated assault as three mediocre attacks and an
encirclement as four moves that achieved nothing.

An order set is priced against whole alternatives: what each of the four doctrines would
have ordered from that board via `decideFor`, and the player's own orders with one thing
changed. Each candidate goes through the engine five times under different generator
states and is averaged, on the same seeds for every candidate so the comparison is paired.
Five, because the ±15% on the cohesion bill is usually worth a fortieth of a step and
occasionally decides a wear threshold or a surrender — a single resolution prices the
roll rather than the plan. **Loss** is the gap to the best candidate, in steps; **luck** is
what the resolution that actually happened did against that average, and it is the only
place the real outcome is read.

`src/games/kessel/evaluate.ts` is the position score. Objectives dominate — they are
worth more than a whole army, which is what makes a battle you did not annihilate
winnable — over ground held, force discounted by supply, cohesion, readiness,
entrenchment, corps standing, and a debit for formations at or near a pocket. Two of those weights
were wrong in ways worth recording, because both made the reviewer recommend the opposite
of the game's thesis:

- **Ground and approach have to be scored, not just objectives.** Most of the map scores
  nothing at the end and objectives are a step function, so without a per-province term
  and a distance-to-objective term an army that stayed at home priced the same as one
  that fought to the edge of everything it wanted.
- **A ring is only worth what it can beat.** Charging the whole corps against any formation
  that loses its last road flags the entire front every turn, makes withdrawing it look
  free — at one ply the enemy has not walked into the gap yet — and prices the pincer that
  closes a ring as a blunder. It scales with how close the formation is to being pushed.

The scoring is the smaller half. Every named fault comes with the player's own orders with
that one thing changed, priced on the same seeds, so *"the corps in Dinant had one way
out, and the corps beside it could have stood in it"* carries a number that is a measured
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

`npm run review-check:kessel` is the check that this measures skill rather than noise,
over the missions with the seats swapped on paired seeds. The headline pairing is
Maneuver against a commander who fights hard and badly, because every doctrine is
competent and what separates them takes a battle to show, while what a reviewer exists
to catch is a mistake inside a turn. It also checks that luck averages to nothing while
loss does not, which is the property that keeps the two from contaminating each other.

Where it is weak is worth saying, and the check prints it rather than hiding it: **loss is
the gap to the best available alternative, so it measures how well a side used the options
in front of it.** A doctrine that holds, refits and declines to advance keeps its options
closed, and that is not something a per-turn measure can convict.

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

`npm run exploit:kessel` searches the doctrine parameter space by cross-entropy for the
setting that wins the player's side of the missions most often, against each mission's
own enemy, then re-measures the winner and the named doctrines on fresh seeds. That
second step is the one that matters: the search maximises over a noisy objective, so its
best score is biased upward by however much it managed to overfit.

The number it prints is **exploitability**: how far the found setting beats the best
named doctrine. A large gap found cheaply means the enemy has a hole a player will find
too. Re-run it after every rules or bot change.
