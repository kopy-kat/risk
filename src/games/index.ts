import { kessel } from './kessel'
import { risk } from './risk'
import type { GameDef } from './types'

/**
 * Every game the app can play. First is the default.
 *
 * A game joins this list only once its data and rules are complete — an entry
 * here is what makes its records replayable, and a half-registered game would
 * quarantine games it could actually have replayed.
 */
export const GAMES: GameDef<never, never>[] = [
  risk as unknown as GameDef<never, never>,
  kessel as unknown as GameDef<never, never>,
]

export const GAME_BY_KEY: Record<string, GameDef<never, never>> = Object.fromEntries(
  GAMES.map((g) => [g.key, g]),
)

export const DEFAULT_GAME = risk.key

/**
 * The fingerprint a record of `game` replays under.
 *
 * Each game owns its own version, so retuning one cannot quarantine another's
 * saved games. An unregistered game gets a string that matches nothing, which is
 * what stops a build that does not know a game from replaying it under the rules
 * of one it does — the boards would diverge and the replay would look plausible.
 */
export const rulesFor = (game = DEFAULT_GAME, scenario?: string): string => {
  const def = GAME_BY_KEY[game]
  if (!def) return `unknown|game:${game}`
  if (scenario === undefined) return def.rulesVersion
  return def.scenarios?.includes(scenario) ? `${def.rulesVersion}|${scenario}` : `unknown|scenario:${scenario}`
}

export type { GameDef, GameView, GameBot, CreateOptions } from './types'
