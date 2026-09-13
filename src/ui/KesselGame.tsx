import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { rngFrom } from '../engine/rng'
import type { PlayerId, SeatConfig } from '../engine/types'
import { kessel } from '../games/kessel'
import { applyMove, broken, createGame, hqReach, inCommand, legalMoves } from '../games/kessel/game'
import { mapOf } from '../games/kessel/map'
import type { GameMap, ProvinceId } from '../games/kessel/map'
import { MUD_CYCLE, MUD_TURNS, exploitReach, isMud, reachable } from '../games/kessel/movement'
import { retreatOptions } from '../games/kessel/supply'
import { newGameId, saveGame } from '../review/store'
import type { FormationId, KesselState, LogEntry, Move, Order } from '../games/kessel/types'
import { playerColor } from './colors'
import type { PrimaryAction } from './Dock'
import { KesselDock } from './KesselDock'
import type { AttackPreview } from './KesselDock'
import { KesselMap } from './KesselMap'
import type { TargetKind } from './KesselMap'

/** Long enough to read the board before the other side answers. */
const BOT_DELAY = 420
/** backstop, so a bot that never commits can't hang the tab */
const BOT_MOVE_CAP = 20_000

interface Props {
  seats: SeatConfig[]
  onExit(): void
  /** open the review for the war just played, by its record id */
  onReview(id: string): void
}

const botFor = (key: string | null) => (key ? kessel.bots.find((b) => b.key === key) : undefined)

/**
 * One side's whole turn. A turn is twenty-six orders and then a commit, and
 * animating them one at a time would be seven seconds of watching a list fill
 * in — the orders resolve simultaneously anyway, so the board after is the only
 * board worth showing. Stopping at the change of side is what keeps an all-bot
 * game watchable turn by turn rather than running to the peace in one frame.
 */
function runBots(s0: KesselState, rand: () => number): KesselState {
  let s = s0
  for (let i = 0; i < BOT_MOVE_CAP; i++) {
    if (s.phase === 'gameOver' || s.current !== s0.current) break
    const bot = botFor(s.sides[s.current].bot)
    if (!bot) break
    s = applyMove(s, bot.decide(s, s.current, rand))
  }
  return s
}

/**
 * The board this turn's staged orders would produce, before anyone fights on it.
 *
 * Whether a formation is in a pocket is a question about where everyone stands
 * once the moves have happened, and moves resolve before attacks — so a ring
 * closed by a move staged two clicks ago has to count against the defender
 * being priced now, or the bar prices an attack nobody is about to make. A move
 * out of command is not among them, and one ordered last turn that arrives now is.
 */
function projectOrders(s: KesselState, command: Set<FormationId>): KesselState {
  const moving = (id: FormationId, owner: PlayerId): Order | undefined => {
    const late = s.delayed[id]
    if (late) return owner === s.current && late.type === 'move' ? late : undefined
    const order = s.orders[id]
    return order?.type === 'move' && command.has(id) ? order : undefined
  }
  if (!s.formations.some((f) => moving(f.id, f.owner))) return s
  const owner = { ...s.owner }
  const formations = s.formations.map((f) => {
    const order = moving(f.id, f.owner)
    if (order?.type !== 'move') return f
    owner[order.to] = f.owner
    return { ...f, at: order.to }
  })
  return { ...s, owner, formations }
}

const REAR_NEWS = /arrives by rail|up to strength/

/** Turns until the roads go. On the calendar for both sides, so it is said out loud. */
const mudIn = (turn: number) => {
  for (let t = 1; t <= MUD_CYCLE; t++) if (isMud(turn + t)) return t
  return MUD_CYCLE - MUD_TURNS
}

const aimReport = (m: GameMap, s: KesselState, p: PlayerId) => {
  const aims = s.sides[p].aims
  const total = aims.reduce((n, id) => n + m.province[id].vp, 0)
  const got = aims.reduce((n, id) => n + (s.owner[id] === p ? m.province[id].vp : 0), 0)
  return { aims, total, got, share: total === 0 ? 0 : got / total }
}

export function KesselGame({ seats, onExit, onReview }: Props) {
  const [seed] = useState(() => Math.floor(Math.random() * 1e9))
  const recordId = useRef(newGameId(Math.floor(Math.random() * 1e9)))
  const [state, setState] = useState<KesselState>(() => createGame({ seats, seed }))
  const [selected, setSelected] = useState<FormationId | null>(null)
  /** a headquarters being sent somewhere, by index — never at the same time as a formation */
  const [selectedHq, setSelectedHq] = useState<number | null>(null)
  const [hover, setHover] = useState<ProvinceId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  /** Undo stack. `applyMove` never mutates, so an earlier state is the whole of it. */
  const [history, setHistory] = useState<KesselState[]>([])
  /** what the other side did while you weren't looking */
  const [recap, setRecap] = useState<LogEntry[] | null>(null)
  /** the attack the bar prices when nothing is selected — the last one you lined up */
  const [lastAttack, setLastAttack] = useState<ProvinceId | null>(null)
  const rng = useRef(rngFrom(seed ^ 0x9e3779b9))
  const wasBot = useRef(false)
  const logMark = useRef(0)
  const savedTurn = useRef(-1)

  // Saved as a seed and a move list, the same as Risk — the whole record is what
  // it takes to replay the war exactly.
  useEffect(() => {
    if (!state.moves.length) return
    if (!state.sides.some((x) => !x.bot)) return
    const over = state.phase === 'gameOver'
    if (!over && state.turn === savedTurn.current) return
    savedTurn.current = state.turn
    saveGame({
      id: recordId.current,
      game: 'kessel',
      seed,
      botSeed: seed ^ 0x9e3779b9,
      seats: state.sides.map((x) => ({ name: x.name, bot: x.bot, color: x.color })),
      moves: state.moves,
      assisted: [],
      winner: state.winner,
      turns: state.turn,
      finished: over,
    })
  }, [state, seed])

  const m = mapOf(state.mapId)
  const me = state.current
  const isHuman = !state.sides[me].bot && state.phase !== 'gameOver'
  /**
   * Whose eyes the map is drawn through. One human sees the war from their seat
   * whoever is moving; two at one keyboard each see their own fog on their own
   * turn; a war between bots is watched with nothing hidden.
   */
  const humans = state.sides.filter((x) => !x.bot)
  const viewer: PlayerId | null = humans.length === 1 ? humans[0].id : isHuman ? me : null

  const play = useCallback(
    (move: Move) => {
      try {
        const next = applyMove(state, move)
        setError(null)
        setRecap(null)
        if (move.type === 'order' || move.type === 'clearOrder' || move.type === 'moveHq') {
          setHistory((h) => [...h, state])
        } else {
          setHistory([])
          setSelected(null)
          setSelectedHq(null)
          setLastAttack(null)
        }
        if (move.type === 'order' && move.order.type === 'attack') setLastAttack(move.order.to)
        setState(next)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [state],
  )

  const undo = useCallback(() => {
    if (!history.length) return
    setState(history[history.length - 1])
    setHistory((h) => h.slice(0, -1))
    setError(null)
  }, [history])

  useEffect(() => {
    if (state.phase === 'gameOver' || !state.sides[state.current].bot) return
    // the effect re-runs on every board, so reading it from the closure is
    // correct — and keeps the generator out of a state updater
    const id = setTimeout(() => setState(runBots(state, () => rng.current.next())), BOT_DELAY)
    return () => clearTimeout(id)
  }, [state])

  /** Mark where the other side's turn began, and report it when control comes back. */
  useEffect(() => {
    const botNow = !!state.sides[state.current].bot
    if (botNow && !wasBot.current) logMark.current = state.log.length
    if (!botNow && wasBot.current) {
      // What happens in the enemy's rear is theirs to know: a draft arriving or
      // a corps rebuilt is not news the other side gets a line about.
      const rows = state.log
        .slice(logMark.current)
        .filter((row) => row.player === state.current || row.player === null || !REAR_NEWS.test(row.text))
      setRecap(rows.length > 0 ? rows : null)
    }
    wasBot.current = botNow
  }, [state])

  /**
   * Every order this side could give, indexed by the province it points at. Read
   * off the engine's own generator rather than re-derived, so what the map offers
   * and what the rules allow cannot drift apart.
   */
  const legal = useMemo(() => {
    const out = new Map<FormationId, Map<ProvinceId, 'move' | 'attack'>>()
    if (!isHuman || state.phase !== 'orders') return out
    for (const mv of legalMoves(state, me)) {
      if (mv.type !== 'order') continue
      if (mv.order.type !== 'move' && mv.order.type !== 'attack') continue
      const at = out.get(mv.formation) ?? new Map<ProvinceId, 'move' | 'attack'>()
      at.set(mv.order.to, mv.order.type)
      out.set(mv.formation, at)
    }
    return out
  }, [state, me, isHuman])

  /** Formations of the side to move whose orders this turn are carried out this turn. */
  const command = useMemo(() => inCommand(m, state, me), [m, state, me])

  const projected = useMemo(() => projectOrders(state, command), [state, command])

  const pockets = useMemo(() => {
    const out = new Set<ProvinceId>()
    for (const f of projected.formations) {
      if (retreatOptions(m, projected, f).length === 0) out.add(f.at)
    }
    return out
  }, [m, projected])

  const sel = selected === null ? null : (state.formations.find((f) => f.id === selected) ?? null)

  /**
   * Where an attack already staged for the selected formation could ride on to.
   * Offered only once the assault is staged: the exploitation is the second click.
   */
  const onward = useMemo(() => {
    const out = new Set<ProvinceId>()
    if (!sel || !isHuman || state.phase !== 'orders') return out
    const order = state.orders[sel.id]
    if (order?.type !== 'attack') return out
    for (const p of Object.keys(exploitReach(m, state, sel, order.to).cost)) out.add(p)
    return out
  }, [sel, isHuman, state, m])

  const hqTargets = useMemo(
    () =>
      selectedHq === null || !isHuman || state.phase !== 'orders'
        ? new Set<ProvinceId>()
        : hqReach(m, state, me, selectedHq),
    [selectedHq, isHuman, state, m, me],
  )

  const targets = useMemo(() => {
    const out = new Map<ProvinceId, TargetKind>()
    if (selectedHq !== null) {
      for (const p of hqTargets) out.set(p, 'hq')
      return out
    }
    if (!sel) return out
    const mine = legal.get(sel.id)
    if (!mine) return out
    const rail = reachable(m, state, sel).rail
    for (const [p, kind] of mine) out.set(p, kind === 'move' && rail.has(p) ? 'rail' : kind)
    for (const p of onward) out.set(p, 'onward')
    return out
  }, [state, m, sel, legal, onward, selectedHq, hqTargets])

  /** Formations in the order the eye sweeps them — the contact line first, west to east. */
  const cycleOrder = useMemo(() => {
    const inContact = (at: ProvinceId) =>
      (m.adjacency[at] ?? []).some((n) => state.formations.some((x) => x.at === n && x.owner !== me))
    return state.formations
      .filter((f) => f.owner === me)
      .sort(
        (a, b) =>
          Number(inContact(b.at)) - Number(inContact(a.at)) ||
          m.province[a.at].cx - m.province[b.at].cx ||
          m.province[a.at].cy - m.province[b.at].cy,
      )
  }, [state.formations, me, m])

  const cycle = useCallback(
    (dir: 1 | -1) => {
      const pool = cycleOrder
      if (pool.length === 0) return
      const at = pool.findIndex((f) => f.id === selected)
      const next = at === -1 ? (dir > 0 ? 0 : pool.length - 1) : (at + dir + pool.length) % pool.length
      setSelectedHq(null)
      setSelected(pool[next].id)
    },
    [cycleOrder, selected],
  )

  const pick = useCallback(
    (p: ProvinceId) => {
      if (!isHuman || state.phase !== 'orders') return
      const here = state.formations.filter((f) => f.at === p)

      if (selectedHq !== null) {
        if (hqTargets.has(p)) {
          play({ type: 'moveHq', hq: selectedHq, to: p })
          setSelectedHq(null)
          return
        }
        setSelectedHq(null)
      }

      if (sel) {
        const staged = state.orders[sel.id]
        if (staged?.type === 'attack' && onward.has(p)) {
          play({ type: 'order', formation: sel.id, order: { type: 'attack', to: staged.to, onward: p } })
          return
        }
        const kind = legal.get(sel.id)?.get(p)
        if (kind === 'attack' || kind === 'move') {
          play({ type: 'order', formation: sel.id, order: { type: kind, to: p } })
          return
        }
        // the culminating point, said out loud at the moment it bites
        if (
          sel.supply < 3 &&
          (m.adjacency[sel.at] ?? []).includes(p) &&
          here.some((f) => f.owner !== me)
        ) {
          setError('Short of full supply — this formation cannot start an attack')
          return
        }
      }

      const ours = here.filter((f) => f.owner === me)
      if (ours.length === 0) {
        setSelected(null)
        return
      }
      const at = ours.findIndex((f) => f.id === selected)
      // arriving fresh lands on whatever still has no order; clicking again
      // walks the stack, which is the only way to reach the counter underneath
      if (at === -1) setSelected((ours.find((f) => !state.orders[f.id]) ?? ours[0]).id)
      else setSelected(ours[(at + 1) % ours.length].id)
    },
    [isHuman, state, sel, selected, legal, onward, play, m, me, selectedHq, hqTargets],
  )

  const attack = useMemo<AttackPreview | null>(() => {
    if (!isHuman || state.phase !== 'orders') return null
    const staged = (to: ProvinceId) =>
      state.formations.filter((f) => {
        const order = state.orders[f.id]
        return f.owner === me && order?.type === 'attack' && order.to === to
      })

    if (sel && hover && legal.get(sel.id)?.get(hover) === 'attack') {
      return { to: hover, from: [sel, ...staged(hover).filter((f) => f.id !== sel.id)], staged: false }
    }
    const own = sel && state.orders[sel.id]?.type === 'attack'
      ? (state.orders[sel.id] as { to: ProvinceId }).to
      : null
    const to = own ?? lastAttack
    if (!to) return null
    const from = staged(to)
    return from.length > 0 ? { to, from, staged: true } : null
  }, [isHuman, state, sel, hover, legal, me, lastAttack])

  const primary = useMemo<PrimaryAction | null>(() => {
    if (!isHuman) return null
    if (state.phase === 'terms') {
      return { label: 'Accept terms', run: () => play({ type: 'acceptTerms' }) }
    }
    if (broken(state, me) && !state.offered) {
      return { label: 'Offer terms', run: () => play({ type: 'offerTerms' }) }
    }
    return { label: 'Commit turn', run: () => play({ type: 'commit' }) }
  }, [isHuman, state, me, play])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (showSettings) setShowSettings(false)
        else {
          setSelected(null)
          setSelectedHq(null)
        }
        return
      }
      if (showSettings || state.phase === 'gameOver') return
      if (e.key === ' ') {
        e.preventDefault()
        primary?.run()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        undo()
        return
      }
      if (!isHuman || state.phase !== 'orders') return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        cycle(e.key === 'ArrowRight' ? 1 : -1)
        return
      }
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault()
        const count = state.sides[me].hqs.length
        setSelected(null)
        setSelectedHq((h) => (h === null ? (count > 0 ? 0 : null) : h + 1 < count ? h + 1 : null))
        return
      }
      if (selectedHq !== null) {
        if ((e.key === 'Backspace' || e.key === 'Delete') && state.hqOrders[selectedHq] !== undefined) {
          e.preventDefault()
          play({ type: 'moveHq', hq: selectedHq, to: null })
        }
        return
      }
      if (!sel) return
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault()
        play({ type: 'order', formation: sel.id, order: { type: 'hold' } })
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        play({ type: 'order', formation: sel.id, order: { type: 'refit' } })
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        if (state.orders[sel.id]) play({ type: 'clearOrder', formation: sel.id })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, primary, undo, cycle, sel, isHuman, showSettings, play, me, selectedHq])

  const over = state.phase === 'gameOver'

  return (
    <div className="app">
      <div className="topbar">
        <div className="wordmark">KESSEL<span>.</span></div>
        <div className="mono-label">
          Turn {String(state.turn).padStart(2, '0')}
          {isMud(state.turn) ? ' · mud' : ` · mud in ${mudIn(state.turn)}`}
        </div>
        <div className="spacer" />
        {error && <div className="mono-label err">{error}</div>}

        <div className="scoreboard">
          {state.sides.map((s) => (
            <div
              key={s.id}
              className={`seatline ${s.id === state.current ? 'on' : ''}`}
              style={{ ['--c' as string]: playerColor(s.color) }}
              title={`${s.name}${s.bot ? ` · bot (${s.bot.replace('kessel-', '')})` : ' · you'}`}
            >
              <span className="dot" />
              <span className="nm">{s.name}</span>
              <span className="n">{m.ids.filter((id) => state.owner[id] === s.id).length}</span>
              <span className="cards" title="formations standing">
                {state.formations.filter((f) => f.owner === s.id).length}<i>▣</i>
              </span>
            </div>
          ))}
        </div>

        <div className="phases">
          <span className={`phase-pill ${state.phase === 'orders' ? 'active' : 'done'}`}>Orders</span>
          <span className={`phase-pill ${state.phase === 'terms' ? 'active' : ''}`}>Terms</span>
        </div>
      </div>

      <main className="stage">
        <KesselMap
          state={state}
          viewer={viewer}
          selected={selected}
          selectedHq={isHuman ? selectedHq : null}
          targets={targets}
          pockets={pockets}
          hover={hover}
          onPick={pick}
          onHover={setHover}
        />

        {recap && !over && (
          <div className="recap" onClick={() => setRecap(null)}>
            <span className="mono-label">While you were away</span>
            <div className="lines">
              {recap.map((row, i) => (
                <div
                  className="line"
                  key={i}
                  style={{
                    ['--c' as string]:
                      row.player === null ? 'var(--ink-3)' : playerColor(state.sides[row.player].color),
                  }}
                >
                  <span className="who">{row.player === null ? '' : state.sides[row.player].name}</span>
                  <span className="what">{row.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <KesselDock
          state={state}
          me={me}
          selected={selected}
          selectedHq={selectedHq}
          command={command}
          attack={attack}
          projected={projected}
          primary={primary}
          onClearOrder={() => sel && play({ type: 'clearOrder', formation: sel.id })}
          onClearHq={() => selectedHq !== null && play({ type: 'moveHq', hq: selectedHq, to: null })}
          onRejectTerms={() => play({ type: 'rejectTerms' })}
          onCommit={() => play({ type: 'commit' })}
          onShowSettings={() => setShowSettings((v) => !v)}
          settingsOpen={showSettings}
          onCloseSettings={() => setShowSettings(false)}
          seed={seed}
        />
      </main>

      {over && (
        <div className="overlay">
          <div className="panel">
            <div
              className="winner"
              style={{
                ['--c' as string]:
                  state.winner === null ? 'var(--ink-3)' : playerColor(state.sides[state.winner].color),
              }}
            >
              <span className="dot" />
              <h1 style={{ margin: 0 }}>
                {state.winner === null ? 'Stalemate' : state.sides[state.winner].name}
              </h1>
            </div>
            <div className="sub">
              {state.winner === null
                ? `the war ends on the line as it stands · turn ${state.turn}`
                : `achieves its war aims · a ${state.peace?.verdict ?? 'narrow'} peace · turn ${state.turn}`}
            </div>

            {/* The peace is scored here and nowhere else: ground taken counts for
                nothing unless it was ground you said you wanted. */}
            <div className="field kpeace">
              <span className="mono-label">War aims at the peace</span>
              {state.sides.map((s) => {
                const r = aimReport(m, state, s.id)
                return (
                  <div className="side" key={s.id} style={{ ['--c' as string]: playerColor(s.color) }}>
                    <div className="head">
                      <span className="nm">{s.name}</span>
                      <span className="track"><i style={{ width: `${Math.round(r.share * 100)}%` }} /></span>
                      <span className="n">{r.got}/{r.total} vp</span>
                    </div>
                    <div className="aims">
                      {r.aims.map((id) => (
                        <span key={id} className={`aim ${state.owner[id] === s.id ? 'held' : ''}`}>
                          {m.province[id].name}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="endgame-actions">
              {state.sides.some((x) => !x.bot) && (
                <button className="btn ghost" onClick={() => onReview(recordId.current)}>
                  Review this war
                </button>
              )}
              <button className="go" onClick={onExit}>New game</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
