import { colonelBot } from './colonel'
import { generalBot } from './general'
import { easyBot } from './easy'
import { randomBot } from './random'
import type { Bot } from './types'

/**
 * What a human can pick as an opponent. `easy` and `random` are deliberately not
 * here — they exist as benchmark rungs, not as something anyone should have to
 * play against.
 */
export const BOTS: Bot[] = [generalBot, colonelBot]

/** Everything registered, including the baselines. Used by the bench and the sim. */
export const ALL_BOTS: Bot[] = [generalBot, colonelBot, easyBot, randomBot]

export const BOT_BY_KEY: Record<string, Bot> = Object.fromEntries(ALL_BOTS.map((b) => [b.key, b]))

export const DEFAULT_BOT = generalBot.key

export type { Bot }
