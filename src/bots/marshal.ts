import { makeStrategist } from './strategy/strategist'

/**
 * Tier 3 — aspirationally the level of a very strong player.
 *
 * Everything General does, plus the two things that most separate strong Risk
 * players from good ones:
 *
 *  - **Elimination hunting.** Knocking a player out hands you their entire hand.
 *    With an escalating cash-in that is routinely the biggest swing on the board,
 *    and it compounds: each elimination makes the next one easier.
 *  - **Reading the table.** Who is one card from a forced cash-in (and therefore
 *    about to arrive with an army), and who has spread themselves too thin to
 *    defend what they hold. Both are public information that weaker tiers ignore.
 *
 * It will also spend a set to convert a near-elimination into a certain one, which
 * is the card-timing decision that matters most.
 */
export const marshalBot = makeStrategist({
  key: 'marshal',
  name: 'Marshal',
  blurb: 'Hunts eliminations for the cards and watches who is about to cash',
  attackThreshold: 0.4,
  minSurvivors: 1.6,
  lossAversion: 0.2,
  plans: new Set(['expand', 'consolidate', 'deny', 'cycle', 'decapitate']),
  holdDiscipline: 1,
  modelsOpponents: true,
  cardPatience: true,
  retaliates: true,
  huntsEliminations: true,
  readsTable: true,
  usesPlans: true,
  formsCoalitions: true,
  sweepDepth: 3,
  draftsChokepoints: true,
  profilesOpponents: true,
})
