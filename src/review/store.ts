/**
 * Saved games, in `localStorage`.
 *
 * A game is stored as its seed and its move list — never as boards. `applyMove`
 * is pure and the generator state lives inside `GameState`, so those two things
 * replay the whole game exactly, dice and all. A 300-move game is about 20 kB of
 * JSON; the same game as 300 board snapshots would be several megabytes.
 */
import type { SeatConfig } from '../engine/game'
import { rulesFor } from '../games'
import type { Move as RiskMove, PlayerId } from '../engine/types'
import type { Tells } from '../games/kessel/adapt'
import { MAX_LEVEL } from '../games/kessel/missions'
import type { Carried, Move as KesselMove } from '../games/kessel/types'

/** A move of whichever game the record names — never a mixture. */
export type RecordedMove = RiskMove | KesselMove

const KEY = 'risk.games.v1'
/** Bump when the record shape changes incompatibly. */
const SCHEMA = 1
/** Oldest games are evicted past this. 5 MB of quota is roughly 150 games. */
const MAX_GAMES = 40

export interface GameRecord {
  id: string
  schema: number
  /** `RULES_VERSION` at the time it was played — see `isReplayable` */
  rules: string
  seed: number
  /**
   * The bots run off a second generator, seeded from the first. Replay doesn't
   * need it — bot *moves* are recorded like everyone else's — but keeping it is
   * free and it's what would let a game be re-run with the seats changed.
   */
  botSeed: number
  seats: SeatConfig[]
  /** Which game was played. Absent means `'risk'`. */
  game?: string
  /** the scenario it was set up from, when not the game's default */
  scenario?: string
  /** the level the scenario was set at, when above the first */
  level?: number
  /** Kessel: the army carried in from the campaign's last battle, which the setup depends on */
  army?: { type: string; strength: number }[]
  /** Kessel: the human side's tells over the game, which is what the next enemy learns from */
  tells?: Tells | null
  moves: RecordedMove[]
  /**
   * Indices of moves the app played on a human's behalf, i.e. "auto-place rest".
   * Reviewing someone for a move they didn't make is worse than not reviewing it.
   */
  assisted: number[]
  winner: PlayerId | null
  turns: number
  finished: boolean
  savedAt: number
}

/**
 * Whether this record can be replayed against the engine as it stands now.
 *
 * Rules drift is the one thing that silently corrupts a replay: change the
 * cash-in table and an old move list desyncs part way through, leaving a board
 * that looks plausible and is wrong.
 */
export const isReplayable = (r: GameRecord): boolean =>
  r.schema === SCHEMA && r.rules === rulesFor(r.game, r.scenario)

function read(): GameRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as GameRecord[]) : []
  } catch {
    // corrupt or unavailable (private browsing, disabled storage) — no history
    // is a better outcome than a crashed app
    return []
  }
}

function write(games: GameRecord[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(games))
  } catch {
    // over quota: drop the oldest half and try once more rather than losing the
    // game currently being played
    try {
      localStorage.setItem(KEY, JSON.stringify(games.slice(0, Math.floor(games.length / 2))))
    } catch {
      /* storage is unusable; play continues, history doesn't */
    }
  }
}

/**
 * Campaign progress, kept apart from the games: records are evicted past
 * `MAX_GAMES`, and a campaign half fought should not fall away with them.
 */
const CAMPAIGN_KEY = 'risk.campaigns.v1'

export interface CampaignProgress {
  /** the run under way: which battle is next, the army going into it, and the stars won so far */
  run: { at: number; army: Carried[] | null; stars: number[] }
  /** the most stars a finished run has won */
  best: number
  level: number
  /** the furthest battle any run has reached, which is how far practice is open */
  reached: number
}

const FRESH: CampaignProgress = { run: { at: 0, army: null, stars: [] }, best: 0, level: 0, reached: 0 }

function allCampaigns(): Record<string, CampaignProgress> {
  try {
    return JSON.parse(localStorage.getItem(CAMPAIGN_KEY) ?? '{}') as Record<string, CampaignProgress>
  } catch {
    return {}
  }
}

export const campaignProgress = (id: string): CampaignProgress => allCampaigns()[id] ?? FRESH

function saveCampaign(id: string, progress: CampaignProgress): CampaignProgress {
  try {
    localStorage.setItem(CAMPAIGN_KEY, JSON.stringify({ ...allCampaigns(), [id]: progress }))
  } catch {
    /* storage is unusable; the campaign simply doesn't advance */
  }
  return progress
}

/**
 * A battle won and moved on from: its stars and its survivors go into the run. The
 * last battle closes the run — scored against the best, and raising the campaign a
 * level once it has won two thirds of the stars it could have — and the next run
 * starts from the top.
 */
export function advanceCampaign(id: string, battles: number, stars: number, army: Carried[]): CampaignProgress {
  const p = campaignProgress(id)
  const run = { at: p.run.at + 1, army, stars: [...p.run.stars, stars] }
  const reached = Math.max(p.reached, run.at)
  if (run.at < battles) return saveCampaign(id, { ...p, run, reached })
  const total = run.stars.reduce((a, b) => a + b, 0)
  const mastered = total >= Math.ceil(battles * 3 * (2 / 3))
  return saveCampaign(id, {
    run: FRESH.run,
    best: Math.max(p.best, total),
    level: mastered ? Math.min(MAX_LEVEL, p.level + 1) : p.level,
    reached,
  })
}

export const restartCampaign = (id: string) => saveCampaign(id, { ...campaignProgress(id), run: FRESH.run })

/** Newest first. */
export function listGames(): GameRecord[] {
  return read().sort((a, b) => b.savedAt - a.savedAt)
}

export function getGame(id: string): GameRecord | null {
  return read().find((g) => g.id === id) ?? null
}

/**
 * Insert or replace by id. The app saves after every move, so a game abandoned
 * mid-turn is still reviewable — and an undone move disappears from the record,
 * which is correct, because it didn't happen.
 */
export function saveGame(record: Omit<GameRecord, 'schema' | 'rules' | 'savedAt'>): void {
  const full: GameRecord = {
    ...record,
    schema: SCHEMA,
    rules: rulesFor(record.game, record.scenario),
    savedAt: Date.now(),
  }
  const rest = read().filter((g) => g.id !== full.id)
  write([full, ...rest].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_GAMES))
}

export function deleteGame(id: string): void {
  write(read().filter((g) => g.id !== id))
}

export function clearGames(): void {
  write([])
}

/** Stable id for a game, so repeated saves overwrite one entry instead of piling up. */
export const newGameId = (seed: number): string => `${seed}-${Date.now().toString(36)}`
