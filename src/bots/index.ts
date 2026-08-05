import { easyBot } from './easy'
import { randomBot } from './random'
import type { Bot } from './types'

/** Add new agents here and they show up in the seat picker automatically. */
export const BOTS: Bot[] = [easyBot, randomBot]

export const BOT_BY_KEY: Record<string, Bot> = Object.fromEntries(BOTS.map((b) => [b.key, b]))

export const DEFAULT_BOT = easyBot.key

export type { Bot }
