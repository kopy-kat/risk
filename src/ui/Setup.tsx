import { useMemo, useState } from 'react'
import { BOTS, DEFAULT_BOT } from '../bots'
import type { SeatConfig } from '../engine/game'
import type { GameMode } from '../engine/types'
import { deleteGame, importGames, isReplayable, listGames } from '../review/store'
import type { GameRecord, ImportGamesResult } from '../review/store'
import { PALETTE_NAMES, playerColor } from './colors'

const MAX_IMPORT_BYTES = 10 * 1024 * 1024

interface Props {
  onStart(seats: SeatConfig[], mode: GameMode): void
  onReview(id: string): void
}

const MODES: Array<{ key: GameMode; name: string; blurb: string }> = [
  { key: 'classic', name: 'Classic', blurb: 'World domination — hold all 42 territories.' },
  {
    key: 'capitals',
    name: 'Capitals',
    blurb: 'Your first placement founds your capital. Hold every capital at once to win.',
  },
  {
    key: 'supply',
    name: 'Supply',
    blurb:
      'Only your largest connected group is in supply. Cut-off territories earn nothing, take no reinforcements, and wither.',
  },
]

/** A seat as the picker holds it: difficulty is global, so a seat is only ever human or not. */
interface Seat {
  name: string
  isBot: boolean
}

export function Setup({ onStart, onReview }: Props) {
  const [count, setCount] = useState(4)
  const [past, setPast] = useState<GameRecord[]>(() => listGames())
  const [importNotice, setImportNotice] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)
  const [difficulty, setDifficulty] = useState(DEFAULT_BOT)
  const [mode, setMode] = useState<GameMode>('classic')
  const [seats, setSeats] = useState<Seat[]>(
    PALETTE_NAMES.map((name, i) => ({ name, isBot: i > 0 })),
  )

  const update = (i: number, patch: Partial<Seat>) =>
    setSeats((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  const active = seats.slice(0, count)
  const humans = active.filter((s) => !s.isBot).length
  const bots = active.length - humans

  const importFile = async (file: File) => {
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('That file is too large to import safely.')
      const result = importGames(await file.text())
      setPast(listGames())
      setImportNotice({ kind: 'ok', text: describeImport(result) })
    } catch (e) {
      setImportNotice({
        kind: 'error',
        text: e instanceof Error ? e.message : 'That file could not be imported.',
      })
    }
  }

  return (
    <div className="overlay">
      <div className="panel">
        <h1>RISK<span>.</span></h1>
        <div className="sub">World Domination</div>

        <div className="field">
          <span className="mono-label">Players</span>
          <div className="count">
            {[2, 3, 4, 5, 6].map((n) => (
              <button key={n} className={n === count ? 'on' : ''} onClick={() => setCount(n)}>{n}</button>
            ))}
          </div>
        </div>

        <div className="field">
          {/* order is drawn at kick-off, so this list is identity, not sequence */}
          <span className="mono-label">Seats · turn order drawn at start</span>
          <div className="seats">
            {active.map((s, i) => (
              <div className="seat" key={i} style={{ ['--c' as string]: playerColor(i) }}>
                <span className="dot" />
                <input
                  value={s.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  aria-label={`Seat ${i + 1} name`}
                />
                <span className="toggle">
                  <button className={!s.isBot ? 'on' : ''} onClick={() => update(i, { isBot: false })}>Human</button>
                  <button className={s.isBot ? 'on' : ''} onClick={() => update(i, { isBot: true })}>Bot</button>
                </span>
              </div>
            ))}
          </div>
        </div>

        {bots > 0 && (
          <div className="field">
            {/* one rung for every bot in the game — mixed tables read as a handicap match */}
            <span className="mono-label">Difficulty</span>
            <div className="tiers">
              {BOTS.map((b) => (
                <button
                  key={b.key}
                  className={b.key === difficulty ? 'on' : ''}
                  onClick={() => setDifficulty(b.key)}
                >
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <span className="mono-label">Mode</span>
          <div className="tiers">
            {MODES.map((m) => (
              <button key={m.key} className={m.key === mode ? 'on' : ''} onClick={() => setMode(m.key)}>
                {m.name}
              </button>
            ))}
          </div>
          <span className="mode-blurb">{MODES.find((m) => m.key === mode)!.blurb}</span>
        </div>

        <button
          className="go"
          onClick={() =>
            onStart(
              active.map((s) => ({ name: s.name.trim() || 'Player', bot: s.isBot ? difficulty : null })),
              mode,
            )
          }
        >
          {humans === 0 ? 'Watch the bots' : 'Begin deployment'}
        </button>

        <div className="field pastgames">
          <span className="mono-label">
            Past games
            <span className="history-actions">
              <label className="history-action import">
                Import
                <input
                  className="file-input"
                  type="file"
                  accept=".json,application/json"
                  aria-label="Import games from a file"
                  onChange={(e) => {
                    const input = e.currentTarget
                    const file = input.files?.[0]
                    input.value = ''
                    if (file) void importFile(file)
                  }}
                />
              </label>
              {/* Games live in localStorage, so without this the only way to get them
                  out for analysis is the devtools console. `npm run study <file>`
                  reads the all-games export. */}
              {past.length > 0 && (
                <button className="history-action" onClick={() => downloadGames(past)}>
                  Export all
                </button>
              )}
            </span>
          </span>
          {importNotice && (
            <span
              className={`import-status ${importNotice.kind}`}
              role={importNotice.kind === 'error' ? 'alert' : 'status'}
            >
              {importNotice.text}
            </span>
          )}
          {past.length > 0 ? (
            <div className="games">
              {past.map((g) => (
                <PastGame
                  key={g.id}
                  game={g}
                  onOpen={() => onReview(g.id)}
                  onDelete={() => {
                    deleteGame(g.id)
                    setPast(listGames())
                  }}
                />
              ))}
            </div>
          ) : (
            <span className="no-games">No saved games yet. Import one to replay or review it.</span>
          )}
        </div>
      </div>
    </div>
  )
}

function PastGame({
  game, onOpen, onDelete,
}: {
  game: GameRecord
  onOpen(): void
  onDelete(): void
}) {
  const stale = !isReplayable(game)
  const outcome = useMemo(() => {
    if (game.winner !== null) return `${game.seats[game.winner].name} won`
    return game.finished ? 'finished' : 'unfinished'
  }, [game])

  return (
    <div className={`game ${stale ? 'stale' : ''}`}>
      <button className="open" onClick={onOpen} disabled={stale}>
        <span className="dots">
          {game.seats.map((s, i) => (
            <span
              key={i}
              className={`dot ${s.bot ? 'bot' : ''}`}
              style={{ ['--c' as string]: playerColor(s.color ?? i) }}
              title={s.bot ? `${s.name} · ${s.bot}` : `${s.name} · you`}
            />
          ))}
        </span>
        <span className="what">
          {/* a game played under different rules is kept but can't be replayed —
              its move list no longer applies to the engine as it stands */}
          {stale
            ? 'different rules — cannot replay'
            : `${outcome} · ${game.turns} turns${game.mode && game.mode !== 'classic' ? ` · ${game.mode}` : ''}`}
        </span>
        <span className="when">{ago(game.savedAt)}</span>
      </button>
      <button
        className="share"
        onClick={() => downloadGame(game)}
        aria-label="Export this game"
        title="Export this game"
      >
        Export
      </button>
      <button className="del" onClick={onDelete} aria-label="Delete this game" title="Delete">
        ×
      </button>
    </div>
  )
}

/**
 * Write every stored game to a file the scripts can read.
 *
 * A seed and a move list replay a game exactly, so this is the whole record —
 * one file is enough for `npm run study` to reconstruct every board, and small
 * enough (~30 kB a game) that dumping all of them is the right granularity.
 */
function downloadGames(games: GameRecord[]): void {
  downloadJson(games, `risk-games-${new Date().toISOString().slice(0, 10)}.json`)
}

/** A single record is easier to send; import accepts it directly as well as the all-games array. */
function downloadGame(game: GameRecord): void {
  const safeId = game.id.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'shared'
  downloadJson(game, `risk-game-${safeId}.json`)
}

function downloadJson(value: GameRecord | GameRecord[], filename: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function describeImport(result: ImportGamesResult): string {
  const parts = [
    result.imported
      ? `Imported ${result.imported} game${result.imported === 1 ? '' : 's'}.`
      : 'No new games imported.',
  ]
  if (result.duplicates)
    parts.push(`${result.duplicates} already saved or duplicated.`)
  if (result.rejected)
    parts.push(`${result.rejected} invalid or incompatible.`)
  if (result.atCapacity)
    parts.push(`${result.atCapacity} not added because the 40-game history is full.`)
  return parts.join(' ')
}

function ago(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
