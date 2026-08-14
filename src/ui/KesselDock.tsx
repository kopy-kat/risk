import type { ReactNode } from 'react'
import type { PlayerId } from '../engine/types'
import { attackValue, defendValue } from '../games/kessel/combat'
import { WILL_FLOOR } from '../games/kessel/game'
import { frontage, mapOf } from '../games/kessel/map'
import type { GameMap, ProvinceId } from '../games/kessel/map'
import { retreatOptions } from '../games/kessel/supply'
import type { Formation, FormationId, KesselState } from '../games/kessel/types'
import { playerColor } from './colors'
import type { PrimaryAction } from './Dock'
import { SUPPLY_NAME } from './KesselMap'
import { Settings } from './Settings'

/** The attack the bar is pricing: a target, and everyone who would go in with it. */
export interface AttackPreview {
  to: ProvinceId
  from: Formation[]
  /** whether this is a click away or already staged */
  staged: boolean
}

export interface KesselDockProps {
  state: KesselState
  me: PlayerId
  selected: FormationId | null
  attack: AttackPreview | null
  /**
   * The board the staged orders would produce. Whether a defender can retreat is
   * a question about where everyone stands *after* this turn's moves, so a ring
   * closed by a move staged two clicks ago has to count.
   */
  projected: KesselState
  primary: PrimaryAction | null
  onClearOrder(): void
  onRejectTerms(): void
  onShowSettings(): void
  settingsOpen: boolean
  onCloseSettings(): void
  seed: number
}

const KESSEL_KEYS: [string, string][] = [
  ['Space', 'Press the highlighted button'],
  ['← →', 'Cycle your formations without an order'],
  ['H', 'Hold — dig in where you stand'],
  ['R', 'Refit — spend the turn on cohesion'],
  ['⌫', 'Clear the staged order'],
  ['Esc', 'Deselect / close'],
  ['⌘Z', 'Undo — until the turn is committed'],
  ['+ −', 'Zoom the map · scroll or drag it · 0 fits'],
]

const TYPE_NAME: Record<Formation['type'], string> = {
  infantry: 'Infantry',
  armour: 'Armour',
  recon: 'Recon',
}

interface Slots {
  counter?: ReactNode
  hint?: ReactNode
  say: ReactNode
  controls?: ReactNode
}

/**
 * Everything the bar needs to know about one attack. The frontage cap is applied
 * here exactly as the engine applies it, because "five formations, three of them
 * fit" is the difference between mass and a queue.
 */
export interface Odds {
  ratio: number
  committed: number
  brought: number
  defenders: number
  trapped: number
  fallback: ProvinceId | null
}

export function oddsFor(
  m: GameMap,
  s: KesselState,
  projected: KesselState,
  me: PlayerId,
  to: ProvinceId,
  attackers: Formation[],
): Odds | null {
  const defenders = s.formations.filter((f) => f.at === to && f.owner !== me)
  if (attackers.length === 0 || defenders.length === 0) return null

  const sources = [...new Set(attackers.map((f) => f.at))]
  const room = Math.min(4, sources.reduce((n, src) => n + frontage(m, src, to), 0))
  const committed = [...attackers].sort((a, b) => b.strength - a.strength).slice(0, room)

  const ours = committed.reduce((n, f) => n + attackValue(f), 0)
  const theirs = defenders.reduce((n, f) => n + defendValue(m, f, to), 0)
  const ways = defenders.map((f) => retreatOptions(m, projected, f))

  return {
    ratio: theirs === 0 ? Infinity : ours / theirs,
    committed: committed.length,
    brought: attackers.length,
    defenders: defenders.length,
    trapped: ways.filter((w) => w.length === 0).length,
    fallback: ways.find((w) => w.length > 0)?.[0] ?? null,
  }
}

/**
 * Same footprint as the Risk bar, and for the same reason: the button you press
 * every turn cannot move because a formation happened to be selected.
 */
export function KesselDock(props: KesselDockProps) {
  const { state, primary, onShowSettings, settingsOpen, onCloseSettings, seed } = props
  const side = state.sides[state.current]
  const slots = side.bot ? botSlots(props) : phaseSlots(props)

  return (
    <div className="dock kdock">
      <div className="ident" style={{ ['--c' as string]: playerColor(side.color) }}>
        <span className="swatch" />
        <div className="who">
          <span className="nm">{side.name}</span>
          <span className="meta">{side.bot ? `Bot · ${side.bot.replace('kessel-', '')}` : 'You'}</span>
        </div>
      </div>

      <div className="mid">
        <div className="cell num">{slots.counter}</div>
        <div className="prompt">
          <span className="k">{slots.hint}</span>
          <span className="v">{slots.say}</span>
        </div>
        <div className="cell ctrl">
          {slots.controls}
          <OddsBlock {...props} />
          <Will state={state} />
        </div>
      </div>

      <div className="tail">
        <span className="slot act">
          {primary && (
            <button className="btn primary wide" onClick={primary.run}>
              {primary.label} <kbd>Space</kbd>
            </button>
          )}
        </span>
        <button
          className={`btn help ${settingsOpen ? 'on' : ''}`}
          onClick={onShowSettings}
          title="Settings and shortcuts"
          aria-label="Settings"
        >⚙</button>
        {settingsOpen && (
          <Settings
            seed={seed}
            onClose={onCloseSettings}
            keys={KESSEL_KEYS}
            note="Beaten with a line of retreat, a formation is pushed back at full strength. Beaten without one, it surrenders."
          />
        )}
      </div>
    </div>
  )
}

/**
 * Both sides' will, against the line below which a side can only ask for terms.
 * The threshold is drawn rather than stated: how close you are to it is the
 * question, and a number needs a second number to answer that.
 */
function Will({ state }: { state: KesselState }) {
  return (
    <div className="kwill">
      {state.sides.map((s) => (
        <div
          key={s.id}
          className={`row ${s.will <= WILL_FLOOR ? 'broken' : ''} ${s.id === state.current ? 'on' : ''}`}
          style={{ ['--c' as string]: playerColor(s.color) }}
        >
          <span className="nm">{s.name}</span>
          <span className="track">
            <i style={{ width: `${s.will}%` }} />
            <b style={{ left: `${WILL_FLOOR}%` }} />
          </span>
          <span className="n">{Math.round(s.will)}</span>
        </div>
      ))}
      <span className="cap mono-label">Will · terms below {WILL_FLOOR}</span>
    </div>
  )
}

/**
 * The odds, and the one fact that decides whether an attack is worth making.
 * Force ratio moves a line; a defender with nowhere to go is an army destroyed,
 * so that line is the loud one.
 */
function OddsBlock({ state, projected, me, attack }: KesselDockProps) {
  const m = mapOf(state.mapId)
  const odds = attack ? oddsFor(m, state, projected, me, attack.to, attack.from) : null

  if (!attack || !odds) {
    return (
      <div className="kodds empty">
        <span className="mono-label">Odds</span>
        <span className="idle">Nothing lined up</span>
      </div>
    )
  }

  const band = odds.ratio >= 1.6 ? 'good' : odds.ratio >= 1.05 ? 'even' : 'bad'
  return (
    <div className={`kodds ${band}`}>
      <span className="mono-label">
        {m.province[attack.to].name} · {attack.staged ? 'staged' : 'preview'}
      </span>
      <span className="ratio">
        {odds.ratio === Infinity ? '—' : odds.ratio.toFixed(1)}<i>:1</i>
        {odds.committed < odds.brought && (
          <em>{odds.committed} of {odds.brought} fit the frontage</em>
        )}
      </span>
      {odds.trapped === odds.defenders ? (
        <span className="retreat none">No line of retreat</span>
      ) : odds.trapped > 0 ? (
        <span className="retreat some">{odds.trapped} of {odds.defenders} cannot retreat</span>
      ) : (
        <span className="retreat">Falls back to {m.province[odds.fallback as ProvinceId].name}</span>
      )}
    </div>
  )
}

function botSlots({ state }: KesselDockProps): Slots {
  return {
    hint: 'Thinking',
    say: state.phase === 'terms'
      ? `${state.sides[state.current].name} is weighing the terms`
      : `${state.sides[state.current].name} is writing this turn's orders`,
  }
}

function phaseSlots(props: KesselDockProps): Slots {
  const { state, me, selected, projected } = props
  const m = mapOf(state.mapId)

  if (state.phase === 'terms') {
    return {
      hint: `${state.sides[(1 - me) as PlayerId].name} offers terms`,
      say: <>Accept and the war ends on this line, scored against both sides' aims</>,
      controls: (
        <button className="btn ghost" onClick={props.onRejectTerms}>
          Fight on · −8 will
        </button>
      ),
    }
  }

  if (state.sides[me].will <= WILL_FLOOR) {
    return {
      counter: <span className="counter">{Math.round(state.sides[me].will)}</span>,
      hint: 'Will spent',
      say: <>Your army will not be ordered forward again · <b>ask for terms</b></>,
    }
  }

  const mine = state.formations.filter((f) => f.owner === me)
  const pending = mine.filter((f) => !state.orders[f.id])
  const f = selected === null ? null : mine.find((x) => x.id === selected)
  const counter = <span className="counter">{pending.length}</span>

  if (!f) {
    return {
      counter,
      hint: <>Without orders · <kbd>←</kbd><kbd>→</kbd> cycles them</>,
      say: <>Click one of your formations, then an adjacent province</>,
    }
  }

  const order = state.orders[f.id]
  const trapped = retreatOptions(m, projected, f).length === 0
  const hint = (
    <>
      {TYPE_NAME[f.type]} · {m.province[f.at].name} · {f.strength} str · {Math.round(f.cohesion)} coh
      {' · '}<b className={`sup s${f.supply}`}>{SUPPLY_NAME[f.supply]}</b>
      {trapped && ' · encircled'}
    </>
  )

  const controls = order ? (
    <button className="btn ghost" onClick={props.onClearOrder}>Clear order <kbd>⌫</kbd></button>
  ) : undefined

  if (order?.type === 'attack') {
    return { counter, hint, say: <>Attacking <b>{m.province[order.to].name}</b></>, controls }
  }
  if (order?.type === 'move') {
    return { counter, hint, say: <>Moving to <b>{m.province[order.to].name}</b></>, controls }
  }
  if (order?.type === 'hold') {
    return { counter, hint, say: <>Holding · digging in</>, controls }
  }
  if (order?.type === 'refit') {
    return { counter, hint, say: <>Refitting · the turn traded for cohesion</>, controls }
  }

  return {
    counter,
    hint,
    say: f.supply >= 3
      ? <>Click a province · enemy-held <b>attacks</b> · <kbd>H</kbd> hold · <kbd>R</kbd> refit</>
      : <>Short of full supply, so it <b>cannot attack</b> · move, <kbd>H</kbd> hold or <kbd>R</kbd> refit</>,
    controls,
  }
}
