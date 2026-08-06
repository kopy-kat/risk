import { useMemo, useState } from 'react'
import { BOTS, DEFAULT_BOT } from '../bots'
import type { SeatConfig } from '../engine/game'
import { deleteGame, isReplayable, listGames } from '../review/store'
import type { GameRecord } from '../review/store'
import { PALETTE_NAMES, playerColor } from './colors'

interface Props {
  onStart(seats: SeatConfig[], seed?: number): void
  onReview(id: string): void
}

export function Setup({ onStart, onReview }: Props) {
  const [count, setCount] = useState(4)
  const [seed, setSeed] = useState('')
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
          <span className="mono-label">Seats</span>
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

        <div className="field seedfield">
          <span className="mono-label">Seed</span>
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="random — paste one to replay a game"
            aria-label="Game seed"
            inputMode="numeric"
          />
        </div>

        <button
          className="go"
          onClick={() =>
            onStart(
              active.map((s) => ({ ...s, name: s.name.trim() || 'Player' })),
              seed ? Number(seed) : undefined,
            )
          }
        >
          {humans === 0 ? 'Watch the bots' : 'Begin deployment'}
        </button>

        {past.length > 0 && (
          <div className="field pastgames">
            <span className="mono-label">Past games</span>
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
              style={{ ['--c' as string]: playerColor(i) }}
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

function ago(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
