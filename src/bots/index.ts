import { colonelBot } from './colonel'
import { generalBot } from './general'
import { marshalBot } from './marshal'
import { POOL } from './pool'
import { easyBot } from './easy'
import { randomBot } from './random'
import type { Bot } from './types'

/**
 * What a human can pick as an opponent. The rungs below are deliberately not
 * here — they exist to be measured against, not to be played against.
 */
export const BOTS: Bot[] = [marshalBot, generalBot, colonelBot]

/**
 * The strength ladder, strongest first. This is what the round-robin benchmark
 * ranks: three tiers plus the two fixed yardsticks, which never change, so
 * "tier vs `easy`" stays the one number that answers whether a change made the
 * bots stronger rather than merely rearranging the gaps between them.
 */
export const LADDER: Bot[] = [marshalBot, generalBot, colonelBot, easyBot, randomBot]

/**
 * Everything with a key, ladder and opponent pool alike. The registry the sim
 * draws seats from and the bench resolves names against.
 *
 * The `POOL` is out of the ladder on purpose. It answers a different question —
 * "is there a strategy this has no reply to?" — so ranking a tier against it
 * would be reading a diagnostic as a score, and round-robining the pool against
 * itself would measure nothing at all.
 */
export const ALL_BOTS: Bot[] = [...LADDER, ...POOL]

export const BOT_BY_KEY: Record<string, Bot> = Object.fromEntries(ALL_BOTS.map((b) => [b.key, b]))

export const DEFAULT_BOT = generalBot.key   // General is a fair default; Marshal is opt-in

export type { Bot }
