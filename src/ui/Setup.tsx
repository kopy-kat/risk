import { useMemo, useState } from 'react'
import { BOTS, DEFAULT_BOT } from '../bots'
import type { SeatConfig } from '../engine/game'
import { deleteGame, isReplayable, listGames } from '../review/store'
import type { GameRecord } from '../review/store'
import { PALETTE_NAMES, playerColor } from './colors'

interface Props {
  onStart(seats: SeatConfig[]): void
  onReview(id: string): void
}

export function Setup({ onStart, onReview }: Props) {
  const [count, setCount] = useState(4)
  const [past, setPast] = useState<GameRecord[]>(() => listGames())
  const [seats, setSeats] = useState<SeatConfig[]>(
    PALETTE_NAMES.map((name, i) => ({ name, bot: i === 0 ? null : DEFAULT_BOT })),
  )

  const update = (i: number, patch: Partial<SeatConfig>) =>
    setSeats((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  const active = seats.slice(0, count)
  const humans = active.filter((s) => s.bot === null).length

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
                  <button className={s.bot === null ? 'on' : ''} onClick={() => update(i, { bot: null })}>Human</button>
                  <button className={s.bot !== null ? 'on' : ''} onClick={() => update(i, { bot: DEFAULT_BOT })}>Bot</button>
                </span>
                <select
                  value={s.bot ?? ''}
                  disabled={s.bot === null}
                  onChange={(e) => update(i, { bot: e.target.value })}
                  aria-label={`Seat ${i + 1} bot`}
                >
                  {s.bot === null && <option value="">—</option>}
                  {BOTS.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>

        <button
          className="go"
          onClick={() => onStart(active.map((s) => ({ ...s, name: s.name.trim() || 'Player' })))}
        >
          {humans === 0 ? 'Watch the bots' : 'Begin deployment'}
        </button>

        {past.length > 0 && (
          <div className="field pastgames">
            <span className="mono-label">
              Past games
              {/* Games live in localStorage, so without this the only way to get one
                  out for analysis is the devtools console. It is the whole export
                  path on purpose: `npm run study <file>` reads what this writes. */}
              <button className="export" onClick={() => downloadGames(past)}>Export</button>
            </span>
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
          </div>
        )}
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
          {stale ? 'different rules — cannot replay' : `${outcome} · ${game.turns} turns`}
        </span>
        <span className="when">{ago(game.savedAt)}</span>
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
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(games, null, 2)], { type: 'application/json' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = `risk-games-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function ago(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
