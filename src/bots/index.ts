import { colonelBot } from './colonel'
import { generalBot } from './general'
import { marshalBot } from './marshal'
import { easyBot } from './easy'
import { randomBot } from './random'
import type { Bot } from './types'

/**
 * The difficulty ladder, weakest first — one setting picks one rung for every bot
 * in the game. `easy` and `random` are deliberately not here — they exist as
 * benchmark rungs, not as something anyone should have to play against.
 */
export const BOTS: Bot[] = [colonelBot, generalBot, marshalBot]

/** Everything registered, including the baselines. Used by the bench and the sim. */
export const ALL_BOTS: Bot[] = [marshalBot, generalBot, colonelBot, easyBot, randomBot]

export const BOT_BY_KEY: Record<string, Bot> = Object.fromEntries(ALL_BOTS.map((b) => [b.key, b]))

export const DEFAULT_BOT = generalBot.key   // General is a fair default; Marshal is opt-in

export type { Bot }
