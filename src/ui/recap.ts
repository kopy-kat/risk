/**
 * What the bots did while you weren't acting, as a scoreline rather than a
 * transcript.
 *
 * Read off two boards — the one you left and the one you got back — instead of
 * the log, because the log is a record of *moves* and the question a recap
 * answers is about *outcomes*. "Attacked Ural from China 3× · −2/−2" is four
 * lines of arithmetic away from the only three things you need before your next
 * decision: who grew, who shrank, and who is gone. Those three come out of a
 * board comparison in one pass and can't drift out of step with the rules the
 * way parsed log text would.
 *
 * The one thing a board pair can't answer is which player landed the killing
 * blow, so that comes from the log's `victim` field — structurally, not by
 * reading the text.
 */
import { TERRITORY_IDS } from '../engine/board'
import type { GameState, PlayerId } from '../engine/types'

export interface RecapRow {
  player: PlayerId
  /** net armies on the board, gained or lost */
  armies: number
  /** net territories held */
  territories: number
  /** players this one knocked out */
  killed: PlayerId[]
}

function holdings(s: GameState) {
  const armies = s.players.map(() => 0)
  const territories = s.players.map(() => 0)
  for (const t of TERRITORY_IDS) {
    armies[s.owner[t]] += s.troops[t]
    territories[s.owner[t]]++
  }
  return { armies, territories }
}

/**
 * Who took `p`'s last territory. The final entry that cost them ground is the
 * killing blow by definition — nothing can take ground from a player who is
 * already out — so the search runs backwards over the whole log and stops at the
 * first hit, which keeps it independent of where the recap window starts.
 */
function killerOf(s: GameState, p: PlayerId): PlayerId | null {
  for (let i = s.log.length - 1; i >= 0; i--) {
    const e = s.log[i]
    if (e.victim === p && e.player !== null) return e.player
  }
  return null
}

/** One row per player who has something to report. Empty means nothing happened. */
export function recapBetween(before: GameState, after: GameState): RecapRow[] {
  const was = holdings(before)
  const now = holdings(after)
  const rows: RecapRow[] = []
  for (const p of after.players) {
    // Someone knocked out in the window is reported on their killer's row, not
    // their own — "−14 armies, −5 territories" is a strange way to say "dead".
    if (before.players[p.id].alive && !p.alive) continue
    const killed = after.players
      .filter((q) => before.players[q.id].alive && !q.alive && killerOf(after, q.id) === p.id)
      .map((q) => q.id)
    const armies = now.armies[p.id] - was.armies[p.id]
    const territories = now.territories[p.id] - was.territories[p.id]
    if (armies || territories || killed.length) rows.push({ player: p.id, armies, territories, killed })
  }
  return rows
}

const signed = (n: number) => `${n > 0 ? '+' : '−'}${Math.abs(n)}`
const plural = (n: number, one: string, many: string) => (Math.abs(n) === 1 ? one : many)

/**
 * The row as one line, given a way to name the dead. Ground first: armies come
 * and go every turn, and who holds what is the part that decides your next move.
 */
export function describeRow(row: RecapRow, name: (p: PlayerId) => string): string {
  const bits: string[] = []
  if (row.territories) bits.push(`${signed(row.territories)} ${plural(row.territories, 'territory', 'territories')}`)
  if (row.armies) bits.push(`${signed(row.armies)} ${plural(row.armies, 'army', 'armies')}`)
  if (row.killed.length) bits.push(`eliminated ${row.killed.map(name).join(', ')}`)
  return bits.join(' · ')
}
