import { makeStrategist } from './strategy/strategist'

/**
 * Tier 1 — aimed at roughly RISK: Global Domination's "Expert".
 *
 * Plays the map competently and nothing else: picks an efficient continent, masses
 * for it, garrisons what it holds, and uses exact combat odds so it never takes the
 * bad-value attacks that sink heuristic bots.
 *
 * What it deliberately does NOT do, and what the higher tiers add: break other
 * players' continents, time its card cash-ins, notice who is about to receive a
 * pile of armies, or hunt eliminations for the cards. It cashes sets the moment it
 * can and thinks only about the current turn.
 */
export const colonelBot = makeStrategist({
  key: 'colonel',
  name: 'Colonel',
  blurb: 'Plays the map well — takes an efficient continent and holds it',
  /**
   * 0.4, which is lower than it looks right. I hand-picked 0.7 as "what a human
   * would call a reasonable attack" and the benchmark disagreed: sweeping the
   * parameter found 0.4 wins 67% against the old bot where 0.7 managed 55%.
   * Expansion compounds in Risk — territories buy income, income buys cards — so
   * caution costs more than the armies it saves.
   *
   * It also matches this tier's brief: Colonel is the one that overextends.
   * Discipline is what General and Marshal add.
   */
  attackThreshold: 0.4,
  // winning a territory you cannot then hold is how won games get thrown away
  minSurvivors: 1.6,
  lossAversion: 0.2,
  plans: new Set(['expand', 'consolidate']),
})
