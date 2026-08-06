import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TERRITORY_IDS } from '../engine/board'
import type { TerritoryId } from '../engine/board'
import { bestTradeIn, createGame, applyMove, territoriesOf } from '../engine/game'
import type { SeatConfig } from '../engine/game'
import { rngFrom } from '../engine/rng'
import type { GameState, LogEntry, Move } from '../engine/types'
import { BOT_BY_KEY } from '../bots'
import { easyBot } from '../bots/easy'
import { stepBot } from '../bots/play'
import { MapView } from './MapView'
import { Dock } from './Dock'
import type { PrimaryAction } from './Dock'
import { Setup } from './Setup'
import { playerColor } from './colors'
import {
  CLEARS_UNDO, UNDOABLE, clickableFor, isHumanTurn, moveForClick, previewFor, primaryFor,
  targetsFor, validDestination, validSelection,
} from './decide'

const BOT_DELAY = { setup: 60, move: 260 }
/** backstop so a misbehaving bot can't spin the skip button forever */
const SKIP_MOVE_CAP = 100_000

export function App() {
  const [game, setGame] = useState<GameState | null>(null)
  const [selected, setSelected] = useState<TerritoryId | null>(null)
  const [fortifyTo, setFortifyTo] = useState<TerritoryId | null>(null)
  const [amount, setAmount] = useState(1)
  const [hover, setHover] = useState<TerritoryId | null>(null)
  const [autoSetup, setAutoSetup] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Undo stack. Because applyMove never mutates, "undo" is just an earlier state —
   * no inverse operations needed. Only deterministic moves go on here: once dice
   * have been rolled, rewinding and re-rolling would be save-scumming.
   */
  const [history, setHistory] = useState<GameState[]>([])
  /** the seed this game was created from, so a bad game can be replayed exactly */
  const [seed, setSeed] = useState(0)
  /** what the bots did while you weren't looking */
  const [recap, setRecap] = useState<LogEntry[] | null>(null)
  /** how much of the log you've already seen — moves while it's your turn */
  const logMark = useRef(0)
  /** whether the last state we saw was bot-controlled, so we know when control returns */
  const wasBot = useRef(false)
  const rng = useRef(rngFrom(12345))

  const start = useCallback((seats: SeatConfig[], chosenSeed?: number) => {
    const s = chosenSeed ?? Math.floor(Math.random() * 1e9)
    // one number reproduces the whole game: the deal, the dice, and the bots
    rng.current = rngFrom(s ^ 0x9e3779b9)
    setSeed(s)
    setGame(createGame({ seats, seed: s }))
    setSelected(null)
    setFortifyTo(null)
    setAutoSetup(false)
    setRecap(null)
    logMark.current = 0
    wasBot.current = false
  }, [])

  // State updaters must stay side-effect free: React double-invokes them in dev to
  // catch impurity, which would double-push history and burn RNG draws. So every
  // one of these computes the next state up front and then assigns.
  const play = useCallback(
    (move: Move) => {
      if (!game) return
      try {
        const next = applyMove(game, move)
        setError(null)
        setRecap(null)
        setGame(next)
        if (UNDOABLE.has(move.type)) setHistory((h) => [...h, game])
        else if (CLEARS_UNDO.has(move.type)) setHistory([])
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [game],
  )

  const undo = useCallback(() => {
    if (!history.length) return
    setGame(history[history.length - 1])
    setHistory((h) => h.slice(0, -1))
    setSelected(null)
    setFortifyTo(null)
    setError(null)
  }, [history])

  /** Run every bot move at once, up to the next human seat (or the end of the game). */
  const skipBots = useCallback(() => {
    if (!game || game.phase === 'gameOver') return
    let s = game
    let moves = 0
    try {
      while (s.phase !== 'gameOver' && moves++ < SKIP_MOVE_CAP) {
        const cur = s.players[s.current]
        if (!cur.bot) break
        s = stepBot(s, BOT_BY_KEY[cur.bot], () => rng.current.next())
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setGame(s)
  }, [game])

  // bots (and opt-in auto-placement) advance themselves on a timer
  useEffect(() => {
    if (!game || game.phase === 'gameOver') return
    const me = game.players[game.current]
    const driving = me.bot ? BOT_BY_KEY[me.bot] : autoSetup && game.phase === 'setup' ? easyBot : null
    if (!driving) return
    const delay = game.phase === 'setup' ? BOT_DELAY.setup : BOT_DELAY.move
    // the effect re-runs on every game change, so reading it from the closure is
    // correct — and keeps the RNG out of a state updater
    const id = setTimeout(() => setGame(stepBot(game, driving, () => rng.current.next())), delay)
    return () => clearTimeout(id)
  }, [game, autoSetup])

  // Selection and amounts are per-phase, so wipe them whenever the phase turns over.
  // canFortify is in here too: spending the one fortify doesn't change phase or
  // player, so without it the old selection would survive and the primary button
  // would keep offering a fortify the engine has already used up.
  const phase = game?.phase
  const current = game?.current
  const canFortify = game?.canFortify
  useEffect(() => {
    setSelected(null)
    setFortifyTo(null)
    if (phase === 'occupy' && game?.pendingOccupation) setAmount(game.pendingOccupation.max)
    else setAmount(1)
    if (phase !== 'setup') setAutoSetup(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current, canFortify])

  // The undo window never spans a change of player — but it *does* survive a phase
  // change, so deploys stay undoable right up until your first roll.
  useEffect(() => { setHistory([]) }, [current])

  /**
   * What happened while you weren't acting. Deliberately transient rather than a
   * permanent log panel: it appears when control returns to you (which is also
   * what Skip does) and clears on your next move.
   *
   * The mark tracks along with your own moves and then freezes for the whole bot
   * stretch — watching for the change of *player* instead would reset it at every
   * bot handover, and you'd only ever see the last bot's turn.
   */
  useEffect(() => {
    if (!game) return
    const botNow = !!game.players[game.current].bot
    if (!botNow) {
      // your own turn-start line is the last thing logged before control comes
      // back — it isn't news, so it doesn't belong under "while you were away"
      const since = game.log.slice(logMark.current).filter((e) => e.player !== game.current)
      logMark.current = game.log.length
      if (wasBot.current) setRecap(since.length ? since : null)
    }
    wasBot.current = botNow
  }, [game])

  const me = game ? game.players[game.current] : null
  const isHuman = !!game && isHumanTurn(game)

  const sel = useMemo<TerritoryId | null>(
    () => (game ? validSelection(game, selected) : null),
    [game, selected],
  )

  const targets = useMemo<Set<TerritoryId>>(
    () => (game ? targetsFor(game, sel) : new Set()),
    [game, sel],
  )

  const dest = validDestination(sel, fortifyTo, targets)

  const preview = useMemo<Record<TerritoryId, number> | null>(
    () => (game ? previewFor(game, amount, sel, dest) : null),
    [game, amount, sel, dest],
  )

  const clickable = useMemo<Set<TerritoryId>>(
    () => (game ? clickableFor(game, targets, autoSetup) : new Set()),
    [game, targets, autoSetup],
  )

  const pick = useCallback(
    (t: TerritoryId, shift: boolean) => {
      if (!game || !me) return
      // Clicks that play a move are decided in `decide`; the ones left here are
      // the two that only move UI state around.
      const move = moveForClick(game, t, shift, amount, sel)
      if (move) {
        // one click, one battle: a blitz rolls until the territory falls or the
        // attack runs dry. Rolling a single round at a time was only ceremony.
        play(move)
        return
      }
      if (game.phase === 'attack' && game.owner[t] === me.id) setSelected(t)
      else if (game.phase === 'fortify') {
        if (sel && targets.has(t)) {
          setFortifyTo(t)
          setAmount(game.troops[sel] - 1)   // default to sending the stack; Min is one click away
        } else if (game.owner[t] === me.id && game.troops[t] > 1) {
          setSelected(t)
          setFortifyTo(null)
        }
      }
    },
    [game, me, amount, sel, targets, play],
  )

  // After a capture resolves, keep the spearhead selected so you can push on.
  // Dropping a *stale* selection is handled by deriving `sel`, not here.
  useEffect(() => {
    if (!game || game.phase !== 'attack' || selected) return
    if (game.lastBattle?.captured) {
      const to = game.lastBattle.to
      if (game.owner[to] === game.current && game.troops[to] > 1) setSelected(to)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.phase, game?.lastBattle, selected])

  const cancel = useCallback(() => { setSelected(null); setFortifyTo(null) }, [])

  /**
   * The single dark button in the bar, and what Space does. Keeping them the same
   * value means the label always tells the truth about the key.
   */
  const primary = useMemo<PrimaryAction | null>(() => {
    if (!game) return null
    const p = primaryFor(game, amount, sel, dest)
    if (!p) return null
    const run =
      p.kind === 'skipBots' ? skipBots
        : p.kind === 'autoSetup' ? () => setAutoSetup(true)
          : () => play(p.move!)
    return { label: p.label, run }
  }, [game, amount, sel, dest, play, skipBots])

  // ── keyboard ──────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never steal keys from text entry (the seat-name inputs). Sliders and
      // buttons keep focus after you use them, so bailing out on every INPUT
      // meant Space hit the focused slider instead of the primary action.
      const el = e.target as HTMLElement | null
      const isTextEntry =
        !!el &&
        (el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable ||
          (el.tagName === 'INPUT' &&
            !['range', 'checkbox', 'radio', 'button', 'submit'].includes((el as HTMLInputElement).type)))
      if (isTextEntry) return

      if (e.key === 'Escape') {
        e.preventDefault()
        if (showSettings) setShowSettings(false)
        else cancel()
        return
      }
      if (showSettings || !game || game.phase === 'gameOver') return

      // Space is the whole keyboard surface for acting: it presses whatever the
      // bar's dark button says. Enter used to do the same thing, which only made
      // the label's ␣ hint a half-truth.
      if (e.key === ' ') {
        e.preventDefault()
        primary?.run()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (isHuman) undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [game, primary, cancel, showSettings, undo, isHuman])

  if (!game) return <Setup onStart={start} />

  const phaseIndex = { deploy: 0, attack: 1, occupy: 1, fortify: 2, setup: 0, gameOver: 2 }[game.phase]
  // Only dim during initial placement. Once the game is running you need to read
  // enemy strength to decide where to reinforce, so dimming would work against you.
  const focus = game.phase === 'setup' ? game.current : null

  return (
    <div className="app">
      <div className="topbar">
        <div className="wordmark">RISK<span>.</span></div>
        <div className="mono-label">
          {game.phase === 'setup' ? 'Initial deployment' : `Turn ${String(game.turn).padStart(2, '0')}`}
        </div>
        <div className="spacer" />
        {error && <div className="mono-label err">{error}</div>}

        {/* hand sizes are public information in Risk, so showing them is rules-correct */}
        <div className="scoreboard">
          {game.players.map((p) => (
            <div
              key={p.id}
              className={`seatline ${p.id === game.current ? 'on' : ''} ${p.alive ? '' : 'out'}`}
              style={{ ['--c' as string]: playerColor(p.color) }}
              title={`${p.name}${p.bot ? ` · bot (${p.bot})` : ' · you'}`}
            >
              <span className="dot" />
              <span className="nm">{p.name}</span>
              <span className="n">{territoriesOf(game, p.id).length}</span>
              <span className="cards" title={`${p.cards.length} cards`}>{p.cards.length}<i>♦</i></span>
            </div>
          ))}
        </div>

        <div className="phases">
          {['Deploy', 'Attack', 'Fortify'].map((p, i) => (
            <span key={p} className={`phase-pill ${i === phaseIndex ? 'active' : i < phaseIndex ? 'done' : ''}`}>{p}</span>
          ))}
        </div>
      </div>

      <main className="stage">
        <MapView
          state={game}
          selected={sel}
          targets={targets}
          clickable={clickable}
          focus={focus}
          flash={game.pendingOccupation?.to ?? null}
          preview={preview}
          hover={hover}
          onPick={pick}
          onHover={setHover}
        />
        {recap && (
          <div className="recap" onClick={() => setRecap(null)}>
            <span className="mono-label">While you were away</span>
            <div className="lines">
              {/* every move, not a tail of them — the run of lines under one name
                  is that player's whole turn */}
              {recap.map((e, i) => (
                <div
                  className="line"
                  key={i}
                  style={{ ['--c' as string]: e.player === null ? 'var(--ink-3)' : playerColor(game.players[e.player].color) }}
                >
                  <span className="who">
                    {e.player === recap[i - 1]?.player ? '' : e.player === null ? '·' : game.players[e.player].name}
                  </span>
                  <span className="what">{e.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <Dock
          state={game}
          selected={sel}
          fortifyTo={dest}
          amount={amount}
          primary={primary}
          setAmount={setAmount}
          onTrade={() => {
            const set = bestTradeIn(game, game.current)
            if (set) play({ type: 'tradeCards', cards: set.cards })
          }}
          onCancel={cancel}
          onShowSettings={() => setShowSettings((v) => !v)}
          settingsOpen={showSettings}
          seed={seed}
          onCloseSettings={() => setShowSettings(false)}
          onUndo={undo}
          canUndo={history.length > 0}
        />
      </main>

      {game.phase === 'gameOver' && game.winner !== null && (
        <div className="overlay">
          <div className="panel">
            <div className="winner" style={{ ['--c' as string]: playerColor(game.players[game.winner].color) }}>
              <span className="dot" />
              <h1 style={{ margin: 0 }}>{game.players[game.winner].name}</h1>
            </div>
            <div className="sub">
              takes the world in {game.turn} turns ·{' '}
              {territoriesOf(game, game.winner).length}/{TERRITORY_IDS.length} territories
            </div>
            <button className="go" onClick={() => setGame(null)}>New game</button>
          </div>
        </div>
      )}
    </div>
  )
}
