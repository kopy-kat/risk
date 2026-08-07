import { colonelBot } from './colonel'
import { generalBot } from './general'
import { marshalBot } from './marshal'
import { POOL } from './pool'
import { easyBot } from './easy'
import { randomBot } from './random'
import type { Bot } from './types'

/**
 * The difficulty ladder, weakest first — one setting picks one rung for every bot
 * in the game. `easy` and `random` are deliberately not here — they exist as
 * benchmark rungs, not as something anyone should have to play against.
 */
export const BOTS: Bot[] = [colonelBot, generalBot, marshalBot]

/**
 * What the round-robin benchmark ranks, strongest first: the three tiers plus the
 * two fixed yardsticks, which never change, so "tier vs `easy`" stays the one
 * number that answers whether a change made the bots stronger rather than merely
 * rearranging the gaps between them.
 *
 * Same three tiers as `BOTS`, ordered the other way and with the rungs added —
 * one list is what a person picks from, the other is what gets measured, and
 * they drift apart the moment either gains an entry.
 */
export const BENCH_LADDER: Bot[] = [marshalBot, generalBot, colonelBot, easyBot, randomBot]

/**
 * Everything with a key, ladder and opponent pool alike. The registry the sim
 * draws seats from and the bench resolves names against.
 *
 * The `POOL` is out of the bench ladder on purpose. It answers a different
 * question — "is there a strategy this has no reply to?" — so ranking a tier
 * against it would be reading a diagnostic as a score, and round-robining the
 * pool against itself would measure nothing at all.
 */
export const ALL_BOTS: Bot[] = [...BENCH_LADDER, ...POOL]

export const BOT_BY_KEY: Record<string, Bot> = Object.fromEntries(ALL_BOTS.map((b) => [b.key, b]))

export const DEFAULT_BOT = generalBot.key   // General is a fair default; Marshal is opt-in

export type { Bot }
