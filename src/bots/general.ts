import { makeStrategist } from './strategy/strategist'

/**
 * Tier 2 — a good club player.
 *
 * Everything Colonel does, plus the four things that actually separate a decent
 * player from an adequate one:
 *
 *  - **Denial.** Breaking someone's continent costs them the same income that
 *    taking one would earn us, for the price of a single territory.
 *  - **Card cycling.** Guaranteeing a conquest every turn is free income; skipping
 *    it wastes a turn's worth of card equity.
 *  - **Patience.** The cash-in counter is global, so every set a rival trades
 *    raises the payout on ours. Colonel cashes on sight and leaves armies behind.
 *  - **Holding what it takes.** It checks what will border a territory *after* the
 *    capture and declines ground the neighbours would simply take back.
 *
 * Still missing, and left for Marshal: hunting eliminations for the cards,
 * predicting when a rival is about to cash, and looking past its own next turn.
 */
export const generalBot = makeStrategist({
  key: 'general',
  name: 'General',
  blurb: 'Breaks your continents, cycles cards, and only takes ground it can hold',
  attackThreshold: 0.4,
  minSurvivors: 1.6,
  lossAversion: 0.2,
  plans: new Set(['expand', 'consolidate', 'deny', 'cycle']),
  holdDiscipline: 1,
  modelsOpponents: true,
  cardPatience: true,
  retaliates: true,
})
