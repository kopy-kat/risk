import { TERRITORY_IDS } from './board'
import type { Card, CardSuit } from './types'

const SUITS: CardSuit[] = ['infantry', 'cavalry', 'artillery']

/** 42 territory cards (14 of each suit) plus two wilds. */
export function buildDeck(): Card[] {
  const deck: Card[] = TERRITORY_IDS.map((territory, i) => ({
    id: i,
    suit: SUITS[i % 3],
    territory,
  }))
  deck.push({ id: 42, suit: 'wild', territory: null })
  deck.push({ id: 43, suit: 'wild', territory: null })
  return deck
}

/**
 * Escalating cash-in, as requested: 4, 6, 8, 10, 12, 15, 20, 25, then +5 forever.
 * Change this table to retune how fast the game snowballs — nothing else depends
 * on the specific numbers.
 */
export const CASH_VALUES = [4, 6, 8, 10, 12, 15, 20, 25]

export function cashValue(setsTraded: number): number {
  if (setsTraded < CASH_VALUES.length) return CASH_VALUES[setsTraded]
  return CASH_VALUES[CASH_VALUES.length - 1] + 5 * (setsTraded - CASH_VALUES.length + 1)
}

/** Three of a kind, one of each, or anything containing a wild. */
export function isValidSet(cards: Card[]): boolean {
  if (cards.length !== 3) return false
  const real = cards.filter((c) => c.suit !== 'wild')
  if (real.length < 3) return true
  const suits = new Set(real.map((c) => c.suit))
  return suits.size === 1 || suits.size === 3
}

/** Every valid 3-card combination in a hand, as arrays of card ids. */
export function findSets(hand: Card[]): number[][] {
  const out: number[][] = []
  for (let i = 0; i < hand.length; i++)
    for (let j = i + 1; j < hand.length; j++)
      for (let k = j + 1; k < hand.length; k++) {
        const combo = [hand[i], hand[j], hand[k]]
        if (isValidSet(combo)) out.push(combo.map((c) => c.id))
      }
  return out
}
